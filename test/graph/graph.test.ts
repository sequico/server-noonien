// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it } from "vitest"
import { collectionGuard } from "../../src/gossip/collection.js"
import { decodeOperations } from "../../src/graph/codec.js"
import { MemoryGraph } from "../../src/graph/graph.js"
import type { Operation, OperationDraft } from "../../src/graph/operations.js"
import { Metrics } from "../../src/metrics.js"
import {
  type CollectionResult,
  type CompactionResult,
  type OperationLog,
  type PruneResult,
  ShardLog,
} from "../../src/store/log.js"
import { MemoryBackend } from "../../src/sync/memory.js"
import { materialize } from "../support/operations.js"

function newGraph(): MemoryGraph {
  return new MemoryGraph(new ShardLog(new MemoryBackend(), "node"))
}

/** A log over a fixed operation set, so a large case needs no disk round trip. */
class FixedLog implements OperationLog {
  private readonly ops: Operation[]
  readonly appended: OperationDraft[][] = []

  constructor(ops: Operation[]) {
    this.ops = ops
  }

  read(): Promise<Operation[]> {
    return Promise.resolve(this.ops)
  }

  append(drafts: readonly OperationDraft[]): Promise<void> {
    this.appended.push([...drafts])
    return Promise.resolve()
  }

  compact(): Promise<CompactionResult> {
    return Promise.resolve({ before: 0, after: 0 })
  }

  prune(): Promise<PruneResult> {
    return Promise.resolve({ before: 0, after: 0, dropped: 0 })
  }

  gc(): Promise<CollectionResult> {
    return Promise.resolve({ before: 0, after: 0, frozen: 0 })
  }
}

async function seed(graph: MemoryGraph): Promise<void> {
  await graph.createEntities([
    { name: "Ada", entityType: "person", observations: ["mathematician"] },
    { name: "Bob", entityType: "person", observations: ["engineer"] },
  ])
  await graph.createRelations([{ from: "Ada", to: "Bob", relationType: "knows" }])
}

