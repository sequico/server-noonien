// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, warn } from "../diagnostics.js"
import type { Metrics } from "../metrics.js"
import type { CollectionGuard, OperationLog, PruneResult } from "../store/log.js"
import { foldOperations } from "./fold.js"
import type { Operation, OperationDraft } from "./operations.js"
import { observationContentKey, relationKey } from "./operations.js"
import type { Entity, KnowledgeGraph, Relation } from "./types.js"

export interface ObservationInput {
  readonly entityName: string
  readonly contents: readonly string[]
}

export interface ObservationDeletionInput {
  readonly entityName: string
  readonly observations: readonly string[]
}

export interface AddedObservations {
  readonly entityName: string
  readonly addedObservations: string[]
}

export interface DeleteEntitiesResult {
  readonly deleted: string[]
  readonly notFound: string[]
}

export interface DeleteObservationsResult {
  readonly deletedCount: number
  readonly missingEntities: string[]
}

export interface DeleteRelationsResult {
  readonly deletedCount: number
}

export interface UpdateEntityInput {
  readonly name: string
  readonly newName?: string | undefined
  readonly entityType?: string | undefined
}

export interface UpdatedEntity {
  readonly name: string
  readonly renamedTo?: string
  readonly entityType?: string
  readonly updated: boolean
  readonly reason?: string
}

export interface UpdateEntitiesResult {
  readonly results: readonly UpdatedEntity[]
}

export interface UpdateRelationInput {
  readonly from: string
  readonly to: string
  readonly relationType: string
  readonly newFrom?: string | undefined
  readonly newTo?: string | undefined
  readonly newRelationType?: string | undefined
}

export interface UpdatedRelation {
  readonly from: string
  readonly to: string
  readonly relationType: string
  readonly updated: boolean
  readonly reason?: string
}

export interface UpdateRelationsResult {
  readonly results: readonly UpdatedRelation[]
}

export interface MemoryGraphOptions {
  /** Compact the local shard online after this many appended operations (0 disables). */
  readonly compactAfter?: number
  /**
   * Resolve the collection guard when the threshold is reached. A guard collects the
   * local shard's tombstones (physical deletion, like the official server); returning
   * `undefined` only prunes shadowed operations — what a directory where a daemon owns
   * collection does, because collecting safely there needs the peer knowledge it holds.
   */
  readonly collection?: () => Promise<CollectionGuard | undefined>
}

/**
 * The content-level deletes to queue for one entity, and the observations left
 * after them. One delete is emitted per distinct content requested, and every
 * occurrence of that content is counted, matching the official server even when
 * a content was duplicated. It never touches the folded graph: it returns the
 * remaining observations so the caller can track removals without mutating the
 * memoized state a concurrent read may be holding.
 */
function observationDeletes(
  entityName: string,
  observations: readonly string[],
  contents: readonly string[],
): { readonly removed: number; readonly drafts: OperationDraft[]; readonly remaining: string[] } {
  const targets = new Set(contents)
  // One pass counts every occurrence of each targeted content. Scanning the whole
  // list once per distinct content would be quadratic, which a single entity with
  // many observations (tens of thousands, tens of thousands distinct) makes
  // pathological.
  const occurrences = new Map<string, number>()
  for (const content of observations) {
    if (targets.has(content)) {
      occurrences.set(content, (occurrences.get(content) ?? 0) + 1)
    }
  }
  const drafts: OperationDraft[] = []
  let removed = 0
  for (const [content, count] of occurrences) {
    removed += count
    drafts.push({ type: "observation.delete", entityName, content })
  }
  return { removed, drafts, remaining: observations.filter((value) => !targets.has(value)) }
}

/**
 * Plan the additions of one request against the running known-content sets. The
 * official server checks each content against the observations present *before*
 * the request, so duplicate contents in one call are all added; each gets a
 * distinct slot so it stays a distinct element and survives the fold.
 */
