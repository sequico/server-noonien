// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it, vi } from "vitest"
import { MemoryGraph } from "../src/graph/graph.js"
import { parseOfficialMemory } from "../src/migrate.js"
import { ShardLog } from "../src/store/log.js"
import { MemoryBackend } from "../src/sync/memory.js"

const OFFICIAL_FILE = [
  JSON.stringify({ type: "entity", name: "Ada", entityType: "person", observations: ["math"] }),
  JSON.stringify({ type: "relation", from: "Ada", to: "Bob", relationType: "knows" }),
  "",
  "not json",
  JSON.stringify({ type: "unknown" }),
].join("\n")

describe("parseOfficialMemory", () => {
  it("reads entities and relations, skipping noise", () => {
    expect(parseOfficialMemory(OFFICIAL_FILE)).toEqual({
      entities: [{ name: "Ada", entityType: "person", observations: ["math"] }],
      relations: [{ from: "Ada", to: "Bob", relationType: "knows" }],
    })
  })

  it("round-trips an official file into the graph", async () => {
    const graph = new MemoryGraph(new ShardLog(new MemoryBackend(), "node"))
    const source = parseOfficialMemory(OFFICIAL_FILE)
    await graph.createEntities(source.entities)
    await graph.createEntities([{ name: "Bob", entityType: "person", observations: [] }])
    await graph.createRelations(source.relations)
    expect(await graph.readGraph()).toEqual({
      entities: [
        { name: "Ada", entityType: "person", observations: ["math"] },
        { name: "Bob", entityType: "person", observations: [] },
      ],
      relations: [{ from: "Ada", to: "Bob", relationType: "knows" }],
    })
  })

  it("reports each kind of skip once, with how many lines it covered", () => {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    try {
      expect(parseOfficialMemory('{"type":"unknown"}\n{"type":"unknown"}\nnot json')).toEqual({
        entities: [],
        relations: [],
      })
      const reported = spy.mock.calls.map((call) => String(call[0]))
      // One report per kind, not one per line: a pretty-printed import file skips
      // every line, and a write each would be a hundred thousand of them.
      expect(reported).toHaveLength(2)
      expect(reported.join("")).toContain('skipping 2 line(s) with unknown type "unknown"')
      expect(reported.join("")).toContain("skipping 1 malformed line(s)")
    } finally {
      spy.mockRestore()
    }
  })
})
