// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it } from "vitest"
import { MemoryGraph } from "../../src/graph/graph.js"
import { ShardLog } from "../../src/store/log.js"
import { MemoryBackend } from "../../src/sync/memory.js"

function newGraph(node = "n1"): { graph: MemoryGraph; backend: MemoryBackend } {
  const backend = new MemoryBackend()
  return { graph: new MemoryGraph(new ShardLog(backend, node)), backend }
}

async function seed(graph: MemoryGraph): Promise<void> {
  await graph.createEntities([
    { name: "Ada", entityType: "person", observations: ["mathematician", "lives in London"] },
    { name: "Bob", entityType: "person", observations: ["engineer", "lives in Rome"] },
    { name: "Rome", entityType: "city", observations: ["capital of Italy"] },
  ])
  await graph.createRelations([{ from: "Bob", to: "Rome", relationType: "lives in" }])
}

describe("read_changes", () => {
  it("returns what an operation touched and the names deleted, and never a compact marker", async () => {
    const { graph } = newGraph()
    await seed(graph)
    const past = new Date(Date.now() - 60 * 60 * 1000)
    await graph.createEntities([{ name: "Zoe", entityType: "person", observations: ["doctor"] }])
    await graph.deleteEntities(["Bob"])
    const changes = await graph.changes(past)
    expect(changes.entities.map((entity) => entity.name)).toEqual(
      expect.arrayContaining(["Zoe", "Rome"]),
    )
    expect(changes.entities.map((entity) => entity.name)).not.toContain("Bob")
    expect(changes.deleted).toEqual(["Bob"])
    expect(changes.until >= changes.since).toBe(true)
  })

  it("clamps a since in the future instead of answering nothing", async () => {
    const { graph } = newGraph()
    await seed(graph)
    const future = new Date(Date.now() + 60 * 60 * 1000)
    const changes = await graph.changes(future)
    expect(changes.entities.map((entity) => entity.name)).toEqual(
      expect.arrayContaining(["Ada", "Bob"]),
    )
  })
})

describe("find_nodes", () => {
  it("matches every word as a prefix and finds what a literal search cannot", async () => {
    const { graph } = newGraph()
    await seed(graph)
    const found = await graph.findNodes("lives rome")
    expect(found.entities.map((entity) => entity.name)).toEqual(expect.arrayContaining(["Bob"]))
    // `port` matches a word beginning with it, never one that merely contains it.
    await graph.createEntities([
      { name: "Helpdesk", entityType: "team", observations: ["support calls"] },
    ])
    const literal = await graph.searchNodes("port")
    const word = await graph.findNodes("port")
    expect(literal.entities.map((entity) => entity.name)).toContain("Helpdesk")
    expect(word.entities.map((entity) => entity.name)).not.toContain("Helpdesk")
  })

  it("ranks a name hit above an observation hit", async () => {
    const { graph } = newGraph()
    await seed(graph)
    await graph.createEntities([
      { name: "London notes", entityType: "note", observations: ["nothing here"] },
    ])
    const found = await graph.findNodes("London")
    expect(found.entities[0]?.name).toBe("London notes")
  })
})

describe("expand_nodes", () => {
  it("adds the neighbours at depth 1 and marks a truncated walk", async () => {
    const { graph } = newGraph()
    await seed(graph)
    const opened = await graph.openNodes(["Bob"])
    const expanded = await graph.expandNodes(["Bob"])
    // Same relations, because both report the ones incident to the result — but the walk
    // also brings the neighbour's content, which is the point of it.
    expect(expanded.relations).toEqual(opened.relations)
    expect(expanded.entities.map((entity) => entity.name)).toEqual(["Bob", "Rome"])
    expect(expanded.truncated).toBe(false)
    const capped = await graph.expandNodes(["Bob"], { depth: 2, limit: 1 })
    expect(capped.entities).toHaveLength(1)
    expect(capped.truncated).toBe(true)
  })
})

describe("resolve_conflict", () => {
  it("writes nothing when the graph already agrees and restores a tombstoned observation", async () => {
    const { graph, backend } = newGraph()
    await seed(graph)
    const unchanged = await graph.resolveConflicts([
      { entityName: "Ada", content: "mathematician", keep: true },
    ])
    expect(unchanged.results[0]?.changed).toBe(false)

    await graph.deleteObservations([{ entityName: "Ada", observations: ["mathematician"] }])
    const restored = await graph.resolveConflicts([
      { entityName: "Ada", content: "mathematician", keep: true },
    ])
    expect(restored.results[0]?.changed).toBe(true)
    const read = await graph.openNodes(["Ada"])
    expect(read.entities[0]?.observations).toContain("mathematician")

    const kinds = new Set((await new ShardLog(backend, "n1").read()).map((op) => op.type))
    expect([...kinds].sort()).toEqual([
      "entity.create",
      "observation.add",
      "observation.delete",
      "relation.add",
    ])
  })

  it("drops a relation and refuses to keep one with a missing endpoint", async () => {
    const { graph } = newGraph()
    await seed(graph)
    const dropped = await graph.resolveConflicts([
      { from: "Bob", to: "Rome", relationType: "lives in", keep: false },
    ])
    expect(dropped.results[0]?.changed).toBe(true)
    await expect(
      graph.resolveConflicts([
        { from: "Bob", to: "Atlantis", relationType: "lives in", keep: true },
      ]),
    ).rejects.toThrow(/not found/)
    await expect(
      graph.resolveConflicts([{ entityName: "Ghost", content: "x", keep: true }]),
    ).rejects.toThrow(/not found/)
  })
})

