// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { IncomingMessage } from "node:http"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { decodeOperations, encodeOperation } from "../graph/codec.js"
import type { Operation } from "../graph/operations.js"
import type { Metrics } from "../metrics.js"
import {
  type DigestDto,
  DigestSchema,
  MAX_WIRE_BYTES,
  MembershipSchema,
  type PeerEntryDto,
  type PeerInfoDto,
  PeerInfoSchema,
  ReceiveResultSchema,
  type ShardSummaryDto,
  ShardsSchema,
} from "./protocol.js"

/** Counter names the daemon reads back; defined once so a rename cannot drift. */
export const BYTES_SENT_METRIC = "noonien_gossip_bytes_sent_total"
export const BYTES_RECEIVED_METRIC = "noonien_gossip_bytes_received_total"

/** Maximum size of one pushed batch; a larger delta is sent in several requests. */
const MAX_PUSH_BYTES = 8 * 1024 * 1024

/**
 * Maximum size of a single operation. The server caps a request body at
 * {@link MAX_WIRE_BYTES}, so a larger operation can never be pushed — fail with its
 * id instead of retrying it forever.
 */
const MAX_OPERATION_BYTES = MAX_WIRE_BYTES

/** Maximum size of a peer response the client will buffer before giving up. */
const MAX_RESPONSE_BYTES = MAX_WIRE_BYTES

/**
 * Bytes of one `/shards/{node}/ops` page. A shard larger than this is pulled in
 * several bounded requests, so a fresh peer can still catch up on a shard bigger
 * than the response cap. It never exceeds a single operation, so a page always makes
 * progress.
 */
const OPS_PAGE_BYTES = MAX_WIRE_BYTES

/**
 * Raised when a peer could not be reached at all (connection refused, DNS
 * failure, timeout, broken stream). Only these count against a peer's
 * liveness; an HTTP status, a schema mismatch or a rejected push prove the peer
 * is up and must not be mistaken for an unreachable node.
 */
export class UnreachableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UnreachableError"
  }
}

/** Client-side TLS material for talking to a peer. */
export interface ClientTls {
  readonly key: Buffer
  readonly cert: Buffer
  readonly ca: Buffer | undefined
  readonly rejectUnauthorized: boolean
}

/**
 * The local node's identity a transport announces on every request, so the peer's
 * server can mark it alive (and revive it from the dead backoff) and, for a node
 * it does not know yet, adopt it from its address as soon as it is reached,
 * whether or not mTLS identifies the caller.
 */
export interface Announce {
  readonly node: string
  readonly address: string
  readonly version: number
}

/** The operations the sync algorithm needs from one peer. */
export interface PeerTransport {
  readonly address: string
  info(): Promise<PeerInfoDto>
  membership(): Promise<PeerEntryDto[]>
  shards(): Promise<ShardSummaryDto[]>
  /** The peer's compact shard digest; only called when it advertises the capability. */
  digest(): Promise<DigestDto>
  /** The shard summaries of the given digest buckets, in one call. */
  digestBuckets(indexes: readonly number[]): Promise<ShardSummaryDto[]>
  opsAfter(node: string, afterSeq: number): Promise<Operation[]>
  pushOps(node: string, ops: readonly Operation[]): Promise<void>
}

/** HTTP/JSON transport over TCP; TLS when client material is given. */
export class HttpTransport implements PeerTransport {
  readonly address: string
  private readonly tls: ClientTls | undefined
  private readonly timeoutMs: number
  private readonly metrics: Metrics | undefined
  private readonly maxResponseBytes: number
  private readonly self: Announce | undefined

  constructor(
    address: string,
    tls: ClientTls | undefined,
    timeoutMs = 10_000,
    metrics?: Metrics,
    maxResponseBytes = MAX_RESPONSE_BYTES,
    self?: Announce,
  ) {
    this.address = address
    this.tls = tls
    this.timeoutMs = timeoutMs
    this.metrics = metrics
    this.maxResponseBytes = maxResponseBytes
    this.self = self
  }

  async info(): Promise<PeerInfoDto> {
    return PeerInfoSchema.parse(await this.getJson("/info"))
  }

  async membership(): Promise<PeerEntryDto[]> {
    return MembershipSchema.parse(await this.getJson("/membership")).peers
  }

  async shards(): Promise<ShardSummaryDto[]> {
    return ShardsSchema.parse(await this.getJson("/shards")).shards
  }

  async digest(): Promise<DigestDto> {
    return DigestSchema.parse(await this.getJson("/shards/digest"))
  }

  async digestBuckets(indexes: readonly number[]): Promise<ShardSummaryDto[]> {
    const query = indexes.join(",")
    return ShardsSchema.parse(await this.getJson(`/shards/digest?buckets=${query}`)).shards
  }

  opsAfter(node: string, afterSeq: number): Promise<Operation[]> {
    return this.pullOps(node, afterSeq)
  }

  /**
   * Pull a shard's operations after `afterSeq`, page by page. A shard larger than
   * {@link OPS_PAGE_BYTES} is fetched in bounded requests, each continuing from the
   * last sequence received, so a fresh peer can catch up on a shard of any size
   * instead of failing against the single-response cap.
   */
  private async pullOps(node: string, afterSeq: number): Promise<Operation[]> {
    const collected: Operation[] = []
    let after = afterSeq
    for (;;) {
      const { text, truncated } = await this.getPage(
        `/shards/${encodeURIComponent(node)}/ops?after=${after}`,
      )
      // A truncated page can end mid-line: cut it back to the last whole line so the
      // codec never reports a torn line, and the next page re-fetches the rest.
      const whole = truncated ? text.slice(0, text.lastIndexOf("\n") + 1) : text
      const ops = decodeOperations(whole, "a peer shard")
      collected.push(...ops)
      const last = ops[ops.length - 1]
      // Stop on the last page, and never loop when the peer ignores the cursor.
      if (!truncated || last === undefined || last.seq <= after) {
        return collected
      }
      after = last.seq
    }
  }

