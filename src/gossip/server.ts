// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { IncomingMessage, ServerResponse } from "node:http"
import { createServer as createHttpServer, type Server } from "node:http"
import { createServer as createHttpsServer } from "node:https"
import type { AddressInfo } from "node:net"
import type { TLSSocket } from "node:tls"
import { warn } from "../diagnostics.js"
import { decodeOperations, encodeOperation } from "../graph/codec.js"
import { foldOperations } from "../graph/fold.js"
import type { Operation } from "../graph/operations.js"
import type { Metrics } from "../metrics.js"
import { isSafeNodeId } from "../sync/backend.js"
import { addressHost, formatHostPort } from "./address.js"
import { bucketEntries, computeDigest, DIGEST_BUCKETS } from "./digest.js"
import type { PeerKnowledge } from "./knowledge.js"
import type { Membership } from "./membership.js"
import { DIGEST_CAPABILITY, MAX_WIRE_BYTES, PROTOCOL_VERSION } from "./protocol.js"
import type { ReplicaStore } from "./replica.js"

/** What a peer announced in the request headers, if anything. */
interface Announced {
  readonly node: string
  readonly address: string | undefined
  readonly version: number
}

/** Maximum accepted size of a pushed operations body. */
const MAX_BODY_BYTES = MAX_WIRE_BYTES
/**
 * Operations the `/graph` diagnostic route will fold in one request. Past this it
 * refuses instead of truncating: measured on a synthetic log, a read after a write
 * over 50 000 operations costs about 0.4 s and a few hundred megabytes of heap, so one
 * request must not be able to ask for it — the per-shard route serves the same data a
 * page at a time.
 */
const MAX_GRAPH_OPS = 50_000
/** Bytes of NDJSON buffered before one write, so a large delta is not one write per op. */
const WRITE_CHUNK_BYTES = 256 * 1024

/** Raised when a pushed body exceeds {@link MAX_BODY_BYTES}. */
class PayloadTooLargeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PayloadTooLargeError"
  }
}

/** Server-side TLS material. A client certificate is required when `requireClient`. */
export interface ServerTls {
  readonly key: Buffer
  readonly cert: Buffer
  readonly ca: Buffer | undefined
  readonly requireClient: boolean
}

export interface GossipServerOptions {
  readonly host: string
  readonly port: number
  readonly tls: ServerTls | undefined
  readonly replica: ReplicaStore
  readonly membership: Membership
  /** Prometheus metrics, served at `/metrics` when present. */
  readonly metrics?: Metrics
  /** Per-shard stable high-water marks, served at `/watermark` when present. */
  readonly watermark?: () => Record<string, number>
  /**
   * The durable peer knowledge, written by an inbound **push**: a peer that pushes
   * operations to this node holds them by construction, so what it pushed is recorded as
   * the part of a frontier an exchange would otherwise have to learn. Without it a peer
   * that pushes and then dies looks like one never exchanged with — an element it
   * delivered would read as uncontested, and a pusher outside the membership would gate
   * nothing at all.
   */
  readonly knowledge?: PeerKnowledge
  /** Node ids refused outright — a revoked peer is rejected on every route. */
  readonly revoked?: ReadonlySet<string>
  /** Maximum accepted size of a pushed body; defaults to the wire cap. */
  readonly maxBodyBytes?: number
  /** Operations the `/graph` route folds in one request; defaults to the ceiling. */
  readonly maxGraphOps?: number
  /**
   * Offered the `host:port` of a caller that is not a peer yet, when the host it
   * announces is the one the request came from, so the daemon can probe it on `/info`
   * and adopt it if it answers. This is how a statically-seeded joiner is discovered by
   * the seeds it reached: membership itself never grows from the headers of a request.
   */
  readonly inboundCandidate?: (address: string) => void
}

export interface GossipServer {
  /** `host:port` the server is reachable at. */
  readonly address: string
  /** Full URL, for logs and diagnostics. */
  readonly url: string
  close(): Promise<void>
}

/** Start the HTTP/JSON service that serves this node's shards and membership. */
export function startGossipServer(options: GossipServerOptions): Promise<GossipServer> {
  const startedAt = Date.now()
  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    handle(options, request, response, startedAt).catch((error: unknown) => {
      if (error instanceof PayloadTooLargeError) {
        // Send the status first, then drop the rest of the oversized body.
        send(response, 413, { error: error.message })
        request.destroy()
        return
      }
      // Do not echo an internal error to the peer — it can leak paths and state.
      // Log it here and answer generically.
      warn(`request failed: ${error instanceof Error ? error.message : String(error)}`)
      send(response, 500, { error: "internal error" })
    })
  }
  const server: Server =
    options.tls === undefined
      ? createHttpServer(handler)
      : createHttpsServer(
          {
            key: options.tls.key,
            cert: options.tls.cert,
            ca: options.tls.ca,
            requestCert: options.tls.requireClient,
            rejectUnauthorized: options.tls.requireClient,
          },
          handler,
        )
  // A stalled request must not hold a connection (and its buffer) open.
  server.requestTimeout = 60_000
  server.headersTimeout = 20_000
  return listen(server, options.host, options.port, options.tls === undefined ? "http" : "https")
}

