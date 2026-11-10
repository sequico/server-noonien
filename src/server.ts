// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import type { Implementation } from "@modelcontextprotocol/server"
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server"
import { z } from "zod"
import type { MemoryGraph } from "./graph/graph.js"
import { EntitySchema, KnowledgeGraphSchema, RelationSchema } from "./graph/types.js"

/** The resource URI the official memory server exposes the whole graph at. */
export const GRAPH_RESOURCE_URI = "memory://knowledge-graph"

/** The resource template that answers the same window as `read_changes`. */
export const CHANGES_RESOURCE_URI = "memory://changes"

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

// An edit tombstones what it replaces — the old name, the old relation key, the old
// content — so `destructiveHint` stays true: the MCP definition of `false` is *only
// additive updates*, which this is not, and the hint's job is to warn, not to be
// pleasant. Keeping the tool attractive is the description's job and the server
// instructions' job; a false hint would just move the surprise to the caller. It is not
// advertised as idempotent either: writing the same value again is a no-op, but writing
// a change twice is not a repeat.
const annotationsUpdate = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const

function textResult(text: string): { type: "text"; text: string } {
  return { type: "text", text }
}

/**
 * Register the nine drop-in memory tools, the extension tools beside them and the
 * knowledge-graph resource on a server, backed by the given graph. The nine
 * names, inputs, outputs, messages and annotations mirror
 * `@modelcontextprotocol/server-memory` exactly; the `update_*`, `merge_entities`
 * and `read_conflicts` additions never change them. The description text is ours and
 * the drop-in contract does not cover it: each keeps the official sentence and adds
 * what an agent needs to choose the tool and predict its effect. `onMutate`
 * runs after every successful mutation so the server can notify subscribers.
 */
