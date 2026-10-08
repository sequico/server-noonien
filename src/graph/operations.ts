// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod"
import { COUNTER_DIGITS, isHlc, legacyHlc, PHYSICAL_DIGITS } from "./hlc.js"

/**
 * A canonical UTC ISO-8601 timestamp with millisecond precision — exactly what
 * `Date.prototype.toISOString` produces, e.g. `2026-01-01T00:00:00.000Z`. The
 * fold orders operations by the *lexicographic* order of `ts`, so every node
 * must emit this one format; any other spelling (a missing millisecond part, a
 * numeric offset, ...) would no longer match chronology.
 */
function canonicalTimestamp() {
  return z.string().refine(
    (value) => {
      const parsed = new Date(value)
      return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
    },
    {
      message: "must be a canonical UTC ISO-8601 timestamp, e.g. 2026-01-01T00:00:00.000Z",
    },
  )
}

/**
 * The operation envelope revision, stamped into every authored operation and
 * asserted by the schema, so the two can never drift.
 */
export const OPERATION_VERSION = 1

/**
 * The envelope every operation in the append-only log carries.
 *
 * `hlc`/`node`/`seq` form the last-writer-wins total order used by the fold:
 * a greater HLC wins, ties are broken by `node`, then `seq`. `hlc` is omitted by
 * operations written before it existed; {@link hlcOf} falls back to the physical
 * millisecond of `ts`, counter 0, so old and new operations interleave
 * correctly. `ts` stays the canonical wall-clock time of writing, and `id` is
 * the operation identity used to deduplicate a shard that was read twice.
 */
const envelope = {
  v: z.literal(OPERATION_VERSION),
  id: z.string().min(1),
  ts: canonicalTimestamp(),
  hlc: z
    .string()
    .refine(isHlc, {
      message: `must be an HLC stamp: ${PHYSICAL_DIGITS}-digit physical milliseconds : ${COUNTER_DIGITS}-digit counter`,
    })
    .optional(),
  node: z.string().min(1),
  seq: z.number().int().min(0),
}

/**
 * Payloads of the six graph operations, plus the `shard.compact` metadata
 * operation. Additive operations make a knowledge-graph element present;
 * `.delete` operations tombstone it; `shard.compact` is neither and is ignored
 * by the fold.
 *
 * Payload strings are intentionally unrestricted, empty included: the tool
 * contract mirrors the official server, whose input schemas put no minimum
 * length on names, contents or types. Constraining them here would reject
 * inputs the official server accepts.
 */
const payloads = {
  "entity.create": z.object({
    name: z.string(),
    entityType: z.string(),
  }),
  "entity.delete": z.object({
    name: z.string(),
  }),
  "observation.add": z.object({
    entityName: z.string(),
    content: z.string(),
    /**
     * The occurrence ordinal of this content on the entity. Both
     * `create_entities` and `add_observations` preserve duplicate contents, as
     * the official server does, by emitting one `observation.add` per occurrence
     * with a distinct slot. Older operations without a slot are read as
     * occurrence 0.
     */
    slot: z.number().int().min(0).optional(),
  }),
  "observation.delete": z.object({
    entityName: z.string(),
    content: z.string(),
  }),
  "relation.add": z.object({
    from: z.string(),
    to: z.string(),
    relationType: z.string(),
  }),
  "relation.delete": z.object({
    from: z.string(),
    to: z.string(),
    relationType: z.string(),
  }),
  /**
   * A shard-owned metadata operation, written by the owner only when it compacts.
   * It is not a graph element: the fold ignores it. It carries the shard
   * `generation` (bumped on every compaction) and, through its own `seq`, the
   * durable authored high-water mark, so the sequence never regresses and a
   * compaction is never confused with a lost shard.
   */
  "shard.compact": z.object({
    generation: z.number().int().min(1),
  }),
} as const

const operations = z.discriminatedUnion("type", [
  payloads["entity.create"].extend({ ...envelope, type: z.literal("entity.create") }),
  payloads["entity.delete"].extend({ ...envelope, type: z.literal("entity.delete") }),
  payloads["observation.add"].extend({ ...envelope, type: z.literal("observation.add") }),
  payloads["observation.delete"].extend({ ...envelope, type: z.literal("observation.delete") }),
  payloads["relation.add"].extend({ ...envelope, type: z.literal("relation.add") }),
  payloads["relation.delete"].extend({ ...envelope, type: z.literal("relation.delete") }),
  payloads["shard.compact"].extend({ ...envelope, type: z.literal("shard.compact") }),
])

/**
 * An operation whose `id` is exactly the `(ts, node, seq)` triple it is derived
 * from. Enforcing the identity in the schema means a shard read twice — or a
 * corrupted one — is deduplicated by `id` without two different operations ever
 * sharing one.
 */
