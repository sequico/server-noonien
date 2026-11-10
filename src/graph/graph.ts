// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, warn } from "../diagnostics.js"
import type { Metrics } from "../metrics.js"
import type { CollectionGuard, OperationLog, PruneResult } from "../store/log.js"
import { normaliseName, scorePair, tokenSet } from "./duplicates.js"
import { foldOperations } from "./fold.js"
import type { Operation, OperationDraft } from "./operations.js"
import { describeElement, elementGroup, observationContentKey, relationKey } from "./operations.js"
import { scoreEntity, terms } from "./search.js"
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

export interface MergeEntitiesInput {
  readonly from: string
  readonly into: string
}

export interface MergedEntity {
  readonly from: string
  readonly into: string
  readonly merged: boolean
  readonly reason?: string
  /** Observations the target gains; present on a merge, dry run included. */
  readonly observationsJoined?: number
  /** Relations repointed to the target; present on a merge, dry run included. */
  readonly relationsRepointed?: number
  /** The name that disappears; present on a merge, dry run included. */
  readonly removedName?: string
  /** False for a dry run: the counts are what the real call would do. */
  readonly applied?: boolean
}

export interface MergeEntitiesResult {
  readonly results: readonly MergedEntity[]
}

export interface ObservationUpdateInput {
  readonly entityName: string
  readonly oldContent: string
  readonly newContent: string
}

export interface UpdatedObservation {
  readonly entityName: string
  readonly oldContent: string
  readonly newContent: string
  readonly updated: boolean
  readonly reason?: string
}

export interface UpdateObservationsResult {
  readonly results: readonly UpdatedObservation[]
}

/** How much of a read to take back. Both fields are optional: absent means everything. */
export interface PageOptions {
  readonly limit?: number | undefined
  readonly offset?: number | undefined
}

export interface SearchOptions extends PageOptions {
  /** Only entities of this exact type; absent means any type. */
  readonly entityType?: string | undefined
}

/** One node that wrote a contested element: what it wrote, and when it last did. */
export interface ConflictAuthor {
  readonly node: string
  readonly ts: string
  readonly value: string
}

/** An element more than one node has written, and who wrote it with what. */
export interface ConflictEntry {
  readonly element: string
  readonly authors: readonly ConflictAuthor[]
  readonly operations: number
}

export interface ConflictReport {
  readonly conflicts: readonly ConflictEntry[]
}

/** What a window of changes answers: the window used, the graph, and what went. */
export interface ChangesResult extends KnowledgeGraph {
  readonly since: string
  readonly until: string
  readonly deleted: readonly string[]
}

/** How far out to walk, and how much of the result to keep. */
export interface ExpandOptions {
  readonly depth?: number | undefined
  readonly limit?: number | undefined
}

export interface ExpandResult extends KnowledgeGraph {
  readonly truncated: boolean
}

/** One element an agent settles: an observation or a relation, and whether it stands. */
export interface ResolveInput {
  readonly entityName?: string | undefined
  readonly content?: string | undefined
  readonly from?: string | undefined
  readonly to?: string | undefined
  readonly relationType?: string | undefined
  readonly keep: boolean
}

export interface ResolvedElement {
  readonly element: string
  readonly keep: boolean
  readonly changed: boolean
}

export interface ResolveResult {
  readonly results: readonly ResolvedElement[]
}

/** One operation that touched an entity, as the history read reports it. */
export interface HistoryEntry {
  readonly entityName: string
  readonly ts: string
  readonly node: string
  readonly kind: string
  readonly detail: string
}

export interface HistoryOptions extends PageOptions {
  readonly entityNames: readonly string[]
}

/** Two entities that may be the same thing. */
export interface DuplicatePair {
  readonly a: string
  readonly b: string
  readonly score: number
  readonly reasons: readonly string[]
}

export interface DuplicateOptions {
  readonly by?: "name" | "content" | undefined
  readonly threshold?: number | undefined
  readonly limit?: number | undefined
}

/** The numbers an operator acts on. */
export interface GraphStats {
  readonly entities: number
  readonly relations: number
  readonly observations: number
  readonly operations: number
  readonly deletions: number
  readonly lastMutation: string | undefined
  readonly byType: readonly { readonly entityType: string; readonly entities: number }[]
  readonly largest: readonly { readonly name: string; readonly observations: number }[]
  readonly stale: readonly string[]
}

/** One fact kept current: the key owns the content `key: value`. */
export interface ObservationSetInput {
  readonly entityName: string
  readonly key: string
  readonly value: string
}

export interface SetObservationResult {
  readonly entityName: string
  readonly key: string
  readonly content: string
  readonly action: "added" | "replaced"
}

