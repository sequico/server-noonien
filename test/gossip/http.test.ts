// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { bucketOf, DIGEST_BUCKETS } from "../../src/gossip/digest.js"
import { syncWith } from "../../src/gossip/exchange.js"
import type { Membership } from "../../src/gossip/membership.js"
import { DIGEST_CAPABILITY, PROTOCOL_VERSION } from "../../src/gossip/protocol.js"
import { ReplicaStore } from "../../src/gossip/replica.js"
import { type GossipServer, startGossipServer } from "../../src/gossip/server.js"
import { HttpTransport } from "../../src/gossip/transport.js"
import { encodeOperation } from "../../src/graph/codec.js"
import { foldOperations } from "../../src/graph/fold.js"
import type { Operation, OperationDraft } from "../../src/graph/operations.js"
import { Metrics } from "../../src/metrics.js"
import { ShardLog } from "../../src/store/log.js"
import { FileBackend } from "../../src/sync/file.js"
import { testMembership } from "../support/gossip.js"
import { op, T1 } from "../support/operations.js"

const A_DRAFTS: OperationDraft[] = [
  { type: "entity.create", name: "Ada", entityType: "person" },
  { type: "observation.add", entityName: "Ada", content: "math" },
]

const B_DRAFTS: OperationDraft[] = [
  { type: "entity.create", name: "Alan", entityType: "person" },
  { type: "relation.add", from: "Ada", to: "Alan", relationType: "colleague" },
]

interface Node {
  readonly node: string
  readonly directory: string
  readonly store: ReplicaStore
  readonly membership: Membership
  readonly server: GossipServer
  readonly address: string
  readonly url: string
}

const directories: string[] = []
const servers: GossipServer[] = []

async function newNode(node: string): Promise<Node> {
  const directory = await mkdtemp(join(tmpdir(), "noonien-http-"))
  directories.push(directory)
  const store = new ReplicaStore(directory, node)
  const membership = testMembership(node, `${node}:0`)
  const server = await startGossipServer({
    host: "127.0.0.1",
    port: 0,
    tls: undefined,
    replica: store,
    membership,
  })
  servers.push(server)
  return {
    node,
    directory,
    store,
    membership,
    server,
    address: server.address,
    url: server.url,
  }
}

async function author(node: Node, drafts: readonly OperationDraft[]): Promise<void> {
  await new ShardLog(new FileBackend(node.directory), node.node).append(drafts)
}

