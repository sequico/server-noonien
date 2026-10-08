// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import {
  collectionDecision,
  createImportGraph,
  createMemoryGraph,
  createShardLog,
  loadConfig,
} from "./config.js"
import { collectionGuard } from "./gossip/collection.js"
import { foldOperations } from "./graph/fold.js"
import { parseOfficialMemory } from "./migrate.js"
import { PACKAGE } from "./package.js"
import { runStdioServer } from "./serve.js"
import type { CollectionResult, PruneResult } from "./store/log.js"

const HELP = `noonien — shared, serverless, conflict-free memory for AI agents

Usage: noonien [command] [args]

The MCP memory server is \`server-noonien\` (with no command it serves over stdio);
\`serve\` starts it here too. With no command, \`noonien\` prints this help.

Commands:
  serve              Run the MCP memory server over stdio
  import <file>      Import an official server-memory JSONL file (own shard, online)
  export             Print the folded knowledge graph as JSON
  merge              Fold every shard and report the merged state
  compact            Maintain this node's shards now; delete tombstones only where it is safe
  query <text>       Search entities and print the matching subgraph
  help               Show this help

Environment:
  NOONIEN_BACKEND   file (default), memory or s3
  NOONIEN_DIR       shard directory (default ~/.noonien; a leading ~ expands)
  NOONIEN_NODE_ID   this node's shard name (default the hostname)
  NOONIEN_COMPACT_AFTER   maintain the shard online after N appends (default 1000, 0 off)
  NOONIEN_GC        delete tombstones without a daemon (only where this node is the directory's
                     only writer; default off) — see NOONIEND_* for the daemon
  NOONIEN_S3_BUCKET, NOONIEN_S3_PREFIX, NOONIEN_S3_REGION,
  NOONIEN_S3_ENDPOINT, NOONIEN_S3_FORCE_PATH_STYLE
`

/**
 * Import an official `server-memory` JSONL file into this node's `<node>-import` shard,
 * then prune that shard: it only ever adds, so its shadowed operations can go without any
 * peer knowledge — and whatever is left is what the daemon replicates to every peer.
 */
export async function importFile(
  file: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (file === undefined) {
    throw new Error("usage: noonien import <file>")
  }
  const source = parseOfficialMemory(await readFile(file, "utf8"))
  const graph = createImportGraph(env)
  const entities = await graph.createEntities(source.entities)
  const present = new Set((await graph.readGraph()).entities.map((entity) => entity.name))
  const relations = source.relations.filter(
    (relation) => present.has(relation.from) && present.has(relation.to),
  )
  const created = await graph.createRelations(relations)
  const pruned = await graph.prune()
  const skipped = source.relations.length - relations.length
  process.stdout.write(
    `Imported ${entities.length} of ${source.entities.length} entities and ` +
      `${created.length} of ${source.relations.length} relations from ${file}.` +
      (skipped > 0 ? ` Skipped ${skipped} relation(s) with a missing endpoint.` : "") +
      (pruned.dropped > 0 ? ` Pruned ${pruned.dropped} shadowed operation(s).` : "") +
      "\n",
  )
}

async function exportGraph(): Promise<void> {
  const graph = await createMemoryGraph().readGraph()
  process.stdout.write(`${JSON.stringify(graph, null, 2)}\n`)
}

async function mergeShards(): Promise<void> {
  const log = createShardLog()
  const config = loadConfig()
  const shards = await log.shards()
  const ops = await log.read()
  const graph = foldOperations(ops)
  process.stdout.write(
    `node: ${config.nodeId} (backend: ${config.backend})\n` +
      `shards: ${shards.length}${shards.length > 0 ? ` (${shards.join(", ")})` : ""}\n` +
      `operations: ${ops.length}\n` +
      `entities: ${graph.entities.length}\n` +
      `relations: ${graph.relations.length}\n`,
  )
}

