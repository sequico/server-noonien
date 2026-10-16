// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { warn } from "./diagnostics.js"
import type { Entity, KnowledgeGraph, Relation } from "./graph/types.js"
import { EntitySchema, RelationSchema } from "./graph/types.js"

type ParsedRecord =
  | { readonly kind: "entity"; readonly entity: Entity }
  | { readonly kind: "relation"; readonly relation: Relation }

/** How many lines each kind of skip covered, so one report covers them all. */
type Skips = Map<string, number>

/** Count one skipped line and stand in for the record it could not be. */
function skip(skips: Skips, kind: string): undefined {
  skips.set(kind, (skips.get(kind) ?? 0) + 1)
  return undefined
}

function parseRecord(line: string, skips: Skips): ParsedRecord | undefined {
  const trimmed = line.trim()
  if (trimmed === "") {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return skip(skips, "malformed line(s)")
  }
  if (typeof parsed !== "object" || parsed === null) {
    return skip(skips, "non-object line(s)")
  }
  const type = (parsed as { type?: unknown }).type
  if (type === "entity") {
    const result = EntitySchema.safeParse(parsed)
    if (result.success) {
      return { kind: "entity", entity: result.data }
    }
    return skip(skips, "invalid entity line(s)")
  }
  if (type === "relation") {
    const result = RelationSchema.safeParse(parsed)
    if (result.success) {
      return { kind: "relation", relation: result.data }
    }
    return skip(skips, "invalid relation line(s)")
  }
  return skip(skips, `line(s) with unknown type ${JSON.stringify(type)}`)
}

/**
 * Parse a memory file written by the official `server-memory`: one JSON object
 * per line, tagged `entity` or `relation`, entities carrying their
 * observations. Malformed and invalid lines are skipped and reported on stderr
 * once per kind, with how many lines each covered — the file a user is most
 * likely to hand over is the pretty-printed one, where every line is skipped
 * and a report per line would be a hundred thousand writes on the way out.
 */
export function parseOfficialMemory(text: string): KnowledgeGraph {
  const entities: Entity[] = []
  const relations: Relation[] = []
  const skips: Skips = new Map()
  for (const line of text.split("\n")) {
    const record = parseRecord(line, skips)
    if (record === undefined) {
      continue
    }
    if (record.kind === "entity") {
      entities.push(record.entity)
    } else {
      relations.push(record.relation)
    }
  }
  for (const [kind, count] of skips) {
    warn(`skipping ${count} ${kind} in the import file`)
  }
  return { entities, relations }
}
