// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { afterEach, describe, expect, it, vi } from "vitest"
import { decodeShard, encodeOperation } from "../../src/graph/codec.js"
import { op } from "../support/operations.js"

const valid = encodeOperation(op({ type: "entity.create", name: "A", entityType: "t" }, { seq: 0 }))

/** What the decoder wrote to stderr while running `task`. */
function stderrOf(task: () => void): string[] {
  const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true)
  try {
    task()
    return spy.mock.calls.map((call) => String(call[0]))
  } finally {
    spy.mockRestore()
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("decodeShard", () => {
  it("names the lines it dropped, and not a torn trailing one", () => {
    // Line 2 is a complete line that is not an operation; line 4 is a partial line,
    // which is a write in progress and safe to drop. Only line 2 is corruption a
    // rewrite would erase.
    const text = `${valid}\n{"v":1}\n${valid}\n{"partial":`
    expect(decodeShard(text, "n1.jsonl").corruptedLines).toEqual([2])
    // Nothing torn: the same complete-but-invalid line is corruption wherever it sits.
    expect(decodeShard(`${valid}\n{"v":1}\n`, "n1.jsonl").corruptedLines).toEqual([2])
    // A malformed line with a valid one after it is not a torn write either.
    expect(decodeShard(`not json\n${valid}\n`, "n1.jsonl").corruptedLines).toEqual([1])
  })

  it("reports the skipped lines with their numbers", () => {
    const reported = stderrOf(() => {
      decodeShard(`${valid}\nnot json\n${valid}\n{"v":1}\n`, "a shard to fix")
    })
    expect(reported.join("")).toContain("skipping 1 malformed line(s) in a shard to fix (line 2)")
    expect(reported.join("")).toContain(
      "skipping 1 invalid operation line(s) in a shard to fix (line 4)",
    )
  })

  it("says the same corruption once, not on every read", () => {
    // A peer that keeps pushing the same corrupt body would otherwise write the same
    // warning every round: the identity of a report is the source and the text.
    const repeated = () => decodeShard(`not json\n${valid}\n`, "z600.jsonl")
    expect(stderrOf(repeated)).toHaveLength(1)
    expect(stderrOf(repeated)).toHaveLength(0)
    // Different corruption at the same place is a different fact, and is reported.
    const other = () => decodeShard(`still not json\n${valid}\n`, "z600.jsonl")
    expect(stderrOf(other)).toHaveLength(1)
    // And so is the same corruption in another shard.
    const elsewhere = () => decodeShard(`not json\n${valid}\n`, "mail.jsonl")
    expect(stderrOf(elsewhere)).toHaveLength(1)
  })
})
