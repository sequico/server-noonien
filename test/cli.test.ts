// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { compactShard, importFile } from "../src/cli.js"
import { ShardLog } from "../src/store/log.js"
import { FileBackend } from "../src/sync/file.js"
import { shardTypes } from "./support/gossip.js"
import { createTempDirectory } from "./support/tmp.js"

const directories: string[] = []

async function tempDirectory(): Promise<string> {
  const directory = await createTempDirectory("noonien-compact-")
  directories.push(directory)
  return directory
}

function env(directory: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { NOONIEN_DIR: directory, NOONIEN_NODE_ID: "n1", ...extra }
}

/** Author a create then a delete of E into this node's shard. */
async function author(directory: string): Promise<void> {
  const log = new ShardLog(new FileBackend(directory), "n1")
  await log.append([{ type: "entity.create", name: "E", entityType: "t" }])
  await log.append([{ type: "entity.delete", name: "E" }])
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe("noonien compact", () => {
  it("prunes only by default: deleting tombstones without a daemon is the operator's call", async () => {
    const directory = await tempDirectory()
    await author(directory)
    const { result, reason } = await compactShard(env(directory))
    // The directory cannot prove it is written by this node alone, so the tombstone is
    // kept and the reason says how to declare it.
    expect(result).toEqual({ before: 2, after: 2, frozen: 0 })
    expect(reason).toMatch(/NOONIEN_GC/)
    expect(await shardTypes(directory, "n1")).toEqual(["entity.delete", "shard.compact"])
  })

  it("physically deletes where NOONIEN_GC declares the directory this node's own", async () => {
    const directory = await tempDirectory()
    await author(directory)
    const { result, reason } = await compactShard(env(directory, { NOONIEN_GC: "true" }))
    expect(result).toEqual({ before: 2, after: 1, frozen: 0 })
    expect(reason).toBeUndefined()
    expect(await shardTypes(directory, "n1")).toEqual(["shard.compact"])
  })

  it("keeps the evidence where a daemon owns the directory", async () => {
    const directory = await tempDirectory()
    await author(directory)
    await writeFile(join(directory, ".nooniend-peers.json"), "{}")
    const { result, reason } = await compactShard(env(directory, { NOONIEN_GC: "true" }))
    // The daemon holds the peer knowledge and collects, so it is the only writer allowed to
    // prune: here nothing is dropped — the shadowed create is the evidence its gate reads.
    expect(result).toEqual({ before: 2, after: 2, frozen: 1 })
    expect(reason).toMatch(/daemon/)
    expect(await shardTypes(directory, "n1")).toEqual(["entity.create", "entity.delete"])
  })

  it("refuses to collect when the promise is contradicted by a peer's shard", async () => {
    // The server refuses in exactly the same place: running `compact` on a synced folder
    // must not delete what the server would keep.
    const directory = await tempDirectory()
    await author(directory)
    await new FileBackend(directory).append("other.jsonl", "")
    const { result, reason } = await compactShard(env(directory, { NOONIEN_GC: "true" }))
    expect(result).toEqual({ before: 2, after: 2, frozen: 0 })
    expect(reason).toMatch(/other\.jsonl/)
    expect(await shardTypes(directory, "n1")).toEqual(["entity.delete", "shard.compact"])
  })
})

describe("noonien import", () => {
  const RECORD = `${JSON.stringify({
    type: "entity",
    name: "Ada",
    entityType: "person",
    observations: ["math"],
  })}\n`

  /** Import one entity with one observation, and return the file imported. */
  async function importAda(directory: string): Promise<string> {
    const file = join(directory, "memory.jsonl")
    await writeFile(file, RECORD)
    await importFile(file, env(directory))
    return file
  }

  it("prunes the import shard on the way out", async () => {
    const directory = await tempDirectory()
    const file = await importAda(directory)
    // A fresh import has nothing shadowed to drop, so both adds are there.
    expect(await shardTypes(directory, "n1-import")).toEqual(["entity.create", "observation.add"])

    // A later deletion shadows the imported observation; the next import prunes it.
    await new ShardLog(new FileBackend(directory), "n1").append([
      { type: "observation.delete", entityName: "Ada", content: "math" },
    ])
    await importFile(file, env(directory))
    expect(await shardTypes(directory, "n1-import")).toEqual(["entity.create", "shard.compact"])
  })

  it("is pruned by compact too, which then leaves it untouched", async () => {
    const directory = await tempDirectory()
    await importAda(directory)
    await new ShardLog(new FileBackend(directory), "n1").append([
      { type: "observation.delete", entityName: "Ada", content: "math" },
    ])

    const first = await compactShard(env(directory))
    expect(first.imported?.shard).toBe("n1-import.jsonl")
    expect(first.imported?.result).toEqual({ before: 2, after: 2, dropped: 1 })
    expect(await shardTypes(directory, "n1-import")).toEqual(["entity.create", "shard.compact"])

    // A second pass finds nothing to drop: the file is untouched, so there is no rewrite
    // and no generation churn (which would make every peer re-pull the shard).
    const pruned = await readFile(join(directory, "n1-import.jsonl"), "utf8")
    const second = await compactShard(env(directory))
    expect(second.imported?.result).toEqual({ before: 2, after: 2, dropped: 0 })
    expect(await readFile(join(directory, "n1-import.jsonl"), "utf8")).toBe(pruned)
  })
})
