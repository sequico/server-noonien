// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { foldOperations } from "../../src/graph/fold.js"
import { MemoryGraph } from "../../src/graph/graph.js"
import type { OperationDraft } from "../../src/graph/operations.js"
import { ShardLog } from "../../src/store/log.js"
import type { SyncBackend } from "../../src/sync/backend.js"
import { MemoryBackend } from "../../src/sync/memory.js"
import { COLLECT_ALL } from "../support/gossip.js"
import { materialize } from "../support/operations.js"

const nameArb = fc.constantFrom("a", "b", "c", "d")
const contentArb = fc.constantFrom("o1", "o2")
const typeArb = fc.constantFrom("person", "place")

const draftArb: fc.Arbitrary<OperationDraft> = fc.oneof(
  fc.record({ type: fc.constant("entity.create" as const), name: nameArb, entityType: typeArb }),
  fc.record({ type: fc.constant("entity.delete" as const), name: nameArb }),
  fc.record({
    type: fc.constant("observation.add" as const),
    entityName: nameArb,
    content: contentArb,
  }),
  fc.record({
    type: fc.constant("observation.delete" as const),
    entityName: nameArb,
    content: contentArb,
  }),
  fc.record({
    type: fc.constant("relation.add" as const),
    from: nameArb,
    to: nameArb,
    relationType: fc.constant("knows"),
  }),
  fc.record({
    type: fc.constant("relation.delete" as const),
    from: nameArb,
    to: nameArb,
    relationType: fc.constant("knows"),
  }),
)

const draftsArb = fc.array(draftArb, { maxLength: 30 })

describe("CRDT laws", () => {
  it("is idempotent: folding the same operations twice changes nothing", () => {
    fc.assert(
      fc.property(draftsArb, (drafts) => {
        const ops = materialize(drafts, "n1")
        expect(foldOperations([...ops, ...ops])).toEqual(foldOperations(ops))
      }),
    )
  })

  it("collecting the local shard after pruning preserves the folded graph", async () => {
    await fc.assert(
      fc.asyncProperty(draftsArb, async (drafts) => {
        const log = new ShardLog(new MemoryBackend(), "n1")
        if (drafts.length > 0) {
          await log.append(drafts)
        }
        const before = foldOperations(await log.read())
        await log.compact()
        await log.gc(COLLECT_ALL)
        expect(foldOperations(await log.read())).toEqual(before)
      }),
    )
  })

  it("is commutative: operation order does not matter", () => {
    fc.assert(
      fc.property(draftsArb, (drafts) => {
        const ops = materialize(drafts, "n1")
        expect(foldOperations([...ops].reverse())).toEqual(foldOperations(ops))
      }),
    )
  })

  it("converges when two nodes exchange their logs in either order", () => {
    fc.assert(
      fc.property(draftsArb, draftsArb, (left, right) => {
        const a = materialize(left, "n1")
        const b = materialize(right, "n2")
        const merged = foldOperations([...a, ...b])
        expect(foldOperations([...b, ...a])).toEqual(merged)
        expect(foldOperations([...a, ...b, ...a, ...b])).toEqual(merged)
      }),
    )
  })

  it("is associative: grouping three shards in any order yields the same graph", () => {
    fc.assert(
      fc.property(draftsArb, draftsArb, draftsArb, (one, two, three) => {
        const a = materialize(one, "n1")
        const b = materialize(two, "n2")
        const c = materialize(three, "n3")
        const expected = foldOperations([...a, ...b, ...c])
        expect(foldOperations([...c, ...b, ...a])).toEqual(expected)
        expect(foldOperations([...b, ...a, ...c])).toEqual(expected)
        expect(foldOperations([...a, ...c, ...b])).toEqual(expected)
      }),
    )
  })

  it("reaches the same state when two nodes replay each other's operations", () => {
    fc.assert(
      fc.property(draftsArb, draftsArb, (left, right) => {
        // Each node applies its own operations, then receives the other's.
        const onNodeOne = foldOperations([...materialize(left, "n1"), ...materialize(right, "n2")])
        const onNodeTwo = foldOperations([...materialize(right, "n2"), ...materialize(left, "n1")])
        expect(onNodeOne).toEqual(onNodeTwo)
      }),
    )
  })

  it("preserves the merged graph when a shard is compacted", async () => {
    await fc.assert(
      fc.asyncProperty(draftsArb, draftsArb, async (left, right) => {
        const a = new ShardLog(new MemoryBackend(), "n1")
        const b = new ShardLog(new MemoryBackend(), "n2")
        await a.append(left)
        await b.append(right)
        const merged = foldOperations([...(await a.read()), ...(await b.read())])
        await a.compact()
        expect(foldOperations([...(await a.read()), ...(await b.read())])).toEqual(merged)
      }),
    )
  })
})

