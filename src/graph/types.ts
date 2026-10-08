// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { z } from "zod"

/**
 * The knowledge-graph data model. It is byte-for-byte the model of the official
 * `@modelcontextprotocol/server-memory` server, so the two are interchangeable.
 */
export const EntitySchema = z.object({
  name: z.string().describe("The name of the entity"),
  entityType: z.string().describe("The type of the entity"),
  observations: z
    .array(z.string())
    .describe("An array of observation contents associated with the entity"),
})

export const RelationSchema = z.object({
  from: z.string().describe("The name of the entity where the relation starts"),
  to: z.string().describe("The name of the entity where the relation ends"),
  relationType: z.string().describe("The type of the relation"),
})

export const KnowledgeGraphSchema = z.object({
  entities: z.array(EntitySchema),
  relations: z.array(RelationSchema),
})

export type Entity = z.infer<typeof EntitySchema>
export type Relation = z.infer<typeof RelationSchema>
export type KnowledgeGraph = z.infer<typeof KnowledgeGraphSchema>
