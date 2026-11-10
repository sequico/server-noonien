# server-noonien — Tool extension plan (1.3.0)

One plan for what an agent will see, and for the guards that keep it honest afterwards: one order,
one release, one read-through of the public documents. This document is **forward-looking** — it
exists until 1.3.0 ships, then each unit's content moves into `README.md` (tool table, CLI list) and
`docs/plan.md` (tool surface, decisions) and the file is deleted. It never describes history, and
never restates what those two already say.

## What changes for an agent

Usefulness first. The body follows the **order of work**, which is not this order: the guards come
first because they lock what the nine answer, then the reads, then the pair that closes the conflict
gap. The table's numbers are this ranking; the section numbers are the work order.

| #   | Change                                                                | Kind                |
| --- | --------------------------------------------------------------------- | ------------------- |
| 1   | `read_changes` — a window of what moved instead of the whole graph    | new read tool       |
| 2   | `find_nodes` — a search that finds what a person meant to type        | new read tool       |
| 3   | `expand_nodes` — a neighbourhood N hops out, for context assembly     | new read tool       |
| 4   | `resolve_conflict` — settle an element two machines wrote             | new write tool      |
| 5   | `find_duplicates` — proposals for the same thing under two names      | new read tool       |
| 6   | `read_history` — who wrote this, and when                             | new read tool       |
| 7   | `set_observations` — one fact kept current instead of a pile of twins | new write tool      |
| 8   | `read_conflicts` — the values seen, not just the authors              | output of extension |
| 9   | `noonien stats` — the numbers an operator acts on, with `--json`      | CLI                 |
| 10  | Three pointing sentences on the nine, so the new tools are found      | description text    |

## Ground rules

- **The nine stay the nine.** No unit changes a drop-in tool's names, input schema, output schema,
  messages or the order of their results. Their **description text** is ours and may gain a sentence
  that names a better sibling: the contract does not cover prose, and a tool an agent never hears
  about is a tool that does not exist.
- **No unit introduces an operation type.** `resolve_conflict` and `set_observations` are expressed
  with `entity.*`, `observation.*` and `relation.*`, so the codec, the fold and the CRDT are untouched.
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

Everything else in this plan is implementation, decided here and not asked again.

---

## The order

| Step | Unit                          | Commit                                                   | Notes                                          |
| ---- | ----------------------------- | -------------------------------------------------------- | ---------------------------------------------- |
| 1    | Surface test                  | `test(tools): lock the surface before it grows`          | every tool, every parameter, every kind        |
| 2    | Drop-in contract test         | `test(tools): pin what the nine answer`                  | golden of inputs, outputs, order               |
| 3    | `read_changes`                | `feat(tools): read only what changed`                    | `graph.ts`, `server.ts`                        |
| 4    | `find_nodes`                  | `feat(tools): a search that finds things`                | new pure module `src/graph/search.ts`          |
| 5    | `expand_nodes`                | `feat(tools): expand a subgraph`                         | reuses `incidentRelations`                     |
| 6    | `read_conflicts` values       | `feat(tools): show the values a conflict carries`        | output of an extension tool                    |
| 7    | `resolve_conflict`            | `feat(tools): settle a contested element`                | existing operation types only                  |
| 8    | `find_duplicates`             | `feat(tools): propose duplicate entities`                | `by: name \| content`                          |
| 9    | `read_history`                | `feat(tools): trace who wrote an entity and when`        | reads the log, not the fold                    |
| 10   | `set_observations`            | `feat(tools): upsert an observation by key`              | D1 accepted                                    |
| 11   | Three pointing sentences      | `docs(tools): point each search at its better sibling`   | `search_nodes`, `read_graph`, `merge_entities` |
| 12   | `noonien stats --json`        | `feat(cli): report graph stats`                          | one pass over the ops already read             |
| 13   | README drift in the preflight | `feat(release): fail when a tool is not documented`      | reads `tools/list` from the built server       |
| 14   | Link check                    | `feat(repo): fail on a relative link that leads nowhere` | in `ci.yml` (D3)                               |
| 15   | Public docs review            | `docs: bring the public surface to 1.3.0`                | the artifact table below                       |
| 16   | `instructions`                | `feat(tools): name the new tools at initialize`          | one sentence, one commit                       |
| 17   | Release 1.3.0                 | `chore(main): release 1.3.0`                             | Release workflow, then the four nodes          |
| 18   | Measure the TDQS              | — (no commit unless the text changes)                    | the feedback loop the text needs               |