export interface MemoryGraphOptions {
  /** Compact the local shard after this many appended operations (0 disables the count). */
  readonly compactAfter?: number
  /** Compact once the own shard has grown by this many bytes since the last pass (0 disables). */
  readonly compactBytes?: number
  /**
   * Resolve the collection guard when a pass is due. A guard collects the
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

/** The slice a read asked for; an absent limit means everything from the offset. */
function page(entities: readonly Entity[], options: PageOptions): Entity[] {
  const offset = options.offset ?? 0
  return options.limit === undefined
    ? entities.slice(offset)
    : entities.slice(offset, offset + options.limit)
}

/** Plan one observation replacement: tombstone the old content, add the new one once. */
function planObservationUpdate(
  input: ObservationUpdateInput,
  working: Map<string, Set<string>>,
  drafts: OperationDraft[],
): UpdatedObservation {
  const present = working.get(input.entityName)
  if (present === undefined) {
    return { ...input, updated: false, reason: "entity not found" }
  }
  if (input.oldContent === input.newContent) {
    return present.has(input.oldContent)
      ? { ...input, updated: true }
      : { ...input, updated: false, reason: "observation not found" }
  }
  if (!present.has(input.oldContent)) {
    return { ...input, updated: false, reason: "observation not found" }
  }
  present.delete(input.oldContent)
  drafts.push({
    type: "observation.delete",
    entityName: input.entityName,
    content: input.oldContent,
  })
  if (!present.has(input.newContent)) {
    present.add(input.newContent)
    drafts.push({
      type: "observation.add",
      entityName: input.entityName,
      content: input.newContent,
      slot: 0,
    })
  }
  return { ...input, updated: true }
}

/** Plan one merge: union the observations, repoint the relations, tombstone the source. */
function planMerge(
  input: MergeEntitiesInput,
  relations: Relation[],
  working: Map<string, Entity>,
  drafts: OperationDraft[],
): MergedEntity {
  if (input.from === input.into) {
    return { ...input, merged: false, reason: "an entity cannot be merged into itself" }
  }
  const from = working.get(input.from)
  if (from === undefined) {
    return { ...input, merged: false, reason: "entity not found" }
  }
  const into = working.get(input.into)
  if (into === undefined) {
    return { ...input, merged: false, reason: `entity "${input.into}" not found` }
  }
  const present = new Set(into.observations)
  const added: string[] = []
  for (const content of from.observations) {
    if (present.has(content)) {
      continue
    }
    present.add(content)
    added.push(content)
  }
  for (const [index, relation] of relations.entries()) {
    if (relation.from !== input.from && relation.to !== input.from) {
      continue
    }
    drafts.push({ type: "relation.delete", ...relation })
    const repointed = {
      from: relation.from === input.from ? input.into : relation.from,
      to: relation.to === input.from ? input.into : relation.to,
      relationType: relation.relationType,
    }
    relations[index] = repointed
    drafts.push({ type: "relation.add", ...repointed })
  }
  for (const content of new Set(from.observations)) {
    drafts.push({ type: "observation.delete", entityName: input.from, content })
  }
  drafts.push({ type: "entity.delete", name: input.from })
  observationAddDrafts(drafts, input.into, added)
  working.delete(input.from)
  working.set(input.into, {
    name: input.into,
    entityType: into.entityType,
    observations: [...into.observations, ...added],
  })
  return { ...input, merged: true }
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
  private readonly compactBytes: number
  private readonly collection: (() => Promise<CollectionGuard | undefined>) | undefined
  private uncompacted = 0
  private baselineBytes: number | undefined
  private nextAttemptAt = 0
  private backoffMs = 0
  private queue: Promise<unknown> = Promise.resolve()
  private cached: { readonly ops: Operation[]; readonly graph: KnowledgeGraph } | undefined

  constructor(log: OperationLog, metrics?: Metrics, options: MemoryGraphOptions = {}) {
    this.log = log
    this.metrics = metrics
    this.compactAfter = options.compactAfter ?? 0
    this.compactBytes = options.compactBytes ?? 0
    this.collection = options.collection
  }

  /**
   * Append the drafts. Maintenance is **not** part of the write: a pass waits for the
   * timer (or the startup attempt) and never sits in front of the next mutation.
   */
  private async commit(drafts: readonly OperationDraft[]): Promise<void> {
    await this.log.append(drafts)
    this.uncompacted += drafts.length
    this.metrics?.counter("noonien_mcp_ops_appended_total", "Operations appended", drafts.length)
  }

  /**
   * Run a maintenance pass when one is due — by appended operations or by shard growth —
   * and not earlier than the backoff allows. A failure (a peer winning the compare-and-
   * swap) doubles the wait instead of retrying on every write; a success resets it.
   */
  async maintain(): Promise<void> {
    return this.run(async () => {
      const now = Date.now()
      if (now < this.nextAttemptAt) {
        this.metrics?.counter("noonien_mcp_compaction_skipped_total", "Compaction passes skipped")
        return
      }
      const size = await this.log.ownShardSize()
      if (this.baselineBytes === undefined) {
        this.baselineBytes = size
      }
      const byCount = this.compactAfter > 0 && this.uncompacted >= this.compactAfter
      const byBytes = this.compactBytes > 0 && size - this.baselineBytes >= this.compactBytes
      if (!byCount && !byBytes) {
        return
      }
      try {
        const guard = this.collection === undefined ? undefined : await this.collection()
        if (guard === undefined) {
          await this.log.compact()
        } else {
          await this.log.gc(guard)
        }
        this.uncompacted = 0
        this.baselineBytes = await this.log.ownShardSize()
        this.backoffMs = 0
        this.nextAttemptAt = 0
      } catch (error) {
        // Maintenance is an optimisation, not part of a mutation: a concurrent
        // writer that keeps winning the compare-and-swap must not fail a write
        // that already succeeded, and the next attempt waits longer.
        this.backoffMs = Math.min(
          Math.max(this.backoffMs * 2, COMPACTION_BACKOFF_MS),
          COMPACTION_MAX_BACKOFF_MS,
        )
        this.nextAttemptAt = Date.now() + this.backoffMs
        this.metrics?.counter("noonien_mcp_compaction_failed_total", "Failed compactions")
        warn(`compaction failed: ${describe(error)}; next attempt in ${this.backoffMs} ms`)
      }
    })
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

  /**
   * Replace one observation content with another on an entity — the edit an add and a
   * delete would need two calls for. It is content-level, like the delete it is built
   * on: every occurrence of the old content goes and the new one is added once, so
   * replacing a content with one the entity already holds only removes the old.
   */
  async updateObservations(
    inputs: readonly ObservationUpdateInput[],
  ): Promise<UpdateObservationsResult> {
    return this.run(async () => {
      const graph = await this.currentGraph()
      const working = new Map(
        graph.entities.map((entity) => [entity.name, new Set(entity.observations)]),
      )
      const drafts: OperationDraft[] = []
      const results = inputs.map((input) => planObservationUpdate(input, working, drafts))
      await this.commit(drafts)
      return { results }
    })
  }

  /**
   * Merge one entity into another: the union of their observations (a content the
   * target already holds is not duplicated), every incident relation of the merged
   * entity repointed to the target, and the merged entity tombstoned with its
   * observations. This is the way to combine two entities, which a rename onto an
   * existing name refuses to guess at.
   */
  async mergeEntities(
    inputs: readonly MergeEntitiesInput[],
    options: { readonly dryRun?: boolean | undefined } = {},
  ): Promise<MergeEntitiesResult> {
    return this.run(async () => {
      const graph = await this.currentGraph()
      const working = new Map(graph.entities.map((entity) => [entity.name, entity]))
      const relations = [...graph.relations]
      const drafts: OperationDraft[] = []
      const results = inputs.map((input): MergedEntity => {
        const start = drafts.length
        const merged = planMerge(input, relations, working, drafts)
        if (!merged.merged) {
          return { ...merged, applied: false }
        }
        const produced = drafts.slice(start)
        return {
          ...merged,
          observationsJoined: produced.filter((draft) => draft.type === "observation.add").length,
          relationsRepointed: produced.filter((draft) => draft.type === "relation.add").length,
          removedName: input.from,
          applied: options.dryRun !== true,
        }
      })
      if (options.dryRun !== true) {
        await this.commit(drafts)
      }
      return { results }
    })
  }

  /**
   * Every element more than one node has written, with what each node left and when it
   * last touched it. The fold is last-writer-wins and resolves a concurrent write in
   * silence; this reads the operation log instead, so an agent can see the two versions
   * and settle them with `resolve_conflict`.
   */
  async conflicts(): Promise<ConflictReport> {
    const ops = await this.log.read()
    const byKey = new Map<
      string,
      { element: string; latest: Map<string, Operation>; operations: number }
    >()
    for (const op of ops) {
      // The same group the fold and the collection reason about, so an add and a
      // content-level delete from two nodes count as one contested element.
      const key = elementGroup(op)
      const entry = byKey.get(key) ?? {
        element: describeElement(op),
        latest: new Map<string, Operation>(),
        operations: 0,
      }
      const known = entry.latest.get(op.node)
      if (known === undefined || compareNewest(op, known) < 0) {
        entry.latest.set(op.node, op)
      }
      entry.operations += 1
      byKey.set(key, entry)
    }
    const conflicts = [...byKey.values()]
      .filter((entry) => entry.latest.size > 1)
      .map((entry) => ({
        element: entry.element,
        authors: [...entry.latest.values()]
          .map((op) => ({ node: op.node, ts: op.ts, value: opValue(op) }))
          .sort((left, right) => compareNames(left.node, right.node)),
        operations: entry.operations,
      }))
    return { conflicts }
  }

  async readGraph(options: PageOptions = {}): Promise<KnowledgeGraph> {
    const graph = await this.currentGraph()
    const entities = page(graph.entities, options)
    return { entities, relations: incidentRelations(graph, entities) }
  }

  /**
   * Prune the local shard without collecting: the operations a later one shadows go, the
   * surviving tombstones stay. The maintenance for a shard that only ever adds — the
   * `<node>-import` shard — where nothing can be lost and no peer knowledge is needed.
   */
  async prune(): Promise<PruneResult> {
    return this.run(() => this.log.prune())
  }

  async searchNodes(query: string, options: SearchOptions = {}): Promise<KnowledgeGraph> {
    const graph = await this.currentGraph()
    const needle = query.toLowerCase()
    const matched = graph.entities.filter(
      (entity) =>
        (options.entityType === undefined || entity.entityType === options.entityType) &&
        (entity.name.toLowerCase().includes(needle) ||
          entity.entityType.toLowerCase().includes(needle) ||
          entity.observations.some((content) => content.toLowerCase().includes(needle))),
    )
    const entities = page(matched, options)
    return { entities, relations: incidentRelations(graph, entities) }
  }

  async openNodes(names: readonly string[]): Promise<KnowledgeGraph> {
    const graph = await this.currentGraph()
    const wanted = new Set(names)
    const entities = graph.entities.filter((entity) => wanted.has(entity.name))
    return { entities, relations: incidentRelations(graph, entities) }
  }

  /**
   * What moved in a window: every entity an operation touched, as it is now, and the
   * names deleted in the window that the fold no longer holds. The window reaches a
   * constant five minutes further back than asked, so a peer whose clock lags does not
   * lose a change; `until` is this node's clock, never the newest operation's stamp,
   * because a peer hours ahead would otherwise push the next window into the future.
   */
  async changes(since: Date | undefined, options: PageOptions = {}): Promise<ChangesResult> {
    const now = new Date()
    const until = now.toISOString()
    const asked = since === undefined || Number.isNaN(since.getTime()) ? now : since
    const from = new Date(Math.min(asked.getTime(), now.getTime()) - SINCE_OVERLAP_MS)
    const sinceText = from.toISOString()
    const ops = await this.log.read()
    const graph = await this.currentGraph()
    const present = new Set(graph.entities.map((entity) => entity.name))
    const { touched, removed } = windowOf(ops, sinceText)
    const entities = page(
      graph.entities.filter((entity) => touched.has(entity.name)),
      options,
    )
    const deleted = [...removed].filter((name) => !present.has(name)).sort(compareNames)
    return {
      since: sinceText,
      until,
      entities,
      relations: incidentRelations(graph, entities),
      deleted,
    }
  }

  /**
   * How well each entity answers a query written the way a person types it: every word
   * must match, a word matches the start of a longer one, and the best matches come
   * first. The result set is not the substring search's: `port` finds `ports` and not
   * `support`, which is why `search_nodes` stays beside this.
   */
  async findNodes(query: string, options: SearchOptions = {}): Promise<KnowledgeGraph> {
    const graph = await this.currentGraph()
    const wanted = terms(query)
    const scored: { entity: Entity; score: number }[] = []
    for (const entity of graph.entities) {
      if (options.entityType !== undefined && entity.entityType !== options.entityType) {
        continue
      }
      const score = scoreEntity(entity, wanted)
      if (score !== undefined) {
        scored.push({ entity, score })
      }
    }
    scored.sort(
      (left, right) => right.score - left.score || compareNames(left.entity, right.entity),
    )
    const entities = page(
      scored.map((entry) => entry.entity),
      options,
    )
    return { entities, relations: incidentRelations(graph, entities) }
  }

  /**
   * The neighbourhood of the named entities, `depth` hops out and undirected. The walk
   * visits neighbours in name order, so the cap drops the far frontier rather than a
   * close one, and `truncated` says it did.
   */
  async expandNodes(names: readonly string[], options: ExpandOptions = {}): Promise<ExpandResult> {
    const graph = await this.currentGraph()
    const depth = Math.min(Math.max(options.depth ?? 1, 1), 5)
    const limit = Math.max(options.limit ?? 200, 1)
    const known = new Set(graph.entities.map((entity) => entity.name))
    const adjacency = new Map<string, string[]>()
    for (const relation of graph.relations) {
      addNeighbour(adjacency, relation.from, relation.to)
      addNeighbour(adjacency, relation.to, relation.from)
    }
    const start = [...new Set(names)].filter((name) => known.has(name)).sort(compareNames)
    const { seen, truncated } = walkNeighbours(start, adjacency, depth, limit)
    const entities = graph.entities.filter((entity) => seen.has(entity.name))
    return { entities, relations: incidentRelations(graph, entities), truncated }
  }

  /**
   * Settle an element two machines wrote: keep it or drop it, with a stamp newer than
   * anything in the log. Re-creating is not enough — a write that already exists is
   * skipped and a tombstone already in the log changes nothing — so the drafts are
   * committed directly. An element that already stands as asked writes nothing.
   */
  async resolveConflicts(inputs: readonly ResolveInput[]): Promise<ResolveResult> {
    return this.run(async () => {
      const graph = await this.currentGraph()
      const entities = new Map(graph.entities.map((entity) => [entity.name, entity]))
      const relations = new Set(graph.relations.map(relationKey))
      const drafts: OperationDraft[] = []
      const results = inputs.map((input) => planResolve(input, entities, relations, drafts))
      await this.commit(drafts)
      return { results }
    })
  }

  /**
   * Every operation that touched the named entities, newest first. The fold carries no
   * dates, so this reads the log: it is how an agent tells a fact confirmed yesterday
   * from one nobody has confirmed in months.
   */
  async history(options: HistoryOptions): Promise<{ entries: HistoryEntry[] }> {
    const ops = await this.log.read()
    const wanted = new Set(options.entityNames)
    const matching: { op: Operation; entityName: string }[] = []
    for (const op of ops) {
      if (op.type === "shard.compact") {
        continue
      }
      const name = namesIn(op).find((candidate) => wanted.has(candidate))
      if (name !== undefined) {
        matching.push({ op, entityName: name })
      }
    }
    matching.sort((left, right) => compareNewest(left.op, right.op))
    const limit = Math.min(Math.max(options.limit ?? HISTORY_DEFAULT_LIMIT, 1), HISTORY_MAX_LIMIT)
    const offset = options.offset ?? 0
    const entries = matching.slice(offset, offset + limit).map(({ op, entityName }) => ({
      entityName,
      ts: op.ts,
      node: op.node,
      kind: op.type,
      detail: opDetail(op),
    }))
    return { entries }
  }

  /** Counts, the type spread, the biggest entities, and what nobody has confirmed lately. */
  async stats(): Promise<GraphStats> {
    const graph = await this.currentGraph()
    const { operations, deletions, lastMutation, newest } = opCounts(await this.log.read())
    const byType = new Map<string, number>()
    for (const entity of graph.entities) {
      byType.set(entity.entityType, (byType.get(entity.entityType) ?? 0) + 1)
    }
    const cutoff = new Date(Date.now() - STALE_AFTER_MS).toISOString()
    const stale = graph.entities
      .filter((entity) => (newest.get(entity.name) ?? "") < cutoff)
      .sort(
        (left, right) =>
          (newest.get(left.name) ?? "").localeCompare(newest.get(right.name) ?? "") ||
          compareNames(left, right),
      )
      .map((entity) => entity.name)
    return {
      entities: graph.entities.length,
      relations: graph.relations.length,
      observations: graph.entities.reduce((total, entity) => total + entity.observations.length, 0),
      operations,
      deletions,
      lastMutation,
      byType: [...byType.entries()]
        .map(([entityType, entities]) => ({ entityType, entities }))
        .sort(
          (left, right) =>
            right.entities - left.entities || left.entityType.localeCompare(right.entityType),
        ),
      largest: [...graph.entities]
        .sort(
          (left, right) =>
            right.observations.length - left.observations.length || compareNames(left, right),
        )
        .slice(0, LARGEST_LIMIT)
        .map((entity) => ({ name: entity.name, observations: entity.observations.length })),
      stale,
    }
  }

  /**
   * Pairs of entities that may be the same thing, in name mode (case, spacing,
   * punctuation and a known suffix normalised, observations raising the score) or
   * content mode (what the two know). Read-only: merging stays a decision, which is why
   * `merge_entities` has a dry run. Blocking bounds the work.
   */
  async findDuplicates(options: DuplicateOptions = {}): Promise<{ pairs: DuplicatePair[] }> {
    const graph = await this.currentGraph()
    const by = options.by ?? "name"
    const threshold = options.threshold ?? 0.75
    const limit = Math.max(options.limit ?? 20, 1)
    const pairs = duplicatePairs(graph.entities, by, threshold)
    pairs.sort(
      (left, right) =>
        right.score - left.score || left.a.localeCompare(right.a) || left.b.localeCompare(right.b),
    )
    return { pairs: pairs.slice(0, limit) }
  }

  /**
   * Keep one fact current: the content `key: value` replaces every observation the key
   * already owns, so a drifted twin cannot survive. Entries apply in order, so a second
   * entry for the same key sees what the first wrote.
   */
  async setObservations(
    entries: readonly ObservationSetInput[],
  ): Promise<{ results: SetObservationResult[] }> {
    return this.run(async () => {
      const graph = await this.currentGraph()
      const working = new Map(
        graph.entities.map((entity) => [entity.name, [...entity.observations]]),
      )
      const drafts: OperationDraft[] = []
      const results = entries.map((entry) => planObservationSet(entry, working, drafts))
      await this.commit(drafts)
      return { results }
    })
  }
}

function incidentRelations(graph: KnowledgeGraph, entities: readonly Entity[]): Relation[] {
  const names = new Set(entities.map((entity) => entity.name))
  return graph.relations.filter((relation) => names.has(relation.from) || names.has(relation.to))
}

/** The overlap a changes window reaches back, so a lagging peer clock loses nothing. */
const SINCE_OVERLAP_MS = 5 * 60_000

/** How long an entity may go unconfirmed before `stats` calls it stale. */
const STALE_AFTER_MS = 90 * 24 * 60 * 60_000

/** The first wait after a failed compaction pass, and the longest it may grow to. */
const COMPACTION_BACKOFF_MS = 30_000
const COMPACTION_MAX_BACKOFF_MS = 15 * 60_000

/** The page a history read returns when none is asked for, and the most it will take. */
const HISTORY_DEFAULT_LIMIT = 50
const HISTORY_MAX_LIMIT = 500

/** How many entities one duplicate bucket compares, so the pass stays bounded. */
const BUCKET_LIMIT = 200

/** How many entries the largest list reports. */
const LARGEST_LIMIT = 10

/** A name order that does not depend on the locale of the machine. */
function compareNames(
  left: string | { readonly name: string },
  right: string | { readonly name: string },
): number {
  const a = typeof left === "string" ? left : left.name
  const b = typeof right === "string" ? right : right.name
  return a < b ? -1 : a > b ? 1 : 0
}

/** Every entity name an operation names: an entity, a content's owner, or both endpoints. */
function namesIn(op: Operation): string[] {
  switch (op.type) {
    case "entity.create":
    case "entity.delete":
      return [op.name]
    case "observation.add":
    case "observation.delete":
      return [op.entityName]
    case "relation.add":
    case "relation.delete":
      return [op.from, op.to]
    case "shard.compact":
      return []
  }
}

/** What the operation wrote, as a value an agent can read beside its node and stamp. */
function opValue(op: Operation): string {
  switch (op.type) {
    case "entity.create":
      return op.entityType
    case "entity.delete":
    case "observation.delete":
    case "relation.delete":
      return "(deleted)"
    case "observation.add":
      return op.content
    case "relation.add":
      return "(present)"
    case "shard.compact":
      return "(compaction)"
  }
}

/** The payload of an operation as one line, for a history entry. */
function opDetail(op: Operation): string {
  switch (op.type) {
    case "entity.create":
      return op.entityType
    case "entity.delete":
      return "(deleted)"
    case "observation.add":
    case "observation.delete":
      return op.content
    case "relation.add":
    case "relation.delete":
      return `${op.from} -> ${op.to} : ${op.relationType}`
    case "shard.compact":
      return `generation ${op.generation}`
  }
}

/** Newest first, with the sequence breaking a tie inside one millisecond. */
function compareNewest(left: Operation, right: Operation): number {
  if (left.ts !== right.ts) {
    return left.ts < right.ts ? 1 : -1
  }
  return right.seq - left.seq
}

/** Add one neighbour to an undirected adjacency map. */
function addNeighbour(adjacency: Map<string, string[]>, from: string, to: string): void {
  const list = adjacency.get(from)
  if (list === undefined) {
    adjacency.set(from, [to])
  } else {
    list.push(to)
  }
}

/** One element to settle: either an observation or a relation, with its label. */
interface ElementSpec {
  readonly element: string
  readonly observation?: { readonly entityName: string; readonly content: string }
  readonly relation?: { readonly from: string; readonly to: string; readonly relationType: string }
}

/** Read one settle request, refusing an entry that names nothing or both shapes. */
function elementSpec(input: ResolveInput): ElementSpec {
  const hasObservation = input.entityName !== undefined && input.content !== undefined
  const hasRelation =
    input.from !== undefined && input.to !== undefined && input.relationType !== undefined
  if (hasObservation === hasRelation) {
    throw new Error(
      "each element names either an observation (entityName and content) or a relation " +
        "(from, to and relationType), never both and never neither",
    )
  }
  if (hasObservation) {
    return {
      element: `observation "${input.entityName}" "${input.content}"`,
      observation: { entityName: input.entityName ?? "", content: input.content ?? "" },
    }
  }
  return {
    element: `relation "${input.from}" -> "${input.to}" : ${input.relationType}`,
    relation: {
      from: input.from ?? "",
      to: input.to ?? "",
      relationType: input.relationType ?? "",
    },
  }
}

/** One level of the walk: add what fits, and report the next frontier. */
function visitLevel(
  frontier: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
  seen: Set<string>,
  limit: number,
): { next: Set<string>; truncated: boolean } {
  const next = new Set<string>()
  let truncated = false
  for (const name of frontier) {
    if (seen.has(name)) {
      continue
    }
    if (seen.size >= limit) {
      truncated = true
      continue
    }
    seen.add(name)
    for (const neighbour of adjacency.get(name) ?? []) {
      if (!seen.has(neighbour)) {
        next.add(neighbour)
      }
    }
  }
  return { next, truncated }
}

/** Breadth-first walk over an undirected adjacency map, capped in name order. */
function walkNeighbours(
  start: readonly string[],
  adjacency: ReadonlyMap<string, readonly string[]>,
  depth: number,
  limit: number,
): { seen: Set<string>; truncated: boolean } {
  const seen = new Set<string>()
  let frontier = [...start]
  let truncated = false
  for (let hop = 0; hop <= depth && frontier.length > 0; hop += 1) {
    const level = visitLevel(frontier, adjacency, seen, limit)
    truncated = truncated || level.truncated
    frontier = [...level.next].sort(compareNames)
  }
  return { seen, truncated }
}

/** Whether the fold currently holds the element a settle request names. */
function isPresent(
  spec: ElementSpec,
  entities: ReadonlyMap<string, Entity>,
  relations: ReadonlySet<string>,
): boolean {
  const { observation, relation } = spec
  if (observation !== undefined) {
    return entities.get(observation.entityName)?.observations.includes(observation.content) ?? false
  }
  return relations.has(relationKey(relation ?? { from: "", to: "", relationType: "" }))
}

/** The one operation a settle writes, for the outcome it asks for. */
function settleDraft(input: ResolveInput, spec: ElementSpec): OperationDraft | undefined {
  const { observation, relation } = spec
  if (observation !== undefined) {
    return input.keep
      ? { type: "observation.add", ...observation, slot: 0 }
      : { type: "observation.delete", ...observation }
  }
  if (relation !== undefined) {
    return input.keep
      ? { type: "relation.add", ...relation }
      : { type: "relation.delete", ...relation }
  }
  return undefined
}

/** Plan one settle: no draft when the fold already agrees, one draft otherwise. */
function planResolve(
  input: ResolveInput,
  entities: ReadonlyMap<string, Entity>,
  relations: ReadonlySet<string>,
  drafts: OperationDraft[],
): ResolvedElement {
  const spec = elementSpec(input)
  const { observation, relation } = spec
  if (observation !== undefined && !entities.has(observation.entityName)) {
    throw new Error(`Entity with name ${observation.entityName} not found`)
  }
  if (relation !== undefined && input.keep) {
    for (const name of [relation.from, relation.to]) {
      if (!entities.has(name)) {
        throw new Error(`Entity with name ${name} not found`)
      }
    }
  }
  if (isPresent(spec, entities, relations) === input.keep) {
    return { element: spec.element, keep: input.keep, changed: false }
  }
  const draft = settleDraft(input, spec)
  if (draft !== undefined) {
    drafts.push(draft)
  }
  return { element: spec.element, keep: input.keep, changed: true }
}

/** The entities an operation in the window touched, and the names it deleted. */
function windowOf(
  ops: readonly Operation[],
  sinceText: string,
): { touched: Set<string>; removed: Set<string> } {
  const touched = new Set<string>()
  const removed = new Set<string>()
  for (const op of ops) {
    if (op.type === "shard.compact" || op.ts < sinceText) {
      continue
    }
    for (const name of namesIn(op)) {
      touched.add(name)
    }
    if (op.type === "entity.delete") {
      removed.add(op.name)
    }
  }
  return { touched, removed }
}

/** Add one entity to the bucket of a token. */
function addEntity(buckets: Map<string, Entity[]>, token: string, entity: Entity): void {
  const bucket = buckets.get(token)
  if (bucket === undefined) {
    buckets.set(token, [entity])
  } else {
    bucket.push(entity)
  }
}

/** Every pair inside one bucket that reaches the threshold, each pair once. */
function collectPairs(
  members: readonly Entity[],
  by: "name" | "content",
  threshold: number,
  seen: Set<string>,
  pairs: DuplicatePair[],
): void {
  for (let i = 0; i < members.length; i += 1) {
    for (let j = i + 1; j < members.length; j += 1) {
      const a = members[i] as Entity
      const b = members[j] as Entity
      const key = a.name < b.name ? `${a.name}\u0000${b.name}` : `${b.name}\u0000${a.name}`
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      const scored = scorePair(by, a, b)
      if (scored === undefined || scored.score < threshold) {
        continue
      }
      pairs.push({
        a: a.name,
        b: b.name,
        score: Math.round(scored.score * 1000) / 1000,
        reasons: scored.reasons,
      })
    }
  }
}

/** Block, compare, and keep every pair above the threshold. */
function duplicatePairs(
  entities: readonly Entity[],
  by: "name" | "content",
  threshold: number,
): DuplicatePair[] {
  const buckets = new Map<string, Entity[]>()
  for (const entity of entities) {
    const normalised = normaliseName(entity.name)
    const tokens = by === "name" ? tokenSet(normalised) : tokenSet(entity.observations.join(" "))
    for (const token of tokens) {
      addEntity(buckets, token, entity)
    }
    if (by === "name") {
      // Two names that differ only by an edit or a suffix share no word, which is exactly
      // the pair this mode exists to find: block them by their first characters as well.
      addEntity(buckets, `prefix:${normalised.slice(0, 3)}`, entity)
    }
  }
  const seen = new Set<string>()
  const pairs: DuplicatePair[] = []
  for (const members of buckets.values()) {
    collectPairs(members.slice(0, BUCKET_LIMIT), by, threshold, seen, pairs)
  }
  return pairs
}

/** Plan one `key: value` write against the working view, and report what it did. */
function planObservationSet(
  entry: ObservationSetInput,
  working: Map<string, string[]>,
  drafts: OperationDraft[],
): SetObservationResult {
  if (entry.key.includes(": ")) {
    throw new Error(
      `a key must not contain a colon followed by a space (got ${JSON.stringify(entry.key)})`,
    )
  }
  const observations = working.get(entry.entityName)
  if (observations === undefined) {
    throw new Error(`Entity with name ${entry.entityName} not found`)
  }
  const prefix = `${entry.key}: `
  const owned = observations.filter(
    (content) => content === entry.key || content.startsWith(prefix),
  )
  const content = `${prefix}${entry.value}`
  // Writing the value the key already holds must not delete it: only the contents that
  // differ from the chosen one are tombstoned, and the chosen one is added only when absent.
  const stale = owned.filter((previous) => previous !== content)
  for (const previous of new Set(stale)) {
    drafts.push({ type: "observation.delete", entityName: entry.entityName, content: previous })
  }
  const present = owned.includes(content)
  if (!present) {
    drafts.push({ type: "observation.add", entityName: entry.entityName, content, slot: 0 })
  }
  working.set(entry.entityName, [
    ...observations.filter((value) => value === content || !stale.includes(value)),
    ...(present ? [] : [content]),
  ])
  return {
    entityName: entry.entityName,
    key: entry.key,
    content,
    action: owned.length === 0 ? "added" : "replaced",
  }
}

/** Count the operations, and remember the newest stamp per entity they name. */
function opCounts(ops: readonly Operation[]): {
  operations: number
  deletions: number
  lastMutation: string | undefined
  newest: Map<string, string>
} {
  const newest = new Map<string, string>()
  let operations = 0
  let deletions = 0
  let lastMutation: string | undefined
  for (const op of ops) {
    if (op.type === "shard.compact") {
      continue
    }
    operations += 1
    if (op.type.endsWith(".delete")) {
      deletions += 1
    }
    lastMutation = lastMutation === undefined || op.ts > lastMutation ? op.ts : lastMutation
    for (const name of namesIn(op)) {
      const known = newest.get(name)
      if (known === undefined || op.ts > known) {
        newest.set(name, op.ts)
      }
    }
  }
  return { operations, deletions, lastMutation, newest }
}