async function handle(
  options: GossipServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
  startedAt: number,
): Promise<void> {
  const method = request.method ?? "GET"
  const url = new URL(request.url ?? "/", "http://localhost")
  const client = peerNode(request)
  if (client !== undefined && options.revoked?.has(client) === true) {
    send(response, 403, { error: "client certificate is revoked" })
    return
  }
  reviveCaller(options, request, client)
  if (method === "GET" && (await handleGet(options, url, response, startedAt))) {
    return
  }
  if (!(await handleOps(options, request, response, method, url))) {
    send(response, 404, { error: "not found" })
  }
}

/**
 * A peer that reaches us is alive: mark it so, reviving it from the dead backoff
 * without waiting out its retry.
 *
 * Only a **certificate** revives anyone. A header is a claim, and reviving on a
 * claim would let any host that can open a socket keep a member alive forever: its
 * failure count never reaches the dead threshold, so a peer that no longer exists
 * stays *reachable* while no round can ever cover it — and that holds tombstone
 * collection open mesh-wide. A peer that really is back is revived by the round that
 * reaches it, which is the only evidence that counts.
 *
 * A caller that is **not** a peer yet is never adopted from its headers: nothing it
 * sends becomes membership, and its id is never taken on trust. It is offered as a
 * discovery candidate instead, on the same terms as any other — the daemon probes it and
 * takes the id from its own `/info`, so a statically-seeded joiner is still discovered by
 * the seeds it reached, and a host that does not answer never becomes a member and never
 * blocks collection. The candidate is built from the **host the request came from** and
 * only the port it announces, so nothing a stranger sends can point the dialer at another
 * host: an address announced for a different host is not even probed.
 *
 * With mTLS the certificate names the peer and wins; a mismatch between the
 * certificate and the announced node is ignored, and the announced version is
 * only read when the certificate agrees.
 */
function reviveCaller(
  options: GossipServerOptions,
  request: IncomingMessage,
  client: string | undefined,
): void {
  const announced = announceOf(request)
  const node = client ?? announced?.node
  if (node === undefined) {
    return
  }
  if (client !== undefined) {
    options.membership.touch(client, announced?.node === client ? announced.version : Number.NaN)
  }
  if (
    options.inboundCandidate !== undefined &&
    !options.membership.has(node) &&
    announced?.address !== undefined &&
    addressHost(announced.address) === sourceHost(request)
  ) {
    options.inboundCandidate(announced.address)
  }
}

/** The host a request came from, its IPv4-mapped IPv6 prefix stripped. */
function sourceHost(request: IncomingMessage): string | undefined {
  const remote = request.socket.remoteAddress
  if (remote === undefined) {
    return undefined
  }
  return remote.startsWith("::ffff:") ? remote.slice("::ffff:".length) : remote
}

/**
 * The `x-noonien-node` / `-address` / `-version` a peer announced, if any. A node id that
 * is not path-safe is ignored outright: it would grow membership and the `{node}` metric
 * label without bound.
 */
function announceOf(request: IncomingMessage): Announced | undefined {
  const node = request.headers["x-noonien-node"]
  if (typeof node !== "string" || !isSafeNodeId(node)) {
    return undefined
  }
  const address = request.headers["x-noonien-address"]
  const raw = request.headers["x-noonien-version"]
  return {
    node,
    address: typeof address === "string" && address !== "" ? address : undefined,
    version: typeof raw === "string" ? Number(raw) : Number.NaN,
  }
}

