#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { runCli } from "./cli.js"
import { CLI_PREFIX, fatal, setPrefix } from "./diagnostics.js"

setPrefix(CLI_PREFIX)

// The maintenance CLI (`noonien`): import, export, merge, compact, query. With
// no command it prints the help. The MCP memory server is the separate
// `server-noonien`, and the replication daemon is `nooniend`.
void Promise.resolve()
  .then(() => runCli(process.argv.slice(2)))
  .catch((error: unknown) => fatal(CLI_PREFIX, error))
