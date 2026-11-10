# server-noonien — Tool extension plan (1.3.0)

One plan for six additions to the surface an agent sees: one work breakdown, one dependency order,
one release. This document is **forward-looking** — it exists until 1.3.0 ships, then each unit's
content moves into `README.md` (tool table) and `PLAN.md` (tool surface, decisions) and the file is
deleted. It never describes history, and never restates what those two already say.

Usefulness order is the ranking below. **Implementation order is the work breakdown**, because two
units wait on a decision and the read-only ones carry no risk.

| #   | Unit               | Kind                        | User value                                 | Blocked by |
| --- | ------------------ | --------------------------- | ------------------------------------------ | ---------- |
| 1   | `read_changes`     | new read tool               | context per call: the whole graph → a page | —          |
| 2   | `search_nodes`     | behaviour of a drop-in tool | a query that finds things                  | D1 for 2b  |
| 3   | `expand_nodes`     | new read tool               | context assembly in N hops                 | —          |
| 4   | `put_observations` | new write tool              | no more contradictory twins                | D2         |
| 5   | `find_duplicates`  | new read tool               | makes `merge_entities` usable              | —          |
| 6   | `graph_stats`      | new read tool               | decides when to compact                    | —          |

## Ground rules

- **The nine stay the nine.** No unit adds, removes or renames an input on a drop-in tool; none
  introduces an operation type. `put_observations` is expressed with `observation.add` and
  `observation.delete`, so the codec, the fold and the CRDT are untouched by all six.
- **Extensions sit beside them**, named so a client of the official server never calls one by
  accident.
- **Descriptions carry the behaviour**, in the current style: the official sentence where one exists,
  then when to use the tool instead of a sibling and how it fails. Every parameter gets a
  `describe()`.
- **Reads notify nothing; the one write notifies once**, through the existing `onMutate`.
- **The gate runs before the push, not per unit** (project rule). Each unit is one commit, read back
  by hand; `npm run gate` once, on the whole tree, before 1.3.0 is pushed.

## Decisions required before the units they block

- **D1 — may `search_nodes` change its result set?** 2a (order only) needs no answer. 2b (AND over
  token prefixes) makes the nine behave differently from the official server for multi-word queries.
  Recommended: yes — the contract's value is names, inputs and outputs, not a predicate, and today's
  multi-word behaviour is a dead end.
- **D2 — accept the `key: value` convention for `put_observations`?** Recommended: yes, stated in
  the tool description. It is the price of a one-call upsert without changing the entity shape.
- **D3 — release shape.** Recommended: one minor, **1.3.0**, after all six, `CHANGELOG` heading cut
  by hand, Release workflow run once. A release per unit multiplies the four-node deploy for no
  user-visible gain.

Everything else in this plan is implementation, decided here and not asked again.

---

## Work breakdown

| Step | Unit                       | Phase | Commit                                      | Notes                                         |
| ---- | -------------------------- | ----- | ------------------------------------------- | --------------------------------------------- |
| 1    | 1 `read_changes`           | reads | `feat(tools): read only what changed`       | touches `graph.ts` + `types.ts` + `server.ts` |
| 2    | 3 `expand_nodes`           | reads | `feat(tools): expand a subgraph`            | reuses `incidentRelations`                    |
| 3    | 6 `graph_stats`            | reads | `feat(tools): report graph stats`           | one pass over the ops already read            |
| 4    | 2a `search_nodes` ranking  | reads | `feat(tools): rank search results`          | result set unchanged — asserted in a test     |
| 5    | 5 `find_duplicates`        | reads | `feat(tools): propose duplicate entities`   | new pure module                               |
| 6    | 2b `search_nodes` matching | reads | `feat(tools): match every search term`      | **only if D1**                                |
| 7    | 4 `put_observations`       | write | `feat(tools): upsert an observation by key` | **only if D2**                                |
| 8    | Instructions + docs        | ship  | `docs(tools): describe the new surface`     | README, PLAN, `instructions` string           |
| 9    | Release 1.3.0              | ship  | `chore(main): release 1.3.0`                | Release workflow, then four nodes             |

Steps 1–5 are independent of each other and of D1/D2: they can ship as 1.3.0 with steps 6–7 absent,
and 6–7 then follow as 1.3.1. That is the only contingency in this plan.

---

## Phase: reads (steps 1–5)

