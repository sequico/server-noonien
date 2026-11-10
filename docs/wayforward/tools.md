# server-noonien — Tool extension plan (1.3.0)

One plan for what an agent will see, for what the store does on its own, and for the guards that keep
both honest: one order, one release, one read-through of the public documents. This document is
**forward-looking** — it exists until 1.3.0 ships, then each unit's content moves into `README.md`
(tool table, CLI list) and `docs/plan.md` (tool surface, decisions, automation) and the file is
deleted. It never describes history, and never restates what those two already say.

## What changes

Ranked by what it is worth to whoever uses it. The body follows the **order of work**, which is not
this order. Of the twenty-one tools after this release, four are **core** — `read_changes`,
`find_nodes`, `expand_nodes`, `find_duplicates` — and an agent's accuracy falls as the surface grows,
so `instructions` will name the core ones first.

| #   | Change                                                                | For      |
| --- | --------------------------------------------------------------------- | -------- |
| 1   | `read_changes` — a window of what moved instead of the whole graph    | agent    |
| 2   | `find_nodes` — a search that finds what a person meant to type        | agent    |
| 3   | `expand_nodes` — a neighbourhood N hops out, for context assembly     | agent    |
| 4   | `resolve_conflict` — settle an element two machines wrote             | agent    |
| 5   | `read_conflicts` — the values and the times, not just the authors     | agent    |
| 6   | `find_duplicates` — proposals for the same thing under two names      | agent    |
| 7   | `read_history` — who wrote this, and when                             | agent    |
| 8   | `set_observations` — one fact kept current instead of a pile of twins | agent    |
| 9   | `memory://changes` — the same window as a subscribable resource       | agent    |
| 10  | `merge_entities` — a dry run, so an irreversible merge can be read    | agent    |
| 11  | `noonien stats` — the numbers, the freshness, and `--json`            | operator |
| 12  | `noonien doctor` — does every shard parse, and is anything orphaned   | operator |
| 13  | `noonien export --out --keep` — dated snapshots with retention        | operator |
| 14  | Compaction by bytes, off the write path, with backoff                 | store    |
| 15  | The daemon's guard for the server, once verified                      | store    |
| 16  | Three pointing sentences on the nine, so the new tools are found      | agent    |

## Ground rules

- **The nine stay the nine.** No unit changes a drop-in tool's names, input schema, output schema,
  messages or the order of their results. Their **description text** is ours and may gain a sentence
  that names a better sibling: the contract does not cover prose, and a tool an agent never hears
  about is a tool that does not exist.
- **No unit introduces an operation type.** Everything is expressed with `entity.*`, `observation.*`
  and `relation.*`, so the codec, the fold and the CRDT are untouched.
- **An automation may touch structure, never meaning.** Compacting, exporting and measuring run on
  their own; merging, deleting and deciding stay with an agent or the owner. The reasons are in
  _Out of scope_.
- **Extensions are named so a client of the official server never calls one by accident**, and
  described so an agent that could use one finds it.
- **Descriptions carry the behaviour**: the official sentence where one exists, then when to use the
  tool instead of a sibling and how it fails. Every parameter gets a `describe()`; the exact words are
  in _The words an agent reads_.
- **Reads notify nothing; a write notifies once**, through the existing `onMutate`. Every new read
  tool carries `annotationsRead`; `resolve_conflict` and `set_observations` carry the edit annotations.
- **Each unit lands complete**: code, tests, its `README.md`/`docs/plan.md` row (written or amended)
  and its `CHANGELOG.md` line under `Unreleased`, in one commit.
- **The gate runs once, before the push** (project rule), on the whole tree. Unit commits are read
  back by hand.

## Decisions taken

- **D1 — the `key: value` convention for `set_observations`: accepted (owner, 2026-11-10).** The tool
  states it in its description, and a key containing `: ` is refused rather than left to mean two
  things.
- **D2 — release shape: one minor, 1.3.0 (owner, 2026-11-10).** Everything ships together, the
  `CHANGELOG` heading is cut by hand, the Release workflow runs once.
- **D3 — the guards enter CI: approved (owner, 2026-11-10).** The link check and the README-drift check
  become steps in `ci.yml`; this is the approval the project law requires for a workflow change, and it
  covers these two steps only.
- **D4 — scope: no slice, everything ships (owner, 2026-11-10).** There is no reduced first release and
  no step with a narrowed scope: a step that cannot be finished is a step that does not ship, and the
  release waits.

Everything else in this plan is implementation, decided here and not asked again.

---

## The order

