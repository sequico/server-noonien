// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { decodeOperations, decodeShard, encodeOperation } from "../graph/codec.js"
import { Hlc } from "../graph/hlc.js"
import type { Operation, OperationDraft } from "../graph/operations.js"
import {
  compareOperations,
  elementEffect,
  hlcOf,
  maxGeneration,
  OPERATION_VERSION,
  OperationSchema,
  observationContentKey,
  operationId,
} from "../graph/operations.js"
import type { Metrics } from "../metrics.js"
import {
  compactionContended,
  ShardChangedError,
  type SyncBackend,
  shardName as shardFileName,
} from "../sync/backend.js"

/** The read/append surface the knowledge graph needs from storage. */
export interface OperationLog {
  /** Every operation from every shard, deduplicated by operation id. */
  read(): Promise<Operation[]>
  /** Stamp the drafts as this node and append them to the node's own shard. */
  append(drafts: readonly OperationDraft[]): Promise<void>
  /** Rewrite the local shard, keeping only the operations no later one shadows. */
  compact(): Promise<CompactionResult>
  /** Prune the local shard, rewriting only when something was actually dropped. */
  prune(): Promise<PruneResult>
  /** Rewrite the local shard, also dropping the tombstones the guard clears. */
  gc(guard: CollectionGuard): Promise<CollectionResult>
}

/** The operation counts before and after compacting a shard. */
export interface CompactionResult {
  readonly before: number
  readonly after: number
}

/** A prune's counts: like a compaction's, plus how many own operations it dropped. */
export interface PruneResult extends CompactionResult {
  /** Own operations the prune removed; zero when the shard was already pruned. */
  readonly dropped: number
}

/**
 * What one rewrite reports. `dropped` exists because `before`/`after` alone cannot say
 * whether an operation went: `after` also counts the `shard.compact` metadata operation
 * the rewrite appends, so dropping exactly one balances against it. Only `prune` needs it.
 */
interface RewriteResult extends CollectionResult {
  readonly dropped: number
}

/**
 * A guard a collection consults before dropping a tombstone: whether the element it
 * removes could still be contested by a peer off the mesh.
 */
export interface CollectionGuard {
  /** True when a reachable peer is behind, suspending every element this round. */
  readonly suspended: boolean
  /** True when no off-mesh peer could hold an unseen operation on this element. */
  allows(ops: readonly Operation[]): boolean
}

/** The counts of a collection: the compaction, plus the elements it had to keep. */
export interface CollectionResult extends CompactionResult {
  /** Elements whose tombstone was kept because a peer could still contest them. */
  readonly frozen: number
}

/** The own-shard sequence high-water mark seen during a read. */
interface Scan {
  highestSequence: number
}

/** A decoded shard and the fingerprint it was decoded from. */
interface CachedShard {
  token: string
  size: number
  readonly ops: Operation[]
}

/** The latest operation per element key across every shard, for compaction. */
interface ElementIndex {
  readonly latestByKey: Map<string, Operation>
  readonly latestDeleteByContent: Map<string, Operation>
}

function observeOwn(scan: Scan, nodeId: string, op: Operation): void {
  if (op.node === nodeId && op.seq > scan.highestSequence) {
    scan.highestSequence = op.seq
  }
}

function mergeUnique(byId: Map<string, Operation>, name: string, op: Operation): void {
  const existing = byId.get(op.id)
  if (existing === undefined) {
    byId.set(op.id, op)
    return
  }
  // A node id is a single-writer shard. Two different operations with the same
  // id mean two writers shared it; merging silently would drop one of them, so
  // fail loudly instead.
  if (encodeOperation(existing) !== encodeOperation(op)) {
    throw new Error(
      `Conflicting operations share id ${op.id}: two writers used the shard ` +
        `"${name}". Give each a unique NOONIEN_NODE_ID.`,
    )
  }
}

/** How many times a compaction re-reads and retries after a concurrent write. */
const COMPACT_ATTEMPTS = 5

