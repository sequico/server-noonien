# server-noonien — Plan

## Goal

A **local-first, serverless, multi-machine** knowledge-graph memory for AI agents, drop-in
compatible with the official `@modelcontextprotocol/server-memory`, that converges without conflicts
across hosts through pluggable sync backends.

## Problem statement

- The official memory MCP persists to one JSONL file and rewrites the whole file on every mutation.
- Its mutation lock is in-process only, so sharing the file over a synced folder or network mount
  loses writes across processes and hosts — the last write silently discards the others' — and the
  sync tool forks the file into conflict copies instead of merging it.
- The mainstream "shared memory" options require a hosted server/database or a cloud service.

## Non-goals

- Not a vector/semantic memory store (embeddings, RAG). This is an explicit knowledge graph.
- Not a real-time chat backend. Convergence is eventual, not synchronous.
- Not a hosted service. It runs as a local MCP server on each machine.

## Architecture

### Data model
Same as the official server:
- **Entity**: `{ name, entityType, observations[] }`
- **Relation**: `{ from, to, relationType }`
- Observations are strings; relations are `from`/`to`/`relationType` triples. Relations are
  deduplicated; observations behave exactly like the official server (see below).

### Convergence model (CRDT)
Represent every mutation as an operation in an append-only log. The merged state is an
**LWW-Element-Set**:

- `create_entities` / `add_observations` / `create_relations` → additive operations (union).
- `delete_entities` / `delete_observations` / `delete_relations` → tombstones.
- An element (an entity, a relation, one observation occurrence) is present exactly when its
  operation with the greatest `(HLC, node, sequence)` is an add; that total order is the
  last-writer-wins tie-break. An observation delete is content-level, so it removes every occurrence
  whose add is older than it.
- `delete_entities` also tombstones the deleted entity's observations and its incident relations.
- Observations match the official server: `create_entities` preserves duplicate contents as given
  (each occurrence is its own element), `add_observations` adds every requested occurrence that is
  not already present — so duplicate contents within a single request are preserved too — and
  deleting an observation removes every occurrence of that content.

Properties required and tested:
- **Idempotent**: applying the same op twice changes nothing.
- **Commutative**: order of ops across shards does not matter.
- **Associative**: folding shards in any grouping yields the same graph.
- **Convergent**: two nodes with the same op set are byte-identical after fold.

### Storage layout
- Each node owns one shard: `<sync-dir>/<node>.jsonl`. The node id defaults to the hostname and is
  normalized to a safe file stem **injectively** — a label that had to be replaced gains a digest of
  the original — so two different labels can never collapse onto one shard. Normal writes only
  append to it; compaction is the one rewrite, and it is atomic (a temporary file renamed over the
  shard on the `file` backend, a conditional write on `s3`), so a crash midway cannot truncate it.
- A shard is **single-writer**: exactly one author per node id. The `file` backend serializes
  `append` and `replace` through a per-shard lock and `s3` through conditional writes, so the
  writers — the server, the online compaction, the `nooniend` daemon recovering the own shard —
  never race or drop a write; a compaction that loses the compare-and-swap re-reads and retries.
  `noonien import` authors its own `<node>-import` shard, so it runs online too — and it is pruned
  on each import and by `noonien compact`: it only ever adds, so pruning it needs no knowledge and
  can lose nothing.
- Reads fold all shards; normal writes append only to the local shard. Reading is **incremental**:
  each shard is decoded once and cached against a cheap fingerprint (mtime + inode, a version
  counter, or an object ETag), so a read re-parses only the shards that changed and the folded graph
  is memoized — an unchanged read costs one fingerprint poll per shard. A malformed shard line is
  skipped and reported once per read with how many lines it covered, so a concurrent append never
  fails a whole read and corruption is visible without flooding stderr.
- **Compaction** — online and via `noonien compact`: rewrite a node's shard keeping, per element,
  only the operations no later one shadows, as a compare-and-swap that re-reads and retries on a
  conflict. Each compaction stamps a `shard.compact` metadata operation (never a graph element)
  whose `generation` is bumped every time and whose `seq` is the durable high-water mark, so the
  sequence never regresses and a compaction is never mistaken for a lost shard. Peers read the
  generation from `/shards` and replace a stale replica with the compacted shard. Only the local
  shard is touched.

