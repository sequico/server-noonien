# server-noonien — Tool extension plan (1.3.0)

One plan for the additions to the surface an agent and its operator see: one work breakdown, one
order, one release. This document is **forward-looking** — it exists until 1.3.0 ships, then each
unit's content moves into `README.md` (tool table, CLI list) and `PLAN.md` (tool surface, decisions)
and the file is deleted. It never describes history, and never restates what those two already say.

Usefulness order is the ranking below. **Implementation order is the work breakdown**, because one
unit waits on a decision and the read-only ones carry no risk. The numbers on the unit headings are
this ranking, which is why the phases visit them out of order.

| #   | Unit               | Surface        | User value                        | Blocked by |
| --- | ------------------ | -------------- | --------------------------------- | ---------- |
| 1   | `read_changes`     | new read tool  | the whole graph per turn → a page | —          |
| 2   | `find_nodes`       | new read tool  | a query that finds things         | —          |
| 3   | `expand_nodes`     | new read tool  | context assembly in N hops        | —          |
| 4   | `set_observations` | new write tool | no more contradictory twins       | D1         |
| 5   | `find_duplicates`  | new read tool  | makes `merge_entities` usable     | —          |
| 6   | `noonien stats`    | CLI subcommand | decides when to compact           | —          |

`stats` is a CLI subcommand and not a tool: its consumer is the operator, who already runs `noonien`,
and an MCP tool for an operator fact would widen the surface an agent reads for nothing.

## Ground rules

- **The nine stay the nine, literally.** No unit changes a drop-in tool — not its inputs, not its
  outputs, not the order of them. The new behaviour always arrives as a tool beside the nine, which
  is how `update_*`, `merge_entities` and `read_conflicts` already work. A client of the official
  server calls the nine and never notices the rest exists.
- **No unit introduces an operation type.** `set_observations` is expressed with `observation.add`
  and `observation.delete`, so the codec, the fold and the CRDT are untouched by all six.
- **Extensions sit beside them**, named so a client of the official server never calls one by
  accident.
- **Descriptions carry the behaviour**, in the current style: the official sentence where one exists,
  then when to use the tool instead of a sibling and how it fails. Every parameter gets a
  `describe()`.
- **Reads notify nothing; the one write notifies once**, through the existing `onMutate`.
- **Each unit lands complete**: code, tests, its `README.md`/`PLAN.md` row and its `CHANGELOG.md`
  line under `Unreleased`, in one commit. The docs describe the current state, so they cannot trail
  the code to a final sweep.
- **The gate runs once, before the push** (project rule), on the whole tree. Unit commits are read
  back by hand.

## Decisions required before the units they block

- **D1 — accept the `key: value` convention for `set_observations`?** Recommended: yes, stated in the
  tool description. It is the price of a one-call upsert without changing the entity shape.
- **D2 — release shape.** Recommended: one minor, **1.3.0**, after all six, `CHANGELOG` heading cut
  by hand, Release workflow run once. A release per unit multiplies the four-node deploy for no
  user-visible gain.

Everything else in this plan is implementation, decided here and not asked again.

---

## Work breakdown

| Step | Unit                        | Commit                                          | Notes                                     |
| ---- | --------------------------- | ----------------------------------------------- | ----------------------------------------- |
| 1    | 1 `read_changes`            | `feat(tools): read only what changed`           | `graph.ts`, `server.ts`, `server.test.ts` |
| 2    | 2 `find_nodes`              | `feat(tools): a search that finds things`       | new pure module `src/graph/search.ts`     |
| 3    | 3 `expand_nodes`            | `feat(tools): expand a subgraph`                | reuses `incidentRelations`                |
| 4    | 5 `find_duplicates`         | `feat(tools): propose duplicate entities`       | new pure module `src/graph/duplicates.ts` |
| 5    | 6 `noonien stats`           | `feat(cli): report graph stats`                 | one pass over the ops already read        |
| 6    | 4 `set_observations`        | `feat(tools): upsert an observation by key`     | **only if D1**                            |
| 7    | Instructions + read-through | `feat(tools): name the new tools at initialize` | `instructions` string, full re-read       |
| 8    | Release 1.3.0               | `chore(main): release 1.3.0`                    | Release workflow, then the four nodes     |

Steps 1–5 are independent of each other and of D1: 1.3.0 can ship with step 6 absent, and the upsert
follows as 1.3.1. That is the only contingency in this plan.

---

## Phase: reads

Read-only, over the memoized fold: each adds its row to the tool table.

### 1. `read_changes` — what moved since the last visit

The only way to learn what changed is `read_graph`, the whole graph, for two or three entities. The
operation log already knows the answer.

```jsonc
// input — since optional, ISO-8601
{ "since": "2026-11-10T08:00:00.000Z", "limit": 50, "offset": 0 }
// output
{
  "since": "…",                            // the window actually used, overlap included
  "until": "2026-11-10T09:12:41.330Z",     // this read's snapshot time; pass it back as `since`
  "entities": [/* current state of every entity touched in the window */],
  "relations": [/* incident relations of those entities */],
  "deleted": ["Name"]                      // deleted in the window and absent from the fold
}
```

