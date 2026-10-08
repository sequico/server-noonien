// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { describe, expect, it } from "vitest"
import { Metrics } from "../src/metrics.js"

describe("Metrics", () => {
  it("renders counters and gauges in the Prometheus format", () => {
    const metrics = new Metrics()
    metrics.counter("ops_total", "Operations", 2)
    metrics.counter("ops_total", "Operations")
    metrics.gauge("up", "Daemon is up", 1)
    expect(metrics.render()).toBe(
      [
        "# HELP ops_total Operations",
        "# TYPE ops_total counter",
        "ops_total 3",
        "# HELP up Daemon is up",
        "# TYPE up gauge",
        "up 1",
        "",
      ].join("\n"),
    )
  })

  it("renders one series per label set with a single HELP and TYPE", () => {
    const metrics = new Metrics()
    metrics.gauge("absent_seconds", "Seconds away", 5, { node: "a" })
    metrics.gauge("absent_seconds", "Seconds away", 0, { node: "b" })
    expect(metrics.render()).toBe(
      [
        "# HELP absent_seconds Seconds away",
        "# TYPE absent_seconds gauge",
        'absent_seconds{node="a"} 5',
        'absent_seconds{node="b"} 0',
        "",
      ].join("\n"),
    )
  })

  it("orders labels deterministically and escapes their values", () => {
    const metrics = new Metrics()
    metrics.gauge("m", "Metric", 1, { zone: 'a"b', node: "x" })
    expect(metrics.render()).toContain('m{node="x",zone="a\\"b"} 1')
  })

  it("snapshots by name, labels included", () => {
    const metrics = new Metrics()
    metrics.counter("c", "Counter")
    metrics.gauge("g", "Gauge", 2, { node: "a" })
    expect(metrics.snapshot()).toEqual({ c: 1, 'g{node="a"}': 2 })
  })
})
