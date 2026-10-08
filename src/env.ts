// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Environment helpers shared by the base and gossip configuration, so a value is
 * parsed the same way wherever it is read.
 */

/** Parse a boolean flag (`true`/`1`/`yes`, `false`/`0`/`no`); `name` labels errors. */
export function parseFlag(value: string | undefined, fallback: boolean, name: string): boolean {
  const trimmed = value?.trim().toLowerCase()
  if (trimmed === undefined || trimmed === "") {
    return fallback
  }
  if (trimmed === "true" || trimmed === "1" || trimmed === "yes") {
    return true
  }
  if (trimmed === "false" || trimmed === "0" || trimmed === "no") {
    return false
  }
  throw new Error(`Invalid boolean for ${name}: ${value}`)
}

/**
 * Parse an integer at least `min` (`1` by default); `name` labels errors. An
 * absent or empty value yields `fallback`.
 */
export function parseInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  min = 1,
): number {
  const trimmed = value?.trim()
  if (trimmed === undefined || trimmed === "") {
    return fallback
  }
  const parsed = Number(trimmed)
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(
      `Invalid ${min === 0 ? "non-negative" : "positive"} integer for ${name}: ${value}`,
    )
  }
  return parsed
}