describe("set_observations", () => {
  it("adds, replaces, and collapses a drifted twin into one observation", async () => {
    const { graph } = newGraph()
    await seed(graph)
    await graph.addObservations([{ entityName: "Ada", contents: ["version 1.0", "version: 1.1"] }])
    const result = await graph.setObservations([
      { entityName: "Ada", key: "version", value: "1.2" },
    ])
    expect(result.results[0]?.action).toBe("replaced")
    const read = await graph.openNodes(["Ada"])
    const owned = (read.entities[0]?.observations ?? []).filter(
      (content) => content === "version" || content.startsWith("version: "),
    )
    expect(owned).toEqual(["version: 1.2"])
  })

  it("writing the value a key already holds changes nothing", async () => {
    const { graph } = newGraph()
    await seed(graph)
    await graph.setObservations([{ entityName: "Ada", key: "version", value: "1.2" }])
    const again = await graph.setObservations([{ entityName: "Ada", key: "version", value: "1.2" }])
    expect(again.results[0]?.action).toBe("replaced")
    const read = await graph.openNodes(["Ada"])
    expect(read.entities[0]?.observations).toContain("version: 1.2")
  })

  it("refuses a key that contains a colon and a space, and a missing entity", async () => {
    const { graph } = newGraph()
    await seed(graph)
    await expect(
      graph.setObservations([{ entityName: "Ada", key: "a: b", value: "x" }]),
    ).rejects.toThrow(/colon/)
    await expect(
      graph.setObservations([{ entityName: "Nobody", key: "a", value: "x" }]),
    ).rejects.toThrow(/not found/)
  })
})

describe("read_history", () => {
  it("reports newest first and counts a relation under both endpoints", async () => {
    const { graph } = newGraph()
    await seed(graph)
    const { entries } = await graph.history({ entityNames: ["Rome"] })
    expect(entries.length).toBeGreaterThan(0)
    expect(entries[0]?.node).toBe("n1")
    expect(entries.every((entry) => entry.entityName === "Rome")).toBe(true)
    expect(entries.some((entry) => entry.kind === "relation.add")).toBe(true)
    const ordered = entries.map((entry) => entry.ts)
    expect([...ordered].sort().reverse()).toEqual(ordered)
  })
})

describe("find_duplicates", () => {
  it("proposes a normalised-name pair and a content pair", async () => {
    const { graph } = newGraph()
    await graph.createEntities([
      { name: "nooniend", entityType: "service", observations: ["replicates shards"] },
      { name: "noonien daemon", entityType: "service", observations: ["replicates shards"] },
      { name: "unrelated", entityType: "note", observations: ["something else"] },
    ])
    const byName = await graph.findDuplicates({ threshold: 0.5 })
    expect(byName.pairs.map((pair) => [pair.a, pair.b].sort().join("|"))).toContain(
      ["nooniend", "noonien daemon"].sort().join("|"),
    )
    const byContent = await graph.findDuplicates({ by: "content", threshold: 0.5 })
    expect(byContent.pairs.length).toBeGreaterThan(0)
  })
})

describe("merge_entities dry run", () => {
  it("writes nothing and reports the same counts the real merge then does", async () => {
    const { graph, backend } = newGraph()
    await seed(graph)
    const before = (await new ShardLog(backend, "n1").read()).length
    const preview = await graph.mergeEntities([{ from: "Rome", into: "Ada" }], { dryRun: true })
    expect(preview.results[0]?.applied).toBe(false)
    expect((await new ShardLog(backend, "n1").read()).length).toBe(before)

    const real = await graph.mergeEntities([{ from: "Rome", into: "Ada" }])
    expect(real.results[0]?.applied).toBe(true)
    expect(real.results[0]?.observationsJoined).toBe(preview.results[0]?.observationsJoined)
    expect(real.results[0]?.relationsRepointed).toBe(preview.results[0]?.relationsRepointed)
  })
})

describe("stats", () => {
  it("counts, ranks, and calls nothing stale on a fresh graph", async () => {
    const { graph } = newGraph()
    await seed(graph)
    const stats = await graph.stats()
    expect(stats.entities).toBe(3)
    expect(stats.relations).toBe(1)
    expect(stats.observations).toBe(5)
    expect(stats.deletions).toBe(0)
    expect(stats.stale).toEqual([])
    expect(stats.largest[0]?.observations).toBe(2)
    expect(stats.byType[0]).toEqual({ entityType: "person", entities: 2 })
  })
})
