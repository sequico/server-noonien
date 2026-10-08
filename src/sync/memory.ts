// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { assertShardName, type ShardStat, type SyncBackend, shardChanged } from "./backend.js"

/**
 * Shards held in process memory. Nothing persists across restarts: use it for
 * tests, for a throwaway session, or as the base of a future remote backend. Every
 * shard name is validated exactly as the file and S3 backends do, so a test cannot
 * rely on a path the real backends would reject.
 */
export class MemoryBackend implements SyncBackend {
  private readonly shards = new Map<string, string>()
  private readonly versions = new Map<string, number>()

  list(): Promise<string[]> {
    return Promise.resolve([...this.shards.keys()].sort())
  }

  async read(name: string): Promise<string | undefined> {
    assertShardName(name)
    return this.shards.get(name)
  }

  async stat(name: string): Promise<ShardStat | undefined> {
    assertShardName(name)
    const text = this.shards.get(name)
    if (text === undefined) {
      return undefined
    }
    return {
      token: String(this.versions.get(name) ?? 0),
      size: Buffer.byteLength(text),
    }
  }

  async append(name: string, text: string): Promise<void> {
    assertShardName(name)
    this.shards.set(name, (this.shards.get(name) ?? "") + text)
    this.versions.set(name, (this.versions.get(name) ?? 0) + 1)
  }

  async replace(name: string, text: string, expected: string | undefined): Promise<void> {
    assertShardName(name)
    if (this.shards.get(name) !== expected) {
      throw shardChanged(name)
    }
    this.shards.set(name, text)
    this.versions.set(name, (this.versions.get(name) ?? 0) + 1)
  }
}