| Step | Unit                       | Commit                                                   | Notes                                          |
| ---- | -------------------------- | -------------------------------------------------------- | ---------------------------------------------- |
| 1    | Surface test               | `test(tools): lock the surface before it grows`          | every tool, every parameter, every kind        |
| 2    | Drop-in contract test      | `test(tools): pin what the nine answer`                  | expected values, not snapshots                 |
| 3    | Link check                 | `feat(repo): fail on a relative link that leads nowhere` | in `ci.yml` (D3)                               |
| 4    | `read_changes`             | `feat(tools): read only what changed`                    | `graph.ts`, `server.ts`                        |
| 5    | `find_nodes`               | `feat(tools): a search that finds things`                | new pure module `src/graph/search.ts`          |
| 6    | `expand_nodes`             | `feat(tools): expand a subgraph`                         | reuses `incidentRelations`                     |
| 7    | `read_conflicts` + times   | `feat(tools): show the values a conflict carries`        | output of an extension tool                    |
| 8    | `resolve_conflict`         | `feat(tools): settle a contested element`                | drafts committed directly                      |
| 9    | `find_duplicates`          | `feat(tools): propose duplicate entities`                | `by: name \| content`                          |
| 10   | `read_history`             | `feat(tools): trace who wrote an entity and when`        | reads the log, not the fold                    |
| 11   | `merge_entities` dry run   | `feat(tools): preview a merge before it happens`         | optional input on an extension                 |
| 12   | `set_observations`         | `feat(tools): upsert an observation by key`              | D1 accepted                                    |
| 13   | `memory://changes`         | `feat(resources): subscribe to what changed`             | reuses `changes()`                             |
| 14   | Three pointing sentences   | `docs(tools): point each search at its better sibling`   | `search_nodes`, `read_graph`, `merge_entities` |
| 15   | `stats --json` + freshness | `feat(cli): report graph stats`                          | one pass over the ops already read             |
| 16   | `noonien doctor`           | `feat(cli): verify the store`                            | read-only, exit code on a defect               |
| 17   | `export --out --keep`      | `feat(cli): keep dated snapshots`                        | files outside the store                        |
| 18   | Compaction                 | `feat(store): compact by bytes, off the write path`      | size, timer, backoff                           |
| 19   | Daemon guard               | `feat(store): collect when the daemon can vouch`         | **verify first**, then wire or say why not     |
| 20   | README drift               | `feat(release): fail when a tool is not documented`      | reads `tools/list` from the built server       |
| 21   | Public docs review         | `docs: bring the public surface to 1.3.0`                | the artifact table below                       |
| 22   | `instructions`             | `feat(tools): name the new tools at initialize`          | core tools first                               |
| 23   | Release 1.3.0              | `chore(main): release 1.3.0`                             | Release workflow, then the four nodes          |
| 24   | Measure the TDQS           | — (no commit unless the text changes)                    | the feedback loop the text needs               |

Steps 4–19 are independent of one another. Nothing is optional: D4 fixes the scope.

---

### 1 · Surface test

The invariant that survives every future tool: in `test/server.test.ts`, walk `tools/list` and assert
that each tool has a `title`, a non-empty `description`, annotations consistent with its kind
(read-only and idempotent for a read, destructive where it tombstones), and a `describe()` on every
property of its input schema, including array items.

**Undo:** this is the guard the rest leans on; removing it removes the guarantee, not a feature.

### 2 · Drop-in contract test

Before touching any of the nine, pin what they answer: a fixture graph and, for each tool, the
expected input schema, output schema and result written out in the test — **description excluded**,
because the prose is ours. Expectations are spelled out rather than snapshotted: a snapshot is accepted
by pressing a key, which is how a contract drifts. The test also pins the result _order_, which for
`search_nodes` and `read_graph` is name order.

**Undo:** never.

### 3 · Link check

Every relative Markdown link resolves, from the directory of the file that carries it. `node
scripts/links.mjs` walks the tracked `.md` files, resolves each target, and prints what is broken; the
preflight runs it and `ci.yml` runs it too (D3) — a file that moves takes its links down silently, and
nothing notices.

Tests: a fixture directory with one broken link fails; the repository passes.

### 4 · `read_changes` — what moved since the last visit

The only way to learn what changed is `read_graph`, the whole graph, for two or three entities. The
operation log already knows the answer.

```jsonc
// input — since optional, ISO-8601
{ "since": "2026-11-10T08:00:00.000Z", "limit": 50, "offset": 0 }
// output — since is the window actually used, until is this node's clock
{ "since": "…", "until": "…", "entities": [/* touched, current state */], "relations": [/* incident */], "deleted": ["Name"] }
```

- **`until` is this node's clock at read time**, never the newest operation timestamp: a peer whose
  clock runs hours ahead would otherwise push the next window into the future and drop real changes.
- **The window is rewound by five minutes**, a constant rather than a knob: the promise is "changes are
  complete for any node whose clock is within ±5 minutes of this one". Repeat reads are idempotent.
- `since` absent means the last five minutes; a `since` in the future is clamped to now.
- **Touched** means named by an operation in the window: an entity create or delete, an observation
  add or delete, or either endpoint of a relation add or delete.
- **`deleted` is trustworthy** because collection never drops a tombstone.
- `shard.compact` metadata operations are filtered out.