function buildIndex(ops: Iterable<Operation>): ElementIndex {
  const latestByKey = new Map<string, Operation>()
  const latestDeleteByContent = new Map<string, Operation>()
  for (const op of ops) {
    const key = elementEffect(op).key
    const current = latestByKey.get(key)
    if (current === undefined || compareOperations(op, current) > 0) {
      latestByKey.set(key, op)
    }
    if (op.type === "observation.delete") {
      const byContent = observationContentKey(op.entityName, op.content)
      const existing = latestDeleteByContent.get(byContent)
      if (existing === undefined || compareOperations(op, existing) > 0) {
        latestDeleteByContent.set(byContent, op)
      }
    }
  }
  return { latestByKey, latestDeleteByContent }
}

/** True when a later operation (from any node) makes this one irrelevant. */
function isShadowed(op: Operation, index: ElementIndex): boolean {
  const latest = index.latestByKey.get(elementEffect(op).key)
  if (latest !== undefined && compareOperations(latest, op) > 0) {
    return true
  }
  if (op.type === "observation.add") {
    const deleted = index.latestDeleteByContent.get(
      observationContentKey(op.entityName, op.content),
    )
    if (deleted !== undefined && compareOperations(deleted, op) > 0) {
      return true
    }
  }
  return false
}

/** True for an operation that tombstones an element (entity, relation, observation). */
function isTombstone(op: Operation): boolean {
  return (
    op.type === "entity.delete" || op.type === "relation.delete" || op.type === "observation.delete"
  )
}

/** The collection decision for one rewrite: which elements to drop, which to pin. */
interface CollectionPlan {
  /** Group keys whose own tombstone may be dropped. */
  readonly collectable: ReadonlySet<string>
  /** Group keys whose own operations are kept as witnesses for an off-mesh peer. */
  readonly pinned: ReadonlySet<string>
  /** Elements whose tombstone was kept because a peer could still contest them. */
  readonly frozen: number
}

/** The plan for a plain compaction: nothing is collected, nothing is pinned. */
const NO_COLLECTION: CollectionPlan = {
  collectable: new Set(),
  pinned: new Set(),
  frozen: 0,
}

/** The operations of the merged view, grouped by the element a collection reasons about. */
function groupByElement(ops: readonly Operation[]): Map<string, Operation[]> {
  const byKey = new Map<string, Operation[]>()
  for (const op of ops) {
    const key = foldGroup(op)
    const list = byKey.get(key)
    if (list === undefined) {
      byKey.set(key, [op])
    } else {
      list.push(op)
    }
  }
  return byKey
}

/**
 * The group a collection reasons about: the fold element for entities and relations,
 * and the observation **content** for observations. An `observation.delete` is
 * content-level but keyed at slot `-1` while an add is keyed at its occurrence, so
 * grouping them by content is what lets a surviving occurrence keep the delete — the
 * per-key view would miss it and revive the observation.
 */
function foldGroup(op: Operation): string {
  switch (op.type) {
    case "observation.add":
    case "observation.delete":
      return observationContentKey(op.entityName, op.content)
    default:
      return elementEffect(op).key
  }
}

/** The last-writer-wins winner of a set of operations on one element. */
function latestOperation(ops: readonly Operation[]): Operation | undefined {
  let latest: Operation | undefined
  for (const op of ops) {
    if (latest === undefined || compareOperations(op, latest) > 0) {
      latest = op
    }
  }
  return latest
}

/**
 * True when dropping this node's operations on the element leaves it absent, so the
 * fold is unchanged. Only another node's surviving operation can decide otherwise.
 */
function keepsAbsent(ops: readonly Operation[], selfNode: string): boolean {
  const latest = latestOperation(ops.filter((op) => op.node !== selfNode))
  return latest === undefined || isTombstone(latest)
}

/** What one element contributes to a rewrite: keep it as evidence, collect it, or count it frozen. */
interface ElementPlan {
  /** Keep every own operation on the element, as the evidence a peer knew it. */
  readonly pin: boolean
  /** Mark the element collectable, so this node's tombstone may be dropped. */
  readonly collect: boolean
  /** Count the element as frozen (this node's tombstone is kept because it must be). */
  readonly freeze: boolean
}

const NOTHING_TO_DO: ElementPlan = { pin: false, collect: false, freeze: false }

