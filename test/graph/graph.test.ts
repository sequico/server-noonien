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

  it("renames an entity, moving its observations and relations", async () => {
    const graph = newGraph()
    await seed(graph)
    const before = await graph.readGraph()
    expect(
      await graph.updateEntities([
        { name: "Ada", newName: "Ada Lovelace", entityType: "mathematician" },
      ]),
    ).toEqual({
      results: [
        { name: "Ada", renamedTo: "Ada Lovelace", entityType: "mathematician", updated: true },
      ],
    })
    expect(await graph.readGraph()).toEqual({
      entities: [
        { name: "Ada Lovelace", entityType: "mathematician", observations: ["mathematician"] },
        { name: "Bob", entityType: "person", observations: ["engineer"] },
      ],
      relations: [{ from: "Ada Lovelace", to: "Bob", relationType: "knows" }],
    })
    // The rename must not touch the objects a previous read returned.
    expect(before.entities[0]?.name).toBe("Ada")
    expect(before.relations[0]?.from).toBe("Ada")
  })

  it("keeps a rename intact across an online compaction", async () => {
    const backend = new MemoryBackend()
    // Compact on every append, so the rename's operations are rewritten as soon
    // as they land.
    const graph = new MemoryGraph(new ShardLog(backend, "node"), undefined, { compactAfter: 1 })
    await seed(graph)
    await graph.updateEntities([{ name: "Ada", newName: "Ada Lovelace" }])
    expect(await graph.readGraph()).toEqual({
      entities: [
        { name: "Ada Lovelace", entityType: "person", observations: ["mathematician"] },
        { name: "Bob", entityType: "person", observations: ["engineer"] },
      ],
      relations: [{ from: "Ada Lovelace", to: "Bob", relationType: "knows" }],
    })
    // The tombstone of the old name survived the rewrite: re-creating it does not
    // revive the observations the rename moved away.
    await graph.createEntities([{ name: "Ada", entityType: "person", observations: [] }])
    expect((await graph.readGraph()).entities).toEqual([
      { name: "Ada", entityType: "person", observations: [] },
      { name: "Ada Lovelace", entityType: "person", observations: ["mathematician"] },
      { name: "Bob", entityType: "person", observations: ["engineer"] },
    ])
  })

  it("does not revive the old name's observations when it is created again", async () => {
    const graph = newGraph()
    await seed(graph)
    await graph.updateEntities([{ name: "Ada", newName: "Ada Lovelace" }])
    await graph.createEntities([{ name: "Ada", entityType: "person", observations: [] }])
    expect((await graph.readGraph()).entities).toEqual([
      { name: "Ada", entityType: "person", observations: [] },
      { name: "Ada Lovelace", entityType: "person", observations: ["mathematician"] },
      { name: "Bob", entityType: "person", observations: ["engineer"] },
    ])
  })

  it("preserves duplicate observations across a rename", async () => {
    const graph = newGraph()
    await graph.createEntities([{ name: "Ada", entityType: "person", observations: ["x", "x"] }])
    await graph.updateEntities([{ name: "Ada", newName: "Ada Lovelace" }])
    expect((await graph.readGraph()).entities[0]?.observations).toEqual(["x", "x"])
  })

  it("changes an entity type alone, treating an unchanged value as applied", async () => {
    const graph = newGraph()
    await seed(graph)
    expect(await graph.updateEntities([{ name: "Ada", entityType: "mathematician" }])).toEqual({
      results: [{ name: "Ada", entityType: "mathematician", updated: true }],
    })
    expect((await graph.readGraph()).entities.map((entity) => entity.entityType)).toEqual([
      "mathematician",
      "person",
    ])
    // Nothing to change: reported as applied, and the observations are untouched.
    expect(await graph.updateEntities([{ name: "Ada", entityType: "mathematician" }])).toEqual({
      results: [{ name: "Ada", entityType: "mathematician", updated: true }],
    })
    expect((await graph.readGraph()).entities[0]?.observations).toEqual(["mathematician"])
  })

  it("is idempotent: repeating a rename changes nothing after the first", async () => {
    const graph = newGraph()
    await seed(graph)
    await graph.updateEntities([{ name: "Ada", newName: "Ada Lovelace" }])
    const before = await graph.readGraph()
    expect(await graph.updateEntities([{ name: "Ada", newName: "Ada Lovelace" }])).toEqual({
      results: [{ name: "Ada", updated: false, reason: "entity not found" }],
    })
    expect(await graph.readGraph()).toEqual(before)
  })

  it("refuses a rename onto an existing name and reports an unknown one", async () => {
    const graph = newGraph()
    await seed(graph)
    expect(
      await graph.updateEntities([
        { name: "Ada", newName: "Bob" },
        { name: "Ghost", newName: "Ghost II" },
      ]),
    ).toEqual({
      results: [
        { name: "Ada", updated: false, reason: 'entity "Bob" already exists' },
        { name: "Ghost", updated: false, reason: "entity not found" },
      ],
    })
    expect((await graph.readGraph()).entities.map((entity) => entity.name)).toEqual(["Ada", "Bob"])
  })

  it("applies a batch of renames, repointing relations across its entries", async () => {
    const graph = newGraph()
    await seed(graph)
    expect(
      await graph.updateEntities([
        { name: "Ada", newName: "Temp" },
        { name: "Bob", newName: "Ada" },
      ]),
    ).toEqual({
      results: [
        { name: "Ada", renamedTo: "Temp", entityType: "person", updated: true },
        { name: "Bob", renamedTo: "Ada", entityType: "person", updated: true },
      ],
    })
    expect((await graph.readGraph()).relations).toEqual([
      { from: "Temp", to: "Ada", relationType: "knows" },
    ])
  })

  it("updates a relation type and repoints its endpoints", async () => {
    const graph = newGraph()
    await seed(graph)
    expect(
      await graph.updateRelations([
        { from: "Ada", to: "Bob", relationType: "knows", newRelationType: "mentors" },
      ]),
    ).toEqual({
      results: [{ from: "Ada", to: "Bob", relationType: "knows", updated: true }],
    })
    expect((await graph.readGraph()).relations).toEqual([
      { from: "Ada", to: "Bob", relationType: "mentors" },
    ])
    expect(
      await graph.updateRelations([
        { from: "Ada", to: "Bob", relationType: "mentors", newFrom: "Bob", newTo: "Ada" },
      ]),
    ).toEqual({
      results: [{ from: "Ada", to: "Bob", relationType: "mentors", updated: true }],
    })
    expect((await graph.readGraph()).relations).toEqual([
      { from: "Bob", to: "Ada", relationType: "mentors" },
    ])
  })

  it("removes the old edge when a repoint lands on an existing relation", async () => {
    const graph = newGraph()
    await seed(graph)
    await graph.createEntities([{ name: "Carol", entityType: "person", observations: [] }])
    await graph.createRelations([{ from: "Ada", to: "Carol", relationType: "knows" }])
    // The target key already exists, so the edit's add is a set-add and only the
    // old edge goes: a relation is a set, so nothing else is lost.
    expect(
      await graph.updateRelations([
        { from: "Ada", to: "Carol", relationType: "knows", newTo: "Bob" },
      ]),
    ).toEqual({
      results: [{ from: "Ada", to: "Carol", relationType: "knows", updated: true }],
    })
    expect((await graph.readGraph()).relations).toEqual([
      { from: "Ada", to: "Bob", relationType: "knows" },
    ])
  })

  it("reports an unknown relation or a missing endpoint", async () => {
    const graph = newGraph()
    await seed(graph)
    expect(
      await graph.updateRelations([
        { from: "Ada", to: "Ghost", relationType: "knows" },
        { from: "Ada", to: "Bob", relationType: "knows", newTo: "Ghost" },
      ]),
    ).toEqual({
      results: [
        {
          from: "Ada",
          to: "Ghost",
          relationType: "knows",
          updated: false,
          reason: "relation not found",
        },
        {
          from: "Ada",
          to: "Bob",
          relationType: "knows",
          updated: false,
          reason: 'entity "Ghost" not found',
        },
      ],
    })
    expect((await graph.readGraph()).relations).toEqual([
      { from: "Ada", to: "Bob", relationType: "knows" },
    ])
  })

  it("merges one entity into another, union and repointing", async () => {
    const graph = newGraph()
    await graph.createEntities([
      { name: "Ada", entityType: "person", observations: ["math"] },
      { name: "Ada Lovelace", entityType: "person", observations: ["math", "logic"] },
      { name: "Bob", entityType: "person", observations: [] },
    ])
    await graph.createRelations([
      { from: "Ada", to: "Bob", relationType: "knows" },
      { from: "Bob", to: "Ada", relationType: "knows" },
    ])
    expect(await graph.mergeEntities([{ from: "Ada", into: "Ada Lovelace" }])).toEqual({
      results: [{ from: "Ada", into: "Ada Lovelace", merged: true }],
    })
    // The union does not duplicate the content the target already held, and both
    // directions of the repointing are followed.
    expect(await graph.readGraph()).toEqual({
      entities: [
        { name: "Ada Lovelace", entityType: "person", observations: ["math", "logic"] },
        { name: "Bob", entityType: "person", observations: [] },
      ],
      relations: [
        { from: "Ada Lovelace", to: "Bob", relationType: "knows" },
        { from: "Bob", to: "Ada Lovelace", relationType: "knows" },
      ],
    })
  })

  it("reports a merge it cannot do", async () => {
    const graph = newGraph()
    await seed(graph)
    expect(
      await graph.mergeEntities([
        { from: "Ada", into: "Ada" },
        { from: "Ghost", into: "Ada" },
        { from: "Ada", into: "Ghost" },
      ]),
    ).toEqual({
      results: [
        {
          from: "Ada",
          into: "Ada",
          merged: false,
          reason: "an entity cannot be merged into itself",
        },
        { from: "Ghost", into: "Ada", merged: false, reason: "entity not found" },
        { from: "Ada", into: "Ghost", merged: false, reason: 'entity "Ghost" not found' },
      ],
    })
    expect((await graph.readGraph()).entities.map((entity) => entity.name)).toEqual(["Ada", "Bob"])
  })

  it("replaces an observation content, keeping the rest", async () => {
    const graph = newGraph()
    await graph.createEntities([
      { name: "Ada", entityType: "person", observations: ["math", "logic"] },
    ])
    expect(
      await graph.updateObservations([
        { entityName: "Ada", oldContent: "math", newContent: "mathematics" },
        { entityName: "Ada", oldContent: "logic", newContent: "mathematics" },
        { entityName: "Ada", oldContent: "mathematics", newContent: "mathematics" },
        { entityName: "Ada", oldContent: "absent", newContent: "x" },
        { entityName: "Ghost", oldContent: "x", newContent: "y" },
      ]),
    ).toEqual({
      results: [
        { entityName: "Ada", oldContent: "math", newContent: "mathematics", updated: true },
        { entityName: "Ada", oldContent: "logic", newContent: "mathematics", updated: true },
        { entityName: "Ada", oldContent: "mathematics", newContent: "mathematics", updated: true },
        {
          entityName: "Ada",
          oldContent: "absent",
          newContent: "x",
          updated: false,
          reason: "observation not found",
        },
        {
          entityName: "Ghost",
          oldContent: "x",
          newContent: "y",
          updated: false,
          reason: "entity not found",
        },
      ],
    })
    // Both sources collapsed onto one content: the replacement is a set, not a copy.
    expect((await graph.readGraph()).entities[0]?.observations).toEqual(["mathematics"])
  })

  it("pages a read and filters a search by type", async () => {
    const graph = newGraph()
    await graph.createEntities([
      { name: "A", entityType: "person", observations: [] },
      { name: "B", entityType: "place", observations: [] },
      { name: "C", entityType: "person", observations: [] },
    ])
    await graph.createRelations([{ from: "A", to: "B", relationType: "visits" }])
    expect((await graph.readGraph({ limit: 2, offset: 1 })).entities.map((e) => e.name)).toEqual([
      "B",
      "C",
    ])
    expect((await graph.readGraph({ limit: 1 })).relations).toEqual([
      { from: "A", to: "B", relationType: "visits" },
    ])
    expect(
      (await graph.searchNodes("", { entityType: "person" })).entities.map((e) => e.name),
    ).toEqual(["A", "C"])
    expect(
      (await graph.searchNodes("", { limit: 1, offset: 1 })).entities.map((e) => e.name),
    ).toEqual(["B"])
  })

  it("reports an element two nodes both wrote", async () => {
    // Each node writes on its own store — a single store would let the second one see
    // the first's operation and skip it — then the shards are exchanged, as the daemon
    // does.
    const backendA = new MemoryBackend()
    const backendB = new MemoryBackend()
    const one = new MemoryGraph(new ShardLog(backendA, "n1"))
    const two = new MemoryGraph(new ShardLog(backendB, "n2"))
    await one.createEntities([{ name: "Ada", entityType: "person", observations: [] }])
    // One author is not a conflict.
    expect(await one.conflicts()).toEqual({ conflicts: [] })
    await two.createEntities([{ name: "Ada", entityType: "scientist", observations: [] }])
    const shard = await backendB.read("n2.jsonl")
    if (shard !== undefined) {
      await backendA.append("n2.jsonl", shard)
    }
    expect(await one.conflicts()).toEqual({
      conflicts: [{ element: 'entity "Ada"', authors: ["n1", "n2"], operations: 2 }],
    })
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