Implementation: `changes(since, options)` in `src/graph/graph.ts` — touched set from `log.read()` by
`ts` and payload type, then `currentGraph()` and filter. Output schema is
`KnowledgeGraphSchema.extend({ since, until, deleted })`.

Tests: an op exactly at `since` is included; an entity created before the window and observed inside
it arrives complete; a deletion inside the window is reported once and absent from `entities`; an
operation stamped five minutes behind is not lost; a future `since` is clamped; `shard.compact`
changes nothing; paging is stable.

**Undo:** reads only; removing it leaves the graph untouched.

### 5 · `find_nodes` — a search that finds things

`search_nodes` is a lowercased substring returned in name order: `"port redis"` almost never hits,
`"ports"` does not find `port`, and the best match is wherever the alphabet puts it. That tool does
not move; the search an agent would type gets its own.

```jsonc
{ "query": "port redis", "entityType": "host", "limit": 20, "offset": 0 }
// → { "entities": [/* ranked */], "relations": [/* incident */] }
```

- Terms split on non-alphanumerics; **every** term must match; a term matches a **token prefix**, so
  `port` finds `ports` and not `support`. Neither search contains the other, which is why both stay.
- Ranked: exact name, then name prefix, then type, then observation; earliest match breaks ties, then
  name. Paging happens after ranking.

Implementation: pure `src/graph/search.ts` (`terms`, `scoreEntity`) + `findNodes` on `MemoryGraph`.

Tests: a name hit outranks an observation hit; prefix and token matching; a multi-word query that
finds nothing today finds the entity; a term inside a longer word is found by `search_nodes` and not
here; paging over a ranked list.

**Undo:** reads only.

### 6 · `expand_nodes` — the neighbourhood, not the whole graph

`open_nodes` returns an entity and its incident relations, including to entities it does not return:
the agent sees that a neighbour exists and not what it says.

```jsonc
{ "names": ["Glama"], "depth": 2, "limit": 100 }
// → { "entities": [/* within depth hops */], "relations": [/* incident */], "truncated": false }
```

`depth` defaults to 1, capped at 5; `limit` caps the entities (200 by default) and sets `truncated`; a
name that does not exist is skipped. Relations are the incident ones every other read uses, so the
relation set matches what `open_nodes` reports for the starting entities — and the entities are the
ones the walk reaches, which is the point of the tool.

Implementation: BFS over an adjacency map built once per call, neighbours in name order so the cap
drops the far frontier, then sorted by name.

Tests: depth 1 equals `open_nodes`; direction ignored; a cycle terminates; `limit` sets `truncated`.

**Undo:** reads only.

### 7 · `read_conflicts` — the values and the times

Today the report is `{element, authors, operations}`: an agent learns that two nodes wrote something
and cannot see what, or when. Add both.

```jsonc
// → { "conflicts": [{ "element": "…",
//       "authors": [{ "node": "ai", "ts": "…", "value": "…" }, { "node": "z600", "ts": "…", "value": "…" }],
//       "operations": 3 }] }
```

- `authors` becomes one entry per node with the value it wrote and the stamp of its newest operation on
  that element: the pair an agent needs to decide.
- `authors` keeps its name and gains detail; `element` and `operations` are unchanged. It is an
  extension tool, so the output may grow — a string array becoming an array of objects is a change no
  caller of the official nine can see.
- No new parameter: a conflict report is short by nature.

Tests: two nodes with different values produce two entries with their stamps; the same value from two
nodes still produces two entries; an element authored by one node is absent.

**Undo:** output only; adding fields cannot hurt a client that ignores them.

### 8 · `resolve_conflict` — settle what `read_conflicts` found

Detecting a contested element is useless if the agent cannot close it. Re-creating is not the fix: a
create of what already exists is skipped, and a delete already in the log changes nothing. The missing
primitive is a **fresh stamp on a chosen outcome**.

```jsonc
// input — each entry names an observation or a relation, and whether it should stand; shapes mix
{ "elements": [
  { "entityName": "Glama", "content": "listed version: 1.2.0", "keep": true },
  { "from": "A", "to": "B", "relationType": "runs", "keep": false }
] }
// output, one result per entry
{ "results": [{ "element": "…", "keep": true, "changed": true }] }
```

- `keep: true` writes an add with a stamp newer than anything in the log, so presence wins everywhere
  the change propagates; `keep: false` writes a fresh tombstone, so absence wins.
- **`changed` is `false` when the fold already agreed**: an element that stands as asked is left alone,
  because every write is durable history and a no-op write is noise.
- Implementation writes the operation drafts and commits them, **not** through `addObservations` or
  `createRelations`: their skip-if-present rule is exactly what this tool has to bypass.
- A relation can only be kept if both endpoints exist, the same rule `create_relations` enforces; an
  observation can only be kept on an entity that exists, as `add_observations` requires.
- Entity _types_ are not settled here: `update_entities` already tombstones and re-adds, which is a
  fresh stamp by construction.

