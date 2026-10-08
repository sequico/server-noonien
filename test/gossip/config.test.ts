// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { hostname } from "node:os"
import { describe, expect, it } from "vitest"
import { formatHostPort, parseHostPort } from "../../src/gossip/address.js"
import { DEFAULT_GOSSIP_PORT, loadGossipConfig } from "../../src/gossip/config.js"

describe("loadGossipConfig", () => {
  it("binds the wildcard port and advertises the hostname by default", () => {
    const config = loadGossipConfig({})
    expect(config.listenHost).toBe("0.0.0.0")
    expect(config.listenPort).toBe(DEFAULT_GOSSIP_PORT)
    expect(config.advertise).toBe(`${hostname()}:${DEFAULT_GOSSIP_PORT}`)
    expect(config.intervalMs).toBe(30_000)
    expect(config.suspectAfter).toBe(3)
    expect(config.deadAfter).toBe(6)
    expect(config.deadRetryMs).toBe(300_000)
    expect(config.membershipTtlMs).toBe(604_800_000)
    // The retention window defaults to 180 days: long enough to mean "gone", short
    // enough that the durable metadata a collection depends on stays bounded.
    expect(config.forgetAfterMs).toBe(15_552_000_000)
    expect(config.push).toBe(true)
    expect(config.tls).toBeUndefined()
  })

  it("advertises an explicit listen address when one is configured", () => {
    const config = loadGossipConfig({ NOONIEND_LISTEN: "10.0.0.1:9000" })
    expect(config.listenHost).toBe("10.0.0.1")
    expect(config.listenPort).toBe(9000)
    expect(config.advertise).toBe("10.0.0.1:9000")
  })

  it("reads a bare listen port against the default host", () => {
    const config = loadGossipConfig({ NOONIEND_LISTEN: "9001" })
    expect(config.listenHost).toBe("0.0.0.0")
    expect(config.listenPort).toBe(9001)
  })

  it("honours an explicit advertise address and the bootstrap options", () => {
    const config = loadGossipConfig({
      NOONIEND_ADVERTISE: "peer.example:1234",
      NOONIEND_PEERS: "a@host:1",
      NOONIEND_DNS_SRV: "example.com",
      NOONIEND_TAILSCALE: "true",
    })
    expect(config.advertise).toBe("peer.example:1234")
    expect(config.staticPeers).toBe("a@host:1")
    expect(config.dnsSrvDomain).toBe("example.com")
    expect(config.tailscale).toBe(true)
  })

  it("converts the anti-entropy interval from seconds to milliseconds", () => {
    expect(loadGossipConfig({ NOONIEND_INTERVAL: "5" }).intervalMs).toBe(5000)
  })

  it("converts the dead-peer backoff from seconds to milliseconds", () => {
    expect(loadGossipConfig({ NOONIEND_DEAD_RETRY: "60" }).deadRetryMs).toBe(60_000)
  })

  it("parses the revoked node list", () => {
    expect([...loadGossipConfig({ NOONIEND_REVOKED: "a, b ,,c" }).revoked].sort()).toEqual([
      "a",
      "b",
      "c",
    ])
    expect(loadGossipConfig({}).revoked.size).toBe(0)
  })

  it("parses the departed node list", () => {
    expect([...loadGossipConfig({ NOONIEND_DEPARTED: "a, b ,,c" }).departed].sort()).toEqual([
      "a",
      "b",
      "c",
    ])
    expect(loadGossipConfig({}).departed.size).toBe(0)
  })

  it("rejects a dead threshold below the suspect threshold", () => {
    expect(() =>
      loadGossipConfig({
        NOONIEND_SUSPECT_AFTER: "5",
        NOONIEND_DEAD_AFTER: "2",
      }),
    ).toThrow(/DEAD_AFTER/)
  })

  it("requires both a TLS certificate and a key", () => {
    expect(() => loadGossipConfig({ NOONIEND_TLS_CERT: "/tmp/cert.pem" })).toThrow(/TLS/)
  })

  it("requires a client certificate for TLS by default", () => {
    const config = loadGossipConfig({
      NOONIEND_TLS_CERT: "/tmp/cert.pem",
      NOONIEND_TLS_KEY: "/tmp/key.pem",
      NOONIEND_TLS_CA: "/tmp/ca.pem",
    })
    expect(config.tls).toEqual({
      cert: "/tmp/cert.pem",
      key: "/tmp/key.pem",
      ca: "/tmp/ca.pem",
      requireClient: true,
    })
  })

  it("defaults the adaptive topology to the full mesh and the plain list", () => {
    const config = loadGossipConfig({})
    expect(config.fanout).toBe(0)
    expect(config.digestMinShards).toBe(32)
    expect(config.channels).toBe(false)
    expect(config.relay.size).toBe(0)
  })

  it("collects the authored shard by default and can be turned off", () => {
    expect(loadGossipConfig({}).gc).toBe(true)
    expect(loadGossipConfig({ NOONIEND_GC: "false" }).gc).toBe(false)
  })

  it("reads the retention window, letting 0 disable retirement", () => {
    expect(loadGossipConfig({ NOONIEND_FORGET_AFTER: "3600" }).forgetAfterMs).toBe(3_600_000)
    expect(loadGossipConfig({ NOONIEND_FORGET_AFTER: "0" }).forgetAfterMs).toBe(0)
    expect(() => loadGossipConfig({ NOONIEND_FORGET_AFTER: "soon" })).toThrow()
  })

  it("parses the adaptive topology options", () => {
    const config = loadGossipConfig({
      NOONIEND_FANOUT: "8",
      NOONIEND_DIGEST_MIN_SHARDS: "64",
      NOONIEND_CHANNELS: "true",
      NOONIEND_RELAY: "hub, relay",
      // A fanout cap and collection cannot coexist (see below), so the topology options
      // are read with collection off.
      NOONIEND_GC: "false",
    })
    expect(config.fanout).toBe(8)
    expect(config.digestMinShards).toBe(64)
    expect(config.channels).toBe(true)
    expect([...config.relay].sort()).toEqual(["hub", "relay"])
  })

  it("rejects a negative fanout", () => {
    expect(() => loadGossipConfig({ NOONIEND_FANOUT: "-1" })).toThrow(/FANOUT/)
  })

  it("refuses a backend that is not a directory", () => {
    // The daemon replicates a directory: with s3 (or memory) it would replicate a local
    // folder the server never uses, doing nothing and saying nothing.
    expect(() => loadGossipConfig({ NOONIEN_BACKEND: "memory" })).toThrow(/NOONIEN_BACKEND/)
    expect(() => loadGossipConfig({ NOONIEN_BACKEND: "s3", NOONIEN_S3_BUCKET: "b" })).toThrow(
      /NOONIEN_BACKEND/,
    )
    expect(loadGossipConfig({ NOONIEN_BACKEND: "FILE" }).directory).toBeTruthy()
  })

  it("refuses a fanout cap together with tombstone collection", () => {
    // A reachable peer the round did not sample suspends the collection, so with a cap
    // the collection would never run: the combination is refused, not shipped inert.
    expect(() => loadGossipConfig({ NOONIEND_FANOUT: "2" })).toThrow(/FANOUT/)
    expect(loadGossipConfig({ NOONIEND_FANOUT: "2", NOONIEND_GC: "false" }).fanout).toBe(2)
    // Collection alone is fine, and that is the default.
    expect(loadGossipConfig({}).gc).toBe(true)
    expect(loadGossipConfig({}).forgetAfterMs).toBeGreaterThan(0)
  })

  it("allows a zero digest threshold", () => {
    expect(loadGossipConfig({ NOONIEND_DIGEST_MIN_SHARDS: "0" }).digestMinShards).toBe(0)
  })

  it("keeps the noonien directory and node id from the base config", () => {
    const config = loadGossipConfig({ NOONIEN_DIR: "/tmp/shards", NOONIEN_NODE_ID: "node-7" })
    expect(config.directory).toBe("/tmp/shards")
    expect(config.nodeId).toBe("node-7")
  })
})

