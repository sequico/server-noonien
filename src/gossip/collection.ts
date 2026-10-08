// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Operation } from "../graph/operations.js"
import type { CollectionGuard } from "../store/log.js"

/** A peer's per-author high-water mark: the greatest frontier it has been seen to hold. */
export type Frontier = ReadonlyMap<string, number>

/**
 * The retained peers a round did not exchange with, and how to read each one.
 *
 * `retired` and `blanket` are the two durable forms a peer's protection takes once
 * its retention window expires and its live record is dropped. They exist so that
 * bounding the retained metadata never weakens the gate: the *comparison* a peer
 * provided is materialised, not its outcome (see `PLAN.md`, and
 * `retireSilentPeers` in `daemon.ts`, which produces them).
 */
export interface OffMesh {
  /** Retained peers (known or forgotten) this node has not exchanged with this round. */
  readonly pending: readonly string[]
  /** True for a pending peer the node can still reach (its health is not dead). */
  readonly reachable: (node: string) => boolean
  /** The greatest frontier a peer has been seen to hold, or `undefined` when never reached. */
  readonly frontier: (node: string) => Frontier | undefined
  /**
   * The **retired frontier**: the elementwise maximum per author of the frontiers of
   * the peers whose retention window expired. It is one more frontier — the same
   * coverage and subset rules, over thresholds that outlive the peers that produced
   * them — so it gates the elements those peers could contest **for ever**, including
   * deletions that happen *after* the expiry (a per-element pin taken at expiry would
   * miss exactly those, which is why the comparison is kept instead; see
   * `PLAN.md`).
   *
   * It cannot over-reach: only *accounted* peers (whose frontier is a subset of the
   * local high-water marks) are merged into it, so `retired ⊆ local` always holds and
   * the map is bounded by the shards this node holds, not by the nodes ever seen.
   */
  readonly retired: Frontier
  /**
   * True when a durable **blanket** is in force: a retired peer that was *not*
   * accounted for left "it could hold anything" behind, because its frontier could
   * not be verified and merging it would mean trusting a claim we cannot read.
   */
  readonly blanket: boolean
  /** The local node's own per-author high-water marks: everything this node holds. */
  readonly local: Frontier
}

/**
 * The knowledge state a collection must respect, distilled from the mesh: a
 * **suspended** collection drops no tombstone at all (a reachable peer was not
 * exchanged with, so unseen writes may still be in flight), while `peers` are the
 * gating frontiers — the peers off the mesh, the retired frontier, and `undefined`
 * for anything that could hold a relayed operation nobody can identify: a peer never
 * reached, or a durable blanket. `local` is what this node itself holds, so a peer
 * that holds anything the node lacks is never treated as harmless.
 */
export interface Collection {
  /** True when a reachable peer is behind, so nothing may be collected. */
  readonly suspended: boolean
  /** The gating frontiers; `undefined` means "could hold anything". */
  readonly peers: readonly (Frontier | undefined)[]
  /** The local node's own per-author high-water marks. */
  readonly local: Frontier
}

/**
 * The peers that must keep gating collection: the membership's known and forgotten
 * peers, plus **every peer this node has ever exchanged with**. The second set
 * matters because membership can drop an entry (an address that serves a different
 * node) without forgetting it, and a peer that once held an operation may still
 * author a competing one — so it keeps blocking until it is revoked or departed.
 */
export function retainedPeers(
  knownOrForgotten: readonly string[],
  everReached: readonly string[],
): string[] {
  const peers = new Set(knownOrForgotten)
  for (const node of everReached) {
    peers.add(node)
  }
  return [...peers]
}

/**
 * Distill the peers a round did not cover into a collection gate. A pending peer
 * that is still reachable suspends collection entirely: it may hold writes this
 * node has not pulled, and its live frontier says nothing about them. A peer off
 * the mesh only contributes its knowledge frontier — the *causally aware* writes it
 * could have authored while away are those on the elements it already folded; a
 * peer that folded nothing on an element can only mint a coincident one, which the
 * fold decides as a concurrent genesis rather than a revival.
 */