function registerMemoryTools(server: McpServer, graph: MemoryGraph, onMutate: () => void): void {
  server.registerTool(
    "create_entities",
    {
      title: "Create Entities",
      description:
        "Create multiple new entities in the knowledge graph. A name that already exists is skipped and left unchanged — use add_observations to extend it — and only the entities actually created are returned. Observations are stored exactly as given, duplicate contents included.",
      inputSchema: z.object({
        entities: z
          .array(EntitySchema)
          .describe("The entities to create, each with its name, type and observations"),
      }),
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
        'Create multiple new relations between entities in the knowledge graph. Relations should be in active voice. Both endpoints must already exist: one missing name fails the whole call with "Entity with name … not found". A relation that is already present is skipped, so the response lists only the ones added.',
      inputSchema: z.object({
        relations: z
          .array(RelationSchema)
          .describe("The relations to create, each with its from, to and relationType"),
      }),
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
      description:
        "Add new observations to existing entities in the knowledge graph. Content the entity already holds is not added again, while duplicates within one request are kept as separate occurrences; the response reports what was added per entity. Every named entity must exist — a missing one fails the whole call, so create it with create_entities first. To replace a content use update_observations, to remove one use delete_observations.",
      inputSchema: z.object({
        observations: z
          .array(
            z.object({
              entityName: z.string().describe("The name of the entity to add the observations to"),
              contents: z.array(z.string()).describe("An array of observation contents to add"),
            }),
          )
          .describe("One entry per entity: the entity name and the contents to add"),
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
    "update_entities",
    {
      title: "Update Entities",
      description:
        "Prefer this to deleting an entity and re-creating it under another name: rename existing entities and/or change their entity type, keeping their observations and relations. A rename onto a name that already exists is refused rather than merging the two; an unknown name is reported and the batch keeps its other entries.",
      inputSchema: z.object({
        entities: z
          .array(
            z.object({
              name: z.string().describe("The current name of the entity to update"),
              newName: z
                .string()
                .optional()
                .describe("The new name to rename the entity to; omit to keep the current name"),
              entityType: z
                .string()
                .optional()
                .describe("The new entity type; omit to keep the current type"),
            }),
          )
          .describe("One entry per entity: the current name, and the new name and/or type"),
      }),
      outputSchema: z.object({
        results: z.array(
          z.object({
            name: z.string(),
            renamedTo: z.string().optional(),
            entityType: z.string().optional(),
            updated: z.boolean(),
            reason: z.string().optional(),
          }),
        ),
      }),
      annotations: annotationsUpdate,
    },
    async ({ entities }) => {
      const { results } = await graph.updateEntities(entities)
      onMutate()
      return {
        content: [textResult(JSON.stringify(results, null, 2))],
        structuredContent: { results },
      }
    },
  )

  server.registerTool(
    "update_observations",
    {
      title: "Update Observations",
      description:
        "Prefer this to delete_observations followed by add_observations: replace observation contents on existing entities in place",
      inputSchema: z.object({
        updates: z
          .array(
            z.object({
              entityName: z.string().describe("The name of the entity holding the observation"),
              oldContent: z.string().describe("The observation content to replace"),
              newContent: z.string().describe("The content to replace it with"),
            }),
          )
          .describe(
            "One entry per replacement: the entity, the content to replace and the new content",
          ),
      }),
      outputSchema: z.object({
        results: z.array(
          z.object({
            entityName: z.string(),
            oldContent: z.string(),
            newContent: z.string(),
            updated: z.boolean(),
            reason: z.string().optional(),
          }),
        ),
      }),
      annotations: annotationsUpdate,
    },
    async ({ updates }) => {
      const { results } = await graph.updateObservations(updates)
      onMutate()
      return {
        content: [textResult(JSON.stringify(results, null, 2))],
        structuredContent: { results },
      }
    },
  )

  server.registerTool(
    "update_relations",
    {
      title: "Update Relations",
      description:
        "Prefer this to deleting a relation and creating another: change the type of existing relations and/or repoint their endpoints. Each entry is matched by its current from, to and relationType; a missing match is reported, not thrown, so the batch keeps its other entries.",
      inputSchema: z.object({
        relations: z
          .array(
            z.object({
              from: z.string().describe("The name of the entity where the relation starts"),
              to: z.string().describe("The name of the entity where the relation ends"),
              relationType: z.string().describe("The type of the relation"),
              newFrom: z
                .string()
                .optional()
                .describe("The new start entity; omit to keep the current one"),
              newTo: z
                .string()
                .optional()
                .describe("The new end entity; omit to keep the current one"),
              newRelationType: z
                .string()
                .optional()
                .describe("The new relation type; omit to keep the current one"),
            }),
          )
          .describe("One entry per relation: its current from/to/relationType and the new values"),
      }),
      outputSchema: z.object({
        results: z.array(
          z.object({
            from: z.string(),
            to: z.string(),
            relationType: z.string(),
            updated: z.boolean(),
            reason: z.string().optional(),
          }),
        ),
      }),
      annotations: annotationsUpdate,
    },
    async ({ relations }) => {
      const { results } = await graph.updateRelations(relations)
      onMutate()
      return {
        content: [textResult(JSON.stringify(results, null, 2))],
        structuredContent: { results },
      }
    },
  )

  server.registerTool(
    "merge_entities",
    {
      title: "Merge Entities",
      description:
        "Prefer this to deleting one entity and re-adding its observations and relations to another: merge an entity into another, unioning their observations and repointing its relations. The target keeps its name; the absorbed entity is deleted. It cannot be undone, so pass dryRun first to see the observations joined, the relations repointed and the name that disappears; find_duplicates proposes pairs that look like the same thing.",
      inputSchema: z.object({
        merges: z
          .array(
            z.object({
              from: z.string().describe("The name of the entity to merge in and delete"),
              into: z.string().describe("The name of the entity it is merged into"),
            }),
          )
          .describe(
            "One entry per merge: the entity to absorb and delete, and the entity it merges into",
          ),
        dryRun: z
          .boolean()
          .optional()
          .describe(
            "Report what the merges would change, and write nothing; omit for a real merge",
          ),
      }),
      outputSchema: z.object({
        results: z.array(
          z.object({
            from: z.string(),
            into: z.string(),
            merged: z.boolean(),
            reason: z.string().optional(),
            observationsJoined: z.number().int().optional(),
            relationsRepointed: z.number().int().optional(),
            removedName: z.string().optional(),
            applied: z.boolean().optional(),
          }),
        ),
      }),
      annotations: annotationsUpdate,
    },
    async ({ merges, dryRun }) => {
      const { results } = await graph.mergeEntities(merges, { dryRun })
      if (dryRun !== true) {
        onMutate()
      }
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
        "Delete multiple entities and their associated relations from the knowledge graph. Unknown names are ignored rather than failing, and the message reports how many were deleted and which were not found. The deletion also removes the entity's observations and its incident relations, and it is durable: a tombstone beats a concurrent write from another machine.",
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
      description:
        "Delete specific observations from entities in the knowledge graph. Deletion is by content: every occurrence of that content on the entity goes. A batch is not all-or-nothing — the message reports how many were deleted and names the entities that were not found. To replace a content in place use update_observations; to remove the whole entity use delete_entities.",
      inputSchema: z.object({
        deletions: z
          .array(
            z.object({
              entityName: z.string().describe("The name of the entity containing the observations"),
              observations: z.array(z.string()).describe("An array of observations to delete"),
            }),
          )
          .describe("One entry per entity: the entity name and the contents to delete"),
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
      description:
        "Delete multiple relations from the knowledge graph. A relation is matched by its from, to and relationType; one that matches nothing is ignored, and the message reports how many of the requested relations were deleted. Deleting an entity removes its incident relations with it, so this is for dropping one edge while both endpoints stay.",
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
      description:
        "Read the knowledge graph, or a page of it: the optional limit and offset take a slice of the entities in name order. Use it for the whole graph; for a query use search_nodes, for names you already know use open_nodes, and for the elements more than one node wrote use read_conflicts. A page carries the relations that touch its entities. To read only what changed since your last visit, use read_changes.",
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("The most entities to return; omit for all of them"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("How many entities to skip before the page; omit for none"),
      }),
      outputSchema: KnowledgeGraphSchema,
      annotations: annotationsRead,
    },
    async ({ limit, offset }) => {
      const graphValue = await graph.readGraph({ limit, offset })
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
      description:
        "Search for nodes in the knowledge graph based on a query. The query is matched against entity names, types and observation content; entityType narrows to one exact type, and limit/offset page the matches in name order. For the whole graph use read_graph, and for names you already know use open_nodes. For a search written the way a query is spoken, use find_nodes: it matches whole words and ranks the results.",
      inputSchema: z.object({
        query: z
          .string()
          .max(2048)
          .describe(
            "The search query to match against entity names, types, and observation content",
          ),
        entityType: z
          .string()
          .optional()
          .describe("Only entities of this exact type; omit to match every type"),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("The most entities to return; omit for all of them"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("How many matches to skip before the page; omit for none"),
      }),
      outputSchema: KnowledgeGraphSchema,
      annotations: annotationsRead,
    },
    async ({ query, entityType, limit, offset }) => {
      const graphValue = await graph.searchNodes(query, { entityType, limit, offset })
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
      description:
        "Open specific nodes in the knowledge graph by their names. Names that do not exist are omitted rather than failing, and the result carries every relation touching the entities returned, including relations to entities outside it. Use it when the names are known; for a query use search_nodes, for everything use read_graph.",
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

  server.registerTool(
    "read_conflicts",
    {
      title: "Read Conflicts",
      description:
        "Call this when a write may have been superseded by another machine, or before trusting an edit: it lists the elements more than one node has written, with what each node left and when it last touched it, so a last-writer-wins resolution is visible instead of silent. Settle a contested element with resolve_conflict.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        conflicts: z.array(
          z.object({
            element: z.string(),
            authors: z.array(
              z.object({
                node: z.string(),
                ts: z.string(),
                value: z.string(),
              }),
            ),
            operations: z.number().int(),
          }),
        ),
      }),
      annotations: annotationsRead,
    },
    async () => {
      const report = await graph.conflicts()
      return {
        content: [textResult(JSON.stringify(report, null, 2))],
        structuredContent: report,
      }
    },
  )

  server.registerTool(
    "read_changes",
    {
      title: "Read Changes",
      description:
        "Read only what changed in a window you choose: the entities touched in it, as they are now, and the names deleted in it. Use it instead of read_graph when you are coming back to a memory you already know — the whole graph for two changed entities costs the context you came to use. The window reaches five minutes further back than you ask, so a change written by a peer with a slightly lagging clock is not lost, and reading the same window twice is harmless. It also returns until, the moment it stopped at, in this node's clock: pass that back as since and the next read continues from there.",
      inputSchema: z.object({
        since: z
          .string()
          .refine((value) => !Number.isNaN(new Date(value).getTime()), {
            message: "must be an ISO-8601 timestamp",
          })
          .optional()
          .describe(
            "The ISO-8601 moment to read after; omit it for the last five minutes, or pass the moment a previous call returned to continue where that call stopped",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("The most entities to return; omit for all of them"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("How many entities to skip before the page; omit for none"),
      }),
      outputSchema: KnowledgeGraphSchema.extend({
        since: z.string(),
        until: z.string(),
        deleted: z.array(z.string()),
      }),
      annotations: annotationsRead,
    },
    async ({ since, limit, offset }) => {
      const value = await graph.changes(since === undefined ? undefined : new Date(since), {
        limit,
        offset,
      })
      return {
        content: [textResult(JSON.stringify(value, null, 2))],
        structuredContent: value,
      }
    },
  )

  server.registerTool(
    "find_nodes",
    {
      title: "Find Nodes",
      description:
        "Search the graph the way a query is written, not as a literal string: every word must match, a word matches the beginning of a longer one, and the best matches come first. Use it instead of search_nodes when the query is more than one word, or when a word may be spelled differently — ports for port. search_nodes is the literal-substring search and stays for exactly that. A word that matches nothing makes the result empty rather than failing the call.",
      inputSchema: z.object({
        query: z.string().max(2048).describe("The words to look for"),
        entityType: z
          .string()
          .optional()
          .describe("Keep only entities of exactly this type; omit to match every type"),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("The most entities to return; omit for all of them"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("How many ranked results to skip before the page; omit for none"),
      }),
      outputSchema: KnowledgeGraphSchema,
      annotations: annotationsRead,
    },
    async ({ query, entityType, limit, offset }) => {
      const value = await graph.findNodes(query, { entityType, limit, offset })
      return {
        content: [textResult(JSON.stringify(value, null, 2))],
        structuredContent: value,
      }
    },
  )

  server.registerTool(
    "expand_nodes",
    {
      title: "Expand Nodes",
      description:
        "Walk out from the entities you name: every entity within depth hops, with the relations that touch them. Use it instead of read_graph to assemble the context around a topic, and instead of open_nodes when the neighbours' content matters as much as the entity you started from. The walk ignores direction, stops on cycles, and skips names that do not exist rather than failing. When limit binds, truncated is true and the farthest entities are the ones left out.",
      inputSchema: z.object({
        names: z.array(z.string()).describe("The entities to start from"),
        depth: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe("How many hops to walk, 1 by default and at most 5"),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("The most entities to return, 200 by default"),
      }),
      outputSchema: KnowledgeGraphSchema.extend({ truncated: z.boolean() }),
      annotations: annotationsRead,
    },
    async ({ names, depth, limit }) => {
      const value = await graph.expandNodes(names, { depth, limit })
      return {
        content: [textResult(JSON.stringify(value, null, 2))],
        structuredContent: value,
      }
    },
  )

  server.registerTool(
    "resolve_conflict",
    {
      title: "Resolve Conflict",
      description:
        "Settle an element that more than one machine has written: keep it or drop it with a stamp newer than anything in the log, so the decision wins on every node as the change propagates. Use it after read_conflicts named the element and you have decided how it should stand — re-creating it with the existing tools is not enough, because a write that already exists is skipped, and deleting what is already tombstoned changes nothing. An element that already stands as you ask is left untouched and reported as unchanged, because every write is durable history. An observation needs the entity to exist, and a relation both of its endpoints, exactly as when they were created.",
      inputSchema: z.object({
        elements: z
          .array(
            z.object({
              entityName: z
                .string()
                .optional()
                .describe("The entity that holds an observation; give it with content"),
              content: z
                .string()
                .optional()
                .describe("The observation content; give it with entityName"),
              from: z
                .string()
                .optional()
                .describe("The name where a relation starts; give it with to and relationType"),
              to: z
                .string()
                .optional()
                .describe("The name where a relation ends; give it with from and relationType"),
              relationType: z
                .string()
                .optional()
                .describe("The relation type; give it with from and to"),
              keep: z.boolean().describe("True to make the element stand, false to make it go"),
            }),
          )
          .describe("One entry per element: an observation or a relation, and whether it stands"),
      }),
      outputSchema: z.object({
        results: z.array(
          z.object({
            element: z.string(),
            keep: z.boolean(),
            changed: z.boolean(),
          }),
        ),
      }),
      annotations: annotationsUpdate,
    },
    async ({ elements }) => {
      const { results } = await graph.resolveConflicts(elements)
      onMutate()
      return {
        content: [textResult(JSON.stringify(results, null, 2))],
        structuredContent: { results },
      }
    },
  )

  server.registerTool(
    "find_duplicates",
    {
      title: "Find Duplicates",
      description:
        'Propose pairs of entities that may be the same thing, so merge_entities can be used on a pair you would not have noticed. With by: "name" the names are compared after case, spacing, punctuation and a known suffix such as .service are normalised, and overlapping observations raise the score; with by: "content" the observations are compared instead, which is how one fact written twice under two names is found. It is read-only. A score is a hint, not a verdict: read both entities before merging them.',
      inputSchema: z.object({
        by: z
          .enum(["name", "content"])
          .optional()
          .describe("What to compare: name (default) or content"),
        threshold: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("The lowest score to report, 0.75 by default"),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("The most pairs to return, 20 by default, best first"),
      }),
      outputSchema: z.object({
        pairs: z.array(
          z.object({
            a: z.string(),
            b: z.string(),
            score: z.number(),
            reasons: z.array(z.string()),
          }),
        ),
      }),
      annotations: annotationsRead,
    },
    async ({ by, threshold, limit }) => {
      const value = await graph.findDuplicates({ by, threshold, limit })
      return {
        content: [textResult(JSON.stringify(value, null, 2))],
        structuredContent: value,
      }
    },
  )

  server.registerTool(
    "read_history",
    {
      title: "Read History",
      description:
        "Show what wrote an entity and when: the operations that touched it, newest first, with their timestamp, node and kind. Use it to tell a fact confirmed yesterday from one nobody has touched in months, which no other tool answers — read_conflicts covers only contested elements, and the graph itself carries no dates. For the current state use open_nodes; for what changed in a window use read_changes.",
      inputSchema: z.object({
        entityNames: z
          .array(z.string())
          .describe("The entities to trace; a relation counts under both of its endpoints"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("The most operations to return, 50 by default and at most 500"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("How many operations to skip before the page; omit for none"),
      }),
      outputSchema: z.object({
        entries: z.array(
          z.object({
            entityName: z.string(),
            ts: z.string(),
            node: z.string(),
            kind: z.string(),
            detail: z.string(),
          }),
        ),
      }),
      annotations: annotationsRead,
    },
    async ({ entityNames, limit, offset }) => {
      const value = await graph.history({ entityNames, limit, offset })
      return {
        content: [textResult(JSON.stringify(value, null, 2))],
        structuredContent: value,
      }
    },
  )

  server.registerTool(
    "set_observations",
    {
      title: "Set Observations",
      description:
        "Keep one fact current: write key: value on an entity, replacing every observation that key already holds, so a drifted twin cannot survive. Use it instead of update_observations when the value changes over time — a version, a status — and you should not have to remember its previous text. An observation belongs to a key when it is exactly the key or starts with the key, a colon and a space, and a key may not itself contain a colon followed by a space. A missing entity fails as add_observations does: create it with create_entities first.",
      inputSchema: z.object({
        entries: z
          .array(
            z.object({
              entityName: z.string().describe("The entity that holds the fact"),
              key: z
                .string()
                .describe("The name of the fact, matched at the start of an observation"),
              value: z.string().describe("What the fact is now"),
            }),
          )
          .describe("One entry per fact"),
      }),
      outputSchema: z.object({
        results: z.array(
          z.object({
            entityName: z.string(),
            key: z.string(),
            content: z.string(),
            action: z.enum(["added", "replaced"]),
          }),
        ),
      }),
      annotations: annotationsUpdate,
    },
    async ({ entries }) => {
      const { results } = await graph.setObservations(entries)
      onMutate()
      return {
        content: [textResult(JSON.stringify(results, null, 2))],
        structuredContent: { results },
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

  const readChanges = async (uri: URL) => {
    const since = uri.searchParams.get("since")
    const value = await graph.changes(since === null ? undefined : new Date(since))
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(value, null, 2),
        },
      ],
    }
  }
  // Both are needed: a template matches only when the query is present, and a client that
  // just refreshes its context asks for the bare URI and wants the default window.
  server.registerResource(
    "changes",
    CHANGES_RESOURCE_URI,
    {
      title: "Changes",
      description:
        "What moved in the last five minutes: the same body as read_changes, the window it used included",
      mimeType: "application/json",
    },
    readChanges,
  )
  server.registerResource(
    "changes-window",
    new ResourceTemplate(`${CHANGES_RESOURCE_URI}{?since}`, { list: undefined }),
    {
      title: "Changes since",
      description: "What moved since an ISO-8601 moment: the same body as read_changes",
      mimeType: "application/json",
    },
    readChanges,
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
 * Let clients subscribe to the graph and the changes resources, and return a notifier
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
  const uris = [GRAPH_RESOURCE_URI, CHANGES_RESOURCE_URI]
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
    // A legacy client is notified only for the resource it subscribed to — never
    // because it subscribed to some other one. The modern era lets the SDK filter
    // by the client's `subscriptions/listen` stream.
    for (const uri of uris) {
      if (!isModernEra(server) && !subscribers.has(uri)) {
        continue
      }
      // A notification is best effort: a closed or failing transport must not
      // surface as an unhandled rejection and crash the server process.
      void server.server.sendResourceUpdated({ uri }).catch(() => undefined)
    }
  }
}

/**
 * What the model is told about this surface, in the `initialize` result. A model already
 * knows the nine official tools and reaches for `delete_*` + `create_*` by habit, so the
 * value of an edit — and of `read_conflicts` in particular — has to be stated where the
 * client reads it, not only in each tool's own description.
 */
const INSTRUCTIONS =
  "Shared, conflict-free knowledge-graph memory — entities with observations, and typed " +
  "relations between them — converged across machines without a server. The nine memory " +
  "tools behave as in @modelcontextprotocol/server-memory. To change what already exists, do " +
  "not compose delete + create: rename an entity or change its type with update_entities, " +
  "replace an observation content with update_observations, change a relation's type or " +
  "endpoints with update_relations, and combine two entities with merge_entities, which takes " +
  "a dryRun when you want to see the bill first. For a large graph, page read_graph and " +
  "search_nodes with limit/offset, and filter search_nodes by entityType. " +
  "find_nodes searches the way a query is written — every word must match, results are " +
  "ranked — while search_nodes is the literal substring. read_changes reads what moved in a " +
  "window instead of the whole graph, expand_nodes walks a neighbourhood out from the entities " +
  "you name, and find_duplicates proposes pairs that look like the same thing. To settle what " +
  "two machines wrote, read_conflicts lists it with the values and the times and " +
  "resolve_conflict decides it; read_history says who wrote an entity and when; " +
  "set_observations keeps a key: value fact current."

/** Build a fully wired memory MCP server. */
export function createMemoryServer(graph: MemoryGraph, serverInfo: Implementation): McpServer {
  const server = new McpServer(serverInfo, {
    capabilities: { tools: {}, resources: {} },
    instructions: INSTRUCTIONS,
  })
  const notify = registerGraphSubscriptions(server)
  registerMemoryTools(server, graph, notify)
  return server
}