/**
 * Decide, per element, what a collection may drop.
 *
 * Two things this node can lose are decided together: one of its own **tombstones**, which a
 * collection may physically drop once the guard clears the element, and one of its own
 * operations a later one **shadows**, which is the evidence that a peer knew the element.
 * Both are safe to drop only when the guard clears the element (`allows`) and no other
 * operation keeps the element alive — and only a tombstone is ever dropped by collection.
 * When the guard cannot clear the element (the collection is suspended, or a retained
 * off-mesh peer could still hold an unseen operation on it), every own operation on it is
 * **pinned**: kept as the evidence a later round reads. The operation the peer knew may be
 * on a different node's shard than the tombstone (a delete by one node of an element another
 * created), so its author must keep it just as the deleter keeps the tombstone, or the gate
 * would lose the proof the moment that node pruned its own shadowed operation.
 */
function planElement(
  ops: readonly Operation[],
  selfNode: string,
  collection: CollectionGuard,
): ElementPlan {
  const winner = latestOperation(ops)
  if (winner === undefined) {
    return NOTHING_TO_DO
  }
  const tombstone = winner.node === selfNode && isTombstone(winner)
  // Only two things of this node's can be dropped: a tombstone it authored (collection) and
  // one of its own operations a later one shadows (evidence). A group with neither needs no
  // judgement, so its `allows` is never computed — the common case, and the reason the loop
  // stays linear on a large, live graph.
  const shadowed = ops.some((op) => op.node === selfNode && op !== winner)
  if (!tombstone && !shadowed) {
    return NOTHING_TO_DO
  }
  if (!collection.suspended && collection.allows(ops)) {
    // The guard clears the element: nothing needs keeping, and only this node's tombstone —
    // and only while the fold still hides the element without it — may be dropped.
    if (!tombstone || !keepsAbsent(ops, selfNode)) {
      return { pin: false, collect: false, freeze: tombstone }
    }
    return { pin: false, collect: true, freeze: false }
  }
  // The guard cannot clear the element: keep every own operation as the evidence a later
  // round reads, and count this node's tombstone as frozen.
  return { pin: true, collect: false, freeze: tombstone }
}

/** Assemble the per-element decisions of a rewrite into the plan it applies. */
function collectionPlan(
  merged: readonly Operation[],
  selfNode: string,
  collection: CollectionGuard | undefined,
): CollectionPlan {
  if (collection === undefined) {
    return NO_COLLECTION
  }
  const collectable = new Set<string>()
  const pinned = new Set<string>()
  let frozen = 0
  for (const [key, ops] of groupByElement(merged)) {
    const decision = planElement(ops, selfNode, collection)
    if (decision.pin) {
      pinned.add(key)
    }
    if (decision.collect) {
      collectable.add(key)
    }
    if (decision.freeze) {
      frozen += 1
    }
  }
  return { collectable, pinned, frozen }
}

/** Whether one authored operation survives a rewrite under the collection plan. */
function keep(op: Operation, index: ElementIndex, plan: CollectionPlan): boolean {
  const key = foldGroup(op)
  if (plan.pinned.has(key)) {
    return true
  }
  if (isShadowed(op, index)) {
    return false
  }
  return !(isTombstone(op) && plan.collectable.has(key))
}

/**
 * The per-node operation log. Each node writes only its own `<node>.jsonl`
 * shard; reads merge every shard the backend exposes. The per-node sequence
 * counter never restarts, so an operation id is unique even across restarts.
 * Operations are ordered by `(hlc, node, seq)` — an HLC, so the order survives
 * clock skew and a node that has seen a claim can overtake it. Writes append;
 * `compact` is the only rewrite, a compare-and-swap that re-reads and retries so
 * a concurrent writer is never lost.
 *
 * Reading is incremental: each shard is decoded once and cached against its
 * backend fingerprint, so a read only re-parses the shards that changed, and a
 * read with nothing changed returns the very same merged array — which is what
 * lets {@link MemoryGraph} memoize the fold. Writes keep the cache of this
 * node's own shard in step, so growing the log never re-decodes it.
 */
export class ShardLog implements OperationLog {
  readonly nodeId: string
  private readonly backend: SyncBackend
  private readonly metrics: Metrics | undefined
  private readonly shardOps = new Map<string, CachedShard>()
  private readonly clock = new Hlc()
  private merged: Operation[] | undefined
  private signature: string | undefined
  private sequence: number | undefined

