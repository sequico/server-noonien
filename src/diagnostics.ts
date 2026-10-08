// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The single diagnostic channel for the package. Recoverable problems — a
 * malformed shard line, an unreachable peer — are written to stderr, the way the
 * official memory server reports them, so a running server or daemon surfaces
 * them without dying. `console` is banned in `src`, so this is the one writer.
 */

/** Prefix for the MCP server (`server-noonien`). */
export const MCP_PREFIX = "server-noonien"

/** Prefix for the maintenance CLI (`noonien`). */
export const CLI_PREFIX = "noonien"

/** Prefix for the replication daemon (`nooniend`). */
export const DAEMON_PREFIX = "nooniend"

/**
 * The prefix `warn` and `gossip` use. Shared modules (the codec, the shard log)
 * are called from every entry point, so the process sets it once at startup and
 * their messages carry the right command name.
 */
let prefix = MCP_PREFIX

/** Set the process-wide diagnostic prefix, once per entry point. */
export function setPrefix(value: string): void {
  prefix = value
}

function emit(activePrefix: string, message: string): void {
  process.stderr.write(`${activePrefix}: ${message}\n`)
}

/** Report a recoverable problem from the running process. */
export function warn(message: string): void {
  emit(prefix, message)
}

/** Report a recoverable problem from the replication daemon. */
export function gossip(message: string): void {
  emit(prefix, message)
}

/** The message of an unknown thrown value. */
export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Report a fatal error and set a non-zero exit code. `process.exit` can drop a
 * pending write to a piped stderr, so the caller lets the now-idle loop drain.
 */
export function fatal(prefix: string, error: unknown): void {
  emit(prefix, describe(error))
  process.exitCode = 1
}
