// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createHash } from "node:crypto"
import { hostname } from "node:os"

/** Resolve the node id that names this machine's shard. */
export function resolveNodeId(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env["NOONIEN_NODE_ID"]?.trim()
  return sanitizeNodeId(raw !== undefined && raw !== "" ? raw : hostname())
}

/** Filesystems cap a name near 255 bytes; keep the stem well below it. */
const MAX_STEM = 64
/**
 * The shape a normalized label ends with. A safe label that already looks like a
 * normalized one is itself normalized, so the two output sets stay disjoint.
 */
const NORMALIZED_SUFFIX = /-[0-9a-f]{8}$/

/**
 * Reduce an arbitrary label to a safe, bounded shard-file stem, injectively. A
 * label that is already safe **and** cannot be mistaken for a normalized one keeps
 * its name; every other label gains a short digest of the original, so two
 * different labels — "a b", "a-b", or an over-long id — can never collapse onto one
 * shard and its single writer. The result is always a stem the shard layer accepts
 * (`isSafeNodeId`): separators are gone, a `..` is collapsed, and it starts
 * alphanumeric and stays short.
 */
export function sanitizeNodeId(value: string): string {
  const trimmed = value.trim()
  const cleaned = trimmed.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "")
  if (
    trimmed !== "" &&
    cleaned === trimmed &&
    cleaned.length <= MAX_STEM &&
    !NORMALIZED_SUFFIX.test(cleaned) &&
    !cleaned.includes("..")
  ) {
    return cleaned
  }
  // A label that was normalized, is over-long, already looks normalized, carries a
  // `..` (which no shard stem may), or is empty gains a digest of the original
  // appended to its (bounded) stem — so the empty label can never collide with the
  // literal id "node".
  const digest = createHash("sha256").update(trimmed).digest("hex").slice(0, 8)
  const stem = cleaned === "" ? "node" : cleaned.slice(0, MAX_STEM).replace(/\.{2,}/g, ".")
  return `${stem}-${digest}`
}
