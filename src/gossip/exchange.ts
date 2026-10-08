// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import {
  computeDigest,
  differingBuckets,
  rebuildRemoteState,
  stateByNode,
  supportsDigest,
} from "./digest.js"
import type { Membership } from "./membership.js"
import type { PeerInfoDto, ShardSummaryDto } from "./protocol.js"
import type { ReplicaStore } from "./replica.js"
import { type PeerTransport, UnreachableError } from "./transport.js"
import type { PeerEntry, ShardState } from "./types.js"

export interface SyncResult {
  readonly ok: boolean
  readonly pulled: number
  readonly pushed: number
  /** The peer's per-shard high-water marks, for the caller's stable-watermark view. */
  readonly shards: ReadonlyMap<string, number>
  readonly error: string | undefined
}

export interface SyncOptions {
  /**
   * Fetch and merge the peer's full membership list. `false` when membership is
   * gossiped on its own channel, so the data exchange carries no peer-set
   * metadata; the peer's own entry is still learned from its `/info`.
   */
  readonly membership?: boolean
  /**
   * Shard count at or above which the compact digest replaces the full shard
   * list. Below it the plain list is cheaper, so it is the default.
   */
  readonly digestMinShards?: number
  /** Called when the digest path was used, for the daemon's metrics. */
  readonly onDigest?: () => void
  /** Node ids whose shards are never pulled — a revoked or departed peer's replica. */
  readonly ignored?: ReadonlySet<string>
}

interface ReconcileInput {
  readonly transport: PeerTransport
  readonly replica: ReplicaStore
  readonly local: ReadonlyMap<string, ShardState>
  readonly remote: ReadonlyMap<string, ShardState>
  readonly ignored: ReadonlySet<string> | undefined
}

interface Exchange {
  readonly pulled: number
  readonly pushed: number
}

/**
 * True when the local replica of a shard is a **new generation** the peer has not
 * adopted: its replica still holds the pre-compaction content, so the owner must not
 * push it a delta (which would carry the `shard.compact` metadata and strand the
 * operations the compaction dropped); the peer replaces the whole shard on its own
 * round. A peer with no replica yet (`maxSeq < 0`) is never superseded.
 */
function isSuperseded(local: ShardState, remote: ShardState): boolean {
  return remote.maxSeq >= 0 && remote.generation < local.generation
}

/**
 * What the peer holds after a successful exchange, as a per-shard high-water mark
 * (the knowledge frontier the daemon records). The peer's own report predates the
 * exchange, so for the shard this node authors the entry is raised to this node's
 * local high-water mark when the exchange delivered it that shard — a superseded
 * replica is excluded, because then the owner pushes nothing and the peer adopts the
 * current shard on its own round. Without this, a peer that goes away right after
 * being pushed would look like it never folded the element.
 */
function peerKnowledge(
  replica: ReplicaStore,
  local: ReadonlyMap<string, ShardState>,
  remote: ReadonlyMap<string, ShardState>,
): Map<string, number> {
  const shards = new Map([...remote].map(([node, state]) => [node, state.maxSeq]))
  const own = local.get(replica.ownNode)
  if (own !== undefined) {
    const reported = remote.get(replica.ownNode) ?? { maxSeq: -1, generation: 0 }
    if (!isSuperseded(own, reported)) {
      shards.set(replica.ownNode, Math.max(shards.get(replica.ownNode) ?? -1, own.maxSeq))
    }
  }
  return shards
}

/**
 * Reconcile every shard with one peer by comparing per-shard high-water marks.
 * A node only ever pushes the shard it authors; for every other shard it pulls
 * the missing delta. Membership is merged on the way (unless the channels are
 * split) and the peer's reachability is updated from the outcome. Relay comes
 * for free: a node serves any replica it holds, so a third node's shard reaches
 * the others by being pulled through it. A node's own shard is only ever
 * recovered from a peer's replica, never overwritten by it.
 *
 * Above {@link SyncOptions.digestMinShards} the peer's shard set is compared
 * through a fixed-size digest (when the peer advertises it) and only the
 * differing buckets are fetched, so a large mesh exchanges O(buckets) metadata
 * per round instead of one summary per shard; below it — and with a peer that
 * cannot digest — the plain `/shards` list is used unchanged.
 */
