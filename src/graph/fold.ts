// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Operation } from "./operations.js"
import { compareOperations, observationContentKey, relationKey } from "./operations.js"
import type { Entity, KnowledgeGraph, Relation } from "./types.js"

interface Winner {
  readonly op: Operation
  readonly present: boolean
}

/**
 * The live state of one (entity, content) observation: the latest add per
 * occurrence slot, and the latest content-level delete. An observation is
 * present at a slot when its latest add is newer than the latest delete, which
 * is how `add_observations` and `create_entities` — both of which may carry
 * duplicate contents, like the official server — fall out of the same rule.
 */
interface ObservationGroup {
  readonly entityName: string
  readonly content: string
  readonly adds: Map<number, Operation>
  lastDelete: Operation | undefined
}

interface State {
  readonly entities: Map<string, Winner>
  readonly relations: Map<string, Winner>
  readonly observations: Map<string, ObservationGroup>
}

function keepLatest(map: Map<string, Winner>, key: string, op: Operation, present: boolean): void {
  const current = map.get(key)
  if (current === undefined || compareOperations(op, current.op) > 0) {
    map.set(key, { op, present })
  }
}

function observationGroup(
  map: Map<string, ObservationGroup>,
  entityName: string,
  content: string,
): ObservationGroup {
  const key = observationContentKey(entityName, content)
  const existing = map.get(key)
  if (existing !== undefined) {
    return existing
  }
  const group: ObservationGroup = { entityName, content, adds: new Map(), lastDelete: undefined }
  map.set(key, group)
  return group
}

function accumulate(state: State, op: Operation): void {
  switch (op.type) {
    case "entity.create":
      keepLatest(state.entities, op.name, op, true)
      return
    case "entity.delete":
      keepLatest(state.entities, op.name, op, false)
      return
    case "relation.add":
      keepLatest(state.relations, relationKey(op), op, true)
      return
    case "relation.delete":
      keepLatest(state.relations, relationKey(op), op, false)
      return
    case "observation.add": {
      const group = observationGroup(state.observations, op.entityName, op.content)
      const slot = op.slot ?? 0
      const current = group.adds.get(slot)
      if (current === undefined || compareOperations(op, current) > 0) {
        group.adds.set(slot, op)
      }
      return
    }
    case "observation.delete": {
      const group = observationGroup(state.observations, op.entityName, op.content)
      if (group.lastDelete === undefined || compareOperations(op, group.lastDelete) > 0) {
        group.lastDelete = op
      }
      return
    }
    case "shard.compact":
      // A shard-owned metadata operation: it never affects the graph.
      return
  }
}

function presentEntities(entities: Map<string, Winner>): Map<string, Entity> {
  const byName = new Map<string, Entity>()
  for (const [name, winner] of entities) {
    if (winner.present && winner.op.type === "entity.create") {
      byName.set(name, { name, entityType: winner.op.entityType, observations: [] })
    }
  }
  return byName
}

function attachObservations(
  observations: Map<string, ObservationGroup>,
  byName: Map<string, Entity>,
): void {
  const additions: {
    readonly op: Operation
    readonly entityName: string
    readonly content: string
  }[] = []
  for (const group of observations.values()) {
    if (!byName.has(group.entityName)) {
      continue
    }
    for (const add of group.adds.values()) {
      if (group.lastDelete === undefined || compareOperations(add, group.lastDelete) > 0) {
        additions.push({ op: add, entityName: group.entityName, content: group.content })
      }
    }
  }
  additions.sort((a, b) => compareOperations(a.op, b.op))
  for (const addition of additions) {
    byName.get(addition.entityName)?.observations.push(addition.content)
  }
}

function presentRelations(relations: Map<string, Winner>, byName: Map<string, Entity>): Relation[] {
  const present: Relation[] = []
  for (const winner of relations.values()) {
    if (winner.present && winner.op.type === "relation.add") {
      const { op } = winner
      if (byName.has(op.from) && byName.has(op.to)) {
        present.push({ from: op.from, to: op.to, relationType: op.relationType })
      }
    }
  }
  present.sort(compareRelations)
  return present
}

/**
 * Fold an operation log into a knowledge graph.
 *
 * Entities and relations are LWW registers decided by {@link compareOperations}.
 * Observations behave like the official server: adding a content already present
 * has no effect, `create_entities` may carry the same content more than once
 * (each occurrence is a separate slot), and deleting an observation removes
 * every occurrence of that content. Observations are shown only while their
 * entity is present, and relations only while both endpoints are present.
 *
 * The fold is a pure function of the operation *set*: it does not depend on the
 * order in which shards or lines were read, so any two nodes that have seen the
 * same operations produce the identical graph (idempotent, commutative,
 * associative, convergent).
 */
export function foldOperations(ops: Iterable<Operation>): KnowledgeGraph {
  const state: State = { entities: new Map(), relations: new Map(), observations: new Map() }
  for (const op of ops) {
    accumulate(state, op)
  }
  const byName = presentEntities(state.entities)
  attachObservations(state.observations, byName)
  return {
    entities: [...byName.values()].sort(compareEntities),
    relations: presentRelations(state.relations, byName),
  }
}

function compareEntities(a: Entity, b: Entity): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

function compareRelations(a: Relation, b: Relation): number {
  if (a.from !== b.from) {
    return a.from < b.from ? -1 : 1
  }
  if (a.to !== b.to) {
    return a.to < b.to ? -1 : 1
  }
  if (a.relationType !== b.relationType) {
    return a.relationType < b.relationType ? -1 : 1
  }
  return 0
}
