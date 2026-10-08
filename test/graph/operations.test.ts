// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it } from "vitest"
import {
  elementKey,
  entityRef,
  OPERATION_VERSION,
  OperationSchema,
  observationRef,
  operationId,
  relationRef,
} from "../../src/graph/operations.js"

const TS = "2026-01-01T00:00:00.000Z"
const base = {
  v: OPERATION_VERSION,
  id: operationId(TS, "n", 0),
  ts: TS,
  node: "n",
  seq: 0,
} as const

describe("OperationSchema", () => {
  it("accepts the empty payload strings the official tool contract allows", () => {
    expect(
      OperationSchema.safeParse({ ...base, type: "entity.create", name: "", entityType: "" })
        .success,
    ).toBe(true)
    expect(
      OperationSchema.safeParse({ ...base, type: "observation.add", entityName: "", content: "" })
        .success,
    ).toBe(true)
    expect(
      OperationSchema.safeParse({
        ...base,
        type: "relation.add",
        from: "",
        to: "",
        relationType: "",
      }).success,
    ).toBe(true)
  })

  it("rejects an unknown operation type", () => {
    expect(OperationSchema.safeParse({ ...base, type: "entity.rename", name: "x" }).success).toBe(
      false,
    )
  })

  it("rejects a timestamp that is not canonical UTC ISO-8601", () => {
    const ts = "2026-01-01T00:00:00Z"
    expect(
      OperationSchema.safeParse({
        ...base,
        id: operationId(ts, "n", 0),
        ts,
        type: "entity.create",
        name: "x",
        entityType: "t",
      }).success,
    ).toBe(false)
  })

  it("rejects an id that is not the ts|node|seq triple", () => {
    expect(
      OperationSchema.safeParse({ ...base, id: "other", type: "entity.create", name: "x" }).success,
    ).toBe(false)
  })
})

describe("elementKey", () => {
  it("gives every element kind a distinct key", () => {
    const keys = new Set([
      elementKey(entityRef("a")),
      elementKey(observationRef("a", "b")),
      elementKey(relationRef("a", "b", "c")),
    ])
    expect(keys.size).toBe(3)
  })

  it("cannot be forged by embedding separators", () => {
    expect(elementKey(entityRef("a\u0000b"))).not.toBe(elementKey(entityRef("a")))
    expect(elementKey(observationRef("a\u0000b", "c"))).not.toBe(
      elementKey(observationRef("a", "b\u0000c")),
    )
  })
})