describe("MemoryGraph", () => {
  it("creates entities and returns only the new ones", async () => {
    const graph = newGraph()
    const created = await graph.createEntities([
      { name: "Ada", entityType: "person", observations: ["math"] },
      { name: "Ada", entityType: "person", observations: [] },
    ])
    expect(created).toEqual([{ name: "Ada", entityType: "person", observations: ["math"] }])
    expect(
      await graph.createEntities([{ name: "Ada", entityType: "other", observations: [] }]),
    ).toEqual([])
    expect((await graph.readGraph()).entities).toEqual([
      { name: "Ada", entityType: "person", observations: ["math"] },
    ])
  })

  it("rejects a relation whose endpoint does not exist", async () => {
    const graph = newGraph()
    await graph.createEntities([{ name: "Ada", entityType: "person", observations: [] }])
    await expect(
      graph.createRelations([{ from: "Ada", to: "Ghost", relationType: "knows" }]),
    ).rejects.toThrow("Entity with name Ghost not found")
  })

  it("accepts empty strings, matching the official tool contract", async () => {
    const graph = newGraph()
    const created = await graph.createEntities([{ name: "", entityType: "", observations: [""] }])
    expect(created).toEqual([{ name: "", entityType: "", observations: [""] }])
    expect((await graph.readGraph()).entities).toEqual([
      { name: "", entityType: "", observations: [""] },
    ])
  })

  it("preserves duplicate observations given at creation, like the official server", async () => {
    const graph = newGraph()
    const created = await graph.createEntities([
      { name: "Ada", entityType: "person", observations: ["x", "x", "y"] },
    ])
    expect(created).toEqual([{ name: "Ada", entityType: "person", observations: ["x", "x", "y"] }])
    expect((await graph.readGraph()).entities[0]?.observations).toEqual(["x", "x", "y"])
  })

  it("removes every occurrence of a duplicated observation, then re-adds it once", async () => {
    const graph = newGraph()
    await graph.createEntities([{ name: "Ada", entityType: "person", observations: ["x", "x"] }])
    expect(await graph.deleteObservations([{ entityName: "Ada", observations: ["x"] }])).toEqual({
      deletedCount: 2,
      missingEntities: [],
    })
    expect((await graph.readGraph()).entities[0]?.observations).toEqual([])
    expect(await graph.addObservations([{ entityName: "Ada", contents: ["x"] }])).toEqual([
      { entityName: "Ada", addedObservations: ["x"] },
    ])
    expect((await graph.readGraph()).entities[0]?.observations).toEqual(["x"])
  })

  it("adds observations, preserving duplicates within one call", async () => {
    const graph = newGraph()
    await graph.createEntities([{ name: "Ada", entityType: "person", observations: [] }])
    // Duplicate contents in a single call are all added, like the official server.
    expect(await graph.addObservations([{ entityName: "Ada", contents: ["a", "a", "b"] }])).toEqual(
      [{ entityName: "Ada", addedObservations: ["a", "a", "b"] }],
    )
    // A later call sees the additions of the earlier ones.
    expect(await graph.addObservations([{ entityName: "Ada", contents: ["b", "c"] }])).toEqual([
      { entityName: "Ada", addedObservations: ["c"] },
    ])
    expect((await graph.readGraph()).entities[0]?.observations).toEqual(["a", "a", "b", "c"])
  })

  it("rejects observations for a missing entity", async () => {
    const graph = newGraph()
    await expect(graph.addObservations([{ entityName: "Ghost", contents: ["x"] }])).rejects.toThrow(
      "Entity with name Ghost not found",
    )
  })

  it("deletes entities, their observations and their relations", async () => {
    const graph = newGraph()
    await seed(graph)
    expect(await graph.deleteEntities(["Ada", "Ghost"])).toEqual({
      deleted: ["Ada"],
      notFound: ["Ghost"],
    })
    const value = await graph.readGraph()
    expect(value.entities).toEqual([
      { name: "Bob", entityType: "person", observations: ["engineer"] },
    ])
    expect(value.relations).toEqual([])
  })

  it("deletes observations and reports missing entities", async () => {
    const graph = newGraph()
    await graph.createEntities([{ name: "Ada", entityType: "person", observations: ["a", "b"] }])
    expect(
      await graph.deleteObservations([
        { entityName: "Ada", observations: ["a", "z"] },
        { entityName: "Ghost", observations: ["x"] },
      ]),
    ).toEqual({ deletedCount: 1, missingEntities: ["Ghost"] })
    expect((await graph.readGraph()).entities[0]?.observations).toEqual(["b"])
  })

  it("deletes relations and counts distinct matches", async () => {
    const graph = newGraph()
    await seed(graph)
    const relation = { from: "Ada", to: "Bob", relationType: "knows" }
    expect(await graph.deleteRelations([relation, relation])).toEqual({ deletedCount: 1 })
    expect((await graph.readGraph()).relations).toEqual([])
  })

  it("searches entities and includes relations touching the matches", async () => {
    const graph = newGraph()
    await seed(graph)
    expect(await graph.searchNodes("math")).toEqual({
      entities: [{ name: "Ada", entityType: "person", observations: ["mathematician"] }],
      relations: [{ from: "Ada", to: "Bob", relationType: "knows" }],
    })
    expect(await graph.searchNodes("nothing")).toEqual({ entities: [], relations: [] })
  })

  it("opens nodes by name and includes relations touching them", async () => {
    const graph = newGraph()
    await seed(graph)
    expect(await graph.openNodes(["Ada"])).toEqual({
      entities: [{ name: "Ada", entityType: "person", observations: ["mathematician"] }],
      relations: [{ from: "Ada", to: "Bob", relationType: "knows" }],
    })
  })

  it("serializes concurrent mutations without losing operations", async () => {
    const graph = newGraph()
    await graph.createEntities([{ name: "Ada", entityType: "person", observations: [] }])
    await Promise.all(
      ["a", "b", "c", "d", "e"].map((content) =>
        graph.addObservations([{ entityName: "Ada", contents: [content] }]),
      ),
    )
    expect((await graph.readGraph()).entities[0]?.observations).toEqual(["a", "b", "c", "d", "e"])
  })

  it("counts folds when given a metrics registry", async () => {
    const metrics = new Metrics()
    const graph = new MemoryGraph(new ShardLog(new MemoryBackend(), "node"), metrics)
    await graph.createEntities([{ name: "A", entityType: "t", observations: [] }])
    await graph.readGraph()
    expect(metrics.snapshot()["noonien_mcp_folds_total"]).toBe(2)
  })

  it("does not mutate a graph a previous read returned", async () => {
    const graph = newGraph()
    await graph.createEntities([
      { name: "Ada", entityType: "person", observations: ["math"] },
      { name: "Bob", entityType: "person", observations: [] },
    ])
    const before = await graph.readGraph()
    // A mutation must never touch the objects a concurrent read may be holding.
    await graph.deleteEntities(["Ada"])
    await graph.addObservations([{ entityName: "Bob", contents: ["logic"] }])
    expect(before.entities).toEqual([
      { name: "Ada", entityType: "person", observations: ["math"] },
      { name: "Bob", entityType: "person", observations: [] },
    ])
  })

  it("compacts the local shard online once the threshold is reached", async () => {
    const backend = new MemoryBackend()
    const graph = new MemoryGraph(new ShardLog(backend, "node"), undefined, { compactAfter: 2 })
    await graph.createEntities([{ name: "A", entityType: "t", observations: ["x"] }])
    await graph.createEntities([{ name: "B", entityType: "t", observations: [] }])
    const own = decodeOperations((await backend.read("node.jsonl")) ?? "")
    expect(own.some((op) => op.type === "shard.compact")).toBe(true)
    expect(await graph.readGraph()).toEqual({
      entities: [
        { name: "A", entityType: "t", observations: ["x"] },
        { name: "B", entityType: "t", observations: [] },
      ],
      relations: [],
    })
  })

  it("collects tombstones online when the collection guard allows it", async () => {
    const backend = new MemoryBackend()
    const graph = new MemoryGraph(new ShardLog(backend, "node"), undefined, {
      compactAfter: 2,
      collection: () =>
        Promise.resolve(collectionGuard({ suspended: false, peers: [], local: new Map() })),
    })
    await graph.createEntities([{ name: "A", entityType: "t", observations: [] }])
    await graph.deleteEntities(["A"])
    const own = decodeOperations((await backend.read("node.jsonl")) ?? "")
    // The create is shadowed and the tombstone is collectable: only the metadata stays.
    expect(own.map((op) => op.type)).toEqual(["shard.compact"])
    expect(await graph.readGraph()).toEqual({ entities: [], relations: [] })
  })

  it("only prunes shadows online when no collection guard is available", async () => {
    const backend = new MemoryBackend()
    const graph = new MemoryGraph(new ShardLog(backend, "node"), undefined, {
      compactAfter: 2,
      collection: () => Promise.resolve(undefined),
    })
    await graph.createEntities([{ name: "A", entityType: "t", observations: [] }])
    await graph.deleteEntities(["A"])
    const own = decodeOperations((await backend.read("node.jsonl")) ?? "")
    expect(own.map((op) => op.type)).toEqual(["entity.delete", "shard.compact"])
  })

  it("keeps the mutation when the online compaction cannot win", async () => {
    class ContendedBackend extends MemoryBackend {
      override async replace(): Promise<void> {
        throw new Error("contended")
      }
    }
    const graph = new MemoryGraph(new ShardLog(new ContendedBackend(), "node"), undefined, {
      compactAfter: 1,
    })
    const created = await graph.createEntities([{ name: "A", entityType: "t", observations: [] }])
    expect(created).toEqual([{ name: "A", entityType: "t", observations: [] }])
    expect((await graph.readGraph()).entities).toEqual([
      { name: "A", entityType: "t", observations: [] },
    ])
  })

  it("deletes an entity with a very large observation list", async () => {
    // Past ~125k elements a spread call (`push(...ops)`) overflows the call stack,
    // and counting occurrences per content is quadratic; both used to make an
    // entity with tens of thousands of observations undeletable.
    const count = 200_000
    const drafts: OperationDraft[] = [
      { type: "entity.create", name: "Big", entityType: "t" },
      ...Array.from(
        { length: count },
        (_, index): OperationDraft => ({
          type: "observation.add",
          entityName: "Big",
          content: `obs-${index}`,
        }),
      ),
    ]
    const log = new FixedLog(materialize(drafts, "node"))
    const graph = new MemoryGraph(log)
    expect(await graph.deleteEntities(["Big"])).toEqual({ deleted: ["Big"], notFound: [] })
    expect(log.appended[0]).toHaveLength(count + 1)
  }, 30_000) // races the suite default. // The 200k-element case runs a few seconds; give it its own budget so it never
})