function planAdditions(
  entity: Entity,
  input: ObservationInput,
  known: Map<string, Set<string>>,
  slots: Map<string, number>,
  drafts: OperationDraft[],
): AddedObservations {
  let present = known.get(input.entityName)
  if (present === undefined) {
    present = new Set(entity.observations)
    known.set(input.entityName, present)
  }
  const added: string[] = []
  for (const content of input.contents) {
    if (present.has(content)) {
      continue
    }
    const slotKey = observationContentKey(input.entityName, content)
    const slot = slots.get(slotKey) ?? 0
    slots.set(slotKey, slot + 1)
    added.push(content)
    drafts.push({ type: "observation.add", entityName: input.entityName, content, slot })
  }
  for (const content of added) {
    present.add(content)
  }
  return { entityName: input.entityName, addedObservations: added }
}

/**
 * Queue one `observation.add` per occurrence, each at its own slot, so a content
 * repeated in the list stays as many distinct elements as it was written with.
 */
function observationAddDrafts(
  drafts: OperationDraft[],
  entityName: string,
  observations: readonly string[],
): void {
  const slots = new Map<string, number>()
  for (const content of observations) {
    const slot = slots.get(content) ?? 0
    slots.set(content, slot + 1)
    drafts.push({ type: "observation.add", entityName, content, slot })
  }
}

/**
 * The drafts of a rename: tombstone the old entity together with its observations
 * (so a later re-creation of the old name cannot revive them) and repoint every
 * incident relation to the new endpoint. The additive counterpart — the new
 * entity and its observations — is queued by the caller. The repointed relation
 * replaces the old one in `relations`, the working list, so a later entry of the
 * same batch sees the endpoint it just moved.
 */
function renameDrafts(
  drafts: OperationDraft[],
  entity: Entity,
  newName: string,
  relations: Relation[],
): void {
  for (const content of new Set(entity.observations)) {
    drafts.push({ type: "observation.delete", entityName: entity.name, content })
  }
  drafts.push({ type: "entity.delete", name: entity.name })
  for (const [index, relation] of relations.entries()) {
    if (relation.from !== entity.name && relation.to !== entity.name) {
      continue
    }
    drafts.push({ type: "relation.delete", ...relation })
    const repointed = {
      from: relation.from === entity.name ? newName : relation.from,
      to: relation.to === entity.name ? newName : relation.to,
      relationType: relation.relationType,
    }
    relations[index] = repointed
    drafts.push({ type: "relation.add", ...repointed })
  }
}

/**
 * Plan one entity update against the working view: a rename queues the tombstone
 * drafts and the additive ones, a type-only change queues a new `entity.create`
 * (the fold reads an entity's type from the latest create), and both update the
 * working view so a later entry of the batch sees the result.
 */
function planEntityUpdate(
  input: UpdateEntityInput,
  relations: Relation[],
  working: Map<string, Entity>,
  drafts: OperationDraft[],
): UpdatedEntity {
  const entity = working.get(input.name)
  if (entity === undefined) {
    return { name: input.name, updated: false, reason: "entity not found" }
  }
  const newName = input.newName ?? input.name
  const entityType = input.entityType ?? entity.entityType
  const renamed = newName !== input.name
  if (renamed && working.has(newName)) {
    return { name: input.name, updated: false, reason: `entity "${newName}" already exists` }
  }
  if (renamed) {
    renameDrafts(drafts, entity, newName, relations)
  } else if (entityType === entity.entityType) {
    return { name: input.name, entityType, updated: true }
  }
  drafts.push({ type: "entity.create", name: newName, entityType })
  if (renamed) {
    observationAddDrafts(drafts, newName, entity.observations)
  }
  working.delete(input.name)
  working.set(newName, { name: newName, entityType, observations: [...entity.observations] })
  return {
    name: input.name,
    ...(renamed ? { renamedTo: newName } : {}),
    entityType,
    updated: true,
  }
}

/**
 * Plan one relation update: verify the old key is present and the new endpoints
 * exist, then queue the tombstone of the old key and the add of the new one (a
 * no-op change queues nothing), updating the working set.
 */
