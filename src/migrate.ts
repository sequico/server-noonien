// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { warn } from "./diagnostics.js"
import type { Entity, KnowledgeGraph, Relation } from "./graph/types.js"
import { EntitySchema, RelationSchema } from "./graph/types.js"

type ParsedRecord =
  | { readonly kind: "entity"; readonly entity: Entity }
  | { readonly kind: "relation"; readonly relation: Relation }

function parseRecord(line: string): ParsedRecord | undefined {
  const trimmed = line.trim()
  if (trimmed === "") {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    warn("skipping a malformed line in the import file")
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) {
    warn("skipping a non-object line in the import file")
    return undefined
  }
  const type = (parsed as { type?: unknown }).type
  if (type === "entity") {
    const result = EntitySchema.safeParse(parsed)
    if (result.success) {
      return { kind: "entity", entity: result.data }
    }
    warn("skipping an invalid entity in the import file")
    return undefined
  }
  if (type === "relation") {
    const result = RelationSchema.safeParse(parsed)
    if (result.success) {
      return { kind: "relation", relation: result.data }
    }
    warn("skipping an invalid relation in the import file")
    return undefined
  }
  warn(`skipping a record with unknown type ${JSON.stringify(type)} in the import file`)
  return undefined
}

/**
 * Parse a memory file written by the official `server-memory`: one JSON object
 * per line, tagged `entity` or `relation`, entities carrying their
 * observations. Malformed and invalid lines are skipped and reported on stderr.
 */
export function parseOfficialMemory(text: string): KnowledgeGraph {
  const entities: Entity[] = []
  const relations: Relation[] = []
  for (const line of text.split("\n")) {
    const record = parseRecord(line)
    if (record === undefined) {
      continue
    }
    if (record.kind === "entity") {
      entities.push(record.entity)
    } else {
      relations.push(record.relation)
    }
  }
  return { entities, relations }
}
