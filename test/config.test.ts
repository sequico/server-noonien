// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type Config, collectionDecision, createMemoryGraph, loadConfig } from "../src/config.js"
import { ShardLog } from "../src/store/log.js"
import { FileBackend } from "../src/sync/file.js"
import { MemoryBackend } from "../src/sync/memory.js"
import { shardTypes } from "./support/gossip.js"
import { createTempDirectory } from "./support/tmp.js"

describe("loadConfig", () => {
  it("defaults to the file backend and ~/.noonien", () => {
    const config = loadConfig({})
    expect(config.backend).toBe("file")
    expect(config.directory).toBe(join(homedir(), ".noonien"))
    expect(config.nodeId).toBeTruthy()
    expect(config.s3).toBeUndefined()
  })

  it("expands a leading tilde in NOONIEN_DIR", () => {
    expect(loadConfig({ NOONIEN_DIR: "~/shards" }).directory).toBe(join(homedir(), "shards"))
    expect(loadConfig({ NOONIEN_DIR: "~" }).directory).toBe(homedir())
    expect(loadConfig({ NOONIEN_DIR: "/var/lib/noonien" }).directory).toBe("/var/lib/noonien")
    expect(loadConfig({ NOONIEN_DIR: "  " }).directory).toBe(join(homedir(), ".noonien"))
  })

  it("rejects an unknown backend", () => {
    expect(() => loadConfig({ NOONIEN_BACKEND: "dropbox" })).toThrow(/Unknown NOONIEN_BACKEND/)
  })

  it("accepts a backend name in any case", () => {
    expect(loadConfig({ NOONIEN_BACKEND: "FILE" }).backend).toBe("file")
    expect(loadConfig({ NOONIEN_BACKEND: "Memory" }).backend).toBe("memory")
    expect(loadConfig({ NOONIEN_BACKEND: "S3", NOONIEN_S3_BUCKET: "b" }).backend).toBe("s3")
  })

  it("requires a bucket for the s3 backend and normalizes the prefix", () => {
    expect(() => loadConfig({ NOONIEN_BACKEND: "s3" })).toThrow(/NOONIEN_S3_BUCKET/)
    expect(
      loadConfig({
        NOONIEN_BACKEND: "s3",
        NOONIEN_S3_BUCKET: "memory",
        NOONIEN_S3_PREFIX: "shards",
        NOONIEN_S3_ENDPOINT: "http://localhost:9000",
      }).s3,
    ).toEqual({
      bucket: "memory",
      region: "us-east-1",
      endpoint: "http://localhost:9000",
      forcePathStyle: true,
      prefix: "shards/",
    })
    expect(loadConfig({ NOONIEN_BACKEND: "s3", NOONIEN_S3_BUCKET: "b" }).s3?.prefix).toBe("")
  })

  it("honours an explicit force-path-style flag", () => {
    expect(
      loadConfig({
        NOONIEN_BACKEND: "s3",
        NOONIEN_S3_BUCKET: "b",
        NOONIEN_S3_ENDPOINT: "http://localhost:9000",
        NOONIEN_S3_FORCE_PATH_STYLE: "false",
      }).s3?.forcePathStyle,
    ).toBe(false)
    expect(() =>
      loadConfig({
        NOONIEN_BACKEND: "s3",
        NOONIEN_S3_BUCKET: "b",
        NOONIEN_S3_FORCE_PATH_STYLE: "maybe",
      }),
    ).toThrow(/Invalid boolean/)
  })

  it("parses the online compaction threshold", () => {
    expect(loadConfig({}).compactAfter).toBe(1000)
    expect(loadConfig({ NOONIEN_COMPACT_AFTER: "0" }).compactAfter).toBe(0)
    expect(loadConfig({ NOONIEN_COMPACT_AFTER: "50" }).compactAfter).toBe(50)
    expect(() => loadConfig({ NOONIEN_COMPACT_AFTER: "-1" })).toThrow(/NOONIEN_COMPACT_AFTER/)
  })
})

