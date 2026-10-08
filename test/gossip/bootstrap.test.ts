// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it } from "vitest"
import {
  collectSeeds,
  parseSrvRecords,
  parseStaticPeers,
  parseTailscaleStatus,
} from "../../src/gossip/bootstrap.js"

describe("parseStaticPeers", () => {
  it("reads node-qualified and bare addresses", () => {
    expect(parseStaticPeers("ai@100.93.143.80:7878, z600:7878, mail", 7878)).toEqual([
      { node: "ai", address: "100.93.143.80:7878" },
      { node: undefined, address: "z600:7878" },
      { node: undefined, address: "mail:7878" },
    ])
  })

  it("ignores blank tokens and extra separators", () => {
    expect(parseStaticPeers(" a:1 ,, ", 7878)).toEqual([{ node: undefined, address: "a:1" }])
  })

  it("keeps a bracketed IPv6 address and appends a missing port", () => {
    expect(parseStaticPeers("[::1]:9000, [::2]", 7878)).toEqual([
      { node: undefined, address: "[::1]:9000" },
      { node: undefined, address: "[::2]:7878" },
    ])
  })

  it("brackets an unbracketed IPv6 address", () => {
    expect(parseStaticPeers("fe80::1", 7878)).toEqual([
      { node: undefined, address: "[fe80::1]:7878" },
    ])
  })

  it("replaces an out-of-range port with the default", () => {
    expect(parseStaticPeers("host:99999", 7878)).toEqual([
      { node: undefined, address: "host:7878" },
    ])
  })
})

describe("parseSrvRecords", () => {
  it("turns SRV records into address seeds", () => {
    expect(parseSrvRecords([{ name: "peer.example", port: 9000 }], 7878)).toEqual([
      { node: undefined, address: "peer.example:9000" },
    ])
  })

  it("falls back to the default port when the record has none", () => {
    expect(parseSrvRecords([{ name: "peer.example", port: 0 }], 7878)).toEqual([
      { node: undefined, address: "peer.example:7878" },
    ])
  })
})

describe("parseTailscaleStatus", () => {
  it("turns tailnet peers into node-qualified seeds", () => {
    const status = {
      Self: { HostName: "ai", TailscaleIPs: ["100.93.143.80"] },
      Peer: {
        a: { HostName: "z600", TailscaleIPs: ["100.91.199.87"] },
        b: { HostName: "mail-greensley", TailscaleIPs: ["100.106.79.30"] },
      },
    }
    expect(parseTailscaleStatus(status, 7878)).toEqual([
      { node: "z600", address: "100.91.199.87:7878" },
      { node: "mail-greensley", address: "100.106.79.30:7878" },
    ])
  })

  it("brackets an IPv6-first tailnet address", () => {
    const status = {
      Peer: { a: { HostName: "z600", TailscaleIPs: ["fd7a:115c:a1e0::1", "100.91.199.87"] } },
    }
    expect(parseTailscaleStatus(status, 7878)).toEqual([
      { node: "z600", address: "[fd7a:115c:a1e0::1]:7878" },
    ])
  })

  it("skips peers without a hostname or an address", () => {
    const status = { Peer: { a: { HostName: "x" }, b: { TailscaleIPs: ["1.2.3.4"] } } }
    expect(parseTailscaleStatus(status, 7878)).toEqual([])
  })

  it("returns nothing for an unexpected document", () => {
    expect(parseTailscaleStatus(null, 7878)).toEqual([])
    expect(parseTailscaleStatus({}, 7878)).toEqual([])
  })
})

describe("collectSeeds", () => {
  it("returns the static seeds and dedupes by address, keeping the node id", async () => {
    const seeds = await collectSeeds({
      staticPeers: "ai@a:1, a:1",
      dnsSrvDomain: undefined,
      tailscale: false,
      port: 7878,
    })
    expect(seeds).toEqual([{ node: "ai", address: "a:1" }])
  })

  it("returns nothing when no adapter is enabled", async () => {
    expect(
      await collectSeeds({
        staticPeers: undefined,
        dnsSrvDomain: undefined,
        tailscale: false,
        port: 7878,
      }),
    ).toEqual([])
  })

  it("does not fail when the DNS adapter cannot resolve", async () => {
    const seeds = await collectSeeds({
      staticPeers: "ai@a:1",
      dnsSrvDomain: "invalid.invalid",
      tailscale: false,
      port: 7878,
    })
    expect(seeds).toEqual([{ node: "ai", address: "a:1" }])
  })
})
