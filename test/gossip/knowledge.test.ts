// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { PeerKnowledge } from "../../src/gossip/knowledge.js"

const directories: string[] = []

async function tempPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "noonien-knowledge-"))
  directories.push(directory)
  return join(directory, ".nooniend-peers.json")
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe("PeerKnowledge", () => {
  it("starts empty when the record does not exist", async () => {
    const knowledge = await PeerKnowledge.load(await tempPath())
    expect(knowledge.frontier("a")).toBeUndefined()
    expect(knowledge.lastSeen("a")).toBeUndefined()
  })

  it("records a peer's frontier and last exchange time", async () => {
    const knowledge = await PeerKnowledge.load(await tempPath())
    knowledge.record(
      "a",
      new Map([
        ["a", 4],
        ["b", 7],
      ]),
      1000,
    )
    expect(knowledge.frontier("a")).toEqual(
      new Map([
        ["a", 4],
        ["b", 7],
      ]),
    )
    expect(knowledge.lastSeen("a")).toBe(1000)
  })

  it("keeps the greatest frontier a peer was ever seen to hold", async () => {
    const knowledge = await PeerKnowledge.load(await tempPath())
    knowledge.record("a", new Map([["b", 5]]), 10)
    // A later, smaller report must not erase what the peer once knew: it could have
    // authored a competing operation on any element it held.
    knowledge.record("a", new Map([["b", 2]]), 20)
    expect(knowledge.frontier("a")).toEqual(new Map([["b", 5]]))
    expect(knowledge.lastSeen("a")).toBe(20)
  })

  it("lists the peers it has a record for, without a departed one", async () => {
    const knowledge = await PeerKnowledge.load(await tempPath())
    knowledge.record("a", new Map([["a", 1]]), 1)
    knowledge.record("b", new Map([["b", 1]]), 2)
    knowledge.forget("a")
    expect(knowledge.nodes()).toEqual(["b"])
  })

  it("round-trips through disk", async () => {
    const path = await tempPath()
    const first = await PeerKnowledge.load(path)
    first.record("a", new Map([["b", 2]]), 42)
    await first.save()
    const second = await PeerKnowledge.load(path)
    expect(second.frontier("a")).toEqual(new Map([["b", 2]]))
    expect(second.lastSeen("a")).toBe(42)
  })

  it("keeps the reserved keys out of the peer set", async () => {
    const path = await tempPath()
    await writeFile(
      path,
      JSON.stringify({
        good: { lastSeen: 2, shards: { a: 3 } },
        "@retired": { a: 3 },
        "@blankets": ["gone"],
      }),
    )
    const knowledge = await PeerKnowledge.load(path)
    // A node id may not contain "@", so the loader reads the reserved keys as "not a
    // peer" and never throws on them, and the durable protection is read explicitly.
    expect(knowledge.nodes()).toEqual(["good"])
    expect(knowledge.retiredFrontier()).toEqual(new Map([["a", 3]]))
    expect(knowledge.blanketCount()).toBe(1)
  })

  it("merges retired frontiers elementwise, never regressing", async () => {
    const knowledge = await PeerKnowledge.load(await tempPath())
    knowledge.retire(
      new Map([
        ["a", 4],
        ["b", 2],
      ]),
    )
    knowledge.retire(
      new Map([
        ["a", 1],
        ["c", 7],
      ]),
    )
    // The maximum, not the latest: a threshold once known may not shrink, or an element
    // that peer could still contest would silently become collectable.
    expect(knowledge.retiredFrontier()).toEqual(
      new Map([
        ["a", 4],
        ["b", 2],
        ["c", 7],
      ]),
    )
  })

  it("keeps a blanket through forget, and clears it on depart", async () => {
    const knowledge = await PeerKnowledge.load(await tempPath())
    knowledge.record("a", new Map([["a", 1]]), 10)
    knowledge.blanket("a")
    knowledge.forget("a")
    expect(knowledge.nodes()).toEqual([])
    // Retirement drops the live record but keeps the protection; departure forfeits it.
    expect(knowledge.blanketCount()).toBe(1)
    knowledge.depart("a")
    expect(knowledge.blanketCount()).toBe(0)
  })

  it("round-trips the retained protection through disk", async () => {
    const path = await tempPath()
    const first = await PeerKnowledge.load(path)
    first.retire(new Map([["a", 2]]))
    first.blanket("gone")
    await first.save()
    const second = await PeerKnowledge.load(path)
    expect(second.retiredFrontier()).toEqual(new Map([["a", 2]]))
    expect(second.blanketCount()).toBe(1)
  })

  it("rejects a corrupt retained protection loudly", async () => {
    // A malformed peer record is dropped because with no frontier the node keeps
    // conservatively blocking. A malformed *threshold* would do the opposite — unblock
    // an element the retired peer could still contest — so it is never ignored.
    const badNumber = await tempPath()
    await writeFile(badNumber, JSON.stringify({ "@retired": { a: "x" } }))
    await expect(PeerKnowledge.load(badNumber)).rejects.toThrow(/corrupt/)
    const badShape = await tempPath()
    await writeFile(badShape, JSON.stringify({ "@blankets": "gone" }))
    await expect(PeerKnowledge.load(badShape)).rejects.toThrow(/corrupt/)
  })

  it("forgets a departed peer", async () => {
    const knowledge = await PeerKnowledge.load(await tempPath())
    knowledge.record("a", new Map([["a", 1]]), 10)
    knowledge.forget("a")
    expect(knowledge.frontier("a")).toBeUndefined()
    expect(knowledge.lastSeen("a")).toBeUndefined()
  })

  it("rejects a corrupt record loudly", async () => {
    const path = await tempPath()
    await writeFile(path, "{not json")
    await expect(PeerKnowledge.load(path)).rejects.toThrow()
  })

  it("drops an entry with an unsafe node id or a malformed frontier", async () => {
    const path = await tempPath()
    await writeFile(
      path,
      JSON.stringify({
        "../evil": { lastSeen: 1, shards: { a: 1 } },
        good: { lastSeen: 2, shards: { a: 3 } },
        badSeen: { lastSeen: "x", shards: {} },
        badShard: { lastSeen: 1, shards: { a: "y" } },
      }),
    )
    const knowledge = await PeerKnowledge.load(path)
    expect(knowledge.nodes()).toEqual(["good"])
    expect(knowledge.frontier("good")).toEqual(new Map([["a", 3]]))
  })
})