function planRelationUpdate(
  input: UpdateRelationInput,
  names: ReadonlySet<string>,
  working: Map<string, Relation>,
  drafts: OperationDraft[],
): UpdatedRelation {
  const current = { from: input.from, to: input.to, relationType: input.relationType }
  if (!working.has(relationKey(current))) {
    return { ...current, updated: false, reason: "relation not found" }
  }
  const target = {
    from: input.newFrom ?? input.from,
    to: input.newTo ?? input.to,
    relationType: input.newRelationType ?? input.relationType,
  }
  const missing = [target.from, target.to].find((name) => !names.has(name))
  if (missing !== undefined) {
    return { ...current, updated: false, reason: `entity "${missing}" not found` }
  }
  if (relationKey(target) !== relationKey(current)) {
    working.delete(relationKey(current))
    working.set(relationKey(target), target)
    drafts.push({ type: "relation.delete", ...current })
    drafts.push({ type: "relation.add", ...target })
  }
  return { ...current, updated: true }
}

/**
 * The nine memory operations over an append-only operation log. Every mutation
 * reads the current graph, emits additive or tombstone operations, appends them
 * to the local shard and never touches shared state in place. Mutations are
 * serialized so concurrent tool calls cannot interleave drafts; reads are pure
 * and run outside the queue, and the folded graph is memoized so a read that
 * sees no change costs one backend poll.
 */
export class MemoryGraph {
  private readonly log: OperationLog
  private readonly metrics: Metrics | undefined
  private readonly compactAfter: number
  private readonly collection: (() => Promise<CollectionGuard | undefined>) | undefined
  private uncompacted = 0
  private queue: Promise<unknown> = Promise.resolve()
  private cached: { readonly ops: Operation[]; readonly graph: KnowledgeGraph } | undefined

  constructor(log: OperationLog, metrics?: Metrics, options: MemoryGraphOptions = {}) {
    this.log = log
    this.metrics = metrics
    this.compactAfter = options.compactAfter ?? 0
    this.collection = options.collection
  }

