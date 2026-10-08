// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it } from "vitest"
import { MemoryGraph } from "../../src/graph/graph.js"
import { ShardLog } from "../../src/store/log.js"
import type { S3Operations, VersionedObject } from "../../src/sync/s3.js"
import { S3Backend } from "../../src/sync/s3.js"

class FakeS3 implements S3Operations {
  private readonly objects = new Map<string, VersionedObject>()
  private versionCounter = 0
  failNextConditional = false

  list(prefix: string): Promise<string[]> {
    return Promise.resolve([...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort())
  }

  getVersioned(key: string): Promise<VersionedObject | undefined> {
    return Promise.resolve(this.objects.get(key))
  }

  head(key: string): Promise<{ version: string; size: number } | undefined> {
    const object = this.objects.get(key)
    return Promise.resolve(
      object === undefined
        ? undefined
        : { version: object.version, size: Buffer.byteLength(object.content) },
    )
  }

  putConditional(key: string, content: string, version: string | undefined): Promise<boolean> {
    if (this.failNextConditional) {
      this.failNextConditional = false
      return Promise.resolve(false)
    }
    const current = this.objects.get(key)
    if (version === undefined ? current !== undefined : current?.version !== version) {
      return Promise.resolve(false)
    }
    this.versionCounter += 1
    this.objects.set(key, { content, version: `v${this.versionCounter}` })
    return Promise.resolve(true)
  }

  seed(key: string, content: string): void {
    this.versionCounter += 1
    this.objects.set(key, { content, version: `v${this.versionCounter}` })
  }

  keys(): string[] {
    return [...this.objects.keys()]
  }
}

function backend(store: FakeS3): S3Backend {
  return new S3Backend("noonien/", () => Promise.resolve(store))
}

describe("S3Backend", () => {
  it("lists shards relative to the prefix", async () => {
    const store = new FakeS3()
    store.seed("noonien/n1.jsonl", "")
    store.seed("noonien/notes.txt", "")
    store.seed("other/n2.jsonl", "")
    expect(await backend(store).list()).toEqual(["n1.jsonl"])
  })

  it("reads a missing shard as undefined", async () => {
    expect(await backend(new FakeS3()).read("n1.jsonl")).toBeUndefined()
  })

  it("appends to the node's own object with a conditional write", async () => {
    const store = new FakeS3()
    const s3 = backend(store)
    await s3.append("n1.jsonl", "a\n")
    await s3.append("n1.jsonl", "b\n")
    expect(await s3.read("n1.jsonl")).toBe("a\nb\n")
    expect(store.keys()).toEqual(["noonien/n1.jsonl"])
  })

  it("retries an append when the object changed underneath it", async () => {
    const store = new FakeS3()
    const s3 = backend(store)
    store.failNextConditional = true
    await s3.append("n1.jsonl", "a\n")
    expect(await s3.read("n1.jsonl")).toBe("a\n")
  })

  it("replaces a shard object only while its content is unchanged", async () => {
    const store = new FakeS3()
    const s3 = backend(store)
    await s3.append("n1.jsonl", "a\n")
    await s3.replace("n1.jsonl", "b\n", "a\n")
    expect(await s3.read("n1.jsonl")).toBe("b\n")
    await expect(s3.replace("n1.jsonl", "c\n", "a\n")).rejects.toThrow(/changed during compaction/)
  })

  it("converges across two nodes on a shared bucket", async () => {
    const store = new FakeS3()
    const nodeA = new MemoryGraph(new ShardLog(backend(store), "n1"))
    const nodeB = new MemoryGraph(new ShardLog(backend(store), "n2"))
    await nodeA.createEntities([{ name: "Ada", entityType: "person", observations: [] }])
    await nodeB.addObservations([{ entityName: "Ada", contents: ["from-b"] }])
    expect(await nodeA.readGraph()).toEqual({
      entities: [{ name: "Ada", entityType: "person", observations: ["from-b"] }],
      relations: [],
    })
  })
})