describe("parseHostPort", () => {
  it("falls back when the value is absent", () => {
    expect(parseHostPort(undefined, "0.0.0.0", 7878)).toEqual({ host: "0.0.0.0", port: 7878 })
  })

  it("reads a bare port", () => {
    expect(parseHostPort("9001", "host", 7878)).toEqual({ host: "host", port: 9001 })
  })

  it("reads a colon-prefixed port", () => {
    expect(parseHostPort(":9001", "host", 7878)).toEqual({ host: "host", port: 9001 })
  })

  it("reads an IPv6 bracket address", () => {
    expect(parseHostPort("[::1]:9002", "host", 7878)).toEqual({ host: "::1", port: 9002 })
  })

  it("reads a bare IPv6 bracket address", () => {
    expect(parseHostPort("[::1]", "host", 7878)).toEqual({ host: "::1", port: 7878 })
  })

  it("rejects an invalid port", () => {
    expect(() => parseHostPort("host:not-a-port", "host", 7878)).toThrow(/Invalid port/)
  })
})

describe("formatHostPort", () => {
  it("brackets an IPv6 literal and leaves a hostname alone", () => {
    expect(formatHostPort("::1", 7878)).toBe("[::1]:7878")
    expect(formatHostPort("host", 7878)).toBe("host:7878")
  })
})
