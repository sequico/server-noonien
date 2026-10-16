// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import {
  assertShardName,
  CONTENTION_BUDGET_MS,
  delay,
  isSafeNodeId,
  NO_SHARD,
  nodeOfShard,
  SHARD_EXTENSION,
  type ShardStat,
  type SyncBackend,
  shardChanged,
  shardContended,
} from "./backend.js"

/** An object and the version token a conditional write must match. */
export interface VersionedObject {
  readonly content: string
  readonly version: string
}

/** The subset of S3 object operations a shard store needs. */
export interface S3Operations {
  list(prefix: string): Promise<string[]>
  /** The object and its version token, or `undefined` when it does not exist. */
  getVersioned(key: string): Promise<VersionedObject | undefined>
  /** The object's version token and byte length without fetching the body. */
  head(key: string): Promise<ObjectStamp | undefined>
  /**
   * Write `content` only while the object still has `version` (`undefined` means
   * it must not exist yet). Returns `false` when the precondition failed, so the
   * caller can retry against the new version.
   */
  putConditional(key: string, content: string, version: string | undefined): Promise<boolean>
}

/** An object's cheap fingerprint: its version token and byte length. */
export interface ObjectStamp {
  readonly version: string
  readonly size: number
}

/** Connection settings for an S3-compatible object store. */
export interface AwsS3Config {
  readonly bucket: string
  readonly region: string
  readonly endpoint: string | undefined
  readonly forcePathStyle: boolean
}

/** An {@link AwsS3Config} plus the key prefix all shards live under. */
export interface S3Settings extends AwsS3Config {
  readonly prefix: string
}

/** Loads the concrete S3 operations on first use, keeping the SDK optional. */
export type S3OperationsLoader = () => Promise<S3Operations>

/** First wait between two conditional attempts, doubling up to a cap. */
const CONTENTION_BACKOFF_MS = 20
/** Longest wait between two conditional attempts: contention is a wait, not a spin. */
const CONTENTION_BACKOFF_MAX_MS = 1000

/**
 * Shards as objects in an S3-compatible bucket (AWS S3, Cloudflare R2,
 * Contabo, MinIO, ...). Appends and rewrites are conditional writes guarded by
 * the object's version token: if another writer touched the object in between,
 * the write is retried against the new version, so a shared node id can no
 * longer lose an append silently. One writer per node id stays the recommended
 * setup.
 */
export class S3Backend implements SyncBackend {
  private readonly prefix: string
  private readonly load: S3OperationsLoader
  private loaded: Promise<S3Operations> | undefined

  constructor(prefix: string, load: S3OperationsLoader) {
    this.prefix = prefix
    this.load = load
  }

  /** Build a backend that loads `@aws-sdk/client-s3` on first use. */
  static fromConfig(settings: S3Settings): S3Backend {
    return new S3Backend(settings.prefix, () =>
      import("./s3-aws.js").then((module) => module.createAwsS3Operations(settings)),
    )
  }

  async list(): Promise<string[]> {
    const operations = await this.operations()
    return (await operations.list(this.prefix))
      .map((key) => key.slice(this.prefix.length))
      .filter((name) => name.endsWith(SHARD_EXTENSION))
      .filter((name) => isSafeNodeId(nodeOfShard(name)))
      .sort()
  }

  async read(name: string): Promise<string | undefined> {
    assertShardName(name)
    const operations = await this.operations()
    return (await operations.getVersioned(this.prefix + name))?.content
  }

  async stat(name: string): Promise<ShardStat | undefined> {
    assertShardName(name)
    const operations = await this.operations()
    const object = await operations.head(this.prefix + name)
    return object === undefined ? undefined : { token: object.version, size: object.size }
  }

  async append(name: string, text: string, expected?: string): Promise<void> {
    assertShardName(name)
    await this.conditional(name, (current) => {
      if (expected !== undefined && (current?.version ?? NO_SHARD) !== expected) {
        // The object moved under the content this caller derived from, so appending
        // would write a sequence another writer already spent.
        throw shardChanged(name)
      }
      return `${current?.content ?? ""}${text}`
    })
  }

  async replace(name: string, text: string, expected: string | undefined): Promise<void> {
    assertShardName(name)
    await this.conditional(name, (current) => {
      if (current?.content !== expected) {
        throw shardChanged(name)
      }
      return text
    })
  }

  /**
   * Run one conditional write, re-reading the object on a lost race and waiting
   * between attempts until the contention budget runs out: two writers on one node id
   * serialize instead of one of them failing on the first collision.
   *
   * `build` gets the object as it is now and returns what to write; it throws when what
   * it read cannot be used — a stale token, content that moved — which is the caller's
   * own refusal, not contention, so it is never retried.
   */
  private async conditional(
    name: string,
    build: (current: VersionedObject | undefined) => string,
  ): Promise<void> {
    const operations = await this.operations()
    const key = this.prefix + name
    const deadline = Date.now() + CONTENTION_BUDGET_MS
    for (let attempt = 0; ; attempt += 1) {
      const current = await operations.getVersioned(key)
      const content = build(current)
      if (await operations.putConditional(key, content, current?.version)) {
        return
      }
      if (Date.now() >= deadline) {
        throw shardContended(name)
      }
      await delay(Math.min(CONTENTION_BACKOFF_MAX_MS, CONTENTION_BACKOFF_MS * 2 ** attempt))
    }
  }

  private operations(): Promise<S3Operations> {
    if (this.loaded === undefined) {
      // Clearing `loaded` on failure means a transient load error is retried on
      // the next call instead of being cached as a permanently rejected promise.
      this.loaded = this.load().catch((error: unknown) => {
        this.loaded = undefined
        throw error
      })
    }
    return this.loaded
  }
}
