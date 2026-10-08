// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { rm } from "node:fs/promises"
import { afterEach, describe, expect, it } from "vitest"
import { collectable, type Frontier } from "../../src/gossip/collection.js"
import { decodeOperations } from "../../src/graph/codec.js"
import { foldOperations } from "../../src/graph/fold.js"
import { ShardLog } from "../../src/store/log.js"
import { FileBackend } from "../../src/sync/file.js"
import {
  COLLECT_ALL,
  type DirectPeer,
  directPeer,
  shardTypes,
  syncPeers,
} from "../support/gossip.js"
import { createTempDirectory } from "../support/tmp.js"

const directories: string[] = []

async function peer(node: string): Promise<DirectPeer> {
  const directory = await createTempDirectory("noonien-gc-")
  directories.push(directory)
  return directPeer(node, directory, 1)
}

/** The shard log this node authors, over its own directory. */
function logOf(peer: DirectPeer): ShardLog {
  return new ShardLog(new FileBackend(peer.directory), peer.node)
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe("tombstone collection across a mesh", () => {
  it("keeps a tombstone until every shard is pruned, then drops it everywhere", async () => {
    const a = await peer("n1")
    const b = await peer("n2")
    const logA = logOf(a)
    const logB = logOf(b)
    await logA.append([{ type: "entity.create", name: "E", entityType: "t" }])
    await logB.append([{ type: "entity.delete", name: "E" }])

    // Both have seen each other, but n1's create still sits unpruned in the merged
    // view: n2 must not drop its tombstone while a competitor survives elsewhere.
    await syncPeers(a, b)
    await syncPeers(b, a)
    expect(await logB.gc(COLLECT_ALL)).toEqual({ before: 1, after: 1, frozen: 1 })
    expect(await shardTypes(b.directory, "n2")).toEqual(["entity.delete"])

    // Converge and let every node prune its own shard; once no competitor survives,
    // the tombstone is collectable and the element is physically gone from every copy.
    for (let round = 0; round < 4; round += 1) {
      await syncPeers(a, b)
      await syncPeers(b, a)
      await logA.gc(COLLECT_ALL)
      await logB.gc(COLLECT_ALL)
    }
    await syncPeers(a, b)
    await syncPeers(b, a)

    expect(await shardTypes(a.directory, "n1")).toEqual(["shard.compact"])
    expect(await shardTypes(b.directory, "n2")).toEqual(["shard.compact"])
    expect(foldOperations(await logA.read())).toEqual({ entities: [], relations: [] })
  })

  it("collects an element a peer off the mesh never saw, without waiting for it", async () => {
    const a = await peer("n1")
    const b = await peer("n2")
    const logB = logOf(b)
    await logB.append([{ type: "entity.create", name: "E", entityType: "t" }])
    // n1 catches up with n2, then leaves the mesh: its frontier is frozen here.
    await syncPeers(a, b)
    const frontier: Frontier = new Map((await a.store.list()).map((sum) => [sum.node, sum.maxSeq]))
    const localFrontier: Frontier = new Map(
      (await b.store.list()).map((sum) => [sum.node, sum.maxSeq]),
    )
    // n2 deletes E and creates then deletes a brand-new element n1 never received.
    await logB.append([
      { type: "entity.delete", name: "E" },
      { type: "entity.create", name: "New", entityType: "t" },
      { type: "entity.delete", name: "New" },
    ])
    const result = await logB.gc({
      suspended: false,
      allows: (ops) =>
        collectable({ suspended: false, peers: [frontier], local: localFrontier }, ops),
    })
    // "New" never reached n1, so it is collected at once; E's tombstone stays frozen
    // because n1 holds the operation that created E, whose create survives as the
    // witness a later round still needs.
    expect(result.frozen).toBe(1)
    const own = decodeOperations((await new FileBackend(b.directory).read("n2.jsonl")) ?? "")
    expect(own.map((entry) => entry.type)).toEqual([
      "entity.create",
      "entity.delete",
      "shard.compact",
    ])
    expect(foldOperations(await logB.read())).toEqual({ entities: [], relations: [] })
  })
})
