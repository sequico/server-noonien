// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { access, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { isNotFound } from "../errors.js"
import { isSafeNodeId } from "../sync/backend.js"

/** The durable knowledge file the daemon writes inside the shard directory. */
export const PEERS_FILE = ".nooniend-peers.json"

/**
 * Reserved keys of the knowledge file, holding the durable protection that outlives
 * the peers that produced it. They can never collide with a peer record: a node id
 * may not contain `@` (`isSafeNodeId`), and the loader already drops any key that is
 * not a safe node id — so the peer loop reads them as "not a peer" and never throws.
 *
 * - `RETIRED_KEY` — the **retired frontier**: `author → greatest sequence`, the
 *   elementwise maximum over the peers whose retention window expired. See
 *   `PLAN.md` (*Bounded retention*) for why the *comparison* is kept rather than the
 *   elements it once covered.
 * - `BLANKETS_KEY` — the node ids whose protection is "it could hold anything": a
 *   retired peer that was not accounted for, so its frontier could not be verified.
 */
const RETIRED_KEY = "@retired"
const BLANKETS_KEY = "@blankets"

/** The path of the durable knowledge file inside a shard directory. */
export function peersPath(directory: string): string {
  return join(directory, PEERS_FILE)
}

/** True when a daemon has written its knowledge file in this directory. */
export async function hasPeerKnowledge(directory: string): Promise<boolean> {
  try {
    await access(peersPath(directory))
    return true
  } catch (error) {
    if (isNotFound(error)) {
      return false
    }
    throw error
  }
}

/** One peer's durable record: when it was last reached and what it held then. */
interface PeerState {
  lastSeen: number
  shards: Map<string, number>
}

/** The serialized shape of one peer in {@link PeerKnowledge}. */
interface StoredPeer {
  readonly lastSeen: number
  readonly shards: Record<string, number>
}

/** True when a parsed entry has the shape of a stored peer record. */
function isStoredPeer(value: unknown): value is StoredPeer {
  if (typeof value !== "object" || value === null) {
    return false
  }
  const { lastSeen, shards } = value as { lastSeen?: unknown; shards?: unknown }
  if (typeof lastSeen !== "number" || !Number.isFinite(lastSeen)) {
    return false
  }
  if (typeof shards !== "object" || shards === null || Array.isArray(shards)) {
    return false
  }
  return Object.values(shards).every((seq) => typeof seq === "number" && Number.isFinite(seq))
}

/**
 * Read the retired frontier, failing loudly on a malformed one. Unlike a peer record —
 * which, dropped, only conservatively keeps blocking — a dropped threshold would
 * *unblock* an element a retired peer could still contest, so a corrupt reserved key
 * stops the daemon instead of being ignored.
 */
function parseRetired(value: unknown, path: string): Map<string, number> {
  const retired = new Map<string, number>()
  if (value === undefined) {
    return retired
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`corrupt peer knowledge file ${path}: ${RETIRED_KEY} is not an object`)
  }
  for (const [author, seq] of Object.entries(value as Record<string, unknown>)) {
    if (!isSafeNodeId(author) || typeof seq !== "number" || !Number.isFinite(seq)) {
      throw new Error(`corrupt peer knowledge file ${path}: ${RETIRED_KEY} has an invalid entry`)
    }
    retired.set(author, seq)
  }
  return retired
}

/** Read the durable blanket markers, failing loudly on a malformed value (see above). */
function parseBlankets(value: unknown, path: string): Set<string> {
  const blankets = new Set<string>()
  if (value === undefined) {
    return blankets
  }
  if (!Array.isArray(value)) {
    throw new Error(`corrupt peer knowledge file ${path}: ${BLANKETS_KEY} is not an array`)
  }
  for (const node of value) {
    if (typeof node !== "string" || !isSafeNodeId(node)) {
      throw new Error(`corrupt peer knowledge file ${path}: ${BLANKETS_KEY} has an invalid entry`)
    }
    blankets.add(node)
  }
  return blankets
}

/**
 * The durable per-peer knowledge frontier: for every peer this node has exchanged
 * with, the time it happened and the greatest sequence it has been seen to hold of
 * each author's shard.
 *
 * A shard has a single writer, so a per-author high-water mark is a version
 * vector: `frontier(author) >= seq` means the peer holds every operation of
 * `author` up to `seq`. Collection consults it to decide whether an absent peer
 * could still hold an unseen operation on an element — a peer contests an element
 * only after folding it, so a peer whose frontier covers no operation of the
 * element can only mint a coincident one, a concurrent genesis the fold decides,
 * not a causally aware competitor. The
 * record is persisted because the peers that block collection are exactly the ones
 * gone the longest, across daemon restarts.
 */
export class PeerKnowledge {
  private readonly path: string
  private readonly peers = new Map<string, PeerState>()
  /**
   * The retired frontier: the elementwise maximum per author of the frontiers of the
   * peers whose retention window expired. Durable, because a restart must not lose the
   * protection it carries. Replaced wholesale by the loader.
   */
  private retired = new Map<string, number>()
  /** Node ids whose protection is a durable blanket: a retired, unaccounted peer. */
  private blankets = new Set<string>()

  private constructor(path: string) {
    this.path = path
  }

