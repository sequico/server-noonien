// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod"

/** One peer entry in the gossiped membership set. */
export const PeerEntrySchema = z.object({
  node: z.string().min(1),
  address: z.string().min(1),
  version: z.number().int().min(0),
})

/**
 * The wire protocol revision. It is part of `/info`, so the first exchange with
 * a peer validates compatibility and a mismatch surfaces as a clear error at the
 * start of the reconciliation instead of a silent misinterpretation.
 */
export const PROTOCOL_VERSION = 1

/**
 * A capability a node advertises in `/info` alongside the protocol revision. It
 * is additive, so an older peer ignores it and a newer peer falls back cleanly:
 * `digest` means the peer serves `/shards/digest` and can reconcile its shard
 * set without exchanging the full list.
 */
export const DIGEST_CAPABILITY = "digest"

/**
 * Ceiling on the entries a peer may advertise in one list (`/membership`,
 * `/shards`). Well above any realistic mesh, it stops a hostile peer from forcing
 * unbounded local state — and per-entry outbound work — out of a single response.
 */
export const MAX_LIST_ENTRIES = 10_000

/** Ceiling on the capabilities a peer may advertise in `/info`. */
export const MAX_CAPABILITIES = 64

/**
 * Maximum size of a pushed operations body. The server rejects a larger request, and
 * the client derives its operation and response caps from it, so one constant bounds
 * the wire on both ends.
 */
export const MAX_WIRE_BYTES = 64 * 1024 * 1024

/**
 * Fixed bucket count of the shard digest. The digest is a root over one hash per
 * bucket, so its size is independent of the shard count and reconciliation costs
 * O(buckets) comparisons whatever the mesh size. It is part of the wire contract:
 * a digest with a different bucket count is rejected rather than silently
 * reconciled against the wrong buckets.
 */
export const DIGEST_BUCKETS = 16

/** Body of `GET /info`: this node's entry, the protocol revision and its capabilities. */
export const PeerInfoSchema = PeerEntrySchema.extend({
  protocol: z.literal(PROTOCOL_VERSION),
  capabilities: z.array(z.string()).max(MAX_CAPABILITIES).default([]),
})

/** Body of `GET /membership`. */
export const MembershipSchema = z.object({
  peers: z.array(PeerEntrySchema).max(MAX_LIST_ENTRIES),
})

/** One servable shard. */
export const ShardSummarySchema = z.object({
  node: z.string().min(1),
  count: z.number().int().min(0),
  maxSeq: z.number().int(),
  generation: z.number().int().min(0).default(0),
})

/** Body of `GET /shards`. */
export const ShardsSchema = z.object({
  shards: z.array(ShardSummarySchema).max(MAX_LIST_ENTRIES),
})

/** One bucket of the shard digest: a hash over the bucket's shard summaries. */
export const DigestBucketSchema = z.object({
  index: z.number().int().min(0),
  hash: z.string().min(1),
  count: z.number().int().min(0),
})

/**
 * Body of `GET /shards/digest`: a Merkle root over the bucket hashes plus the
 * buckets themselves. The size is fixed — a root and one hash per bucket — so it
 * does not grow with the shard count, and only the differing buckets are fetched.
 * A digest with the wrong number of buckets, or duplicate/out-of-range indexes, is
 * rejected at parse time.
 */
export const DigestSchema = z
  .object({
    root: z.string().min(1),
    buckets: z.array(DigestBucketSchema),
  })
  .superRefine((digest, ctx) => {
    if (digest.buckets.length !== DIGEST_BUCKETS) {
      ctx.addIssue({
        code: "custom",
        message: `digest must carry exactly ${DIGEST_BUCKETS} buckets`,
      })
    }
    const indexes = new Set(digest.buckets.map((bucket) => bucket.index))
    if (indexes.size !== digest.buckets.length || [...indexes].some((i) => i >= DIGEST_BUCKETS)) {
      ctx.addIssue({ code: "custom", message: "digest bucket indexes must be unique and in range" })
    }
  })

/** Body of `POST /shards/{node}/ops`. */
export const ReceiveResultSchema = z.object({
  appended: z.number().int().min(0),
  maxSeq: z.number().int(),
})

export type PeerEntryDto = z.infer<typeof PeerEntrySchema>
export type PeerInfoDto = z.infer<typeof PeerInfoSchema>
export type ShardSummaryDto = z.infer<typeof ShardSummarySchema>
export type DigestBucketDto = z.infer<typeof DigestBucketSchema>
export type DigestDto = z.infer<typeof DigestSchema>
