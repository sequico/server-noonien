// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { mkdir, readdir } from "node:fs/promises"
import { join } from "node:path"
import { decodeOperations, encodeOperation } from "../graph/codec.js"
import type { Operation } from "../graph/operations.js"
import { compareOperations, generationOf, maxGeneration } from "../graph/operations.js"
import {
  isSafeNodeId,
  nodeOfShard,
  SHARD_EXTENSION,
  type ShardStat,
  shardName,
} from "../sync/backend.js"
import { FileBackend } from "../sync/file.js"
import type { ShardSummary } from "./types.js"

/**
 * The decoded state of one shard, kept between calls. `ids` and `maxSeq` are the
 * per-shard index the daemon deduplicates against and reports as its
 * high-water mark; both are maintained incrementally when the daemon appends,
 * so a merge never re-reads the file it just wrote.
 */
interface ShardIndex {
  token: string
  size: number
  readonly ops: Operation[]
  readonly ids: Set<string>
  maxSeq: number
  generation: number
}

function shardFile(directory: string, node: string): string {
  return join(directory, shardName(node))
}

/** Bound on the decoded shards kept in memory; past it the oldest entry is evicted. */
const MAX_CACHED_SHARDS = 256

/** Fail when an operation does not belong to the shard it is being written to. */
function assertBelongsTo(node: string, ops: readonly Operation[]): void {
  for (const op of ops) {
    if (op.node !== node) {
      throw new Error(`operation ${op.id} belongs to node "${op.node}", not "${node}"`)
    }
  }
}

/** The operations of a request that are not already known, marking them known. */
function selectFresh(known: Set<string>, ops: readonly Operation[]): Operation[] {
  const fresh: Operation[] = []
  for (const op of ops) {
    if (!known.has(op.id)) {
      known.add(op.id)
      fresh.push(op)
    }
  }
  return fresh
}

/** Fold freshly appended operations into a shard's index. */
function absorb(index: ShardIndex, fresh: readonly Operation[]): void {
  for (const op of fresh) {
    index.ids.add(op.id)
    index.ops.push(op)
    if (op.seq > index.maxSeq) {
      index.maxSeq = op.seq
    }
    if (generationOf(op) > index.generation) {
      index.generation = generationOf(op)
    }
  }
}

function indexOf(info: ShardStat | undefined, ops: Operation[]): ShardIndex {
  const ids = new Set<string>()
  let maxSeq = -1
  for (const op of ops) {
    ids.add(op.id)
    if (op.seq > maxSeq) {
      maxSeq = op.seq
    }
  }
  return {
    token: info?.token ?? "",
    size: info?.size ?? -1,
    ops,
    ids,
    maxSeq,
    generation: maxGeneration(ops),
  }
}

/**
 * The gossip daemon's view of the shard directory: it reads every shard — this
 * node's own plus the replicas of the peers' shards — and writes a peer's
 * replica when it merges one. The one exception is {@link recover}, which
 * re-appends this node's own lost operations from a peer's replica; every write
 * goes through the file backend's per-shard lock, so it serializes with the MCP
 * server even across processes.
 *
 * Each shard is decoded once and indexed: an id set for deduplication and a
 * `maxSeq` high-water mark, both updated in place when the daemon appends, so a
 * merge never re-reads the file it just wrote, and a reconciliation only
 * re-parses a shard whose modification time or size changed. A shard only
 * accepts operations of its own node, and writes are serialized, so a replica
 * received from one path cannot race a pull from another.
 */
export class ReplicaStore {
  readonly ownNode: string
  private readonly directory: string
  private readonly backend: FileBackend
  private readonly cache = new Map<string, ShardIndex>()
  private queue: Promise<unknown> = Promise.resolve()

  constructor(directory: string, ownNode: string) {
    this.directory = directory
    this.ownNode = ownNode
    this.backend = new FileBackend(directory)
  }