  constructor(backend: SyncBackend, nodeId: string, metrics?: Metrics) {
    this.backend = backend
    this.nodeId = nodeId
    this.metrics = metrics
  }

  /** The shard file this node owns. */
  get shardName(): string {
    return shardFileName(this.nodeId)
  }

  /** The shard files the backend currently exposes. */
  async shards(): Promise<string[]> {
    return this.backend.list()
  }

  async read(): Promise<Operation[]> {
    const stats = await this.shardStats()
    const signature = stats
      .map((shard) => `${shard.name}\u0000${shard.token}\u0000${shard.size}`)
      .join("\u0001")
    if (signature === this.signature && this.merged !== undefined) {
      return this.merged
    }

    const { scan, ops, live } = await this.collect(stats)
    for (const name of [...this.shardOps.keys()]) {
      if (!live.has(name)) {
        this.shardOps.delete(name)
      }
    }
    if (scan.highestSequence + 1 > (this.sequence ?? -1)) {
      this.sequence = scan.highestSequence + 1
    }
    this.merged = ops
    this.signature = signature
    this.metrics?.gauge("noonien_mcp_shards_merged", "Shards merged by the last read", live.size)
    return this.merged
  }

  /** The fingerprint of every shard the backend currently exposes. */
  private async shardStats(): Promise<{ name: string; token: string; size: number }[]> {
    const stats: { name: string; token: string; size: number }[] = []
    for (const name of await this.backend.list()) {
      const info = await this.backend.stat(name)
      this.metrics?.counter("noonien_mcp_shard_stat_total", "Shard stat calls during reads")
      if (info !== undefined) {
        stats.push({ name, token: info.token, size: info.size })
      }
    }
    return stats
  }

  /** Decode every shard (reusing the cache) and merge it into one operation set. */
  private async collect(
    stats: readonly { name: string; token: string; size: number }[],
  ): Promise<{ scan: Scan; ops: Operation[]; live: Set<string> }> {
    const scan: Scan = { highestSequence: -1 }
    const byId = new Map<string, Operation>()
    const live = new Set<string>()
    for (const shard of stats) {
      live.add(shard.name)
      const { ops, decoded } = await this.shardOperations(shard)
      for (const op of ops) {
        // Observe only a newly decoded shard: the clock already passed every
        // operation of a shard read before, so re-observing is wasted work (and
        // needlessly bumps the counter).
        if (decoded) {
          this.clock.observe(hlcOf(op))
        }
        observeOwn(scan, this.nodeId, op)
        mergeUnique(byId, shard.name, op)
      }
    }
    return { scan, ops: [...byId.values()], live }
  }

  /** The decoded operations of one shard, reusing the cache when it is unchanged. */
  private async shardOperations(shard: {
    name: string
    token: string
    size: number
  }): Promise<{ ops: Operation[]; decoded: boolean }> {
    const cached = this.shardOps.get(shard.name)
    if (cached !== undefined && cached.token === shard.token && cached.size === shard.size) {
      return { ops: cached.ops, decoded: false }
    }
    const text = await this.backend.read(shard.name)
    const ops = text === undefined ? [] : decodeOperations(text, shard.name)
    this.metrics?.counter(
      "noonien_mcp_ops_decoded_total",
      "Operations decoded while reading changed shards",
      ops.length,
    )
    this.shardOps.set(shard.name, { token: shard.token, size: shard.size, ops })
    return { ops, decoded: true }
  }

  /** Stamp one draft as this node at the given sequence. */
  private stamp(draft: OperationDraft, seq: number): Operation {
    const hlc = this.clock.next()
    const ts = new Date(this.clock.physical).toISOString()
    return OperationSchema.parse({
      ...draft,
      v: OPERATION_VERSION,
      id: operationId(ts, this.nodeId, seq),
      ts,
      hlc,
      node: this.nodeId,
      seq,
    })
  }

