// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { encodeHlc } from "../../src/graph/hlc.js"
import type { Operation, OperationDraft } from "../../src/graph/operations.js"
import { OPERATION_VERSION, OperationSchema, operationId } from "../../src/graph/operations.js"

export const T1 = "2026-01-01T00:00:00.000Z"
export const T2 = "2026-01-01T00:00:01.000Z"
export const T3 = "2026-01-01T00:00:02.000Z"

export interface OpOptions {
  readonly ts?: string
  readonly seq?: number
  readonly node?: string
  /** An HLC stamp; a legacy operation omits it and is ordered by `ts`. */
  readonly hlc?: string
}

/** Build a fully stamped operation for fold and log tests. */
export function op(draft: OperationDraft, options: OpOptions = {}): Operation {
  const ts = options.ts ?? T1
  const node = options.node ?? "n1"
  const seq = options.seq ?? 0
  return OperationSchema.parse({
    ...draft,
    v: OPERATION_VERSION,
    id: operationId(ts, node, seq),
    ts,
    ...(options.hlc === undefined ? {} : { hlc: options.hlc }),
    node,
    seq,
  })
}

/**
 * Materialize a list of drafts into stamped operations. Timestamps cycle so
 * that ties are exercised; the per-node sequence keeps every id unique, and each
 * operation carries an HLC (the path production uses) whose counter follows the
 * index.
 */
export function materialize(
  drafts: readonly OperationDraft[],
  node: string,
  startSeq = 0,
): Operation[] {
  const stamps = [T1, T2, T3]
  return drafts.map((draft, index) => {
    const ts = stamps[index % stamps.length] ?? T1
    return op(draft, {
      ts,
      seq: startSeq + index,
      node,
      hlc: encodeHlc(Date.parse(ts), index),
    })
  })
}