  /** Summary of every shard currently on disk, sorted by node. */
  async list(): Promise<ShardSummary[]> {
    await mkdir(this.directory, { recursive: true })
    const entries = await readdir(this.directory, { withFileTypes: true })
    const summaries: ShardSummary[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(SHARD_EXTENSION)) {
        continue
      }
      const node = nodeOfShard(entry.name)
      // Skip a file whose stem is not a safe node id (an `a..b.jsonl` left by hand):
      // it is not a shard this daemon manages and must not reach a path builder.
      if (!isSafeNodeId(node)) {
        continue
      }
      const index = await this.index(node)
      summaries.push({
        node,
        count: index.ops.length,
        maxSeq: index.maxSeq,
        generation: index.generation,
      })
    }
    return summaries.sort((a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : 0))
  }

  /** The operations of one shard with `seq` greater than `afterSeq`, in order. */
  async opsAfter(node: string, afterSeq: number): Promise<Operation[]> {
    const index = await this.index(node)
    return index.ops.filter((op) => op.seq > afterSeq).sort(compareOperations)
  }

  /** Every operation the daemon holds across all shards, in shard then sequence order. */
  async allOps(): Promise<Operation[]> {
    const ops: Operation[] = []
    for (const summary of await this.list()) {
      for (const op of await this.opsAfter(summary.node, -1)) {
        ops.push(op)
      }
    }
    return ops
  }

  /** The highest sequence present in one shard, or `-1` when it does not exist. */
  async maxSeq(node: string): Promise<number> {
    return (await this.index(node)).maxSeq
  }

  /**
   * Merge received operations into the replica of `node`, skipping unknown or
   * already-present ids and appending only the new ones. Serialized against
   * other writes to the same store.
   */
  receive(node: string, ops: readonly Operation[]): Promise<number> {
    return this.enqueue(() => this.apply(node, ops, false))
  }

  /**
   * Re-append operations this node authored but lost, recovered from a peer's
   * replica of its own shard. This is the one case where the daemon writes the
   * local shard, and only with operations that already belong to it; the MCP
   * server refreshes its sequence from the shard on the next read, so the two
   * writers cannot collide on an id.
   */
  recover(ops: readonly Operation[]): Promise<number> {
    return this.enqueue(() => this.apply(this.ownNode, ops, true))
  }

  /**
   * Replace a replica with the exact operations the owner serves. Used when the
   * owner compacted (a newer generation): the peer drops everything it held and
   * adopts the compacted shard, so replicas converge to the compacted content.
   */
  replace(node: string, ops: readonly Operation[]): Promise<number> {
    return this.enqueue(() => this.rewrite(node, ops))
  }

  private async rewrite(node: string, ops: readonly Operation[]): Promise<number> {
    if (node === this.ownNode) {
      throw new Error(`refusing to replace the local shard "${node}" from gossip`)
    }
    for (const op of ops) {
      if (op.node !== node) {
        throw new Error(`operation ${op.id} belongs to node "${op.node}", not "${node}"`)
      }
    }
    const name = shardName(node)
    const expected = await this.backend.read(name)
    const body = ops.length === 0 ? "" : `${ops.map(encodeOperation).join("\n")}\n`
    await this.backend.replace(name, body, expected)
    const path = shardFile(this.directory, node)
    const info = await this.backend.stat(name)
    this.cacheShard(path, indexOf(info, [...ops]))
    return ops.length
  }

  private enqueue(task: () => Promise<number>): Promise<number> {
    const run = this.queue.then(task, task)
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async apply(node: string, ops: readonly Operation[], allowOwn: boolean): Promise<number> {
    if (!allowOwn && node === this.ownNode) {
      throw new Error(`refusing to write the local shard "${node}" from gossip`)
    }
    if (ops.length === 0) {
      return 0
    }
    assertBelongsTo(node, ops)
    const index = await this.index(node)
    const fresh = selectFresh(new Set(index.ids), ops)
    if (fresh.length === 0) {
      return 0
    }
    fresh.sort(compareOperations)
    const path = shardFile(this.directory, node)
    const text = `${fresh.map(encodeOperation).join("\n")}\n`
    // Write through the file backend so the daemon takes the same per-shard
    // lock the MCP server uses: the own shard has one writer at a time.
    await this.backend.append(shardName(node), text)
    // The append succeeded, so the operations are now known. Advance the index from
    // what was just written instead of re-reading the file — but only when the file
    // grew by exactly what was written. An external write (the MCP server appending
    // to the own shard) leaves the cached copy stale, so drop it and let the next
    // read reload, instead of marking it fresh and hiding that write.
    const info = await this.backend.stat(shardName(node))
    if (info !== undefined && info.size === index.size + Buffer.byteLength(text)) {
      index.token = info.token
      index.size = info.size
      absorb(index, fresh)
      this.cacheShard(path, index)
    } else {
      this.cache.delete(path)
    }
    return fresh.length
  }

  /** The cached index of a shard, refreshed when the file changed on disk. */
  private async index(node: string): Promise<ShardIndex> {
    const path = shardFile(this.directory, node)
    const name = shardName(node)
    const info = await this.backend.stat(name)
    if (info === undefined) {
      this.cache.delete(path)
      return indexOf(undefined, [])
    }
    const cached = this.cache.get(path)
    if (cached !== undefined && cached.token === info.token && cached.size === info.size) {
      return cached
    }
    const index = indexOf(info, decodeOperations((await this.backend.read(name)) ?? ""))
    this.cacheShard(path, index)
    return index
  }

  /** Cache a shard index, evicting the oldest entry past the cap. */
  private cacheShard(path: string, index: ShardIndex): void {
    // Re-insert so the entry becomes the most recently used (Map keeps insertion order).
    this.cache.delete(path)
    this.cache.set(path, index)
    while (this.cache.size > MAX_CACHED_SHARDS) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.cache.delete(oldest)
    }
  }
}
