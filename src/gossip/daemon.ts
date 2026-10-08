// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { type FSWatcher, readFileSync, watch } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { gossip } from "../diagnostics.js"
import { Metrics } from "../metrics.js"
import { ShardLog } from "../store/log.js"
import { isSafeNodeId, shardName } from "../sync/backend.js"
import { FileBackend } from "../sync/file.js"
import { collectSeeds } from "./bootstrap.js"
import {
  collectionGuard,
  exceedsLocal,
  type Frontier,
  meshState,
  retainedPeers,
  withoutForfeited,
} from "./collection.js"
import { type GossipConfig, loadGossipConfig } from "./config.js"
import { syncMembership, syncWith } from "./exchange.js"
import { PeerKnowledge, peersPath } from "./knowledge.js"
import { Membership } from "./membership.js"
import { ReplicaStore } from "./replica.js"
import { seededRandom, selectPeers } from "./sampler.js"
import { type ServerTls, startGossipServer } from "./server.js"
import {
  BYTES_RECEIVED_METRIC,
  BYTES_SENT_METRIC,
  type ClientTls,
  HttpTransport,
  type PeerTransport,
} from "./transport.js"
import type { Seed, ShardSummary } from "./types.js"

/** Peers contacted on the membership channel when the channels are split. */
const MEMBERSHIP_CHANNEL_PEERS = 1

export interface GossipHandle {
  readonly url: string
  readonly nodeId: string
  /** Run one anti-entropy round against the sampled peers. */
  syncOnce(): Promise<number>
  close(): Promise<void>
}

export interface StartOptions {
  readonly quiet?: boolean
}

interface Tls {
  readonly server: ServerTls
  readonly client: ClientTls
}

interface Watcher {
  close(): void
}

/** A peer counted in the watermark whose shard set we have not observed yet. */
const EMPTY_SHARDS: ReadonlyMap<string, number> = new Map()

/**
 * Start the gossip daemon: serve this node's shards and membership over HTTP,
 * reconcile with peers on a timer and on local shard changes, keep the peer set up
 * to date and, when {@link GossipConfig.gc}, collect the shard it authors. It
 * writes the local node's own shard only for recovery and collection, never a peer's.
 */
