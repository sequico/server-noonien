// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { DEFAULT_GOSSIP_PORT } from "../../src/gossip/config.js"
import { bucketEntries, computeDigest } from "../../src/gossip/digest.js"
import { syncWith } from "../../src/gossip/exchange.js"
import { Membership } from "../../src/gossip/membership.js"
import {
  DIGEST_CAPABILITY,
  type DigestDto,
  type PeerInfoDto,
  PROTOCOL_VERSION,
} from "../../src/gossip/protocol.js"
import { ReplicaStore } from "../../src/gossip/replica.js"
import type { PeerTransport } from "../../src/gossip/transport.js"
import type { PeerEntry, ShardSummary } from "../../src/gossip/types.js"
import { decodeOperations } from "../../src/graph/codec.js"
import type { Operation } from "../../src/graph/operations.js"
import type { CollectionGuard } from "../../src/store/log.js"
import { FileBackend } from "../../src/sync/file.js"

export const GOSSIP_PORT = DEFAULT_GOSSIP_PORT

/** `from` reconciles with `to`: pulls what it lacks, pushes the shard it authors. */
export async function syncPeers(from: DirectPeer, to: DirectPeer): Promise<void> {
  await syncWith(to.membership.self(), new DirectTransport(to), from.store, from.membership)
}

/** The operation types physically present in one shard file of a directory. */
export async function shardTypes(directory: string, node: string): Promise<string[]> {
  const text = await new FileBackend(directory).read(`${node}.jsonl`)
  return decodeOperations(text ?? "").map((op) => op.type)
}

/**
 * A collection guard that clears every element — no peer knowledge, so a tombstone
 * is dropped as soon as the fold allows. This is what a single-node daemon holds.
 */
export const COLLECT_ALL: CollectionGuard = { suspended: false, allows: () => true }

/** A backoff long enough that it never elapses inside a test. */
const DEAD_RETRY_MS = 300_000

export interface DirectPeer {
  readonly node: string
  readonly directory: string
  readonly store: ReplicaStore
  readonly membership: Membership
}

/** A peer backed by a real shard directory, without HTTP in between. */
export function directPeer(node: string, directory: string, version = 1): DirectPeer {
  return {
    node,
    directory,
    store: new ReplicaStore(directory, node),
    membership: testMembership(node, `${node}:${GOSSIP_PORT}`, version),
  }
}

/** A membership whose backoffs never elapse inside a test. */
export function testMembership(node: string, address: string, version = 1): Membership {
  return new Membership({
    self: { node, address, version },
    suspectAfter: 3,
    deadAfter: 6,
    deadRetryMs: DEAD_RETRY_MS,
    membershipTtlMs: 604_800_000,
  })
}

/**
 * The same contract as {@link PeerTransport}, served by calling another peer's
 * store and membership in process. Lets the convergence properties exercise the
 * sync algorithm without sockets.
 */
export class DirectTransport implements PeerTransport {
  readonly address: string
  private readonly peer: DirectPeer

  constructor(peer: DirectPeer) {
    this.peer = peer
    this.address = peer.membership.self().address
  }

  info(): Promise<PeerInfoDto> {
    return Promise.resolve({
      ...this.peer.membership.self(),
      protocol: PROTOCOL_VERSION,
      capabilities: [DIGEST_CAPABILITY],
    })
  }

  membership(): Promise<PeerEntry[]> {
    return Promise.resolve(this.peer.membership.known())
  }

  shards(): Promise<ShardSummary[]> {
    return this.peer.store.list()
  }

  async digest(): Promise<DigestDto> {
    return computeDigest(await this.peer.store.list())
  }

  async digestBuckets(indexes: readonly number[]): Promise<ShardSummary[]> {
    return bucketEntries(await this.peer.store.list(), indexes)
  }

  opsAfter(node: string, afterSeq: number): Promise<Operation[]> {
    return this.peer.store.opsAfter(node, afterSeq)
  }

  async pushOps(node: string, ops: readonly Operation[]): Promise<void> {
    await this.peer.store.receive(node, ops)
  }
}
