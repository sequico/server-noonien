// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it } from "vitest"
import { isS3NotFound, requireEtag } from "../../src/sync/s3-aws.js"

/** The shape the AWS SDK reports a failed request with. */
function failure(name: string, httpStatusCode: number): unknown {
  return { name, $metadata: { httpStatusCode } }
}

describe("isS3NotFound", () => {
  it("reads a missing object as absent", () => {
    expect(isS3NotFound(failure("NoSuchKey", 404))).toBe(true)
    expect(isS3NotFound(failure("NotFound", 404))).toBe(true)
    expect(isS3NotFound(failure("SomethingNew", 404))).toBe(true)
  })

  it("never reads a broken store as an absent shard", () => {
    // An append under `IfNoneMatch: "*"` on a bucket that does not exist would
    // restart every shard from zero, so a bare 404 that names the bucket is a
    // configuration error, not a missing object.
    expect(isS3NotFound(failure("NoSuchBucket", 404))).toBe(false)
    expect(isS3NotFound(failure("AccessDenied", 403))).toBe(false)
    expect(isS3NotFound(failure("InternalError", 500))).toBe(false)
    expect(isS3NotFound(new Error("network down"))).toBe(false)
  })
})

describe("requireEtag", () => {
  it("passes a single-part ETag through as the version token", () => {
    expect(requireEtag("n1.jsonl", '"d41d8cd98f00b204e9800998ecf8427e"')).toBe(
      '"d41d8cd98f00b204e9800998ecf8427e"',
    )
  })

  it("refuses a token no conditional write could present", () => {
    expect(() => requireEtag("n1.jsonl", undefined)).toThrow(/no ETag/)
    expect(() => requireEtag("n1.jsonl", '"d41d8cd98f00b204e9800998ecf8427e-3"')).toThrow(
      /multipart/,
    )
  })
})
