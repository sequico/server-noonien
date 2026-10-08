#!/usr/bin/env node
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { DAEMON_PREFIX, fatal, setPrefix } from "./diagnostics.js"
import { startGossip } from "./gossip/daemon.js"

setPrefix(DAEMON_PREFIX)

// The replication daemon (`nooniend`): one long-running process per machine. It
// serves this node's shards and membership over HTTP and reconciles with peers;
// it never authors operations. All configuration is read from the environment
// (see `loadGossipConfig`); there are no arguments, so it drops straight into a
// systemd unit. SIGINT/SIGTERM stop the server and the timers before exiting.
void startGossip()
  .then((handle) => {
    const shutdown = (): void => {
      void handle.close().then(
        () => process.exit(0),
        (error: unknown) => {
          fatal(DAEMON_PREFIX, error)
          process.exit()
        },
      )
    }
    process.once("SIGINT", shutdown)
    process.once("SIGTERM", shutdown)
  })
  .catch((error: unknown) => fatal(DAEMON_PREFIX, error))