### Sync backends (pluggable)
`NOONIEN_BACKEND` selects one of three backends — `file`, `s3` or `memory`. The `file` and `s3`
backends converge through a **shared area** — a replicated directory or a shared bucket; noonien
merges the shards, it does not move them. The `gossip` transport is **not** a backend: it is the
companion daemon **`nooniend`**, which removes the shared-area requirement by replicating the
shards peer to peer, needing only IP reachability.
- `file` — any directory; pairs with Syncthing / Dropbox / git / a shared mount. No server.
- `s3` — S3-compatible object storage (AWS S3, R2, Contabo, MinIO): one object per shard, written
  with versioned conditional writes that are retried on contention.
- `memory` — volatile, in-process; for tests and throwaway sessions.

### Gossip sync — `nooniend`

A companion daemon that replicates the shard directory **peer to peer**, so `server-noonien` keeps the
`file` backend on a local directory with a full replica and needs no shared area. It is the
project's headline feature: [`README.md`](README.md) documents how to run and configure it; this
section records the design decisions and the reasons for them.

The transport is **underlay-agnostic**: it only needs IP reachability between peers, so it runs over
any VPN (WireGuard, Tailscale, OpenVPN, Netbird, ZeroTier, ...) or a plain LAN, with no dependency
on a specific provider.

#### Design decisions

- **Wire: HTTP/JSON with a JSON Lines operations stream** — a standard, observable transport
  (curl/log/proxy/TLS, status codes) with no dependency; NDJSON streams a shard's operations without
  buffering. A framed TCP protocol would only pay off at far higher volumes and would mean owning
  framing, timeouts and reconnection for no gain here; if it is ever needed, only the payload
  changes, not the protocol. The wire carries a protocol revision (currently `1`) in `/info`, so an
  incompatible peer is caught on the first exchange; list responses are capped at 10 000 entries and
  the digest at 16 buckets.
- **Authentication: mTLS with per-peer certificates** — the transport is underlay-agnostic, so
  authorization cannot be borrowed from a mesh identity; mTLS authenticates each peer and maps the
  certificate's common name to a node id, so a peer may only push the shard it authors while reads
  stay open to any authenticated peer — which is what lets a node relay. A VPN's own encryption is
  welcome but not relied on. Without TLS the daemon trusts the underlay.
- **Bind `0.0.0.0:PORT` (configurable), limited by the host firewall / the VPN** — portable across
  any underlay; the exposure is contained by the firewall, as on the hosts today.
- **No consensus; eventual delivery only** — operations are idempotent and the fold is commutative,
  so anti-entropy needs no ordering and no coordinator, only that the deltas eventually arrive.
- **Repair and relay** — a node whose own shard is lost or truncated recovers it from any peer's
  replica, re-appending operations that already belong to it; a node serves every replica it holds,
  so an offline peer keeps converging through any online one.
- **Compaction generation and snapshot replacement** — the owner bumps a per-shard generation on
  every compaction, announced in `/shards`; a peer that sees a newer generation replaces its replica
  with the compacted shard (a snapshot, then deltas), so replicas converge to the compacted content
  and the high-water mark stays unambiguous for recovery.
- **Efficiency: delta transfer by `seq`, indexed per shard** — each shard is decoded once into an id
  index and high-water mark, refreshed only when the file changes and advanced in place when the
  daemon appends, so a merge never re-reads what it just wrote; a push larger than a batch is split
  into bounded requests and a served delta is written in few buffered chunks; the MCP server always
  reads locally, so no tool call touches the network.
- **Adaptive topology, gated by size** — a small mesh keeps the full mesh: the daemon contacts every
  peer by default. Above `NOONIEND_FANOUT` it samples a random subset each round (the RNG is seeded
  from the node id, so it is deterministic when the mesh is within the fanout), which holds links
  and metadata at O(N·k) while convergence stays epidemic; a node in `NOONIEND_RELAY` is always
  sampled, so an operator can pin a super-peer. Liveness and the stable watermark stay correct under
  a cap: liveness comes from the exchanges actually made, and a per-shard watermark keeps each
  peer's last observed high-water mark across rounds, so it is a conservative lower bound rather
  than a single-round one.
