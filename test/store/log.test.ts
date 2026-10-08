// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it, vi } from "vitest"
import { collectable } from "../../src/gossip/collection.js"
import { decodeOperations, encodeOperation } from "../../src/graph/codec.js"
import { foldOperations } from "../../src/graph/fold.js"
import { Metrics } from "../../src/metrics.js"
import { type CollectionGuard, ShardLog } from "../../src/store/log.js"
import { MemoryBackend } from "../../src/sync/memory.js"
import { COLLECT_ALL } from "../support/gossip.js"
import { op } from "../support/operations.js"

/** A memory backend whose rewrite can be held open, to inject a concurrent writer. */
class GatedBackend extends MemoryBackend {
  gate: Promise<void> | undefined

  override async replace(name: string, text: string, expected: string | undefined): Promise<void> {
    if (this.gate !== undefined) {
      await this.gate
    }
    await super.replace(name, text, expected)
  }
}

describe("ShardLog", () => {
  it("stamps operations with a monotonic per-node sequence", async () => {
    const log = new ShardLog(new MemoryBackend(), "n1")
    await log.append([{ type: "entity.create", name: "A", entityType: "t" }])
    await log.append([{ type: "observation.add", entityName: "A", content: "x" }])
    const ops = await log.read()
    expect(ops.map((entry) => entry.seq)).toEqual([0, 1])
    expect(ops.every((entry) => entry.node === "n1")).toBe(true)
    expect(new Set(ops.map((entry) => entry.id)).size).toBe(2)
  })

  it("continues the sequence after a restart", async () => {
    const backend = new MemoryBackend()
    await new ShardLog(backend, "n1").append([
      { type: "entity.create", name: "A", entityType: "t" },
    ])
    const restarted = new ShardLog(backend, "n1")
    await restarted.append([{ type: "entity.delete", name: "A" }])
    expect((await restarted.read()).map((entry) => entry.seq)).toEqual([0, 1])
  })

  it("merges shards from several nodes", async () => {
    const backend = new MemoryBackend()
    const a = new ShardLog(backend, "n1")
    const b = new ShardLog(backend, "n2")
    await a.append([{ type: "entity.create", name: "A", entityType: "t" }])
    await b.append([{ type: "observation.add", entityName: "A", content: "x" }])
    const ops = await a.read()
    expect(ops).toHaveLength(2)
    expect(new Set(ops.map((entry) => entry.node))).toEqual(new Set(["n1", "n2"]))
    expect(await a.read()).toEqual(ops)
  })

  it("deduplicates an operation present in two shards", async () => {
    const backend = new MemoryBackend()
    const line = `${encodeOperation(op({ type: "entity.create", name: "A", entityType: "t" }, { node: "n1", seq: 0 }))}\n`
    await backend.append("n1.jsonl", line)
    await backend.append("n2.jsonl", line)
    const ops = await new ShardLog(backend, "n1").read()
    expect(ops).toHaveLength(1)
  })

  it("skips malformed lines", async () => {
    const backend = new MemoryBackend()
    const valid = encodeOperation(op({ type: "entity.create", name: "A", entityType: "t" }))
    await backend.append("n1.jsonl", `not json\n{"v":1}\n\n${valid}\n`)
    expect(await new ShardLog(backend, "n1").read()).toHaveLength(1)
  })

  it("reports a skipped malformed line on stderr", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    const backend = new MemoryBackend()
    await backend.append("n1.jsonl", "not json\n")
    await new ShardLog(backend, "n1").read()
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("server-noonien:"))
  })

  it("reports the shards it can see", async () => {
    const backend = new MemoryBackend()
    const log = new ShardLog(backend, "n1")
    await log.append([{ type: "entity.create", name: "A", entityType: "t" }])
    expect(await log.shards()).toEqual(["n1.jsonl"])
  })

  it("counts decoded operations and merges when given a metrics registry", async () => {
    const metrics = new Metrics()
    const log = new ShardLog(new MemoryBackend(), "n1", metrics)
    await log.append([{ type: "entity.create", name: "A", entityType: "t" }])
    await log.read()
    await log.read()
    expect(metrics.snapshot()["noonien_mcp_ops_decoded_total"]).toBe(1)
    expect(metrics.snapshot()["noonien_mcp_shards_merged"]).toBe(1)
  })

  it("keeps timestamps monotonic when the clock steps back", async () => {
    vi.useFakeTimers()
    try {
      const backend = new MemoryBackend()
      const log = new ShardLog(backend, "n1")
      vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"))
      await log.append([
        { type: "entity.create", name: "E", entityType: "t" },
        { type: "observation.add", entityName: "E", content: "x" },
      ])
      vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"))
      await log.append([{ type: "observation.delete", entityName: "E", content: "x" }])
      const ops = await log.read()
      const stamps = ops.map((entry) => entry.ts)
      expect(stamps).toEqual([...stamps].sort())
      expect(foldOperations(ops).entities[0]?.observations).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it("fails loudly when two writers share a shard", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"))
      const backend = new MemoryBackend()
      await Promise.all([
        new ShardLog(backend, "n1").append([{ type: "entity.create", name: "A", entityType: "t" }]),
        new ShardLog(backend, "n1").append([{ type: "entity.delete", name: "A" }]),
      ])
      await expect(new ShardLog(backend, "n1").read()).rejects.toThrow(
        /Conflicting operations share id/,
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it("compacts a shard to the latest operation per element and keeps the graph", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"))
      const backend = new MemoryBackend()
      const log = new ShardLog(backend, "n1")
      await log.append([
        { type: "entity.create", name: "E", entityType: "t" },
        { type: "observation.add", entityName: "E", content: "x" },
        { type: "observation.delete", entityName: "E", content: "x" },
        { type: "observation.add", entityName: "E", content: "x" },
      ])
      const before = await log.read()
      expect(await log.compact()).toEqual({ before: 4, after: 4 })
      const after = await log.read()
      expect(foldOperations(after)).toEqual(foldOperations(before))
      vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"))
      await log.append([{ type: "observation.add", entityName: "E", content: "y" }])
      expect((await log.read()).map((entry) => entry.seq).sort((a, b) => a - b)).toEqual([
        0, 2, 3, 4, 5,
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it("drops an operation that another node's later operation shadows", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"))
      const backend = new MemoryBackend()
      const a = new ShardLog(backend, "n1")
      const b = new ShardLog(backend, "n2")
      await a.append([
        { type: "entity.create", name: "E", entityType: "t" },
        { type: "observation.add", entityName: "E", content: "x" },
        { type: "observation.add", entityName: "E", content: "y" },
      ])
      vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"))
      await b.append([{ type: "observation.delete", entityName: "E", content: "x" }])
      const before = await a.read()
      expect(await a.compact()).toEqual({ before: 3, after: 3 })
      // The shadowed add is gone from the local shard...
      const own = decodeOperations((await backend.read("n1.jsonl")) ?? "")
      expect(own.map((entry) => entry.type)).toEqual([
        "entity.create",
        "observation.add",
        "shard.compact",
      ])
      // ...but the merged graph is unchanged.
      expect(foldOperations(await a.read())).toEqual(foldOperations(before))
    } finally {
      vi.useRealTimers()
    }
  })

  it("stamps a durable high-water mark and a generation on compaction", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"))
      const backend = new MemoryBackend()
      const log = new ShardLog(backend, "n1")
      await log.append([
        { type: "entity.create", name: "E", entityType: "t" },
        { type: "observation.add", entityName: "E", content: "x" },
      ])
      await log.compact()
      const own = decodeOperations((await backend.read("n1.jsonl")) ?? "")
      const meta = own.find((op) => op.type === "shard.compact")
      expect(meta?.type === "shard.compact" ? meta.generation : 0).toBe(1)
      // The meta operation carries the current sequence, so the high-water mark
      // never regresses across a compaction or a restart.
      expect(Math.max(...own.map((op) => op.seq))).toBe(meta?.seq)
      await log.compact()
      const again = decodeOperations((await backend.read("n1.jsonl")) ?? "")
      const metas = again.filter((op) => op.type === "shard.compact")
      expect(metas).toHaveLength(1)
      expect(metas[0]?.type === "shard.compact" ? metas[0].generation : 0).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("re-derives the sequence when a concurrent writer consumed it", async () => {
    const backend = new MemoryBackend()
    // Two writers on the same node id: the MCP server, and the daemon that shares the
    // shard and stamps a `shard.compact` meta at the next sequence.
    const server = new ShardLog(backend, "n1")
    const daemon = new ShardLog(backend, "n1")
    await server.append([{ type: "entity.create", name: "A", entityType: "t" }])
    await daemon.read()
    await server.compact()
    await daemon.append([{ type: "entity.create", name: "B", entityType: "t" }])
    const seqs = decodeOperations((await backend.read("n1.jsonl")) ?? "").map((op) => op.seq)
    // Every operation keeps a sequence of its own: the daemon did not reuse the one
    // the compaction consumed.
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it("does nothing when the shard does not exist", async () => {
    const backend = new MemoryBackend()
    expect(await new ShardLog(backend, "n1").compact()).toEqual({ before: 0, after: 0 })
    expect(await backend.list()).toEqual([])
  })

  it("collects a deleted element physically once every shard is pruned", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"))
      const backend = new MemoryBackend()
      const log = new ShardLog(backend, "n1")
      await log.append([
        { type: "entity.create", name: "E", entityType: "t" },
        { type: "observation.add", entityName: "E", content: "x" },
      ])
      vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"))
      await log.append([
        { type: "observation.delete", entityName: "E", content: "x" },
        { type: "entity.delete", name: "E" },
      ])
      const before = foldOperations(await log.read())
      // Without a collection guard it only prunes the shadowed adds.
      expect(await log.compact()).toEqual({ before: 4, after: 3 })
      // Cleared to collect, the surviving tombstones go too: the element is gone.
      expect(await log.gc(COLLECT_ALL)).toEqual({ before: 3, after: 1, frozen: 0 })
      const own = decodeOperations((await backend.read("n1.jsonl")) ?? "")
      expect(own.map((entry) => entry.type)).toEqual(["shard.compact"])
      expect(foldOperations(await log.read())).toEqual(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps a tombstone while a competitor survives in another shard", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"))
      const backend = new MemoryBackend()
      const a = new ShardLog(backend, "n1")
      const b = new ShardLog(backend, "n2")
      await a.append([{ type: "entity.create", name: "E", entityType: "t" }])
      vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"))
      await b.append([{ type: "entity.delete", name: "E" }])
      // n1 has not pruned, so its create still sits (shadowed) in the merged view:
      // a competitor survives, so n2 must not drop its tombstone.
      expect(await b.gc(COLLECT_ALL)).toEqual({ before: 1, after: 1, frozen: 1 })
      const ownOf = async (): Promise<string[]> =>
        decodeOperations((await backend.read("n2.jsonl")) ?? "").map((entry) => entry.type)
      expect(await ownOf()).toEqual(["entity.delete"])
      // Once n1 prunes its shadowed create, n2's tombstone becomes collectable.
      await a.compact()
      expect(await b.gc(COLLECT_ALL)).toEqual({ before: 1, after: 1, frozen: 0 })
      expect(await ownOf()).toEqual(["shard.compact"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("keeps a content-level observation delete while a foreign occurrence survives", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"))
      const backend = new MemoryBackend()
      const a = new ShardLog(backend, "n1")
      const b = new ShardLog(backend, "n2")
      await a.append([{ type: "observation.add", entityName: "E", content: "x" }])
      vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"))
      await b.append([{ type: "observation.delete", entityName: "E", content: "x" }])
      // n1's add is a different key (its occurrence slot) but the delete is
      // content-level: n2 must keep the delete while that occurrence survives.
      expect(await b.gc(COLLECT_ALL)).toEqual({ before: 1, after: 1, frozen: 1 })
      const ownOf = async (): Promise<string[]> =>
        decodeOperations((await backend.read("n2.jsonl")) ?? "").map((entry) => entry.type)
      expect(await ownOf()).toEqual(["observation.delete"])
      // Once n1 prunes its shadowed occurrence, n2's delete is collectable.
      await a.compact()
      expect(await b.gc(COLLECT_ALL)).toEqual({ before: 1, after: 1, frozen: 0 })
      expect(await ownOf()).toEqual(["shard.compact"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("collects a content-level delete together with its own occurrence", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"))
      const backend = new MemoryBackend()
      const log = new ShardLog(backend, "n1")
      await log.append([
        { type: "observation.add", entityName: "E", content: "x" },
        { type: "observation.delete", entityName: "E", content: "x" },
      ])
      expect(await log.gc(COLLECT_ALL)).toEqual({ before: 2, after: 1, frozen: 0 })
      const own = decodeOperations((await backend.read("n1.jsonl")) ?? "")
      expect(own.map((entry) => entry.type)).toEqual(["shard.compact"])
    } finally {
      vi.useRealTimers()
    }
  })

  it("refuses to compact a shard whose corruption is not a torn trailing line", async () => {
    const backend = new MemoryBackend()
    const first = op({ type: "entity.create", name: "A", entityType: "t" }, { node: "n1", seq: 0 })
    const second = op({ type: "entity.create", name: "B", entityType: "t" }, { node: "n1", seq: 1 })
    await backend.append(
      "n1.jsonl",
      `${encodeOperation(first)}\n{ not json }\n${encodeOperation(second)}\n`,
    )
    // A rewrite would re-encode only the decoded ops and erase the corrupt line.
    await expect(new ShardLog(backend, "n1").compact()).rejects.toThrow(/corrupt/)
  })

  it("drops a torn trailing line and compacts the rest", async () => {
    const backend = new MemoryBackend()
    const first = op({ type: "entity.create", name: "A", entityType: "t" }, { node: "n1", seq: 0 })
    await backend.append("n1.jsonl", `${encodeOperation(first)}\n{"partial":`)
    await new ShardLog(backend, "n1").compact()
    const own = decodeOperations((await backend.read("n1.jsonl")) ?? "")
    expect(own.some((entry) => entry.type === "entity.create")).toBe(true)
  })

  it("retries when the shard changes during compaction, losing no write", async () => {
    const backend = new GatedBackend()
    const writer = new ShardLog(backend, "n1")
    await writer.append([{ type: "entity.create", name: "E", entityType: "t" }])
    let release: () => void = () => {}
    backend.gate = new Promise<void>((resolve) => {
      release = () => resolve()
    })
    const compacting = new ShardLog(backend, "n1").compact()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await writer.append([{ type: "observation.add", entityName: "E", content: "x" }])
    release()
    expect(await compacting).toEqual({ before: 2, after: 3 })
    expect(await writer.read()).toHaveLength(3)
  })
})

describe("prune", () => {
  it("drops the shadowed operations, keeps every tombstone, and skips a no-op rewrite", async () => {
    const backend = new MemoryBackend()
    const log = new ShardLog(backend, "n1")
    await log.append([
      { type: "entity.create", name: "E", entityType: "t" },
      { type: "entity.delete", name: "E" },
    ])
    const before = await backend.read("n1.jsonl")
    // The create is shadowed by the tombstone and goes; the tombstone survives, because a
    // prune collects nothing — it needs neither the peer knowledge nor a promise.
    expect(await log.prune()).toEqual({ before: 2, after: 2, dropped: 1 })
    expect(decodeOperations((await backend.read("n1.jsonl")) ?? "").map((op) => op.type)).toEqual([
      "entity.delete",
      "shard.compact",
    ])
    expect(await backend.read("n1.jsonl")).not.toBe(before)
    expect(foldOperations(await log.read())).toEqual({ entities: [], relations: [] })

    // Nothing left to drop: the shard is not rewritten, so the generation does not churn
    // (a bump would make every peer re-pull the whole shard) and a repeated maintenance is
    // free. Compared at byte level, which is the only place the difference shows.
    const pruned = await backend.read("n1.jsonl")
    expect(await log.prune()).toEqual({ before: 2, after: 2, dropped: 0 })
    expect(await backend.read("n1.jsonl")).toBe(pruned)
  })
})

describe("collection evidence", () => {
  it("keeps the shadowed evidence while the collection is suspended", async () => {
    const backend = new MemoryBackend()
    const log = new ShardLog(backend, "n1")
    await log.append([{ type: "entity.create", name: "E", entityType: "t" }])
    await log.append([{ type: "entity.delete", name: "E" }])

    // A reachable peer the round did not exchange with suspends collection: nothing may be
    // dropped, not even the shadowed create that is the only proof the peer knew E. Had the
    // create been pruned here, the very next round — the peer now dead — would find no
    // operation it covers and collect the tombstone while the peer is still off the mesh.
    const suspended: CollectionGuard = { suspended: true, allows: () => false }
    expect(await log.gc(suspended)).toEqual({ before: 2, after: 2, frozen: 1 })
    expect(decodeOperations((await backend.read("n1.jsonl")) ?? "").map((op) => op.type)).toEqual([
      "entity.create",
      "entity.delete",
    ])
  })

  it("keeps a foreign element's evidence while a peer off the mesh could contest it", async () => {
    const backend = new MemoryBackend()
    const a = new ShardLog(backend, "n1")
    const b = new ShardLog(backend, "n2")
    await a.append([{ type: "entity.create", name: "E", entityType: "t" }])
    await b.append([{ type: "entity.delete", name: "E" }])

    // A third peer that knew E has gone: the create on n1's shard is the only evidence the
    // gate reads, so n1 must keep it even though the tombstone is n2's.
    const guard: CollectionGuard = {
      suspended: false,
      allows: (ops) =>
        collectable(
          {
            suspended: false,
            peers: [new Map([["n1", 0]])],
            local: new Map([
              ["n1", 0],
              ["n2", 0],
            ]),
          },
          ops,
        ),
    }
    // n1 holds no tombstone to freeze, but it keeps the create that proves the peer knew E.
    expect(await a.gc(guard)).toEqual({ before: 1, after: 1, frozen: 0 })
    expect(decodeOperations((await backend.read("n1.jsonl")) ?? "").map((op) => op.type)).toEqual([
      "entity.create",
    ])
    // With the evidence retained, n2 cannot collect the tombstone.
    expect(await b.gc(guard)).toEqual({ before: 1, after: 1, frozen: 1 })
    expect(decodeOperations((await backend.read("n2.jsonl")) ?? "").map((op) => op.type)).toEqual([
      "entity.delete",
    ])
  })

  it("keeps a shadowed operation on a live element while a peer off the mesh could contest it", async () => {
    const backend = new MemoryBackend()
    const a = new ShardLog(backend, "n1")
    // A delete then a re-create leaves E live, with the first create and the delete shadowed.
    // A peer that knew E at the first create (seq 0) still pins its evidence: dropping it now
    // would leave the next delete nothing the peer's frontier covers, so the element could be
    // collected while that peer is still off the mesh.
    await a.append([{ type: "entity.create", name: "E", entityType: "t" }])
    await a.append([{ type: "entity.delete", name: "E" }])
    await a.append([{ type: "entity.create", name: "E", entityType: "t2" }])
    const guard: CollectionGuard = {
      suspended: false,
      allows: (ops) =>
        collectable(
          { suspended: false, peers: [new Map([["n1", 0]])], local: new Map([["n1", 2]]) },
          ops,
        ),
    }
    // E is live, so nothing is collected; the shadowed create and delete are kept as evidence.
    expect(await a.gc(guard)).toEqual({ before: 3, after: 3, frozen: 0 })
    expect(decodeOperations((await backend.read("n1.jsonl")) ?? "").map((op) => op.type)).toEqual([
      "entity.create",
      "entity.delete",
      "entity.create",
    ])
  })
})
