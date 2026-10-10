// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { hostname } from "node:os"
import { loadConfig } from "../config.js"
import { parseFlag, parseInteger } from "../env.js"
import { formatHostPort, parseHostPort } from "./address.js"

/** Default TCP port for the gossip service. */
export const DEFAULT_GOSSIP_PORT = 7878

/**
 * Default retention window: 180 days. Long enough that only a node genuinely gone is
 * retired, short enough that the durable metadata a collection depends on stays
 * bounded by what is actually reachable (see `README.md` *Deletion and collection*).
 */
const DEFAULT_FORGET_AFTER = 180 * 24 * 60 * 60

/**
 * Default discovery refresh: five minutes. Long enough that re-reading the discovery
 * sources (an exec for Tailscale) stays rare, short enough that a node joining the
 * network is found without a restart.
 */
const DEFAULT_DISCOVER_INTERVAL = 300

export interface GossipTlsConfig {
  readonly cert: string
  readonly key: string
  readonly ca: string | undefined
  readonly requireClient: boolean
}

export interface GossipConfig {
  readonly directory: string
  readonly nodeId: string
  readonly listenHost: string
  readonly listenPort: number
  readonly advertise: string
  readonly staticPeers: string | undefined
  readonly dnsSrvDomain: string | undefined
  readonly tailscale: boolean
  /**
   * How often the discovery sources are re-read, in milliseconds. `0` reads them once
   * at startup only. A refresh never drops a member: it adds new candidates, which are
   * adopted on the identity handshake (see `Candidates`).
   */
  readonly discoverIntervalMs: number
  readonly intervalMs: number
  readonly suspectAfter: number
  readonly deadAfter: number
  readonly deadRetryMs: number
  readonly membershipTtlMs: number
  readonly push: boolean
  readonly revoked: ReadonlySet<string>
  /** Peers contacted per anti-entropy round (0 = every contactable peer, the full mesh). */
  readonly fanout: number
  /** Shard count at or above which the compact digest replaces the full shard list. */
  readonly digestMinShards: number
  /** Gossip membership on its own channel instead of piggybacking it on every exchange. */
  readonly channels: boolean
  /** Node ids always included in the sample, so they act as relays / super-peers. */
  readonly relay: ReadonlySet<string>
  /**
   * Collect the local shard: prune the operations a later one shadows and, once
   * every peer's shard is fully up to date, drop the surviving tombstones so a
   * deletion becomes physical. Only the shard this node authors is rewritten.
   */
  readonly gc: boolean
  /**
   * Silences after which a peer is **retired**: its protection is materialised (a
   * retired threshold, or a blanket when it holds operations this node lacks) and its
   * live record is dropped, so the durable metadata stays bounded — without ever
   * weakening the gate (see `README.md` *Deletion and collection*). `0` never retires.
   */
  readonly forgetAfterMs: number
  /**
   * Node ids explicitly departed: their writes are forfeited. The daemon discards
   * their replica, refuses them on every route and stops blocking collection on
   * them — the one explicit way to let a node that will not come back stop holding a
   * deletion hostage.
   */
  readonly departed: ReadonlySet<string>
  readonly tls: GossipTlsConfig | undefined
}