- **Digest at or above a threshold, with the full list below it** — at or above
  `NOONIEND_DIGEST_MIN_SHARDS` the daemon exchanges a fixed-size digest (a Merkle root over 16
  buckets of `node → (maxSeq, generation)`) and fetches only the differing buckets, so per-round
  metadata is O(buckets) rather than one summary per shard; below it the plain list is cheaper and
  is used. The `digest` capability in `/info` is additive, so a peer without it keeps the plain list
  and a mixed mesh never breaks. `NOONIEND_CHANNELS` can move membership onto its own channel, so
  the full peer list is not piggybacked on every data exchange.
- **Membership as a gossiped CRDT; no SWIM, Consul, etcd or mDNS** — the live peer set is an LWW-set
  propagated over the same channel with suspect/timeout liveness and an inbound rule — a peer that
  reaches us is alive at once (a recovered peer is re-engaged without waiting out its retry
  backoff), and a joiner we do not know is adopted from the address it announces, so a single seed
  suffices for the membership to converge in both directions: no external dependency, it fits the
  CRDT model and works on any underlay. SWIM's canonical implementation is Go (a sidecar) and the
  Node options are immature, so it would put an unmaintained component on the critical path for a
  benefit that only shows on large, dynamic clusters; Consul/etcd reintroduce a central server,
  which the project rejects; mDNS is LAN-only and does not cross the mesh.
- **Verified entries** — an entry learned from a node's own `/info` (or an operator seed) is
  authoritative and cannot be overridden by gossip; an address that serves a different node than the
  entry claims is dropped.
- **Physical deletion as a per-element, knowledge-gated collection** — a delete is a tombstone, so
  the log keeps it unless something removes it, and removing it while a concurrent add that folded
  the element still exists would revive it. `nooniend` prunes the shadowed operations of the shard
  it authors, then drops a surviving tombstone once no peer off the mesh could causally contest its
  element. Two conditions gate it per peer: the peer's durable knowledge frontier (persisted per
  peer in `.nooniend-peers.json`) must be a subset of what this node already holds — a peer holding
  any operation this node lacks could hold a relayed operation on the element — and it must cover no
  operation of the element, so only a peer that folded it is a possible competitor; a peer that
  never folded it can still mint a coincident element, which the fold decides as a concurrent
  genesis. An element that appeared while a peer was away is collectable at once; one the peer knew
  stays frozen until it returns or is departed. The evidence the gate reads is the operation the
  peer knew, which may be on another node's shard (a delete by one node of an element another
  created), so the node that authored it keeps it too: no node prunes a shadowed operation on an
  element a retained off-mesh peer's frontier covers. A peer still reachable but not exchanged with
  suspends collection, and a suspended round drops nothing at all — neither a tombstone nor the
  operation that proves a peer knew the element; forgetting a peer (the membership TTL) does not
  unblock it, but `NOONIEND_REVOKED` and `NOONIEND_DEPARTED` do. Single-node needs no gate, so it
  collects immediately — the official server's physical deletion, without giving up convergence in a
  mesh. Without the daemon collection needs the operator's promise (`NOONIEN_GC`: this directory is
  written by this node alone) and a directory that proves it — a peer that is absent or not yet
  synced leaves no trace — so the server's online maintenance and `noonien compact` prune only
  until it is declared, and refuse when the declaration is contradicted by another node's shard.
  Where a daemon owns the directory it holds the peer knowledge and collects, so it is the only
  writer that maintains the shard: the server and `noonien compact` keep their whole view there,
  because a shadowed operation is the evidence the daemon's gate reads. The daemon replicates a
  **directory**, so a non-`file` `NOONIEN_BACKEND` is refused. How long each peer has been away and
  how many elements stay frozen are exposed as metrics.
- **Bootstrap adapters: static seed, DNS SRV and Tailscale** — a static list always works; DNS SRV
  is the most provider-neutral discovery where a zone exists; Tailscale needs no configuration on
  that mesh. Adapters propose **candidates** and are re-read on a timer; a candidate joins the mesh
  only once it answers `/info`, so a device that does not run the daemon is never adopted. Adding
  Netbird, ZeroTier or Kubernetes later is local.