/**
 * Maintain this node's shard in one pass: prune the operations a later one shadows and,
 * only where it is sound, physically drop the surviving tombstones.
 *
 * Without a daemon that is sound only where this node is the directory's only writer
 * (`NOONIEN_GC`), because there is no per-peer knowledge to gate on: a peer that is
 * offline, or configured but not yet synced, is simply not in the directory and its
 * unsynced write would be lost. Where a daemon owns the directory it holds the knowledge
 * and maintains the shard, so this keeps its view whole — pruning a shadowed operation
 * would drop the evidence the daemon collects against. `collectionDecision` is the one
 * place that judgment lives and the MCP server's online maintenance consults the very
 * same one — so running `compact` on a synced folder cannot collect where the server
 * would refuse, nor prune where the daemon needs the evidence.
 */
export async function compactShard(env: NodeJS.ProcessEnv = process.env): Promise<{
  readonly shard: string
  readonly result: CollectionResult
  /** Why the tombstones were kept, when they were: written for the operator. */
  readonly reason: string | undefined
  /** This machine's `<node>-import` shard, pruned when the directory holds one. */
  readonly imported: { readonly shard: string; readonly result: PruneResult } | undefined
}> {
  const config = loadConfig(env)
  const log = createShardLog(env)
  const decision = await collectionDecision(config, log)
  let result: CollectionResult
  if (decision.allowed) {
    result = await log.gc(collectionGuard({ suspended: false, peers: [], local: new Map() }))
  } else if (decision.daemon) {
    // The daemon maintains this directory and holds the peer knowledge: keep our whole
    // view so its gate still reads the evidence (see `collectionDecision`).
    result = await log.gc(collectionGuard({ suspended: true, peers: [], local: new Map() }))
  } else {
    result = { ...(await log.compact()), frozen: 0 }
  }
  // The `<node>-import` shard is written by this machine too and only ever adds: it needs
  // neither the peer knowledge nor the promise, so pruning it is always safe — and this is
  // the only maintenance it ever gets (the import does it on the way out as well).
  const importLog = createShardLog(env, `${config.nodeId}-import`)
  const importShard = importLog.shardName
  const imported = (await importLog.shards()).includes(importShard)
    ? { shard: importShard, result: await importLog.prune() }
    : undefined
  return {
    shard: log.shardName,
    result,
    reason: decision.allowed ? undefined : decision.reason,
    imported,
  }
}

async function query(text: string): Promise<void> {
  if (text.trim() === "") {
    throw new Error("usage: noonien query <text>")
  }
  const graph = await createMemoryGraph().searchNodes(text)
  process.stdout.write(`${JSON.stringify(graph, null, 2)}\n`)
}

/** The maintenance CLI, run by the `noonien` entry point. */
export async function runCli(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  })
  if (values.version === true) {
    process.stdout.write(`${PACKAGE.name} ${PACKAGE.version}\n`)
    return
  }
  const [command, ...rest] = positionals
  if (values.help === true || command === undefined || command === "help") {
    process.stdout.write(HELP)
    return
  }
  switch (command) {
    case "serve":
      runStdioServer()
      return
    case "import":
      await importFile(rest[0])
      return
    case "export":
      await exportGraph()
      return
    case "merge":
      await mergeShards()
      return
    case "compact": {
      const { shard, result, reason, imported } = await compactShard()
      process.stdout.write(
        `Compacted ${shard}: ${result.before} -> ${result.after} operations ` +
          `(${result.frozen} frozen).\n` +
          (reason === undefined ? "" : `Tombstones kept — ${reason}.\n`) +
          (imported === undefined
            ? ""
            : `Pruned ${imported.shard}: ` +
              (imported.result.dropped === 0
                ? "nothing to drop.\n"
                : `dropped ${imported.result.dropped} shadowed operation(s).\n`)),
      )
      return
    }
    case "query":
      await query(rest.join(" "))
      return
    default:
      throw new Error(`Unknown command: ${command}`)
  }
}
