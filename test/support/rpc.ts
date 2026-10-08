// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { JSONRPCResultResponse } from "@modelcontextprotocol/server"
import { InMemoryTransport } from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import { MemoryGraph } from "../../src/graph/graph.js"
import { PACKAGE } from "../../src/package.js"
import { createMemoryServer } from "../../src/server.js"
import { ShardLog } from "../../src/store/log.js"
import { MemoryBackend } from "../../src/sync/memory.js"

export interface ToolCallResult {
  readonly content?: readonly { readonly type: string; readonly text?: string }[]
  readonly structuredContent?: Record<string, unknown>
  readonly isError?: boolean
}

export interface TestClient {
  readonly graph: MemoryGraph
  request(method: string, params?: Record<string, unknown>): Promise<JSONRPCResultResponse>
  notify(method: string, params?: Record<string, unknown>): Promise<void>
  initialize(): Promise<JSONRPCResultResponse>
  discoverModern(): Promise<JSONRPCResultResponse>
  listen(resourceSubscriptions: string[]): void
  callTool(name: string, args?: Record<string, unknown>): Promise<ToolCallResult>
  nextNotification(method: string): Promise<unknown>
  close(): Promise<void>
}

export function newGraph(nodeId = "test-node"): MemoryGraph {
  return new MemoryGraph(new ShardLog(new MemoryBackend(), nodeId))
}

/**
 * Serve a graph over an in-memory transport through the real `serveStdio`
 * entry, so the tests exercise the same era negotiation as a client would.
 */
export function connect(graph: MemoryGraph): TestClient {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const handle = serveStdio(() => createMemoryServer(graph, PACKAGE), {
    transport: serverTransport,
  })

  const pending = new Map<number, (message: JSONRPCResultResponse) => void>()
  const notificationWaiters = new Map<string, ((params: unknown) => void)[]>()
  let nextId = 1
  clientTransport.onmessage = (message) => {
    if (
      "id" in message &&
      typeof message.id === "number" &&
      ("result" in message || "error" in message)
    ) {
      const resolve = pending.get(message.id)
      pending.delete(message.id)
      resolve?.(message as JSONRPCResultResponse)
      return
    }
    if ("method" in message) {
      const waiter = notificationWaiters.get(message.method)?.shift()
      waiter?.((message as { params?: unknown }).params)
    }
  }
  void clientTransport.start()

  // The 2026-07-28 era is opt-in: a modern connection is opened by probing with
  // `server/discover`, after which every request carries the per-request `_meta`
  // envelope. Otherwise the 2025 `initialize` handshake is used.
  let era: "legacy" | "modern" = "legacy"
  const envelope = (): Record<string, unknown> => ({
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "noonien-tests", version: "0.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  })
  const withEnvelope = (params?: Record<string, unknown>): Record<string, unknown> | undefined =>
    era === "modern" ? { ...params, _meta: envelope() } : params

  const request = (
    method: string,
    params?: Record<string, unknown>,
  ): Promise<JSONRPCResultResponse> => {
    const id = nextId
    nextId += 1
    return new Promise((resolve) => {
      pending.set(id, resolve)
      void clientTransport.send({ jsonrpc: "2.0", id, method, params: withEnvelope(params) })
    })
  }

  const notify = (method: string, params?: Record<string, unknown>): Promise<void> =>
    clientTransport.send({ jsonrpc: "2.0", method, params })

  const initialize = async (): Promise<JSONRPCResultResponse> => {
    const response = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "noonien-tests", version: "0.0.0" },
    })
    await notify("notifications/initialized")
    return response
  }

  /** Open the connection on the 2026-07-28 era by probing with `server/discover`. */
  const discoverModern = (): Promise<JSONRPCResultResponse> => {
    era = "modern"
    return request("server/discover")
  }

  /**
   * Subscribe to resource updates on a modern connection. `subscriptions/listen`
   * is a long-lived stream with no immediate result: the server acknowledges it
   * with `notifications/subscriptions/acknowledged`.
   */
  const listen = (resourceSubscriptions: string[]): void => {
    void request("subscriptions/listen", { notifications: { resourceSubscriptions } })
  }

  const callTool = async (
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<ToolCallResult> => {
    const response = await request("tools/call", { name, arguments: args })
    return (response.result ?? {}) as ToolCallResult
  }

  const nextNotification = (method: string): Promise<unknown> =>
    new Promise((resolve) => {
      const waiters = notificationWaiters.get(method) ?? []
      waiters.push(resolve)
      notificationWaiters.set(method, waiters)
    })

  return {
    graph,
    request,
    notify,
    initialize,
    discoverModern,
    listen,
    callTool,
    nextNotification,
    async close() {
      await handle.close()
      await clientTransport.close()
    },
  }
}
