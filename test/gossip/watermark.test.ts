// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it } from "vitest"
import { fillStableWatermark } from "../../src/gossip/daemon.js"
import type { ShardSummary } from "../../src/gossip/types.js"

function shard(node: string, maxSeq: number): ShardSummary {
  return { node, count: maxSeq + 1, maxSeq, generation: 0 }
}

describe("fillStableWatermark", () => {
  it("confirms nothing when no peer was reached", () => {
    const stable = new Map<string, number>()
    expect(fillStableWatermark(stable, [shard("a", 1)], [])).toBe(0)
    expect(stable.get("a")).toBe(-1)
  })

  it("confirms a shard only when every reached peer holds it", () => {
    const stable = new Map<string, number>()
    const replicated = fillStableWatermark(
      stable,
      [shard("a", 1), shard("b", 0)],
      [
        new Map([["a", 1]]),
        new Map([
          ["a", 0],
          ["b", 0],
        ]),
      ],
    )
    expect(stable.get("a")).toBe(0)
    expect(stable.get("b")).toBe(-1)
    expect(replicated).toBe(0)
  })

  it("confirms a shard when the minimum equals the local high-water mark", () => {
    const stable = new Map<string, number>()
    const replicated = fillStableWatermark(
      stable,
      [shard("a", 1)],
      [new Map([["a", 1]]), new Map([["a", 1]])],
    )
    expect(stable.get("a")).toBe(1)
    expect(replicated).toBe(1)
  })
})