Every unit below is read-only, works on the memoized fold, and adds one row to the tool table.

### 1. `read_changes` — what moved since the last visit

The only way to learn what changed is `read_graph`, the whole graph, for two or three entities. The
operation log already knows the answer.

```jsonc
// input — since optional, ISO-8601
{ "since": "2026-11-10T08:00:00.000Z", "limit": 50, "offset": 0 }
// output
{
  "since": "…",                            // the window actually used, overlap included
  "watermark": "2026-11-10T09:12:41.330Z", // max ts seen; pass it back next time
  "entities": [/* current state of every entity touched in the window */],
  "relations": [/* incident relations of those entities */],
  "deleted": ["Name"]                      // deleted in the window and absent from the fold
}
```

- **Overlap, not exactness.** Every comparison is on `ts` and host clocks drift, so the window is
  rewound by a constant five minutes. Revisits cost a few hundred bytes and repeat reads are
  idempotent; an exact `ts > since` would silently drop a peer's operation written with a lagging
  clock. Constant, not an environment knob.
- `since` absent falls back to that overlap — "the last few minutes".
- **`deleted` is trustworthy** because collection keeps tombstones: an entity deleted inside the
  window still has its evidence in the log.
- Rejected: `since` on `read_graph`, which would put an optional field on a drop-in input schema for
  no gain an extension tool does not already give.

Implementation: `changes(since, options)` in `src/graph/graph.ts` (touched set from `log.read()` by
`ts`, then `currentGraph()` and filter; deleted = names with an `entity.delete` in the window that
the fold no longer contains), `ReadChangesResultSchema` in `src/graph/types.ts`, registration with
`annotationsRead` in `src/server.ts`.

Tests: an op exactly at `since` is included; an entity created before the window and observed inside
it arrives complete; a deletion inside the window is reported once and absent from `entities`; a
clock five minutes behind loses nothing; paging over the touched set.

Risk: a whole-log fold makes the first call after a change no cheaper than `read_graph`. At 10,000
operations it is single-digit milliseconds and the memoized fold covers repeats; past that the answer
is the incremental fold sketched in `SCALING.md`, not a different contract.

### 3. `expand_nodes` — the neighbourhood, not the whole graph

Context assembly is a walk, and there is none. `open_nodes` returns the entity and its incident
relations, including to entities it does not return: the agent sees that a neighbour exists and not
what it says.

```jsonc
// input
{ "names": ["Glama"], "depth": 2, "limit": 100 }
// output
{ "entities": [/* every entity within depth hops, undirected */], "relations": [/* induced */], "truncated": false }
```

`depth` defaults to 1, capped at 5; `limit` caps the entities (default 200) and sets `truncated`
instead of cutting silently; unknown names are skipped, as in `open_nodes`.

Implementation: BFS in `src/graph/graph.ts` over an adjacency map built once per call, entities in
name order for determinism.

Tests: depth 1 equals `open_nodes`; direction is ignored; a cycle terminates; `limit` sets
`truncated`; the relations returned are exactly the induced ones.

### 6. `graph_stats` — the numbers an agent can act on

```jsonc
{
  "entities": 38,
  "relations": 56,
  "observations": 210,
  "byType": [{ "entityType": "host", "entities": 5 }],
  "largest": [{ "name": "ai", "observations": 42 }],
  "operations": 503,
  "tombstones": 71,
  "lastMutation": "2026-11-10T09:12:41.330Z"
}
```

Counts come from the folded graph and one pass over the operations already read for it. Shard
counts, watermarks and peer health stay on the daemon's `/shards`, `/watermark` and `/peers`: those
are operator facts, and serving them twice is duplication.

Tests: counts on a fixture graph; `tombstones` counts delete operations, not entities; `largest` is
ordered and capped at ten; an empty graph answers zeroes rather than failing.

### 2a. `search_nodes` — ranked results

Today it is a lowercased substring over name, type and observations, returned in name order. 2a
scores the same set and returns the best first: exact name, then name prefix, then type, then
observation, with the earliest match breaking ties, then name. `limit`/`offset` page the ranked list.

The **set** stays identical, and a test asserts it: that is what keeps the drop-in claim honest.
Order changes — accepted, and stated in the README, since order was never the contract's value.

### 5. `find_duplicates` — the graph's rot, proposed not applied

