// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** The on-disk/object extension every shard carries. */
export const SHARD_EXTENSION = ".jsonl"

/**
 * A node id becomes a shard-file stem, so it must be path-safe: a bounded label
 * of letters, digits, dot, underscore and hyphen, starting alphanumeric and never
 * containing `..`. Remote node ids (a `NOONIEND_PEERS` host, a digest summary, an
 * `/shards/{node}` path) all pass through here, so no caller can escape the
 * directory with a separator or a parent segment.
 */
const NODE_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/

/** True when a node id is safe to use as a shard-file stem. */
export function isSafeNodeId(node: string): boolean {
  return NODE_ID_PATTERN.test(node) && !node.includes("..")
}

/** The shard file name owned by a node. Rejects an unsafe node id outright. */
export function shardName(node: string): string {
  if (!isSafeNodeId(node)) {
    throw new Error(`unsafe node id: ${JSON.stringify(node)}`)
  }
  return `${node}${SHARD_EXTENSION}`
}

/** The node a shard file name belongs to (the inverse of {@link shardName}). */
export function nodeOfShard(fileName: string): string {
  return fileName.slice(0, -SHARD_EXTENSION.length)
}

/** Fail when a shard name is not a safe `<node>.jsonl`, guarding every backend path. */
export function assertShardName(name: string): string {
  if (!name.endsWith(SHARD_EXTENSION) || !isSafeNodeId(nodeOfShard(name))) {
    throw new Error(`unsafe shard name: ${JSON.stringify(name)}`)
  }
  return name
}

/**
 * A cheap content fingerprint of a shard, used to skip re-decoding one that has
 * not changed. `token` changes whenever the content changes (mtime + inode for a
 * file, a version counter in memory, an ETag for an object); `size` is its byte
 * length. A caller that reads the same shard twice only re-parses it when the
 * fingerprint moved.
 */
export interface ShardStat {
  readonly token: string
  readonly size: number
}

/**
 * A sync backend is the transport for per-node shards. A shard has a single
 * writer by design: it is appended to, and rewritten only by compaction, which
 * is a compare-and-swap so a concurrent writer is detected instead of lost.
 * Implementing this interface is all a storage medium needs to become a
 * noonien sync target (folder, object store, ...).
 */
export interface SyncBackend {
  /** Names of the shards currently present, in ascending order. */
  list(): Promise<string[]>
  /** The raw content of a shard, or `undefined` when it does not exist yet. */
  read(name: string): Promise<string | undefined>
  /** A change fingerprint for a shard, or `undefined` when it does not exist. */
  stat(name: string): Promise<ShardStat | undefined>
  /** Append raw text to a shard, creating it when necessary. */
  append(name: string, text: string): Promise<void>
  /**
   * Overwrite a shard with exactly `text`, but only when its current content is
   * still `expected` (`undefined` when the shard does not exist). This is the
   * one rewrite in the otherwise append-only interface; the guard makes a
   * compaction that races a live writer fail loudly instead of dropping the
   * writer's operations.
   */
  replace(name: string, text: string, expected: string | undefined): Promise<void>
}

/** The error a backend raises when a shard changed between read and replace. */
export class ShardChangedError extends Error {
  constructor(name: string) {
    super(
      `Shard ${name} changed during compaction: another writer is active on this ` +
        `node id. Retrying against the new content.`,
    )
    this.name = "ShardChangedError"
  }
}

/** Raise the error a backend reports when a shard changed during compaction. */
export function shardChanged(name: string): ShardChangedError {
  return new ShardChangedError(name)
}

/** The error a backend raises when concurrent appends exhaust the retry budget. */
export function shardContended(name: string): Error {
  return new Error(
    `Shard ${name} is being written concurrently: give each writer a unique NOONIEN_NODE_ID.`,
  )
}

/** The error a compaction raises when it keeps losing the compare-and-swap. */
export function compactionContended(name: string): Error {
  return new Error(
    `Compaction of shard ${name} kept racing a concurrent writer; ` +
      `it will be retried at the next threshold.`,
  )
}
