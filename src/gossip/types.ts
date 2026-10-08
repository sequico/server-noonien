// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A peer as advertised by membership. A node is the source of truth for its own
 * entry; `version` is the last-writer-wins value used when two entries for the
 * same node meet.
 */
export interface PeerEntry {
  readonly node: string
  readonly address: string
  readonly version: number
}

/** What a node can serve for one shard (its own or a replica it holds). */
export interface ShardSummary {
  readonly node: string
  readonly count: number
  readonly maxSeq: number
  /** Compaction generation: bumped by the owner every time it compacts the shard. */
  readonly generation: number
}

/** A shard's position, as seen locally or at a peer, for reconciliation. */
export interface ShardState {
  readonly maxSeq: number
  readonly generation: number
}

/** Local reachability of a known peer. */
export type PeerHealth = "alive" | "suspect" | "dead"

/** A seed returned by a bootstrap adapter; the node id may still be unknown. */
export interface Seed {
  readonly node: string | undefined
  readonly address: string
}
