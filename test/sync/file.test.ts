// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { MemoryGraph } from "../../src/graph/graph.js"
import { ShardLog } from "../../src/store/log.js"
import { FileBackend } from "../../src/sync/file.js"

let directory = ""

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "noonien-test-"))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe("FileBackend", () => {
  it("reads a missing shard as undefined and appends to create it", async () => {
    const backend = new FileBackend(directory)
    expect(await backend.read("n1.jsonl")).toBeUndefined()
    await backend.append("n1.jsonl", "a\n")
    await backend.append("n1.jsonl", "b\n")
    expect(await backend.read("n1.jsonl")).toBe("a\nb\n")
    expect(await backend.list()).toEqual(["n1.jsonl"])
  })

  it("lists only jsonl shards", async () => {
    const backend = new FileBackend(directory)
    await backend.append("keep.jsonl", "x\n")
    await writeFile(join(directory, "notes.txt"), "ignore me")
    expect(await backend.list()).toEqual(["keep.jsonl"])
  })

  it("rejects a shard name that would escape the directory", async () => {
    const backend = new FileBackend(directory)
    await expect(backend.read("../escape.jsonl")).rejects.toThrow(/unsafe shard name/)
    await expect(backend.append("a/b.jsonl", "x\n")).rejects.toThrow(/unsafe shard name/)
    await expect(backend.stat("a..b.jsonl")).rejects.toThrow(/unsafe shard name/)
    await expect(backend.replace("..jsonl", "x\n", undefined)).rejects.toThrow(/unsafe shard name/)
  })

  it("lists only safe shard names", async () => {
    const backend = new FileBackend(directory)
    await backend.append("good.jsonl", "x\n")
    await writeFile(join(directory, "a..b.jsonl"), "x\n")
    expect(await backend.list()).toEqual(["good.jsonl"])
  })

  it("replaces a shard only while its content is unchanged", async () => {
    const backend = new FileBackend(directory)
    await backend.append("n1.jsonl", "a\n")
    await backend.replace("n1.jsonl", "b\n", "a\n")
    expect(await backend.read("n1.jsonl")).toBe("b\n")
    await expect(backend.replace("n1.jsonl", "c\n", "a\n")).rejects.toThrow(
      /changed during compaction/,
    )
    expect(await backend.read("n1.jsonl")).toBe("b\n")
    expect(await backend.list()).toEqual(["n1.jsonl"])
  })

  it("creates a missing shard with replace and leaves no temporary file", async () => {
    const backend = new FileBackend(directory)
    await backend.replace("n1.jsonl", "a\n", undefined)
    expect(await backend.read("n1.jsonl")).toBe("a\n")
    expect(await backend.list()).toEqual(["n1.jsonl"])
  })

  it("leaves no temporary file behind when a replace fails", async () => {
    const backend = new FileBackend(directory)
    await mkdir(join(directory, "n1.jsonl"))
    await expect(backend.replace("n1.jsonl", "a\n", undefined)).rejects.toThrow()
    expect((await readdir(directory)).filter((entry) => entry.endsWith(".tmp"))).toEqual([])
  })

  it("round-trips a graph through the filesystem", async () => {
    const writer = new MemoryGraph(new ShardLog(new FileBackend(directory), "n1"))
    await writer.createEntities([{ name: "Ada", entityType: "person", observations: ["math"] }])
    const reader = new MemoryGraph(new ShardLog(new FileBackend(directory), "n2"))
    expect(await reader.readGraph()).toEqual({
      entities: [{ name: "Ada", entityType: "person", observations: ["math"] }],
      relations: [],
    })
  })
})