  async append(drafts: readonly OperationDraft[]): Promise<void> {
    if (drafts.length === 0) {
      return
    }
    // Derive the next sequence from the shard as it is now when it changed under us
    // — a daemon compaction stamps a `shard.compact` at the next sequence, so a cache
    // from before it would reuse that sequence (two operations on one seq strand the
    // later one from the peers). The re-read is skipped when the cached copy is still
    // current, which is the common case after this node's own write.
    if (this.sequence === undefined || (await this.ownShardMoved())) {
      await this.recover()
    }
    let seq = this.sequence ?? 0
    const ops: Operation[] = []
    for (const draft of drafts) {
      ops.push(this.stamp(draft, seq))
      seq += 1
    }
    const text = `${ops.map(encodeOperation).join("\n")}\n`
    // The stat taken just before the append is what tells us afterwards whether an
    // external writer (a gossip recovery or a compaction) touched the shard in
    // between: only a growth from the same token as the cached copy is ours to fold.
    const before = await this.backend.stat(this.shardName)
    await this.backend.append(this.shardName, text)
    // Only now is the sequence spent: a failed append leaves it unchanged, so a
    // retry reuses the same ids instead of leaving a gap.
    this.sequence = seq

    // Fold the appended operations into the cached shard so the next read does
    // not re-decode the file we just grew — but only when no external write slipped
    // in (the token still matches) and the file grew by exactly what we wrote. Any
    // other write leaves the cached copy stale, and dropping it forces a re-decode.
    const cached = this.shardOps.get(this.shardName)
    const info = await this.backend.stat(this.shardName)
    if (
      cached !== undefined &&
      before !== undefined &&
      info !== undefined &&
      cached.token === before.token &&
      info.size === before.size + Buffer.byteLength(text)
    ) {
      for (const op of ops) {
        cached.ops.push(op)
      }
      cached.token = info.token
      cached.size = info.size
    } else {
      this.shardOps.delete(this.shardName)
    }
    this.merged = undefined
    this.signature = undefined
  }

  /**
   * True when this node's own shard changed since the cached copy was read — a
   * concurrent writer (a daemon compaction or recovery) touched it, so the cached
   * sequence must be re-derived before stamping the next operation.
   */
  private async ownShardMoved(): Promise<boolean> {
    const cached = this.shardOps.get(this.shardName)
    if (cached === undefined) {
      return true
    }
    const info = await this.backend.stat(this.shardName)
    return info === undefined || info.token !== cached.token || info.size !== cached.size
  }

  /**
   * Recover the per-node sequence from the shard, and advance the clock past
   * everything in it, so the sequence never restarts across a restart and a
   * write after recovery is ordered after every recovered operation.
   */
  private async recover(): Promise<number> {
    const text = await this.backend.read(this.shardName)
    const scan: Scan = { highestSequence: -1 }
    if (text !== undefined) {
      for (const op of decodeOperations(text, this.shardName)) {
        this.clock.observe(hlcOf(op))
        observeOwn(scan, this.nodeId, op)
      }
    }
    if (scan.highestSequence + 1 > (this.sequence ?? -1)) {
      this.sequence = scan.highestSequence + 1
    }
    return this.sequence ?? 0
  }

  /**
   * Rewrite this node's shard, per element keeping only the operations no later
   * one shadows — the winner of every element always survives, so the merged
   * graph is unchanged. Safe to run online: the rewrite is a compare-and-swap
   * against the content that was read, and a conflict (a concurrent append or a
   * gossip recovery) makes the whole compaction re-read and retry, so no write is
   * ever lost.
   *
   * Each compaction stamps a `shard.compact` metadata operation: its `generation`
   * (bumped every time) tells peers that a replica was superseded, and its `seq`
   * (the current sequence) is the shard's durable high-water mark, so the sequence
   * never regresses and a compaction is never mistaken for a lost shard.
   */
  async compact(): Promise<CompactionResult> {
    const result = await this.rewriteWithRetry(undefined, false)
    return { before: result.before, after: result.after }
  }

  /**
   * Prune the local shard: drop the operations a later one shadows and keep every
   * surviving tombstone, rewriting **only when something was actually dropped**.
   *
   * This is what a shard that only ever adds needs. It can lose nothing, so it needs
   * neither the peer knowledge nor the operator's promise, and skipping the no-op rewrite
   * matters: a rewrite bumps the generation, and a bumped generation makes every peer
   * re-pull the whole shard. `noonien import` maintains its `<node>-import` shard this
   * way, and `noonien compact` prunes it too.
   */
  async prune(): Promise<PruneResult> {
    const { before, after, dropped } = await this.rewriteWithRetry(undefined, true)
    return { before, after, dropped }
  }

