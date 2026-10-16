// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto"
import { warn } from "../diagnostics.js"
import type { Operation } from "./operations.js"
import { OperationSchema } from "./operations.js"

/** Serialize one operation as a single JSONL line (no trailing newline). */
export function encodeOperation(op: Operation): string {
  return JSON.stringify(op)
}

/** The operations decoded from a shard, plus the lines that are corrupt. */
export interface DecodedShard {
  readonly ops: Operation[]
  /**
   * The 1-based numbers of the malformed or invalid lines that are **not** the trailing
   * partial line. A trailing line that does not parse is a torn concurrent append and is
   * safe to drop; every other skip is real corruption a rewrite must not erase, and
   * naming the lines is what makes the refusal that follows actionable.
   */
  readonly corruptedLines: readonly number[]
}

/**
 * The corruption already reported, so the same one is said once and not on every read:
 * a peer that keeps pushing the same corrupt line would otherwise write the same
 * warning every round, for ever. Bounded, because an inbound body decides how many
 * distinct corruptions it can name.
 */
const reported = new Map<string, true>()
const MAX_REPORTED = 1024

/** One skipped line: where it is, and what it said — its text is what identifies it. */
interface Skipped {
  readonly line: number
  readonly text: string
}

/** Report skipped lines once per source and set of lines, naming them. */
function report(kind: string, source: string, skipped: readonly Skipped[]): void {
  // The line's own text is part of the identity, not only its number: the same place
  // holding different corruption is a different fact to report. Hashed rather than
  // held, because the text is as big as the body that carried it.
  const digest = createHash("sha256")
    .update(skipped.map((entry) => entry.text).join("\u0000"))
    .digest("hex")
  const key = `${source}\u0000${kind}\u0000${digest}`
  if (reported.has(key)) {
    return
  }
  reported.set(key, true)
  if (reported.size > MAX_REPORTED) {
    const oldest = reported.keys().next().value
    if (oldest !== undefined) {
      reported.delete(oldest)
    }
  }
  const where = skipped.map((entry) => entry.line).join(", ")
  warn(
    `skipping ${skipped.length} ${kind} in ${source} ` +
      `(${skipped.length === 1 ? "line" : "lines"} ${where})`,
  )
}

/**
 * Decode JSONL text into operations. Malformed and non-operation lines are
 * skipped — a shard being written concurrently never fails a whole read — and each
 * kind of skip is reported **once per source and set of lines**, so neither a corrupt
 * appendix nor a peer repeating the same body once a round can flood stderr.
 */
export function decodeShard(text: string, source = "a shard"): DecodedShard {
  const ops: Operation[] = []
  const malformed: Skipped[] = []
  const invalid: Skipped[] = []
  let trailingMalformed = false
  let line = 0
  for (const raw of text.split("\n")) {
    line += 1
    const trimmed = raw.trim()
    if (trimmed === "") {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      malformed.push({ line, text: trimmed })
      trailingMalformed = true
      continue
    }
    const result = OperationSchema.safeParse(parsed)
    if (result.success) {
      ops.push(result.data)
      trailingMalformed = false
    } else {
      invalid.push({ line, text: trimmed })
      // A complete-but-invalid line is not a torn write.
      trailingMalformed = false
    }
  }
  if (malformed.length > 0) {
    report("malformed line(s)", source, malformed)
  }
  if (invalid.length > 0) {
    report("invalid operation line(s)", source, invalid)
  }
  const corruptedLines = [...malformed, ...invalid].map((entry) => entry.line).sort((a, b) => a - b)
  if (trailingMalformed) {
    // The torn line is the highest number here: any later non-blank line clears the flag.
    corruptedLines.pop()
  }
  return { ops, corruptedLines }
}

/** Decode JSONL text into operations, dropping every malformed or invalid line. */
export function decodeOperations(text: string, source = "a shard"): Operation[] {
  return decodeShard(text, source).ops
}
