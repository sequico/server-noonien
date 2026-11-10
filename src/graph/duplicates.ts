// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Entity } from "./types.js"

const WORD = /[\p{L}\p{N}]+/gu

/** Suffixes that say what a thing is, not which one it is (`nooniend.service`). */
const SUFFIXES = new Set(["service", "server", "daemon", "svc"])

/**
 * A name reduced to what identifies it: lowercased, diacritics stripped, punctuation
 * collapsed to spaces, and a trailing `service`/`server`/`daemon` dropped. Names empty
 * when normalised fall back to their lowercased text, so two empty labels cannot look
 * alike for the wrong reason.
 */
export function normaliseName(name: string): string {
  const text = name
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
  const words = text.match(WORD) ?? []
  while (words.length > 1 && SUFFIXES.has(words[words.length - 1] ?? "")) {
    words.pop()
  }
  return words.length > 0 ? words.join(" ") : name.toLowerCase()
}

/** The set of words a text contains, for a Jaccard comparison. */
export function tokenSet(text: string): Set<string> {
  return new Set(text.toLowerCase().match(WORD) ?? [])
}

/** How much two word sets overlap: 0 when either is empty. */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0
  }
  let shared = 0
  for (const token of a) {
    if (b.has(token)) {
      shared += 1
    }
  }
  return shared / (a.size + b.size - shared)
}

/** The Levenshtein distance between two strings, two rows at a time. */
function distance(a: string, b: string): number {
  if (a === b) {
    return 0
  }
  if (a.length === 0 || b.length === 0) {
    return a.length + b.length
  }
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, substitution)
    }
    previous = current
  }
  return previous[b.length] ?? 0
}

/** Similarity of two strings in 0..1: one minus their distance over the longer one. */
export function ratio(a: string, b: string): number {
  const longest = Math.max(a.length, b.length)
  return longest === 0 ? 1 : 1 - distance(a, b) / longest
}

export interface PairScore {
  readonly score: number
  readonly reasons: string[]
}

/** The observations of an entity as one token set, for the content mode. */
function observations(entity: Entity): Set<string> {
  return tokenSet(entity.observations.join(" "))
}

/**
 * How likely two entities are the same thing, in one of two modes. Name mode compares
 * the normalised names (word overlap and edit distance) and lets shared observations
 * raise the score; content mode compares what the two know. Returns `undefined` when
 * there is nothing to compare.
 */
export function scorePair(by: "name" | "content", a: Entity, b: Entity): PairScore | undefined {
  if (a.name === b.name) {
    return undefined
  }
  const content = jaccard(observations(a), observations(b))
  if (by === "content") {
    return content > 0 ? { score: content, reasons: ["content"] } : undefined
  }
  const nameA = normaliseName(a.name)
  const nameB = normaliseName(b.name)
  const nameScore = Math.max(
    jaccard(tokenSet(nameA), tokenSet(nameB)),
    ratio(nameA, nameB) * 0.9 + (nameA === nameB ? 0.1 : 0),
  )
  const reasons = ["name"]
  if (content > 0) {
    reasons.push("observations")
  }
  return { score: Math.max(nameScore, 0.6 * nameScore + 0.4 * content), reasons }
}
