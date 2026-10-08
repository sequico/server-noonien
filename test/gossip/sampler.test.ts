// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it } from "vitest"
import { seededRandom, selectPeers } from "../../src/gossip/sampler.js"
import type { PeerEntry } from "../../src/gossip/types.js"

function peers(count: number): PeerEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    node: `n${index}`,
    address: `n${index}:1`,
    version: 1,
  }))
}

describe("seededRandom", () => {
  it("is deterministic for the same seed", () => {
    const first = seededRandom("node")
    const second = seededRandom("node")
    expect([first(), first(), first()]).toEqual([second(), second(), second()])
  })

  it("differs across seeds", () => {
    const first = seededRandom("a")
    const second = seededRandom("b")
    expect([first(), first(), first()]).not.toEqual([second(), second(), second()])
  })

  it("draws in [0, 1)", () => {
    const random = seededRandom("range")
    for (let draw = 0; draw < 200; draw += 1) {
      const value = random()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })
})

describe("selectPeers", () => {
  it("returns every peer when the fanout is zero or at least the peer count", () => {
    const all = peers(5)
    expect(selectPeers(all, 0, seededRandom("x"))).toEqual(all)
    expect(selectPeers(all, 5, seededRandom("x"))).toEqual(all)
    expect(selectPeers(all, 99, seededRandom("x"))).toEqual(all)
  })

  it("returns exactly the fanout, without duplicates", () => {
    const sample = selectPeers(peers(100), 8, seededRandom("node"))
    expect(sample).toHaveLength(8)
    expect(new Set(sample.map((peer) => peer.node)).size).toBe(8)
  })

  it("always includes a configured relay", () => {
    const all = peers(50)
    const relay = new Set(["n7"])
    for (let round = 0; round < 20; round += 1) {
      const sample = selectPeers(all, 4, seededRandom(`seed-${round}`), relay)
      expect(sample.map((peer) => peer.node)).toContain("n7")
    }
  })

  it("samples every peer over a stream of rounds", () => {
    const all = peers(20)
    const random = seededRandom("drift")
    const seen = new Set<string>()
    for (let round = 0; round < 200; round += 1) {
      for (const peer of selectPeers(all, 2, random)) {
        seen.add(peer.node)
      }
    }
    expect(seen.size).toBe(all.length)
  })

  it("is empty when there are no peers", () => {
    expect(selectPeers([], 4, seededRandom("x"))).toEqual([])
  })
})