- **Bounded retention: retire a silent peer without weakening the gate** — the durable metadata a
  collection depends on grows with the peers that vanish, and the peers gone the longest are exactly
  the ones that must be remembered. After `NOONIEND_FORGET_AFTER` (default 180 days) a peer is
  **retired**, which moves *where* the protection lives and never *which* elements are guarded: an
  **accounted** peer (its frontier is a subset of what this node holds) is merged into a durable
  **retired frontier**, one elementwise maximum per author, which is exactly the union of the
  per-element decisions it and its fellow retirees would have made — over one map bounded by the
  shards this node holds, not one map per peer; an **unaccounted** peer leaves a durable
  **blanket**, the same "it could hold anything" that gated it while it was live. Nothing is
  forfeited by retiring, so the window can be on by default and `NOONIEND_REVOKED`/`_DEPARTED` stay
  the only forfeiture (a maximum cannot be un-merged, so a node must be departed before its window
  expires). Two details make it sound: the *comparison* is kept rather than the elements it once
  covered — a per-element pin computed at expiry would miss a tombstone created **after** the expiry
  — and a frontier that claims an author this node cannot serve is never recorded, so a peer cannot
  freeze the mesh with a claim it cannot back. A claimed node that was never reached keeps blocking
  conservatively, as before. What remains of liveness is stated too: collection needs a **stable
  round over the live set** — every still-reachable retained peer exchanged with, none holding
  anything this node lacks — while over the peer history it needs no barrier, which is exactly what
  the durable frontier buys. A `NOONIEND_FANOUT` cap excludes `NOONIEND_GC` for that reason. And
  the one place a human decision remains is stated too: a peer that is both unreachable and
  unverifiable blocks collection until the operator departs it, so the window bounds metadata
  without removing the decision.

## Tool surface (drop-in)
| Tool | Kind |
| --- | --- |
| `create_entities` | additive |
| `add_observations` | additive |
| `create_relations` | additive |
| `delete_entities` | tombstone |
| `delete_observations` | tombstone |
| `delete_relations` | tombstone |
| `read_graph` | read |
| `search_nodes` | read |
| `open_nodes` | read |

The full graph is also served at the `memory://knowledge-graph` resource: on the 2025-era protocol a
client subscribes with `resources/subscribe` and receives `notifications/resources/updated` after
every mutation; on the 2026-07-28 revision it opens a `subscriptions/listen` stream instead. The
server speaks both.

## CLI
The package ships three commands. `server-noonien` is the MCP server — with no argument (or `serve`)
it serves over stdio, so the package name and the client entry are the same. The maintenance CLI is
`noonien`, and the replication daemon is `nooniend`.
- `server-noonien` / `server-noonien serve` — run the MCP server over stdio.
- `noonien import <memory.jsonl>` — migrate an existing official-server graph (writes its own
  `<node>-import` shard, so it runs online; the shard is pruned by `import` and by `compact` — it
  only ever adds, so it needs neither the peer knowledge nor the promise).
- `noonien export` — dump the folded graph.
- `noonien merge` — fold every shard and report the merged state.
- `noonien compact` — maintain the local shard now: prune the shadowed operations and, when safe,
  physically delete its tombstones (the server runs the same maintenance online); where a daemon
  owns the directory it keeps the whole view and leaves the shard to the daemon.
- `noonien query <text>` — search entities and print the matching subgraph.
- `noonien help` — list the commands; `--version` prints the version.

`nooniend` is the peer-to-peer replication daemon; it takes no arguments and is configured entirely
through environment variables: the shared `NOONIEN_DIR` and `NOONIEN_NODE_ID` plus the daemon's
`NOONIEND_*`.

## Distribution
- Language: **TypeScript** (the `@modelcontextprotocol/server` SDK); the npm package `server-noonien`
  runs via `npx server-noonien` (published on the public npm registry) and ships three commands:
  `server-noonien` (the MCP server), `noonien` (the CLI) and `nooniend` (the replication daemon).
- S3 support is the only optional dependency (`@aws-sdk/client-s3`), loaded lazily.
- License: MPL 2.0.

