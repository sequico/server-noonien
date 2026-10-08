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

/** Turn a `tailscale status --json` document into seeds. */
export function parseTailscaleStatus(status: unknown, port: number): Seed[] {
  const peers = asRecord(asRecord(status)?.["Peer"])
  if (peers === undefined) {
    return []
  }
  const seeds: Seed[] = []
  for (const value of Object.values(peers)) {
    const peer = asRecord(value)
    const node = asString(peer?.["HostName"])
    const ip = asStringArray(peer?.["TailscaleIPs"])?.[0]
    if (node !== undefined && ip !== undefined) {
      // Route through `withPort` so an IPv6-first peer is bracketed, not glued into
      // an unusable `addr:port` string.
      seeds.push({ node, address: withPort(ip, port) })
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

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? (value as string[])
    : undefined
}