export async function syncWith(
  peer: PeerEntry,
  transport: PeerTransport,
  replica: ReplicaStore,
  membership: Membership,
  options: SyncOptions = {},
): Promise<SyncResult> {
  try {
    const info = await transport.info()
    if (info.node !== peer.node) {
      // The address serves a different node than the entry claimed: the entry is
      // spoofed or stale, so drop it rather than trust it.
      membership.drop(peer.node)
      return {
        ok: false,
        pulled: 0,
        pushed: 0,
        shards: new Map(),
        error: `peer at ${transport.address} is ${info.node}, not ${peer.node}`,
      }
    }
    membership.merge([{ node: info.node, address: transport.address, version: info.version }], true)
    if (options.membership !== false) {
      membership.merge(await transport.membership())
    }
    const localSummaries = await replica.list()
    const local = stateByNode(localSummaries)
    const remote = await remoteStates(transport, info, local, localSummaries, options)
    const exchange = await reconcile({
      transport,
      replica,
      local,
      remote,
      ignored: options.ignored,
    })
    membership.recordSuccess(peer.node)
    return {
      ok: true,
      ...exchange,
      shards: peerKnowledge(replica, local, remote),
      error: undefined,
    }
  } catch (error) {
    // Only a failed connection counts against liveness. An HTTP status, a schema
    // mismatch or a rejected push mean the peer answered, so it stays alive and
    // the error is surfaced for the operator to see.
    if (error instanceof UnreachableError) {
      membership.recordFailure(peer.node)
    } else {
      membership.recordSuccess(peer.node)
    }
    return {
      ok: false,
      pulled: 0,
      pushed: 0,
      shards: new Map(),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Gossip membership with one peer on the dedicated channel: fetch and merge its
 * peer set, nothing else. Used when the channels are split, so the data
 * anti-entropy no longer carries the full peer list on every exchange. Liveness
 * is left to the data channel, which contacts the mesh and records it, so a
 * membership-only fetch never counts twice.
 */
export async function syncMembership(
  transport: PeerTransport,
  membership: Membership,
): Promise<boolean> {
  try {
    membership.merge(await transport.membership())
    return true
  } catch {
    return false
  }
}

/** The peer's shard states, via the full list or the compact digest. */
async function remoteStates(
  transport: PeerTransport,
  info: PeerInfoDto,
  local: ReadonlyMap<string, ShardState>,
  localSummaries: readonly ShardSummaryDto[],
  options: SyncOptions,
): Promise<Map<string, ShardState>> {
  const threshold = options.digestMinShards ?? Number.POSITIVE_INFINITY
  if (!supportsDigest(info) || localSummaries.length < threshold) {
    return stateByNode(await transport.shards())
  }
  const localDigest = computeDigest(localSummaries)
  const remoteDigest = await transport.digest()
  options.onDigest?.()
  if (remoteDigest.root === localDigest.root) {
    // The two shard sets agree: the peer's state is the local one, so no list is
    // exchanged at all.
    return new Map(local)
  }
  const differing = differingBuckets(localDigest, remoteDigest)
  return rebuildRemoteState(local, differing, await transport.digestBuckets(differing))
}

async function reconcile(input: ReconcileInput): Promise<Exchange> {
  let pulled = 0
  let pushed = 0
  for (const node of new Set([...input.remote.keys(), ...input.local.keys()])) {
    // A revoked or departed node's replica is not re-pulled: pulling it back would
    // undo the discard that freed collection from it.
    if (input.ignored?.has(node) === true) {
      continue
    }
    const result = await reconcileNode(input, node)
    pulled += result.pulled
    pushed += result.pushed
  }
  return { pulled, pushed }
}

/** Reconcile one node's shard: push the own shard, replace/pull a stale replica. */
async function reconcileNode(input: ReconcileInput, node: string): Promise<Exchange> {
  const { replica, transport } = input
  const local = input.local.get(node) ?? { maxSeq: -1, generation: 0 }
  const remote = input.remote.get(node) ?? { maxSeq: -1, generation: 0 }
  if (node === replica.ownNode) {
    // A peer whose replica is a superseded generation must replace the whole shard,
    // which it does on its own round: pushing the delta instead would deliver the
    // `shard.compact` metadata, advance the peer's generation, and leave the
    // operations the compaction dropped sitting in its replica for good. A peer with
    // no replica yet (`maxSeq < 0`) is never superseded — it must receive the shard,
    // otherwise a fresh node could never catch up once this node has compacted.
    if (!isSuperseded(local, remote) && remote.maxSeq < local.maxSeq) {
      return { pulled: 0, pushed: await push(input, node, remote.maxSeq) }
    }
    if (remote.maxSeq > local.maxSeq || remote.generation > local.generation) {
      // A peer holds a more complete copy of this node's own shard: recover the
      // operations it authored and lost, back into its own shard. If the peer
      // also has a newer generation, recover the whole compacted shard.
      const after = remote.generation > local.generation ? -1 : local.maxSeq
      return { pulled: await replica.recover(await transport.opsAfter(node, after)), pushed: 0 }
    }
    return { pulled: 0, pushed: 0 }
  }
  if (remote.generation > local.generation) {
    // The author compacted: replace the stale replica with the compacted shard.
    return { pulled: await replica.replace(node, await transport.opsAfter(node, -1)), pushed: 0 }
  }
  if (remote.maxSeq > local.maxSeq) {
    return {
      pulled: await replica.receive(node, await transport.opsAfter(node, local.maxSeq)),
      pushed: 0,
    }
  }
  return { pulled: 0, pushed: 0 }
}

async function push(input: ReconcileInput, node: string, afterSeq: number): Promise<number> {
  const ops = await input.replica.opsAfter(node, afterSeq)
  if (ops.length > 0) {
    await input.transport.pushOps(node, ops)
  }
  return ops.length
}