/** Serve the read-only metadata routes; `false` when the path is none of them. */
async function handleGet(
  options: GossipServerOptions,
  url: URL,
  response: ServerResponse,
  startedAt: number,
): Promise<boolean> {
  if (url.pathname === "/health") {
    send(response, 200, { status: "ok" })
    return true
  }
  if (url.pathname === "/info") {
    send(response, 200, {
      ...options.membership.self(),
      protocol: PROTOCOL_VERSION,
      capabilities: [DIGEST_CAPABILITY],
    })
    return true
  }
  if (url.pathname === "/peers") {
    send(response, 200, {
      peers: options.membership.known().map((entry) => ({
        ...entry,
        health: options.membership.healthOf(entry.node),
      })),
    })
    return true
  }
  if (url.pathname === "/status") {
    send(response, 200, await nodeStatus(options, startedAt))
    return true
  }
  if (url.pathname === "/membership") {
    send(response, 200, { peers: options.membership.known() })
    return true
  }
  if (url.pathname === "/graph") {
    const ceiling = options.maxGraphOps ?? MAX_GRAPH_OPS
    const total = (await options.replica.list()).reduce((sum, shard) => sum + shard.count, 0)
    if (total > ceiling) {
      send(response, 413, {
        error:
          `the local replica holds ${total} operations, above the ${ceiling} this ` +
          "route serves in one request; read the shards instead",
      })
      return true
    }
    send(response, 200, foldOperations(await options.replica.allOps()))
    return true
  }
  if (url.pathname === "/shards") {
    send(response, 200, { shards: await options.replica.list() })
    return true
  }
  if (url.pathname === "/shards/digest") {
    await serveDigest(options, url, response)
    return true
  }
  if (url.pathname === "/metrics" && options.metrics !== undefined) {
    response.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" })
    response.end(options.metrics.render())
    return true
  }
  if (url.pathname === "/watermark" && options.watermark !== undefined) {
    send(response, 200, options.watermark())
    return true
  }
  return false
}

/**
 * A one-glance summary for probes and operators: the local identity, how long the
 * process has been up, how many shards are on disk and how the peers stand
 * (remote peers only — the local node is not a peer of itself).
 */
async function nodeStatus(options: GossipServerOptions, startedAt: number): Promise<NodeStatus> {
  const self = options.membership.self()
  const peers = { total: 0, alive: 0, suspect: 0, dead: 0 }
  for (const entry of options.membership.known()) {
    if (entry.node === self.node) {
      continue
    }
    peers.total += 1
    peers[options.membership.healthOf(entry.node)] += 1
  }
  return {
    node: self.node,
    version: self.version,
    protocol: PROTOCOL_VERSION,
    uptimeSec: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
    shards: (await options.replica.list()).length,
    peers,
  }
}

interface NodeStatus {
  readonly node: string
  readonly version: number
  readonly protocol: number
  readonly uptimeSec: number
  readonly shards: number
  readonly peers: {
    readonly total: number
    readonly alive: number
    readonly suspect: number
    readonly dead: number
  }
}

/**
 * Serve the shard digest: the whole digest when no bucket is asked for, or the
 * summaries of several buckets (`?buckets=1,3,5`) in one call, which is what a
 * peer fetches for the buckets whose hash differed. Fetching them together scans
 * the shard set once instead of once per bucket. The bucket count is fixed, so an
 * out-of-range index is a client error, not an empty answer.
 */
async function serveDigest(
  options: GossipServerOptions,
  url: URL,
  response: ServerResponse,
): Promise<void> {
  const buckets = url.searchParams.get("buckets")
  const summaries = await options.replica.list()
  if (buckets === null) {
    send(response, 200, computeDigest(summaries))
    return
  }
  const indexes = parseBuckets(buckets)
  if (indexes === undefined) {
    send(response, 400, { error: `invalid digest buckets "${buckets}"` })
    return
  }
  send(response, 200, { shards: bucketEntries(summaries, indexes) })
}

/** Parse `1,3,5` into in-range bucket indexes, or `undefined` when malformed. */
function parseBuckets(value: string): number[] | undefined {
  const indexes: number[] = []
  for (const part of value.split(",")) {
    const trimmed = part.trim()
    const index = Number(trimmed)
    if (trimmed === "" || !Number.isInteger(index) || index < 0 || index >= DIGEST_BUCKETS) {
      return undefined
    }
    indexes.push(index)
  }
  return indexes
}

