// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it } from "vitest"
import {
  Candidates,
  collectSeeds,
  parseSrvRecords,
  parseStaticPeers,
  parseTailscaleStatus,
} from "../../src/gossip/bootstrap.js"

describe("parseStaticPeers", () => {
  it("reads node-qualified and bare addresses", () => {
    expect(parseStaticPeers("ai@100.93.143.80:27878, z600:27878, mail", 27878)).toEqual([
      { node: "ai", address: "100.93.143.80:27878" },
      { node: undefined, address: "z600:27878" },
      { node: undefined, address: "mail:27878" },
    ])
  })

  it("ignores blank tokens and extra separators", () => {
    expect(parseStaticPeers(" a:1 ,, ", 27878)).toEqual([{ node: undefined, address: "a:1" }])
  })

  it("keeps a bracketed IPv6 address and appends a missing port", () => {
    expect(parseStaticPeers("[::1]:9000, [::2]", 27878)).toEqual([
      { node: undefined, address: "[::1]:9000" },
      { node: undefined, address: "[::2]:27878" },
    ])
  })

  it("brackets an unbracketed IPv6 address", () => {
    expect(parseStaticPeers("fe80::1", 27878)).toEqual([
      { node: undefined, address: "[fe80::1]:27878" },
    ])
  })

  it("replaces an out-of-range port with the default", () => {
    expect(parseStaticPeers("host:99999", 27878)).toEqual([
      { node: undefined, address: "host:27878" },
    ])
  })
})

describe("parseSrvRecords", () => {
  it("turns SRV records into address seeds", () => {
    expect(parseSrvRecords([{ name: "peer.example", port: 9000 }], 27878)).toEqual([
      { node: undefined, address: "peer.example:9000" },
    ])
  })

  it("falls back to the default port when the record has none", () => {
    expect(parseSrvRecords([{ name: "peer.example", port: 0 }], 27878)).toEqual([
      { node: undefined, address: "peer.example:27878" },
    ])
  })
})

describe("parseTailscaleStatus", () => {
  it("turns tailnet peers into address-only candidates", () => {
    const status = {
      Self: { HostName: "ai", TailscaleIPs: ["100.93.143.80"] },
      Peer: {
        a: { HostName: "z600", TailscaleIPs: ["100.91.199.87"] },
        b: { HostName: "phone", TailscaleIPs: ["100.106.79.30"] },
      },
    }
    // The host name is not a trusted node id: the peer is adopted only once it answers
    // `/info`, so a device that does not run `nooniend` is never given an entry.
    expect(parseTailscaleStatus(status, 27878)).toEqual([
      { node: undefined, address: "100.91.199.87:27878" },
      { node: undefined, address: "100.106.79.30:27878" },
    ])
  })

  it("brackets an IPv6-first tailnet address", () => {
    const status = {
      Peer: { a: { HostName: "z600", TailscaleIPs: ["fd7a:115c:a1e0::1", "100.91.199.87"] } },
    }
    expect(parseTailscaleStatus(status, 27878)).toEqual([
      { node: undefined, address: "[fd7a:115c:a1e0::1]:27878" },
    ])
  })

  it("skips peers without an address", () => {
    const status = { Peer: { a: { HostName: "x" }, b: { TailscaleIPs: ["1.2.3.4"] } } }
    expect(parseTailscaleStatus(status, 27878)).toEqual([
      { node: undefined, address: "1.2.3.4:27878" },
    ])
  })

  it("returns nothing for an unexpected document", () => {
    expect(parseTailscaleStatus(null, 27878)).toEqual([])
    expect(parseTailscaleStatus({}, 27878)).toEqual([])
  })
})

describe("Candidates", () => {
  it("keeps an answered candidate out and the others pending", () => {
    const candidates = new Candidates(30_000, 300_000)
    candidates.add(["a:1", "b:2"])
    expect(candidates.size).toBe(2)
    candidates.adopted("a:1")
    expect(candidates.size).toBe(1)
    expect(candidates.due(0)).toEqual(["b:2"])
  })

  it("backs a failing candidate off exponentially up to the cap", () => {
    const candidates = new Candidates(30_000, 120_000)
    candidates.add(["a:1"])
    candidates.failed("a:1", 0)
    expect(candidates.due(29_999)).toEqual([])
    expect(candidates.due(30_000)).toEqual(["a:1"])
    candidates.failed("a:1", 30_000)
    expect(candidates.due(89_999)).toEqual([])
    expect(candidates.due(90_000)).toEqual(["a:1"])
    candidates.failed("a:1", 90_000)
    candidates.failed("a:1", 210_000)
    expect(candidates.due(329_999)).toEqual([])
    expect(candidates.due(330_000)).toEqual(["a:1"])
  })

  it("never re-adds an adopted address", () => {
    const candidates = new Candidates(30_000, 300_000)
    candidates.add(["a:1"])
    candidates.adopted("a:1")
    candidates.add(["a:1"])
    expect(candidates.size).toBe(0)
  })
})

describe("collectSeeds", () => {
  it("returns the static seeds and dedupes by address, keeping the node id", async () => {
    const seeds = await collectSeeds({
      staticPeers: "ai@a:1, a:1",
      dnsSrvDomain: undefined,
      tailscale: false,
      port: 27878,
    })
    expect(seeds).toEqual([{ node: "ai", address: "a:1" }])
  })

  it("returns nothing when no adapter is enabled", async () => {
    expect(
      await collectSeeds({
        staticPeers: undefined,
        dnsSrvDomain: undefined,
        tailscale: false,
        port: 27878,
      }),
    ).toEqual([])
  })

  it("does not fail when the DNS adapter cannot resolve", async () => {
    const seeds = await collectSeeds({
      staticPeers: "ai@a:1",
      dnsSrvDomain: "invalid.invalid",
      tailscale: false,
      port: 27878,
    })
    expect(seeds).toEqual([{ node: "ai", address: "a:1" }])
  })
})
