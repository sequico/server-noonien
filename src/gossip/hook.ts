// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, warn } from "../diagnostics.js"
import type { Metrics } from "../metrics.js"

/** How long a hook post may take before it is abandoned. */
const HOOK_TIMEOUT_MS = 5000

/**
 * POST the stable watermark to the operator's hook: a write on another machine is
 * otherwise invisible until a read, and this is the push that lets a listener act on
 * it. Best effort by design — a hook that is down must never disturb replication, so a
 * failure is a warning and a metric, never a thrown error.
 */
export async function notifyHook(
  url: string,
  body: unknown,
  options: { readonly metrics?: Metrics | undefined } = {},
): Promise<boolean> {
  const metrics = options.metrics
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
    })
    if (!response.ok) {
      warn(`hook ${url} answered ${response.status}`)
      metrics?.counter("noonien_gossip_hook_failed_total", "Hook posts that failed")
      return false
    }
    metrics?.counter("noonien_gossip_hook_total", "Hook posts delivered")
    return true
  } catch (error) {
    warn(`hook ${url} failed: ${describe(error)}`)
    metrics?.counter("noonien_gossip_hook_failed_total", "Hook posts that failed")
    return false
  }
}
