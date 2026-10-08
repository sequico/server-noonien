// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it } from "vitest"
import { MAX_PEERS, Membership } from "../../src/gossip/membership.js"

const DEAD_RETRY_MS = 1000
const MEMBERSHIP_TTL_MS = 2000

function membership(): Membership {
  return new Membership({
    self: { node: "self", address: "self:7878", version: 100 },
    suspectAfter: 2,
    deadAfter: 3,
    deadRetryMs: DEAD_RETRY_MS,
    membershipTtlMs: MEMBERSHIP_TTL_MS,
  })
}

function kill(set: Membership, node: string, now: number): void {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    set.recordFailure(node, now)
  }
}

describe("Membership", () => {
  it("starts with only the local node, alive", () => {
    const set = membership()
    expect(set.known().map((entry) => entry.node)).toEqual(["self"])
    expect(set.contactable()).toEqual([])
    expect(set.healthOf("self")).toBe("alive")
  })

  it("merges remote entries and keeps the greatest version per node", () => {
    const set = membership()
    set.merge([{ node: "peer", address: "old:1", version: 1 }])
    set.merge([{ node: "peer", address: "new:2", version: 2 }])
    set.merge([{ node: "peer", address: "stale:3", version: 1 }])
    expect(set.known().find((entry) => entry.node === "peer")).toEqual({
      node: "peer",
      address: "new:2",
      version: 2,
    })
  })

  it("never lets a remote entry override the local node", () => {
    const set = membership()
    set.merge([{ node: "self", address: "attacker:1", version: 999 }])
    expect(set.self()).toEqual({ node: "self", address: "self:7878", version: 100 })
  })

  it("marks a peer suspect, then dead, after consecutive failures", () => {
    const set = membership()
    set.merge([{ node: "peer", address: "peer:1", version: 1 }])
    set.recordFailure("peer", 1000)
    expect(set.healthOf("peer")).toBe("alive")
    set.recordFailure("peer", 1000)
    expect(set.healthOf("peer")).toBe("suspect")
    set.recordFailure("peer", 1000)
    expect(set.healthOf("peer")).toBe("dead")
    expect(set.contactable(1000)).toEqual([])
  })

  it("probes a dead peer again after its backoff, never making the verdict final", () => {
    const set = membership()
    set.merge([{ node: "peer", address: "peer:1", version: 1 }])
    kill(set, "peer", 1000)
    expect(set.contactable(1000)).toEqual([])
    expect(set.contactable(1000 + DEAD_RETRY_MS - 1)).toEqual([])
    expect(set.contactable(1000 + DEAD_RETRY_MS).map((entry) => entry.node)).toEqual(["peer"])
  })

  it("revives a dead peer when it advertises a newer version", () => {
    const set = membership()
    set.merge([{ node: "peer", address: "peer:1", version: 1 }])
    kill(set, "peer", 1000)
    expect(set.healthOf("peer")).toBe("dead")
    set.merge([{ node: "peer", address: "peer:1", version: 2 }])
    expect(set.healthOf("peer")).toBe("alive")
    expect(set.contactable(1000).map((entry) => entry.node)).toEqual(["peer"])
  })

  it("resets a peer to alive on any success", () => {
    const set = membership()
    set.merge([{ node: "peer", address: "peer:1", version: 1 }])
    kill(set, "peer", 1000)
    expect(set.healthOf("peer")).toBe("dead")
    set.recordSuccess("peer")
    expect(set.healthOf("peer")).toBe("alive")
    expect(set.contactable().map((entry) => entry.node)).toEqual(["peer"])
  })

  it("revives a dead peer that reaches us, keeping its stored address", () => {
    const set = membership()
    set.merge([{ node: "peer", address: "peer:1", version: 5 }])
    kill(set, "peer", 1000)
    expect(set.healthOf("peer")).toBe("dead")
    set.touch("peer", 5, 1000)
    expect(set.healthOf("peer")).toBe("alive")
    expect(set.contactable(1000).map((entry) => entry.node)).toEqual(["peer"])
    expect(set.known().find((entry) => entry.node === "peer")?.address).toBe("peer:1")
  })

  it("refreshes the stored version when the peer announces a newer one", () => {
    const set = membership()
    set.merge([{ node: "peer", address: "peer:1", version: 1 }])
    kill(set, "peer", 1000)
    set.touch("peer", 9, 1000)
    expect(set.healthOf("peer")).toBe("alive")
    expect(set.known().find((entry) => entry.node === "peer")?.version).toBe(9)
  })

  it("ignores an announced peer it does not know", () => {
    const set = membership()
    set.touch("ghost", 1)
    expect(set.known().map((entry) => entry.node)).toEqual(["self"])
  })

  it("learns a peer it does not know and revives a known one", () => {
    const set = membership()
    set.learn({ node: "peer", address: "peer:1", version: 5 }, 1000)
    expect(set.known().find((entry) => entry.node === "peer")?.address).toBe("peer:1")
    expect(set.healthOf("peer")).toBe("alive")
    expect(set.contactable(1000).map((entry) => entry.node)).toEqual(["peer"])
  })

  it("ignores a learned entry for the local node", () => {
    const set = membership()
    set.learn({ node: "self", address: "evil:1", version: 9 })
    expect(set.known().map((entry) => entry.node)).toEqual(["self"])
    expect(set.known()[0]?.address).toBe("self:7878")
  })

  it("forgets a dead peer past the TTL, ignoring its stale gossip", () => {
    const set = membership()
    set.merge([{ node: "peer", address: "peer:1", version: 1 }])
    kill(set, "peer", Date.now())
    expect(set.prune(Date.now() + MEMBERSHIP_TTL_MS + 1)).toBe(1)
    expect(set.known().map((entry) => entry.node)).toEqual(["self"])
    // The old entry still circulating in others' gossip cannot re-add it...
    set.merge([{ node: "peer", address: "peer:1", version: 1 }])
    expect(set.known().map((entry) => entry.node)).toEqual(["self"])
    // ...but a restart with a newer version brings it back.
    set.merge([{ node: "peer", address: "peer:1", version: 2 }])
    expect(set.known().map((entry) => entry.node)).toEqual(["self", "peer"])
  })

  it("still counts a forgotten peer among the nodes that block collection", () => {
    const set = membership()
    set.merge([{ node: "peer", address: "peer:1", version: 1 }])
    kill(set, "peer", Date.now())
    expect(set.prune(Date.now() + MEMBERSHIP_TTL_MS + 1)).toBe(1)
    // Forgotten: out of the peer set, but its unseen writes may still exist.
    expect(set.known().map((entry) => entry.node)).toEqual(["self"])
    expect(set.retainedNodes()).toEqual(["peer"])
  })

  it("does not retain the local node", () => {
    expect(membership().retainedNodes()).toEqual([])
  })

  it("keeps a live peer and a recently appeared dead one", () => {
    const set = membership()
    set.merge([{ node: "alive", address: "alive:1", version: 1 }])
    set.merge([{ node: "dead", address: "dead:1", version: 1 }])
    kill(set, "dead", Date.now())
    expect(set.prune(Date.now() + MEMBERSHIP_TTL_MS + 1)).toBe(1)
    expect(set.known().map((entry) => entry.node)).toEqual(["self", "alive"])
  })

  it("does not let gossip override a node verified from its own /info", () => {
    const set = membership()
    set.merge([{ node: "peer", address: "peer:1", version: 1 }], true)
    set.merge([{ node: "peer", address: "attacker:9", version: 999 }])
    expect(set.known().find((entry) => entry.node === "peer")).toEqual({
      node: "peer",
      address: "peer:1",
      version: 1,
    })
  })

  it("drops a peer whose address does not serve the claimed node", () => {
    const set = membership()
    set.merge([{ node: "peer", address: "peer:1", version: 1 }])
    set.drop("peer")
    expect(set.known().map((entry) => entry.node)).toEqual(["self"])
    expect(set.contactable()).toEqual([])
  })

  it("re-adopts a forgotten node when it is configured as a seed", () => {
    const set = membership()
    set.merge([{ node: "peer", address: "peer:1", version: 1 }])
    kill(set, "peer", Date.now())
    expect(set.prune(Date.now() + MEMBERSHIP_TTL_MS + 1)).toBe(1)
    expect(set.known().map((entry) => entry.node)).toEqual(["self"])
    set.seed([{ node: "peer", address: "peer:1", version: 0 }])
    expect(set.known().map((entry) => entry.node)).toEqual(["self", "peer"])
  })

  it("ignores a peer whose address is not a plain host:port", () => {
    const set = membership()
    set.merge([{ node: "with-path", address: "evil.com:80/path", version: 1 }])
    set.merge([{ node: "with-userinfo", address: "user@host:1", version: 1 }])
    set.merge([{ node: "no-port", address: "host", version: 1 }])
    set.merge([{ node: "port-zero", address: "host:0", version: 1 }])
    expect(set.known().map((entry) => entry.node)).toEqual(["self"])
    // A valid entry for the same node is still adopted afterwards.
    set.merge([{ node: "with-path", address: "evil.com:80", version: 2 }])
    expect(set.known().map((entry) => entry.node)).toEqual(["self", "with-path"])
  })

  it("ignores a peer whose node id is not path-safe", () => {
    const set = membership()
    set.merge([{ node: "../evil", address: "evil:1", version: 1 }])
    set.merge([{ node: "a/b", address: "evil:1", version: 1 }])
    set.learn({ node: "a..b", address: "evil:1", version: 1 })
    set.seed([{ node: "with\nnewline", address: "evil:1", version: 1 }])
    expect(set.known().map((entry) => entry.node)).toEqual(["self"])
  })

  it("caps the peer set so a hostile peer cannot grow it without bound", () => {
    const set = membership()
    for (let index = 0; index < MAX_PEERS + 1_000; index += 1) {
      set.merge([{ node: `peer-${index}`, address: `host-${index}:1`, version: 1 }])
    }
    // The peer set (local node included) is bounded; the overflow is dropped.
    expect(set.known().length).toBe(MAX_PEERS)
  })
})