describe("createMemoryGraph collection", () => {
  const directories: string[] = []

  async function tempDirectory(): Promise<string> {
    const directory = await createTempDirectory("noonien-config-")
    directories.push(directory)
    return directory
  }

  function graphIn(
    directory: string,
    env: NodeJS.ProcessEnv = {},
  ): ReturnType<typeof createMemoryGraph> {
    return createMemoryGraph({
      NOONIEN_DIR: directory,
      NOONIEN_NODE_ID: "n1",
      NOONIEN_COMPACT_AFTER: "2",
      ...env,
    })
  }

  async function createAndDelete(graph: ReturnType<typeof createMemoryGraph>): Promise<void> {
    await graph.createEntities([{ name: "E", entityType: "t", observations: [] }])
    await graph.deleteEntities(["E"])
  }

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    )
  })

  it("prunes by default: collection without a daemon is opt-in", async () => {
    // The directory cannot prove it is single-writer — a peer that is offline, or not yet
    // synced, is not there to be seen — so the tombstones are kept unless the operator
    // declares it (NOONIEN_GC).
    const directory = await tempDirectory()
    await createAndDelete(graphIn(directory))
    expect(await shardTypes(directory, "n1")).toEqual(["entity.delete", "shard.compact"])
  })

  it("collects physically where the operator declares the directory its own", async () => {
    const directory = await tempDirectory()
    await createAndDelete(graphIn(directory, { NOONIEN_GC: "true" }))
    expect(await shardTypes(directory, "n1")).toEqual(["shard.compact"])
  })

  it("only prunes when another shard is present, even when declared", async () => {
    const directory = await tempDirectory()
    await new FileBackend(directory).append("other.jsonl", "")
    await createAndDelete(graphIn(directory, { NOONIEN_GC: "true" }))
    expect(await shardTypes(directory, "n1")).toEqual(["entity.delete", "shard.compact"])
  })

  it("still collects when only this machine's import shard is present", async () => {
    const directory = await tempDirectory()
    await new FileBackend(directory).append("n1-import.jsonl", "")
    await createAndDelete(graphIn(directory, { NOONIEN_GC: "true" }))
    expect(await shardTypes(directory, "n1")).toEqual(["shard.compact"])
  })

  it("keeps the evidence when the daemon knowledge file is present", async () => {
    // The daemon collects against the evidence, so the online maintenance must not prune
    // the shadowed create: it keeps its whole view and leaves the shard to the daemon.
    const directory = await tempDirectory()
    await writeFile(join(directory, ".nooniend-peers.json"), "{}")
    await createAndDelete(graphIn(directory, { NOONIEN_GC: "true" }))
    expect(await shardTypes(directory, "n1")).toEqual(["entity.create", "entity.delete"])
  })
})

describe("collectionDecision", () => {
  const directories: string[] = []

  async function tempDirectory(): Promise<string> {
    const directory = await createTempDirectory("noonien-decision-")
    directories.push(directory)
    return directory
  }

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    )
  })

  it("allows memory always, and names its reason otherwise", async () => {
    // One process, nothing shared: nothing to lose.
    expect(
      await collectionDecision(
        loadConfig({ NOONIEN_BACKEND: "memory" }),
        new ShardLog(new MemoryBackend(), "n1"),
      ),
    ).toEqual({ allowed: true, reason: undefined, contradicted: false, daemon: false })

    const directory = await tempDirectory()
    const log = new ShardLog(new FileBackend(directory), "n1")
    const config = (env: NodeJS.ProcessEnv = {}): Config =>
      loadConfig({ NOONIEN_DIR: directory, NOONIEN_NODE_ID: "n1", ...env })

    // Not declared → prune only, and the reason says how to declare it.
    const undeclared = await collectionDecision(config(), log)
    expect(undeclared).toMatchObject({ allowed: false, contradicted: false, daemon: false })
    expect(undeclared.reason).toMatch(/NOONIEN_GC/)

    expect(await collectionDecision(config({ NOONIEN_GC: "true" }), log)).toEqual({
      allowed: true,
      reason: undefined,
      contradicted: false,
      daemon: false,
    })

    // Declared but contradicted by a peer's shard → refuse, and say so loudly.
    await new FileBackend(directory).append("other.jsonl", "")
    const contradicted = await collectionDecision(config({ NOONIEN_GC: "true" }), log)
    expect(contradicted).toMatchObject({ allowed: false, contradicted: true, daemon: false })
    expect(contradicted.reason).toMatch(/other\.jsonl/)

    // A daemon owns it: the daemon holds the knowledge and collects.
    await writeFile(join(directory, ".nooniend-peers.json"), "{}")
    const owned = await collectionDecision(config({ NOONIEN_GC: "true" }), log)
    expect(owned).toMatchObject({ allowed: false, contradicted: false, daemon: true })
    expect(owned.reason).toMatch(/daemon/)
  })
})