/**
 * Resolve the gossip configuration from the environment.
 *
 * The daemon replicates a **directory**, so `NOONIEN_BACKEND` must be `file` (its
 * default): `memory` and `s3` are refused rather than silently replicating a local
 * folder the server never uses.
 *
 * - `NOONIEND_LISTEN` — `host:port` to bind, default `0.0.0.0:7878`.
 * - `NOONIEND_ADVERTISE` — `host:port` this node advertises, default from
 *   the listen host (or the hostname when the bind is a wildcard).
 * - `NOONIEND_PEERS` — static seed list, `node@host:port` or `host:port`.
 * - `NOONIEND_DNS_SRV` — domain whose `_nooniend._tcp` SRV records
 *   are the seeds.
 * - `NOONIEND_TAILSCALE` — discover seeds from `tailscale status`.
 * - `NOONIEND_DISCOVER_INTERVAL` — seconds between discovery refreshes (default 300;
 *   `0` reads the discovery sources once at startup). A refresh only adds candidates;
 *   a candidate is adopted once it answers `/info`.
 * - `NOONIEND_INTERVAL` — anti-entropy period in seconds (default 30).
 * - `NOONIEND_SUSPECT_AFTER` / `_DEAD_AFTER` — failed exchanges that mark
 *   a peer suspect (3) and dead (6).
 * - `NOONIEND_DEAD_RETRY` — seconds a dead peer is left alone before it is
 *   probed again (default 300).
 * - `NOONIEND_MEMBERSHIP_TTL` — seconds a dead peer is kept before it is
 *   forgotten entirely (default 604800, one week).
 * - `NOONIEND_REVOKED` — comma-separated node ids refused on every route
 *   (a revoked peer's certificate is rejected; the daemon does not sync with it).
 * - `NOONIEND_FANOUT` — peers contacted per round; `0` (default) is every
 *   contactable peer, above it a random subset of that size (the adaptive
 *   topology).
 * - `NOONIEND_DIGEST_MIN_SHARDS` — shard count at or above which the
 *   compact digest replaces the full shard list (default 32; `0` always uses the
 *   digest when the peer supports it).
 * - `NOONIEND_CHANNELS` — gossip membership on its own channel instead of
 *   piggybacking the peer list on every data exchange (default off).
 * - `NOONIEND_RELAY` — comma-separated node ids of a relay / super-peer
 *   that every node always samples.
 * - `NOONIEND_GC` — collect the local shard: prune the operations a later one
 *   shadows and drop a tombstone once no peer off the mesh could hold an unseen
 *   operation on its element, so a deletion becomes physical (default on; with no
 *   peers it is immediate). Only the authored shard is rewritten; peers adopt it
 *   through the compaction generation.
 * - `NOONIEND_DEPARTED` — comma-separated node ids explicitly departed: their
 *   replica is discarded, they are refused on every route and they stop blocking
 *   collection. A node that is merely absent keeps blocking it, because it may be
 *   alive off-mesh with valid unsent writes.
 * - `NOONIEND_FORGET_AFTER` — seconds of silence after which a retained peer is
 *   **retired** (default 180 days; `0` never). Retirement is semantically invisible:
 *   an accounted peer's frontier is merged into the durable *retired frontier* (the
 *   same per-element decisions, one map bounded by the shards this node holds) and an
 *   unaccounted peer leaves a durable *blanket*. Nothing is forfeited — that stays
 *   `NOONIEND_DEPARTED` — so this only bounds the metadata the gate depends on.
 * - `NOONIEND_TLS_CERT` / `_KEY` / `_CA` / `_REQUIRE_CLIENT` — enable TLS;
 *   a client certificate is required by default (mTLS).
 */
export function loadGossipConfig(env: NodeJS.ProcessEnv = process.env): GossipConfig {
  const base = loadConfig(env)
  // The daemon replicates a **directory**: it has no object-store backend, so with
  // `NOONIEN_BACKEND=s3` (or `memory`) it would replicate a local folder the server
  // never uses — doing nothing, silently, with no watchful eye on it. Refuse instead.
  if (base.backend !== "file") {
    throw new Error(
      `NOONIEND replicates a shard directory, but NOONIEN_BACKEND is "${base.backend}": ` +
        "set NOONIEN_BACKEND=file (or leave it unset)",
    )
  }
  const { host: listenHost, port: listenPort } = parseHostPort(
    env["NOONIEND_LISTEN"],
    "0.0.0.0",
    DEFAULT_GOSSIP_PORT,
  )
  const wildcard = listenHost === "0.0.0.0" || listenHost === "::" || listenHost === ""
  const advertise =
    env["NOONIEND_ADVERTISE"]?.trim() ||
    formatHostPort(wildcard ? hostname() : listenHost, listenPort)
  const suspectAfter = parseInteger(env["NOONIEND_SUSPECT_AFTER"], 3, "NOONIEND_SUSPECT_AFTER")
  const deadAfter = parseInteger(env["NOONIEND_DEAD_AFTER"], 6, "NOONIEND_DEAD_AFTER")
  if (deadAfter < suspectAfter) {
    throw new Error("NOONIEND_DEAD_AFTER must be >= NOONIEND_SUSPECT_AFTER")
  }
  const gc = parseFlag(env["NOONIEND_GC"], true, "NOONIEND_GC")
  const fanout = parseInteger(env["NOONIEND_FANOUT"], 0, "NOONIEND_FANOUT", 0)
  // A reachable peer the round did not sample *suspends* the collection, so a fanout cap
  // and tombstone collection cannot coexist: with fewer peers sampled than reachable,
  // some peer is unsampled every round and the collection would never run. Refuse the
  // combination instead of shipping it inert. (Collection is gated on a *stable round*
  // over the live set; over the peer history it needs no barrier — which is what the
  // knowledge frontier is for.)
  if (gc && fanout > 0) {
    throw new Error(
      "NOONIEND_FANOUT > 0 excludes tombstone collection: a reachable peer the round " +
        "did not sample suspends it. Set NOONIEND_FANOUT=0, or turn collection off " +
        "with NOONIEND_GC=false.",
    )
  }
  return {
    directory: base.directory,
    nodeId: base.nodeId,
    listenHost,
    listenPort,
    advertise,
    staticPeers: nonEmpty(env["NOONIEND_PEERS"]),
    dnsSrvDomain: nonEmpty(env["NOONIEND_DNS_SRV"]),
    tailscale: parseFlag(env["NOONIEND_TAILSCALE"], false, "NOONIEND_TAILSCALE"),
    discoverIntervalMs: parseDiscoverInterval(env["NOONIEND_DISCOVER_INTERVAL"]),
    intervalMs: parseSeconds(env["NOONIEND_INTERVAL"], 30, "NOONIEND_INTERVAL"),
    suspectAfter,
    deadAfter,
    deadRetryMs: parseSeconds(env["NOONIEND_DEAD_RETRY"], 300, "NOONIEND_DEAD_RETRY"),
    membershipTtlMs: parseSeconds(
      env["NOONIEND_MEMBERSHIP_TTL"],
      604_800,
      "NOONIEND_MEMBERSHIP_TTL",
    ),
    push: parseFlag(env["NOONIEND_PUSH"], true, "NOONIEND_PUSH"),
    revoked: parseNodeList(env["NOONIEND_REVOKED"]),
    fanout,
    digestMinShards: parseInteger(
      env["NOONIEND_DIGEST_MIN_SHARDS"],
      32,
      "NOONIEND_DIGEST_MIN_SHARDS",
      0,
    ),
    channels: parseFlag(env["NOONIEND_CHANNELS"], false, "NOONIEND_CHANNELS"),
    relay: parseNodeList(env["NOONIEND_RELAY"]),
    gc,
    forgetAfterMs: parseWindow(env["NOONIEND_FORGET_AFTER"]),
    departed: parseNodeList(env["NOONIEND_DEPARTED"]),
    tls: parseTls(env),
  }
}

