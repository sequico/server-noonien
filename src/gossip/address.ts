// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The peer address grammar, in one place. A peer address is a plain `host:port` —
 * a hostname or IPv4 label, or a bracketed IPv6 literal — and a port is a usable
 * TCP port (1–65535). Every parser and validator in the daemon uses these, so the
 * grammar and the port range cannot drift between them.
 */

/** True when a value is a usable TCP port (1–65535). */
export function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535
}

/**
 * A peer address must be a plain `host:port`. Rejecting anything else stops a
 * gossiped or announced address from carrying a URL path, userinfo or fragment
 * into the transport that dials it.
 */
const PEER_ADDRESS_PATTERN = /^(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\]):(\d{1,5})$/

/** True when a string is a plain `host:port` with a usable port. */
export function isPeerAddress(address: string): boolean {
  const match = PEER_ADDRESS_PATTERN.exec(address)
  return match !== null && isValidPort(Number(match[1]))
}

/** Format `host:port`, bracketing an IPv6 literal so the result is a valid authority. */
export function formatHostPort(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`
}

/** Split `host:port` with a fallback port, accepting a bare port and IPv6. */
export function parseHostPort(
  value: string | undefined,
  fallbackHost: string,
  fallbackPort: number,
): { host: string; port: number } {
  const trimmed = value?.trim()
  if (trimmed === undefined || trimmed === "") {
    return { host: fallbackHost, port: fallbackPort }
  }
  if (/^\d+$/.test(trimmed)) {
    return { host: fallbackHost, port: parsePort(trimmed) }
  }
  const [host, port] = splitHostPort(trimmed)
  return { host: host === "" ? fallbackHost : host, port: port ?? fallbackPort }
}

function splitHostPort(value: string): [string, number | undefined] {
  // A bracketed IPv6 host, with or without a port.
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value)
  if (bracketed !== null) {
    const host = bracketed[1] ?? value
    return [host, bracketed[2] === undefined ? undefined : parsePort(bracketed[2], value)]
  }
  // An unbracketed IPv6 address has several colons; the whole value is the host
  // and the port falls back. IPv6 with a port must be bracketed, e.g. `[::1]:27878`.
  if (value.split(":").length > 2) {
    return [value, undefined]
  }
  const at = value.lastIndexOf(":")
  if (at < 0) {
    return [value, undefined]
  }
  const host = value.slice(0, at).replace(/^\[|\]$/g, "")
  return [host, parsePort(value.slice(at + 1), value)]
}

function parsePort(value: string, context = value): number {
  const parsed = Number(value)
  if (!isValidPort(parsed)) {
    throw new Error(`Invalid port in "${context}"`)
  }
  return parsed
}

/** The host part of a `host:port` address, or `undefined` when it has none. */
export function addressHost(address: string): string | undefined {
  const bracketed = /^\[([^\]]+)\]/.exec(address)?.[1]
  if (bracketed !== undefined) {
    return bracketed
  }
  const at = address.lastIndexOf(":")
  return at <= 0 ? undefined : address.slice(0, at)
}

/**
 * Ensure an address carries a port, adding `port` when it has none and bracketing a
 * bare IPv6 literal so the result is a valid authority. An out-of-range port is
 * replaced by the fallback.
 */
export function withPort(address: string, port: number): string {
  const trimmed = address.trim()
  if (trimmed.startsWith("[")) {
    const match = /^(\[[^\]]+\])(?::(\d+))?$/.exec(trimmed)
    if (match === null) {
      return trimmed
    }
    const host = match[1] ?? trimmed
    const parsed = match[2] === undefined ? undefined : Number(match[2])
    return parsed !== undefined && isValidPort(parsed) ? trimmed : `${host}:${port}`
  }
  const match = /^([^:]+):(\d+)$/.exec(trimmed)
  if (match !== null) {
    const parsed = Number(match[2])
    const host = match[1] ?? trimmed
    return isValidPort(parsed) ? trimmed : `${host}:${port}`
  }
  // A colon without a bracketed `host:port` shape is an unbracketed IPv6
  // address, which is only valid bracketed in a URL.
  return trimmed.includes(":") ? `[${trimmed}]:${port}` : `${trimmed}:${port}`
}
