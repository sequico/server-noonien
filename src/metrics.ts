// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * A tiny, dependency-free metrics registry. It renders the Prometheus text
 * exposition format, so a daemon can expose `/metrics` without pulling a
 * client library, and it is cheap enough to bump on a hot path.
 */
type Kind = "counter" | "gauge"
type Labels = Readonly<Record<string, string>>

interface Series {
  readonly kind: Kind
  readonly name: string
  readonly help: string
  /** The already-rendered `{k="v"}` suffix, or an empty string. */
  readonly labels: string
  value: number
}

function escapeLabel(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
}

/** Render labels deterministically, so a series has one stable key. */
function renderLabels(labels: Labels | undefined): string {
  if (labels === undefined) {
    return ""
  }
  const entries = Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  if (entries.length === 0) {
    return ""
  }
  return `{${entries.map(([name, value]) => `${name}="${escapeLabel(value)}"`).join(",")}}`
}

export class Metrics {
  private readonly series = new Map<string, Series>()

  /** Add to a monotonic counter (created at `delta` on first use). */
  counter(name: string, help: string, delta = 1, labels?: Labels): void {
    const suffix = renderLabels(labels)
    const key = `${name}${suffix}`
    const existing = this.series.get(key)
    if (existing === undefined) {
      this.series.set(key, { kind: "counter", name, help, labels: suffix, value: delta })
      return
    }
    existing.value += delta
  }

  /** Set a gauge to its current value. */
  gauge(name: string, help: string, value: number, labels?: Labels): void {
    const suffix = renderLabels(labels)
    this.series.set(`${name}${suffix}`, { kind: "gauge", name, help, labels: suffix, value })
  }

  /** Drop a series, so a peer that no longer exists does not keep a metric forever. */
  remove(name: string, labels?: Labels): void {
    this.series.delete(`${name}${renderLabels(labels)}`)
  }

  /** The current values, for tests and diagnostics, keyed by name plus labels. */
  snapshot(): Record<string, number> {
    const values: Record<string, number> = {}
    for (const [key, series] of this.series) {
      values[key] = series.value
    }
    return values
  }

  /** Render every series in the Prometheus text exposition format. */
  render(): string {
    const described = new Set<string>()
    const lines: string[] = []
    for (const series of this.series.values()) {
      if (!described.has(series.name)) {
        described.add(series.name)
        lines.push(`# HELP ${series.name} ${series.help}`)
        lines.push(`# TYPE ${series.name} ${series.kind}`)
      }
      lines.push(`${series.name}${series.labels} ${series.value}`)
    }
    return `${lines.join("\n")}\n`
  }
}