Tests: keeping an element already present writes nothing; flipping a tombstoned observation restores
it and wins after a merge in either direction; a relation is dropped the same way; the op log contains
only the four existing payload types; two nodes resolving the same element differently converge on the
later stamp.

**Undo:** it writes ordinary operations, so removing the tool leaves a readable graph — the stamps it
wrote stay, which is what a decision is.

### 9 · `find_duplicates` — the graph's rot, proposed not applied

`merge_entities` exists but needs the pair already known. A read-only pass that proposes pairs makes
it usable, in two modes:

```jsonc
// by is "name" (default) or "content"; threshold and limit apply to both
{ "by": "name", "threshold": 0.75, "limit": 20 }
// → { "pairs": [{ "a": "nooniend", "b": "noonien daemon", "score": 0.81, "reasons": ["name", "observations"] }] }
```

- `by: "name"` normalises case, diacritics, spacing and known suffixes (`.service`), compares token-set
  Jaccard and normalised Levenshtein, and raises the score when observations overlap.
- `by: "content"` compares the **observation token sets**, so a fact written twice under two names is
  found; `reasons` is `["content"]`.
- **Blocking** bounds the work: buckets by token, at most 200 members each (name order), so the cost is
  `entities × tokens × 200` instead of `entities²`. A stated limit, marked with a `shortcut:` comment.
- Read-only; the merge stays a decision.

Implementation: pure `src/graph/duplicates.ts` (normalise, bucket, score) + `findDuplicates`.

Tests: a known pair is found; disjoint observations score lower; the pair set never self-references;
blocking still finds a pair sharing one token; `by: "content"` finds a pair whose names share nothing;
the limit truncates the worst scores.

**Undo:** reads only.

### 10 · `read_history` — who wrote this, and when

No tool answers "is this fact stale?". `read_conflicts` gives authors on contested elements only; the
fold carries no dates at all. The log has both.

```jsonc
{ "entityNames": ["Glama"], "limit": 50, "offset": 0 }
// → { "entries": [{ "entityName": "Glama", "ts": "…", "node": "ai", "kind": "observation.add", "detail": "…" }] }
```

`kind` is the operation type, `detail` the payload rendered as one line (a content, a relation key, an
entity type). Newest first; relations count for both endpoints; `shard.compact` is filtered out.
Capped per call by `limit` (50 by default, 500 at most) so a busy entity cannot flood a context.

Implementation: `history(names, options)` on `MemoryGraph`, filtering `log.read()`. No fold, so it is
cheap on a graph that has not changed.

Tests: an entity's own operations appear newest first; a relation appears under both endpoints;
`shard.compact` does not; unknown names return nothing rather than failing; paging is stable.

**Undo:** reads only.

### 11 · `merge_entities` — a dry run

`merge_entities` is the one irreversible call in the surface, and today the only way to know what it
will do is to read the code. An optional `dryRun` reports the consequences and writes nothing.

```jsonc
{ "merges": [{ "from": "B", "into": "A" }], "dryRun": true }
// → { "results": [{ "from": "B", "into": "A",
//       "observationsJoined": 4, "relationsRepointed": 2, "removedName": "B", "applied": false }] }
```

- `dryRun` defaults to false, so the existing call is unchanged — it is an optional input on an
  extension tool, not a new tool.
- The counts come from planning the merge exactly as the real call does, then discarding the drafts:
  the preview cannot drift from the effect.
- `applied` says which of the two happened, so a caller can render one response shape.

Tests: a dry run leaves the op log byte-identical; its counts equal what the real merge then does;
merging into a missing entity fails the same way in both modes.

**Undo:** the flag can be removed without touching the data.

### 12 · `set_observations` — one fact kept current

```jsonc
{ "entries": [{ "entityName": "Glama", "key": "listed version", "value": "1.2.0" }] }
// → { "results": [{ "entityName": "Glama", "key": "listed version", "content": "listed version: 1.2.0", "action": "replaced" }] }
```

- The observation is `key: value`; a key owns an observation when the content is exactly the key or
  starts with `key: ` (colon and space). A key containing `: ` is refused, because it would let two
  keys own one observation.
- **All** occurrences of the key collapse into the one new content. Entries apply in order.
- A missing entity fails as `add_observations` does: creating entities stays `create_entities`' job.
- Implemented as `observation.delete` + `observation.add`; one commit, one notification.

Tests: add then replace; two drifted twins collapse to one; `key:extra` is not owned by `key`; a key
with `: ` is refused; two entries on one key end in one observation; a missing entity reports per
entry; only the two existing payload types appear; convergence holds and the later stamp wins.

**Undo:** the data stays written in the convention; that is the one thing removing the tool does not
take back.

### 13 · `memory://changes` — the window as a resource

An agent that refreshes its context each turn does not need a tool call: it needs a resource it can
read, with a subscription. Same body as `read_changes`, same window.

```text
memory://changes            →  the read_changes result for the last five minutes
memory://changes{?since}    →  the same, from a moment the client names
```