export function meshState(input: OffMesh): Collection {
  const peers: (Frontier | undefined)[] = []
  for (const node of input.pending) {
    if (input.reachable(node)) {
      return { suspended: true, peers: [], local: input.local }
    }
    peers.push(input.frontier(node))
  }
  // The retired frontier gates exactly like a peer off the mesh; a durable blanket is
  // the statement that something could hold anything, which the gate already reads as
  // `undefined`. Both outlive the peers they came from, so a restart cannot lose them.
  peers.push(input.retired)
  if (input.blanket) {
    peers.push(undefined)
  }
  return { suspended: false, peers, local: input.local }
}

/**
 * True when a frontier claims operations the local node does not hold — the peer is
 * **not accounted for**. Such a peer could hold a *relayed* operation on an element,
 * authored by a third node, that its per-author frontier cannot identify; its holdings
 * are therefore not readable as a subset of the local view, and it blocks instead.
 * One definition, shared by the gate and by the retirement decision that merges a
 * peer's frontier into the retired one: only an accounted peer may be merged.
 */
export function exceedsLocal(frontier: Frontier, local: Frontier): boolean {
  for (const [author, seq] of frontier) {
    if (seq > (local.get(author) ?? -1)) {
      return true
    }
  }
  return false
}

/**
 * Drop the authors whose writes are forfeited — `NOONIEND_REVOKED` / `NOONIEND_DEPARTED`.
 *
 * A forfeited node is refused on every route and its shard is never pulled again, so no
 * operation it authored can reach this node after the forfeit. Its author entry, however,
 * stays in the frontiers of the peers that hold its replica (and in the retired frontier),
 * and once its own shard is gone that entry reads as "holds something this node lacks" —
 * a **blanket** over every element, which is precisely the block the operator meant to
 * lift. Removing the author is therefore both sound and what makes the escape hatch work.
 *
 * A *revoked* node keeps its replica here, so the operations of its we already hold still
 * keep their elements frozen through the fold (the plan will not drop a tombstone whose
 * competitor survives) — that one is `NOONIEND_DEPARTED`'s job, which discards it.
 */
export function withoutForfeited(frontier: Frontier, forfeited: ReadonlySet<string>): Frontier {
  if (![...frontier.keys()].some((author) => forfeited.has(author))) {
    return frontier
  }
  const kept = new Map<string, number>()
  for (const [author, seq] of frontier) {
    if (!forfeited.has(author)) {
      kept.set(author, seq)
    }
  }
  return kept
}

/** True when a frontier covers one of the element's operations: the peer knew it. */
function coversElement(frontier: Frontier, ops: readonly Operation[]): boolean {
  return ops.some((op) => (frontier.get(op.node) ?? -1) >= op.seq)
}

/**
 * True when no peer off the mesh could hold an operation on this element that the
 * local node has not seen.
 *
 * A peer that holds anything the local node lacks is treated as a blocker: it could
 * hold a relayed operation on this element, authored by a third node, that the local
 * node has never received — and its per-author frontier would not reveal *which*
 * element. Only when the peer's frontier is within the local node's own high-water
 * marks can its holdings be read as a subset of the local view, and then a frontier
 * that covers no operation of the element means the peer never *folded* it — so it
 * cannot have authored a competing tombstone on it, and an add it authors is a
 * concurrent genesis the fold decides, not a causally aware competitor (Invariant
 * 4.1). A peer never reached (`undefined` frontier) could hold anything, so it blocks
 * every element. A **retired** frontier takes part in exactly this rule, which is what
 * makes expiry invisible to the outcome: what changes is only where the thresholds live.
 */
export function collectable(collection: Collection, ops: readonly Operation[]): boolean {
  if (collection.suspended) {
    return false
  }
  return !collection.peers.some(
    (frontier) =>
      frontier === undefined ||
      exceedsLocal(frontier, collection.local) ||
      coversElement(frontier, ops),
  )
}

/** Wrap a collection's knowledge state as the guard a `ShardLog.gc` consults. */
export function collectionGuard(state: Collection): CollectionGuard {
  return { suspended: state.suspended, allows: (ops) => collectable(state, ops) }
}
