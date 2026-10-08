// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { warn } from "../diagnostics.js"
import type { Operation } from "./operations.js"
import { OperationSchema } from "./operations.js"

/** Serialize one operation as a single JSONL line (no trailing newline). */
export function encodeOperation(op: Operation): string {
  return JSON.stringify(op)
}

/** The operations decoded from a shard, plus the count of lines that are corrupt. */
export interface DecodedShard {
  readonly ops: Operation[]
  /**
   * Malformed or invalid lines that are **not** the trailing partial line. A
   * trailing line that does not parse is a torn concurrent append and is safe to
   * drop; every other skip is real corruption a rewrite must not erase.
   */
  readonly corrupted: number
}

/**
 * Decode JSONL text into operations. Malformed and non-operation lines are
 * skipped — a shard being written concurrently never fails a whole read — but
 * each kind of skip is reported once, with how many lines it covered, so a
 * single corrupt appendix cannot flood stderr on every read.
 */
export function decodeShard(text: string, source = "a shard"): DecodedShard {
  const ops: Operation[] = []
  let malformed = 0
  let invalid = 0
  let skipped = 0
  let trailingMalformed = false
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "") {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      malformed += 1
      skipped += 1
      trailingMalformed = true
      continue
    }
    const result = OperationSchema.safeParse(parsed)
    if (result.success) {
      ops.push(result.data)
      trailingMalformed = false
    } else {
      invalid += 1
      skipped += 1
      // A complete-but-invalid line is not a torn write.
      trailingMalformed = false
    }
  }
  if (malformed > 0) {
    warn(`skipping ${malformed} malformed line(s) in ${source}`)
  }
  if (invalid > 0) {
    warn(`skipping ${invalid} invalid operation line(s) in ${source}`)
  }
  return { ops, corrupted: skipped - (trailingMalformed ? 1 : 0) }
}

/** Decode JSONL text into operations, dropping every malformed or invalid line. */
export function decodeOperations(text: string, source = "a shard"): Operation[] {
  return decodeShard(text, source).ops
}
