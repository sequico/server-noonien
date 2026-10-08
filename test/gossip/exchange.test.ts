// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { computeDigest } from "../../src/gossip/digest.js"
import { syncMembership, syncWith } from "../../src/gossip/exchange.js"
import {
  DIGEST_CAPABILITY,
  type DigestDto,
  type PeerInfoDto,
  PROTOCOL_VERSION,
} from "../../src/gossip/protocol.js"
import { seededRandom, selectPeers } from "../../src/gossip/sampler.js"
import { type PeerTransport, UnreachableError } from "../../src/gossip/transport.js"
import type { PeerEntry, ShardSummary } from "../../src/gossip/types.js"
import { foldOperations } from "../../src/graph/fold.js"
import type { Operation, OperationDraft } from "../../src/graph/operations.js"
import { ShardLog } from "../../src/store/log.js"
import { FileBackend } from "../../src/sync/file.js"
import { type DirectPeer, DirectTransport, directPeer, syncPeers } from "../support/gossip.js"

const POOL = [
  { type: "entity.create", name: "E0", entityType: "t" },
  { type: "entity.create", name: "E1", entityType: "t" },
  { type: "entity.delete", name: "E1" },
  { type: "observation.add", entityName: "E0", content: "a" },
  { type: "observation.add", entityName: "E0", content: "b" },
  { type: "relation.add", from: "E0", to: "E1", relationType: "r" },
] satisfies readonly OperationDraft[]

function poolDraft(index: number): OperationDraft {
  const value = POOL[index % POOL.length]
  if (value === undefined) {
    throw new Error("the draft pool is empty")
  }
  return value
}

function requirePeer(peers: readonly DirectPeer[], index: number): DirectPeer {
  const peer = peers[index]
  if (peer === undefined) {
    throw new Error(`missing peer at index ${index}`)
  }
  return peer
}

function allOps(peer: DirectPeer): Promise<Operation[]> {
  return peer.store.allOps()
}

async function ownOps(peer: DirectPeer): Promise<Operation[]> {
  return peer.store.opsAfter(peer.node, -1)
}

async function fullRound(peers: readonly DirectPeer[]): Promise<void> {
  for (const from of peers) {
    for (const to of peers) {
      if (from !== to) {
        await syncPeers(from, to)
      }
    }
  }
}

function idsOf(ops: readonly Operation[]): string[] {
  return ops.map((op) => op.id).sort()
}

async function tempDirectories(count: number, prefix: string): Promise<string[]> {
  return Promise.all(Array.from({ length: count }, () => mkdtemp(join(tmpdir(), prefix))))
}

async function cleanUp(directories: readonly string[]): Promise<void> {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })))
}

async function authorShards(
  plan: readonly (readonly number[])[],
  directories: readonly string[],
): Promise<DirectPeer[]> {
  const peers = directories.map((directory, index) => directPeer(`n${index}`, directory, index + 1))
  for (const [index, directory] of directories.entries()) {
    await new ShardLog(new FileBackend(directory), `n${index}`).append(
      (plan[index] ?? []).map(poolDraft),
    )
  }
  return peers
}

async function expectedIds(peers: readonly DirectPeer[]): Promise<Set<string>> {
  const ids = new Set<string>()
  for (const peer of peers) {
    for (const op of await ownOps(peer)) {
      ids.add(op.id)
    }
  }
  return ids
}

async function checkIdempotent(peers: readonly DirectPeer[]): Promise<void> {
  const before = idsOf(await allOps(requirePeer(peers, 0)))
  await fullRound(peers)
  expect(idsOf(await allOps(requirePeer(peers, 0)))).toEqual(before)
}

async function checkConvergence(plan: readonly (readonly number[])[]): Promise<void> {
  const directories = await tempDirectories(plan.length, "noonien-conv-")
  try {
    const peers = await authorShards(plan, directories)
    const expected = await expectedIds(peers)
    for (let round = 0; round < 2; round += 1) {
      await fullRound(peers)
    }
    const reference = foldOperations(await allOps(requirePeer(peers, 0)))
    for (const peer of peers) {
      const ops = await allOps(peer)
      expect(new Set(ops.map((op) => op.id))).toEqual(expected)
      expect(foldOperations(ops)).toEqual(reference)
    }
    await checkIdempotent(peers)
  } finally {
    await cleanUp(directories)
  }
}