Steps 3–10 are independent of one another, and every one of them ships: the plan has no conditional
step left.

---

### 1 · Surface test

The invariant that survives every future tool: in `test/server.test.ts`, walk `tools/list` and assert
that each tool has a `title`, a non-empty `description`, annotations consistent with its kind
(read-only and idempotent for a read, destructive where it tombstones), and a `describe()` on every
property of its input schema, including array items. It is one test that replaces a manual review, and
it fails the day someone adds a tool without the words.

**Removal:** never. This is the guard the rest of the plan leans on.

### 2 · Drop-in contract test

Before touching any of the nine, pin what they answer: a fixture graph and, for each tool, the
expected input schema, output schema and result written out in the test — **description excluded**,
because the prose is ours. Expectations are spelled out rather than snapshotted: a snapshot is accepted
by pressing a key, which is how a contract drifts. The test also pins the result _order_, which for
`search_nodes` and `read_graph` is name order. From then on, an accidental change to a drop-in is a red
test rather than a review finding.

**Removal:** never.

### 3 · `read_changes` — what moved since the last visit

The only way to learn what changed is `read_graph`, the whole graph, for two or three entities. The
operation log already knows the answer.

```jsonc
// input — since optional, ISO-8601
{ "since": "2026-11-10T08:00:00.000Z", "limit": 50, "offset": 0 }
// output
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

Risk: a whole-log fold makes the first call after a change no cheaper than `read_graph` — it is the
shape of the log that decides, not the page asked for. The memoized fold covers repeats, and a log
large enough to hurt is the case `docs/wayforward/scaling.md` already addresses.

### 4 · `find_nodes` — a search that finds things

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

### 5 · `expand_nodes` — the neighbourhood, not the whole graph

`open_nodes` returns an entity and its incident relations, including to entities it does not return:
the agent sees that a neighbour exists and not what it says.

```jsonc
{ "names": ["Glama"], "depth": 2, "limit": 100 }
// → { "entities": [/* within depth hops */], "relations": [/* incident */], "truncated": false }
```

`depth` defaults to 1, capped at 5; `limit` caps the entities (200 by default) and sets `truncated`; a
name that does not exist is skipped. Relations are the incident ones every other read uses, so depth 1
answers what `open_nodes` answers plus `truncated`.

Implementation: BFS over an adjacency map built once per call, neighbours in name order so the cap
drops the far frontier, then sorted by name.

Tests: depth 1 equals `open_nodes`; direction ignored; a cycle terminates; `limit` sets `truncated`.

### 6 · `read_conflicts` — the values, not just the authors

Today the report is `{element, authors, operations}`: an agent learns that two nodes wrote something
and cannot see what. Add the distinct values each author left.

```jsonc
// → { "conflicts": [{ "element": "…", "authors": ["ai", "z600"], "values": ["…", "…"], "operations": 3 }] }
```

`values` is the distinct payload text per element — the observation content, the entity type, the
relation key. It is an extension tool, so the output may grow; the existing fields keep their names and
meaning. No new parameter: a conflict report is short by nature, and a graph with hundreds of them has a
problem a page will not solve.

Tests: two authored values appear; the same value from two nodes appears once; an element authored by
one node is absent.

**Removal:** never — a conflict report without values is half a tool.

### 7 · `resolve_conflict` — settle what `read_conflicts` found

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
  `createRelations`: their skip-if-present rule is exactly what this tool has to bypass. The payloads
  stay `observation.add`/`.delete` and `relation.add`/`.delete`, so no new operation type exists and the
  convergence proof is the one already in the tests.
- A relation can only be kept if both endpoints exist, the same rule `create_relations` enforces.
- Entity _types_ are not settled here: `update_entities` already tombstones and re-adds, which is a
  fresh stamp by construction.

Tests: keeping an element already present writes nothing; flipping a tombstoned observation restores
it and wins after a merge in either direction; a relation is dropped the same way; the op log contains
only the four existing payload types; two nodes resolving the same element differently converge on the
later stamp.

Risk: a tool that writes with a guaranteed win is powerful — its description must say it settles, not
suggests. No removal path; the alternative is leaving `read_conflicts` unusable.

### 8 · `find_duplicates` — the graph's rot, proposed not applied

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
- Read-only; the merge stays `merge_entities`.

Implementation: pure `src/graph/duplicates.ts` (normalise, bucket, score) + `findDuplicates`.

Tests: a known pair is found; disjoint observations score lower; the pair set never self-references;
blocking still finds a pair sharing one token; `by: "content"` finds a pair whose names share nothing;
the limit truncates the worst scores.

### 9 · `read_history` — who wrote this, and when

No tool answers "is this fact stale?". `read_conflicts` gives authors without times; the fold gives no
dates at all. The log has both.

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

**Removal:** if nobody asks "how old is this", it costs one registration.

### 10 · `set_observations` — one fact kept current

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

Risk: the one unit that puts a convention into the data. Accepted and stated in the description. It also
settles a contested key on its own, because the replacement carries a fresh stamp — which is why
`resolve_conflict` does not mention keys.

### 11 · Three pointing sentences

The nine keep their text except for one sentence each on the three where a better sibling now exists —
`search_nodes` → `find_nodes`, `read_graph` → `read_changes`, `merge_entities` → "cannot be undone;
`find_duplicates` proposes the pairs". (`create_entities` already says that an existing name is
skipped, so it needs nothing.) Without these, the new tools exist for the agent that already knows
them.

Tests: the contract test of step 2 still passes — that is what proves the sentences are prose only.

### 12 · `noonien stats --json`

Counting the graph today means a route plus `jq`, and the daemon's routes exist only where a daemon
runs. One command over the same folded state:

```text
entities 38 · relations 56 · observations 210 · operations 503 · deletions 71
largest: ai 42, Glama 17, nooniend 12 · types: host 5, service 4, registry 3
```

`--json` emits the same numbers as one object, so a timer can keep a series. Shard counts, watermarks
and peer health stay on `/shards`, `/watermark` and `/peers`: same facts served twice is duplication.

Implementation: `stats()` in `src/graph/graph.ts` (fold plus one pass over the operations already read,
`shard.compact` excluded) and a `stats` case in `src/cli.ts`.

Tests: counts on a fixture graph; `deletions` counts operations, not entities; `--json` parses and
agrees with the text; an empty graph answers zeroes.

### 13 · README drift in the preflight

`scripts/release-check.mjs` already proves versions and packaged bins agree. Add: spawn the built
server, read `tools/list`, and compare its names with the README tool table — a registered tool missing
from the table, or a row naming a tool that no longer exists, fails the preflight. The same pass
asserts that `instructions` names every extension tool. It runs in `ci.yml` too (D3), on the build CI
already produces, so a pull request that adds a tool without its row is red before it is merged.

Tests: the check fails on a fixture where one name is removed from the table, and passes on the tree.

### 14 · Link check

Every relative Markdown link resolves, from the directory of the file that carries it. `node
scripts/links.mjs` walks the tracked `.md` files, resolves each target, and prints what is broken; the
preflight runs it and `ci.yml` runs it too (D3) — a file that moves takes its links down silently, and
nothing noticed.

Tests: a fixture directory with one broken link fails; the repository passes.

### 15 · Public docs review

Each unit owns its own README/PLAN/CHANGELOG rows. What no unit owns is the rest of the public
surface, reviewed once, after the last unit, as a **read** rather than a search-and-replace: every
sentence that names a tool, counts them or names a command is compared with the tree, and a claim that
cannot be checked there is rewritten or deleted.

| Artifact                                | What it must say after 1.3.0                                                                                                                                                       | Action           |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `README.md`                             | seven new rows in the tool table; `stats` and `--json` in the CLI list; the two searches and how they differ; `read_changes`'s window; the Documentation list without this file    | edit             |
| `docs/plan.md`                          | the new rows in the tool surface table with their kind; `stats` in the CLI list; _Current state_ naming the new reads; the decision that a better search is a tool beside the nine | edit             |
| `CHANGELOG.md`                          | `Unreleased` cut into `1.3.0` with its date, the lines the units wrote plus the one already on main for the enriched descriptions                                                  | edit             |
| `CONTRIBUTING.md`                       | the drop-in paragraph lists the extensions: it must list the new ones                                                                                                              | edit             |
| `mcpb/manifest.json`                    | `long_description` names the extensions — add these; never the version, release-please owns it                                                                                     | edit description |
| `AGENTS.md`                             | the compatibility contract names the current extensions — project law, so the owner approves the wording                                                                           | edit with owner  |
| `docs/wayforward/scaling.md`            | the measured read cost and the "page the surface" advice still hold; the new reads do not contradict them                                                                          | verify           |
| `.opencode/skills/noonien-dev/SKILL.md` | the developer skill names the tools and commands it teaches                                                                                                                        | edit             |
| `server.json`                           | the registry listing carries no tool names; its version fields are bumped by release-please                                                                                        | verify           |
| `docs/protocol.md`                      | no wire message, header or route changed — this release adds no daemon surface                                                                                                     | verify           |
| `docs/paper.md`                         | **frozen at 1.0.0**: it says "the same nine tools", which stays true, and its mention of the plan is a name, not a link, so the move breaks nothing                                | do not touch     |
| `docs/wayforward/tools.md`              | this file, deleted once its content lives in README and PLAN                                                                                                                       | delete           |

The registries follow the release: npm renders the README from the tarball, the MCP Registry publishes
the tagged `server.json`, and Glama re-syncs and re-scores on its own schedule.

### 16 · `instructions`

The tail of the constant in `src/server.ts`, in the voice it already uses, naming every new tool: a
model calls a tool only if it knows it exists. One commit, because one sentence covers all of them.

### 17 · Release

The `Unreleased` heading cut by hand into `1.3.0` with its date, then one `workflow_dispatch` run of
the Release workflow — never `npm publish` by hand. Then the four nodes: install, restart, and record
the package version and `ActiveEnterTimestamp` per node. `/info.version` is a start stamp, not a
version, so it proves a restart and not a release; the installed package is the evidence, and the
comparison across nodes lives in `~/sequicompany`.

### 18 · Measure the TDQS

The text in _The words an agent reads_ is written for a score nobody has seen yet. After Glama syncs
the release, read the per-tool TDQS and record which dimension is still low — Behaviour, Usage or
Parameters — in the internal registry notes, then fix that dimension's sentences in a follow-up commit.
Nothing is written back into this file: it is deleted at the release. Without this step the writing is
done blind.

---

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

**`read_conflicts`** — one clause appended to the description it already has:

> It also shows the values each author left, so you can decide which one should stand and settle it
> with `resolve_conflict`.

**`resolve_conflict`**

> Settle an element that more than one machine has written: keep it or drop it with a stamp newer than
> anything in the log, so the decision wins on every node as the change propagates. Use it after
> `read_conflicts` named the element and you have decided how it should stand — re-creating it with the
> existing tools is not enough, because a write that already exists is skipped, and deleting what is
> already tombstoned changes nothing. An element that already stands as you ask is left untouched and
> reported as unchanged, because every write is durable history.

> `elements` — the elements to settle, one entry each. `entityName` and `content` name an observation;
> `from`, `to` and `relationType` name a relation, which can only stand if both its endpoints do.
> `keep` — true to make it stand, false to make it go.

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
> months, which no other tool answers — `read_conflicts` gives authors without times, and the graph
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

> `merge_entities`: It cannot be undone; `find_duplicates` proposes pairs that look like the same
> thing.

**`instructions`** — the tail of the constant in `src/server.ts`, replacing its last sentence rather
than adding one (the backticks here are this document's; the string is plain text):

> … For a large graph, page `read_graph` and `search_nodes` with limit/offset, and filter
> `search_nodes` by entityType; `find_nodes` searches the way a query is written — every word must
> match, results are ranked — while `search_nodes` is the literal substring. `read_changes` reads what
> moved in a window instead of the whole graph, `expand_nodes` walks a neighbourhood out from the
> entities you name, and `read_history` says who wrote an entity and when. `find_duplicates` proposes
> pairs that look like the same thing, `read_conflicts` lists what two machines wrote and
> `resolve_conflict` settles it, and `set_observations` keeps a `key: value` fact current.

## Out of scope

Restated so a later reader does not re-litigate them: no change to a drop-in tool's inputs, outputs or
result order (prose may point at a better sibling, nothing else); no atomic multi-operation batch
(atomicity is not a requirement of an AP model and sequential calls work); no TTL or automatic
forgetting (a shared memory is corrected, not expired); no embeddings or vector search (a model and an
index mean a server — a different product); no entity aliases (a convention, not a primitive);
`find_similar` for free text stays a mode of `find_duplicates`, not a tool of its own.
