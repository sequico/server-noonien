// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { createMemoryGraph } from "./config.js"
import { warn } from "./diagnostics.js"
import { PACKAGE } from "./package.js"
import { createMemoryServer } from "./server.js"

/** How often the server asks whether a maintenance pass is due. */
const MAINTENANCE_INTERVAL_MS = 60_000

/** Serve the memory MCP over stdio, one graph instance per process. */
export function runStdioServer(env: NodeJS.ProcessEnv = process.env): void {
  const graph = createMemoryGraph(env)
  // Maintenance runs outside the write path: once at startup, because a session may
  // close before the timer ever fires, and then on a timer that never keeps the process
  // alive on its own. A pass that is not due costs one stat.
  void graph.maintain()
  const timer = setInterval(() => {
    void graph.maintain()
  }, MAINTENANCE_INTERVAL_MS)
  timer.unref()
  serveStdio(() => createMemoryServer(graph, PACKAGE), {
    onerror: (error) => warn(error.message),
  })
}