export async function startGossip(
  env: NodeJS.ProcessEnv = process.env,
  options: StartOptions = {},
): Promise<GossipHandle> {
  const config = loadGossipConfig(env)
  const tls = loadTls(config)
  const metrics = new Metrics()
  const log = (message: string): void => {
    if (options.quiet !== true) {
      gossip(message)
    }
  }

  const replica = new ReplicaStore(config.directory, config.nodeId)
  // The daemon may collect the shard it authors: prune the operations a later one
  // shadows and, once the mesh is fully converged, drop the surviving tombstones so
  // a deletion becomes physical. `recover` already writes the own shard; every write
  // still serializes with the MCP server through the file backend's per-shard lock
  // and the compaction compare-and-swap.
  const shardLog = config.gc
    ? new ShardLog(new FileBackend(config.directory), config.nodeId, metrics)
    : undefined
  // Node ids whose writes are forfeited: they neither block collection nor may
  // contribute. Revoked nodes are refused; departed ones are also discarded.
  const ignored = new Set([...config.revoked, ...config.departed])
  if (config.tls !== undefined && !config.tls.requireClient) {
    log(
      "NOONIEND_TLS_REQUIRE_CLIENT=false: TLS encrypts but does not authenticate — any client " +
        "can push any node's shard, and NOONIEND_REVOKED / NOONIEND_DEPARTED cannot take effect",
    )
  }
  if ((config.revoked.size > 0 || config.departed.size > 0) && config.tls?.requireClient !== true) {
    log(
      "NOONIEND_REVOKED / NOONIEND_DEPARTED have no effect without mTLS: a peer has no " +
        "identity to refuse without a client certificate (set NOONIEND_TLS_CERT/KEY/CA)",
    )
  }
  const membership = new Membership({
    self: { node: config.nodeId, address: config.advertise, version: Date.now() },
    suspectAfter: config.suspectAfter,
    deadAfter: config.deadAfter,
    deadRetryMs: config.deadRetryMs,
    membershipTtlMs: config.membershipTtlMs,
  })
  const transports = new Map<string, PeerTransport>()
  const transportFor = (address: string): PeerTransport => {
    const existing = transports.get(address)
    if (existing !== undefined) {
      return existing
    }
    const created = new HttpTransport(
      address,
      tls?.client,
      undefined,
      metrics,
      undefined,
      membership.self(),
    )
    transports.set(address, created)
    return created
  }

  await mkdir(config.directory, { recursive: true })
  const knowledge = await PeerKnowledge.load(peersPath(config.directory))
  // Write the record from the start, even when it is empty: that file is how a daemon
  // announces it owns the directory, and the server and `noonien compact` consult it
  // before deciding whether a collection without it is allowed. Without this, a daemon
  // that has not completed a round yet would be invisible, and either could collect while
  // it is about to replicate — the one window a knowledge file can close.
  await knowledge.save()
  const seeds = await collectSeeds({
    staticPeers: config.staticPeers,
    dnsSrvDomain: config.dnsSrvDomain,
    tailscale: config.tailscale,
    port: config.listenPort,
  })
  for (const seed of seeds) {
    if (seed.node !== undefined && seed.node !== config.nodeId) {
      membership.seed([{ node: seed.node, address: seed.address, version: 0 }])
    }
  }

  // Per-shard stable high-water mark: an operation at or below it has reached every
  // contactable peer. It is observability (the `/watermark` route) and a conservative
  // causal-stability bound; tombstone collection uses the convergence barrier below,
  // which additionally requires every retained member to have been contacted. With a
  // fanout cap we do not hear from every peer each round, so the last high-water mark
  // observed from each peer is kept across rounds: a stale value is a lower bound,
  // hence conservative (safe), and a never-contacted peer counts as empty.
  const stable = new Map<string, number>()
  const random = seededRandom(config.nodeId)
  const startedAt = Date.now()
  const server = await startGossipServer({
    host: config.listenHost,
    port: config.listenPort,
    tls: tls?.server,
    replica,
    membership,
    metrics,
    watermark: () => Object.fromEntries(stable),
    revoked: ignored,
  })

  const resolvedSeeds = new Set<string>()
  let running = false
  let pending = false
  // The last triggered round, so `close` can let an in-flight write finish before
  // the caller removes the directory.
  let inFlight: Promise<unknown> = Promise.resolve()
  // The peers currently carrying an `absent_seconds` series, so a departed or
  // forgotten peer's series is removed instead of leaking forever.
  const absencePeers = new Set<string>()
  const runRound = async (): Promise<number> => {
    const started = performance.now()
    const bytesBefore = bytesMoved(metrics)
    metrics.counter("noonien_gossip_rounds_total", "Anti-entropy rounds")
    await discardDeparted(config.directory, config.departed)
    for (const node of config.departed) {
      knowledge.depart(node)
    }
    await resolveSeeds(seeds, config.nodeId, membership, transportFor, resolvedSeeds)
    membership.prune()
    const peers = membership.contactable().filter((peer) => !ignored.has(peer.node))
    const sample = selectPeers(peers, config.fanout, random, config.relay)
    metrics.gauge("noonien_gossip_links", "Peers contacted in the last round", sample.length)
    metrics.gauge(
      "noonien_gossip_fanout",
      "Configured anti-entropy fanout (0 = every peer)",
      config.fanout,
    )
    if (config.channels) {
      // Membership rides its own channel: a small sample exchanges the peer set,
      // so the data exchanges below carry none of it. A failure is surfaced like
      // a data exchange's, so a broken membership channel is not silent.
      const membershipPeers = selectPeers(peers, MEMBERSHIP_CHANNEL_PEERS, random, config.relay)
      const membershipResults = await Promise.allSettled(
        membershipPeers.map((peer) => syncMembership(transportFor(peer.address), membership)),
      )
      membershipResults.forEach((result, index) => {
        const peer = membershipPeers[index]
        if (peer !== undefined && !(result.status === "fulfilled" && result.value)) {
          metrics.counter(
            "noonien_gossip_membership_channel_failures_total",
            "Membership-channel exchanges that failed",
          )
          log(`membership gossip with ${peer.node} (${peer.address}) failed`)
        }
      })
    }
    const results = await Promise.allSettled(
      sample.map(async (peer) => {
        const result = await syncWith(peer, transportFor(peer.address), replica, membership, {
          membership: !config.channels,
          digestMinShards: config.digestMinShards,
          ignored,
          onDigest: () =>
            metrics.counter(
              "noonien_gossip_digest_exchanges_total",
              "Exchanges that used the shard digest",
            ),
        })
        if (result.ok) {
          metrics.counter("noonien_gossip_peers_ok_total", "Successful peer exchanges")
          metrics.counter("noonien_gossip_ops_pulled_total", "Operations pulled", result.pulled)
          metrics.counter("noonien_gossip_ops_pushed_total", "Operations pushed", result.pushed)
        } else {
          metrics.counter("noonien_gossip_peers_failed_total", "Failed peer exchanges")
          log(`sync with ${peer.node} (${peer.address}) failed: ${result.error ?? "unknown"}`)
        }
        return result
      }),
    )
    for (const address of [...transports.keys()]) {
      if (!membership.known().some((entry) => entry.address === address)) {
        transports.delete(address)
      }
    }

    // Record every synced peer's frontier and when it was reached. The record is
    // durable: a peer gone for a year keeps blocking only the elements it knew.
    //
    // Only what the exchange can confirm is recorded. An author the peer reported but
    // that is not in our replica afterwards is a claim it cannot serve — a lie, or a
    // lag — and a bogus threshold would make the peer a permanent *superset*, which
    // freezes the collection of every element. The filter is deliberately blind to whose
    // author it is: it drops the claim for this node's own shard too, where the file is
    // simply absent (a lost shard) — that costs nothing, because the recovery path
    // restores our own operations from the peer regardless. A dropped claim is
    // re-learned on the next exchange.
    const now = Date.now()
    const covered = new Set<string>()
    const local = await replica.list()
    const held = new Set(local.map((summary) => summary.node))
    results.forEach((result, index) => {
      const peer = sample[index]
      if (peer !== undefined && result.status === "fulfilled" && result.value.ok) {
        covered.add(peer.node)
        knowledge.record(
          peer.node,
          new Map([...result.value.shards].filter(([author]) => held.has(author))),
          now,
        )
      }
    })
    await knowledge.save()
    // The stable watermark is observability: a peer's last frontier is a lower
    // bound, so a peer not sampled now keeps it and one never reached counts empty.
    const remotes = peers.map((peer) => knowledge.frontier(peer.node) ?? EMPTY_SHARDS)
    const replicated = fillStableWatermark(stable, local, remotes)
    metrics.gauge("noonien_gossip_shards", "Shards held locally", local.length)
    metrics.gauge(
      "noonien_gossip_stable_shards",
      "Shards caught up on every contactable peer",
      replicated,
    )
    metrics.gauge(
      "noonien_gossip_membership_size",
      "Peers known by membership",
      membership.known().length,
    )
    metrics.gauge("noonien_gossip_up", "Daemon is up", 1)
    metrics.gauge(
      "noonien_gossip_round_seconds",
      "Duration of the last anti-entropy round",
      (performance.now() - started) / 1000,
    )
    metrics.gauge(
      "noonien_gossip_round_bytes",
      "Bytes sent and received in the last round",
      Math.max(0, bytesMoved(metrics) - bytesBefore),
    )
    await collect({
      shardLog,
      membership,
      ignored,
      covered,
      knowledge,
      now,
      startedAt,
      metrics,
      log,
      local: new Map(local.map((summary) => [summary.node, summary.maxSeq])),
      forgetAfterMs: config.forgetAfterMs,
      absence: absencePeers,
    })
    return results.filter((result) => result.status === "fulfilled" && result.value.ok).length
  }
  const syncOnce = async (): Promise<number> => {
    if (running) {
      // A change during a round is not lost and does not wait for the next
      // interval: it queues exactly one more round, drained by the running one.
      pending = true
      return 0
    }
    running = true
    try {
      let succeeded = await runRound()
      while (pending) {
        pending = false
        succeeded = await runRound()
      }
      return succeeded
    } finally {
      running = false
    }
  }
  const trigger = (): void => {
    if (running) {
      // A change during a round is not lost and does not wait for the next interval:
      // queue exactly one more round, drained by the running one. Keep the in-flight
      // promise, so `close` still awaits the round that is actually running.
      void syncOnce().catch((error: unknown) => {
        log(`sync round failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      return
    }
    inFlight = syncOnce().catch((error: unknown) => {
      log(`sync round failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  // Push on change watches only this node's own shard, so writing a replica from
  // a peer does not feed back into another round.
  const watcher = config.push
    ? watchDirectory(config.directory, shardName(config.nodeId), trigger)
    : undefined
  const timer = setInterval(trigger, config.intervalMs)
  log(
    `node ${config.nodeId} listening on ${config.listenHost}:${config.listenPort} (advertise ${config.advertise})`,
  )
  trigger()

  return {
    url: server.url,
    nodeId: config.nodeId,
    syncOnce,
    close: async (): Promise<void> => {
      clearInterval(timer)
      watcher?.close()
      // Let a round that is already running finish writing before the directory is
      // removed or the process exits.
      await inFlight
      await server.close()
    },
  }
}

/** The bytes sent and received so far, from the transport counters. */
function bytesMoved(metrics: Metrics): number {
  const values = metrics.snapshot()
  return (values[BYTES_SENT_METRIC] ?? 0) + (values[BYTES_RECEIVED_METRIC] ?? 0)
}

/**
 * Fill the stable watermark: the minimum high-water mark per shard across the
 * local replica and every contactable peer (each contributing its last observed
 * map, or nothing when never contacted). A peer that does not hold a shard counts
 * as -1, so a shard is only "stable" once everyone has it; with no peer nothing
 * is confirmed. Returns how many shards are caught up.
 */
export function fillStableWatermark(
  target: Map<string, number>,
  local: readonly ShardSummary[],
  remotes: readonly ReadonlyMap<string, number>[],
): number {
  target.clear()
  const hasPeers = remotes.length > 0
  let replicated = 0
  for (const shard of local) {
    let minimum = hasPeers ? shard.maxSeq : -1
    for (const remote of remotes) {
      minimum = Math.min(minimum, remote.get(shard.node) ?? -1)
    }
    target.set(shard.node, minimum)
    if (hasPeers && minimum === shard.maxSeq) {
      replicated += 1
    }
  }
  return replicated
}

/**
 * Remove the replica of a departed node. Explicit and destructive: the operator has
 * decided the node will not come back and its writes are forfeited — the only thing
 * that frees a collection blocked on an absent node.
 */
async function discardDeparted(directory: string, departed: ReadonlySet<string>): Promise<void> {
  for (const node of departed) {
    if (!isSafeNodeId(node)) {
      continue
    }
    await rm(join(directory, shardName(node)), { force: true })
  }
}

interface CollectInput {
  readonly shardLog: ShardLog | undefined
  readonly membership: Membership
  readonly ignored: ReadonlySet<string>
  /** Peers exchanged with successfully this round, whose writes are merged locally. */
  readonly covered: ReadonlySet<string>
  readonly knowledge: PeerKnowledge
  readonly now: number
  readonly startedAt: number
  readonly metrics: Metrics
  readonly log: (message: string) => void
  /** The local replica's per-author high-water marks, to judge a peer's frontier against. */
  readonly local: Frontier
  /** Seconds of silence after which a peer is retired; `0` never retires. */
  readonly forgetAfterMs: number
  /** The peers with an `absent_seconds` series, carried across rounds so stale ones are removed. */
  readonly absence: Set<string>
}

/**
 * Retire the peers nothing has heard from for the window: materialise what they
 * protect, then drop their live record so it stops costing a round.
 *
 * Materialising is the whole point of the policy — bounding the durable metadata must
 * never weaken the gate — so a peer is retired into exactly the statement it was
 * making (`PLAN.md` — *Bounded retention*):
 *
 * - **accounted for** (its frontier is a subset of our high-water marks): its frontier
 *   is merged into the retired frontier, one elementwise maximum per author. The
 *   per-element decisions are unchanged, and the storage becomes one map bounded by
 *   the shards this node holds instead of one map per peer;
 * - **not accounted for** (it claims operations we cannot read): its frontier is not
 *   something we can verify, so it is replaced by a durable **blanket** — the same "it
 *   could hold anything" the gate already applied to it, now stated once instead of
 *   carried as an unverifiable map;
 * - **no record at all** (never reached): left alone, because there is nothing to
 *   materialise. A claimed-but-unreachable node stays the conservative blank it has
 *   always been; bounding that is a separate policy, recorded as future work.
 *
 * Retiring also takes the node out of membership: keeping it there would re-assert a
 * blank the gate must no longer read (`retainedPeers` unions membership with the
 * knowledge), which would quietly over-block the whole mesh.
 */
export function retireSilentPeers(input: RetireInput): void {
  if (input.forgetAfterMs <= 0) {
    return
  }
  for (const node of input.knowledge.nodes()) {
    const lastSeen = input.knowledge.lastSeen(node)
    if (lastSeen === undefined || input.now - lastSeen < input.forgetAfterMs) {
      continue
    }
    const frontier = withoutForfeited(
      input.knowledge.frontier(node) ?? EMPTY_SHARDS,
      input.forfeited,
    )
    if (exceedsLocal(frontier, input.local)) {
      input.knowledge.blanket(node)
      input.metrics?.counter(
        "noonien_gossip_retired_unaccounted_total",
        "Peers retired whose frontier could not be verified",
      )
      input.log?.(
        `retired ${node} with a blanket: it holds operations this node lacks, so it keeps blocking collection`,
      )
    } else {
      input.knowledge.retire(frontier)
      input.metrics?.counter("noonien_gossip_retired_total", "Peers retired into the frontier")
      input.log?.(`retired ${node} into the retired frontier`)
    }
    input.knowledge.forget(node)
    input.membership.discard(node)
  }
}

/** What a retirement reads and writes: the durable record, membership and our marks. */
export interface RetireInput {
  readonly knowledge: PeerKnowledge
  readonly membership: Membership
  /** This node's per-author high-water marks, to judge a frontier against. */
  readonly local: Frontier
  readonly now: number
  /** Seconds of silence after which a peer is retired; `0` never retires. */
  readonly forgetAfterMs: number
  /**
   * Node ids whose writes are forfeited (`NOONIEND_REVOKED` / `_DEPARTED`). Their author
   * entries are dropped before the frontier is judged — see {@link withoutForfeited} —
   * or a forfeited node would make every other peer look unaccounted and blanket the mesh.
   */
  readonly forfeited: ReadonlySet<string>
  readonly metrics?: Metrics
  readonly log?: (message: string) => void
}

/**
 * Collect the shard this node authors, gated per element on what the peers off the
 * mesh could still hold.
 *
 * A tombstone may be dropped when no off-mesh peer could hold an unseen operation
 * on its element that it is *causally aware of*: a peer contests an element only
 * after folding it, so a peer that never folded the element can only mint a
 * coincident one, a concurrent genesis the fold decides — an element that
 * appeared while that peer was already away is collectable at once. A reachable peer
 * the round did not exchange with suspends collection entirely, since it may hold
 * writes this node has not pulled. The off-mesh peers' frontiers are durable, so a
 * machine gone for a year keeps blocking only the elements it knew; the gating set is
 * the membership's known and forgotten peers **plus every peer ever exchanged with**,
 * so a membership drop cannot silently unblock a deletion. How long each peer has been
 * away and how many elements stay frozen are published as metrics.
 */
async function collect(input: CollectInput): Promise<void> {
  // Retire before the sets below are computed: a retired peer is no longer a live
  // participant, and its protection already lives in the durable forms the gate reads.
  retireSilentPeers({
    knowledge: input.knowledge,
    membership: input.membership,
    local: input.local,
    now: input.now,
    forgetAfterMs: input.forgetAfterMs,
    forfeited: input.ignored,
    metrics: input.metrics,
    log: input.log,
  })
  const retained = retainedPeers(input.membership.retainedNodes(), input.knowledge.nodes())
  const blockers = retained.filter((node) => !input.ignored.has(node))
  const pending = blockers.filter((node) => !input.covered.has(node))
  const known = new Set(input.membership.known().map((entry) => entry.node))
  const state = meshState({
    pending,
    reachable: (node) => known.has(node) && input.membership.healthOf(node) !== "dead",
    // Forfeited authors are dropped from every frontier the gate reads, so a revoked or
    // departed node stops holding the collection back through the peers that hold its
    // replica (see `withoutForfeited`).
    frontier: (node) => {
      const frontier = input.knowledge.frontier(node)
      return frontier === undefined ? undefined : withoutForfeited(frontier, input.ignored)
    },
    retired: withoutForfeited(input.knowledge.retiredFrontier(), input.ignored),
    blanket: input.knowledge.blanketCount() > 0,
    local: input.local,
  })
  input.metrics.gauge(
    "noonien_gossip_retained_peers",
    "Peers whose knowledge still gates collection",
    retained.length,
  )
  input.metrics.gauge(
    "noonien_gossip_retired_authors",
    "Authors whose thresholds survive in the retired frontier",
    input.knowledge.retiredFrontier().size,
  )
  input.metrics.gauge(
    "noonien_gossip_blankets",
    "Durable blankets in force (a retired peer that could hold anything)",
    input.knowledge.blanketCount(),
  )
  publishAbsence(input, blockers)
  if (input.shardLog === undefined) {
    return
  }
  try {
    const result = await input.shardLog.gc(collectionGuard(state))
    input.metrics.gauge(
      "noonien_gossip_frozen_elements",
      "Deleted elements kept because a peer off the mesh may still contest them",
      result.frozen,
    )
  } catch (error) {
    input.log(`gc failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Publish, per retained peer, how long it has been away, and how many are absent. */
function publishAbsence(input: CollectInput, retained: readonly string[]): void {
  const current = new Set(retained)
  // A peer no longer retained must not keep a series in `/metrics` forever.
  for (const node of input.absence) {
    if (!current.has(node)) {
      input.metrics.remove("noonien_gossip_absent_seconds", { node })
    }
  }
  input.absence.clear()
  let absent = 0
  for (const node of retained) {
    input.absence.add(node)
    const away = !input.covered.has(node)
    if (away) {
      absent += 1
    }
    const lastSeen = input.knowledge.lastSeen(node) ?? input.startedAt
    input.metrics.gauge(
      "noonien_gossip_absent_seconds",
      "Seconds since the last successful exchange with a peer",
      away ? Math.max(0, (input.now - lastSeen) / 1000) : 0,
      { node },
    )
  }
  input.metrics.gauge(
    "noonien_gossip_absent_nodes",
    "Peers not exchanged with in the last round",
    absent,
  )
}

async function resolveSeeds(
  seeds: readonly Seed[],
  selfNode: string,
  membership: Membership,
  transportFor: (address: string) => PeerTransport,
  resolved: Set<string>,
): Promise<void> {
  for (const seed of seeds) {
    if (seed.node !== undefined || resolved.has(seed.address)) {
      continue
    }
    try {
      const info = await transportFor(seed.address).info()
      if (info.node !== selfNode) {
        membership.merge([{ node: info.node, address: seed.address, version: info.version }], true)
      }
      resolved.add(seed.address)
    } catch {
      // An unreachable seed is retried on the next round; membership spreads.
    }
  }
}

function watchDirectory(
  directory: string,
  fileName: string,
  onChange: () => void,
): Watcher | undefined {
  try {
    let debounce: NodeJS.Timeout | undefined
    const watcher: FSWatcher = watch(directory, (_event, changed) => {
      if (changed !== null && changed !== fileName) {
        return
      }
      if (debounce !== undefined) {
        clearTimeout(debounce)
      }
      debounce = setTimeout(onChange, 250)
    })
    watcher.on("error", () => undefined)
    return {
      close: () => {
        if (debounce !== undefined) {
          clearTimeout(debounce)
        }
        watcher.close()
      },
    }
  } catch {
    return undefined
  }
}

function loadTls(config: GossipConfig): Tls | undefined {
  if (config.tls === undefined) {
    return undefined
  }
  const cert = readFileSync(config.tls.cert)
  const key = readFileSync(config.tls.key)
  const ca = config.tls.ca === undefined ? undefined : readFileSync(config.tls.ca)
  return {
    server: { cert, key, ca, requireClient: config.tls.requireClient },
    // Always verify the peer's certificate. Without a configured CA the system trust
    // store applies; accepting any certificate would silently downgrade the very
    // channel that authenticates the mesh (MITM).
    client: { cert, key, ca, rejectUnauthorized: true },
  }
}
