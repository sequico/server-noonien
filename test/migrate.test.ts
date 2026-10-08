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

  it("reports a record with an unknown type", () => {
    const spy = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    try {
      expect(parseOfficialMemory('{"type":"unknown"}')).toEqual({ entities: [], relations: [] })
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("unknown type"))
    } finally {
      spy.mockRestore()
    }
  })
})
