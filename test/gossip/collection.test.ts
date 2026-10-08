// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
  collectable,
  type Frontier,
  meshState,
  retainedPeers,
} from "../../src/gossip/collection.js"
import { materialize } from "../support/operations.js"

describe("retainedPeers", () => {
  it("unions the membership's peers with every peer ever reached", () => {
    expect(retainedPeers(["a", "b"], ["b", "c"]).sort()).toEqual(["a", "b", "c"])
  })

  it("keeps a peer membership dropped but once reached", () => {
    // Membership.drop removes an entry without forgetting it, so the knowledge
    // record is the only thing that still gates a deletion.
    expect(retainedPeers([], ["gone"])).toEqual(["gone"])
  })
})

describe("meshState", () => {
  it("has no blockers when every peer was exchanged with", () => {
    const local = new Map([["a", 1]])
    const state = meshState({
      pending: [],
      reachable: () => true,
      frontier: () => undefined,
      retired: new Map(),
      blanket: false,
      local,
    })
    expect(state).toEqual({ suspended: false, peers: [new Map()], local })
  })

  it("records an off-mesh peer's frontier", () => {
    const frontier = new Map([["a", 3]])
    const local = new Map([["a", 3]])
    const state = meshState({
      pending: ["a"],
      reachable: () => false,
      frontier: () => frontier,
      retired: new Map(),
      blanket: false,
      local,
    })
    expect(state).toEqual({ suspended: false, peers: [frontier, new Map()], local })
  })

  it("suspends when a pending peer is still reachable", () => {
    const local = new Map([["a", 1]])
    const state = meshState({
      pending: ["a"],
      reachable: () => true,
      frontier: () => undefined,
      retired: new Map(),
      blanket: false,
      local,
    })
    expect(state).toEqual({ suspended: true, peers: [], local })
  })

  it("carries the retired frontier and a durable blanket into the gate", () => {
    // Retirement must not change what the gate decides: the thresholds arrive as one
    // more frontier, and a blanket arrives as the "could hold anything" the gate
    // already reads from a peer never reached.
    const local = new Map([["a", 1]])
    const retired = new Map([["a", 1]])
    const base = { pending: [], reachable: () => true, frontier: () => undefined, local }
    expect(meshState({ ...base, retired, blanket: false })).toEqual({
      suspended: false,
      peers: [retired],
      local,
    })
    expect(meshState({ ...base, retired, blanket: true })).toEqual({
      suspended: false,
      peers: [retired, undefined],
      local,
    })
  })
})

describe("collectable", () => {
  const ops = materialize(
    [
      { type: "entity.create", name: "E", entityType: "t" },
      { type: "entity.delete", name: "E" },
    ],
    "a",
  )
  const none = new Map<string, number>()

  it("is false while the collection is suspended", () => {
    expect(collectable({ suspended: true, peers: [], local: none }, ops)).toBe(false)
  })

  it("is true with no off-mesh peers", () => {
    expect(collectable({ suspended: false, peers: [], local: none }, ops)).toBe(true)
  })

  it("blocks every element for a peer never reached", () => {
    expect(collectable({ suspended: false, peers: [undefined], local: none }, ops)).toBe(false)
  })

  it("blocks an element a peer's frontier covers", () => {
    expect(
      collectable(
        { suspended: false, peers: [new Map([["a", 0]])], local: new Map([["a", 0]]) },
        ops,
      ),
    ).toBe(false)
  })

  it("clears an element no frontier covers when the peer holds nothing extra", () => {
    // The peer holds only a subset of the local view and nothing of author "a": it
    // can never have known the element.
    const local = new Map([
      ["a", -1],
      ["b", 5],
    ])
    expect(collectable({ suspended: false, peers: [new Map([["b", 5]])], local }, ops)).toBe(true)
    expect(collectable({ suspended: false, peers: [new Map([["a", -1]])], local }, ops)).toBe(true)
  })

  it("blocks when a peer holds anything the local node lacks", () => {
    // A peer that has operations of author "c" the local node never received could
    // hold a relayed operation on the element: its frontier is not readable as a
    // subset, so it blocks instead of collecting.
    expect(collectable({ suspended: false, peers: [new Map([["c", 3]])], local: none }, ops)).toBe(
      false,
    )
  })
})

describe("retirement keeps the decisions", () => {
  const local = new Map([
    ["a", 9],
    ["b", 9],
  ])

  const frontierArb = fc
    .array(fc.tuple(fc.constantFrom("a", "b", "c", "d"), fc.integer({ min: -1, max: 9 })), {
      maxLength: 4,
    })
    .map((entries) => new Map(entries) as Frontier)

  /** The elementwise maximum per author: exactly what `PeerKnowledge.retire` folds. */
  function merged(frontiers: readonly Frontier[]): Frontier {
    const maximum = new Map<string, number>()
    for (const frontier of frontiers) {
      for (const [author, seq] of frontier) {
        maximum.set(author, Math.max(maximum.get(author) ?? -1, seq))
      }
    }
    return maximum
  }

  it("decides an element exactly as the peers it came from would", () => {
    // The central claim of the retention policy: merging the peers' frontiers changes
    // where the thresholds live, never which elements are guarded — the maximum is the
    // union of "some frontier covers this operation".
    const ops = materialize(
      [
        { type: "entity.create", name: "E", entityType: "t" },
        { type: "entity.delete", name: "E" },
      ],
      "a",
    )
    fc.assert(
      fc.property(frontierArb, frontierArb, (one, two) => {
        const separated = collectable({ suspended: false, peers: [one, two], local }, ops)
        const retiredNow = collectable(
          { suspended: false, peers: [merged([one, two])], local },
          ops,
        )
        expect(retiredNow).toBe(separated)
      }),
    )
  })

  it("freezes an element deleted after the peers were retired", () => {
    // The case a per-element pin computed at expiry would miss: the peer is already
    // retired when the element is deleted. The retained threshold still covers the
    // creation, so the tombstone is not collectable — a returning peer's *older* add
    // stays beaten. (A newer add wins the fold whatever we keep: that is LWW, not a
    // collection decision.)
    const created = materialize([{ type: "entity.create", name: "E", entityType: "t" }], "a")
    const deleted = materialize([{ type: "entity.delete", name: "E" }], "a", 1)
    const ops = [...created, ...deleted]
    const retired = new Map([["a", 0]])
    expect(collectable({ suspended: false, peers: [retired], local }, ops)).toBe(false)
    expect(collectable({ suspended: false, peers: [], local }, ops)).toBe(true)
  })
})
