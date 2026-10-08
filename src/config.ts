// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { homedir } from "node:os"
import { join } from "node:path"
import { warn } from "./diagnostics.js"
import { parseFlag, parseInteger } from "./env.js"
import { collectionGuard } from "./gossip/collection.js"
import { hasPeerKnowledge } from "./gossip/knowledge.js"
import { MemoryGraph } from "./graph/graph.js"
import { resolveNodeId } from "./host.js"
import { ShardLog } from "./store/log.js"
import { type SyncBackend, shardName } from "./sync/backend.js"
import { FileBackend } from "./sync/file.js"
import { MemoryBackend } from "./sync/memory.js"
import type { S3Settings } from "./sync/s3.js"
import { S3Backend } from "./sync/s3.js"

export type BackendKind = "file" | "memory" | "s3"

export interface Config {
  readonly backend: BackendKind
  readonly directory: string
  readonly nodeId: string
  readonly s3: S3Settings | undefined
  /** Operations appended before the online maintenance runs (0 disables). */
  readonly compactAfter: number
  /**
   * True when the operator declares this directory written by this node alone
   * (`NOONIEN_GC`): the promise that makes a physical collection without a daemon
   * sound. Nothing in the directory can prove it — see {@link collectionDecision}.
   */
  readonly collect: boolean
}

/**
 * Resolve configuration from the environment.
 *
 * - `NOONIEN_BACKEND` — `file` (default), `memory` or `s3`.
 * - `NOONIEN_DIR` — shard directory, default `~/.noonien` (file backend).
 * - `NOONIEN_NODE_ID` — this node's shard name, default the hostname.
 * - `NOONIEN_S3_BUCKET` — bucket (required for the s3 backend).
 * - `NOONIEN_S3_PREFIX` — key prefix for the shards.
 * - `NOONIEN_S3_REGION` — region, default `us-east-1`.
 * - `NOONIEN_S3_ENDPOINT` — custom endpoint (MinIO, R2, ...).
 * - `NOONIEN_S3_FORCE_PATH_STYLE` — path-style requests (default: on when an
 *   endpoint is set, off otherwise).
 * - `NOONIEN_COMPACT_AFTER` — run the online maintenance after this many appended
 *   operations (default 1000; 0 disables): compact the local shard and, when
 *   collection is allowed, physically drop its tombstones.
 * - `NOONIEN_GC` — declare this directory written by this node alone, which is the
 *   only thing that makes a physical collection **without a daemon** sound (default
 *   off: prune only). It has no effect where a daemon owns the directory — the daemon
 *   holds the peer knowledge and collects.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const backend = parseBackend(env["NOONIEN_BACKEND"])
  return {
    backend,
    directory: expandHome(env["NOONIEN_DIR"]) ?? join(homedir(), ".noonien"),
    nodeId: resolveNodeId(env),
    s3: backend === "s3" ? parseS3Settings(env) : undefined,
    compactAfter: parseInteger(
      env["NOONIEN_COMPACT_AFTER"],
      DEFAULT_COMPACT_AFTER,
      "NOONIEN_COMPACT_AFTER",
      0,
    ),
    collect: parseFlag(env["NOONIEN_GC"], false, "NOONIEN_GC"),
  }
}

/** Operations appended before the local shard is compacted online (0 disables). */
const DEFAULT_COMPACT_AFTER = 1000

/**
 * Expand a leading `~` to the home directory. MCP clients pass `NOONIEN_DIR`
 * from a JSON config, where no shell does the expansion, so an unexpanded `~`
 * would otherwise be read as a relative directory literally named `~`.
 */
function expandHome(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (trimmed === undefined || trimmed === "") {
    return undefined
  }
  if (trimmed === "~") {
    return homedir()
  }
  return trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(2)) : trimmed
}

/** Build the shard log described by the environment, optionally for another node id. */
export function createShardLog(env: NodeJS.ProcessEnv = process.env, nodeId?: string): ShardLog {
  const config = loadConfig(env)
  return new ShardLog(createBackend(config), nodeId ?? config.nodeId)
}

/** Build the knowledge graph described by the environment. */
export function createMemoryGraph(env: NodeJS.ProcessEnv = process.env): MemoryGraph {
  const config = loadConfig(env)
  const log = new ShardLog(createBackend(config), config.nodeId)
  // Only collect where it is sound, and report *once* when the operator's promise is
  // contradicted by what is actually in the directory (a peer's shard): collecting then
  // could lose that peer's unsynced writes.
  let reported = false
  return new MemoryGraph(log, undefined, {
    compactAfter: config.compactAfter,
    collection: async () => {
      const decision = await collectionDecision(config, log)
      if (decision.allowed) {
        return collectionGuard({ suspended: false, peers: [], local: new Map() })
      }
      if (decision.contradicted && !reported) {
        reported = true
        warn(decision.reason ?? "collection is not allowed")
      }
      if (decision.daemon) {
        // The daemon owns this directory and holds the peer knowledge, so it is the only
        // writer that may maintain the shard. Pruning here — even just the shadowed
        // operations — would drop the very evidence the daemon's gate reads to decide
        // whether a peer off the mesh could still contest an element, so keep our whole
        // view and let the daemon prune and collect with the knowledge it holds.
        return collectionGuard({ suspended: true, peers: [], local: new Map() })
      }
      // No daemon collects here, so no peer's gate reads the evidence: prune the shadowed
      // operations and keep the tombstones, as before.
      return undefined
    },
  })
}