- **`until` is this node's clock at read time**, never the newest operation timestamp. A peer whose
  clock runs hours ahead would otherwise push the next window into the future and silently drop
  every real change in between.
- **The window is rewound by five minutes**, a constant rather than a knob: host clocks drift, so
  the promise is "changes are complete for any node whose clock is within ±5 minutes of this one".
  Revisits cost a few hundred bytes and repeat reads are idempotent; an exact `ts > since` would
  drop a peer's operation written with a lagging clock, and that is the failure that matters.
- `since` absent means "the last five minutes"; a `since` in the future is clamped to now rather than
  answering an empty page.
- **Touched** means named by an operation in the window: an entity create or delete, an observation
  add or delete, or either endpoint of a relation add or delete.
- **`deleted` is trustworthy** because collection drops only shadowed operations and never a
  tombstone: an entity deleted inside the window still has its evidence in the log.
- `shard.compact` metadata operations are filtered out; they are not graph changes.

Implementation: `changes(since, options)` in `src/graph/graph.ts` — touched set from `log.read()` by
`ts` and payload type, then `currentGraph()` and filter; deleted = names with an `entity.delete` in
the window that the fold no longer contains. Output schema is
`KnowledgeGraphSchema.extend({ since, until, deleted })` in `server.ts`, the way every other tool's
output schema is written there.

Tests: an op exactly at `since` is included; an entity created before the window and observed inside
it arrives complete; a deletion inside the window is reported once and absent from `entities`; an
operation stamped five minutes behind is not lost; a `since` in the future is clamped; a
`shard.compact` operation in the window changes nothing; paging over the touched set.

Risk: a whole-log fold makes the first call after a change no cheaper than `read_graph`. At 10,000
operations it is single-digit milliseconds and the memoized fold covers repeats. Past that, the next
step is replaying only the new operations onto the cached graph, which changes no contract.

### 2. `find_nodes` — a search that finds things

`search_nodes` is a lowercased substring over name, type and observations, returned in name order. So
`"port redis"` finds nothing, `"ports"` does not find `port`, and the best hit is wherever the
alphabet puts it. That tool is the official one and it does not move; the search an agent would
actually type gets its own:

```jsonc
// input — query required, the rest optional
{ "query": "port redis", "entityType": "host", "limit": 20, "offset": 0 }
// output — the usual graph shape, best first
{ "entities": [/* matching entities, ranked */], "relations": [/* incident */] }
```

- The query is split into terms on non-alphanumerics; **every** term must match, and a term matches a
  token by prefix (`nooni` → `nooniend`, `ports` → `port`).
- Ranked: exact name, then name prefix, then type, then observation; the earliest match position
  breaks ties inside a field, then name. `limit`/`offset` page the ranked list, so a page is stable
  for an unchanged graph.
- A term matches a **token prefix**, so `port` finds `ports` and not `support`: the two searches
  differ, and neither is a superset of the other. `search_nodes` still answers the literal-substring
  question, which is why it stays exactly as it is instead of being replaced.
- `entityType` filters to one exact type, as on `search_nodes`.

Implementation: pure `src/graph/search.ts` (`terms`, `scoreEntity`) called from a new `findNodes` on
`MemoryGraph`; registration with `annotationsRead` and the usual `KnowledgeGraph` output schema.

Tests: a name hit outranks an observation hit; prefix and token matching; a multi-word query that
finds nothing today now finds the entity; a term inside a longer word (`port` in `support`) is found
by `search_nodes` and not by `find_nodes` — the case that keeps both tools; an empty query returns
everything in name order, as `search_nodes` does; paging over a ranked list; and one test asserting
`search_nodes` still answers exactly what it answered before this plan.

### 3. `expand_nodes` — the neighbourhood, not the whole graph

Context assembly is a walk, and there is none. `open_nodes` returns the entity and its incident
relations, including to entities it does not return: the agent sees that a neighbour exists and not
what it says.

```jsonc
// input
{ "names": ["Glama"], "depth": 2, "limit": 100 }
// output
{ "entities": [/* every entity within depth hops, undirected */], "relations": [/* incident */], "truncated": false }
```

`depth` defaults to 1, capped at 5; `limit` caps the entities (default 200) and sets `truncated`
instead of cutting silently; unknown names are skipped, as in `open_nodes`. Relations are the
incident ones, the same rule every other read uses — so depth 1 answers exactly what `open_nodes`
answers, plus `truncated`.

Implementation: BFS in `src/graph/graph.ts` over an adjacency map built once per call, neighbours
visited in name order, so the cap drops the far frontier and never a close neighbour; the selected
entities are then sorted by name for a stable response.

Tests: depth 1 equals `open_nodes`; direction is ignored; a cycle terminates; `limit` sets
`truncated`; unknown names are skipped.

### 5. `find_duplicates` — the graph's rot, proposed not applied

The graph decays into near-duplicates (`nooniend`, `noonien daemon`, `nooniend.service`).
`merge_entities` exists but needs the pair already known, so nobody calls it.