/**
 * One round in which each node reconciles with a single, rotating peer instead
 * of the whole mesh: over `n-1` consecutive rounds every ordered pair has met
 * once, so the schedule stays connected however small the per-round subset is.
 */
async function subsetRound(peers: readonly DirectPeer[], round: number): Promise<void> {
  const count = peers.length
  for (let index = 0; index < count; index += 1) {
    const target = (index + 1 + (round % (count - 1))) % count
    if (target !== index) {
      await syncPeers(requirePeer(peers, index), requirePeer(peers, target))
    }
  }
}

async function checkSubsetConvergence(plan: readonly (readonly number[])[]): Promise<void> {
  const directories = await tempDirectories(plan.length, "noonien-subset-")
  try {
    const peers = await authorShards(plan, directories)
    const expected = await expectedIds(peers)
    for (let round = 0; round < 2 * plan.length + 2; round += 1) {
      await subsetRound(peers, round)
    }
    const reference = foldOperations(await allOps(requirePeer(peers, 0)))
    for (const peer of peers) {
      const ops = await allOps(peer)
      expect(new Set(ops.map((op) => op.id))).toEqual(expected)
      expect(foldOperations(ops)).toEqual(reference)
    }
  } finally {
    await cleanUp(directories)
  }
}

describe("syncWith", () => {
  it("converges on the union of every shard under arbitrary operation sequences", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(fc.integer({ min: 0, max: POOL.length - 1 }), { maxLength: 4 }), {
          minLength: 2,
          maxLength: 3,
        }),
        checkConvergence,
      ),
      { numRuns: 15 },
    )
  }, 20_000)

  it("relays a third node's shard through an intermediate peer", async () => {
    const directories = await tempDirectories(3, "noonien-relay-")
    try {
      await new ShardLog(new FileBackend(directories[0] ?? tmpdir()), "a").append([
        { type: "entity.create", name: "FromA", entityType: "t" },
      ])
      await new ShardLog(new FileBackend(directories[2] ?? tmpdir()), "c").append([
        { type: "entity.create", name: "FromC", entityType: "t" },
      ])
      const peers = directories.map((directory, index) =>
        directPeer(["a", "b", "c"][index] ?? `n${index}`, directory, index + 1),
      )
      const a = requirePeer(peers, 0)
      const b = requirePeer(peers, 1)
      const c = requirePeer(peers, 2)

      // a and c only ever talk to b, never to each other.
      for (let round = 0; round < 2; round += 1) {
        await syncPeers(a, b)
        await syncPeers(b, a)
        await syncPeers(b, c)
        await syncPeers(c, b)
      }

      const ops = await allOps(a)
      expect([...new Set(ops.map((op) => op.node))].sort()).toEqual(["a", "c"])
      const names = ops.flatMap((op) => (op.type === "entity.create" ? [op.name] : [])).sort()
      expect(names).toEqual(["FromA", "FromC"])
    } finally {
      await cleanUp(directories)
    }
  })

  it("reports the own shard the peer was just pushed, not its pre-exchange report", async () => {
    const directories = await tempDirectories(2, "noonien-frontier-")
    try {
      const self = directPeer("self", directories[0] ?? tmpdir())
      await new ShardLog(new FileBackend(directories[0] ?? tmpdir()), "self").append([
        { type: "entity.create", name: "E", entityType: "t" },
      ])
      const fresh = directPeer("fresh", directories[1] ?? tmpdir())
      const result = await syncWith(
        fresh.membership.self(),
        new DirectTransport(fresh),
        self.store,
        self.membership,
      )
      // `fresh` had no replica before the exchange; the push delivered self's shard,
      // so the reported frontier must include it. Otherwise a peer that leaves right
      // after being pushed would look like it never folded the element.
      expect(result.ok).toBe(true)
      expect(result.shards.get("self")).toBe(0)
    } finally {
      await cleanUp(directories)
    }
  })

  it("reports the own compacted shard to a fresh peer", async () => {
    const directories = await tempDirectories(2, "noonien-frontier-generation-")
    try {
      const self = directPeer("self", directories[0] ?? tmpdir())
      const log = new ShardLog(new FileBackend(directories[0] ?? tmpdir()), "self")
      await log.append([{ type: "entity.create", name: "E", entityType: "t" }])
      await log.compact()
      const summary = (await self.store.list()).find((shard) => shard.node === "self")
      expect(summary?.generation).toBeGreaterThan(0)
      const fresh = directPeer("fresh", directories[1] ?? tmpdir())
      const result = await syncWith(
        fresh.membership.self(),
        new DirectTransport(fresh),
        self.store,
        self.membership,
      )
      // The fresh peer is not a superseded generation, so it received the compacted
      // shard; its frontier must equal this node's durable high-water mark.
      expect(result.ok).toBe(true)
      expect(result.shards.get("self")).toBe(summary?.maxSeq)
    } finally {
      await cleanUp(directories)
    }
  })

  it("recovers the local shard from a peer that holds a more complete replica", async () => {
    const directories = await tempDirectories(2, "noonien-recover-")
    try {
      const self = directPeer("self", directories[0] ?? tmpdir())
      await new ShardLog(new FileBackend(directories[0] ?? tmpdir()), "self").append([
        { type: "entity.create", name: "First", entityType: "t" },
      ])
      // A peer holds a replica of self's own shard that also carries a second op.
      const holder = directPeer("holder", directories[1] ?? tmpdir())
      await new ShardLog(new FileBackend(directories[1] ?? tmpdir()), "self").append([
        { type: "entity.create", name: "First", entityType: "t" },
        { type: "entity.create", name: "Second", entityType: "t" },
      ])

      const result = await syncWith(
        holder.membership.self(),
        new DirectTransport(holder),
        self.store,
        self.membership,
      )
      expect(result.ok).toBe(true)
      expect(result.pulled).toBe(1)
      expect((await self.store.opsAfter("self", -1)).map((op) => op.seq)).toEqual([0, 1])
      expect(await self.store.maxSeq("self")).toBe(1)
    } finally {
      await cleanUp(directories)
    }
  })

  it("marks a peer suspect and dead when exchanges keep failing", async () => {
    const directories = await tempDirectories(1, "noonien-dead-")
    try {
      const peer = directPeer("self", directories[0] ?? tmpdir())
      const ghost: PeerEntry = { node: "ghost", address: "ghost:1", version: 1 }
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const result = await syncWith(
          ghost,
          new FailingTransport("ghost:1"),
          peer.store,
          peer.membership,
        )
        expect(result.ok).toBe(false)
      }
      expect(peer.membership.healthOf("ghost")).toBe("dead")
      expect(peer.membership.contactable()).toEqual([])
    } finally {
      await cleanUp(directories)
    }
  })

  it("keeps a peer alive when it answers but rejects the exchange", async () => {
    const directories = await tempDirectories(1, "noonien-reject-")
    try {
      const peer = directPeer("self", directories[0] ?? tmpdir())
      await new ShardLog(new FileBackend(directories[0] ?? tmpdir()), "self").append([
        { type: "entity.create", name: "Self", entityType: "t" },
      ])
      const ghost: PeerEntry = { node: "ghost", address: "ghost:1", version: 1 }
      const result = await syncWith(
        ghost,
        new RejectingTransport("ghost:1"),
        peer.store,
        peer.membership,
      )
      expect(result.ok).toBe(false)
      expect(result.error).toContain("rejected")
      // The peer answered, so it is reachable: the failure must not count.
      expect(peer.membership.healthOf("ghost")).toBe("alive")
      expect(peer.membership.contactable().map((entry) => entry.node)).toEqual(["ghost"])
    } finally {
      await cleanUp(directories)
    }
  })
  it("drops a peer whose address serves a different node", async () => {
    const directories = await tempDirectories(1, "noonien-impostor-")
    try {
      const peer = directPeer("self", directories[0] ?? tmpdir())
      const entry: PeerEntry = { node: "ghost", address: "ghost:1", version: 1 }
      peer.membership.merge([entry])
      const result = await syncWith(
        entry,
        new ImpostorTransport("ghost:1"),
        peer.store,
        peer.membership,
      )
      expect(result.ok).toBe(false)
      expect(peer.membership.known().map((known) => known.node)).toEqual(["self"])
    } finally {
      await cleanUp(directories)
    }
  })

  it("replaces a stale replica after the owner compacted", async () => {
    const directories = await tempDirectories(2, "noonien-gen-")
    try {
      const [aDir, bDir] = directories
      const bLog = new ShardLog(new FileBackend(bDir ?? tmpdir()), "b")
      await bLog.append([
        { type: "entity.create", name: "E", entityType: "t" },
        { type: "observation.add", entityName: "E", content: "x" },
      ])
      const beforeCompaction = await bLog.read()
      await bLog.compact()
      const a = directPeer("a", aDir ?? tmpdir())
      // A holds the pre-compaction replica (generation 0) of b's shard.
      await a.store.receive("b", beforeCompaction)
      const b = directPeer("b", bDir ?? tmpdir())
      const result = await syncWith(
        b.membership.self(),
        new DirectTransport(b),
        a.store,
        a.membership,
      )
      expect(result.ok).toBe(true)
      const summary = (await a.store.list()).find((shard) => shard.node === "b")
      expect(summary?.generation).toBe(1)
    } finally {
      await cleanUp(directories)
    }
  })

  it("converges through the digest path above the threshold", async () => {
    const directories = await tempDirectories(2, "noonien-digest-")
    try {
      const a = directPeer("a", directories[0] ?? tmpdir())
      const b = directPeer("b", directories[1] ?? tmpdir())
      await new ShardLog(new FileBackend(directories[0] ?? tmpdir()), "a").append([
        { type: "entity.create", name: "FromA", entityType: "t" },
      ])
      await new ShardLog(new FileBackend(directories[1] ?? tmpdir()), "b").append([
        { type: "entity.create", name: "FromB", entityType: "t" },
      ])
      let digestUsed = 0
      for (let round = 0; round < 2; round += 1) {
        await syncWith(b.membership.self(), new DirectTransport(b), a.store, a.membership, {
          digestMinShards: 1,
          onDigest: () => {
            digestUsed += 1
          },
        })
        await syncWith(a.membership.self(), new DirectTransport(a), b.store, b.membership, {
          digestMinShards: 1,
          onDigest: () => {
            digestUsed += 1
          },
        })
      }
      expect(digestUsed).toBe(4)
      const reference = foldOperations(await allOps(a))
      expect(foldOperations(await allOps(b))).toEqual(reference)
      expect(new Set((await allOps(a)).map((op) => op.id))).toEqual(
        new Set((await allOps(b)).map((op) => op.id)),
      )
    } finally {
      await cleanUp(directories)
    }
  })

  it("keeps the plain list for a peer that does not advertise the digest", async () => {
    const directories = await tempDirectories(2, "noonien-nodigest-")
    try {
      const a = directPeer("a", directories[0] ?? tmpdir())
      const b = directPeer("b", directories[1] ?? tmpdir())
      // A holds a shard, so its count is at the threshold and the code must
      // consult the capability rather than the shard count.
      await new ShardLog(new FileBackend(directories[0] ?? tmpdir()), "a").append([
        { type: "entity.create", name: "FromA", entityType: "t" },
      ])
      await new ShardLog(new FileBackend(directories[1] ?? tmpdir()), "b").append([
        { type: "entity.create", name: "FromB", entityType: "t" },
      ])
      // A transport without the capability rejects the digest, so a wrong call
      // would fail the sync: the list path must be used.
      const result = await syncWith(
        b.membership.self(),
        new NoDigestTransport(b),
        a.store,
        a.membership,
        { digestMinShards: 1 },
      )
      expect(result.ok).toBe(true)
      expect(await allOps(a)).toHaveLength(2)
    } finally {
      await cleanUp(directories)
    }
  })

  it("piggybacks the membership list, or skips it when the channels are split", async () => {
    const directories = await tempDirectories(2, "noonien-channels-")
    try {
      const a = directPeer("a", directories[0] ?? tmpdir())
      const b = directPeer("b", directories[1] ?? tmpdir())
      b.membership.merge([{ node: "c", address: "c:1", version: 1 }])
      await syncWith(b.membership.self(), new DirectTransport(b), a.store, a.membership, {
        membership: false,
      })
      expect(
        a.membership
          .known()
          .map((known) => known.node)
          .sort(),
      ).toEqual(["a", "b"])
      await syncWith(b.membership.self(), new DirectTransport(b), a.store, a.membership)
      expect(
        a.membership
          .known()
          .map((known) => known.node)
          .sort(),
      ).toEqual(["a", "b", "c"])
    } finally {
      await cleanUp(directories)
    }
  })

  it("gossips membership on its own channel", async () => {
    const directories = await tempDirectories(2, "noonien-memchan-")
    try {
      const a = directPeer("a", directories[0] ?? tmpdir())
      const b = directPeer("b", directories[1] ?? tmpdir())
      b.membership.merge([{ node: "c", address: "c:1", version: 1 }])
      const ok = await syncMembership(new DirectTransport(b), a.membership)
      expect(ok).toBe(true)
      expect(
        a.membership
          .known()
          .map((known) => known.node)
          .sort(),
      ).toEqual(["a", "b", "c"])
    } finally {
      await cleanUp(directories)
    }
  })

  it("propagates a compaction through a capped mesh within a round budget", async () => {
    const directories = await tempDirectories(5, "noonien-fanout-")
    try {
      const owner = new ShardLog(new FileBackend(directories[0] ?? tmpdir()), "o")
      await owner.append([
        { type: "entity.create", name: "E", entityType: "t" },
        { type: "observation.add", entityName: "E", content: "x" },
      ])
      const beforeCompaction = await owner.read()
      await owner.compact()
      const peers = directories.map((directory, index) =>
        directPeer(index === 0 ? "o" : `p${index}`, directory),
      )
      for (const peer of peers.slice(1)) {
        await peer.store.receive("o", beforeCompaction)
      }
      const random = seededRandom("fanout")
      for (let round = 0; round < 40; round += 1) {
        for (const peer of peers) {
          const target = selectPeers(
            peers.filter((other) => other !== peer),
            1,
            random,
          )[0]
          if (target !== undefined) {
            await syncWith(
              target.membership.self(),
              new DirectTransport(target),
              peer.store,
              peer.membership,
            )
          }
        }
      }
      for (const peer of peers.slice(1)) {
        const summary = (await peer.store.list()).find((shard) => shard.node === "o")
        expect(summary?.generation).toBe(1)
      }
    } finally {
      await cleanUp(directories)
    }
  })

  it("converges when only a subset of pairs reconciles each round", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(fc.integer({ min: 0, max: POOL.length - 1 }), { maxLength: 4 }), {
          minLength: 2,
          maxLength: 3,
        }),
        checkSubsetConvergence,
      ),
      { numRuns: 15 },
    )
  }, 30_000)

  it("keeps three nodes converging with snapshot replacement in a full round", async () => {
    const directories = await tempDirectories(3, "noonien-island-")
    try {
      const peers = directories.map((directory, index) => directPeer(`n${index}`, directory))
      const first = new ShardLog(new FileBackend(directories[0] ?? tmpdir()), "n0")
      const second = new ShardLog(new FileBackend(directories[1] ?? tmpdir()), "n1")
      const third = new ShardLog(new FileBackend(directories[2] ?? tmpdir()), "n2")
      await first.append([{ type: "entity.create", name: "From0", entityType: "t" }])
      await second.append([
        { type: "entity.create", name: "From1", entityType: "t" },
        { type: "observation.add", entityName: "From1", content: "x" },
      ])
      await third.append([{ type: "entity.create", name: "From2", entityType: "t" }])
      const beforeCompaction = await second.read()
      await second.compact()
      await requirePeer(peers, 0).store.receive("n1", beforeCompaction)
      await requirePeer(peers, 2).store.receive("n1", beforeCompaction)
      for (let round = 0; round < 2; round += 1) {
        await fullRound(peers)
      }
      const reference = foldOperations(await allOps(requirePeer(peers, 0)))
      for (const peer of peers) {
        const ops = await allOps(peer)
        expect(foldOperations(ops)).toEqual(reference)
        const summary = (await peer.store.list()).find((shard) => shard.node === "n1")
        expect(summary?.generation).toBe(1)
      }
    } finally {
      await cleanUp(directories)
    }
  })
})

