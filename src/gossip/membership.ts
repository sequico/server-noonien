// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { isSafeNodeId } from "../sync/backend.js"
import { isPeerAddress } from "./address.js"
import { MAX_LIST_ENTRIES } from "./protocol.js"
import type { PeerEntry, PeerHealth } from "./types.js"

/**
 * Ceiling on the peer set. A node's id is validated on the way in, but a hostile
 * peer could still advertise unbounded distinct ids; this bound keeps membership
 * and the `{node}`-labelled metric series from growing without limit. It is the same
 * ceiling the wire list uses, so a peer can never advertise more than is held.
 */
const MAX_PEERS = MAX_LIST_ENTRIES

export { MAX_PEERS }

export interface MembershipOptions {
  readonly self: PeerEntry
  /** Consecutive failures that mark a peer suspect. */
  readonly suspectAfter: number
  /** Consecutive failures that mark a peer dead. */
  readonly deadAfter: number
  /** How long a dead peer is left alone before it is probed again. */
  readonly deadRetryMs: number
  /** How long a dead peer is kept before it is forgotten entirely. */
  readonly membershipTtlMs: number
}

interface HealthState {
  failures: number
  health: PeerHealth
  /** Epoch ms before which a dead peer is not probed again. */
  nextAttemptAt: number
  /** Epoch ms of the last successful exchange with this peer. */
  lastSuccessAt: number
}

/** A fresh, alive health state, optionally backdated to a known success. */
function freshHealth(lastSuccessAt: number): HealthState {
  return { failures: 0, health: "alive", nextAttemptAt: 0, lastSuccessAt }
}

/**
 * The live peer set, kept as a last-writer-wins set propagated over the gossip
 * channel. A node is the source of truth for its own entry, so a remote entry
 * for the local node is ignored. Reachability is local: a run of failed
 * exchanges marks a peer suspect and then dead, but a dead peer is only backed
 * off — it is probed again after {@link MembershipOptions.deadRetryMs}, and any
 * newer version of its entry (a restart) revives it immediately. Liveness never
 * becomes a permanent verdict, so a peer that comes back is always re-adopted.
 *
 * A peer that stays dead and is not reached again for
 * {@link MembershipOptions.membershipTtlMs} is **forgotten**: its entry is
 * removed and its version recorded, so the old entry still circulating in the
 * gossip of other nodes cannot silently re-add it. Only a strictly newer version
 * (the node restarting) brings it back, which is what makes the peer set
 * eventually shrink instead of growing forever.
 */
export class Membership {
  private readonly options: MembershipOptions
  private readonly selfEntry: PeerEntry
  private readonly entries = new Map<string, PeerEntry>()
  private readonly health = new Map<string, HealthState>()
  /** Versions of forgotten peers, so stale gossip does not re-add them. */
  private readonly forgotten = new Map<string, number>()
  /** Nodes whose entry came from their own `/info` (or a seed), not from gossip. */
  private readonly verified = new Set<string>()

  constructor(options: MembershipOptions) {
    this.options = options
    this.selfEntry = options.self
    this.entries.set(options.self.node, options.self)
    this.health.set(options.self.node, freshHealth(0))
  }

  /**
   * Merge a peer's advertised set, keeping the greatest version per node.
   *
   * `trusted` marks entries learned from a node's own `/info` (or an operator
   * seed): they are authoritative, so they always replace the stored entry and
   * record the node as verified. A later gossiped claim for a verified node is
   * ignored, so a peer cannot hijack the address of a node we have already
   * talked to directly.
   */
  merge(remote: readonly PeerEntry[], trusted = false): void {
    for (const entry of remote) {
      this.mergeOne(entry, trusted)
    }
  }

  private mergeOne(entry: PeerEntry, trusted: boolean): void {
    // A node id becomes a shard-file stem and a metric label, so only a path-safe
    // id is ever adopted; an unsafe one is dropped like an unsafe address.
    if (entry.node === this.selfEntry.node || !isSafeNodeId(entry.node)) {
      return
    }
    if (!isPeerAddress(entry.address)) {
      return
    }
    const current = this.entries.get(entry.node)
    if (current === undefined && this.entries.size >= MAX_PEERS) {
      return
    }
    if (!trusted && this.verified.has(entry.node)) {
      return
    }
    if (!this.adoptForgotten(entry, trusted)) {
      return
    }
    if (trusted) {
      this.verified.add(entry.node)
    }
    if (trusted || current === undefined || entry.version > current.version) {
      this.entries.set(entry.node, entry)
      if (current === undefined || entry.version > current.version) {
        // A newer version means the peer restarted with a fresh identity: clear
        // any stale failure history so it is contacted right away.
        this.health.set(entry.node, freshHealth(Date.now()))
      }
    }
  }

  /**
   * Apply the forgotten-version gate: a version we already forgot is ignored, so
   * the old entry cannot come back forever through other nodes' gossip. Returns
   * `false` when the entry must be dropped.
   */
  private adoptForgotten(entry: PeerEntry, trusted: boolean): boolean {
    const forgotten = this.forgotten.get(entry.node)
    if (forgotten === undefined) {
      return true
    }
    if (!trusted && entry.version <= forgotten) {
      return false
    }
    this.forgotten.delete(entry.node)
    return true
  }

  /**
   * Remove a node's entry: the address it named serves a different node, so the
   * entry was spoofed or stale. Its version is not remembered, so a genuine
   * entry for the node can still be adopted later.
   */
  drop(node: string): void {
    if (node === this.selfEntry.node) {
      return
    }
    this.entries.delete(node)
    this.health.delete(node)
    this.verified.delete(node)
  }