## Testing
- Property-based tests for the CRDT laws (idempotence, commutativity, associativity, convergence),
  and that compaction preserves the merged graph.
- Unit tests for the fold, the shard log and the nine operations, including the incremental shard
  cache, HLC ordering, cross-shard compaction and the case where a peer recovers the local shard
  while the server is running.
- Integration tests that drive the real serving entry (`serveStdio`) over an in-memory transport and
  assert the nine-tool contract, including the official outputs and messages.
- Migration round-trip from an official `memory.jsonl`.
- Gossip: unit tests for the replica store, membership, bootstrap, configuration (including the
  membership TTL forget and the revocation list), the seeded sampler and the shard digest; a
  property test that reconciliation converges from any generated set of shards — including when only
  a subset of pairs reconciles each round; the digest path converges and falls back to the list for
  a peer without the capability; a newer compaction generation replaces a stale replica, and
  propagates through a fanout-capped mesh within a round budget; integration tests over the real
  HTTP service — the digest, ops, health, peers, status, graph, metrics and watermark routes — and
  over TLS with per-peer certificates.

## Documentation

`README.md` and `PLAN.md` are the project's current-state documentation: they describe how things
are now — no history, no before/after, no changelog — and are revised alongside the code
(`CHANGELOG.md` is the one historical artifact, kept concise by hand: one line per release):

- **README.md** — the user-facing guide: what server-noonien is, the problem it solves and how it is
  solved; the three commands and how to run each; sharing across machines (peer to peer or a shared
  area); the `NOONIEN_*` and `NOONIEND_*` configuration tables; how the CRDT and compaction work;
  drop-in compatibility; security.
- **PLAN.md** — this document: the architecture, the gossip design decisions and their rationale,
  the tool surface, the CLI, distribution, testing and the current state.
- **SCALING.md** — a forward-looking plan (not current state): the partial-replication model for
  1,000 / 10,000 nodes, built on the foundations listed there.

## Current state

- **Core CRDT and the `file` backend** — an append-only operation log, the fold, and the nine
  drop-in tools over stdio.
- **Maintenance CLI** (`noonien`) — `serve`, `import`, `export`, `merge`, `compact`, `query`,
  `help`; `import` migrates an official `memory.jsonl`.
- **S3 backend** — shards as objects written with versioned conditional writes that are retried on
  contention, verified against an S3-compatible store.
- **Compaction** — online in the server and by hand via `noonien compact`, preserving the merged
  graph.
- **Collection without a daemon** — the server's online maintenance and `noonien compact` share one
  decision: keep the tombstones and prune the shadowed operations, unless the operator declares the
  directory written by this node alone (`NOONIEN_GC`, default off) and no other node's shard
  contradicts it; where a daemon owns the directory it is the only writer that maintains the shard,
  and they keep their whole view instead, because a shadowed operation is the evidence the daemon's
  gate reads. The daemon's `NOONIEND_GC` (default on) is the gated collection, and `nooniend`
  refuses a non-`file` `NOONIEN_BACKEND`.
- **Peer-to-peer sync** (`nooniend`) — the daemon replicates the shards directly between nodes over
  any IP-reachable underlay, with no shared area, over HTTP/JSON with optional mTLS, static/DNS-SRV/
  Tailscale bootstrap and a gossiped peer set.
- **Scaling foundations and adaptive topology** — HLC ordering, incremental reads with a memoized
  fold, cross-shard compaction, the daemon `/health`, `/peers`, `/status`, `/graph`, `/metrics` and
  `/watermark`, membership TTL and node revocation, the bounded retention of silent peers (a retired
  frontier plus durable blankets); fanout-capped peer sampling with a seeded RNG and opt-in relays;
  a fixed-size shard digest above a threshold behind an additive `/info` capability; a membership
  channel split; and a stable watermark kept conservative across rounds. The scaling plan (partial
  replication) is in `SCALING.md`.
- **Packaging** — npm metadata and three commands (`server-noonien`, `noonien`, `nooniend`) on the
  public npm registry; CI (Node 22/24/26) runs the gate and verifies the packed tarball; releases
  are automated with **release-please** and **Trusted Publishing** — a single manual trigger opens
  and merges the Release PR, tags the version and publishes to npm, and ordinary pushes run CI only.
