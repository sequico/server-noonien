<div align="center">

# Noonien: Serverless, Convergent, Peer-to-Peer Knowledge-Graph Memory for AI Agents

### Barrier-Free Tombstone Collection Gated on Durable Knowledge

**Samuele Sequi** · Sequi Company samuele@sequi.company

*8 October 2026 · report at release `server-noonien` 1.0.0*

</div>

> **Frozen report.** This document is a snapshot pinned to release 1.0.0: it describes that release
> and is not revised as the code moves on. The project's current state lives in `README.md` and
> `PLAN.md`; later work is not folded back into this report.
>
> © 2026 Sequi Company. This document is licensed under the [Creative Commons Attribution 4.0
> International License (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/); the full text is
> in [`LICENSE`](LICENSE). The project's source code is under the Mozilla Public License 2.0
> instead; see `NOTICE`.
>
> **Citations** are author–year in the text, so they read the same on GitHub and in the PDF; the
> full entries are in [`references.bib`](references.bib), which pandoc turns into the reference
> list. Render with:
> `pandoc docs/paper.md --citeproc --bibliography=docs/references.bib --metadata-file=docs/paper.meta.yaml -o paper.pdf`.

## Abstract

Agent memory is usually a file or a service, not a distributed object, so the moment an agent runs
on more than one machine its memory becomes a consistency problem: the reference implementation of
the Model Context Protocol memory server (Model Context Protocol 2026) persists the whole knowledge
graph in a single JSONL file that every call reads and rewrites in full — safe on one host, and
lossy the moment the file is shared. We present **noonien** (Sequi Company 2026), a local-first,
serverless knowledge-graph memory that is a drop-in for that server (the same nine tools, the same
entities/observations/relations) but stores the graph as an append-only operation log split into
**per-node shards** whose merge is a conflict-free (LWW-Element-Set) fold ordered by a Hybrid
Logical Clock (Kulkarni et al. 2014). Nodes converge either through a shared area (a replicated
folder or an object store) or peer-to-peer through a companion anti-entropy daemon, with no central
server.

Our contribution is **tombstone collection gated on what a peer could have known, not on a live
barrier**. In a convergent store a deletion is a tombstone, not a removal, because dropping a
tombstone while a concurrent add it beats — an add whose author had folded the element — still
exists revives the deleted element. Every system we know gates collection on some *stability
condition*: causal stability ("every replica has seen it") or a time grace — Cassandra's
`gc_grace_seconds` (Apache Cassandra 2026), Kafka's `delete.retention.ms` (Apache Kafka 2026),
`git gc` prune expiry (Git project 2026). Both fail under our deployment — a machine may be offline
for months — the first because "every replica has seen it" is not knowable, the second because it
either keeps tombstones forever or lets the deletion **resurrect** (the "zombie"). We gate instead
on **what a peer could have known**: a durable per-peer **knowledge frontier** (a per-author
high-water mark) permits collecting, *at once*, exactly the elements an away peer never folded, and
freezes the rest — with no barrier over the past and no timer on the data. The liveness it does need
is a *stable round over the live set*: every still-reachable peer exchanged with, and none holding
anything this node lacks. Liveness is not fully autonomous: a peer that is both unreachable and
unverifiable — never reached, or holding operations this node cannot read — blocks collection until
an operator explicitly departs it, so the timer a grace-based system puts on the data is displaced
onto that decision, not eliminated, and we say so plainly. We then make the gate's state **bounded**
without weakening it: an expired peer's frontier is folded into one durable **retired frontier**
(the elementwise maximum — the *comparison* the peer provided, not a snapshot of its outcome), and
an unreadable frontier becomes a durable **blanket**. Expiry therefore changes only *where* the
protection is stored, never *which* elements are guarded, so no **causal** resurrection is possible:
an operation is never undone by a replica that had folded the element. Because the gate reads its
proof from the log, the rewrite that reclaims space keeps, for every element it cannot yet clear,
the operation a retained off-mesh peer's frontier could cover — the retention rule of §5 — and no
revival follows from it. An evaluation on a three-node deployment exercises propagation and
convergence, same-element races, large-scale deletion and space reclamation, and two off-line
windows in which a peer is frozen out and later rejoins; the merge and collection invariants are
also covered by property-based tests.

**Keywords:** conflict-free replicated data types, eventual consistency, tombstone collection,
garbage collection, knowledge graph, multi-agent memory, local-first, Model Context Protocol.

## 1. Introduction

A coding agent that runs on a laptop, a home server and a work box has three memories unless
something shares one. The reference implementation of the MCP memory server
(`@modelcontextprotocol/server-memory`, Model Context Protocol 2026) keeps a knowledge graph in a
single JSONL file and, on every mutation, reads the whole file and rewrites it. Its concurrency
control is in-process only. On one machine that is fine. On two machines writing a file synchronised
by Syncthing, Dropbox or a network mount, whole-file read-modify-write loses writes (the last writer
silently discards the others), and the sync tool forks the file into conflict copies rather than
merging it.

The alternatives are worse for the audience we target: a hosted memory service (data leaves the
machines, an account is required) or a server/database (something to run and operate). The problem
is not retrieval quality; it is that shared agent memory is a **distributed-systems** problem —
replication, convergence, and the safe reclamation of deleted data — and it is normally solved by
centralising the state. Recent work treats multi-agent memory as an architecture and governance
problem (Yu et al. 2026; Margalit et al. 2026) and surveys the mechanism space (Du 2026), but the
consistency and reclamation core is inherited from distributed systems, not from retrieval.

noonien takes the opposite route. It keeps the drop-in tool surface and replaces the shared file
with:

1.  **Per-node shards.** Each machine authors exactly one append-only shard, `<node>.jsonl`. A shard
    has a single writer by construction, so there is no file to contend on and the transport can
    never produce a conflict copy.
2.  **A convergent fold.** The graph is a state-based CRDT (Shapiro et al. 2011) — an
    LWW-Element-Set whose elements are decided by the total order `(HLC, node, seq)` — so merging is
    idempotent, commutative, associative and convergent: any two nodes that have seen the same
    operations hold the identical graph, in any order.
3.  **A transport of choice.** `file`/`s3` converge through a shared area that already exists; the
    companion `nooniend` daemon replicates shards peer-to-peer, needing only IP reachability, with
    no shared area and no service to host.
4.  **No causal resurrection.** Tombstones are reclaimed per element, gated on what an away peer had
    folded, without a global barrier and without a timer on the data.

The rest of the paper is organised as follows. §2 states the system model, the operation log, the
clock order and the fold. §3 describes the anti-entropy engine (reconciliation, digest, membership,
compaction) and its convergence argument. §4 is the contribution: barrier-free tombstone collection,
the metadata-bounding retention policy, and the soundness argument. §5 records the
evidence-retention rule the collection rewrite respects. §6 evaluates the system on a real
three-node deployment and reports the test suite. §7 relates the work to prior art, §8 states the
limitations and open problems, §9 concludes. Appendix A gives the reproduction recipe.

## 2. System model and data model

### 2.1 Model and assumptions

We consider a set of *nodes*, each identified by a stable, path-safe id
(`^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$`, no `..`). Each node owns one **shard** and authors every
operation in it; every node replicates every shard (a *full mesh*, or a federation of *islands*,
§8). The network is asynchronous and nodes may be offline for arbitrarily long. There is no global
clock and no consensus: the model is AP by choice, linearizable reads are not a requirement, and
merge is conflict-free by construction, so no ordering protocol or coordinator is needed.

We assume **crash-recovery** faults and a **single writer per shard** (enforced, §3.1). Nodes are
mutually authenticated members (mTLS, §3.4); the model is not Byzantine — a member can inject
operations, and that is treated as a correctness hazard to be bounded (§8), not as a privilege
boundary. The only place an operator accepts the possibility of losing a deletion is an explicit
forfeit (§4.4).

### 2.2 Operations and elements

Every mutation is an operation in an append-only log. The element algebra mirrors the reference
server exactly and distinguishes three element kinds: an **entity** (a name), an **observation** (an
`(entity, content, occurrence-slot)` triple), and a **relation** (a `(from, to, relationType)`
triple). The six graph operations are additive (`entity.create`, `observation.add`, `relation.add`)
or tombstones (`entity.delete`, `observation.delete`, `relation.delete`); a seventh,
`shard.compact`, is a shard-owned metadata operation the fold ignores (§3.5).

Each operation carries the envelope:

    v     = 1                                  // envelope revision
    id    = ts | node | seq                    // identity, enforced by the schema
    ts    = canonical UTC ISO-8601 (ms)        // wall-clock time of writing
    hlc   = "PPPPPPPPPPPPPPP:CCCCCC"           // 15-digit physical ms : 6-digit counter
    node  = author id
    seq   = per-shard sequence, monotonically increasing, never restarts

`id` is a pure function of `(ts, node, seq)` and is enforced by the operation schema, so a shard
read twice (or corrupted) is deduplicated by `id`, and two *different* operations can never share
one. `seq` is the durable per-shard high-water mark: it is recovered from the shard on restart and
bumped by every append, including the `shard.compact` metadata, so it never regresses (§3.5).

Two element-algebra details are load-bearing for collection. First, an `observation.add` carries a
**slot**, the occurrence ordinal of its content on the entity, so duplicate contents (which the
reference server preserves) are distinct elements and survive the fold; older operations without a
slot read as slot `0`. Second, an `observation.delete` is **content-level** — it removes every
occurrence of a content — so it is keyed at a reserved slot `-1`, *apart* from the per-occurrence
adds; a later add at a real slot therefore cannot shadow the delete during compaction, and grouping
by content (§2.4) is what keeps the delete attached to a surviving occurrence.

Elements are identified by a collision-free string key, `elementKey`, built from JSON tuples
(`["entity", name]`, `["relation", from, to, type]`, `["observation", entity, content, slot]`,
`["shard", node]`).

### 2.3 Hybrid Logical Clock

Ordering must survive clock skew and must let a node that has *observed* a claim write a correction
ordered strictly after it. The order is `(hlc, node, seq)` with `hlc` a **Hybrid Logical Clock**
(Kulkarni et al. 2014), encoded as a fixed-width, lexicographically sortable string
`PPPPPPPPPPPPPPP:CCCCCC` (15-digit physical milliseconds, 6-digit counter) so that a plain string
comparison is the temporal comparison. Physical milliseconds overflow the counter (one million
stamps in the same millisecond) by bumping the physical component, as the standard algorithm
prescribes.

The clock has two operations. `next()` returns a stamp strictly greater than any issued or observed
before, advancing physical time when the wall clock moves forward and otherwise incrementing the
counter. `observe(remote)` advances the local clock past a stamp seen elsewhere, so that a write
made after reading a remote operation is ordered after it: it takes the maximum of now, the local
physical time and the remote physical time, and adjusts the counter accordingly. A remote stamp
further than a bounded skew (`MAX_SKEW_MS = 60 s`) in the future is **clamped** before it can drag
the local clock, so a wrong or hostile clock whose operations this node folds cannot push the node's
own timestamps arbitrarily far ahead. Within a node the timestamp is monotonic even if the wall
clock steps back (NTP, a restored snapshot, a manual `date`).

### 2.4 The fold

A read folds every operation of every shard into a knowledge graph. The fold is a pure function of
the operation **set** — it depends on neither the order shards are read nor the order of lines —
which is exactly the CRDT convergence property.

- Entities and relations are **LWW registers**: the operation with the greatest `(HLC, node, seq)`
  wins and remembers whether it makes the element present. The winner is present iff it is an
  `*.add`/`*.create`.
- Observations are grouped by **content**; within a group an add is kept per **slot** while a single
  `lastDelete` is kept. An occurrence at a slot is present iff its latest add is newer than
  `lastDelete`; `create_entities` (which may carry duplicate contents) and `add_observations` (which
  adds every requested occurrence not already present) fall out of the same rule, and a
  content-level delete removes every occurrence older than it.
- Visibility is composed: an observation is shown only while its entity is present, and a relation
  only while both endpoints are present.
- Output order is deterministic: entities by name, relations by `(from, to, relationType)`,
  observations in operation order.

**Lemma 2.1 (the fold is a set function).** The fold compares and combines operations only through
`(HLC, node, seq)` and set membership; it never branches on input order. Hence the fold is
idempotent, commutative and associative, and two nodes holding the same operation set produce the
identical graph.

**Worked example.** Nodes `a` and `b` each create a different entity and a relation between them,
then `a` deletes an observation `b` had added. Folding `{a,b}`'s operations in either order yields
the same graph: the entity winner is the single create; the relation is present because both
endpoints are present; the observation is absent because `a`'s content-level `observation.delete` is
newer than `b`'s add. Had `b` authored the add *after* seeing `a`'s delete, its HLC would order
after and the observation would be present — LWW is not itself resurrection (§4.8).

## 3. The convergence engine

The daemon `nooniend` replicates each node's shard to the others. It is a small HTTP/JSON service;
a node's MCP server writes only its own shard, and the daemon writes a peer's replica only when it
merges one (the single exception is recovering this node's own lost shard, §3.1).

### 3.1 Shards, single writer, and safe rewrite

A shard is `<node>.jsonl`. The daemon tracks each shard as a decoded index — an id set for
deduplication, a `maxSeq` high-water mark, and a `generation` — kept between rounds and advanced in
place when the daemon appends, so a merge never re-reads the file it just wrote; a shard is
re-decoded only when its fingerprint (mtime:ctime:ino and byte length for a file; a version token
for an object) moves.

The single-writer rule is enforced at three levels. (i) The sequence never restarts: the server
recovers `maxSeq` from its shard on restart and reuses the same ids on a failed append rather than
leaving a gap. (ii) A **conflicting operation id** — two operations with the same `id` but different
content — means two writers shared one node id; a read then **fails loudly** instead of silently
dropping one. (iii) Storage serialises writers: on the `file` backend, `append` and `replace` take
an exclusive per-shard lock file (holder token, mtime heartbeat, stale steal after
`LOCK_STALE_MS = 10 s`, bounded wait), so a compaction running while a server appends fails loudly
or waits rather than dropping the append; on the `s3` backend, appends and rewrites are
**conditional writes** guarded by the object's version token (`If-Match`/`If-None-Match`), retried
against the new version. A rewrite is a compare-and-swap to a temporary file, `fsync`ed and renamed
over the target, so a crash midway can never truncate a shard and a concurrent writer makes the
rewrite fail and retry (five attempts), never lose it.

The daemon **recovers** this node's own shard from a peer's replica when the peer holds a more
complete copy of it: it re-appends operations that already belong to this node, so the per-node
single-writer rule still holds and no id can collide. Every such write goes through the same backend
lock/CAS.

### 3.2 Anti-entropy

Reconciliation is **push-on-change plus periodic anti-entropy**. The daemon watches this node's own
shard and triggers a round on change (debounced), and runs a round every `NOONIEND_INTERVAL`
seconds (default 30). A round samples peers, exchanges with each, then records knowledge and
collects (§4).

An exchange with one peer (Demers et al. 1987; DeCandia et al. 2007) compares per-shard high-water
marks and moves the delta in whichever direction is behind:

- **This node's own shard** is pushed as the delta `seq > remote.maxSeq`; a peer whose replica is a
  *superseded generation* must instead replace the whole shard, which it does on its own round —
  pushing the delta would deliver the `shard.compact` metadata and advance the peer's generation
  while leaving the operations the compaction dropped in its replica forever. Conversely, if the
  peer holds a more complete copy (higher `maxSeq`, or a newer generation), this node **recovers**
  its own lost operations from it.
- **Every other shard** is pulled: replace the replica when the author's generation is newer, else
  receive the delta `seq > local.maxSeq`.

A node serves every replica it holds, so an operation reaches a third node by being pulled through
an intermediary: **relay** is free, and an offline node keeps converging through any online one.
Operations are idempotent and the fold commutative, so delivery may be best-effort; what is required
is only that deltas eventually arrive. The operations push is accepted only for the shard the
authenticated peer names, so a member cannot write another node's shard; reads stay open to any
authenticated peer, which is what enables relay.

**Convergence.** Because (a) every operation is eventually delivered to every reachable node, (b)
the fold is a set function (Lemma 2.1), and (c) a node's own shard is never overwritten by a peer
(only recovered from), any two nodes that have exchanged the same operations hold the identical
graph, whatever the delivery order. This is covered by a property test that reconciliation converges
from any generated set of shards even when only a subset of pairs reconciles each round (§6.8).

### 3.3 The shard digest

Above a threshold (`NOONIEND_DIGEST_MIN_SHARDS`, default 32) and with a peer that advertises the
`digest` capability, reconciliation compares the shard sets through a **fixed-size digest** instead
of exchanging the full list. Each shard's summary (`node`, `maxSeq`, `generation`) is bucketed by a
stable hash of the node into 16 buckets; each bucket is a hash of its sorted summaries, and the
digest is a Merkle root over the bucket hashes plus the buckets. Two peers exchange the
constant-size digest; if the roots match, nothing is exchanged; otherwise only the **differing
buckets** are fetched, so per-round metadata is O(buckets) rather than one summary per shard. The
capability is **additive**: a peer without it falls back to the plain shard list, so a mixed mesh
never breaks. A corrupt digest (wrong bucket count, duplicate or out-of-range indexes) is rejected
at parse time rather than reconciled against the wrong buckets.

### 3.4 Membership

Membership is itself a gossiped **LWW set**; there is no SWIM, Consul, etcd or mDNS. A node is the
source of truth for its own entry; entries learned from a node's own `/info` (or an operator seed)
are **verified** and authoritative, so a later gossiped claim cannot hijack the address of a node we
have talked to. Reachability is local: a run of failed exchanges marks a peer *suspect* and then
*dead*, after which it is backed off but never permanently condemned — an inbound request from the
peer **revives** it immediately, and a newer version of its entry (a restart) does too. A dead peer
not reached for the membership TTL is **forgotten**: its entry is removed but its **version is
remembered**, so the old entry still circulating in other nodes' gossip cannot silently re-add it;
only a strictly newer version brings it back. That is what makes the peer set eventually shrink
instead of growing forever. The live set and every list response are bounded, so a hostile peer
cannot force unbounded state from a single response.

Bootstrap adapters (a static seed, `_nooniend._tcp` DNS SRV, or `tailscale status`) return only an
*initial* list; membership then self-propagates. The transport is HTTP/JSON with a JSON-Lines
operations stream; under mTLS every route requires a client certificate whose common name is the
peer's node id.

### 3.5 Compaction and generation

The log grows with every mutation. **Compaction** rewrites this node's shard keeping, per element,
only the operations no later one shadows, where the shadow index is built from the **merged** view —
so an operation superseded by *another node's* later operation is dropped too, and the winner of
every element always survives. It runs online (after `NOONIEN_COMPACT_AFTER` appends, default 1000)
and by hand (`noonien compact`). Because compaction drops operations that peers may still need, it
is stamped with a `shard.compact` metadata operation carrying `generation` (bumped every time) and,
via its own `seq`, the shard's durable high-water mark. Peers read the generation and **replace** a
stale replica with the compacted shard, so every copy converges to the compacted content and a
compaction is never mistaken for a lost shard. Only the local shard is rewritten, so compaction is
conflict-free across nodes.

Compaction and collection share one rewrite path and one per-element plan (§4.4): plain compaction
has an empty collection plan; collection adds the decision to drop a surviving tombstone.

### 3.6 The stable watermark

The daemon exposes a per-shard **stable watermark**: the minimum high-water mark per shard across
this node's replica and every contactable peer (a peer that does not hold a shard counts as `-1`),
so an operation at or below it has reached every contactable peer. With a fanout cap the last
high-water mark observed from each peer is kept across rounds — a stale value is a lower bound,
hence conservative. The watermark is **observability** and a conservative causal-stability bound;
tombstone collection does *not* use it (that would need a barrier) but the finer per-element gate of
§4.

## 4. Tombstone collection gated on durable knowledge

The claim, precisely: the gate needs **no barrier over the past** — a peer that never folded an
element cannot *causally* contest it, however long it stays away, and no timer is placed on the
data. What it does need is a **stable round over the live set**: every still-reachable peer
exchanged with in that round, and none holding anything this node lacks. Throughout this section,
"no barrier" means exactly that. A peer that is both unreachable and unverifiable is not governed by
a timer but by a decision: it stays a blanket until an operator departs it (§4.9, §8), which is
where we place the liveness cost rather than on the data.

### 4.1 Why a tombstone cannot simply be dropped

A delete is an operation, not a removal. The tombstone is exactly what makes the deletion beat a
concurrent add that knew the element: it wins the fold by `(HLC, node, seq)`. Dropping it while such
an add still exists anywhere revives the element. Collection must therefore remove a tombstone only
when no replica that could re-deliver a *causally aware* competing operation — one authored after
folding the element — is left unaccounted for. The two failure modes are symmetric: collect too
eagerly and a returning peer that had folded the element **resurrects** deleted data; collect too
conservatively and tombstones (and the operations they shadow) accumulate forever, and — the failure
that actually bites — **collection stops**, because the safe-to-forget set includes exactly the
peers that have been gone the longest.

### 4.2 Prior gates, and why they fail here

We read the gates in the literature as two families, both of which answer the same *stability*
question — and the peer-knowledge mechanisms that compute stability belong to the first, not to a
third predicate (§4.10).

- **Causal stability** — "every replica has seen the operation" (Birman et al. 1991; Baquero et al.
  2014). It presupposes that "every participant has seen it" is a fact you can establish. In our
  deployment a machine may be offline for months, or forever; "every replica" is not a set you can
  observe, so the condition is either unsatisfiable (collection never happens) or is approximated by
  a barrier that the model is designed not to have. Matrix clocks (Wuu and Bernstein 1984) and
  dotted version vectors (Preguiça et al. 2010) *compute* this condition — per message, and per key
  — without tracking every acknowledgement; they shrink the state and the messages, but they answer
  the same question and inherit the same limitation.
- **A time grace** — Cassandra's `gc_grace_seconds` (Apache Cassandra 2026), Kafka's
  `delete.retention.ms` (Apache Kafka 2026), `git gc` prune expiry (Git project 2026). After the
  grace the tombstone is dropped unconditionally. This keeps tombstones for at least the grace, and
  then **resurrects** if a peer returns after it: Cassandra's "zombie". The grace is a *timer on the
  data*, and it is unsound whenever the outage can exceed the timer.

Both are stability conditions in the sense that they answer "when is an operation stable?" Our claim
is that the question we need is narrower and, crucially, **decidable per element against a peer we
have talked to**: *had this peer folded this element, so as to author a competing operation on it?*

### 4.3 The knowledge frontier

For every peer it has exchanged with, a node keeps a durable **knowledge frontier**: the greatest
sequence it has been seen to hold of each author's shard. Because a shard has a single writer, a
per-author high-water mark is a *version vector* of what the peer holds: `frontier[A]` $\geq$ `s`
means the peer holds every operation of `A` up to `s`. The frontier is stored as the **greatest ever
seen** per author: once a peer is known to have held an operation it keeps counting as a possible
author of a competing one, even after it compacts that operation away — a peer that once knew an
element may still have written on it, so a later, smaller report must not erase the knowledge.

The frontier answers the per-element question through a simple structural invariant.

**Invariant 4.1 (authorship implies prior knowledge of the element's dependencies).** The operations
do not require the same knowledge of `e`. A **tombstone** (`*.delete`) is authored only after the
node has folded some operation on `e` — it must see the element to name it. An **add** (`*.create`,
`*.add`) is authored after the node has folded the *identities `e` depends on* — nothing at all for
an entity, the entity for an observation, both endpoints for a relation — and **not** necessarily
`e` itself: a node that knows `E` can add an observation on `E` it has never seen, and a node can
mint a name it has never seen. Consequently a frontier that covers **no** operation of `e` rules out
a competing *tombstone* from that peer, but not a competing *add*.

We say a peer **folded** (or *knew*) an element when its frontier covers an operation of it. The
coverage test therefore establishes **causal** competition: if the frontier covers an operation of
`e` the peer folded `e`, and a write it makes on `e` while away is causally aware of the deleted
fact, so the tombstone is kept to beat it; if it covers none, any operation the peer authors on `e`
is a **concurrent genesis** — an independent, coincident naming — which the fold decides by
`(HLC, node, seq)` and which is not a revival of the deleted data (§4.8). The invariant is what
turns "could this peer *causally* contest `e`?" from a question about the future into a finite test
over the operations known for `e`; the definition of revival is narrowed to match.

### 4.4 The per-element gate

A collection of this node's authored shard proceeds per element, over the elements whose current
winner is this node's own tombstone. Before dropping a tombstone, the element must clear the gate
for **every** peer that must still be counted (the membership's known and forgotten peers, plus
*every peer this node has ever exchanged with* — a membership drop must not silently unblock a
deletion):

- **Coverage.** The peer's frontier must cover **no** operation of the element. If it covers one,
  the peer folded the element and may have authored a competing operation that the tombstone must
  beat; the element stays frozen. By Invariant 4.1, not covering any operation means the peer never
  folded the element, so it cannot have authored a competing *tombstone* on it; an *add* it authors
  that names a coincident element is a concurrent genesis, not a competitor (§4.8).
- **Subset.** The peer's frontier must not exceed the local high-water marks — the peer must hold
  nothing this node lacks. If it *does* exceed them, its holdings cannot be read as a subset of the
  local view: it could hold a **relayed** operation on the element, authored by a third node, that
  the per-author frontier does not identify. Such a peer acts as a **blanket**: every element is
  blocked.
- **Suspend.** A peer that is still *reachable* but was not exchanged with this round blocks
  everything this round: it may hold writes this node has not pulled, and its stored frontier says
  nothing about them. Collection is suspended until the round covers it.
- **No record.** A peer never reached has no frontier; it could hold anything and so blocks every
  element (the conservative blank).
- **Departure.** An explicit revocation/departure is the **only** forfeiture: it takes a node out of
  the gate (and a departed peer's replica is discarded), the operator's explicit decision that the
  node's writes are expendable. Forgetting a peer (the membership TTL) does **not** unblock it — it
  may be alive off-mesh with valid unsent writes.

Put precisely, with the local high-water marks `L`, a gating frontier `F` and the operations
`ops(e)` of an element `e`:

    subset(F, L)        <=>  every author a: F[a] <= L[a]
    covers(F, ops(e))   <=>  some op o in ops(e): F[o.node] >= o.seq
    collectable(e)      <=>  not suspended and, for every F in peers:
                             subset(F, L) and not covers(F, ops(e))

`peers` holds one frontier per retained off-mesh peer, the retired frontier `M`, and a bottom
element that fails `subset` for a peer never reached or a durable blanket. A tombstone is dropped
only for an element that is `collectable` **and** whose own operations can go with the fold
unchanged; everything else is counted *frozen*.

An element that appeared while a peer was already away is thus collectable **at once**, without
waiting for that peer to return; an element the peer did know stays frozen until the peer comes back
or is departed. When a peer could contest an element, the element is **pinned** — every operation of
this node on it is kept, so the operation the peer knew survives as the evidence the next round
reads again (§5).

The gate is used by the rewrite as a guard. For each candidate element the plan computes whether the
guard allows it and whether dropping this node's operations leaves the element absent (no *other*
node's surviving operation decides otherwise); it drops the tombstone only when both hold, counts
the rest as *frozen*, and publishes the frozen-element, absent-peer and absent-seconds metrics
(§6.1).

### 4.5 The metadata problem

The gate is sound but its own state grows, along three vectors. (1) **Untrusted gossip**: a peer
entry adopted from another node's list and never contacted. (2) **Legitimate churn**: a fleet that
recycles hostnames accumulates knowledge of machines that no longer exist. (3) **A reachable peer
inflating its frontier**: the shard list accepts a bounded number of entries per response, and the
recorded frontier merges monotonically, so an author it declares but never serves enters the durable
record for good — and such an entry makes the peer a permanent *superset*, which freezes the
collection of **every** element, durably.

The cost is memory, per-round work, metric cardinality that grows with the retained set, and
collection that stops. But this metadata cannot simply be capped: the frontier's own safety argument
is why it grows — the peers that block collection are precisely the ones gone the longest, so they
must be remembered across restarts.

### 4.6 The retired frontier: materialise the comparison, not its outcome

The crucial observation is that a peer's protection is **not a set of elements**; it is the
*comparison* "does this peer's frontier cover an operation of the group?", evaluated on the
operations present **at collection time**. So a naive form — at expiry, pin the element groups the
peer's frontier currently covers, then forget the peer — is **unsound**: pins are computed over the
groups that exist at expiry, and an element that gets its tombstone **after** the expiry is not
among them. If an absent peer then authors a competing operation before that tombstone (it still
sees the element, because it has not seen the deletion), the tombstone must beat it, and with the
pin absent it is collectable: the deletion is lost when the peer returns.

The sound form materialises the comparison itself. After a retention window `NOONIEND_FORGET_AFTER`
(seconds of silence; default **180 days**, `0` disables), a retained peer nothing has heard from is
**retired**:

- If the peer is **accounted for** — its frontier is a subset of this node's high-water marks — its
  frontier is folded into one durable **retired frontier** `M`, the elementwise maximum per author
  (`M[a] = max(M[a], F[a])`). `M` is then used by the gate exactly as a live peer's frontier is, so
  it covers **past and future** collections, including deletions that happen *after* the retirement.
- If the peer is **unaccounted for** — it claims operations this node cannot read — its frontier is
  not something we can verify, so it is replaced by a durable **blanket** (the same "it could hold
  anything" the gate already applied to it, now stated once instead of carried as an unverifiable
  map).
- A peer with **no record at all** (never reached) is left alone: there is nothing to materialise.

Then the peer's live record is dropped and it is removed from retained membership. Retiring is
**semantically invisible**: the per-element decisions are unchanged, because the gate asks "is *any*
frontier covering this operation?" and the elementwise maximum is exactly the union of the peers'
per-element decisions. What changes is only where the thresholds live. Two consequences are
first-class: `M` covers future deletions because the comparison is kept rather than a snapshot of
its outcome; and `M` is **permanent** (a maximum cannot be un-merged), so a node must be departed
*before* its window expires for its contribution to be lifted.

`M` cannot over-reach: only *accounted* peers are merged, so `M` $\subseteq$ `local` always holds,
hence the authors named in `M` are authors this node already holds and `|M|` is bounded by the
**shards this node holds**, not by the nodes ever seen. The retired frontier and the blankets are
written under reserved keys of the knowledge file (which cannot collide with a peer record, since a
node id may not contain the reserved marker) and are read atomically with the rest of the record; a
malformed retired frontier **fails loudly** rather than being ignored, because a dropped threshold
would *unblock* an element a retired peer could still contest (unlike a dropped peer record, which
only conservatively keeps blocking).

### 4.7 The blanket, materialised

An unaccounted peer has no per-element information to merge — that is what "unaccounted" means. Its
only sound statement is "it holds something I lack, so it could contest anything", which is the
blanket the gate already applies. Materialising it as one durable marker keeps that statement
without a frontier to hold (memory O(1) per such node), and it is honoured after a restart. A node
becomes accounted again the next time it exchanges successfully (its live frontier then takes over,
and the blanket lifts); an explicit departure clears it too.

### 4.8 Soundness

Write `W` for the set of operations that exist in any replica, and call an element `e` **guarded**
while some replica that had **folded** `e` could still deliver an operation on `e` that the
tombstone must beat. "Folded" is what the coverage rule detects; a replica that never folded `e` can
only mint a coincident element, a concurrent genesis the fold decides rather than a competitor. The
two invariants are:

- **I1 — no causal revival.** An element's tombstone may be physically removed only when no replica
  that could re-deliver a competing operation it was **causally aware of** — one it authored after
  folding `e` — is left unaccounted for. Forfeiting that is the operator's explicit act.
- **I2 — LWW is not revival, and a concurrent genesis is not either.** An operation authored *after*
  the tombstone wins the fold by the CRDT's own order, whether or not the tombstone still exists. An
  operation that **never folded `e`** — an entity name minted independently, an observation on a
  known entity, a relation on known endpoints — is not aware of the deletion at all, so if it is
  older than the tombstone and the tombstone has been collected it may survive; that is accepted as
  a fresh fact, not a revival of the deleted one. What I1 protects is the causal case: an operation
  **older** than the tombstone, authored by a replica that had folded `e` while it was away, whose
  re-delivery the tombstone must still beat.

At any time each retained peer is in exactly one of four states: (1) **live, accounted** — the
coverage rule runs against its stored frontier; (2) **live, unaccounted** — the blanket holds; (3)
**retired** — its merged `M` runs the same coverage rule (and a retired unaccounted peer left a
blanket); (4) **departed/revoked** — forfeited by the operator.

**Lemma 4.2 (retirement is decision-preserving).** Let an accounted peer with frontier `F` be
retired into `M`, so the new retired frontier is `M'[a] = max(M[a], F[a])`. `subset(F, L)` and
`subset(M, L)` hold — each is within the local high-water marks — so `subset(M', L)` holds, and `M'`
covers an operation of `e` exactly when `M` or `F` did: `covers(M', ops(e))` equals
`covers(M, ops(e))` or `covers(F, ops(e))`. An unaccounted peer is replaced by a blanket, a bottom
element that fails `subset` — exactly as its unverifiable frontier did. Hence for every element
`collectable` is unchanged.

Expiry moves a peer from 1–2 to 3 **without changing which elements are guarded**: for the accounted
case, `M` reproduces the coverage decisions for every group, present or future (the elementwise
maximum is the union of the per-element decisions); for the unaccounted case, the blanket *is* the
statement. Therefore a tombstone is only ever removed when no non-forfeited replica that folded the
element can deliver an older competing operation, so no **causal** revival is possible; an away peer
that never folded the element may still mint a coincident one, a concurrent genesis the merge
decides.

The remaining source of unbounded state is the claimed-but-unreachable peers kept as blanks (no
frontier, no knowledge); its only bound is a membership policy or a forfeiture decision (§8). We
record this openly rather than hide it.

### 4.9 The claim-not-served rule

Vector 3 of §4.5 is closed at the source: after a successful exchange, an author the peer reported
but did **not** serve is not recorded. Within one successful exchange the peer either serves an
author's operations or not; if it claims a sequence for a shard of which we hold nothing, the claim
is inconsistent with its own service and is dropped (it is re-learned on the next exchange). Without
this, an unaccounted blanket is permanent and no expiry policy can tell a lie from a lag; with it, a
peer cannot freeze the mesh with a claim it cannot back, and anti-entropy re-earns the record on the
next successful round.

### 4.10 Relation to prior art

Relative to **causal stability** (Birman et al. 1991; Baquero et al. 2014), the knowledge frontier
replaces a global "has everyone seen it?" with a per-peer, per-element "had this peer folded it, so
as to author a competing operation on it?" — decidable for a peer we have contacted and kept
decidable after we stop contacting it. It is strictly finer: `M` freezes only the elements a retired
peer could have folded, whereas a stability barrier freezes everything behind the slowest replica.

**Matrix clocks, Bayou and dotted version vectors.** The nearest prior mechanisms also draw on what
a peer *knows*, so the distinction is predicate and granularity, not vocabulary. A **matrix clock**
(Wuu and Bernstein 1984) is an $n \times n$ structure that lets a process compute when a log entry
is causally stable without tracking every acknowledgement; **Bayou**'s anti-entropy and dependency
check stabilise committed writes (Demers et al. 1994); a **dotted version vector** prunes a key's
per-replica metadata once every replica has seen a dot (Preguiça et al. 2010). All three reduce the
cost of establishing *"every replica has seen it"* — per message, or per dot and key — but they
remain stability mechanisms: the matrix clock's state grows with the membership ($O(n^2)$ in the
worst case), and all three answer when a write can be forgotten because everyone has seen it, not
whether a given peer could have written on a given element. Our frontier is per *author shard*, and
the predicate is not stability: it is the per-element possibility that a named peer could have
**folded** the element, answered from a map bounded by the authors this node holds and kept
decidable after the peer stops being contacted.

**Yjs and Automerge** (Nicolaescu et al. 2016; Kleppmann and Beresford 2017) sit at a different
point in the design space rather than beside this work: their deletes are monotone — a delete is
never beaten by a concurrent add — so there is no tombstone/LWW revival to gate, and where they do
reclaim (Yjs frees the content of deleted items) it is against a state vector, i.e. causal stability
again. The contribution is therefore a different predicate, evaluated per element, not a cheaper way
to evaluate the stability predicate.

Relative to **$\delta$-CRDTs** (Almeida et al. 2018) and to the **Dynamo** anti-entropy digest
(DeCandia et al. 2007), the contribution is orthogonal: those bound what is *transferred*, this
bounds what is *retained* to make collection safe. Relative to **Byzantine CRDT revocation**
(Kleppmann 2022), the frontier does not defend against a malicious member that lies about its own
holdings (that is handled at the membership/authentication layer and by the claim-not-served rule),
and revocation is the analogue of an explicit forfeit. Relative to **grace-based** collection
(Apache Cassandra 2026; Apache Kafka 2026; Git project 2026), the difference is principled: the
window bounds *metadata* (which peer's thresholds must be materialised), never the *data*, and it is
on by default precisely because expiring a peer forfeits nothing.

## 5. Implementation notes: evidence retention under rewrite

A collection gate is only as sound as the evidence it reads. The gate answers "does this peer's
frontier cover an operation of the element?" by looking at the operations **present in the log**.
The operation that a peer's frontier covers is therefore *the proof* that the peer knew the element,
and it must survive every rewrite until the element is genuinely collectable. The rewrite drops two
kinds of operation of this node's own: a **tombstone** it authored (collection), and one of its own
operations that a later one **shadows** (compaction). Both are safe to drop only when the guard
clears the element; otherwise the element is **pinned**, and every own operation on it is kept as
the evidence a later round reads.

Three properties make the rule complete.

1.  **A suspended round pins too.** When a round suspends — a reachable retained peer it did not
    exchange with — every own operation the guard cannot clear is kept, exactly as for an off-mesh
    contest. The suspension says nothing about any recorded frontier: it is a statement that writes
    may be in flight, so an element it covers must be left whole, or the next round, with that peer
    now dead, would find no operation its frontier covers and clear an element the peer had in fact
    known.
2.  **The evidence may live on another shard.** A delete by one node of an element another node
    created leaves the tombstone on the deleter's shard and the create on the creator's, so the rule
    binds every node, not only the deleter: a node must not prune a shadowed operation of its own on
    an element that a retained off-mesh peer's frontier could still contest, or the deleter's gate
    would lose the proof the moment the creator pruned it.
3.  **The rule is the invariant, not the winner.** The evidence a later round reads is every
    operation of the element, not only the one whose winner is a tombstone: an operation a later one
    shadows on an element that is still *live* (a re-created entity, say) is evidence too, and
    dropping it can leave a later delete with nothing a peer's frontier covers. The rule is
    therefore the invariant itself — an element the guard cannot clear keeps every own operation —
    and `allows` is consulted only for a group holding one of this node's tombstones or a shadowed
    own operation, so a large live graph stays linear.

A complementary rule keeps the two writers from erasing each other's evidence. Where a daemon owns
the directory (it announces itself with its knowledge file, written from startup), the daemon holds
the peer knowledge and collects, so it is the only writer that maintains the shard; the server and
the maintenance CLI then **keep their whole view** — they prune nothing — because a shadowed
operation is exactly the evidence the daemon's gate reads. Without a daemon there is no knowledge to
gate on, so the server's online maintenance and the CLI prune only, and a physical deletion happens
only where the operator declares the directory written by this node alone; a declaration
contradicted by another node's shard is refused. The volatile `memory` backend, which shares
nothing, is the exception — with no peer that could hold an unseen write, it collects without the
declaration. Finally, the shard a one-shot import writes only ever adds, so it needs neither the
peer knowledge nor the operator's promise: it is pruned on the way out and by the maintenance
command, which drops the operations a later one shadowed while keeping every surviving tombstone and
rewriting only when something was actually dropped (a rewrite bumps the generation, and a bumped
generation makes every peer re-pull the shard).

## 6. Evaluation

### 6.1 Deployment and metrics

The evaluation ran on a **three-node deployment** over a WireGuard overlay network, each node
running the MCP server and the replication daemon from the same build, against a dedicated, empty
store per node. The nodes are referred to as `node1`, `node2`, `node3`; `node3` is the peer taken
off the mesh in the two off-line experiments. Workloads were issued through the drop-in MCP tool
surface (the same nine tools as the reference server); measurements were read from the daemon's
read-only HTTP API (`/graph`, `/shards`, `/peers`, `/metrics`). The metrics are listed in Table 1.

**Table 1.** Metrics used in the evaluation.

| Metric | Meaning | Source |
|----------------------------------|----------------------------------|----------------------------------|
| `fold` (entities / relations) | the folded graph a node serves | `/graph` |
| `count / maxSeq / generation` | a shard's operation count, durable sequence and rewrite generation | `/shards` |
| `frozen_elements` | element groups whose tombstone was kept because an off-mesh peer may contest them | `/metrics` |
| `absent_nodes` | retained peers not exchanged with in the last round | `/metrics` |
| `ops_pushed_total` / `ops_pulled_total` | operations sent / received across exchanges (not distinct ops held) | `/metrics` |
| `bytes_sent_total` / `bytes_received_total` | wire bytes (payload + digest traffic) | `/metrics` |
| `rounds_total` | anti-entropy rounds elapsed | `/metrics` |

The suite is ten tests on release 1.0.0. The concurrent-merge tests run the daemons with
push-on-change disabled, so a write reaches the peers only at the next periodic round and a genuine
race is possible. The two off-line tests stop `node3`'s overlay route (an owner-operated action), so
the writes happen while it cannot receive them. §6.3–6.6 report the ten tests (§6.4 are sanity
checks of the fold, explicitly not evidence for the gate); §6.7 adds the time-resolved measurements,
§6.8 summarises the suite and §6.9 states what the evaluation does and does not establish.

### 6.2 Workloads

The ten workloads are listed in Table 2.

**Table 2.** The ten workloads (P01–P10).

| Test | Scenario | Class | Nodes writing concurrently | Graph ops written |
|----|----|----|----|----|
| P01 | single-writer propagation and convergence | convergence | 1 | 250 |
| P02 | concurrent create of the same entity name | sanity | 2 | 2 |
| P03 | concurrent distinct observations on one entity | sanity | 2 | 2 |
| P04 | concurrent observation delete and add | sanity | 2 | 2 |
| P05 | concurrent create of the same relation | sanity | 2 | 2 |
| P06 | 2000-entity delete and physical collection | collection | 1 | 5050 |
| P07 | two nodes, 2000 entities each, concurrent | scale | 2 | 10000 |
| P08 | cross-node invalidation, 2000 entities each | collection | 2 | 8000 |
| P09 | off-mesh peer; 4000 elements it knew deleted | safety (off-line) | 2 | 8000 |
| P10 | off-mesh peer; known vs unknown elements | safety (off-line) | 1 | 10000 |

P02–P05 are two-operation **sanity checks** of the fold's same-element merge; they are not evidence
for the collection gate, which is exercised at scale by P06–P10.

### 6.3 Convergence

P01 is the base case: `node1` creates 100 entities (one observation each) and 50 relations — 250
operations. All three nodes fold the identical `[100, 50]`, and each holds the same single shard
with `count = 250`, `maxSeq = 249`, `generation = 0`. `node1` pushed 500 operations (250 to each of
its two peers); the peers pulled and converged; `frozen_elements` stayed 0.

**Table 3.** Convergence across the mesh (P01, P07).

| Test | Nodes folding identical graph | Shards replicated | Shards / stable |
|------|-------------------------------|-------------------|-----------------|
| P01  | 3 / 3                         | 1 shard × 3       | 1 / 1           |
| P07  | 3 / 3                         | 2 shards × 3      | 2 / 2           |

P07 scales the convergence check (Table 3): `node1` and `node2` each write a disjoint dataset of
2000 entities (one observation each) and 1000 relations — 10000 operations total — while receiving
the other's. All three nodes fold the identical `[4104, 2051]` and replicate both authored shards
identically (`node1: 5254/15368/g12`, `node2: 5005/6868/g2`), `frozen_elements = 0`. The union of
two large, independent datasets is exact on every node.

### 6.4 Concurrent merges (sanity checks)

P02–P05 exercise the same-element races directly, and they are **sanity checks**, not evidence for
the collection gate: each is a pair of operations with no retained off-mesh peer involved. Each pair
was confirmed concurrent by the fact that **both** calls succeeded, which proves neither node had
received the other's operation. Table 4 gives each pair and its outcome.

**Table 4.** Same-element races and their merged outcome (P02–P05).

| Test | Concurrent operations | Merged outcome on every node | Rule |
|-------------------------|-------------------------|-------------------------|-------------------------|
| P02 | create `DUP` (type A) $\parallel$ create `DUP` (type B) | one entity, `entityType` = B (the later `(HLC, node, seq)`) | LWW register |
| P03 | add `obs-A` $\parallel$ add `obs-B` on one entity | both observations, same order | union; deterministic output order |
| P04 | delete `obs-A` $\parallel$ add `obs2-B` | `obs-A` gone, `obs2-B` present | content-level delete vs. a newer add |
| P05 | create `A knows B` $\parallel$ create `A knows B` | exactly one relation | set idempotence |

Every outcome is byte-identical on all three nodes: the fold is deterministic under a same-element
race, and a concurrent delete does not clobber a concurrent add (nor vice versa).

### 6.5 Collection: the off-line safety experiment

The gate is per element and per frontier: with a peer off the mesh, a deletion of an element that
peer had folded stays **frozen** — the tombstone, and the operation the gate reads as proof that the
peer knew the element, are kept until the peer returns or is departed — while a deletion of an
element the peer never folded is collectable **at once**. The two off-line tests exercise the two
halves of that claim, at scale.

**A peer that knew the elements (P09).** `node1` and `node2` stage 2000 elements each — 4000 in
total, all of them known to `node3` — then `node3` is taken off the mesh and each writer deletes all
2000 elements the *other* one had created. While `node3` is away, the deletions stay frozen (Table
5).

**Table 5.** P09: frozen tombstones while `node3` is off the mesh.

| Node  | `frozen_elements` | Shard (count / maxSeq / generation)           | Tombstone ops added |
|-------|-------------------|-----------------------------------------------|---------------------|
| node1 | **4000**          | `4254` $\to$ `8254` / 36380 / g24 (unchanged) | +4000               |
| node2 | **4000**          | `4005` $\to$ `8005` / 27883 / g17 (unchanged) | +4000               |

Both nodes keep every tombstone and do not compact (`generation` unchanged): one `entity.delete` and
one `observation.delete` per deleted element, frozen because `node3`'s frontier covers them. The
frozen set is exactly the two thousand deleted elements — one group per entity and one per
observation, 4000 in all — and nothing else. On `node3`'s return the frozen set drops to 0 and the
tombstones are physically collected; all three nodes fold `[104, 51]`, so the deletion wins
everywhere.

**Known vs unknown elements (P10, per element).** With `node3` off the mesh, `node1` deletes 2000
elements `node3` **knew** and, in the same window, creates 2000 new elements and deletes 1000 of
them — elements `node3` never saw (Table 6).

**Table 6.** P10: known vs unknown elements while `node3` is off the mesh.

| Node           | `node3`-known set | new set      | `frozen_elements` | Shard             |
|----------------|-------------------|--------------|-------------------|-------------------|
| node1 (window) | 0                 | 1000 present | **4000**          | `14254/54383/g27` |
| node2 (window) | 0                 | 1000 present | 0                 | `5/35885/g19`     |

`node1`'s shard holds exactly the 4000 tombstones of the **known** set and no delete for the
**unknown** one: the gate keeps the elements `node3` knew and collects the ones it never saw, in the
same round and without waiting for the peer. On `node3`'s return, `frozen` $\to$ `0`, `node1`'s
shard `14254` $\to$ `6254`, and all three nodes fold `[3104, 51]`. Across both off-line tests the
mesh converges with no resurrection.

### 6.6 Collection: space reclamation

Collection is where a deletion becomes cheap. Table 7 folds the four collection-bearing tests under
a common metric — operations present in the authored shard before and after the physical deletion,
and the resulting reduction factor.

**Table 7.** Space reclaimed by collection (P06, P08, P09, P10).

| Test         | Node  | Shard before | Shard after | Ops reclaimed | Factor | Generation    |
|--------------|-------|--------------|-------------|---------------|--------|---------------|
| P06          | node1 | 5304         | 254         | 5050          | 20.9×  | g5 $\to$ g10  |
| P08          | node1 | 5254         | 254         | 5000          | 20.7×  | g12 $\to$ g17 |
| P08          | node2 | 5005         | 5           | 5000          | 1001×  | g2 $\to$ g8   |
| P09 (rejoin) | node1 | 8254         | 254         | 8000          | 32.5×  | g24 $\to$ g26 |
| P09 (rejoin) | node2 | 8005         | 5           | 8000          | 1601×  | g17 $\to$ g18 |
| P10 (rejoin) | node1 | 14254        | 6254        | 8000          | 2.3×   | g27 $\to$ g28 |

Reading the metrics together: in P06 a single node deletes 2000 of its own entities and the shard
shrinks \~21×; in P08 the deletion is **cross-node** (each node deletes the other's dataset) and
both shards are reclaimed, `node2`'s all the way to its 5-operation baseline (1001×); in P09 each of
two nodes deletes 2000 elements the third knew, holding 4000 tombstones first and reclaiming 8000
operations apiece once the third returns. The factor varies with how much of the shard is dead:
`node2: 5` is a shard whose entire authored content was invalidated, while `node1`'s P10 shard
retains the 2000 elements of the new set that were never deleted.

### 6.7 Propagation, throughput and cost

The time-resolved measurements come from two further runs on the same deployment (the suite above
measures correctness and state, not latency). A writer emits batched tool calls; peers converge as
operations land, not after the batch completes (Table 8).

**Table 8.** Propagation and invalidation latency.

| Run                             | Ops written | Client write time | Throughput   | node2 complete | node3 complete |
|---------------------------------|-------------|-------------------|--------------|----------------|----------------|
| propagation                     | 1000        | 4.06 s            | \~246 ops/s  | +3.0 s         | +5.1 s         |
| full invalidation + 5000 writes | 5000        | 2.96 s            | \~1689 ops/s | +27 s          | +12 s          |

Two observations follow. First, propagation is **incremental**: the faster peer completed *before
the writer finished* (the write took 4.06 s; `node2` was complete at +3.0 s). Second, latency is
dominated by the write rate, not the sync interval; the periodic round (default 30 s) is the safety
net that delivers a trailing operation.

Wire cost, from the propagation run (1001 shard operations, 211 594 bytes on disk), is in Table 9.

**Table 9.** Wire and operation cost of the propagation run.

| Metric                   | Value                               | Normalised                                |
|--------------------------|-------------------------------------|-------------------------------------------|
| Serialized operation     | 211 594 B / 1001 ops                | $\approx$ 211 B/op                        |
| Bytes sent by the writer | 422 844 B for 2000 pushes           | $\approx$ 211 B/op · 2 peers              |
| Bytes received by a peer | 220 505 B / 1001 ops                | $\approx$ 220 B/op (incl. digest traffic) |
| Ops pushed by the writer | 2000                                | 1000 × 2 peers                            |
| Ops pulled by a peer     | 1001                                | one shard                                 |
| Rounds                   | 12 (node2), 15 (node3), 19 (writer) | —                                         |

A complementary run measured invalidation latency directly: 600 tombstones appended and then
physically collected within the same \~1.6 s window once the peers were caught up (authored shard
`count 1001` $\to$ `1`). Deletion, in a converged mesh, both converges and frees space in seconds.

### 6.8 Test-suite coverage

The correctness of the model is checked in the project's automated suite, which is the
reproducibility artifact (Appendix A); Table 10 summarises its size.

**Table 10.** Automated test-suite size.

| Quantity                                 | Value     |
|------------------------------------------|-----------|
| Test files                               | 30        |
| Test cases                               | 327       |
| Property-based assertions (`fast-check`) | 11        |
| Source lines / files                     | 7501 / 41 |
| Test lines / files                       | 6085 / 30 |

The property assertions cover the CRDT laws — idempotence, commutativity, associativity, convergence
from any operation set, and convergence of two replicas exchanging shards — and two rewrite-safety
properties: **compacting preserves the folded graph**, and **collecting after pruning preserves the
folded graph**. The gossip layer adds a property test that reconciliation converges from any
generated shard set even when only a subset of pairs reconciles each round, and deterministic
daemon-level tests for a suspended round (the case of §5) and for a stale generation being replaced.
The rest of the suite is deterministic and drives the real code: the fold, the shard log and the
seven operations (including the incremental shard cache, HLC ordering and cross-shard compaction),
the migration from an official `memory.jsonl`, the nine-tool contract over an in-memory transport,
the daemon's HTTP routes — digest, ops, health, peers, membership, status, graph, metrics, watermark
— TLS with per-peer certificates, and the collection and retention state, including the frontier's
monotonic merge, the retired frontier and the blanket.

### 6.9 What the evaluation establishes, and what it does not

The ten workloads are a **correctness** evaluation, not a comparative one. P06–P08 show that
collection returns the authored shard to its live size (space reclamation), and P09/P10 show that
the gate freezes exactly the elements a retained off-mesh peer had folded and collects the ones it
never saw — per element, in the same round, with no revival on rejoin. They do not establish the
*advantage* over the prior families by measurement, in two respects we record rather than paper
over.

- **No grace comparator.** We did not run a grace-time gate (a tombstone dropped after a fixed
  window) against the same P09/P10 scenario. Its failure is the design's own premise — once a
  tombstone is dropped, nothing hides the element from a concurrent add that arrives later — and P10
  shows the two gates differ in kind: our gate keeps, in the same window, the 4000 elements `node3`
  had folded (`frozen_elements = 4000`) while physically collecting the 1000 it never saw, a
  per-element decision a single time grace cannot express — it would freeze both sets until the
  window, or drop both. A measured head-to-head remains to be run.
- **No metadata-growth measurement.** §4.6 bounds the durable knowledge by construction — live peers
  $O(\text{peers within the window} \times \text{authors})$, the retired frontier
  $O(\text{authors this
  node holds})$, blankets $O(\text{unaccounted retired nodes})$ — and the suite's retention tests
  check that the merge is elementwise and never regresses, but the evaluation does not measure the
  retained set, $|M|$ or the durable file footprint over a churn scenario with and without the
  window. That measurement is future work too.

Both are gaps in the *evidence*, not in the model: the soundness of §4 is argued from the model and
checked by tests, and what is measured here is correctness on the deployment.

### 6.10 Threats to validity

- **No baseline comparator.** The evaluation measures the gate against itself — frozen, collected,
  no revival — not against a grace-time gate on the same scenario; §6.9 states what that leaves
  open.
- **Metadata bound not measured.** The retention bound is argued and unit-tested, not measured on
  the mesh over a churn scenario (§6.9).
- **Scale.** Three nodes, thousands of operations. This is the regime the design targets (an island
  of tens of nodes, §8); it does not evaluate partial replication or thousands of nodes.
- **Latency resolution.** The nodes' clocks are not synchronised and the polling resolution is 0.5–2
  s, so cross-host times are indicative to about ±1–2 s. Throughput is a client-side write rate, not
  a network benchmark.
- **Operational confounds.** Two of the runs booted their observer processes late, so some per-peer
  timelines were reconstructed from replica mtimes and metric deltas rather than sampled live, and
  the off-line windows were shorter than intended.
- **No adversarial members.** The gate assumes benign, authenticated members and a single path to a
  node (§8); no malicious front is evaluated.

## 7. Related work

The mapping to the CRDT literature (Shapiro et al. 2011), logical clocks (Lamport 1978; Kulkarni et
al. 2014), epidemic anti-entropy (Demers et al. 1987), $\delta$-CRDTs (Almeida et al. 2018), the
Dynamo anti-entropy digest (DeCandia et al. 2007), causal stability and the peer-knowledge
mechanisms that compute it — matrix clocks (Wuu and Bernstein 1984), Bayou (Demers et al. 1994) and
dotted version vectors (Preguiça et al. 2010) — CRDT JSON and Yjs (Kleppmann and Beresford 2017;
Nicolaescu et al. 2016), Byzantine CRDT revocation (Kleppmann 2022) and grace-based reclamation
(Apache Cassandra 2026; Apache Kafka 2026; Git project 2026) is in §4.10. The agent-memory line
(Khan et al. 2025; Margalit et al. 2026; Yu et al. 2026; Du 2026; Cho and Lee 2026; Bhardwaj et al.
2026) is the application framing: shared memory for LLM agents is treated there largely as
retrieval, storage or governance, whereas this work treats it as consistency and reclamation.

## 8. Limitations and open problems

- **Full replication does not scale.** Every node holds every shard and a read folds every
  operation, so per-node storage is O(N·ops): viable for an island of tens of nodes, not for 10,000.
  The forward plan is islands of \~10–100 nodes federated by bridge nodes, replica sets by
  consistent hashing, and a shared snapshot store. Collection itself needs to know which peers hold
  an element; with partial replication that knowledge must come from the placement model rather than
  the whole membership, so the current floor is one retained operation per contested element.
- **Safe collection is the daemon's.** `file` and `s3` share a graph but cannot gate a deletion:
  nothing tells them whether a peer holds a write it has not delivered yet, so they prune only, and
  a physical deletion happens only where the operator declares the directory written by this node
  alone — a promise, not a proof. The §4 result is therefore a property of the peer-to-peer
  deployment.
- **Claimed-but-never-answered nodes** remain conservative blanks with no bound other than a
  membership policy or a forfeiture decision; whether such a node should count as a holder at all is
  a liveness/safety choice we leave open.
- **Assumptions the soundness argument rests on.** (A1) the application invariant of §4.3 — the
  competitor the gate keeps a tombstone for is one authored by a replica that had **folded** the
  element; (A2) benign members — a certificate authenticates *who* a member is, not that its reports
  are true, so a member that understates its frontier or hides a peer can cause a deletion to be
  collected while an operation that should beat it still exists; (A3) the mesh is the only path by
  which a node learns — a node that has left must not keep receiving operations elsewhere (a shared
  area on the same directory, a backup restore, a second mesh); (A4) **coincident independent
  naming** — the guarantee is *causal* revival: a peer that never folded an element may still mint a
  coincident one (the same entity name, an observation on an entity it knows, a relation on
  endpoints it knows) and, if older than a collected tombstone, survive the merge; that is accepted
  as a fresh fact unless the element is kept covered by a retained threshold or the operator
  departs. The suspend rule is the conservative net that covers their violation.
- **Clock skew.** LWW trusts the operation's HLC; a member whose clock is far ahead wins every
  conflict on its elements (bounded on the *observer*, not on the author). A wrong clock is a
  correctness hazard, not a privilege boundary.
- **Drop-in faithfulness.** Content-level observation deletion and duplicate-preserving additions
  are kept for compatibility with the reference server; they are not the model we would choose ab
  initio.

## 9. Conclusion

We presented noonien, a serverless, conflict-free knowledge-graph memory that is a drop-in for the
MCP memory server and converges across machines through per-node shards and an HLC-ordered
LWW-Element-Set, over either a shared area or peer-to-peer anti-entropy. Its contribution is a
**tombstone collection gated on durable knowledge**: by gating per element on a durable per-peer
knowledge frontier — decidable for a peer we have talked to, and kept decidable for one we have not
— it collects at once the elements an away peer never folded, freezes the rest, needs no barrier
over the past, and puts no timer on the data. Bounding the metadata with a **retired frontier** (the
comparison, not its outcome) and a durable **blanket** makes expiry semantically invisible, so the
policy can be on by default and no causal resurrection is possible. The one human decision left is
the peer that is both unreachable and unverifiable, which blocks collection until it is departed; we
state it as the boundary of the liveness rather than hide it. The evaluation on a three-node
deployment confirms propagation and convergence, deterministic same-element merges, and per-element,
barrier-free collection and space reclamation across two off-line windows, with the merge and
collection invariants also covered by property-based tests.

## Appendix A. Reproducing the evaluation

The automated suite is the reproducibility artifact:

``` sh
git clone https://github.com/sequico/server-noonien.git
cd server-noonien && npm install
npm run gate     # Biome + tsc + Vitest (incl. the CRDT and rewrite-safety property tests) + build
```

The three-node evaluation is reproduced by running the daemon and the MCP server from the same build
on each node, with a unique node id, against an empty store; issuing the workloads through the nine
MCP tools; and reading `/graph`, `/shards`, `/peers` and `/metrics`. The off-line experiments
require stopping one node's route to the mesh for the duration of the writes. Configuration
variables and the command-line surface are documented in the project's `README.md`.

## Bibliography

The bibliography is maintained separately, in [`references.bib`](references.bib); the in-text
citations are author–year. Pandoc renders that file into the reference list (see the render command
in the note at the top of this document).
