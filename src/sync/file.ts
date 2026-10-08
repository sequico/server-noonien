// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { randomBytes } from "node:crypto"
import type { Dirent } from "node:fs"
import {
  appendFile,
  type FileHandle,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  utimes,
} from "node:fs/promises"
import { join } from "node:path"
import { isNotFound } from "../errors.js"
import {
  assertShardName,
  isSafeNodeId,
  nodeOfShard,
  SHARD_EXTENSION,
  type ShardStat,
  type SyncBackend,
  shardChanged,
  shardContended,
} from "./backend.js"

/** How long a lock file may live before it is considered abandoned. */
const LOCK_STALE_MS = 10_000
/** How often a held lock's mtime is refreshed, well under the stale timeout. */
const LOCK_HEARTBEAT_MS = LOCK_STALE_MS / 3
/** Delay between lock attempts, in milliseconds. */
const LOCK_RETRY_MS = 20
/**
 * The longest a writer waits for a lock a live holder keeps refreshing. A lock is
 * stolen only when it goes stale; a compaction that legitimately runs longer than the
 * stale timeout is waited out (bounded) instead of failing the write.
 */
const LOCK_MAX_WAIT_MS = 5 * 60_000

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Shards as `<name>.jsonl` files inside one directory. Point the directory at
 * any folder a syncer replicates (Syncthing, Dropbox, a shared mount), at a git
 * working tree, or at a local path for a single machine.
 *
 * A shard has one writer by design, but `append` and `replace` from different
 * processes must not interleave: both take an exclusive `<name>.lock` file, so a
 * compaction running while a server appends fails loudly (or waits) instead of
 * silently dropping the append. The lock is released on every path and an
 * abandoned one is stolen after {@link LOCK_STALE_MS}.
 */
export class FileBackend implements SyncBackend {
  private readonly directory: string

  constructor(directory: string) {
    this.directory = directory
  }

  async list(): Promise<string[]> {
    const entries = await readDirectory(this.directory)
    if (entries === undefined) {
      return []
    }
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(SHARD_EXTENSION))
      .map((entry) => entry.name)
      .filter((name) => isSafeNodeId(nodeOfShard(name)))
      .sort()
  }

  async read(name: string): Promise<string | undefined> {
    assertShardName(name)
    try {
      return await readFile(join(this.directory, name), "utf8")
    } catch (error) {
      if (isNotFound(error)) {
        return undefined
      }
      throw error
    }
  }

  async stat(name: string): Promise<ShardStat | undefined> {
    assertShardName(name)
    try {
      const info = await stat(join(this.directory, name))
      // mtime alone has millisecond resolution and `rename` can reuse it, so the
      // inode and the change time are part of the token: a rewrite is a new inode and
      // a new ctime, even on mounts where the inode is `0`.
      return { token: `${info.mtimeMs}:${info.ctimeMs}:${info.ino}`, size: info.size }
    } catch (error) {
      if (isNotFound(error)) {
        return undefined
      }
      throw error
    }
  }

  async append(name: string, text: string): Promise<void> {
    assertShardName(name)
    await mkdir(this.directory, { recursive: true })
    await withLock(this.directory, name, () => appendFile(join(this.directory, name), text))
  }

  /**
   * Rewrite a shard through a temporary file in the same directory, synced and
   * then renamed over the target, so readers see either the whole old shard or
   * the whole new one — a crash midway can never truncate the shard. The
   * read-check and the rename run while holding the shard lock, so an append
   * cannot slip in between and be dropped. The temporary file is removed on any
   * caught failure; only a hard crash can leave one behind, and `list` ignores
   * anything that is not a `.jsonl` shard.
   */
  async replace(name: string, text: string, expected: string | undefined): Promise<void> {
    assertShardName(name)
    await mkdir(this.directory, { recursive: true })
    await withLock(this.directory, name, async () => {
      const target = join(this.directory, name)
      const temp = join(this.directory, `${name}.${randomBytes(8).toString("hex")}.tmp`)
      try {
        const handle = await open(temp, "w")
        try {
          await handle.writeFile(text)
          await handle.sync()
        } finally {
          await handle.close()
        }
        if ((await this.read(name)) !== expected) {
          throw shardChanged(name)
        }
        await rename(temp, target)
      } catch (error) {
        await unlink(temp).catch(() => undefined)
        throw error
      }
    })
  }
}

/** Read a directory, or `undefined` when it does not exist yet. */
async function readDirectory(directory: string): Promise<Dirent[] | undefined> {
  try {
    return await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (isNotFound(error)) {
      return undefined
    }
    throw error
  }
}

/** Run `task` while holding this shard's exclusive lock, then release it. */
async function withLock<T>(directory: string, name: string, task: () => Promise<T>): Promise<T> {
  const lockPath = join(directory, `${name}.lock`)
  // A random token names this holder, so a lock stolen as stale is never released
  // by the process that no longer owns it.
  const token = randomBytes(8).toString("hex")
  const deadline = Date.now() + LOCK_MAX_WAIT_MS
  for (;;) {
    const handle = await tryOpenLock(lockPath, token)
    if (handle !== undefined) {
      // Keep the lock fresh while the task runs, so a long append or rewrite is
      // never mistaken for an abandoned lock and stolen by another process.
      const heartbeat = setInterval(() => {
        const now = new Date()
        void utimes(lockPath, now, now).catch(() => undefined)
      }, LOCK_HEARTBEAT_MS)
      try {
        return await task()
      } finally {
        clearInterval(heartbeat)
        await handle.close()
        await releaseLock(lockPath, token)
      }
    }
    if (await stealStaleLock(lockPath)) {
      continue
    }
    if (Date.now() >= deadline) {
      throw shardContended(name)
    }
    await delay(LOCK_RETRY_MS)
  }
}

/** Create the lock exclusively and stamp it with the holder's token. */
async function tryOpenLock(lockPath: string, token: string): Promise<FileHandle | undefined> {
  let handle: FileHandle
  try {
    handle = await open(lockPath, "wx")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return undefined
    }
    throw error
  }
  try {
    await handle.writeFile(token)
  } catch (error) {
    await handle.close()
    await unlink(lockPath).catch(() => undefined)
    throw error
  }
  return handle
}

/** Remove the lock only while it is still the one this holder created. */
async function releaseLock(lockPath: string, token: string): Promise<void> {
  try {
    if ((await readFile(lockPath, "utf8")) === token) {
      await unlink(lockPath)
    }
  } catch {
    // Missing already (stolen as stale): nothing of ours to release.
  }
}

/**
 * Remove the lock when it is stale, re-checking its age immediately before the
 * unlink so a lock a live holder just refreshed is not stolen (a narrow race that
 * the mtime re-read makes much less likely).
 */
async function stealStaleLock(lockPath: string): Promise<boolean> {
  try {
    const before = await stat(lockPath)
    if (Date.now() - before.mtimeMs <= LOCK_STALE_MS) {
      return false
    }
    const again = await stat(lockPath)
    if (again.mtimeMs !== before.mtimeMs) {
      return false
    }
    await unlink(lockPath)
    return true
  } catch {
    // Missing already: retry the create.
    return true
  }
}
