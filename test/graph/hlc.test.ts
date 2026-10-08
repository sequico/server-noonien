// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it } from "vitest"
import { decodeHlc, encodeHlc, Hlc, isHlc, legacyHlc } from "../../src/graph/hlc.js"
import {
  compareOperations,
  hlcOf,
  OPERATION_VERSION,
  operationId,
} from "../../src/graph/operations.js"
import { op, T1 } from "../support/operations.js"

describe("Hybrid Logical Clock", () => {
  it("encodes stamps that sort lexicographically in time order", () => {
    const early = encodeHlc(1000, 0)
    const late = encodeHlc(1001, 0)
    const sameMsLater = encodeHlc(1000, 5)
    expect(early < sameMsLater).toBe(true)
    expect(sameMsLater < late).toBe(true)
    expect(decodeHlc(early)).toEqual({ physicalMs: 1000, counter: 0 })
    expect(isHlc(early)).toBe(true)
    expect(isHlc("2026-01-01T00:00:00.000Z")).toBe(false)
  })

  it("keeps issuing increasing stamps when the wall clock steps back", () => {
    const clock = new Hlc()
    const first = clock.next(1000)
    const second = clock.next(999)
    expect(second > first).toBe(true)
    expect(decodeHlc(second)?.physicalMs).toBe(1000)
    expect(decodeHlc(second)?.counter).toBe(1)
    expect(clock.physical).toBe(1000)
  })

  it("orders a later write after an observed remote stamp", () => {
    const clock = new Hlc()
    const remote = encodeHlc(5000, 3)
    clock.observe(remote, 1000)
    const next = clock.next(1000)
    expect(next > remote).toBe(true)
  })

  it("bounds how far a far-future remote stamp moves the clock", () => {
    const clock = new Hlc()
    const now = 1000
    clock.observe(encodeHlc(now + 10_000_000, 0), now)
    expect(clock.physical).toBe(now + 60_000)
    expect(decodeHlc(clock.next(now))?.physicalMs).toBe(now + 60_000)
  })

  it("falls back to the physical time of a legacy timestamp", () => {
    const legacy = legacyHlc(T1)
    expect(decodeHlc(legacy)).toEqual({ physicalMs: Date.parse(T1), counter: 0 })
    // A legacy op (no hlc) is ordered by its timestamp.
    const older = op({ type: "entity.create", name: "A", entityType: "t" }, { ts: T1, seq: 0 })
    expect(hlcOf(older)).toBe(legacy)
  })

  it("orders by HLC, then node, then sequence", () => {
    const base = { v: OPERATION_VERSION, ts: T1, node: "n1", seq: 0 } as const
    const a = op({ type: "entity.create", name: "A", entityType: "t" }, { node: "n1", seq: 0 })
    const b = op({ type: "entity.delete", name: "A" }, { node: "n2", seq: 0 })
    // Same ts, different node: the node id breaks the tie.
    expect(compareOperations(a, b)).toBeLessThan(0)
    const withHlc = {
      ...base,
      hlc: encodeHlc(Date.parse(T1) + 1, 0),
      id: operationId(T1, "n1", 0),
      type: "entity.create" as const,
      name: "A",
      entityType: "t",
    }
    expect(compareOperations(withHlc, a)).toBeGreaterThan(0)
  })
})
