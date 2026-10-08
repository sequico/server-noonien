// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { appendFile, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ReplicaStore } from "../../src/gossip/replica.js"
import { encodeOperation } from "../../src/graph/codec.js"
import type { Operation, OperationDraft } from "../../src/graph/operations.js"
import { ShardLog } from "../../src/store/log.js"
import { FileBackend } from "../../src/sync/file.js"
import { op, T1, T2 } from "../support/operations.js"

const DRAFTS: OperationDraft[] = [
  { type: "entity.create", name: "Ada", entityType: "person" },
  { type: "observation.add", entityName: "Ada", content: "math" },
]

function peerOps(node: string, count: number): Operation[] {
  return DRAFTS.slice(0, count).map((draft, seq) => op(draft, { ts: T1, node, seq }))
}

let directory = ""

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "noonien-replica-"))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe("ReplicaStore", () => {
  it("summarizes the local shard with its count and high-water sequence", async () => {
    await new ShardLog(new FileBackend(directory), "me").append(DRAFTS)
    expect(await new ReplicaStore(directory, "me").list()).toEqual([
      { node: "me", count: 2, maxSeq: 1, generation: 0 },
    ])
  })

  it("returns every shard in the directory, sorted by node", async () => {
    await new ShardLog(new FileBackend(directory), "z").append(DRAFTS)
    await new ShardLog(new FileBackend(directory), "a").append(DRAFTS.slice(0, 1))
    const store = new ReplicaStore(directory, "me")
    expect((await store.list()).map((shard) => shard.node)).toEqual(["a", "z"])
  })

  it("reads only the operations above a sequence, in order", async () => {
    await new ShardLog(new FileBackend(directory), "peer").append(DRAFTS)
    const store = new ReplicaStore(directory, "me")
    expect((await store.opsAfter("peer", 0)).map((entry) => entry.seq)).toEqual([1])
    expect((await store.opsAfter("peer", -1)).map((entry) => entry.seq)).toEqual([0, 1])
    expect(await store.opsAfter("missing", -1)).toEqual([])
  })

  it("merges received operations, deduplicating by id", async () => {
    const store = new ReplicaStore(directory, "me")
    const ops = peerOps("peer", 2)
    expect(await store.receive("peer", ops)).toBe(2)
    expect(await store.receive("peer", ops)).toBe(0)
    expect(await store.receive("peer", [])).toBe(0)
    expect((await store.opsAfter("peer", -1)).map((entry) => entry.seq)).toEqual([0, 1])
  })

  it("appends only the operations not already present", async () => {
    const store = new ReplicaStore(directory, "me")
    await store.receive("peer", peerOps("peer", 1))
    expect(await store.receive("peer", peerOps("peer", 2))).toBe(1)
    expect(await store.list()).toEqual([{ node: "peer", count: 2, maxSeq: 1, generation: 0 }])
  })

  it("does not mark an operation known when the append fails", async () => {
    const store = new ReplicaStore(directory, "me")
    await store.receive("peer", peerOps("peer", 1))
    const path = join(directory, "peer.jsonl")
    await chmod(path, 0o444)
    try {
      await expect(store.receive("peer", peerOps("peer", 2))).rejects.toThrow()
    } finally {
      await chmod(path, 0o644)
    }
    // The failed append must not have blacklisted the operation: a retry writes it.
    expect(await store.receive("peer", peerOps("peer", 2))).toBe(1)
    expect((await store.opsAfter("peer", -1)).map((entry) => entry.seq)).toEqual([0, 1])
  })

  it("writes one valid operation per line", async () => {
    const store = new ReplicaStore(directory, "me")
    await store.receive("peer", peerOps("peer", 2))
    const text = await readFile(join(directory, "peer.jsonl"), "utf8")
    expect(text.endsWith("\n")).toBe(true)
    expect(text.trimEnd().split("\n")).toHaveLength(2)
  })

  it("refuses to write the local node's own shard", async () => {
    const store = new ReplicaStore(directory, "me")
    await expect(store.receive("me", peerOps("me", 1))).rejects.toThrow(/local shard/)
  })

  it("recovers operations into the local shard", async () => {
    const store = new ReplicaStore(directory, "me")
    expect(await store.recover(peerOps("me", 2))).toBe(2)
    expect(await store.list()).toEqual([{ node: "me", count: 2, maxSeq: 1, generation: 0 }])
  })

  it("rejects a foreign operation during recovery", async () => {
    const store = new ReplicaStore(directory, "me")
    await expect(store.recover(peerOps("other", 1))).rejects.toThrow(/belongs to node "other"/)
  })

  it("continues the sequence after a peer recovers operations into the local shard", async () => {
    const log = new ShardLog(new FileBackend(directory), "me")
    await log.append([{ type: "entity.create", name: "A", entityType: "t" }])
    // A peer holds a second operation this node authored and lost; it re-appends it.
    const lost = op(
      { type: "observation.add", entityName: "A", content: "x" },
      { ts: T2, node: "me", seq: 1 },
    )
    await new ReplicaStore(directory, "me").recover([lost])
    // Reading the shard refreshes the sequence past the recovered operation...
    expect(await log.read()).toHaveLength(2)
    // ...so the next append continues after it instead of reusing seq 1.
    await log.append([{ type: "observation.add", entityName: "A", content: "y" }])
    expect((await log.read()).map((entry) => entry.seq).sort((a, b) => a - b)).toEqual([0, 1, 2])
  })

  it("rejects an operation that belongs to another node", async () => {
    const store = new ReplicaStore(directory, "me")
    const foreign = op(
      { type: "entity.create", name: "X", entityType: "t" },
      {
        ts: T1,
        node: "other",
        seq: 0,
      },
    )
    await expect(store.receive("peer", [foreign])).rejects.toThrow(/belongs to node "other"/)
    expect(await store.list()).toEqual([])
  })

  it("deduplicates repeated operations within a single request", async () => {
    const store = new ReplicaStore(directory, "me")
    const single = peerOps("peer", 1)[0]
    if (single === undefined) {
      throw new Error("expected one operation")
    }
    expect(await store.receive("peer", [single, single])).toBe(1)
    expect(await store.list()).toEqual([{ node: "peer", count: 1, maxSeq: 0, generation: 0 }])
  })

  it("sees an append that happens after a cached read", async () => {
    const store = new ReplicaStore(directory, "me")
    await store.receive("peer", peerOps("peer", 1))
    expect(await store.opsAfter("peer", -1)).toHaveLength(1)
    const extra = op(
      { type: "observation.add", entityName: "Ada", content: "math" },
      {
        ts: T1,
        node: "peer",
        seq: 1,
      },
    )
    await appendFile(join(directory, "peer.jsonl"), `${encodeOperation(extra)}\n`)
    expect((await store.opsAfter("peer", -1)).map((entry) => entry.seq)).toEqual([0, 1])
  })

  it("does not hide an external append that races its own write", async () => {
    const store = new ReplicaStore(directory, "me")
    const original = FileBackend.prototype.append
    const spy = vi.spyOn(FileBackend.prototype, "append").mockImplementation(function (
      this: FileBackend,
      name: string,
      text: string,
    ): Promise<void> {
      // An external writer (the MCP server) appends to the same own shard between
      // the daemon's cached read and its own append.
      const external = op(
        { type: "observation.add", entityName: "Ada", content: "external" },
        { ts: T2, node: "me", seq: 7 },
      )
      return appendFile(join(directory, name), `${encodeOperation(external)}\n`).then(() =>
        original.call(this, name, text),
      )
    })
    try {
      const own = op(
        { type: "entity.create", name: "Ada", entityType: "t" },
        { ts: T1, node: "me", seq: 0 },
      )
      await store.recover([own])
    } finally {
      spy.mockRestore()
    }
    // The cache must reflect the external op, not pin a stale index over it.
    expect((await store.opsAfter("me", -1)).map((entry) => entry.seq).sort()).toEqual([0, 7])
  })

  it("keeps the per-shard index in step across merges", async () => {
    const store = new ReplicaStore(directory, "me")
    expect(await store.list()).toEqual([])
    const first = peerOps("peer", 2)
    await store.receive("peer", first)
    expect(await store.list()).toEqual([{ node: "peer", count: 2, maxSeq: 1, generation: 0 }])
    const fresh = op(
      { type: "observation.add", entityName: "Ada", content: "logic" },
      {
        ts: T1,
        node: "peer",
        seq: 2,
      },
    )
    expect(await store.receive("peer", [...first, fresh])).toBe(1)
    expect(await store.list()).toEqual([{ node: "peer", count: 3, maxSeq: 2, generation: 0 }])
    expect(await store.maxSeq("peer")).toBe(2)
  })

  it("replaces a replica with the owner's compacted shard", async () => {
    const store = new ReplicaStore(directory, "me")
    await store.receive("peer", peerOps("peer", 2))
    const compacted = [
      ...peerOps("peer", 1),
      op({ type: "shard.compact", generation: 1 }, { ts: T2, node: "peer", seq: 1 }),
    ]
    expect(await store.replace("peer", compacted)).toBe(2)
    expect(await store.list()).toEqual([{ node: "peer", count: 2, maxSeq: 1, generation: 1 }])
  })

  it("reports the compaction generation of a shard", async () => {
    const store = new ReplicaStore(directory, "me")
    await store.receive("peer", [
      op({ type: "shard.compact", generation: 3 }, { ts: T1, node: "peer", seq: 0 }),
    ])
    expect((await store.list())[0]).toEqual({
      node: "peer",
      count: 1,
      maxSeq: 0,
      generation: 3,
    })
  })

  it("collects a whole large shard without overflowing the call stack", {
    // Hang guard, not a benchmark: parsing 200k lines takes seconds, and more on a
    // loaded or slower runner, so the timeout is deliberately generous.
    timeout: 30000,
  }, async () => {
    // Above ~120k elements a spread call (`push(...ops)`) exceeds the argument
    // limit, so a big shard must be collected by iteration, not by spreading.
    const count = 200_000
    const line = `${encodeOperation(
      op(
        { type: "entity.create", name: "Ada", entityType: "person" },
        { ts: T1, node: "peer", seq: 0 },
      ),
    )}\n`
    await writeFile(join(directory, "peer.jsonl"), line.repeat(count))
    const store = new ReplicaStore(directory, "me")
    expect(await store.allOps()).toHaveLength(count)
  })
})