type Step =
  | { kind: "create"; name: string; entityType: string; observations: string[] }
  | { kind: "add"; name: string; content: string }
  | { kind: "delete"; name: string }
  | { kind: "rel"; from: string; to: string }
  | { kind: "unrel"; from: string; to: string }
  | { kind: "delobs"; name: string; content: string }

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.record({
    kind: fc.constant("create" as const),
    name: nameArb,
    entityType: typeArb,
    observations: fc.array(contentArb, { maxLength: 2 }),
  }),
  fc.record({ kind: fc.constant("add" as const), name: nameArb, content: contentArb }),
  fc.record({ kind: fc.constant("delete" as const), name: nameArb }),
  fc.record({ kind: fc.constant("rel" as const), from: nameArb, to: nameArb }),
  fc.record({ kind: fc.constant("unrel" as const), from: nameArb, to: nameArb }),
  fc.record({ kind: fc.constant("delobs" as const), name: nameArb, content: contentArb }),
)

/** Apply a script the way a client would, ignoring the official "not found" rejections. */
async function play(graph: MemoryGraph, steps: readonly Step[]): Promise<void> {
  for (const step of steps) {
    try {
      switch (step.kind) {
        case "create":
          await graph.createEntities([
            { name: step.name, entityType: step.entityType, observations: step.observations },
          ])
          break
        case "add":
          await graph.addObservations([{ entityName: step.name, contents: [step.content] }])
          break
        case "delete":
          await graph.deleteEntities([step.name])
          break
        case "rel":
          await graph.createRelations([{ from: step.from, to: step.to, relationType: "r" }])
          break
        case "unrel":
          await graph.deleteRelations([{ from: step.from, to: step.to, relationType: "r" }])
          break
        case "delobs":
          await graph.deleteObservations([{ entityName: step.name, observations: [step.content] }])
          break
      }
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("Entity with name")) {
        throw error
      }
    }
  }
}

/** Copy every shard the source has and the target lacks. */
async function copyShards(from: SyncBackend, to: SyncBackend): Promise<void> {
  for (const name of await from.list()) {
    if ((await to.read(name)) === undefined) {
      const text = await from.read(name)
      if (text !== undefined) {
        await to.append(name, text)
      }
    }
  }
}

describe("CRDT convergence across replicas", () => {
  it("two replicas reach the same graph after exchanging shards", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(stepArb, { maxLength: 15 }),
        fc.array(stepArb, { maxLength: 15 }),
        async (left, right) => {
          const backendA = new MemoryBackend()
          const backendB = new MemoryBackend()
          const replicaA = new MemoryGraph(new ShardLog(backendA, "n1"))
          const replicaB = new MemoryGraph(new ShardLog(backendB, "n2"))
          await play(replicaA, left)
          await play(replicaB, right)
          await copyShards(backendA, backendB)
          await copyShards(backendB, backendA)
          expect(await replicaA.readGraph()).toEqual(await replicaB.readGraph())
        },
      ),
    )
  })
})
