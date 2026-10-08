// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readFile, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type GossipHandle, startGossip } from "../../src/gossip/daemon.js"
import { hasPeerKnowledge } from "../../src/gossip/knowledge.js"
import { decodeOperations } from "../../src/graph/codec.js"
import { foldOperations } from "../../src/graph/fold.js"
import { ShardLog } from "../../src/store/log.js"
import { FileBackend } from "../../src/sync/file.js"
import { shardTypes } from "../support/gossip.js"
import { createTempDirectory } from "../support/tmp.js"

const directories: string[] = []
const handles: GossipHandle[] = []

async function tempDirectory(): Promise<string> {
  const directory = await createTempDirectory("noonien-daemon-")
  directories.push(directory)
  return directory
}

/** A concrete free port: `startGossip` rejects port 0. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      if (address === null || typeof address === "string") {
        reject(new Error("could not allocate a port"))
        return
      }
      probe.close(() => resolve(address.port))
    })
  })
}

/** Poll a condition while driving the daemon, so the test never depends on timers. */
async function until(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("condition was not met in time")
}

async function startDaemon(
  node: string,
  directory: string,
  port: number,
  seed: string,
  forgetAfterSeconds?: string,
  overrides: NodeJS.ProcessEnv = {},
): Promise<GossipHandle> {
  const handle = await startGossip(
    {
      NOONIEN_DIR: directory,
      NOONIEN_NODE_ID: node,
      NOONIEND_LISTEN: `127.0.0.1:${port}`,
      NOONIEND_ADVERTISE: `127.0.0.1:${port}`,
      NOONIEND_PEERS: seed,
      NOONIEND_INTERVAL: "3600",
      NOONIEND_PUSH: "false",
      NOONIEND_SUSPECT_AFTER: "1",
      NOONIEND_DEAD_AFTER: "1",
      ...(forgetAfterSeconds === undefined ? {} : { NOONIEND_FORGET_AFTER: forgetAfterSeconds }),
      ...overrides,
    },
    { quiet: true },
  )
  // Register here, so `afterEach` closes every daemon a test started — a test that closes
  // one itself also removes it from the list first. An unregistered handle leaked its
  // listening socket (and made `handles.splice(indexOf(handle), 1)` remove the wrong one).
  handles.push(handle)
  return handle
}

async function holdsShard(directory: string, node: string, type: string): Promise<boolean> {
  const text = await readFile(join(directory, `${node}.jsonl`), "utf8").catch(() => "")
  return decodeOperations(text).some((op) => op.type === type)
}

/** The durable knowledge file as it is on disk, reserved keys included. */
async function readKnowledge(directory: string): Promise<Record<string, unknown>> {
  const text = await readFile(join(directory, ".nooniend-peers.json"), "utf8").catch(() => "")
  return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>)
}

/** The durable frontier a daemon recorded for one peer: author → greatest sequence held. */
async function recordedFrontier(directory: string, peer: string, author: string): Promise<number> {
  const knowledge = await readKnowledge(directory)
  const state = knowledge[peer] as { shards: Record<string, number> } | undefined
  return state?.shards[author] ?? -1
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()))
  await Promise.all(
    directories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
      ),
  )
})