The graph decays into near-duplicates (`nooniend`, `noonien daemon`, `nooniend.service`).
`merge_entities` exists but needs the pair already known, so nobody calls it.

```jsonc
// input
{ "threshold": 0.75, "limit": 20, "entityType": null }
// output
{ "pairs": [{ "a": "nooniend", "b": "noonien daemon", "score": 0.81, "reasons": ["name", "observations"] }] }
```

Names are normalised (lowercase, diacritics stripped, non-alphanumerics collapsed, known suffixes
such as `.service` trimmed) and compared by token-set Jaccard and normalised Levenshtein ratio, the
greater winning; shared observation tokens raise the score and add a reason. **Blocking** — only
entities sharing a token or whose collapsed name starts with the same three characters are compared,
and at most a fixed number of neighbours per bucket — keeps it from being quadratic at 5,000
entities. Read-only: the merge stays `merge_entities`.

Implementation: pure `src/graph/duplicates.ts` (normalise, block, score) + `findDuplicates` on
`MemoryGraph`.

Tests: a known pair is found; similar names with disjoint observations score lower; the pair set
never self-references; blocking does not hide a pair that shares a token; the limit truncates the
worst scores, not the best.

Risk: a pathological graph of one repeated token degrades toward quadratic; bounded by the bucket
cap and the limit, and the proposals are heuristic — hence no automatic merge.

---

## Phase: search matching and the upsert (steps 6–7, both conditional)

### 2b. `search_nodes` — every term must match (needs D1)

Tokenise the query, require every term, and let a term match a token by prefix (`nooni` matches
`nooniend`, `ports` matches `port`). Single-term queries stay a superset of today's results;
multi-term queries become an AND, where today they are a literal substring that almost never hits.

Implementation: 2a and 2b share a pure `src/graph/search.ts` (`terms`, `scoreEntity`), called from
`searchNodes`; no schema change either way.

Tests: score order for a name hit against an observation hit; prefix and token behaviour; an empty
query keeps today's behaviour; paging over a ranked list.

### 4. `put_observations` — keep one fact current (needs D2)

```jsonc
// input
{ "entries": [{ "entityName": "Glama", "key": "listed version", "value": "1.2.0" }] }
// output
{ "results": [{ "entityName": "Glama", "key": "listed version", "content": "listed version: 1.2.0", "action": "replaced", "replaced": 1 }] }
```

- The observation is the content `key: value`; a key owns an observation when the content is exactly
  the key or starts with `key: `, longest key first.
- **All** occurrences of the key collapse into the one new content, so a drifted twin cannot
  survive. `action` is `added` when the key was absent.
- A missing entity throws `Entity with name X not found`, as `add_observations` does: creating
  entities stays `create_entities`' job.
- Implemented as `observation.delete` + `observation.add`, like `update_observations`.

Tests: add then replace; two drifted duplicates collapse to one; the longest key wins against a
shorter prefix; a missing entity reports per entry; the op log contains only the two existing
payload types; convergence — the same put on two nodes converges and the later HLC wins.

Risk: the one unit that puts a convention into the data. An agent writing those observations by hand
can leave a key nobody replaces — accepted and stated in the description; the alternative, a
structured observation, breaks the entity shape and the drop-in contract.

---

## Phase: ship (steps 8–9)

- **`instructions`** in `src/server.ts` gains one sentence naming the read extensions and
  `put_observations`, in the voice it already uses: a model calls a tool only if it knows it exists.
  The nine stay the frame.
- **`README.md`**: six rows in the tool table; the `read_changes` overlap and the `search_nodes`
  ordering and matching rules in the paragraph that already covers paging.
- **`PLAN.md`**: six rows in the tool surface table and the two decisions that shaped them (D1, D2).
- **`CHANGELOG.md`**: one line per user-visible change under `Unreleased`, cut to `1.3.0` by hand
  before the release.
- **Release**: one `workflow_dispatch` run of the Release workflow — never `npm publish` by hand.
  Then redeploy the four nodes on 1.3.0 and verify the version and listener from `ai`.

## Out of scope

Restated so a later reader does not re-litigate them: no atomic multi-operation batch (atomicity is
not a requirement of an AP model and sequential calls work), no TTL or automatic forgetting (a
shared memory is corrected, not expired), no embeddings or vector search (a model and an index mean a
server — a different product), no entity aliases (a convention, not a primitive, and
`put_observations` covers the recurring case).
