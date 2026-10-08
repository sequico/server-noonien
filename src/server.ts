// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Implementation } from "@modelcontextprotocol/server"
import { McpServer } from "@modelcontextprotocol/server"
import { z } from "zod"
import type { MemoryGraph } from "./graph/graph.js"
import { EntitySchema, KnowledgeGraphSchema, RelationSchema } from "./graph/types.js"

/** The resource URI the official memory server exposes the whole graph at. */
export const GRAPH_RESOURCE_URI = "memory://knowledge-graph"

const annotationsRead = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

const annotationsAdd = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const

const annotationsDelete = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const

function textResult(text: string): { type: "text"; text: string } {
  return { type: "text", text }
}

/**
 * Register the nine drop-in memory tools and the knowledge-graph resource on a
 * server, backed by the given graph. Names, inputs, outputs, messages and
 * annotations mirror `@modelcontextprotocol/server-memory` exactly. `onMutate`
 * runs after every successful mutation so the server can notify subscribers.
 */
export function registerMemoryTools(
  server: McpServer,
  graph: MemoryGraph,
  onMutate: () => void,
): void {
  server.registerTool(
    "create_entities",
    {
      title: "Create Entities",
      description: "Create multiple new entities in the knowledge graph",
      inputSchema: z.object({ entities: z.array(EntitySchema) }),
      outputSchema: z.object({ entities: z.array(EntitySchema) }),
      annotations: annotationsAdd,
    },
    async ({ entities }) => {
      const created = await graph.createEntities(entities)
      onMutate()
      return {
        content: [textResult(JSON.stringify(created, null, 2))],
        structuredContent: { entities: created },
      }
    },
  )

  server.registerTool(
    "create_relations",
    {
      title: "Create Relations",
      description:
        "Create multiple new relations between entities in the knowledge graph. Relations should be in active voice",
      inputSchema: z.object({ relations: z.array(RelationSchema) }),
      outputSchema: z.object({ relations: z.array(RelationSchema) }),
      annotations: annotationsAdd,
    },
    async ({ relations }) => {
      const created = await graph.createRelations(relations)
      onMutate()
      return {
        content: [textResult(JSON.stringify(created, null, 2))],
        structuredContent: { relations: created },
      }
    },
  )

  server.registerTool(
    "add_observations",
    {
      title: "Add Observations",
      description: "Add new observations to existing entities in the knowledge graph",
      inputSchema: z.object({
        observations: z.array(
          z.object({
            entityName: z.string().describe("The name of the entity to add the observations to"),
            contents: z.array(z.string()).describe("An array of observation contents to add"),
          }),
        ),
      }),
      outputSchema: z.object({
        results: z.array(
          z.object({
            entityName: z.string(),
            addedObservations: z.array(z.string()),
          }),
        ),
      }),
      annotations: annotationsAdd,
    },
    async ({ observations }) => {
      const results = await graph.addObservations(observations)
      onMutate()
      return {
        content: [textResult(JSON.stringify(results, null, 2))],
        structuredContent: { results },
      }
    },
  )

  server.registerTool(
    "delete_entities",
    {
      title: "Delete Entities",
      description:
        "Delete multiple entities and their associated relations from the knowledge graph",
      inputSchema: z.object({
        entityNames: z.array(z.string()).describe("An array of entity names to delete"),
      }),
      outputSchema: z.object({ success: z.boolean(), message: z.string() }),
      annotations: annotationsDelete,
    },
    async ({ entityNames }) => {
      const { deleted, notFound } = await graph.deleteEntities(entityNames)
      onMutate()
      const message =
        notFound.length === 0
          ? "Entities deleted successfully"
          : `Deleted ${deleted.length} of ${entityNames.length} entities. Not found: ${notFound.join(", ")}`
      return {
        content: [textResult(message)],
        structuredContent: { success: true, message },
      }
    },
  )

  server.registerTool(
    "delete_observations",
    {
      title: "Delete Observations",
      description: "Delete specific observations from entities in the knowledge graph",
      inputSchema: z.object({
        deletions: z.array(
          z.object({
            entityName: z.string().describe("The name of the entity containing the observations"),
            observations: z.array(z.string()).describe("An array of observations to delete"),
          }),
        ),
      }),
      outputSchema: z.object({ success: z.boolean(), message: z.string() }),
      annotations: annotationsDelete,
    },
    async ({ deletions }) => {
      const { deletedCount, missingEntities } = await graph.deleteObservations(deletions)
      onMutate()
      const requested = deletions.reduce((total, entry) => total + entry.observations.length, 0)
      const message =
        deletedCount === requested
          ? "Observations deleted successfully"
          : `Deleted ${deletedCount} of ${requested} observations.` +
            (missingEntities.length > 0 ? ` Entities not found: ${missingEntities.join(", ")}` : "")
      return {
        content: [textResult(message)],
        structuredContent: { success: true, message },
      }
    },
  )

  server.registerTool(
    "delete_relations",
    {
      title: "Delete Relations",
      description: "Delete multiple relations from the knowledge graph",
      inputSchema: z.object({
        relations: z.array(RelationSchema).describe("An array of relations to delete"),
      }),
      outputSchema: z.object({ success: z.boolean(), message: z.string() }),
      annotations: annotationsDelete,
    },
    async ({ relations }) => {
      const { deletedCount } = await graph.deleteRelations(relations)
      onMutate()
      const message =
        deletedCount === relations.length
          ? "Relations deleted successfully"
          : `Deleted ${deletedCount} of ${relations.length} relations. The rest matched nothing.`
      return {
        content: [textResult(message)],
        structuredContent: { success: true, message },
      }
    },
  )

  server.registerTool(
    "read_graph",
    {
      title: "Read Graph",
      description: "Read the entire knowledge graph",
      inputSchema: z.object({}),
      outputSchema: KnowledgeGraphSchema,
      annotations: annotationsRead,
    },
    async () => {
      const graphValue = await graph.readGraph()
      return {
        content: [textResult(JSON.stringify(graphValue, null, 2))],
        structuredContent: graphValue,
      }
    },
  )

  server.registerTool(
    "search_nodes",
    {
      title: "Search Nodes",
      description: "Search for nodes in the knowledge graph based on a query",
      inputSchema: z.object({
        query: z
          .string()
          .max(2048)
          .describe(
            "The search query to match against entity names, types, and observation content",
          ),
      }),
      outputSchema: KnowledgeGraphSchema,
      annotations: annotationsRead,
    },
    async ({ query }) => {
      const graphValue = await graph.searchNodes(query)
      return {
        content: [textResult(JSON.stringify(graphValue, null, 2))],
        structuredContent: graphValue,
      }
    },
  )

  server.registerTool(
    "open_nodes",
    {
      title: "Open Nodes",
      description: "Open specific nodes in the knowledge graph by their names",
      inputSchema: z.object({
        names: z.array(z.string()).describe("An array of entity names to retrieve"),
      }),
      outputSchema: KnowledgeGraphSchema,
      annotations: annotationsRead,
    },
    async ({ names }) => {
      const graphValue = await graph.openNodes(names)
      return {
        content: [textResult(JSON.stringify(graphValue, null, 2))],
        structuredContent: graphValue,
      }
    },
  )

  server.registerResource(
    "knowledge-graph",
    GRAPH_RESOURCE_URI,
    {
      title: "Knowledge Graph",
      description: "The full knowledge graph with all entities and relations",
      mimeType: "application/json",
    },
    async (uri) => {
      const graphValue = await graph.readGraph()
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(graphValue, null, 2),
          },
        ],
      }
    },
  )
}