  /** Read the record from disk; an absent file is an empty record. */
  static async load(path: string): Promise<PeerKnowledge> {
    const knowledge = new PeerKnowledge(path)
    let text: string
    try {
      text = await readFile(path, "utf8")
    } catch (error) {
      if (isNotFound(error)) {
        return knowledge
      }
      throw error
    }
    if (text.trim() === "") {
      return knowledge
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      // A corrupt record is not silently read as empty: forgetting the frontier
      // could let collection drop a tombstone a peer still needs. Fail loudly.
      throw new Error(`corrupt peer knowledge file ${path}: not valid JSON`)
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`corrupt peer knowledge file ${path}: not a JSON object`)
    }
    for (const [node, state] of Object.entries(parsed as Record<string, unknown>)) {
      // An entry with an unsafe node id or a malformed frontier is dropped: with no
      // frontier the node conservatively blocks collection, never unblocks it.
      if (!isSafeNodeId(node) || !isStoredPeer(state)) {
        continue
      }
      knowledge.peers.set(node, {
        lastSeen: state.lastSeen,
        shards: new Map(Object.entries(state.shards)),
      })
    }
    const record = parsed as Record<string, unknown>
    knowledge.retired = parseRetired(record[RETIRED_KEY], path)
    knowledge.blankets = parseBlankets(record[BLANKETS_KEY], path)
    return knowledge
  }

  /**
   * Record the frontier a peer reported and the time it was reached. The stored
   * frontier is the **greatest** ever seen per author: once a peer is known to have
   * held an operation it keeps counting as a possible author of a competing one —
   * even after it compacts it away — so a later, smaller report cannot erase the
   * knowledge (a peer that once knew an element may still have written on it).
   */
  record(node: string, shards: ReadonlyMap<string, number>, now: number): void {
    const merged = new Map(this.peers.get(node)?.shards ?? [])
    for (const [author, seq] of shards) {
      if (seq > (merged.get(author) ?? -1)) {
        merged.set(author, seq)
      }
    }
    this.peers.set(node, { lastSeen: now, shards: merged })
  }

  /**
   * Fold a retired peer's frontier into the **retired frontier**, the elementwise
   * maximum per author. The maximum is exactly the union of the per-element decisions
   * the peers would have made — `collectable` asks "does *any* frontier cover an
   * operation of the element?" — so retiring a peer changes where the thresholds live,
   * never which elements are guarded. Two consequences worth stating:
   *
   * - it covers **future** deletions too, because the comparison is kept rather than a
   *   snapshot of its outcome at expiry time (`PLAN.md`);
   * - it is permanent: a maximum cannot be un-merged, so a node must be departed
   *   *before* its window expires if its contribution must be lifted.
   */
  retire(frontier: ReadonlyMap<string, number>): void {
    for (const [author, seq] of frontier) {
      if (seq > (this.retired.get(author) ?? -1)) {
        this.retired.set(author, seq)
      }
    }
  }

  /**
   * Record that a retired peer's holdings could be anything: it was not accounted for,
   * so its frontier could not be verified and must not be merged. The statement the
   * gate applies — "it could hold a relayed operation on any element" — is preserved
   * durably, while the unverifiable frontier itself is dropped.
   */
  blanket(node: string): void {
    this.blankets.add(node)
  }

  /** The retired frontier, elementwise-maximum per author. */
  retiredFrontier(): ReadonlyMap<string, number> {
    return this.retired
  }

  /** How many durable blankets are in force; more than zero blocks every element. */
  blanketCount(): number {
    return this.blankets.size
  }

  /**
   * Drop a peer's live record. Used when a peer is **retired**: its protection has
   * been materialised (into the retired frontier or a blanket), so the record — which
   * is what cost a per-round lookup and a metric series — is no longer needed.
   */
  forget(node: string): void {
    this.peers.delete(node)
  }

  /**
   * Drop everything a node left behind: its live record **and** its blanket. This is
   * the explicit departure (`NOONIEND_REVOKED` / `NOONIEND_DEPARTED`), the one place
   * an operator accepts that the node's writes are expendable. The retired frontier is
   * deliberately not touched — see {@link retire}.
   */
  depart(node: string): void {
    this.peers.delete(node)
    this.blankets.delete(node)
  }

  /** What a peer held at the last exchange, or `undefined` when never reached. */
  frontier(node: string): ReadonlyMap<string, number> | undefined {
    return this.peers.get(node)?.shards
  }

  /** When a peer was last reached, or `undefined` when never reached. */
  lastSeen(node: string): number | undefined {
    return this.peers.get(node)?.lastSeen
  }

  /** Every peer this node has ever exchanged with. */
  nodes(): string[] {
    return [...this.peers.keys()]
  }

  /** Persist atomically, so a crash cannot leave a half-written record. */
  async save(): Promise<void> {
    // Object.fromEntries creates own properties, so a peer literally named
    // "__proto__" is written instead of mutating the record's prototype and
    // vanishing from the file (dropping its frontier and unblocking a deletion).
    const stored: Record<string, unknown> = Object.fromEntries(
      [...this.peers].map(([node, state]) => [
        node,
        { lastSeen: state.lastSeen, shards: Object.fromEntries(state.shards) },
      ]),
    )
    // The reserved keys are written only when they carry something, so a single-node
    // directory keeps the file it always had.
    if (this.retired.size > 0) {
      stored[RETIRED_KEY] = Object.fromEntries(this.retired)
    }
    if (this.blankets.size > 0) {
      stored[BLANKETS_KEY] = [...this.blankets].sort()
    }
    const temp = `${this.path}.tmp`
    await writeFile(temp, `${JSON.stringify(stored)}\n`)
    await rename(temp, this.path)
  }
}
