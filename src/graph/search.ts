// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Entity } from "./types.js"

/** A word, in any script: the unit a query term is matched against. */
const WORD = /[\p{L}\p{N}]+/gu

/**
 * The terms of a query: lowercased words, so `"port redis"` becomes two and does
 * not have to appear as one string anywhere.
 */
export function terms(query: string): string[] {
  return query.toLowerCase().match(WORD) ?? []
}

function words(text: string): string[] {
  return text.toLowerCase().match(WORD) ?? []
}

/** The position of the first word `term` prefixes, preferring an exact match. */
function position(all: readonly string[], term: string): number {
  let first = -1
  for (const [index, word] of all.entries()) {
    if (word === term) {
      return index
    }
    if (first < 0 && word.startsWith(term)) {
      first = index
    }
  }
  return first
}

// Field weights are far apart so a better field always outranks a better position;
// the position only breaks ties inside one field, which is what it is for.
const NAME_EXACT = 400
const NAME_PREFIX = 300
const TYPE = 200
const OBSERVATION = 100

/**
 * How well one entity answers a query, or `undefined` when it does not answer it at
 * all. Every term must match, a term matches the beginning of a word, and a hit in
 * the name weighs more than a hit in the type, which weighs more than a hit in an
 * observation; inside a field the earliest word wins.
 */
export function scoreEntity(entity: Entity, queryTerms: readonly string[]): number | undefined {
  if (queryTerms.length === 0) {
    return 0
  }
  const nameWords = words(entity.name)
  const typeWords = words(entity.entityType)
  const observationWords = entity.observations.flatMap(words)
  let total = 0
  for (const term of queryTerms) {
    const inName = position(nameWords, term)
    if (inName >= 0) {
      total +=
        nameWords[inName] === term ? NAME_EXACT : NAME_PREFIX - Math.min(inName, NAME_PREFIX - TYPE)
      continue
    }
    const inType = position(typeWords, term)
    if (inType >= 0) {
      total += TYPE - Math.min(inType, TYPE - OBSERVATION)
      continue
    }
    const inObservation = position(observationWords, term)
    if (inObservation >= 0) {
      total += OBSERVATION - Math.min(inObservation, OBSERVATION - 1)
      continue
    }
    return undefined
  }
  return total
}