```jsonc
// input — every field optional
{ "threshold": 0.75, "limit": 20 }
// output
{ "pairs": [{ "a": "nooniend", "b": "noonien daemon", "score": 0.81, "reasons": ["name", "observations"] }] }
```

Names are normalised (lowercase, diacritics stripped, non-alphanumerics collapsed, known suffixes
such as `.service` trimmed) and compared by token-set Jaccard and normalised Levenshtein ratio, the
greater winning; shared observation tokens raise the score and add a reason. A pair is proposed when
its score reaches `threshold`.

**Blocking** keeps it from being quadratic: entities are bucketed by each name token, and a bucket
compares at most its first 200 members (they are in name order), so the cost is bounded by
`entities × tokens × 200` instead of `entities²`. That cap is a stated limit: a pair whose names
share no token early in the ordering is not proposed.

Read-only: the merge stays `merge_entities`.

Implementation: pure `src/graph/duplicates.ts` (normalise, bucket, score) + `findDuplicates` on
`MemoryGraph`.

Tests: a known pair is found; similar names with disjoint observations score lower; the pair set
never self-references; blocking still finds a pair that shares one token; the limit truncates the
worst scores, not the best.

Risk: proposals are heuristic and the bucket cap is a stated limit — hence no automatic merge and a
`shortcut:` comment where the cap lives.

---

## Phase: the CLI

### 6. `noonien stats` — the numbers an operator acts on

Counting the graph today means fetching a route and piping it through `jq`
(`curl -s …/graph | jq '.entities|length'`), and the daemon's routes exist only where a daemon
runs. One command, one screen, over the same folded state — ergonomics, not a new capability, which
is why it comes last and is the easiest to drop:

```text
entities 38 · relations 56 · observations 210 · operations 503 · deletions 71
largest: ai 42, Glama 17, nooniend 12
types: host 5, service 4, registry 3
last mutation: 2026-11-10T09:12:41.330Z
```

Implementation: `stats()` in `src/graph/graph.ts` (folded graph plus one pass over the operations
already read, `shard.compact` excluded) and a `stats` case in `src/cli.ts` beside `query`. Shard
counts, watermarks and peer health stay on `/shards`, `/watermark` and `/peers`: same facts served
twice is duplication.

Tests: counts on a fixture graph in `test/cli.test.ts`; `deletions` counts delete operations, not
entities; an empty graph prints zeroes rather than failing.

---

## Phase: the upsert, conditional

### 4. `set_observations` — keep one fact current (needs D1)

```jsonc
// input
{ "entries": [{ "entityName": "Glama", "key": "listed version", "value": "1.2.0" }] }
// output
{ "results": [{ "entityName": "Glama", "key": "listed version", "content": "listed version: 1.2.0", "action": "replaced" }] }
```

- The observation is the content `key: value`; a key owns an observation when the content is exactly
  the key or starts with `key: `. A key containing `: ` is refused, because it would let two keys own
  the same observation; the validation message says so.
- **All** occurrences of the key collapse into the one new content, so a drifted twin cannot survive.
  Entries apply in order, so a second entry for the same key sees what the first wrote. `action` is
  `added` when the key was absent.
- A missing entity throws `Entity with name X not found`, as `add_observations` does: creating
  entities stays `create_entities`' job.
- Implemented as `observation.delete` + `observation.add`, like `update_observations`; one commit,
  one notification.

Tests: add then replace; two drifted duplicates collapse to one; `key:extra` without the space is
not owned by the key `key`; a key containing `: ` is refused; two entries on one key end in one
observation; a missing entity reports per entry; the op log contains only the two existing payload
types; convergence — the same set on two nodes converges and the later HLC wins.

Risk: the one unit that puts a convention into the data. An agent writing those observations by hand
can leave a key nobody replaces — accepted and stated in the description; the alternative, a
structured observation, breaks the entity shape and the drop-in contract.

---

## Phase: ship

- **`instructions`** in `src/server.ts` gains one sentence naming the new read tools and
  `set_observations`, in the voice it already uses: a model calls a tool only if it knows it exists,
  and this is the only way a client learns that `find_nodes` exists beside `search_nodes`. The nine
  stay the frame. This is the one thing the units cannot do in their own commit, because one
  sentence covers all of them.
- **Release**: the `Unreleased` heading cut by hand into `1.3.0` with its date, then one
  `workflow_dispatch` run of the Release workflow — never `npm publish` by hand. Then redeploy the
  four nodes on 1.3.0 and verify the version and the listener from `ai`.

## Out of scope

Restated so a later reader does not re-litigate them: no change to a drop-in tool's behaviour, even
an improvement (the better search is a tool beside it); no atomic multi-operation batch (atomicity is
not a requirement of an AP model and sequential calls work); no TTL or automatic forgetting (a shared
memory is corrected, not expired); no embeddings or vector search (a model and an index mean a
server — a different product); no entity aliases (a convention, not a primitive, and
`set_observations` covers the recurring case).