function parseTls(env: NodeJS.ProcessEnv): GossipTlsConfig | undefined {
  const cert = nonEmpty(env["NOONIEND_TLS_CERT"])
  const key = nonEmpty(env["NOONIEND_TLS_KEY"])
  if (cert === undefined && key === undefined) {
    return undefined
  }
  if (cert === undefined || key === undefined) {
    throw new Error("TLS needs both NOONIEND_TLS_CERT and NOONIEND_TLS_KEY")
  }
  return {
    cert,
    key,
    ca: nonEmpty(env["NOONIEND_TLS_CA"]),
    requireClient: parseFlag(
      env["NOONIEND_TLS_REQUIRE_CLIENT"],
      true,
      "NOONIEND_TLS_REQUIRE_CLIENT",
    ),
  }
}

/** The largest gap a Node timer can hold, in seconds (2^31-1 ms). */
const MAX_TIMER_SECONDS = Math.floor(2_147_483_647 / 1000)

/**
 * Parse a duration given in seconds into milliseconds, rejecting a value so large
 * that its millisecond form overflows a Node timer (which would clamp the interval
 * to 1 ms and spin the loop).
 */
function parseSeconds(value: string | undefined, fallback: number, name: string): number {
  const seconds = parseInteger(value, fallback, name)
  if (seconds > MAX_TIMER_SECONDS) {
    throw new Error(`${name} is too large: at most ${MAX_TIMER_SECONDS} seconds`)
  }
  return seconds * 1000
}

/**
 * Parse the retention window, in seconds (`0` disables retirement). It is never handed
 * to a timer — it is compared against a stored timestamp — so the timer-overflow guard
 * above does not apply and 180 days is an ordinary value.
 */
function parseWindow(value: string | undefined): number {
  return parseInteger(value, DEFAULT_FORGET_AFTER, "NOONIEND_FORGET_AFTER", 0) * 1000
}

/**
 * Parse the discovery refresh interval, in seconds (`0` = read the sources once at
 * startup). It is compared against elapsed milliseconds, not handed to a timer, so the
 * timer-overflow guard above does not apply.
 */
function parseDiscoverInterval(value: string | undefined): number {
  return parseInteger(value, DEFAULT_DISCOVER_INTERVAL, "NOONIEND_DISCOVER_INTERVAL", 0) * 1000
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === "" ? undefined : trimmed
}

/** A comma-separated list of node ids. */
function parseNodeList(value: string | undefined): ReadonlySet<string> {
  const trimmed = value?.trim()
  if (trimmed === undefined || trimmed === "") {
    return new Set()
  }
  return new Set(
    trimmed
      .split(",")
      .map((node) => node.trim())
      .filter((node) => node !== ""),
  )
}
