// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Hybrid Logical Clock (HLC): a timestamp that stays monotonic even when the
 * wall clock steps back, and that advances past every remote stamp a node has
 * seen. noonien orders operations by `(hlc, node, seq)`; HLC makes that order
 * robust to clock skew and gives a node that has observed a claim a stamp
 * strictly after it, which is what makes a correction reliably win.
 *
 * The stamp is a fixed-width, lexicographically sortable string
 * `PPPPPPPPPPPPPPP:CCCCCC` (15-digit physical milliseconds + 6-digit counter),
 * so the existing `a.ts < b.ts` comparison keeps working. Physical milliseconds
 * always fit 15 digits (well past year 9999) and the counter 6 digits (one
 * million stamps within the same millisecond) — overflow bumps the physical
 * component, as the standard algorithm prescribes.
 */
const PHYSICAL_DIGITS = 15
const COUNTER_DIGITS = 6
const MAX_COUNTER = 10 ** COUNTER_DIGITS - 1
const STAMP_PATTERN = new RegExp(`^\\d{${PHYSICAL_DIGITS}}:\\d{${COUNTER_DIGITS}}$`)

/** The digit widths of an HLC stamp, so its shape is defined in one place. */
export { COUNTER_DIGITS, PHYSICAL_DIGITS }

/**
 * The largest clock skew an observed remote stamp may impose on the local clock.
 * A stamp further in the future is clamped, so a wrong or hostile clock (whose
 * operations this node folds in) cannot push the local timestamps arbitrarily
 * far ahead.
 */
const MAX_SKEW_MS = 60_000

/** Encode a physical millisecond and a logical counter as a sortable stamp. */
export function encodeHlc(physicalMs: number, counter: number): string {
  return `${String(physicalMs).padStart(PHYSICAL_DIGITS, "0")}:${String(counter).padStart(
    COUNTER_DIGITS,
    "0",
  )}`
}

/** Parse a stamp back into its parts, or `undefined` when it is not one. */
export function decodeHlc(hlc: string): { physicalMs: number; counter: number } | undefined {
  if (!STAMP_PATTERN.test(hlc)) {
    return undefined
  }
  return {
    physicalMs: Number(hlc.slice(0, PHYSICAL_DIGITS)),
    counter: Number(hlc.slice(-COUNTER_DIGITS)),
  }
}

/** True when a string is a well-formed HLC stamp. */
export function isHlc(value: string): boolean {
  return STAMP_PATTERN.test(value)
}

/**
 * The stamp a legacy wall-clock operation (one stored before HLC) is ordered by:
 * its physical millisecond and counter 0, so old and new operations interleave
 * correctly.
 */
export function legacyHlc(ts: string): string {
  const ms = Date.parse(ts)
  return encodeHlc(Number.isFinite(ms) && ms >= 0 ? ms : 0, 0)
}

/** A monotonic hybrid logical clock owned by one node. */
export class Hlc {
  private physicalMs = 0
  private counter = 0

  /** The physical millisecond of the last issued or observed stamp. */
  get physical(): number {
    return this.physicalMs
  }

  /** The current stamp, `>=` every issued and observed stamp. */
  peek(): string {
    return encodeHlc(this.physicalMs, this.counter)
  }

  /** The next stamp, strictly greater than any returned or observed before it. */
  next(now = Date.now()): string {
    if (now > this.physicalMs) {
      this.physicalMs = now
      this.counter = 0
    } else if (this.counter >= MAX_COUNTER) {
      this.physicalMs += 1
      this.counter = 0
    } else {
      this.counter += 1
    }
    return this.peek()
  }

  /** Advance past a stamp observed elsewhere, so later writes order after it. */
  observe(hlc: string, now = Date.now()): void {
    const decoded = decodeHlc(hlc)
    if (decoded === undefined) {
      return
    }
    // Clamp a far-future remote stamp: it may keep its own order in the fold, but
    // it must not drag this node's clock with it.
    const remote = Math.min(decoded.physicalMs, now + MAX_SKEW_MS)
    const physicalMs = Math.max(now, this.physicalMs, remote)
    if (physicalMs === this.physicalMs && physicalMs === remote) {
      this.counter = Math.max(this.counter, decoded.counter) + 1
    } else if (physicalMs === this.physicalMs) {
      this.counter += 1
    } else if (physicalMs === remote) {
      this.counter = decoded.counter + 1
    } else {
      this.counter = 0
    }
    this.physicalMs = physicalMs
    if (this.counter > MAX_COUNTER) {
      this.physicalMs += 1
      this.counter = 0
    }
  }
}
