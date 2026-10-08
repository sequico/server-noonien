// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it } from "vitest"
import { foldOperations } from "../../src/graph/fold.js"
import { op, T1, T2, T3 } from "../support/operations.js"

describe("foldOperations", () => {
  it("creates an entity together with its observations", () => {
    const graph = foldOperations([
      op({ type: "entity.create", name: "Ada", entityType: "person" }, { ts: T1, seq: 0 }),
      op(
        { type: "observation.add", entityName: "Ada", content: "mathematician" },
        { ts: T1, seq: 1 },
      ),
    ])
    expect(graph).toEqual({
      entities: [{ name: "Ada", entityType: "person", observations: ["mathematician"] }],
      relations: [],
    })
  })

  it("keeps observations in the order they were added", () => {
    const graph = foldOperations([
      op({ type: "entity.create", name: "Ada", entityType: "person" }, { ts: T1, seq: 0 }),
      op({ type: "observation.add", entityName: "Ada", content: "second" }, { ts: T2, seq: 1 }),
      op({ type: "observation.add", entityName: "Ada", content: "first" }, { ts: T3, seq: 2 }),
    ])
    expect(graph.entities[0]?.observations).toEqual(["second", "first"])
  })

  it("hides an entity, its observations and its relations when it is deleted", () => {
    const graph = foldOperations([
      op({ type: "entity.create", name: "Ada", entityType: "person" }, { ts: T1, seq: 0 }),
      op({ type: "entity.create", name: "Bob", entityType: "person" }, { ts: T1, seq: 1 }),
      op({ type: "observation.add", entityName: "Ada", content: "math" }, { ts: T1, seq: 2 }),
      op(
        { type: "relation.add", from: "Ada", to: "Bob", relationType: "knows" },
        { ts: T1, seq: 3 },
      ),
      op({ type: "entity.delete", name: "Ada" }, { ts: T2, seq: 4 }),
    ])
    expect(graph.entities).toEqual([{ name: "Bob", entityType: "person", observations: [] }])
    expect(graph.relations).toEqual([])
  })

  it("lets a later create resurrect a deleted entity", () => {
    const graph = foldOperations([
      op({ type: "entity.create", name: "Ada", entityType: "person" }, { ts: T1, seq: 0 }),
      op({ type: "entity.delete", name: "Ada" }, { ts: T2, seq: 1 }),
      op({ type: "entity.create", name: "Ada", entityType: "machine" }, { ts: T3, seq: 2 }),
    ])
    expect(graph.entities).toEqual([{ name: "Ada", entityType: "machine", observations: [] }])
  })

  it("removes a single observation without touching the entity", () => {
    const graph = foldOperations([
      op({ type: "entity.create", name: "Ada", entityType: "person" }, { ts: T1, seq: 0 }),
      op({ type: "observation.add", entityName: "Ada", content: "keep" }, { ts: T1, seq: 1 }),
      op({ type: "observation.add", entityName: "Ada", content: "drop" }, { ts: T1, seq: 2 }),
      op({ type: "observation.delete", entityName: "Ada", content: "drop" }, { ts: T2, seq: 3 }),
    ])
    expect(graph.entities[0]?.observations).toEqual(["keep"])
  })

  it("lets a later add restore a deleted observation", () => {
    const graph = foldOperations([
      op({ type: "entity.create", name: "Ada", entityType: "person" }, { ts: T1, seq: 0 }),
      op({ type: "observation.add", entityName: "Ada", content: "o" }, { ts: T1, seq: 1 }),
      op({ type: "observation.delete", entityName: "Ada", content: "o" }, { ts: T2, seq: 2 }),
      op({ type: "observation.add", entityName: "Ada", content: "o" }, { ts: T3, seq: 3 }),
    ])
    expect(graph.entities[0]?.observations).toEqual(["o"])
  })

  it("shows a relation only while both endpoints exist", () => {
    const base = [
      op({ type: "entity.create", name: "Ada", entityType: "person" }, { ts: T1, seq: 0 }),
      op({ type: "entity.create", name: "Bob", entityType: "person" }, { ts: T1, seq: 1 }),
      op(
        { type: "relation.add", from: "Ada", to: "Bob", relationType: "knows" },
        { ts: T1, seq: 2 },
      ),
    ]
    expect(foldOperations(base).relations).toEqual([
      { from: "Ada", to: "Bob", relationType: "knows" },
    ])
    expect(
      foldOperations([...base, op({ type: "entity.delete", name: "Bob" }, { ts: T2, seq: 3 })])
        .relations,
    ).toEqual([])
  })

  it("shows a concurrent observation again when the entity is recreated", () => {
    const deleted = [
      op({ type: "entity.create", name: "E", entityType: "t" }, { ts: T1, seq: 0, node: "a" }),
      op({ type: "observation.add", entityName: "E", content: "x" }, { ts: T2, seq: 0, node: "b" }),
      op({ type: "entity.delete", name: "E" }, { ts: T3, seq: 1, node: "a" }),
    ]
    expect(foldOperations(deleted).entities).toEqual([])
    const recreated = [
      ...deleted,
      op({ type: "entity.create", name: "E", entityType: "t" }, { ts: T3, seq: 2, node: "a" }),
    ]
    expect(foldOperations(recreated).entities).toEqual([
      { name: "E", entityType: "t", observations: ["x"] },
    ])
  })

  it("breaks ties by node id when timestamps are equal", () => {
    const created = foldOperations([
      op(
        { type: "entity.create", name: "Ada", entityType: "from-a" },
        { ts: T1, seq: 0, node: "a" },
      ),
      op(
        { type: "entity.create", name: "Ada", entityType: "from-b" },
        { ts: T1, seq: 0, node: "b" },
      ),
    ])
    expect(created.entities[0]?.entityType).toBe("from-b")
  })

  it("is independent of iteration order", () => {
    const bob = op({ type: "entity.create", name: "Bob", entityType: "person" }, { ts: T1, seq: 0 })
    const ada = op({ type: "entity.create", name: "Ada", entityType: "person" }, { ts: T1, seq: 1 })
    const relation = op(
      { type: "relation.add", from: "Ada", to: "Bob", relationType: "knows" },
      { ts: T1, seq: 2 },
    )
    const observation = op(
      { type: "observation.add", entityName: "Ada", content: "math" },
      { ts: T1, seq: 3 },
    )
    const ops = [bob, ada, relation, observation]
    expect(foldOperations([...ops].reverse())).toEqual(foldOperations(ops))
    expect(foldOperations([relation, bob, observation, ada])).toEqual(foldOperations(ops))
  })
})
