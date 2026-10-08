// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { createMemoryGraph } from "./config.js"
import { warn } from "./diagnostics.js"
import { PACKAGE } from "./package.js"
import { createMemoryServer } from "./server.js"

/** Serve the memory MCP over stdio, one graph instance per process. */
export function runStdioServer(env: NodeJS.ProcessEnv = process.env): void {
  const graph = createMemoryGraph(env)
  serveStdio(() => createMemoryServer(graph, PACKAGE), {
    onerror: (error) => warn(error.message),
  })
}
