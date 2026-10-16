// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it } from "vitest"
import { parseFlag, parseInteger } from "../src/env.js"

describe("parseFlag", () => {
  it("accepts the spellings an operator writes and falls back on nothing", () => {
    for (const value of ["true", "TRUE", " 1 ", "yes"]) {
      expect(parseFlag(value, false, "X")).toBe(true)
    }
    for (const value of ["false", "0", "no"]) {
      expect(parseFlag(value, true, "X")).toBe(false)
    }
    // Nothing set, or set to nothing, is the fallback — not `false`.
    expect(parseFlag("", true, "X")).toBe(true)
    expect(parseFlag("   ", false, "X")).toBe(false)
    expect(parseFlag(undefined, true, "X")).toBe(true)
  })

  it("refuses a value it cannot read, naming the setting", () => {
    expect(() => parseFlag("maybe", false, "NOONIEND_TLS")).toThrow(/NOONIEND_TLS/)
  })
})

describe("parseInteger", () => {
  it("falls back on nothing and keeps a value within its floor", () => {
    expect(parseInteger(undefined, 30, "X")).toBe(30)
    expect(parseInteger("  12  ", 30, "X")).toBe(12)
    expect(parseInteger("0", 30, "X", 0)).toBe(0)
  })

  it("refuses a value it cannot use, naming the setting", () => {
    expect(() => parseInteger("1.5", 30, "NOONIEND_INTERVAL")).toThrow(/NOONIEND_INTERVAL/)
    expect(() => parseInteger("-1", 30, "NOONIEND_INTERVAL")).toThrow(/positive/)
    expect(() => parseInteger("-1", 30, "NOONIEND_DIGEST_MIN_SHARDS", 0)).toThrow(/non-negative/)
  })
})
