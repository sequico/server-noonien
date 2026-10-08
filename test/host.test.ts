// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { hostname } from "node:os"
import { describe, expect, it } from "vitest"
import { resolveNodeId, sanitizeNodeId } from "../src/host.js"
import { isSafeNodeId } from "../src/sync/backend.js"

describe("sanitizeNodeId", () => {
  it("keeps safe characters", () => {
    expect(sanitizeNodeId("workstation")).toBe("workstation")
    expect(sanitizeNodeId("host.example.com")).toBe("host.example.com")
  })

  it("normalizes path separators and spaces without losing uniqueness", () => {
    expect(sanitizeNodeId("my host")).toMatch(/^my-host-[0-9a-f]{8}$/)
    expect(sanitizeNodeId("../etc/passwd")).toMatch(/^etc-passwd-[0-9a-f]{8}$/)
    // Two labels that normalize the same must not collapse onto one shard.
    expect(sanitizeNodeId("a b")).not.toBe(sanitizeNodeId("a-b"))
    expect(sanitizeNodeId("a b")).not.toBe(sanitizeNodeId("a_b"))
  })

  it("falls back to a distinct safe default when only specials remain", () => {
    // The empty label goes through the digest path too, so it cannot collide with the
    // literal id "node" (two labels must never share one single-writer shard).
    expect(sanitizeNodeId("")).toMatch(/^node-[0-9a-f]{8}$/)
    expect(sanitizeNodeId("")).not.toBe(sanitizeNodeId("node"))
    for (const value of ["...", "!!!", "@@@"]) {
      expect(sanitizeNodeId(value)).toMatch(/^node-[0-9a-f]{8}$/)
    }
    // Two different labels that normalize to nothing must not collide.
    expect(sanitizeNodeId("!!!")).not.toBe(sanitizeNodeId("@@@"))
  })

  it("always yields a stem the shard layer accepts", () => {
    // A `..` in a node id would otherwise reach the backends, which reject it — so
    // every label, however odd, must normalise to a stem `isSafeNodeId` accepts.
    for (const value of [
      "a..b",
      "a....b",
      "..a..b..",
      "../etc/passwd",
      "a b",
      "!!!",
      "",
      "x".repeat(300),
    ]) {
      expect(isSafeNodeId(sanitizeNodeId(value))).toBe(true)
    }
    // Collapsing the dots keeps the digest's injectivity: the two labels stay apart.
    expect(sanitizeNodeId("a..b")).not.toBe(sanitizeNodeId("a.b"))
  })

  it("bounds the stem and cannot collide with the normalized shape", () => {
    const normalized = sanitizeNodeId("a b")
    expect(normalized).toMatch(/-[0-9a-f]{8}$/)
    // A safe label shaped exactly like a normalized one is itself normalized, so it
    // can never collide with the label that produced that shape.
    expect(sanitizeNodeId(normalized)).not.toBe(normalized)
    expect(sanitizeNodeId(normalized)).toMatch(/-[0-9a-f]{8}$/)
    // An over-long safe label is truncated and disambiguated, staying a short file name.
    const long = sanitizeNodeId("x".repeat(300))
    expect(long).toMatch(/-[0-9a-f]{8}$/)
    expect(long.length).toBeLessThanOrEqual(64 + 9)
  })
})

describe("resolveNodeId", () => {
  it("uses NOONIEN_NODE_ID when set", () => {
    expect(resolveNodeId({ NOONIEN_NODE_ID: " node a " })).toMatch(/^node-a-[0-9a-f]{8}$/)
  })

  it("falls back to the hostname", () => {
    expect(resolveNodeId({})).toBe(sanitizeNodeId(hostname()))
    expect(resolveNodeId({ NOONIEN_NODE_ID: "   " })).toBe(sanitizeNodeId(hostname()))
  })
})