/** The first modern (2026-07-28) protocol revision; revisions are ISO dates. */
const FIRST_MODERN_REVISION = "2026-07-28"

/** Whether the connection negotiated a modern (2026-07-28 or later) revision. */
function isModernEra(server: McpServer): boolean {
  const revision = server.server.getNegotiatedProtocolVersion()
  return revision !== undefined && revision >= FIRST_MODERN_REVISION
}

/**
 * Let clients subscribe to the knowledge-graph resource and return a notifier
 * that fans `notifications/resources/updated` out on every mutation.
 *
 * The two protocol eras deliver an update differently. The 2025 era has no
 * server-side subscription filter, so the notifier tracks the clients that
 * called `resources/subscribe` and notifies exactly those (matching the official
 * server's behaviour). The 2026-07-28 era delivers `resources/updated` only on a
 * client's `subscriptions/listen` stream, and the SDK filters by that stream's
 * filter, so the notifier publishes the update and lets the SDK decide who
 * receives it.
 */
function registerGraphSubscriptions(server: McpServer): () => void {
  const subscribers = new Set<string>()
  server.server.registerCapabilities({ resources: { subscribe: true } })
  server.server.setRequestHandler("resources/subscribe", (request) => {
    subscribers.add(request.params.uri)
    return {}
  })
  server.server.setRequestHandler("resources/unsubscribe", (request) => {
    subscribers.delete(request.params.uri)
    return {}
  })
  return () => {
    // The only resource is the graph, so a legacy client is notified only when it
    // subscribed to that URI — never because it subscribed to some other one. The
    // modern era lets the SDK filter by the client's `subscriptions/listen` stream.
    if (!isModernEra(server) && !subscribers.has(GRAPH_RESOURCE_URI)) {
      return
    }
    // A notification is best effort: a closed or failing transport must not
    // surface as an unhandled rejection and crash the server process.
    void server.server.sendResourceUpdated({ uri: GRAPH_RESOURCE_URI }).catch(() => undefined)
  }
}

/** Build a fully wired memory MCP server. */
export function createMemoryServer(graph: MemoryGraph, serverInfo: Implementation): McpServer {
  const server = new McpServer(serverInfo, { capabilities: { tools: {}, resources: {} } })
  const notify = registerGraphSubscriptions(server)
  registerMemoryTools(server, graph, notify)
  return server
}