- Registered beside `memory://knowledge-graph`, through the subscription notifier, so a mutation
  already notifies subscribers — no new notification path.
- **Two registrations, one handler**: a URI template matches only when its query is present, so the
  bare URI is a resource of its own; a per-turn refresh asks for that one, a client resuming from a
  watermark asks for the template.
- The tool stays: a resource is for a client that reloads context, a tool for a model that decides.

Implementation: reuse `changes()` for both registrations.

Tests: the template appears in `resources/templates/list`; both URIs read; a mutation notifies a
subscriber; the body equals `read_changes` for the same window.

**Undo:** remove the registration; nothing is stored.

### 14 · Three pointing sentences

The nine keep their text except for one sentence each on the three where a better sibling now exists:
`search_nodes` → `find_nodes`, `read_graph` → `read_changes`, `merge_entities` → the dry run and
`find_duplicates`. The three sentences are written out in _The words an agent reads_, not here, so there
is one version of each. (`create_entities` already says that an existing name is skipped, so it needs
nothing.) Without them, the new tools exist only for the agent that already knows them.

Tests: the contract test of step 2 still passes — that is what proves the sentences are prose only.

### 15 · `noonien stats --json` and freshness

Counting the graph today means a route plus `jq`, and the daemon's routes exist only where a daemon
runs. One command over the same folded state, with the number an operator actually needs — how old the
memory is:

```text
entities 38 · relations 56 · observations 210 · operations 503 · deletions 71
largest: ai 42, Glama 17, nooniend 12 · types: host 5, service 4, registry 3
last mutation: 2026-11-10T09:12:41.330Z · stale (90d): 4 — ai, z600, Mail, Glama
```

- `stale` counts entities whose newest operation is older than 90 days and names the oldest few: that
  is the input to a decision, which this command does not take.
- `--json` emits the same numbers as one object, so a timer can keep a series.
- Shard counts, watermarks and peer health stay on `/shards`, `/watermark` and `/peers`: same facts
  served twice is duplication.

Implementation: `stats()` in `src/graph/graph.ts` (fold plus one pass over the operations already read,
`shard.compact` excluded) and a `stats` case in `src/cli.ts`.

Tests: counts on a fixture graph; `deletions` counts operations, not entities; `stale` picks the old
ones and not the new; `--json` parses and agrees with the text; an empty graph answers zeroes.

**Undo:** reads only.

### 16 · `noonien doctor`

A store that does not parse fails at runtime, in the middle of an agent's turn, with a warning nobody
reads. One command that says whether the store is sound, and exits non-zero when it is not:

```text
shards 4 · operations 503 · parse errors 0 · torn lines 0
orphan relations 0 · unknown payloads 0 · unmoved shards 1 (z600, 12 days)
fold 4 ms
```

- **Read-only.** Nothing is repaired, rewritten or quarantined: a tool that repairs is a tool that can
  destroy, and the repair decision is the owner's. `--fix-torn` may come later, as a separate command.
- Checks: every shard parses line by line; a torn final line is reported as such; relations whose
  endpoints are absent from the fold; any line the codec rejects, an unknown payload included; shards
  that have not moved in longer than a stated window; the fold time.
- **A shard that has not moved is reported, not judged**: an idle node is not a defect, and `doctor`
  exits 0 on it. Only a parse failure or an operation the codec rejects is a defect.
- Exit codes: 0 sound, 1 a defect. An unreadable store throws, and the process exits non-zero — a
  separate code for it would be a distinction nobody acts on differently.

Implementation: `doctor()` on the log (it can see shards and lines), a `doctor` case in `src/cli.ts`.

Tests: a fixture with a torn line reports it and exits 1; a clean store exits 0; an orphan relation is
counted; an unknown payload is counted; the report is unchanged after running it twice.

**Undo:** reads only.

### 17 · `noonien export --out --keep`

Replication protects against a node failing, not against our own code writing something wrong. A dated
dump, with retention, is the only cheap defence:

```sh
noonien export --out ~/backups/noonien --keep 7
```

- Writes `graph-<ISO>.json` (the same body `export` already prints) and deletes the oldest beyond
  `--keep`, so a timer needs no logic of its own. `--keep` defaults to 7.
- Refuses to overwrite an existing file: a snapshot that silently replaces another is not a snapshot.
- Writes outside the store (`NOONIEN_DIR` untouched), so an export can never be read back as a shard.

Implementation: extend `exportGraph` with the two flags; the retention is one sort and one unlink.

Tests: writes one file and prints its path; a second run with the same timestamp pattern keeps the
newest N and removes the rest; `--dry-run` lists what it would delete; refuses to clobber.

**Undo:** nothing in the store is touched.

### 18 · Compaction: by bytes, off the write path, with backoff

Compaction today trips on a count of operations, inside the mutation queue: an observation of 2 KB
counts like one of 20 bytes, and the pass runs in front of the next write.

