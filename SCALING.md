# server-noonien — Scaling plan

`README.md` and `PLAN.md` describe the **current** state; this document is the **plan** for taking
the same CRDT from a small island to 1,000 and 10,000 machines without changing the merge semantics.
It restates the concrete values of the building blocks it relies on under
[Prerequisites](#prerequisites), each linked to its full description.

## The cost model

A node = one shard = one file; every node replicates every shard; a read folds every shard and every
operation. Anti-entropy contacts up to the configured fanout — every reachable peer by default —
and, at or above the digest threshold and with a peer that advertises the capability, exchanges a
fixed-size digest instead of the full shard list, so a node's links per round are O(k) and its
per-round metadata O(k) rather than O(N).

| N | Links per node | Read | Per-node storage / RAM |
| --- | --- | --- | --- |
| 100 | k | O(all ops) | all ops |
| 1,000 | k | heavy on every change | all ops |
| 10,000 | k | not viable | not viable |

The bottlenecks at these sizes are (a) **full replication**: every node holds every shard, so
storage and RAM are O(N·ops) per node; (b) a read/refresh that is O(all ops); (c) tombstone
collection that needs an element's full replica set to be known, so it holds inside an island but
not across a federation. Authorization is CN-only.

**Recommendation, up front:** do not run 10,000 machines in one graph. Partition into **islands** of
~10–100 nodes and federate them. The plan scales an island and defines how islands link.

## Prerequisites

The plan builds on these elements of the current design. The concrete values are given here so the
document stands on its own; each links to its full description.

| Prerequisite | Concrete value | Documented in |
| --- | --- | --- |
| HLC ordering | order `(hlc, node, seq)`; stamp `PPPPPPPPPPPPPPP:CCCCCC` (15-digit ms : 6-digit counter); a remote stamp is clamped to at most 60 s of skew | README *How it works* · PLAN *Convergence model (CRDT)* |
| Incremental reads with a memoized fold | a shard is re-decoded only when its fingerprint moves | README *How it works* · PLAN *Storage layout* |
| Online cross-shard compaction | a compare-and-swap rewrite, retried on a lost race | README *Compaction* · PLAN *Storage layout* |
| Per-shard generation and durable high-water mark | the `shard.compact` meta carries `generation` and the durable `seq` | README *Compaction* · PLAN *Storage layout* |
| Snapshot replication | a peer replaces a stale replica when its generation is behind | README *Compaction* · PLAN *Gossip sync — design decisions* |
| `/metrics` and per-shard `/watermark` | `/watermark` is the minimum high-water mark across contactable peers | README *Share across machines* |
| Membership TTL, verified membership, revocation | a dead peer is forgotten after `NOONIEND_MEMBERSHIP_TTL` (default 604800 s); `NOONIEND_REVOKED` refuses a node id | README *Share across machines* · PLAN *Gossip sync — design decisions* |
| Bounded retention of silent peers | after `NOONIEND_FORGET_AFTER` (default 15552000 s — 180 days; `0` = never) a peer is retired into a merged retired frontier, or a durable blanket when it is not accounted for | README *Deletion and collection* · PLAN *Gossip sync — design decisions* |
| Fanout cap with a seeded sampler and opt-in relays | `NOONIEND_FANOUT` (0 = every peer; `> 0` excludes `NOONIEND_GC`, which needs a stable round over the live set); `NOONIEND_RELAY` pins a super-peer | README *Share across machines* · PLAN *Gossip sync — design decisions* |
| Fixed-size shard digest behind the additive `digest` capability | 16 buckets; used at or above `NOONIEND_DIGEST_MIN_SHARDS` (default 32, `0` = whenever supported) | README *Share across machines* · PLAN *Gossip sync — design decisions* |
| Membership channel split | `NOONIEND_CHANNELS` moves membership onto its own channel | README *Share across machines* · PLAN *Gossip sync — design decisions* |

## Partial replication (1,000–10,000)

Full replication on every node stops being viable. It changes *where* data lives, not the CRDT:

- **Replica sets by consistent hashing**: each shard is placed on R nodes (R ≈ 3); a node holds its
  own shard plus a bounded subset. Storage becomes N·ops·R instead of N·ops·N.
- **Snapshot publication.** The per-shard compacted, generation-tagged snapshot of the prerequisites
  is published to a shared store, and a reader starts from the newest snapshots plus pending deltas
  instead of folding every shard.
- **Shared object store with a manifest**: at large N the object store plus an index beats the full
  mesh; the daemon becomes a publisher rather than a universal replicator.
- **Federation of islands**: independent islands (≤ ~100 nodes) linked by a few bridge nodes that
  replicate selected namespaces or snapshots — the practical way to reach 10,000 nodes.

## Tombstone collection at scale

Tombstone collection itself is delivered for a full mesh (see README *Deletion and collection*):
each node prunes the operations a later one shadows and drops a surviving tombstone once no peer off
the mesh could causally contest its element — a peer's durable knowledge frontier must be a subset
of what this node holds (it holds nothing this node lacks) and must cover no operation of the
element (only a peer that folded it is a possible competitor). The metadata that gate needs is
**bounded**: a peer silent beyond `NOONIEND_FORGET_AFTER` is retired into one merged threshold per
author, or a durable blanket, so a full mesh does not grow its durable state without limit. It needs
a **stable round over the live set** (every still-reachable retained peer exchanged with, none
holding anything this node lacks) — which is the liveness a fanout cap would remove. Soundness needs
every replica that *could* hold the element to be known, which the full membership gives — and that
is exactly what does not scale: with partial replication a node does not know which peers hold the
element, so the frontier must come from the **placement model** (replica sets plus node-departure
finalization) instead of the whole membership. Until then the island floor stays one operation per
element.

## Non-goals

- No consensus (Raft/Paxos): the model is AP by choice; linearizable reads are not a requirement.
- No central authority by default: authority is added **only** for control operations (epoch,
  revocation), and those are signed.
- No single CRDT of 10,000 writers: that is a federation of islands, not one graph.