/** A transport that advertises no capability and fails if the digest is called. */
class NoDigestTransport extends DirectTransport {
  override info(): Promise<PeerInfoDto> {
    return super.info().then((value) => ({ ...value, capabilities: [] }))
  }

  override digest(): Promise<DigestDto> {
    return Promise.reject(new Error("the digest must not be used without the capability"))
  }

  override digestBuckets(): Promise<ShardSummary[]> {
    return Promise.reject(new Error("the digest must not be used without the capability"))
  }
}

class FailingTransport implements PeerTransport {
  readonly address: string

  constructor(address: string) {
    this.address = address
  }

  info(): Promise<PeerInfoDto> {
    return Promise.reject(new UnreachableError("unreachable"))
  }

  membership(): Promise<PeerEntry[]> {
    return Promise.reject(new UnreachableError("unreachable"))
  }

  shards(): Promise<ShardSummary[]> {
    return Promise.reject(new UnreachableError("unreachable"))
  }

  digest(): Promise<DigestDto> {
    return Promise.reject(new UnreachableError("unreachable"))
  }

  digestBuckets(): Promise<ShardSummary[]> {
    return Promise.reject(new UnreachableError("unreachable"))
  }

  opsAfter(): Promise<Operation[]> {
    return Promise.reject(new UnreachableError("unreachable"))
  }

