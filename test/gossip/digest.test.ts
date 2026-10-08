// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it } from "vitest"
import {
  bucketEntries,
  bucketOf,
  computeDigest,
  DIGEST_BUCKETS,
  differingBuckets,
  rebuildRemoteState,
  stateByNode,
  supportsDigest,
} from "../../src/gossip/digest.js"
import {
  DIGEST_CAPABILITY,
  DigestSchema,
  MAX_LIST_ENTRIES,
  MembershipSchema,
  type PeerInfoDto,
  PROTOCOL_VERSION,
  ShardsSchema,
} from "../../src/gossip/protocol.js"
import type { ShardSummary } from "../../src/gossip/types.js"

function shard(node: string, maxSeq = 0, generation = 0): ShardSummary {
  return { node, count: maxSeq + 1, maxSeq, generation }
}

function summaries(count: number): ShardSummary[] {
  return Array.from({ length: count }, (_, index) => shard(`n${index}`, index, 0))
}

function info(capabilities: string[]): PeerInfoDto {
  return { node: "peer", address: "peer:1", version: 1, protocol: PROTOCOL_VERSION, capabilities }
}

describe("bucketOf", () => {
  it("is stable and in range", () => {
    for (const node of ["a", "ai", "z600", "mail-greensley", "n42"]) {
      const bucket = bucketOf(node)
      expect(bucket).toBeGreaterThanOrEqual(0)
      expect(bucket).toBeLessThan(DIGEST_BUCKETS)
      expect(bucketOf(node)).toBe(bucket)
    }
  })

  it("spreads distinct nodes over the buckets", () => {
    const buckets = new Set(summaries(200).map((summary) => bucketOf(summary.node)))
    expect(buckets.size).toBeGreaterThan(8)
  })
})

describe("stateByNode", () => {
  it("drops an unsafe node id from a peer's summary", () => {
    const map = stateByNode([shard("good", 1), shard("../evil", 9), shard("a/b", 2)])
    expect([...map.keys()]).toEqual(["good"])
    expect(map.get("good")).toEqual({ maxSeq: 1, generation: 0 })
  })
})

describe("DigestSchema", () => {
  it("accepts a well-formed digest and rejects a wrong bucket count", () => {
    const good = computeDigest(summaries(3))
    expect(good.buckets).toHaveLength(DIGEST_BUCKETS)
    expect(DigestSchema.safeParse(good).success).toBe(true)
    expect(DigestSchema.safeParse({ root: "x", buckets: [] }).success).toBe(false)
    expect(
      DigestSchema.safeParse({ root: "x", buckets: [{ index: 0, hash: "h", count: 0 }] }).success,
    ).toBe(false)
  })
})

describe("list schemas", () => {
  it("rejects a peer list larger than the cap", () => {
    const peers = Array.from({ length: MAX_LIST_ENTRIES + 1 }, (_, index) => ({
      node: `node-${index}`,
      address: `host-${index}:1`,
      version: 1,
    }))
    expect(MembershipSchema.safeParse({ peers }).success).toBe(false)
    expect(ShardsSchema.safeParse({ shards: [] }).success).toBe(true)
  })
})

describe("computeDigest", () => {
  it("has a fixed size independent of the shard count", () => {
    expect(computeDigest(summaries(1)).buckets).toHaveLength(DIGEST_BUCKETS)
    expect(computeDigest(summaries(1000)).buckets).toHaveLength(DIGEST_BUCKETS)
  })

  it("gives the same root for the same set in any order", () => {
    const forward = computeDigest(summaries(30))
    const shuffled = computeDigest([...summaries(30)].reverse())
    expect(shuffled.root).toBe(forward.root)
  })

  it("changes the root when a high-water mark or a generation changes", () => {
    const base = computeDigest([shard("a", 1, 0), shard("b", 2, 0)])
    expect(computeDigest([shard("a", 2, 0), shard("b", 2, 0)]).root).not.toBe(base.root)
    expect(computeDigest([shard("a", 1, 1), shard("b", 2, 0)]).root).not.toBe(base.root)
  })

  it("stays far smaller than the full list at scale", () => {
    const all = summaries(1000)
    const digest = JSON.stringify(computeDigest(all))
    const list = JSON.stringify({ shards: all })
    expect(Buffer.byteLength(digest)).toBeLessThan(Buffer.byteLength(list) / 20)
  })
})

describe("bucketEntries", () => {
  it("partitions the summaries without overlap or loss", () => {
    const all = summaries(50)
    const seen = new Set<string>()
    for (let index = 0; index < DIGEST_BUCKETS; index += 1) {
      for (const summary of bucketEntries(all, [index])) {
        expect(seen.has(summary.node)).toBe(false)
        seen.add(summary.node)
      }
    }
    expect(seen.size).toBe(all.length)
    // Several buckets can be fetched in one call.
    expect(bucketEntries(all, [2, 0])).toHaveLength(
      bucketEntries(all, [0]).length + bucketEntries(all, [2]).length,
    )
  })
})

describe("differingBuckets", () => {
  it("names only the buckets whose summaries changed", () => {
    const local = computeDigest(summaries(30))
    const remote = computeDigest([...summaries(30).slice(1), shard("n0", 99, 0)])
    const differing = differingBuckets(local, remote)
    expect(differing).toEqual([bucketOf("n0")])
  })

  it("is empty for identical digests", () => {
    expect(differingBuckets(computeDigest(summaries(10)), computeDigest(summaries(10)))).toEqual([])
  })
})

describe("rebuildRemoteState", () => {
  it("keeps matched buckets as the local state and applies the fetched ones", () => {
    const local = stateByNode([shard("a", 1, 0), shard("b", 5, 0)])
    const localDigest = computeDigest([shard("a", 1, 0), shard("b", 5, 0)])
    const remoteSummaries = [shard("a", 1, 0), shard("b", 7, 0), shard("c", 2, 0)]
    const differing = differingBuckets(localDigest, computeDigest(remoteSummaries))
    const fetched = bucketEntries(remoteSummaries, differing)
    const remote = rebuildRemoteState(local, differing, fetched)
    expect(remote.get("a")).toEqual({ maxSeq: 1, generation: 0 })
    expect(remote.get("b")).toEqual({ maxSeq: 7, generation: 0 })
    expect(remote.get("c")).toEqual({ maxSeq: 2, generation: 0 })
  })

  it("drops a local node absent from the peer's differing bucket", () => {
    const local = stateByNode([shard("only-local", 3, 0)])
    const remote = rebuildRemoteState(local, [bucketOf("only-local")], [])
    expect(remote.has("only-local")).toBe(false)
  })
})

describe("supportsDigest", () => {
  it("is true only when the capability is advertised", () => {
    expect(supportsDigest(info([DIGEST_CAPABILITY]))).toBe(true)
    expect(supportsDigest(info([]))).toBe(false)
  })
})