/** What {@link collectionDecision} found; `reason` is written for the operator. */
export interface CollectionDecision {
  readonly allowed: boolean
  /** Why the tombstones must be kept; `undefined` when collection is allowed. */
  readonly reason: string | undefined
  /** True when `NOONIEN_GC` is set but the directory contradicts it (report loudly). */
  readonly contradicted: boolean
  /**
   * True when a daemon owns the directory and holds the peer knowledge. Its presence is
   * what makes the maintenance unsafe: the daemon collects against evidence the
   * maintenance may not drop, so the server and `noonien compact` keep their view whole.
   */
  readonly daemon: boolean
}

/**
 * Decide whether this node may physically delete its tombstones **without a daemon**.
 *
 * With `nooniend` the collection is gated per element on the durable peer knowledge —
 * what a peer could have known — which is the only thing that makes dropping a
 * tombstone safe while another node may still hold an older operation it beats. Without
 * a daemon there is no such knowledge, so the sound cases are only:
 *
 * - the `memory` backend: one process, nothing shared, nothing to lose;
 * - a directory this node is the **only** writer of. That cannot be read off the
 *   directory — a peer that is offline, or configured but not yet synced, is simply not
 *   there to be seen, and a collection would lose its unsynced write — so it is a
 *   **promise by the operator** (`NOONIEN_GC=true`), never an inference.
 *
 * Everything else keeps the tombstones and prunes the shadowed operations. Where a
 * daemon owns the directory it holds the knowledge and decides, and it is the only
 * writer allowed to maintain the shard: `noonien compact` and the online maintenance
 * must not prune the shadowed operations there either, because a shadowed operation is
 * exactly the evidence the daemon's gate reads. They keep their view whole instead. That
 * is why this is one function.
 */
export async function collectionDecision(
  config: Config,
  log: ShardLog,
): Promise<CollectionDecision> {
  if (config.backend === "memory") {
    return { allowed: true, reason: undefined, contradicted: false, daemon: false }
  }
  if (await hasPeerKnowledge(config.directory)) {
    return {
      allowed: false,
      contradicted: false,
      daemon: true,
      reason: "a daemon owns this directory: it holds the peer knowledge and collects",
    }
  }
  if (!config.collect) {
    return {
      allowed: false,
      contradicted: false,
      daemon: false,
      reason: "prune only: set NOONIEN_GC=true where this directory is written by this node alone",
    }
  }
  const own = new Set([shardName(config.nodeId), shardName(`${config.nodeId}-import`)])
  const foreign = (await log.shards()).filter((name) => !own.has(name))
  if (foreign.length > 0) {
    return {
      allowed: false,
      contradicted: true,
      daemon: false,
      reason:
        `NOONIEN_GC is set, but the directory holds another node's shard ` +
        `(${foreign.join(", ")}): collecting could lose its unsynced writes, so only ` +
        "the shadowed operations were pruned",
    }
  }
  return { allowed: true, reason: undefined, contradicted: false, daemon: false }
}

/**
 * Build the graph used by `noonien import`. It authors its own
 * `<node>-import` shard, so the import can run while the node's server is live:
 * a distinct author never collides on the node id and convergence merges the two
 * shards. Re-importing the same file is idempotent.
 */
export function createImportGraph(env: NodeJS.ProcessEnv = process.env): MemoryGraph {
  const config = loadConfig(env)
  return new MemoryGraph(new ShardLog(createBackend(config), `${config.nodeId}-import`))
}

function parseBackend(value: string | undefined): BackendKind {
  const trimmed = value?.trim().toLowerCase()
  if (trimmed === undefined || trimmed === "" || trimmed === "file") {
    return "file"
  }
  if (trimmed === "memory" || trimmed === "s3") {
    return trimmed
  }
  throw new Error(`Unknown NOONIEN_BACKEND: ${value} (expected "file", "memory" or "s3")`)
}

function parseS3Settings(env: NodeJS.ProcessEnv): S3Settings {
  const bucket = env["NOONIEN_S3_BUCKET"]?.trim()
  if (bucket === undefined || bucket === "") {
    throw new Error("NOONIEN_BACKEND=s3 requires NOONIEN_S3_BUCKET")
  }
  const endpoint = env["NOONIEN_S3_ENDPOINT"]?.trim() || undefined
  return {
    bucket,
    region: env["NOONIEN_S3_REGION"]?.trim() || "us-east-1",
    endpoint,
    forcePathStyle: parseFlag(
      env["NOONIEN_S3_FORCE_PATH_STYLE"],
      endpoint !== undefined,
      "NOONIEN_S3_FORCE_PATH_STYLE",
    ),
    prefix: normalizePrefix(env["NOONIEN_S3_PREFIX"]),
  }
}

function normalizePrefix(value: string | undefined): string {
  const trimmed = value?.trim() ?? ""
  if (trimmed === "") {
    return ""
  }
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`
}

function createBackend(config: Config): SyncBackend {
  switch (config.backend) {
    case "file":
      return new FileBackend(config.directory)
    case "memory":
      return new MemoryBackend()
    case "s3":
      if (config.s3 === undefined) {
        throw new Error("S3 backend selected without S3 settings")
      }
      return S3Backend.fromConfig(config.s3)
  }
}