function allOps(node: Node): Promise<Operation[]> {
  return node.store.allOps()
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe("gossip HTTP service", () => {
  it("serves info, membership and shards", async () => {
    const node = await newNode("ai")
    await author(node, A_DRAFTS)
    const transport = new HttpTransport(node.address, undefined)
    expect(await transport.info()).toEqual({
      node: "ai",
      address: "ai:0",
      version: 1,
      protocol: PROTOCOL_VERSION,
      capabilities: [DIGEST_CAPABILITY],
    })
    expect(await transport.membership()).toEqual([{ node: "ai", address: "ai:0", version: 1 }])
    expect(await transport.shards()).toEqual([{ node: "ai", count: 2, maxSeq: 1, generation: 0 }])
    expect((await transport.opsAfter("ai", 0)).map((op) => op.seq)).toEqual([1])
  })

  it("revives a dead peer that reaches the server", async () => {
    const ai = await newNode("ai")
    ai.membership.merge([{ node: "z600", address: "z600:9999", version: 1 }])
    for (let attempt = 0; attempt < 6; attempt += 1) {
      ai.membership.recordFailure("z600")
    }
    expect(ai.membership.healthOf("z600")).toBe("dead")

    const zToAi = new HttpTransport(ai.address, undefined, 10_000, undefined, undefined, {
      node: "z600",
      address: "z600:9999",
      version: 1,
    })
    await zToAi.info()
    expect(ai.membership.healthOf("z600")).toBe("alive")
    expect(ai.membership.contactable().map((entry) => entry.node)).toContain("z600")
  })

  it("learns a peer from an address that matches where it is connecting from", async () => {
    const ai = await newNode("ai")
    expect(ai.membership.known().map((entry) => entry.node)).toEqual(["ai"])

    const zToAi = new HttpTransport(ai.address, undefined, 10_000, undefined, undefined, {
      node: "Z600",
      address: "127.0.0.1:9999",
      version: 7,
    })
    await zToAi.info()
    expect(ai.membership.known().map((entry) => entry.node)).toEqual(["ai", "Z600"])
    expect(ai.membership.healthOf("Z600")).toBe("alive")
    expect(ai.membership.contactable().map((entry) => entry.node)).toContain("Z600")
  })

  it("does not adopt a peer announcing an address it is not connecting from", async () => {
    const ai = await newNode("ai")
    const zToAi = new HttpTransport(ai.address, undefined, 10_000, undefined, undefined, {
      node: "Z600",
      address: "169.254.169.254:80",
      version: 7,
    })
    await zToAi.info()
    expect(ai.membership.known().map((entry) => entry.node)).toEqual(["ai"])
  })

  it("does not adopt a peer announcing an unsafe node id", async () => {
    const ai = await newNode("ai")
    const zToAi = new HttpTransport(ai.address, undefined, 10_000, undefined, undefined, {
      node: "../evil",
      address: "127.0.0.1:9999",
      version: 7,
    })
    await zToAi.info()
    expect(ai.membership.known().map((entry) => entry.node)).toEqual(["ai"])
  })

  it("serves health, peers, status and the folded graph", async () => {
    const node = await newNode("ai")
    await author(node, A_DRAFTS)
    node.membership.merge([{ node: "z600", address: "z600:9999", version: 1 }])
    for (let attempt = 0; attempt < 3; attempt += 1) {
      node.membership.recordFailure("z600")
    }
    const get = async (path: string): Promise<unknown> =>
      (await fetch(`http://${node.address}${path}`)).json()

    expect(await get("/health")).toEqual({ status: "ok" })
    expect(await get("/peers")).toEqual({
      peers: [
        { node: "ai", address: "ai:0", version: 1, health: "alive" },
        { node: "z600", address: "z600:9999", version: 1, health: "suspect" },
      ],
    })
    expect(await get("/status")).toMatchObject({
      node: "ai",
      version: 1,
      protocol: PROTOCOL_VERSION,
      shards: 1,
      peers: { total: 1, alive: 0, suspect: 1, dead: 0 },
    })
    const graph = (await get("/graph")) as { entities: Array<{ name: string }> }
    expect(graph.entities.map((entity) => entity.name)).toEqual(["Ada"])
  })

  it("serves the shard digest and its buckets", async () => {
    const node = await newNode("ai")
    await author(node, A_DRAFTS)
    const transport = new HttpTransport(node.address, undefined)
    const digest = await transport.digest()
    expect(digest.buckets).toHaveLength(DIGEST_BUCKETS)
    const index = bucketOf("ai")
    expect(await transport.digestBuckets([index])).toEqual([
      { node: "ai", count: 2, maxSeq: 1, generation: 0 },
    ])
    expect(await transport.digestBuckets([(index + 1) % DIGEST_BUCKETS])).toEqual([])
  })

  it("rejects a malformed digest bucket list", async () => {
    const node = await newNode("ai")
    for (const query of ["9999", "", "1,notanumber", "1,,2"]) {
      const response = await fetch(`http://${node.address}/shards/digest?buckets=${query}`)
      expect(response.status).toBe(400)
    }
  })

  it("converges two nodes through the digest path", async () => {
    const ai = await newNode("ai")
    const z600 = await newNode("z600")
    await author(ai, A_DRAFTS)
    await author(z600, B_DRAFTS)

    const aiToZ = new HttpTransport(z600.address, undefined)
    const zToAi = new HttpTransport(ai.address, undefined)
    const zEntry = { node: "z600", address: z600.address, version: 1 }
    const aiEntry = { node: "ai", address: ai.address, version: 1 }
    for (let round = 0; round < 2; round += 1) {
      await syncWith(zEntry, aiToZ, ai.store, ai.membership, { digestMinShards: 1 })
      await syncWith(aiEntry, zToAi, z600.store, z600.membership, { digestMinShards: 1 })
    }

    const aiOps = await allOps(ai)
    const zOps = await allOps(z600)
    expect(new Set(aiOps.map((op) => op.id))).toEqual(new Set(zOps.map((op) => op.id)))
    expect(foldOperations(aiOps)).toEqual(foldOperations(zOps))
  })

  it("accepts pushed operations into a peer's replica", async () => {
    const node = await newNode("ai")
    const source = await mkdtemp(join(tmpdir(), "noonien-src-"))
    directories.push(source)
    await new ShardLog(new FileBackend(source), "z600").append(A_DRAFTS.slice(0, 1))
    const ops = await new ShardLog(new FileBackend(source), "z600").read()
    const transport = new HttpTransport(node.address, undefined)
    await transport.pushOps("z600", ops)
    expect(await transport.shards()).toEqual([{ node: "z600", count: 1, maxSeq: 0, generation: 0 }])
    const received = await transport.opsAfter("z600", -1)
    const names = received.flatMap((op) => (op.type === "entity.create" ? [op.name] : []))
    expect(names).toEqual(["Ada"])
  })

  it("converges two nodes over real HTTP", async () => {
    const ai = await newNode("ai")
    const z600 = await newNode("z600")
    await author(ai, A_DRAFTS)
    await author(z600, B_DRAFTS)

    const aiToZ = new HttpTransport(z600.address, undefined)
    const zToAi = new HttpTransport(ai.address, undefined)
    const zEntry = { node: "z600", address: z600.address, version: 1 }
    const aiEntry = { node: "ai", address: ai.address, version: 1 }
    for (let round = 0; round < 2; round += 1) {
      await syncWith(zEntry, aiToZ, ai.store, ai.membership)
      await syncWith(aiEntry, zToAi, z600.store, z600.membership)
    }

    const aiOps = await allOps(ai)
    const zOps = await allOps(z600)
    expect(new Set(aiOps.map((op) => op.id))).toEqual(new Set(zOps.map((op) => op.id)))
    expect(aiOps).toHaveLength(4)
    expect(foldOperations(aiOps)).toEqual(foldOperations(zOps))
  })

  it("rejects pushed operations that belong to another node", async () => {
    const node = await newNode("ai")
    const foreign = op(
      { type: "entity.create", name: "X", entityType: "t" },
      {
        ts: T1,
        node: "other",
        seq: 0,
      },
    )
    const response = await fetch(`http://${node.address}/shards/ai/ops`, {
      method: "POST",
      headers: { "content-type": "application/x-ndjson" },
      body: `${encodeOperation(foreign)}\n`,
    })
    expect(response.status).toBe(400)
  })

  it("rejects an unsupported method on the operations route", async () => {
    const node = await newNode("ai")
    const response = await fetch(`http://${node.address}/shards/ai/ops`, { method: "PUT" })
    expect(response.status).toBe(405)
  })

  it("rejects a node id that would escape the shard directory", async () => {
    const node = await newNode("ai")
    for (const segment of ["%2e%2e%2f%2e%2e%2fetc", "a%2Fb", "a..b"]) {
      const response = await fetch(`http://${node.address}/shards/${segment}/ops`)
      expect(response.status).toBe(400)
    }
  })

  it("rejects a node id with malformed percent-encoding as a client error", async () => {
    const node = await newNode("ai")
    const response = await fetch(`http://${node.address}/shards/%zz/ops`)
    expect(response.status).toBe(400)
  })

  it("stops buffering a peer response that exceeds the cap", async () => {
    const node = await newNode("ai")
    await author(node, A_DRAFTS)
    const transport = new HttpTransport(node.address, undefined, 10_000, undefined, 8)
    await expect(transport.shards()).rejects.toThrow(/exceeds/)
  })

  it("pulls a shard larger than the response cap in several pages", async () => {
    const node = await newNode("ai")
    const additions: OperationDraft[] = Array.from({ length: 2000 }, (_, index) => ({
      type: "observation.add",
      entityName: "E",
      content: `value-${index}-${"x".repeat(60)}`,
    }))
    await author(node, [{ type: "entity.create", name: "E", entityType: "t" }, ...additions])
    // A page budget far below the shard size, so the pull must page.
    const transport = new HttpTransport(node.address, undefined, 10_000, undefined, 40_000)
    const ops = await transport.opsAfter("ai", -1)
    expect(ops).toHaveLength(2001)
    expect(ops.map((entry) => entry.seq)).toEqual(Array.from({ length: 2001 }, (_, i) => i))
  })

  it("refuses operations from a revoked node", async () => {
    const directory = await mkdtemp(join(tmpdir(), "noonien-revoked-"))
    directories.push(directory)
    const server = await startGossipServer({
      host: "127.0.0.1",
      port: 0,
      tls: undefined,
      replica: new ReplicaStore(directory, "ai"),
      membership: testMembership("ai", "ai:0"),
      revoked: new Set(["z600"]),
    })
    servers.push(server)
    const entry = op(
      { type: "entity.create", name: "X", entityType: "t" },
      { ts: T1, node: "z600", seq: 0 },
    )
    const response = await fetch(`http://${server.address}/shards/z600/ops`, {
      method: "POST",
      headers: { "content-type": "application/x-ndjson" },
      body: `${encodeOperation(entry)}\n`,
    })
    expect(response.status).toBe(403)
  })

  it("serves Prometheus metrics and the stable watermark", async () => {
    const metrics = new Metrics()
    metrics.counter("noonien_test_total", "A test counter", 2)
    const directory = await mkdtemp(join(tmpdir(), "noonien-metrics-"))
    directories.push(directory)
    const server = await startGossipServer({
      host: "127.0.0.1",
      port: 0,
      tls: undefined,
      replica: new ReplicaStore(directory, "ai"),
      membership: testMembership("ai", "ai:0"),
      metrics,
      watermark: () => ({ ai: 0 }),
    })
    servers.push(server)
    const metricsText = await fetch(`http://${server.address}/metrics`).then((res) => res.text())
    expect(metricsText).toContain("# TYPE noonien_test_total counter")
    expect(metricsText).toContain("noonien_test_total 2")
    const watermark = await fetch(`http://${server.address}/watermark`).then((res) => res.json())
    expect(watermark).toEqual({ ai: 0 })
  })
})