  /**
   * Remove a node entirely — entry, health, verified mark **and** its forgotten
   * version. Used when the daemon retires a peer: its protection has been
   * materialised (a retired threshold or a blanket) and must be read from there, not
   * re-derived from an entry the gate would treat as an unknown peer, which would
   * block every element instead of only the ones that peer could contest. A stale
   * gossip may re-add the node afterwards; it is then a fresh candidate — if it
   * answers it is accounted for again, if not it dies and is retired once more.
   */
  discard(node: string): void {
    if (node === this.selfEntry.node) {
      return
    }
    this.entries.delete(node)
    this.health.delete(node)
    this.verified.delete(node)
    this.forgotten.delete(node)
  }

  self(): PeerEntry {
    return this.selfEntry
  }

  /**
   * Add operator-configured entries (static seeds). A seed is explicit intent,
   * so it also clears any "forgotten" marker — otherwise a peer that once timed
   * out could never be re-adopted through configuration.
   */
  seed(entries: readonly PeerEntry[]): void {
    for (const entry of entries) {
      if (entry.node === this.selfEntry.node || !isSafeNodeId(entry.node)) {
        continue
      }
      if (!isPeerAddress(entry.address)) {
        continue
      }
      this.verified.add(entry.node)
      this.forgotten.delete(entry.node)
      const current = this.entries.get(entry.node)
      if (current === undefined || entry.version > current.version) {
        this.entries.set(entry.node, entry)
        this.health.set(entry.node, freshHealth(Date.now()))
      }
    }
  }

  known(): PeerEntry[] {
    return [...this.entries.values()]
  }

  /**
   * Every node id that could still hold operations this node has not seen: the known
   * peers plus the ones the membership TTL forgot. A forgotten node is out of the
   * peer set — it is not contacted and not gossiped — but it may be alive but off the
   * mesh, writing: dropping a tombstone it could contest would let it resurrect when
   * it reconnects. So collection must keep counting it until it is seen again or the
   * operator explicitly departs it.
   */
  retainedNodes(): string[] {
    const nodes = new Set(this.entries.keys())
    for (const node of this.forgotten.keys()) {
      nodes.add(node)
    }
    nodes.delete(this.selfEntry.node)
    return [...nodes]
  }

  /**
   * Known peers except the local node. A dead peer is skipped only until its
   * backoff has elapsed, so the mesh always has a path back to it.
   */
  contactable(now = Date.now()): PeerEntry[] {
    return this.known().filter((entry) => {
      if (entry.node === this.selfEntry.node) {
        return false
      }
      const state = this.health.get(entry.node)
      return state?.health !== "dead" || now >= state.nextAttemptAt
    })
  }

  healthOf(node: string): PeerHealth {
    return this.health.get(node)?.health ?? "alive"
  }

  recordSuccess(node: string, now = Date.now()): void {
    this.health.set(node, { failures: 0, health: "alive", nextAttemptAt: 0, lastSuccessAt: now })
  }

  /**
   * Learn a peer from an inbound request. Renews its liveness and, for a node not
   * yet known, adopts the entry it announced so we can contact it back — this is
   * what lets a statically-seeded joiner be discovered by the seeds it reached,
   * since membership is otherwise pull-only. The entry is untrusted, exactly like
   * a gossiped one: the next sync confirms it against the peer's own `/info` and
   * marks it verified.
   */
  learn(entry: PeerEntry, now = Date.now()): void {
    if (entry.node === this.selfEntry.node) {
      return
    }
    this.merge([entry], false)
    if (this.entries.has(entry.node)) {
      this.recordSuccess(entry.node, now)
    }
  }

  /**
   * Mark a known peer alive because it just reached us. A peer that contacts this
   * node is reachable by definition, so an inbound request renews liveness and
   * **revives a peer we had marked dead** — no need to wait out its retry
   * backoff. A newer version it announces also refreshes the stored entry. An
   * unknown node is ignored: an entry needs a verifiable address, learned from
   * `/info` or a seed.
   */
  touch(node: string, version: number, now = Date.now()): void {
    if (node === this.selfEntry.node) {
      return
    }
    const current = this.entries.get(node)
    if (current === undefined) {
      return
    }
    if (Number.isFinite(version) && version > current.version) {
      this.entries.set(node, { ...current, version })
    }
    this.recordSuccess(node, now)
  }

  recordFailure(node: string, now = Date.now()): void {
    const current = this.health.get(node) ?? freshHealth(now)
    const failures = current.failures + 1
    let health: PeerHealth = "alive"
    let nextAttemptAt = 0
    if (failures >= this.options.deadAfter) {
      health = "dead"
      nextAttemptAt = now + this.options.deadRetryMs
    } else if (failures >= this.options.suspectAfter) {
      health = "suspect"
    }
    this.health.set(node, { ...current, failures, health, nextAttemptAt })
  }

  /** Forget every dead peer not reached for the TTL; returns how many were dropped. */
  prune(now = Date.now()): number {
    let pruned = 0
    for (const [node, state] of this.health) {
      if (node === this.selfEntry.node || state.health !== "dead") {
        continue
      }
      if (now - state.lastSuccessAt < this.options.membershipTtlMs) {
        continue
      }
      const entry = this.entries.get(node)
      if (entry !== undefined) {
        this.forgotten.set(node, entry.version)
        this.entries.delete(node)
      }
      this.health.delete(node)
      this.verified.delete(node)
      pruned += 1
    }
    return pruned
  }
}
