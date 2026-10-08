// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { exceedsLocal, type Frontier, withoutForfeited } from "../../src/gossip/collection.js"
import { retireSilentPeers } from "../../src/gossip/daemon.js"
import { PeerKnowledge } from "../../src/gossip/knowledge.js"
import { testMembership } from "../support/gossip.js"
import { createTempDirectory } from "../support/tmp.js"

const WINDOW_MS = 60_000

/** A knowledge record in a fresh temporary directory, plus a membership holding a peer. */
async function fixture(peer: string): Promise<{
  knowledge: PeerKnowledge
  membership: ReturnType<typeof testMembership>
}> {
  const directory = await createTempDirectory("noonien-retire-")
  const knowledge = await PeerKnowledge.load(join(directory, ".nooniend-peers.json"))
  const membership = testMembership("self", "self:1")
  membership.merge([{ node: peer, address: `${peer}:1`, version: 1 }])
  return { knowledge, membership }
}

describe("retireSilentPeers", () => {
  it("merges an accounted peer's frontier and stops tracking it", async () => {
    const { knowledge, membership } = await fixture("gone")
    knowledge.record("gone", new Map([["self", 0]]), 0)
    retireSilentPeers({
      knowledge,
      membership,
      local: new Map([["self", 3]]),
      now: WINDOW_MS,
      forgetAfterMs: WINDOW_MS,
      forfeited: new Set(),
    })
    // The peer stops being a live participant (no record, no absent-peer metric), but
    // the thresholds it set remain, so the elements it could contest stay guarded.
    expect(knowledge.nodes()).toEqual([])
    expect(knowledge.retiredFrontier()).toEqual(new Map([["self", 0]]))
    expect(knowledge.blanketCount()).toBe(0)
    // Membership must not keep it either: the gate unions membership with the
    // knowledge, so a leftover entry would read as a peer never reached — a blanket
    // over every element instead of the elements this one could contest.
    expect(membership.retainedNodes()).not.toContain("gone")
  })

  it("merges a peer whose frontier names only a forfeited author beyond ours", async () => {
    const { knowledge, membership } = await fixture("gone")
    // The peer holds the replica of a node the operator has forfeited. Without dropping
    // that author it would look unaccounted for, and its blanket would freeze the mesh for
    // ever — exactly the block `NOONIEND_DEPARTED` was meant to lift.
    knowledge.record(
      "gone",
      new Map([
        ["self", 0],
        ["ghost", 9],
      ]),
      0,
    )
    retireSilentPeers({
      knowledge,
      membership,
      local: new Map([["self", 3]]),
      now: WINDOW_MS,
      forgetAfterMs: WINDOW_MS,
      forfeited: new Set(["ghost"]),
    })
    expect(knowledge.retiredFrontier()).toEqual(new Map([["self", 0]]))
    expect(knowledge.blanketCount()).toBe(0)
  })

  it("gives an unaccounted peer a blanket rather than an unverifiable frontier", async () => {
    const { knowledge, membership } = await fixture("gone")
    // It claims operations of an author this node never received, so its frontier
    // cannot be read as a subset and cannot be merged: the gate's "could hold
    // anything" is preserved as a blanket instead.
    knowledge.record("gone", new Map([["other", 9]]), 0)
    retireSilentPeers({
      knowledge,
      membership,
      local: new Map([["self", 3]]),
      now: WINDOW_MS,
      forgetAfterMs: WINDOW_MS,
      forfeited: new Set(),
    })
    expect(knowledge.retiredFrontier().size).toBe(0)
    expect(knowledge.blanketCount()).toBe(1)
    expect(knowledge.nodes()).toEqual([])
  })

  it("leaves a peer inside the window alone", async () => {
    const { knowledge, membership } = await fixture("fresh")
    knowledge.record("fresh", new Map([["self", 0]]), 0)
    retireSilentPeers({
      knowledge,
      membership,
      local: new Map([["self", 3]]),
      now: WINDOW_MS - 1,
      forgetAfterMs: WINDOW_MS,
      forfeited: new Set(),
    })
    expect(knowledge.nodes()).toEqual(["fresh"])
    expect(knowledge.retiredFrontier().size).toBe(0)
  })

  it("never retires when the window is disabled", async () => {
    const { knowledge, membership } = await fixture("gone")
    knowledge.record("gone", new Map([["self", 0]]), 0)
    retireSilentPeers({
      knowledge,
      membership,
      local: new Map([["self", 3]]),
      now: Number.MAX_SAFE_INTEGER,
      forgetAfterMs: 0,
      forfeited: new Set(),
    })
    expect(knowledge.nodes()).toEqual(["gone"])
  })

  it("leaves a peer with no record alone", async () => {
    // Never reached: there is nothing to materialise, and a claimed-but-unreachable
    // node stays the conservative blank it has always been (see collection-retention.md).
    const { knowledge, membership } = await fixture("claimed")
    retireSilentPeers({
      knowledge,
      membership,
      local: new Map(),
      now: Number.MAX_SAFE_INTEGER,
      forgetAfterMs: WINDOW_MS,
      forfeited: new Set(),
    })
    expect(membership.retainedNodes()).toContain("claimed")
  })
})

describe("withoutForfeited", () => {
  it("drops the authors whose writes are forfeited, and only them", () => {
    const frontier: Frontier = new Map([
      ["a", 3],
      ["ghost", 9],
    ])
    // A forfeited node can never deliver an operation again — it is refused on every
    // route and its shard is not pulled — so leaving its entry in place would only read
    // as "holds something we lack": the blanket that blocks the very collection the
    // operator asked to unblock.
    expect(withoutForfeited(frontier, new Set(["ghost"]))).toEqual(new Map([["a", 3]]))
    // Untouched frontiers are returned as they are (no copy on the common path).
    expect(withoutForfeited(frontier, new Set())).toBe(frontier)
    expect(withoutForfeited(frontier, new Set(["other"]))).toBe(frontier)
  })
})

describe("exceedsLocal", () => {
  const local: Frontier = new Map([
    ["a", 2],
    ["b", 0],
  ])

  it("is false for a frontier within the local marks, including an unknown author", () => {
    expect(exceedsLocal(new Map([["a", 2]]), local)).toBe(false)
    expect(
      exceedsLocal(
        new Map([
          ["a", 1],
          ["b", 0],
        ]),
        local,
      ),
    ).toBe(false)
    // -1 means "holds nothing of that author", which is always within the marks.
    expect(exceedsLocal(new Map([["c", -1]]), local)).toBe(false)
  })

  it("is true when the peer claims anything the local node lacks", () => {
    expect(exceedsLocal(new Map([["a", 3]]), local)).toBe(true)
    // An author the local node does not hold at all: it could be a genuine shard not
    // pulled yet, or a lie — either way the holdings are not readable as a subset.
    expect(exceedsLocal(new Map([["c", 0]]), local)).toBe(true)
  })
})