  pushOps(): Promise<void> {
    return Promise.reject(new UnreachableError("unreachable"))
  }
}

/** Answers discovery but identifies as a different node than the entry claimed. */
class ImpostorTransport implements PeerTransport {
  readonly address: string

  constructor(address: string) {
    this.address = address
  }

  info(): Promise<PeerInfoDto> {
    return Promise.resolve({
      node: "other",
      address: this.address,
      version: 1,
      protocol: PROTOCOL_VERSION,
      capabilities: [DIGEST_CAPABILITY],
    })
  }

  membership(): Promise<PeerEntry[]> {
    return Promise.resolve([])
  }

  shards(): Promise<ShardSummary[]> {
    return Promise.resolve([])
  }

  digest(): Promise<DigestDto> {
    return Promise.resolve(computeDigest([]))
  }

  digestBuckets(): Promise<ShardSummary[]> {
    return Promise.resolve([])
  }

  opsAfter(): Promise<Operation[]> {
    return Promise.resolve([])
  }

  pushOps(): Promise<void> {
    return Promise.resolve()
  }
}

/** Answers the discovery calls but rejects the push with an application error. */
class RejectingTransport implements PeerTransport {
  readonly address: string

  constructor(address: string) {
    this.address = address
  }

  info(): Promise<PeerInfoDto> {
    return Promise.resolve({
      node: "ghost",
      address: this.address,
      version: 1,
      protocol: PROTOCOL_VERSION,
      capabilities: [DIGEST_CAPABILITY],
    })
  }

  membership(): Promise<PeerEntry[]> {
    return Promise.resolve([])
  }

  shards(): Promise<ShardSummary[]> {
    return Promise.resolve([])
  }

  digest(): Promise<DigestDto> {
    return Promise.resolve(computeDigest([]))
  }

  digestBuckets(): Promise<ShardSummary[]> {
    return Promise.resolve([])
  }

  opsAfter(): Promise<Operation[]> {
    return Promise.resolve([])
  }

  pushOps(): Promise<void> {
    return Promise.reject(new Error("peer rejected the push"))
  }
}