- **Bytes as the signal.** `NOONIEN_COMPACT_BYTES` (default 8 MiB of shard growth since the last pass)
  trips in addition to the existing `NOONIEN_COMPACT_AFTER` count, which stays for compatibility.
- **Off the write path.** A mutation marks the shard dirty; a timer in the server process (and the
  daemon's own round) runs the pass, so no write waits behind it. A pass that finds nothing is a
  no-op.
- **Backoff.** A failed pass (CAS contention with a peer) doubles the interval up to a cap, resets on
  success, and is counted — instead of retrying on every single write.
- The guarantee is unchanged: compaction preserves the folded graph, and the property test that says
  so already exists.

Implementation: `ShardLog` keeps the byte counter and the next-attempt time; `MemoryGraph` stops running
maintenance inside `commit()` and asks the log whether a pass is due; the timer lives in `serve.ts`, and
a pass is also attempted at startup when the shard is already over the threshold — a stdio server can
end a session before its timer ever fires.

Tests: the byte threshold trips; a pass under the threshold does not run; a failed pass backs off and
does not retry on the next write; the graph folded after a timer pass equals the graph before it (the
existing convergence property test, reused); two concurrent passes do not corrupt a shard.

**Undo:** thresholds and a timer, no format change; reverting restores the previous behaviour and the
store stays valid.

### 19 · The daemon's guard for the server

The server keeps every tombstone because it has no evidence about its peers; the daemon has that
evidence (the stable watermark, `/watermark`). If the server can ask for it, a machine that is the only
writer can collect what it is entitled to collect instead of growing forever.

**Verify first, and write down the answer.** Read the code and the protocol: whether `/watermark`
answers with enough evidence for a server-side guard, whether the server can reach it without an
endpoint configured, and what happens when no daemon runs. Then either wire it as `options.collection`
with a test, or record in `docs/plan.md` that the guard stays daemon-only, and why.

- If wired: a reachable daemon lets a lone writer collect shadowed operations; an unreachable one
  keeps the whole view, as today.
- Either way, nothing about tombstones changes without the gate: that is the promise collection rests
  on.

Tests (if wired): a reachable guard collects; an unreachable one keeps everything; the folded graph is
identical across the two.

**Undo:** the wiring is a constructor option; unresolving it restores the current behaviour.

### 20 · README drift in the preflight

`scripts/release-check.mjs` already proves versions and packaged bins agree. Add: spawn the built
server, read `tools/list`, and compare its names with the README tool table — a registered tool missing
from the table, or a row naming a tool that no longer exists, fails the preflight. The same pass
asserts that `instructions` names every extension tool. It runs in `ci.yml` too (D3), on the build CI
already produces.

Tests: the check fails on a fixture where one name is removed from the table, and passes on the tree.

### 21 · Public docs review

Each unit owns its own README/PLAN/CHANGELOG rows. What no unit owns is the rest of the public
surface, reviewed once, with every feature already in the tree, as a **read** rather than a
search-and-replace: every sentence that names a tool, counts them or names a command is compared with
the tree, and a claim that cannot be checked there is rewritten or deleted.

| Artifact                                | What it must say after 1.3.0                                                                                                                                                                                                                                                                               | Action           |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `README.md`                             | seven new tool rows; `stats`, `doctor` and `export --out` in the CLI list; the `memory://changes` resource; `NOONIEN_COMPACT_BYTES` in the configuration table; the two searches and how they differ; `read_changes`'s window; the automations in _How it works_; the Documentation list without this file | edit             |
| `docs/plan.md`                          | the new tool rows with their kind; the CLI additions; the automation (compaction, guard) in the current state; the decision that a better search is a tool beside the nine                                                                                                                                 | edit             |
| `CHANGELOG.md`                          | `Unreleased` cut into `1.3.0` with its date, the lines the units wrote plus the one already on main for the enriched descriptions                                                                                                                                                                          | edit             |
| `CONTRIBUTING.md`                       | the drop-in paragraph lists the extensions: it must list the new ones                                                                                                                                                                                                                                      | edit             |
| `mcpb/manifest.json`                    | `long_description` names the extensions — add these; never the version, release-please owns it                                                                                                                                                                                                             | edit description |
| `AGENTS.md`                             | the compatibility contract names the current extensions — project law, so the owner approves the wording                                                                                                                                                                                                   | edit with owner  |
| `docs/wayforward/scaling.md`            | the measured read cost and the "page the surface" advice still hold; the compaction change does not contradict the cost model                                                                                                                                                                              | verify           |
| `.opencode/skills/noonien-dev/SKILL.md` | the developer skill names the tools and commands it teaches                                                                                                                                                                                                                                                | edit             |
| `server.json`                           | the registry listing carries no tool names; its version fields are bumped by release-please                                                                                                                                                                                                                | verify           |
| `docs/protocol.md`                      | no wire message, header or route changed — `/watermark` is consumed, not altered                                                                                                                                                                                                                           | verify           |
| `docs/paper.md`                         | **frozen at 1.0.0**: it says "the same nine tools", which stays true, and its mention of the plan is a name, not a link, so the move breaks nothing                                                                                                                                                        | do not touch     |
| `docs/wayforward/tools.md`              | this file, deleted once its content lives in README and PLAN                                                                                                                                                                                                                                               | delete           |

The registries follow the release: npm renders the README from the tarball, the MCP Registry publishes
the tagged `server.json`, and Glama re-syncs and re-scores on its own schedule.

### 22 · `instructions`

The tail of the constant in `src/server.ts`, in the voice it already uses, naming every new tool — the
**core four first** (`read_changes`, `find_nodes`, `expand_nodes`, `find_duplicates`), the rare ones
after (`read_history`, `resolve_conflict`, `set_observations`): a model reads the earliest names as the
ones to try. One commit, because one sentence covers all of them.

### 23 · Release

The `Unreleased` heading cut by hand into `1.3.0` with its date, then one `workflow_dispatch` run of
the Release workflow — never `npm publish` by hand. Then the four nodes: install, restart, and record
the package version and `ActiveEnterTimestamp` per node. `/info.version` is a start stamp, not a
version, so it proves a restart and not a release; the installed package is the evidence, and the
comparison across nodes lives in `~/sequicompany`.

### 24 · Measure the TDQS

The text in _The words an agent reads_ is written for a score nobody has seen yet. After Glama syncs
the release, read the per-tool TDQS and record which dimension is still low — Behaviour, Usage or
Parameters — in the internal registry notes, then fix that dimension's sentences in a follow-up commit.
Nothing is written back into this file: it is deleted at the release. Without this step the writing is
done blind.

---

## How an agent would use these together

The tools are described one by one; an agent calls them in sequence. These three flows are what the
descriptions and `instructions` have to make possible without opening this file.

- **Coming back to a memory.** `read_changes` with the `until` of the last visit → for each changed
  name that matters, `expand_nodes` with depth 1 → `open_nodes` only when the full observation text is
  needed. Three calls instead of the whole graph.
- **Looking something up.** `find_nodes` with the words as written → `expand_nodes` on the best hit →
  `read_history` when two observations disagree, to see which one was confirmed last.
- **Cleaning up.** `find_duplicates` → `open_nodes` on both sides → `merge_entities` with `dryRun`, read
  the counts, then merge. For a contested element: `read_conflicts` → decide with the values and times
  in front of you → `resolve_conflict`.

## The words an agent reads

An agent picks a tool from its description, so the description is a deliverable of the unit, not a note
about it. Each block is copied **verbatim** into `description`, and its parameter lines into the
`describe()` calls, in the same commit as the behaviour. Where a block and a unit disagree, the unit
wins and the block is corrected.

Titles for the seven new tools, in the same order: `Read Changes`, `Find Nodes`, `Expand Nodes`,
`Resolve Conflict`, `Find Duplicates`, `Read History`, `Set Observations`.

**`read_changes`**

> Read only what changed in a window you choose: the entities touched in it, as they are now, and the
> names deleted in it. Use it instead of `read_graph` when you are coming back to a memory you already
> know — the whole graph for two changed entities costs the context you came to use. The window
> reaches five minutes further back than you ask, so a change written by a peer with a slightly
> lagging clock is not lost, and reading the same window twice is harmless. It also returns `until`,
> the moment it stopped at, in this node's clock: pass that back as `since` and the next read
> continues from there.

> `since` — the ISO-8601 moment to read after; omit it for the last five minutes, or pass the moment a
> previous call returned to continue where that call stopped. `limit`/`offset` — page the touched
> entities, which come in name order.

**`find_nodes`**

> Search the graph the way a query is written, not as a literal string: every word must match, a word
> matches the beginning of a longer one, and the best matches come first. Use it instead of
> `search_nodes` when the query is more than one word, or when a word may be spelled differently —
> `ports` for `port`. `search_nodes` is the literal-substring search and stays for exactly that. A word
> that matches nothing makes the result empty rather than failing the call.

> `query` — the words to look for. `entityType` — keep only entities of exactly this type.
> `limit`/`offset` — page the ranked results, best first.

**`expand_nodes`**

> Walk out from the entities you name: every entity within `depth` hops, with the relations that touch
> them. Use it instead of `read_graph` to assemble the context around a topic, and instead of
> `open_nodes` when the neighbours' content matters as much as the entity you started from. The walk
> ignores direction, stops on cycles, and skips names that do not exist rather than failing. When
> `limit` binds, `truncated` is true and the farthest entities are the ones left out.

> `names` — the entities to start from. `depth` — how many hops to walk, 1 by default and at most 5.
> `limit` — the most entities to return, 200 by default.

**`read_conflicts`** — one sentence appended to the description it already has:

> Each author comes with the value it wrote and when it last wrote it, so you can decide which one
> should stand and settle it with `resolve_conflict`.

**`resolve_conflict`**

> Settle an element that more than one machine has written: keep it or drop it with a stamp newer than
> anything in the log, so the decision wins on every node as the change propagates. Use it after
> `read_conflicts` named the element and you have decided how it should stand — re-creating it with the
> existing tools is not enough, because a write that already exists is skipped, and deleting what is
> already tombstoned changes nothing. An element that already stands as you ask is left untouched and
> reported as unchanged, because every write is durable history.

> `elements` — the elements to settle, one entry each. `entityName` and `content` name an observation,
> which needs the entity to exist; `from`, `to` and `relationType` name a relation, which needs both
> its endpoints. `keep` — true to make it stand, false to make it go.

**`find_duplicates`**

> Propose pairs of entities that may be the same thing, so `merge_entities` can be used on a pair you
> would not have noticed. With `by: "name"` the names are compared after case, spacing, punctuation and
> a known suffix such as `.service` are normalised, and overlapping observations raise the score; with
> `by: "content"` the observations are compared instead, which is how one fact written twice under two
> names is found. It is read-only. A score is a hint, not a verdict: read both entities before merging
> them.

> `by` — what to compare, `name` by default. `threshold` — the lowest score to report, 0.75 by
> default. `limit` — the most pairs to return, 20 by default, best first.

**`read_history`**

> Show what wrote an entity and when: the operations that touched it, newest first, with their
> timestamp, node and kind. Use it to tell a fact confirmed yesterday from one nobody has touched in
> months, which no other tool answers — `read_conflicts` covers only contested elements, and the graph
> itself carries no dates. For the current state use `open_nodes`; for what changed in a window use
> `read_changes`.

> `entityNames` — the entities to trace; a relation counts under both of its endpoints.
> `limit`/`offset` — page the operations, newest first; 50 by default, at most 500.

**`set_observations`**

> Keep one fact current: write `key: value` on an entity, replacing every observation that key already
> holds, so a drifted twin cannot survive. Use it instead of `update_observations` when the value
> changes over time — a version, a status — and you should not have to remember its previous text. An
> observation belongs to a key when it is exactly the key or starts with the key, a colon and a space,
> and a key may not itself contain a colon followed by a space. A missing entity fails as
> `add_observations` does: create it with `create_entities` first.

> `entries` — one entry per fact. `entityName` — the entity that holds it. `key` — the name of the
> fact, matched at the start of an observation. `value` — what the fact is now.

**Sentences added to three of the nine** — appended to the description they already have, nothing else
touched:

> `search_nodes`: For a search written the way a query is spoken, use `find_nodes`: it matches whole
> words and ranks the results.

> `read_graph`: To read only what changed since your last visit, use `read_changes`.

> `merge_entities`: It cannot be undone, so pass `dryRun` first to see the observations joined, the
> relations repointed and the name that disappears; `find_duplicates` proposes pairs that look like
> the same thing.

**`instructions`** — the tail of the constant in `src/server.ts`, replacing its last sentence rather
than adding one (the backticks here are this document's; the string is plain text), core tools first:

> … For a large graph, page `read_graph` and `search_nodes` with limit/offset, and filter
> `search_nodes` by entityType. `find_nodes` searches the way a query is written — every word must
> match, results are ranked — while `search_nodes` is the literal substring. `read_changes` reads what
> moved in a window instead of the whole graph, `expand_nodes` walks a neighbourhood out from the
> entities you name, and `find_duplicates` proposes pairs that look like the same thing. To settle
> what two machines wrote, `read_conflicts` lists it and `resolve_conflict` decides it; `read_history`
> says who wrote an entity and when; `set_observations` keeps a `key: value` fact current.

## Out of scope

Restated so a later reader does not re-litigate them:

- **No change to a drop-in tool's inputs, outputs or result order.** Prose may point at a better
  sibling; nothing else.
- **No atomic multi-operation batch.** Atomicity is not a requirement of an AP model and sequential
  calls work.
- **No automatic merge of duplicates.** Merging is lossy — one name survives, observations union,
  relations repoint — and the store cannot tell whether two similar names are the same thing. Only the
  agent that reads both can, which is why `find_duplicates` proposes and `dryRun` shows the bill.
- **No automatic forgetting, TTL or prune of contents.** A tombstone exists to beat a concurrent
  re-add; dropping it "because it is old" is how deleted data comes back. Collection stays behind the
  gate.
- **No automatic conflict resolution.** Last-writer-wins already chose; `resolve_conflict` records a
  decision and a machine has none to record.
- **No pruning of a peer's shard.** The import race is documented, and automating it makes the race
  frequent instead of rare.
- **No repair inside `doctor`.** A tool that repairs is a tool that can destroy; verification and
  repair are different commands.
- **No embeddings, no vector search, no entity aliases.** A model and an index mean a server — a
  different product; an alias is a convention, not a primitive. `find_similar` for free text stays a
  mode of `find_duplicates`.
