// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto"
import { isSafeNodeId } from "../sync/backend.js"
import { DIGEST_BUCKETS, DIGEST_CAPABILITY, type DigestDto, type PeerInfoDto } from "./protocol.js"
import type { ShardState, ShardSummary } from "./types.js"

export { DIGEST_BUCKETS }

/** Whether a peer advertises the digest capability, so the compact path is safe. */
export function supportsDigest(info: PeerInfoDto): boolean {
  return info.capabilities.includes(DIGEST_CAPABILITY)
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

/** The canonical text of one summary inside a bucket hash. */
function line(summary: ShardSummary): string {
  return `${summary.node}\u0000${summary.maxSeq}\u0000${summary.generation}`
}

/** The bucket a node's summary belongs to, from a stable hash of the node id. */
export function bucketOf(node: string, buckets = DIGEST_BUCKETS): number {
  return createHash("sha256").update(node).digest().readUInt32BE(0) % buckets
}

/** The digest of a shard set: one hash per bucket plus their Merkle root. */
export function computeDigest(
  summaries: readonly ShardSummary[],
  buckets = DIGEST_BUCKETS,
): DigestDto {
  const grouped: string[][] = Array.from({ length: buckets }, () => [])
  for (const summary of summaries) {
    grouped[bucketOf(summary.node, buckets)]?.push(line(summary))
  }
  const entries = grouped.map((lines, index) => {
    lines.sort()
    return { index, hash: hash(lines.join("\n")), count: lines.length }
  })
  return { root: hash(entries.map((entry) => entry.hash).join("\n")), buckets: entries }
}

/**
 * The summaries in the given buckets, sorted by node. A peer fetches all its
 * differing buckets in one call, so the server scans the shard set once instead
 * of once per bucket.
 */
export function bucketEntries(
  summaries: readonly ShardSummary[],
  indexes: readonly number[],
  buckets = DIGEST_BUCKETS,
): ShardSummary[] {
  const wanted = new Set(indexes)
  return summaries
    .filter((summary) => wanted.has(bucketOf(summary.node, buckets)))
    .sort((a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : 0))
}

/** Index shard summaries by node for reconciliation, dropping unsafe node ids. */
export function stateByNode(summaries: readonly ShardSummary[]): Map<string, ShardState> {
  const byNode = new Map<string, ShardState>()
  for (const summary of summaries) {
    // A summary names a node id this node later builds a shard path from, so an
    // unsafe id (from a peer's `/shards` or digest) is dropped, not trusted.
    if (!isSafeNodeId(summary.node)) {
      continue
    }
    byNode.set(summary.node, { maxSeq: summary.maxSeq, generation: summary.generation })
  }
  return byNode
}

/** The bucket indexes whose hashes differ between a local and a peer digest. */
export function differingBuckets(local: DigestDto, remote: DigestDto): number[] {
  const remoteHashes = new Map(remote.buckets.map((bucket) => [bucket.index, bucket.hash]))
  return local.buckets
    .filter((bucket) => remoteHashes.get(bucket.index) !== bucket.hash)
    .map((bucket) => bucket.index)
}

/**
 * Rebuild the peer's shard states from a bucket exchange. A bucket whose hash
 * matched is identical on both sides, so the peer's state equals the local one;
 * for the buckets that differed the peer's entries are used, and a local node
 * absent there is absent at the peer (the `-1` reconciliation default).
 */
export function rebuildRemoteState(
  local: ReadonlyMap<string, ShardState>,
  differing: readonly number[],
  fetched: readonly ShardSummary[],
  buckets = DIGEST_BUCKETS,
): Map<string, ShardState> {
  const changed = new Set(differing)
  const remote = new Map<string, ShardState>()
  for (const [node, state] of local) {
    if (!changed.has(bucketOf(node, buckets))) {
      remote.set(node, state)
    }
  }
  for (const [node, state] of stateByNode(fetched)) {
    remote.set(node, state)
  }
  return remote
}