  async pushOps(node: string, ops: readonly Operation[]): Promise<void> {
    // A big delta is split into bounded batches: the server caps a request body,
    // so one giant POST would be rejected and the delta would never transfer.
    let lines: string[] = []
    let bytes = 0
    for (const op of ops) {
      const line = `${encodeOperation(op)}\n`
      const size = Buffer.byteLength(line)
      if (size > MAX_OPERATION_BYTES) {
        throw new Error(
          `operation ${op.id} is ${size} bytes, above the ${MAX_OPERATION_BYTES}-byte push limit`,
        )
      }
      if (bytes + size > MAX_PUSH_BYTES && lines.length > 0) {
        await this.pushBatch(node, lines)
        lines = []
        bytes = 0
      }
      lines.push(line)
      bytes += size
    }
    if (lines.length > 0) {
      await this.pushBatch(node, lines)
    }
  }

  private async pushBatch(node: string, lines: readonly string[]): Promise<void> {
    const response = await this.request(
      "POST",
      `/shards/${encodeURIComponent(node)}/ops`,
      lines.join(""),
    )
    const text = await readAll(response, this.metrics, this.maxResponseBytes)
    if (response.statusCode === undefined || response.statusCode >= 300) {
      throw new Error(`peer ${this.address} rejected ops (${response.statusCode}): ${text}`)
    }
    ReceiveResultSchema.parse(JSON.parse(text))
  }

  private async getJson(path: string): Promise<unknown> {
    const response = await this.request("GET", path)
    const text = await readAll(response, this.metrics, this.maxResponseBytes)
    if (response.statusCode === undefined || response.statusCode >= 300) {
      throw new Error(`peer ${this.address} answered ${response.statusCode} for ${path}`)
    }
    return JSON.parse(text)
  }

  private async getPage(path: string): Promise<{ text: string; truncated: boolean }> {
    const response = await this.request("GET", path)
    const page = await readPage(
      response,
      this.metrics,
      Math.min(OPS_PAGE_BYTES, this.maxResponseBytes),
    )
    if (response.statusCode === undefined || response.statusCode >= 300) {
      throw new Error(`peer ${this.address} answered ${response.statusCode} for ${path}`)
    }
    return page
  }

  private request(method: string, path: string, body?: string): Promise<IncomingMessage> {
    const scheme = this.tls === undefined ? "http" : "https"
    const url = `${scheme}://${this.address}${path}`
    const headers: Record<string, string> =
      body === undefined ? {} : { "content-type": "application/x-ndjson" }
    if (this.self !== undefined) {
      headers["x-noonien-node"] = this.self.node
      headers["x-noonien-address"] = this.self.address
      headers["x-noonien-version"] = String(this.self.version)
    }
    const options = { method, headers, ...(this.tls ?? {}) }
    this.metrics?.counter(
      BYTES_SENT_METRIC,
      "Bytes sent to peers",
      body === undefined ? 0 : Buffer.byteLength(body),
    )
    return new Promise((resolve, reject) => {
      const request = (this.tls === undefined ? httpRequest : httpsRequest)(url, options, resolve)
      request.setTimeout(this.timeoutMs, () =>
        request.destroy(new Error(`peer ${this.address} timed out`)),
      )
      request.on("error", (error: Error) =>
        reject(new UnreachableError(`peer ${this.address}: ${error.message}`)),
      )
      request.end(body)
    })
  }
}

function readAll(
  response: IncomingMessage,
  metrics: Metrics | undefined,
  limit: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    response.on("data", (chunk: Buffer) => {
      if (settled) {
        return
      }
      size += chunk.length
      if (size > limit) {
        settled = true
        response.destroy()
        reject(new Error(`peer response exceeds ${limit} bytes`))
        return
      }
      chunks.push(chunk)
    })
    response.on("end", () => {
      if (settled) {
        return
      }
      settled = true
      const text = Buffer.concat(chunks).toString("utf8")
      metrics?.counter(BYTES_RECEIVED_METRIC, "Bytes received from peers", Buffer.byteLength(text))
      resolve(text)
    })
    response.on("error", (error: Error) => {
      if (settled) {
        return
      }
      settled = true
      reject(new UnreachableError(error.message))
    })
  })
}

/**
 * Read one bounded page of an NDJSON response. When the cap is reached the response
 * is abandoned mid-stream and only the operations already received are returned: the
 * server streams a shard in order, so the caller continues from the last operation
 * instead of failing on a response larger than the cap.
 */
function readPage(
  response: IncomingMessage,
  metrics: Metrics | undefined,
  limit: number,
): Promise<{ text: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (truncated: boolean): void => {
      settled = true
      const text = Buffer.concat(chunks).toString("utf8")
      metrics?.counter(BYTES_RECEIVED_METRIC, "Bytes received from peers", Buffer.byteLength(text))
      resolve({ text, truncated })
    }
    response.on("data", (chunk: Buffer) => {
      if (settled) {
        return
      }
      size += chunk.length
      // Keep at least the first chunk, so a page always carries something and a single
      // operation larger than the page budget still makes progress.
      if (chunks.length > 0 && size > limit) {
        response.destroy()
        finish(true)
        return
      }
      chunks.push(chunk)
    })
    response.on("end", () => {
      if (!settled) {
        finish(false)
      }
    })
    response.on("error", (error: Error) => {
      if (settled) {
        return
      }
      settled = true
      reject(new UnreachableError(error.message))
    })
  })
}
