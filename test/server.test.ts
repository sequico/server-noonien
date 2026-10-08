// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { JSONRPCResultResponse } from "@modelcontextprotocol/server"
import { afterEach, describe, expect, it } from "vitest"
import { GRAPH_RESOURCE_URI } from "../src/server.js"
import type { TestClient } from "./support/rpc.js"
import { connect, newGraph } from "./support/rpc.js"

const clients: TestClient[] = []

function start(): TestClient {
  const client = connect(newGraph())
  clients.push(client)
  return client
}

function result<T>(response: JSONRPCResultResponse): T {
  return response.result as T
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
})

const OFFICIAL_TOOLS = [
  "create_entities",
  "create_relations",
  "add_observations",
  "delete_entities",
  "delete_observations",
  "delete_relations",
  "read_graph",
  "search_nodes",
  "open_nodes",
]

describe("memory MCP server", () => {
  it("reports only the package name and version in serverInfo", async () => {
    const client = start()
    const response = result<{ serverInfo: Record<string, unknown> }>(await client.initialize())
    expect(Object.keys(response.serverInfo).sort()).toEqual(["name", "version"])
    expect(response.serverInfo["name"]).toBe("server-noonien")
  })

  it("advertises the nine drop-in tools", async () => {
    const client = start()
    await client.initialize()
    const tools = result<{ tools: { name: string }[] }>(await client.request("tools/list")).tools
    expect(tools.map((tool) => tool.name).sort()).toEqual([...OFFICIAL_TOOLS].sort())
  })

  it("creates entities and reads them back", async () => {
    const client = start()
    await client.initialize()
    const created = result<{ structuredContent: { entities: unknown[] } }>(
      await client.request("tools/call", {
        name: "create_entities",
        arguments: { entities: [{ name: "Ada", entityType: "person", observations: ["math"] }] },
      }),
    )
    expect(created.structuredContent.entities).toEqual([
      { name: "Ada", entityType: "person", observations: ["math"] },
    ])
    const read = result<{ structuredContent: { entities: unknown[] } }>(
      await client.request("tools/call", { name: "read_graph", arguments: {} }),
    )
    expect(read.structuredContent.entities).toEqual([
      { name: "Ada", entityType: "person", observations: ["math"] },
    ])
  })

  it("returns the official delete summary", async () => {
    const client = start()
    await client.initialize()
    await client.request("tools/call", {
      name: "create_entities",
      arguments: { entities: [{ name: "Ada", entityType: "person", observations: [] }] },
    })
    const deleted = result<{ structuredContent: { success: boolean; message: string } }>(
      await client.request("tools/call", {
        name: "delete_entities",
        arguments: { entityNames: ["Ada", "Ghost"] },
      }),
    )
    expect(deleted.structuredContent.success).toBe(true)
    expect(deleted.structuredContent.message).toContain("Not found: Ghost")
  })

  it("reports a tool error for a missing entity", async () => {
    const client = start()
    await client.initialize()
    const response = result<{ isError?: boolean }>(
      await client.request("tools/call", {
        name: "add_observations",
        arguments: { observations: [{ entityName: "Ghost", contents: ["x"] }] },
      }),
    )
    expect(response.isError).toBe(true)
  })

  it("exposes the graph as a resource", async () => {
    const client = start()
    await client.initialize()
    const resources = result<{ resources: { uri: string }[] }>(
      await client.request("resources/list"),
    )
    expect(resources.resources.map((resource) => resource.uri)).toContain(GRAPH_RESOURCE_URI)
  })

  it("notifies a subscriber when the graph changes", async () => {
    const client = start()
    await client.initialize()
    await client.request("resources/subscribe", { uri: GRAPH_RESOURCE_URI })
    const notified = client.nextNotification("notifications/resources/updated")
    await client.callTool("create_entities", {
      entities: [{ name: "Ada", entityType: "person", observations: [] }],
    })
    expect(await notified).toEqual({ uri: GRAPH_RESOURCE_URI })
  })

  it("serves the 2026-07-28 era and notifies a subscriptions/listen subscriber", async () => {
    const client = start()
    const discovered = result<{ supportedVersions: string[] }>(await client.discoverModern())
    expect(discovered.supportedVersions).toEqual(["2026-07-28"])
    client.listen([GRAPH_RESOURCE_URI])
    const notified = client.nextNotification("notifications/resources/updated")
    await client.callTool("create_entities", {
      entities: [{ name: "Ada", entityType: "person", observations: [] }],
    })
    // The modern notification also carries the subscription id in `_meta`.
    expect(await notified).toMatchObject({ uri: GRAPH_RESOURCE_URI })
  })

  it("matches the official server's outputs and messages", async () => {
    const client = start()
    await client.initialize()

    const ada = { name: "Ada", entityType: "person", observations: ["math"] }
    const bob = { name: "Bob", entityType: "person", observations: [] }
    const relation = { from: "Ada", to: "Bob", relationType: "knows" }

    const created = await client.callTool("create_entities", { entities: [ada, bob] })
    expect(created.structuredContent).toEqual({ entities: [ada, bob] })
    expect(created.content?.[0]?.text).toBe(JSON.stringify([ada, bob], null, 2))

    expect(
      (await client.callTool("create_entities", { entities: [ada] })).structuredContent,
    ).toEqual({ entities: [] })

    expect(
      (await client.callTool("create_relations", { relations: [relation] })).structuredContent,
    ).toEqual({ relations: [relation] })

    expect(
      (
        await client.callTool("add_observations", {
          observations: [{ entityName: "Ada", contents: ["math", "logic"] }],
        })
      ).structuredContent,
    ).toEqual({ results: [{ entityName: "Ada", addedObservations: ["logic"] }] })

    expect(
      (
        await client.callTool("delete_observations", {
          deletions: [{ entityName: "Ada", observations: ["logic", "absent"] }],
        })
      ).content?.[0]?.text,
    ).toBe("Deleted 1 of 2 observations.")

    expect(
      (
        await client.callTool("delete_observations", {
          deletions: [{ entityName: "Ghost", observations: ["x"] }],
        })
      ).content?.[0]?.text,
    ).toBe("Deleted 0 of 1 observations. Entities not found: Ghost")

    const missingEndpoint = await client.callTool("create_relations", {
      relations: [{ from: "Ada", to: "Ghost", relationType: "knows" }],
    })
    expect(missingEndpoint.isError).toBe(true)

    expect(
      (await client.callTool("delete_entities", { entityNames: ["Ada", "Ghost"] })).content?.[0]
        ?.text,
    ).toBe("Deleted 1 of 2 entities. Not found: Ghost")

    expect((await client.callTool("read_graph")).structuredContent).toEqual({
      entities: [bob],
      relations: [],
    })
    expect((await client.callTool("search_nodes", { query: "bob" })).structuredContent).toEqual({
      entities: [bob],
      relations: [],
    })
    expect((await client.callTool("open_nodes", { names: ["Bob"] })).structuredContent).toEqual({
      entities: [bob],
      relations: [],
    })
  })
})