export const OperationSchema = operations.superRefine((op, ctx) => {
  if (op.id !== operationId(op.ts, op.node, op.seq)) {
    ctx.addIssue({ code: "custom", message: "id must equal the ts|node|seq operation identity" })
  }
})

export type Operation = z.infer<typeof OperationSchema>

type EnvelopeKey = keyof typeof envelope
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, Extract<keyof T, K>>
  : never

/** An operation targeting one element before the local node stamps the envelope. */
export type OperationDraft = DistributiveOmit<Operation, EnvelopeKey>

/**
 * The occurrence ordinal used for an `observation.delete` element key.
 * An observation delete is content-level — it removes every occurrence, like the
 * official server — so it is keyed apart from the per-occurrence adds and can
 * never be shadowed by one of them during compaction.
 */
export const CONTENT_DELETE_SLOT = -1

/** A knowledge-graph element addressed by an operation. */
export type ElementRef =
  | { readonly kind: "entity"; readonly name: string }
  | {
      readonly kind: "observation"
      readonly entityName: string
      readonly content: string
      readonly slot: number
    }
  | {
      readonly kind: "relation"
      readonly from: string
      readonly to: string
      readonly relationType: string
    }
  | { readonly kind: "shard"; readonly node: string }

export function entityRef(name: string): ElementRef {
  return { kind: "entity", name }
}

export function observationRef(entityName: string, content: string, slot = 0): ElementRef {
  return { kind: "observation", entityName, content, slot }
}

export function relationRef(from: string, to: string, relationType: string): ElementRef {
  return { kind: "relation", from, to, relationType }
}

/** The fold and compaction key of a relation, so it is defined in one place. */
export function relationKey(relation: {
  readonly from: string
  readonly to: string
  readonly relationType: string
}): string {
  return elementKey(relationRef(relation.from, relation.to, relation.relationType))
}

/** The key identifying an observation's content, whatever its occurrence slot. */
export function observationContentKey(entityName: string, content: string): string {
  return JSON.stringify(["observation-content", entityName, content])
}

/** A collision-free string identity for an element, used as a fold map key. */
export function elementKey(ref: ElementRef): string {
  switch (ref.kind) {
    case "entity":
      return JSON.stringify(["entity", ref.name])
    case "observation":
      return JSON.stringify(["observation", ref.entityName, ref.content, ref.slot])
    case "relation":
      return JSON.stringify(["relation", ref.from, ref.to, ref.relationType])
    case "shard":
      return JSON.stringify(["shard", ref.node])
  }
}

export interface ElementEffect {
  readonly key: string
  readonly present: boolean
}

/** The element an operation targets and whether it makes it present. */
export function elementEffect(op: Operation): ElementEffect {
  switch (op.type) {
    case "entity.create":
      return { key: elementKey(entityRef(op.name)), present: true }
    case "entity.delete":
      return { key: elementKey(entityRef(op.name)), present: false }
    case "observation.add":
      return {
        key: elementKey(observationRef(op.entityName, op.content, op.slot ?? 0)),
        present: true,
      }
    case "observation.delete":
      return {
        key: elementKey(observationRef(op.entityName, op.content, CONTENT_DELETE_SLOT)),
        present: false,
      }
    case "relation.add":
      return { key: elementKey(relationRef(op.from, op.to, op.relationType)), present: true }
    case "relation.delete":
      return { key: elementKey(relationRef(op.from, op.to, op.relationType)), present: false }
    case "shard.compact":
      return { key: elementKey({ kind: "shard", node: op.node }), present: true }
  }
}

/** The compaction generation a `shard.compact` operation records (0 otherwise). */
export function generationOf(op: Operation): number {
  return op.type === "shard.compact" ? op.generation : 0
}

/** The highest compaction generation among operations. */
export function maxGeneration(ops: Iterable<Operation>): number {
  let generation = 0
  for (const op of ops) {
    const value = generationOf(op)
    if (value > generation) {
      generation = value
    }
  }
  return generation
}

/** Total last-writer-wins order: HLC (or the legacy timestamp), then node, then sequence. */
export function compareOperations(a: Operation, b: Operation): number {
  const aHlc = hlcOf(a)
  const bHlc = hlcOf(b)
  if (aHlc !== bHlc) {
    return aHlc < bHlc ? -1 : 1
  }
  if (a.node !== b.node) {
    return a.node < b.node ? -1 : 1
  }
  return a.seq - b.seq
}

/** The stamp an operation is ordered by: its HLC, or its ts for a legacy op. */
export function hlcOf(op: Pick<Operation, "hlc" | "ts">): string {
  return op.hlc ?? legacyHlc(op.ts)
}

export function operationId(ts: string, node: string, seq: number): string {
  return `${ts}|${node}|${seq}`
}
