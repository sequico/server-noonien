#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { fatal, MCP_PREFIX, setPrefix } from "./diagnostics.js"
import { runStdioServer } from "./serve.js"

setPrefix(MCP_PREFIX)

// The MCP memory server (`server-noonien`): every MCP client spawns it with no
// arguments, so no arguments — or `serve` — serves over stdio. The maintenance
// CLI is the separate `noonien` command, and the replication daemon is
// `nooniend`.
const command = process.argv[2]

if (command === undefined || command === "serve") {
  try {
    runStdioServer()
  } catch (error) {
    fatal(MCP_PREFIX, error)
  }
} else {
  fatal(
    MCP_PREFIX,
    new Error(
      `unknown argument "${command}"; the maintenance CLI is \`noonien\` (try \`noonien help\`)`,
    ),
  )
}
