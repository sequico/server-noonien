// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it } from "vitest"
import { isNotFound } from "../src/errors.js"

/** The shape Node reports a filesystem failure with. */
function failure(code: string): Error {
  return Object.assign(new Error(code), { code })
}

describe("isNotFound", () => {
  it("tells a missing path from a store that cannot be read", () => {
    // Every filesystem-backed store decides between "the shard is not there yet" and
    // "something is wrong with this directory" with this one predicate, so a wrong
    // answer here either drops a shard or rewrites a store it could not read.
    expect(isNotFound(failure("ENOENT"))).toBe(true)
    expect(isNotFound(failure("EACCES"))).toBe(false)
    expect(isNotFound(failure("EISDIR"))).toBe(false)
    expect(isNotFound(failure("EIO"))).toBe(false)
    expect(isNotFound(undefined)).toBe(false)
  })
})