describe("daemon collection", () => {
  it("announces itself with its knowledge file before its first round", async () => {
    const directory = await tempDirectory()
    const port = await freePort()
    // No discovery source: the point is only that the directory says a daemon owns it, so
    // the server and `noonien compact` refuse to collect without asking it — a daemon that
    // had not completed a round yet used to be invisible.
    await startDaemon("solo", directory, port, "")
    expect(await hasPeerKnowledge(directory)).toBe(true)
  })

  it("collects an element a peer that left never saw, keeping one it knew", async () => {
    const directoryA = await tempDirectory()
    const directoryB = await tempDirectory()
    const portA = await freePort()
    const portB = await freePort()
    const a = await startDaemon("ea", directoryA, portA, `127.0.0.1:${portB}`)
    const b = await startDaemon("eb", directoryB, portB, `127.0.0.1:${portA}`)

    // b authors E while a is up, so a receives the create and b learns a knew it.
    await new ShardLog(new FileBackend(directoryB), "eb").append([
      { type: "entity.create", name: "E", entityType: "t" },
    ])
    await until(async () => {
      await b.syncOnce()
      return holdsShard(directoryA, "eb", "entity.create")
    })
    // b must record that a holds b's shard up to the create before a leaves.
    await until(async () => {
      await b.syncOnce()
      return (await recordedFrontier(directoryB, "ea", "eb")) >= 0
    })

    // a goes away. b marks it dead, so collection falls to the knowledge path.
    await a.close()
    handles.splice(handles.indexOf(a), 1)
    await until(async () => {
      await b.syncOnce()
      const peers = (await fetch(`${b.url}/peers`).then((response) => response.json())) as {
        peers: Array<{ node: string; health: string }>
      }
      return peers.peers.some((peer) => peer.node === "ea" && peer.health === "dead")
    })

    // b deletes E and creates then deletes a brand-new element a never received.
    await new ShardLog(new FileBackend(directoryB), "eb").append([
      { type: "entity.delete", name: "E" },
      { type: "entity.create", name: "New", entityType: "t" },
      { type: "entity.delete", name: "New" },
    ])
    // Run rounds until the collection settles: New is gone, E is frozen.
    await until(async () => {
      await b.syncOnce()
      return (
        (await shardTypes(directoryB, "eb")).join(",") ===
        "entity.create,entity.delete,shard.compact"
      )
    })

    // E stays frozen (a knew it; its create is kept as the witness), New is gone.
    expect(await shardTypes(directoryB, "eb")).toEqual([
      "entity.create",
      "entity.delete",
      "shard.compact",
    ])
    expect(foldOperations(await new ShardLog(new FileBackend(directoryB), "eb").read())).toEqual({
      entities: [],
      relations: [],
    })
    const metrics = await fetch(`${b.url}/metrics`).then((response) => response.text())
    expect(metrics).toContain("noonien_gossip_frozen_elements 1")
    expect(metrics).toContain("noonien_gossip_absent_nodes 1")
    expect(metrics).toContain("noonien_gossip_retained_peers 1")
    expect(metrics).toContain('noonien_gossip_absent_seconds{node="ea"}')
  })

  it("retires a peer that went silent, and a later deletion stays frozen", async () => {
    const directoryA = await tempDirectory()
    const directoryB = await tempDirectory()
    const portA = await freePort()
    const portB = await freePort()
    // A one-second retention window, crossed deliberately: a peer is retired once
    // nothing has heard from it for longer than the window. (A peer that is still up
    // keeps refreshing the record, so silence — not a timer on the data — expires it.)
    const a = await startDaemon("ra", directoryA, portA, `127.0.0.1:${portB}`, "1")
    const b = await startDaemon("rb", directoryB, portB, `127.0.0.1:${portA}`, "1")

    // b authors E; a catches up, and b records that a held b's shard up to it.
    await new ShardLog(new FileBackend(directoryB), "rb").append([
      { type: "entity.create", name: "E", entityType: "t" },
    ])
    await until(async () => {
      await b.syncOnce()
      return (await recordedFrontier(directoryB, "ra", "rb")) >= 0
    })

    // a goes away: silence is what retires it, into the durable forms the gate reads.
    await a.close()
    handles.splice(handles.indexOf(a), 1)
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await until(async () => {
      await b.syncOnce()
      const knowledge = await readKnowledge(directoryB)
      return knowledge["ra"] === undefined && knowledge["@retired"] !== undefined
    })

    const knowledge = await readKnowledge(directoryB)
    expect(knowledge["ra"]).toBeUndefined()
    expect((knowledge["@retired"] as Record<string, number>)["rb"]).toBeGreaterThanOrEqual(0)

    // The deletion happens *after* the retirement — the case a per-element pin computed
    // at expiry would miss. "New" is collected at once; E's tombstone stays, because the
    // retired threshold still covers its creation, so a returning peer's older add is
    // still beaten.
    await new ShardLog(new FileBackend(directoryB), "rb").append([
      { type: "entity.delete", name: "E" },
      { type: "entity.create", name: "New", entityType: "t" },
      { type: "entity.delete", name: "New" },
    ])
    await until(async () => {
      await b.syncOnce()
      return (
        (await shardTypes(directoryB, "rb")).join(",") ===
        "entity.create,entity.delete,shard.compact"
      )
    })
    expect(await shardTypes(directoryB, "rb")).toEqual([
      "entity.create",
      "entity.delete",
      "shard.compact",
    ])
    expect(foldOperations(await new ShardLog(new FileBackend(directoryB), "rb").read())).toEqual({
      entities: [],
      relations: [],
    })

    // The retention is observable, and a retired peer no longer produces a per-round
    // series: that is the work the bound buys, alongside the memory.
    const metrics = await fetch(`${b.url}/metrics`).then((response) => response.text())
    expect(metrics).toContain("noonien_gossip_retired_total 1")
    expect(metrics).toContain("noonien_gossip_retired_authors 1")
    expect(metrics).toContain("noonien_gossip_blankets 0")
    // The bound, in one number: the peer no longer counts as retained at all, so the
    // per-round work and the durable metadata it drove are gone, not merely smaller.
    expect(metrics).toContain("noonien_gossip_retained_peers 0")
    expect(metrics).not.toContain('noonien_gossip_absent_seconds{node="ra"}')
  })

  it("keeps the evidence while a peer the round cannot reach suspends the collection", async () => {
    const directoryB = await tempDirectory()
    const portB = await freePort()
    // A configured peer nothing serves: every exchange fails and the peer stays reachable
    // (merely unreachable — not yet dead), so the round **suspends**. A suspended round must
    // drop nothing, including the shadowed create that is the evidence a peer could still
    // contest. `DEAD_AFTER` is deliberately high so the round stays suspended; a peer that is
    // never served removes any dependence on how fast a gracefully closed socket is released.
    const b = await startDaemon(
      "sb",
      directoryB,
      portB,
      `sa@127.0.0.1:${await freePort()}`,
      undefined,
      {
        NOONIEND_DEAD_AFTER: "100",
      },
    )

    await new ShardLog(new FileBackend(directoryB), "sb").append([
      { type: "entity.create", name: "E", entityType: "t" },
    ])
    await new ShardLog(new FileBackend(directoryB), "sb").append([
      { type: "entity.delete", name: "E" },
    ])
    await until(async () => {
      await b.syncOnce()
      const peers = (await fetch(`${b.url}/peers`).then((response) => response.json())) as {
        peers: Array<{ node: string; health: string }>
      }
      return peers.peers.some((peer) => peer.node === "sa" && peer.health !== "alive")
    })

    // E stays frozen: the create survives as the evidence a suspended round must not prune, so
    // the tombstone is never collected while that peer is off the mesh.
    expect(await shardTypes(directoryB, "sb")).toEqual(["entity.create", "entity.delete"])
    const metrics = await fetch(`${b.url}/metrics`).then((response) => response.text())
    expect(metrics).toContain("noonien_gossip_frozen_elements 1")
  })
})
