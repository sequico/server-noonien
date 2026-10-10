// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFile } from "node:child_process"
import { resolveSrv } from "node:dns/promises"
import { promisify } from "node:util"
import { withPort } from "./address.js"
import type { Seed } from "./types.js"

const execFileAsync = promisify(execFile)

export interface BootstrapOptions {
  readonly staticPeers: string | undefined
  readonly dnsSrvDomain: string | undefined
  readonly tailscale: boolean
  /** Port to append to a seed address that carries none. */
  readonly port: number
}

/** Seed service name used for the DNS SRV adapter. */
export const SRV_SERVICE = "_nooniend._tcp"

/**
 * Discovery adapters only return an initial peer list; membership then
 * self-propagates. Every adapter is optional and best-effort: a failing one
 * never stops the others.
 */
export async function collectSeeds(options: BootstrapOptions): Promise<Seed[]> {
  const { staticPeers, dnsSrvDomain, tailscale, port } = options
  const groups: Seed[][] = []
  if (staticPeers !== undefined) {
    groups.push(parseStaticPeers(staticPeers, port))
  }
  if (dnsSrvDomain !== undefined) {
    groups.push(await bestEffort(() => dnsSrvSeeds(dnsSrvDomain, port)))
  }
  if (tailscale) {
    groups.push(await bestEffort(() => tailscaleSeeds(port)))
  }
  return dedupeByAddress(groups.flat())
}

async function bestEffort(load: () => Promise<Seed[]>): Promise<Seed[]> {
  try {
    return await load()
  } catch {
    return []
  }
}

/** Consecutive probe failures for one candidate, and when its next probe is due. */
interface ProbeBackoff {
  readonly fails: number
  readonly nextAt: number
}

/**
 * Discovery **candidates**: addresses proposed by a discovery source that have not
 * completed an identity handshake yet. A candidate becomes a member only once it
 * answers `/info`, and its node id is taken from that answer — never from the
 * discovery source — so a device that does not run `nooniend` never joins the mesh
 * and never blocks collection. A candidate that does not answer is retried on an
 * exponential backoff (`baseMs`, doubling, capped at `capMs`), so such a device costs
 * at most one probe per cap while a node that comes up later is adopted on its next
 * due probe. Discoverability is preserved: the source is re-read on every refresh and
 * a candidate that starts answering joins at once.
 */
export class Candidates {
  private readonly pending = new Set<string>()
  private readonly resolved = new Set<string>()
  private readonly backoff = new Map<string, ProbeBackoff>()
  private readonly baseMs: number
  private readonly capMs: number

  constructor(baseMs: number, capMs: number) {
    this.baseMs = baseMs
    this.capMs = capMs
  }

  /** Add addresses from a discovery refresh; one already resolved is kept out. */
  add(addresses: Iterable<string>): void {
    for (const address of addresses) {
      if (!this.resolved.has(address)) {
        this.pending.add(address)
      }
    }
  }

  /** The candidates whose probe is due at `now`, in a deterministic order. */
  due(now: number): string[] {
    const due: string[] = []
    for (const address of this.pending) {
      const backoff = this.backoff.get(address)
      if (backoff === undefined || backoff.nextAt <= now) {
        due.push(address)
      }
    }
    return due.sort()
  }

  /** The candidate answered and is a member from now on. */
  adopted(address: string): void {
    this.pending.delete(address)
    this.backoff.delete(address)
    this.resolved.add(address)
  }

  /** The candidate did not answer: back its next probe off from `now`. */
  failed(address: string, now: number): void {
    const fails = (this.backoff.get(address)?.fails ?? 0) + 1
    const delay = Math.min(this.capMs, this.baseMs * 2 ** (fails - 1))
    this.backoff.set(address, { fails, nextAt: now + delay })
  }

  /** Candidates still waiting to answer. */
  get size(): number {
    return this.pending.size
  }
}

/** Parse the static seed list: `node@host:port` or `host:port`, comma separated. */
export function parseStaticPeers(value: string, port: number): Seed[] {
  const seeds: Seed[] = []
  for (const token of value.split(/[,\s]+/)) {
    const trimmed = token.trim()
    if (trimmed === "") {
      continue
    }
    const at = trimmed.indexOf("@")
    const node = at > 0 ? trimmed.slice(0, at) : undefined
    const address = at > 0 ? trimmed.slice(at + 1) : trimmed
    seeds.push({ node, address: withPort(address, port) })
  }
  return seeds
}

/** Turn SRV records into seeds (node id resolved later via `/info`). */
export function parseSrvRecords(
  records: readonly { readonly name: string; readonly port: number }[],
  port: number,
): Seed[] {
  return records.map((record) => ({
    node: undefined,
    address: withPort(record.name, record.port || port),
  }))
}

/**
 * Turn a `tailscale status --json` document into discovery **candidates** (addresses
 * only). The host name is deliberately not taken as a node id: a tailnet peer becomes
 * a member only once it answers `/info`, and its id is taken from that answer (see
 * {@link Candidates}). A device on the tailnet that does not run `nooniend` is
 * therefore never adopted, while a node that comes up later is.
 */
export function parseTailscaleStatus(status: unknown, port: number): Seed[] {
  const peers = asRecord(asRecord(status)?.["Peer"])
  if (peers === undefined) {
    return []
  }
  const seeds: Seed[] = []
  for (const value of Object.values(peers)) {
    const peer = asRecord(value)
    const ip = asStringArray(peer?.["TailscaleIPs"])?.[0]
    if (ip !== undefined) {
      // Route through `withPort` so an IPv6-first peer is bracketed, not glued into
      // an unusable `addr:port` string.
      seeds.push({ node: undefined, address: withPort(ip, port) })
    }
  }
  return seeds
}

async function dnsSrvSeeds(domain: string, port: number): Promise<Seed[]> {
  const records = await resolveSrv(`${SRV_SERVICE}.${domain}`)
  return parseSrvRecords(records, port)
}

async function tailscaleSeeds(port: number): Promise<Seed[]> {
  const { stdout } = await execFileAsync("tailscale", ["status", "--json"], {
    maxBuffer: 8 * 1024 * 1024,
  })
  return parseTailscaleStatus(JSON.parse(stdout), port)
}

function dedupeByAddress(seeds: readonly Seed[]): Seed[] {
  const byAddress = new Map<string, Seed>()
  for (const seed of seeds) {
    const current = byAddress.get(seed.address)
    if (current === undefined || (current.node === undefined && seed.node !== undefined)) {
      byAddress.set(seed.address, seed)
    }
  }
  return [...byAddress.values()]
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? (value as string[])
    : undefined
}