  /**
   * Collect the local shard: drop the operations a later one shadows (exactly as
   * `compact` does) and, for every element `guard` clears, drop the surviving
   * tombstone too, so the deletion becomes physical (no operation left in the log).
   *
   * A tombstone whose competitors are gone changes nothing once removed — the fold
   * is unchanged — but a peer off the mesh that folded the element may still hold an
   * unseen causally aware add it beats, so it could resurrect when it returns. The
   * caller decides that per element through {@link CollectionGuard}: it must be
   * sound, because the guard is the only thing standing between a drop and a
   * revival. When a peer could contest an element, the element is pinned — every own
   * operation on it is kept, so the operation the peer folded survives as the witness
   * the next round reads again.
   *
   * Only the shard this node authors is ever rewritten. The rewrite is a
   * compare-and-swap, and an unchanged shard is left untouched so the generation
   * does not churn.
   */
  async gc(guard: CollectionGuard): Promise<CollectionResult> {
    const { before, after, frozen } = await this.rewriteWithRetry(guard, true)
    return { before, after, frozen }
  }

  /** One rewrite attempt, retried against a fresh read on a lost CAS race. */
  private async rewriteWithRetry(
    collection: CollectionGuard | undefined,
    skipIfUnchanged: boolean,
  ): Promise<RewriteResult> {
    for (let attempt = 0; attempt < COMPACT_ATTEMPTS; attempt += 1) {
      try {
        return await this.rewriteShard(collection, skipIfUnchanged)
      } catch (error) {
        if (!(error instanceof ShardChangedError)) {
          throw error
        }
        // A concurrent write slipped in: drop the caches and retry against a
        // fresh read.
        this.shardOps.delete(this.shardName)
        this.merged = undefined
        this.signature = undefined
        this.sequence = undefined
      }
    }
    throw compactionContended(this.shardName)
  }

  /** One rewrite attempt; throws `ShardChangedError` on a lost CAS race. */
  private async rewriteShard(
    collection: CollectionGuard | undefined,
    skipIfUnchanged: boolean,
  ): Promise<RewriteResult> {
    const text = await this.backend.read(this.shardName)
    if (text === undefined) {
      return { before: 0, after: 0, frozen: 0, dropped: 0 }
    }
    const { ops: all, corrupted } = decodeShard(text, this.shardName)
    if (corrupted > 0) {
      // A rewrite re-encodes only decoded operations, so a corrupt line would be
      // erased for good. Refuse instead of losing data we could not parse.
      throw new Error(
        `shard ${this.shardName} has ${corrupted} corrupt line(s); refusing to rewrite over them`,
      )
    }
    const own = all.filter((op) => op.node === this.nodeId && op.type !== "shard.compact")
    if (own.length === 0) {
      return { before: all.length, after: all.length, frozen: 0, dropped: 0 }
    }
    const merged = await this.read()
    const index = buildIndex(merged)
    const plan = collectionPlan(merged, this.nodeId, collection)
    const keptOwn = own.filter((op) => keep(op, index, plan))
    const kept = [
      ...all.filter((op) => op.node !== this.nodeId && op.type !== "shard.compact"),
      ...keptOwn,
    ]
    // Nothing of ours was dropped: leave the shard (and its generation) untouched.
    if (skipIfUnchanged && keptOwn.length === own.length) {
      return { before: all.length, after: all.length, frozen: plan.frozen, dropped: 0 }
    }
    const seq = this.sequence ?? (await this.recover())
    const meta = this.stamp({ type: "shard.compact", generation: maxGeneration(all) + 1 }, seq)
    const rewritten = [...kept, meta]
    rewritten.sort(compareOperations)
    const body = rewritten.map(encodeOperation).join("\n")
    await this.backend.replace(this.shardName, `${body}\n`, text)
    this.metrics?.counter("noonien_mcp_compacted_total", "Shard compactions")
    this.shardOps.delete(this.shardName)
    this.merged = undefined
    this.signature = undefined
    this.sequence = undefined
    return {
      before: all.length,
      after: rewritten.length,
      frozen: plan.frozen,
      dropped: own.length - keptOwn.length,
    }
  }
}