/** Serve or receive the operations of one shard; `false` when the route differs. */
async function handleOps(
  options: GossipServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  url: URL,
): Promise<boolean> {
  const node = /^\/shards\/([^/]+)\/ops$/.exec(url.pathname)?.[1]
  if (node === undefined) {
    return false
  }
  let name: string
  try {
    name = decodeURIComponent(node)
  } catch {
    send(response, 400, { error: `malformed node id "${node}"` })
    return true
  }
  if (!isSafeNodeId(name)) {
    send(response, 400, { error: `unsafe node id "${node}"` })
    return true
  }
  if (method === "GET") {
    const after = Number(url.searchParams.get("after") ?? "-1")
    const ops = await options.replica.opsAfter(name, Number.isFinite(after) ? after : -1)
    writeOperations(response, ops)
    return true
  }
  if (method === "POST") {
    const refusal = pushRefusal(options, request, name)
    if (refusal !== undefined) {
      send(response, 403, { error: refusal })
      return true
    }
    // Refused before the body is buffered: the caller named this node id, so at the
    // ceiling it is the store that has no room, whatever the body turns out to be.
    if (!(await options.replica.accepts(name))) {
      send(response, 507, {
        error: `this node already holds the maximum number of shards, so "${name}" is refused`,
      })
      return true
    }
    const ops = decodeOperations(await readBody(request, options.maxBodyBytes ?? MAX_BODY_BYTES))
    const foreign = ops.find((op) => op.node !== name)
    if (foreign !== undefined) {
      send(response, 400, {
        error: `operation ${foreign.id} belongs to node "${foreign.node}", not "${name}"`,
      })
      return true
    }
    const appended = await options.replica.receive(name, ops)
    const maxSeq = await options.replica.maxSeq(name)
    // The pusher authored what it pushed, so it holds those operations: recording that is
    // what keeps the elements it delivered frozen even if it never exchanges again (see
    // `GossipServerOptions.knowledge`).
    options.knowledge?.record(name, new Map([[name, maxSeq]]), Date.now())
    send(response, 200, { appended, maxSeq })
    return true
  }
  send(response, 405, { error: "method not allowed" })
  return true
}

/**
 * The node id carried by the client certificate's common name, when mTLS is on.
 * The CN of a peer's certificate is its node id, so a peer may only push the
 * shard it authors; reads stay open to any authenticated peer, which is what
 * lets a node relay the shards it holds.
 */
function peerNode(request: IncomingMessage): string | undefined {
  const socket = request.socket as Partial<TLSSocket>
  if (typeof socket.getPeerCertificate !== "function") {
    return undefined
  }
  const commonName = socket.getPeerCertificate().subject?.CN
  return typeof commonName === "string" && commonName !== "" ? commonName : undefined
}

/** Stream a shard's operations as NDJSON, buffering into sizeable writes. */
function writeOperations(response: ServerResponse, ops: readonly Operation[]): void {
  response.writeHead(200, { "content-type": "application/x-ndjson" })
  let chunk: string[] = []
  let bytes = 0
  for (const op of ops) {
    const line = `${encodeOperation(op)}\n`
    chunk.push(line)
    bytes += Buffer.byteLength(line)
    if (bytes >= WRITE_CHUNK_BYTES) {
      response.write(chunk.join(""))
      chunk = []
      bytes = 0
    }
  }
  if (chunk.length > 0) {
    response.write(chunk.join(""))
  }
  response.end()
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  if (response.headersSent) {
    response.end()
    return
  }
  const body = JSON.stringify(payload)
  response.writeHead(status, { "content-type": "application/json" })
  response.end(body)
}

/**
 * Why a push for `{name}` is refused with `403`, or `undefined` when it is allowed: the
 * node is revoked, it is the local node's own shard (only the owner writes that one — it
 * recovers what it lost from a peer's replica itself), or the request's certificate does
 * not authorize it.
 */
function pushRefusal(
  options: GossipServerOptions,
  request: IncomingMessage,
  name: string,
): string | undefined {
  if (options.revoked?.has(name) === true) {
    return `node "${name}" is revoked`
  }
  if (name === options.replica.ownNode) {
    return `node "${name}" may not push its own shard`
  }
  if (options.tls?.requireClient === true && peerNode(request) !== name) {
    return "client certificate does not authorize this shard"
  }
  return undefined
}

/**
 * Read the (bounded) request body. A declared `content-length` over the cap is
 * rejected before buffering, so a lying or stalled client cannot hold a large
 * buffer; the streaming check still guards a body with no `content-length`.
 */
function readBody(request: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<string> {
  const declared = Number(request.headers["content-length"])
  if (Number.isFinite(declared) && declared > maxBytes) {
    return Promise.reject(new PayloadTooLargeError(`request body exceeds ${maxBytes} bytes`))
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        // Stop reading without destroying the socket, so the handler can still send
        // the 413 before the connection is closed.
        request.pause()
        reject(new PayloadTooLargeError(`request body exceeds ${maxBytes} bytes`))
        return
      }
      chunks.push(chunk)
    })
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    request.on("error", reject)
  })
}

function listen(server: Server, host: string, port: number, scheme: string): Promise<GossipServer> {
  return new Promise((resolve, reject) => {
    server.on("error", reject)
    server.listen(port, host, () => {
      const address = server.address() as AddressInfo
      const authority = formatHostPort(host, address.port)
      resolve({
        address: authority,
        url: `${scheme}://${authority}`,
        close: () =>
          new Promise((done, fail) => {
            server.closeAllConnections()
            server.close((error) => (error === undefined ? done() : fail(error)))
          }),
      })
    })
  })
}