  /**
   * Append the drafts and, once the compact threshold is reached, run the local
   * maintenance online: with a guard, collect the tombstones it clears and keep an
   * element's own operations as the evidence where a peer could still contest it — a
   * suspended guard therefore keeps the whole view; with no guard, prune the shadowed
   * operations only. Runs inside the mutation queue, so it is serialized with every other
   * write and never races one.
   */
  private async commit(drafts: readonly OperationDraft[]): Promise<void> {
    await this.log.append(drafts)
    this.uncompacted += drafts.length
    if (this.compactAfter <= 0 || this.uncompacted < this.compactAfter) {
      return
    }
    this.uncompacted = 0
    try {
      const guard = this.collection === undefined ? undefined : await this.collection()
      if (guard === undefined) {
        await this.log.compact()
      } else {
        await this.log.gc(guard)
      }
    } catch (error) {
      // Maintenance is an optimisation, not part of the mutation: a concurrent
      // writer that keeps winning the compare-and-swap must not fail the write
      // that already succeeded.
      this.metrics?.counter("noonien_mcp_compaction_failed_total", "Failed compactions")
      warn(`compaction failed: ${describe(error)}`)
    }
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /**
   * The folded graph. `ShardLog.read` returns the same array while nothing
   * changed, so folding is skipped entirely on an unchanged read.
   */
  private async currentGraph(): Promise<KnowledgeGraph> {
    const ops = await this.log.read()
    const cached = this.cached
    if (cached !== undefined && cached.ops === ops) {
      return cached.graph
    }
    const start = performance.now()
    const graph = foldOperations(ops)
    this.metrics?.counter("noonien_mcp_folds_total", "Folds performed")
    this.metrics?.gauge(
      "noonien_mcp_fold_seconds",
      "Duration of the last fold",
      (performance.now() - start) / 1000,
    )
    this.cached = { ops, graph }
    return graph
  }

  async createEntities(entities: readonly Entity[]): Promise<Entity[]> {
    return this.run(async () => {
      const graph = await this.currentGraph()
      const present = new Set(graph.entities.map((entity) => entity.name))
      const created: Entity[] = []
      const drafts: OperationDraft[] = []
      for (const entity of entities) {
        if (present.has(entity.name)) {
          continue
        }
        present.add(entity.name)
        // The official server stores the observations exactly as given, so
        // duplicate contents survive; each occurrence becomes its own element.
        created.push({
          name: entity.name,
          entityType: entity.entityType,
          observations: [...entity.observations],
        })
        drafts.push({ type: "entity.create", name: entity.name, entityType: entity.entityType })
        observationAddDrafts(drafts, entity.name, entity.observations)
      }
      await this.commit(drafts)
      return created
    })
  }

  async createRelations(relations: readonly Relation[]): Promise<Relation[]> {
    return this.run(async () => {
      const graph = await this.currentGraph()
      const names = new Set(graph.entities.map((entity) => entity.name))
      for (const relation of relations) {
        if (!names.has(relation.from)) {
          throw new Error(`Entity with name ${relation.from} not found`)
        }
        if (!names.has(relation.to)) {
          throw new Error(`Entity with name ${relation.to} not found`)
        }
      }
      const existing = new Set(graph.relations.map(relationKey))
      const created: Relation[] = []
      const drafts: OperationDraft[] = []
      for (const relation of relations) {
        const key = relationKey(relation)
        if (existing.has(key)) {
          continue
        }
        existing.add(key)
        created.push({ ...relation })
        drafts.push({
          type: "relation.add",
          from: relation.from,
          to: relation.to,
          relationType: relation.relationType,
        })
      }
      await this.commit(drafts)
      return created
    })
  }

  async addObservations(observations: readonly ObservationInput[]): Promise<AddedObservations[]> {
    return this.run(async () => {
      const graph = await this.currentGraph()
      const byName = new Map(graph.entities.map((entity) => [entity.name, entity]))
      const known = new Map<string, Set<string>>()
      const slots = new Map<string, number>()
      const drafts: OperationDraft[] = []
      const results = observations.map((input) => {
        const entity = byName.get(input.entityName)
        if (entity === undefined) {
          throw new Error(`Entity with name ${input.entityName} not found`)
        }
        return planAdditions(entity, input, known, slots, drafts)
      })
      await this.commit(drafts)
      return results
    })
  }

  /**
   * Rename an entity, change its type, or both — as additive and tombstone
   * operations only. A rename tombstones the old name and its observations,
   * creates the new one with the same observations and repoints every incident
   * relation, so the graph is never mutated in place and the rename is one
   * append. A rename onto an existing name is refused instead of silently
   * merging the two entities; an unknown name is reported, not thrown, so a
   * batch keeps its other entries.
   */
  async updateEntities(inputs: readonly UpdateEntityInput[]): Promise<UpdateEntitiesResult> {
    return this.run(async () => {
      const graph = await this.currentGraph()
      // A working view so the entries of one batch see each other's effect and a
      // collision with a name another entry just vacated is still detected.
      const working = new Map(graph.entities.map((entity) => [entity.name, entity]))
      const relations = [...graph.relations]
      const drafts: OperationDraft[] = []
      const results = inputs.map((input) => planEntityUpdate(input, relations, working, drafts))
      await this.commit(drafts)
      return { results }
    })
  }

  /**
   * Change a relation's type or its endpoints. A relation is a set element keyed
   * by `(from, to, relationType)`, so an edit is a tombstone of the old key plus
   * an add of the new one; the endpoints must exist, as they must for a creation.
   * An unknown relation or missing endpoint is reported, not thrown, so a batch
   * keeps its other entries.
   */
  async updateRelations(inputs: readonly UpdateRelationInput[]): Promise<UpdateRelationsResult> {
    return this.run(async () => {
      const graph = await this.currentGraph()
      const names = new Set(graph.entities.map((entity) => entity.name))
      const working = new Map(graph.relations.map((relation) => [relationKey(relation), relation]))
      const drafts: OperationDraft[] = []
      const results = inputs.map((input) => planRelationUpdate(input, names, working, drafts))
      await this.commit(drafts)
      return { results }
    })
  }

  async deleteEntities(entityNames: readonly string[]): Promise<DeleteEntitiesResult> {
    return this.run(async () => {
      const graph = await this.currentGraph()
      const present = new Set(graph.entities.map((entity) => entity.name))
      const deleted = entityNames.filter((name) => present.has(name))
      const notFound = entityNames.filter((name) => !present.has(name))
      const targets = new Set(deleted)
      const drafts: OperationDraft[] = []
      for (const entity of graph.entities) {
        if (!targets.has(entity.name)) {
          continue
        }
        const result = observationDeletes(entity.name, entity.observations, entity.observations)
        for (const draft of result.drafts) {
          drafts.push(draft)
        }
        drafts.push({ type: "entity.delete", name: entity.name })
      }
      for (const relation of graph.relations) {
        if (targets.has(relation.from) || targets.has(relation.to)) {
          drafts.push({
            type: "relation.delete",
            from: relation.from,
            to: relation.to,
            relationType: relation.relationType,
          })
        }
      }
      await this.commit(drafts)
      return { deleted, notFound }
    })
  }

  async deleteObservations(
    deletions: readonly ObservationDeletionInput[],
  ): Promise<DeleteObservationsResult> {
    return this.run(async () => {
      const graph = await this.currentGraph()
      const byName = new Map(graph.entities.map((entity) => [entity.name, entity]))
      // Work on copies so the memoized graph is never mutated; a second request
      // for the same entity must see the removals the first one already queued.
      const working = new Map<string, string[]>()
      const missingEntities: string[] = []
      const drafts: OperationDraft[] = []
      let deletedCount = 0
      for (const deletion of deletions) {
        const entity = byName.get(deletion.entityName)
        if (entity === undefined) {
          missingEntities.push(deletion.entityName)
          continue
        }
        const observations = working.get(entity.name) ?? [...entity.observations]
        const result = observationDeletes(entity.name, observations, deletion.observations)
        deletedCount += result.removed
        for (const draft of result.drafts) {
          drafts.push(draft)
        }
        working.set(entity.name, result.remaining)
      }
      await this.commit(drafts)
      return { deletedCount, missingEntities }
    })
  }

  async deleteRelations(relations: readonly Relation[]): Promise<DeleteRelationsResult> {
    return this.run(async () => {
      const graph = await this.currentGraph()
      const present = new Set(graph.relations.map(relationKey))
      const drafts: OperationDraft[] = []
      let deletedCount = 0
      for (const relation of relations) {
        const key = relationKey(relation)
        if (!present.has(key)) {
          continue
        }
        present.delete(key)
        deletedCount += 1
        drafts.push({
          type: "relation.delete",
          from: relation.from,
          to: relation.to,
          relationType: relation.relationType,
        })
      }
      await this.commit(drafts)
      return { deletedCount }
    })
  }

  async readGraph(): Promise<KnowledgeGraph> {
    return this.currentGraph()
  }

  /**
   * Prune the local shard without collecting: the operations a later one shadows go, the
   * surviving tombstones stay. The maintenance for a shard that only ever adds — the
   * `<node>-import` shard — where nothing can be lost and no peer knowledge is needed.
   */
  async prune(): Promise<PruneResult> {
    return this.run(() => this.log.prune())
  }

  async searchNodes(query: string): Promise<KnowledgeGraph> {
    const graph = await this.currentGraph()
    const needle = query.toLowerCase()
    const entities = graph.entities.filter(
      (entity) =>
        entity.name.toLowerCase().includes(needle) ||
        entity.entityType.toLowerCase().includes(needle) ||
        entity.observations.some((content) => content.toLowerCase().includes(needle)),
    )
    return { entities, relations: incidentRelations(graph, entities) }
  }

  async openNodes(names: readonly string[]): Promise<KnowledgeGraph> {
    const graph = await this.currentGraph()
    const wanted = new Set(names)
    const entities = graph.entities.filter((entity) => wanted.has(entity.name))
    return { entities, relations: incidentRelations(graph, entities) }
  }
}

function incidentRelations(graph: KnowledgeGraph, entities: readonly Entity[]): Relation[] {
  const names = new Set(entities.map((entity) => entity.name))
  return graph.relations.filter((relation) => names.has(relation.from) || names.has(relation.to))
}
