# server-noonien

[![CI](https://github.com/sequico/server-noonien/actions/workflows/ci.yml/badge.svg)](https://github.com/sequico/server-noonien/actions/workflows/ci.yml)
[![CodeQL](https://github.com/sequico/server-noonien/actions/workflows/codeql.yml/badge.svg)](https://github.com/sequico/server-noonien/actions/workflows/codeql.yml)
[![npm
version](https://img.shields.io/npm/v/server-noonien.svg)](https://www.npmjs.com/package/server-noonien)
[![License: MPL 2.0](https://img.shields.io/badge/license-MPL--2.0-blue.svg)](LICENSE) [![Node ≥
22](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](https://nodejs.org)

**Shared, serverless, conflict-free memory for AI agents — with peer-to-peer sync.**

`server-noonien` is a drop-in replacement for the official
[`@modelcontextprotocol/server-memory`](https://github.com/modelcontextprotocol/servers/tree/main/src/memory)
knowledge graph — the same entities, observations and relations — that **converges across machines**
with no central server, no database and no merge conflicts.

Its headline feature is **peer-to-peer sync**: the `nooniend` daemon replicates each node's shard
directly to the others, so several machines share one memory with **no shared folder** — only IP
reachability over a VPN or a LAN.

## Table of contents

- [Why server-noonien](#why-server-noonien)
  - [The problem](#the-problem)
  - [How server-noonien solves it](#how-server-noonien-solves-it)
- [The three commands](#the-three-commands)
- [Share across machines](#share-across-machines)
  - [Peer to peer — `nooniend` (recommended)](#peer-to-peer--nooniend-recommended)
    - [The daemon HTTP API](#the-daemon-http-api)
  - [Shared area — `file` and `s3`](#shared-area--file-and-s3)
- [Configuration](#configuration)
  - [Shared variables](#shared-variables)
  - [Server variables](#server-variables)
  - [Daemon variables](#daemon-variables)
- [How it works](#how-it-works)
  - [Compaction](#compaction)
  - [Deletion and collection](#deletion-and-collection)
- [Drop-in compatibility](#drop-in-compatibility)
- [Security](#security)
- [Development](#development)
- [Why the name `noonien`?](#why-the-name-noonien)
- [Documentation](#documentation)
- [License & Disclaimer](#license--disclaimer)
  - [Support the Project](#-support-the-project-passive-monetization)

## Why server-noonien

### The problem

Agent memory today is local, and the official memory server is a single JSONL file that every
mutation reads and rewrites in full. That breaks the moment you have more than one machine:

- **It lives on one host.** Switch machine and your agent has forgotten everything.
- **Sharing it over a synced folder loses writes.** The server serializes mutations *in-process
  only*: two hosts each load the whole graph, mutate their own copy and write it back, so the last
  write silently discards the other's — and the sync tool forks the file into conflict copies
  instead of merging it.
- **The alternatives want a server, a database or a cloud.** The mainstream "shared memory" products
  are something you have to host, or they ship your memory off your machines.

### How server-noonien solves it

`server-noonien` removes the shared file and the central server at the root, and keeps the drop-in
tool surface:

- **Every node keeps its own memory.** Each machine writes only its own append-only shard
  (`<node>.jsonl`); a shard has a single writer by design, so no two nodes ever write the same file
  and noonien itself never forks one — a shared area's syncer still can, and a conflict copy is
  just another shard to fold.
- **Shards merge, they do not overwrite.** The graph is a CRDT — an **LWW-Element-Set** ordered by
  `(HLC, node, sequence)` — whose merge is idempotent, commutative, associative and convergent. Any
  two machines that have seen the same operations hold the **identical** graph, in any order, so
  there is no "last write wins" data loss.
- **No shared area, no central server.** The shards travel **directly between machines** with the
  `nooniend` daemon — only IP reachability, over a VPN or a LAN — so several machines share one
  memory with **no shared folder** and **no service to host**. Prefer a folder or a bucket you
  already have? `file` and `s3` work too: the transport is a choice, not a lock-in.
- **Local-first and offline-friendly.** Every node reads and writes its own shard on disk and keeps
  a full local replica, so it keeps working offline; the mesh reconverges when the network returns.
- **Drop-in for the official server.** The same nine tools, inputs and outputs, so it slots under
  the `memory` server name with no agent changes.

## The three commands

One npm package, **`server-noonien`**, ships **three commands** (Node.js **≥ 22**). Install it once
and all three land on your `PATH`:

```sh
npm install -g server-noonien
```

| Command | Role | How it runs |
| --- | --- | --- |
| **`server-noonien`** | the MCP memory server | short-lived, **spawned by the MCP client** over stdio |
| **`noonien`** | the maintenance CLI | **one-shot**, run by hand |
| **`nooniend`** | the peer-to-peer replication daemon | **long-lived**, one per machine |

Only `server-noonien` matches the package name, so it is the only command `npx` can run by package
name. Run the other two with `--package`, or from the global install above:

```sh
npx -y server-noonien                       # the MCP server (no argument serves over stdio)
npx -y -p server-noonien noonien help       # the maintenance CLI
npx -y -p server-noonien nooniend           # the replication daemon
```

From a clone — for development, or to run code not yet on npm:

```sh
git clone https://github.com/sequico/server-noonien.git
cd server-noonien && npm install && npm run build

node dist/index.js      # server-noonien — the MCP server
node dist/noonien.js   # noonien    — the maintenance CLI
node dist/gossip.js     # nooniend   — the replication daemon
```

### `server-noonien` — the MCP server

The entry every MCP client uses. With **no argument** (or `serve`) it speaks MCP over **stdio**, so
you don't run it yourself — the client spawns it and it lives for the session. Point your client at
it; it works on one machine out of the box, and [sharing across machines](#share-across-machines) is
the next step. In OpenCode (V2):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "memory": {
        "type": "local",
        "command": ["npx", "-y", "server-noonien"],
        "environment": { "NOONIEN_DIR": "~/.noonien" }
      }
    }
  }
}
```

Other clients wrap the same command and environment in their own envelope; from a clone the command
is `["node", "/path/to/server-noonien/dist/index.js"]`. Because the tool surface is identical, you can
replace the `memory` server entry with `server-noonien` and change nothing else.

### `noonien` — the maintenance CLI

| Command | Does |
| --- | --- |
| `noonien serve` | run the MCP memory server over stdio (the same as `server-noonien`) |
| `noonien import <file>` | import an official `server-memory` JSONL file (writes its own `<node>-import` shard, so it runs online) |
| `noonien export` | print the folded knowledge graph as JSON |
| `noonien merge` | fold every shard and report the merged state |
| `noonien compact` | maintain this node's shard now: prune shadowed operations and, only where it is safe, physically delete its tombstones — the same rule the server applies (`NOONIEN_GC`; with a daemon that owns the directory it keeps the whole view and leaves the shard to the daemon) — and report why when it keeps them |
| `noonien query <text>` | search entities and print the matching subgraph |
| `noonien help` | list the commands; `noonien --version` prints the version |

### `nooniend` — the daemon

A long-lived service, **one per machine**, that replicates the shard directory peer to peer. It
takes no arguments and is configured entirely through environment variables — the shared
`NOONIEN_DIR` and `NOONIEN_NODE_ID` ([Shared variables](#shared-variables)) plus the daemon's
`NOONIEND_*` ([Daemon variables](#daemon-variables)). See [Peer to
peer](#peer-to-peer--nooniend-recommended) for the setup.

## Share across machines

`noonien` merges shards; it does not move them by itself. How the shards travel between machines is
your choice: **peer to peer** (a companion daemon — the recommended default) or a **shared area** (a
folder or a bucket that already exists). The MCP server always reads and writes its own local shard;
only the transport differs.

### Peer to peer — `nooniend` (recommended)

**The recommended way to share one memory across machines with no shared storage.** `nooniend` is a
long-lived daemon that replicates the local shard directory **peer to peer**. It only needs IP
reachability, so it runs over any VPN (WireGuard, Tailscale, OpenVPN, Netbird, ZeroTier, …) or a
plain LAN.

Give each machine a **unique** node id and run one `nooniend` per machine. Every daemon keeps a
full replica of the others' shards beside its own, in the same local directory the MCP server uses —
no shared folder required:

```sh
# on a tailnet
NOONIEN_DIR=~/.noonien \
NOONIEND_TAILSCALE=true \
nooniend

# or, with no self-listing underlay, seed one reachable peer
NOONIEN_DIR=~/.noonien \
NOONIEND_PEERS=ai.example:7878 \
nooniend
```

The peers **find each other** — you never list the machines. Configure **one** discovery source:
`NOONIEND_TAILSCALE` (from `tailscale status`), `NOONIEND_DNS_SRV` (the `_nooniend._tcp` SRV
records), or `NOONIEND_PEERS` (a static seed; one is enough, membership then self-propagates).
`NOONIEND_ADVERTISE` is optional and defaults to the listen host.

How it behaves:

- **Never authors operations.** Each node's MCP server writes only its own `<node>.jsonl`; the
  daemon keeps replicas of the peers' shards and only ever pushes the shard it authors, so the
  single-writer rule holds. It also restores the local shard from a peer's replica when the local
  copy is behind.
- **Push on change + periodic anti-entropy.** On a local change (`NOONIEND_PUSH`) and every
  `NOONIEND_INTERVAL` seconds it compares the per-shard high-water `seq` and moves the delta in
  whichever direction is behind. Operations are idempotent, so delivery may be best-effort — no
  consensus, no ordering, only eventual completeness.
- **Scales past a full mesh.** By default it contacts **every** peer; `NOONIEND_FANOUT` caps that
  to a random subset per round — which **excludes tombstone collection**, because a reachable peer
  the round did not sample suspends it, so the daemon refuses that combination — and at or above
  `NOONIEND_DIGEST_MIN_SHARDS` it reconciles through a fixed-size digest instead of the full shard
  list (with `NOONIEND_CHANNELS` moving membership onto its own channel). A small mesh keeps
  behaving exactly like a full mesh, and a peer without the digest capability falls back to the
  plain list, so a mixed mesh never breaks.
- **Relays.** A node serves every replica it holds, so an offline node keeps converging through any
  peer that has its shard.
- **Discovery and membership.** Bootstrap adapters (Tailscale, DNS SRV, a static seed) return an
  initial list; the peer set then gossips itself. Liveness comes from the exchange results — suspect
  after `NOONIEND_SUSPECT_AFTER` failures, dead after `NOONIEND_DEAD_AFTER`, retried after
  `NOONIEND_DEAD_RETRY`, and forgotten after `NOONIEND_MEMBERSHIP_TTL`. A peer that reaches this
  node is marked alive — its certificate names it under mTLS, otherwise the id it announces on the
  request — so a peer that recovers is re-engaged at once instead of waiting out
  `NOONIEND_DEAD_RETRY`. A peer this node does not know yet is adopted from the address it
  announces on the request (untrusted, like a gossiped entry, and confirmed by the next sync), so a
  statically-seeded joiner is discovered by the seeds it reached and its entry then spreads to the
  rest. A node's own entry is authoritative; an address that serves a different node is dropped.
- **Wire and security.** A small HTTP/JSON service bound to `NOONIEND_LISTEN` (the full route list
  is [below](#the-daemon-http-api)); a shard accepts only its own node's operations. mTLS with
  per-peer certificates: the certificate's **common name is the node id**, so a peer may only push
  the shard it authors, while reads stay open to any authenticated peer — which is what lets a node
  relay. `NOONIEND_REVOKED` refuses specific nodes on every route; `NOONIEND_DEPARTED`
  additionally discards a departed node's replica and lets collection proceed past it.
- **Observability.** Prometheus metrics — liveness, peer health, the stable watermark and, for
  collection, how long each peer has been away (`noonien_gossip_absent_seconds`) and how many
  deleted elements are frozen (`noonien_gossip_frozen_elements`) — plus a per-shard stable
  watermark (the minimum high-water mark reached on every contactable peer, a conservative
  causal-stability bound), and status and graph routes for probes and operators — see [The daemon
  HTTP API](#the-daemon-http-api).

Under systemd, a user unit:

```ini
[Unit]
Description=nooniend — peer-to-peer shard replication
After=network-online.target

[Service]
EnvironmentFile=%h/.config/noonien/nooniend.env
ExecStart=%h/.local/bin/nooniend
Restart=on-failure

[Install]
WantedBy=default.target
```

### The daemon HTTP API

`nooniend` serves a small HTTP/JSON API on `NOONIEND_LISTEN` (default `0.0.0.0:7878`). Every route
is read-only except the operations push, whose body is capped at 64 MiB. Without TLS the routes are
unauthenticated; with mTLS they all require a client certificate whose common name is the peer's
node id, and a push is accepted only for the shard the certificate names.

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/health` | Liveness: `{"status":"ok"}`. |
| `GET` | `/info` | This node's entry (`node`, `address`, `version`), the protocol revision and the advertised capabilities (`digest`). |
| `GET` | `/peers` | The peer set with each peer's live health: `{"peers":[{"node","address","version","health"}]}`, `health` one of `alive`, `suspect`, `dead`. |
| `GET` | `/membership` | The peer set without health — the payload nodes gossip. |
| `GET` | `/status` | One-glance summary: `{"node","version","protocol","uptimeSec","shards","peers":{"total","alive","suspect","dead"}}`; the peer counts exclude the local node. |
| `GET` | `/graph` | The whole knowledge graph `{"entities","relations"}`, folded from the replicas on disk. |
| `GET` | `/shards` | Per-shard summaries: `{"shards":[{"node","count","maxSeq","generation"}]}`. |
| `GET` | `/shards/digest` | The shard digest `{"root","buckets":[{"index","hash","count"}]}`; with `?buckets=1,3,5`, just those buckets' summaries as `{"shards":[…]}`. |
| `GET` | `/shards/{node}/ops?after=N` | `{node}`'s operations after sequence `N`, as NDJSON. |
| `POST` | `/shards/{node}/ops` | Append operations to `{node}`'s replica (NDJSON body); accepts only operations authored by `{node}`. |
| `GET` | `/metrics` | Prometheus metrics. |
| `GET` | `/watermark` | Per-shard stable high-water mark across the contactable peers. |

The wire carries a protocol revision (`1`, in `/info` and `/status`): the first exchange validates
it, and a peer that answers a different revision fails the exchange rather than being misread. A
list (`/membership`, `/shards`) is capped at 10 000 entries and the shard digest at 16 buckets, so a
single response cannot force unbounded state from a peer.

```sh
curl -s http://127.0.0.1:7878/health
curl -s http://127.0.0.1:7878/status
curl -s http://127.0.0.1:7878/peers
curl -s http://127.0.0.1:7878/graph | jq '{entities: (.entities|length), relations: (.relations|length)}'
```

### Shared area — `file` and `s3`

The `file` and `s3` backends converge through a **shared area** that already exists and is
replicated outside noonien — a folder or a bucket every node can reach. Point every node at the
*same* area and each node's shard reaches the others:

```sh
NOONIEN_BACKEND=file NOONIEN_DIR=/srv/noonien-shared NOONIEN_NODE_ID=ai server-noonien
# or
NOONIEN_BACKEND=s3 NOONIEN_S3_BUCKET=my-bucket NOONIEN_NODE_ID=ai server-noonien
```

- **`file`** — shards are `*.jsonl` files in `NOONIEN_DIR`; point it at a folder replicated by
  Syncthing, Dropbox, a git working tree or a shared mount.
- **`s3`** — one object per shard, written with conditional writes retried on contention; uses
  `@aws-sdk/client-s3` (an optional dependency, loaded only when selected). Conditional writes need
  a store that honours `If-Match`/`If-None-Match` on `PutObject` (AWS S3, Cloudflare R2, MinIO do);
  a store that ignores them is not supported, and a shard object with a multipart ETag is refused
  rather than guarded by a token that can never match. An object store has no append, so **every
  mutation rewrites the whole shard object** (read-modify-write): correct, but O(shard size) per
  write.

The **`memory`** backend keeps shards in process only — for tests and throwaway sessions. See
[Configuration](#server-variables) for the variables.

**What a shared area does not give you: a safe deletion.** `file`/`s3` share a graph; they cannot
say whether a peer holds a write it has not delivered yet. So without a daemon the maintenance
**prunes only**, and a physical deletion happens only where the operator declares the directory
written by this node alone (`NOONIEN_GC`) — see [Deletion and
collection](#deletion-and-collection). Convergence is delegated to the syncer as well: noonien
neither verifies nor retransmits, so latency and conflict copies are the syncer's business, and a
conflict copy is just another shard to fold. And the daemon replicates a **directory**: `nooniend`
refuses to run with `NOONIEN_BACKEND=s3` (or `memory`), where it would replicate a local folder the
server never uses.

## Configuration

Every setting is read from the environment. `NOONIEN_DIR` and `NOONIEN_NODE_ID` are shared; the
MCP server, the CLI and the daemon otherwise have their own variables — `NOONIEN_*` for the server,
`NOONIEND_*` for the daemon.

### Shared variables

Used by every command.

| Variable | Default | Meaning |
| --- | --- | --- |
| `NOONIEN_NODE_ID` | hostname | This node's shard name — the identity the MCP server writes under and the daemon replicates. Must be **unique per machine** and written by a **single server at a time**. |
| `NOONIEN_DIR` | `~/.noonien` | Directory holding this machine's shards: the `file` backend's store and the daemon's replica store. A leading `~` is expanded. |

These two are **local to each machine**, not a shared area: the MCP server and the daemon share the
same directory *on the same host*, and every machine keeps its **own** copy of every shard.
Peer-to-peer sync with `nooniend` needs **no shared folder or bucket**; a shared area is only the
alternative transport for `file`/`s3`.

A node id is a **single-writer shard**: exactly one server process should append to it at a time.
The normal setup is one memory server per machine; if you run several servers against the same store
concurrently, give each its own `NOONIEN_NODE_ID`. The tool does not enforce this: two writers that
share a node id and write in the same millisecond produce operations with the same id, which a read
**fails loudly** on — but writers on different clocks usually land on different ids, so the shard
can quietly interleave and the fold picks one. A unique node id is a requirement, not something the
tool can check.

### Server variables

Used by the MCP server (and the `noonien` CLI, which reads and writes the same shards).

| Variable | Default | Meaning |
| --- | --- | --- |
| `NOONIEN_BACKEND` | `file` | `file`, `memory` or `s3`. |
| `NOONIEN_S3_BUCKET` | — | Bucket (required for the s3 backend). |
| `NOONIEN_S3_PREFIX` | `""` | Key prefix all shard objects live under. |
| `NOONIEN_S3_REGION` | `us-east-1` | Region passed to the S3 client. |
| `NOONIEN_S3_ENDPOINT` | — | Custom endpoint for MinIO / R2 / Contabo and similar. |
| `NOONIEN_S3_FORCE_PATH_STYLE` | on when an endpoint is set | Path-style requests. |
| `NOONIEN_COMPACT_AFTER` | `1000` | Compact the local shard online after this many appended operations (`0` disables). |
| `NOONIEN_GC` | off | Delete tombstones **without a daemon**: only where this node is the directory's only writer — a promise nothing in the directory can prove. Where a daemon owns the directory (it announces itself with its knowledge file from startup) it has no effect: the daemon collects. |

`NOONIEN_GC` (server, default off) and the daemon's `NOONIEND_GC` (default on) are different
switches; with the `memory` backend nothing is shared, so the server collects regardless of
`NOONIEN_GC`.

S3 credentials come from the standard AWS chain (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_REGION`, profiles, instance roles, …).

The local shard is compacted **online**: the server rewrites its own shard after
`NOONIEN_COMPACT_AFTER` appended operations (default `1000`, `0` disables), inside the same
mutation queue as the writes. The rewrite is a compare-and-swap against the content it read, and a
concurrent write — an append, or the `nooniend` daemon recovering the shard — makes it re-read and
retry, so nothing is ever lost; `noonien compact` runs the same compaction by hand. `noonien
import` authors its own `<node>-import` shard, so it too can run while the node's server is live and
re-importing is idempotent. That shard only ever adds, so it needs neither the peer knowledge nor
the `NOONIEN_GC` promise: `noonien import` prunes it on the way out, and `noonien compact` prunes
it too — dropping the operations a later one shadowed, keeping every tombstone, and rewriting only
when something was dropped, so a repeated maintenance costs nothing and no peer is asked to re-pull
the shard. On the `file` backend, `append` and `compact` take a per-shard lock, so they serialize
instead of racing even across processes — and the daemon takes the same lock.

Within a node the timestamp is **monotonic**: if the wall clock steps back (NTP, a restored
snapshot, a manual `date`), a new operation keeps the previous timestamp rather than an older one,
so an earlier operation can never win over a later one of the same node.

### Daemon variables

Used by the daemon only. It needs **at least one discovery source** — `NOONIEND_TAILSCALE`,
`NOONIEND_DNS_SRV` or `NOONIEND_PEERS` — to reach the mesh; the rest is optional. Run it behind a
VPN or firewall and enable mTLS — see [Security](#security).

| Variable | Default | Meaning |
| --- | --- | --- |
| `NOONIEND_LISTEN` | `0.0.0.0:7878` | `host:port` the gossip service binds. |
| `NOONIEND_ADVERTISE` | the listen host (hostname on a wildcard) | **Optional.** `host:port` this node advertises to peers; set it only when the default does not resolve from the others. |
| `NOONIEND_PEERS` | — | **Discovery: static seeds** — `node@host:port` or `host:port`, comma separated. One is enough; membership then self-propagates. |
| `NOONIEND_DNS_SRV` | — | **Discovery:** domain whose `_nooniend._tcp` SRV records are seeds. |
| `NOONIEND_TAILSCALE` | off | **Discovery:** derive seeds from `tailscale status`. |
| `NOONIEND_INTERVAL` | `30` | Anti-entropy period, seconds. |
| `NOONIEND_PUSH` | on | Reconcile as soon as the local shard changes. |
| `NOONIEND_FANOUT` | `0` | Peers contacted per round; `0` is every reachable peer. **A cap excludes `NOONIEND_GC`**: a reachable peer the round did not sample suspends collection, so the daemon refuses the two together. |
| `NOONIEND_DIGEST_MIN_SHARDS` | `32` | Shard count at or above which the digest replaces the full list (`0` = whenever supported). |
| `NOONIEND_CHANNELS` | off | Gossip membership on its own channel instead of piggybacking it on every exchange. |
| `NOONIEND_RELAY` | — | Comma-separated node ids always sampled (relays / super-peers). |
| `NOONIEND_GC` | on | Collect the authored shard: prune the shadowed operations (keeping the operation a peer off the mesh could still have folded as the gate's evidence) and drop a tombstone once no peer off the mesh that folded its element could contest it — the peer's knowledge frontier is a subset of what this node holds and covers no operation of the element (physical deletion). |
| `NOONIEND_FORGET_AFTER` | `15552000` (180 days) | Seconds of silence after which a peer is **retired**: its protection becomes durable (a merged threshold, or a blanket when it holds operations this node lacks) and its live record is dropped, so the metadata collection depends on stays bounded. `0` never retires. |
| `NOONIEND_SUSPECT_AFTER` | `3` | Failed exchanges before a peer is marked suspect. |
| `NOONIEND_DEAD_AFTER` | `6` | Failed exchanges before a peer is marked dead. |
| `NOONIEND_DEAD_RETRY` | `300` | Seconds a dead peer is left alone before it is probed again. |
| `NOONIEND_MEMBERSHIP_TTL` | `604800` | Seconds a dead peer is kept before it is forgotten. |
| `NOONIEND_REVOKED` | — | Comma-separated node ids the daemon never syncs with and refuses to accept. |
| `NOONIEND_DEPARTED` | — | Comma-separated node ids explicitly gone: like `NOONIEND_REVOKED` but their replica is also discarded and they stop blocking collection. |
| `NOONIEND_TLS_CERT` / `NOONIEND_TLS_KEY` | — | Serve TLS with this certificate and key. |
| `NOONIEND_TLS_CA` | — | CA that signs the peers' certificates, used to verify them in both directions. |
| `NOONIEND_TLS_REQUIRE_CLIENT` | on | Require a client certificate (mTLS). |

## How it works

Every mutation is recorded as an **operation** in an append-only log, split into per-node shards:

- `create_entities` / `add_observations` / `create_relations` add elements;
- `delete_entities` / `delete_observations` / `delete_relations` write tombstones (a deleted entity
  also tombstones its observations and incident relations).

A read **folds** all shards: each element (entity, observation occurrence, relation) is an LWW
register decided by `(HLC, node, sequence)`. A delete of an observation is content-level: it removes
every occurrence older than it. Observations are shown while their entity is present, relations
while both endpoints are present. The fold depends only on the *set* of operations, never on the
order shards or lines were read. Operations are ordered by a **Hybrid Logical Clock**: the order
survives clock skew, and a node that has observed a claim can write a correction ordered after it.
An observed stamp further than a bounded skew in the future is clamped, so a wrong clock cannot drag
the node's timestamps into the future. Reads are **incremental**: each shard is decoded once and
cached against a cheap fingerprint, and the folded graph is memoized, so a read with nothing changed
costs only a fingerprint poll per shard.

Consequences, all covered by property tests:

- **Idempotent** — applying the same operations twice changes nothing.
- **Commutative** — order of operations across shards does not matter.
- **Associative** — folding shards in any grouping yields the same graph.
- **Convergent** — two nodes with the same operations produce the identical graph.

Ordering is deterministic: entities by name, relations by `(from, to, relationType)`, observations
in operation order (`HLC`, `node`, `sequence`).

### Compaction

The log grows with every mutation. Compaction rewrites this node's shard keeping, per element, only
the operations that no later operation shadows — the shadow index is built from the **merged** log,
so an operation superseded by *another node's* later operation is dropped too, and the winner of
every element always survives, tombstones included. It runs **online**: the server compacts its own
shard after `NOONIEN_COMPACT_AFTER` appends, and `noonien compact` does the same by hand. When
each also collects tombstones — the physical deletion — is under [Deletion and
collection](#deletion-and-collection). The rewrite is a compare-and-swap (a temporary file renamed
over the shard on the `file` backend, a conditional write on `s3`), so a crash midway can never
truncate it and a concurrent write — an append, or a gossip recovery — makes the whole compaction
re-read and retry instead of losing it.

Every compaction stamps a `shard.compact` metadata operation (never a graph element): its
`generation` is bumped each time, and its `seq` is the shard's durable high-water mark, so the
sequence never regresses and a compaction is never mistaken for a lost shard. Peers read the
generation from `/shards` and replace a stale replica with the compacted shard, so every copy
converges to the compacted content. Only the local shard is rewritten; every other shard is
untouched, so compaction is conflict-free and other nodes are unaffected.

### Deletion and collection

A delete is an **operation**, not a removal: `delete_entities`, `delete_observations` and
`delete_relations` append tombstones, and the fold hides the element while a tombstone is the latest
operation for it. The tombstone is exactly what makes the deletion beat a concurrent write, so
dropping it while that write still exists would revive the element. A deletion is therefore only
physical once nobody can still hold one.

`nooniend` collects the shard it authors when the mesh is safe, **per element**. It first prunes
the operations a later one shadows that no retained off-mesh peer could still need, then it may drop
a surviving tombstone when no peer off the mesh could contest that element. Two conditions gate it,
per peer: the peer's **knowledge frontier** must be a subset of what this node already holds — a
peer holding any operation this node lacks could hold a *relayed* operation on the element and is
treated as a blocker — and the frontier must cover no operation of the element, so only a peer that
folded it can contest it; a peer that never folded it can still mint a coincident element (an
independent name, an observation on an entity it knows), which the fold decides as a concurrent
genesis, not a revival. An element that appeared while a peer was already away is thus collectable
at once, without waiting for that peer to return; an element the peer did know stays frozen until
the peer comes back or is explicitly departed. A surviving operation on another shard also keeps the
tombstone, so the fold is always preserved. When a peer could contest an element, the operation it
knew is kept as the evidence the next round reads again — and by the node that **authored** it, not
only by the deleter: a node never prunes a shadowed operation on an element a peer off the mesh
could still contest, so the proof survives even when the tombstone lives on a different shard (a
delete by one node of an element another created).

The claim, in one line: collection needs **no barrier over the history** — a peer that never folded
an element cannot *causally* contest it, however long it stays away, and neither a global round of
acknowledgements nor a timer on the data is needed. What it *does* need is a **stable round over the
live set**: every retained peer that is still reachable must have been exchanged with in that round
(otherwise the round **suspends**, because such a peer may hold writes this node has not pulled),
and no retained peer may hold anything this node lacks. That is why `NOONIEND_FANOUT` and
`NOONIEND_GC` exclude each other. Liveness is not autonomous: a peer that is both unreachable and
unverifiable — never reached, or holding operations this node cannot read — blocks collection until
the operator departs it (`NOONIEND_REVOKED` / `NOONIEND_DEPARTED`); the retention window bounds
*metadata* and forfeits no data, but it does not remove that decision.

Each peer's knowledge frontier — the greatest sequence it has been seen to hold of every author's
shard — is **durable**, persisted beside the shards in `.nooniend-peers.json`, so a machine gone
for a year keeps blocking only the elements it actually knew. A peer the round could still reach but
did not exchange with **suspends** collection entirely, because it may hold writes this node has not
pulled. Forgetting a peer (the membership TTL) does not unblock it — it may be alive off the mesh
with valid unsent writes — but `NOONIEND_REVOKED` and `NOONIEND_DEPARTED` do, the operator's
decision that its writes are expendable; a departed peer's replica is discarded outright. A
forfeited node's **authorship** is dropped from the gate as well, so it stops holding the collection
back through the peers that still hold its replica; a *revoked* node's operations already here keep
their elements frozen until it is departed, which discards them. Turn the daemon's collection off
with `NOONIEND_GC=false`.

The per-peer record is **bounded**. After `NOONIEND_FORGET_AFTER` seconds of silence (default 180
days) a peer is **retired**, and retirement is semantically invisible: it moves where the protection
lives, never which elements are guarded. An **accounted** peer — one whose frontier is a subset of
what this node already holds — is merged into a durable **retired frontier**, one elementwise
maximum per author. The maximum is exactly the union of the per-element decisions the peers would
have made, so it keeps gating every element those peers could have folded, **including deletions
that happen after the retirement**, over one map bounded by the shards this node holds rather than
one map per peer. (A per-element list computed at expiry would *not* be sound: a tombstone created
later is not on it.) An **unaccounted** peer — one that claims operations this node cannot read —
leaves a durable **blanket** instead: the same "it could hold anything" that gated it while it was
live, stated once rather than carried as an unverifiable map. Nothing is forfeited by retiring,
which is why the window can be on by default. `NOONIEND_REVOKED` and `NOONIEND_DEPARTED` remain
the only forfeiture — and since a maximum cannot be un-merged, a node must be departed **before**
its window expires for its contribution to be lifted. A frontier that claims an author this node
cannot serve is never recorded: a peer cannot freeze the mesh with a claim it cannot back. A claimed
node that was never reached keeps blocking conservatively, as before.

**Without the daemon** a physical deletion needs an explicit promise. A daemon that owns the
directory (`.nooniend-peers.json` present) holds the peer knowledge and collects, and it is the
only writer that maintains the shard: the server and `noonien compact` keep their whole view there
— a shadowed operation is exactly the evidence the daemon's gate reads, so they must not prune it —
and leave the shard to the daemon. With no daemon there is no knowledge to gate on, and the
directory **cannot** tell whether a peer is merely absent: a machine that is offline, or configured
but not yet synced, leaves nothing to see, and its unsynced write would be lost by a collection —
which is the immediate deletion the official server performs. So the server's online maintenance and
`noonien compact` both prune only, until the operator declares the directory written by **this node
alone** (`NOONIEN_GC=true`), the promise that makes it sound; a declaration contradicted by another
node's shard is refused and reported.

### Metrics

The daemon serves every metric at `/metrics` (the MCP server is stdio and has no endpoint). The
collection and retention state:

| Metric | Meaning |
| --- | --- |
| `noonien_gossip_frozen_elements` | deleted elements kept because a peer off the mesh may still contest them |
| `noonien_gossip_absent_nodes` | retained peers not exchanged with in the last round |
| `noonien_gossip_absent_seconds{node}` | how long each peer has been away |
| `noonien_gossip_retained_peers` | peers whose knowledge still gates collection |
| `noonien_gossip_retired_total` | peers retired into the retired frontier |
| `noonien_gossip_retired_unaccounted_total` | peers retired with a blanket |
| `noonien_gossip_retired_authors` | authors whose thresholds survive in the retired frontier |
| `noonien_gossip_blankets` | durable blankets in force |

The same endpoint carries the transport and liveness families — `noonien_gossip_rounds_total`,
`noonien_gossip_round_seconds`, `noonien_gossip_round_bytes`, `noonien_gossip_links`,
`noonien_gossip_shards`, `noonien_gossip_stable_shards`, `noonien_gossip_membership_size`,
`noonien_gossip_peers_ok_total`, `noonien_gossip_peers_failed_total`,
`noonien_gossip_ops_pulled_total`, `noonien_gossip_ops_pushed_total`,
`noonien_gossip_digest_exchanges_total`, `noonien_gossip_membership_channel_failures_total`,
`noonien_gossip_bytes_sent_total`, `noonien_gossip_bytes_received_total`,
`noonien_gossip_fanout`, `noonien_gossip_up` — and, when the daemon runs the local log's own
maintenance, its `noonien_mcp_*` counters (`noonien_mcp_folds_total`, `noonien_mcp_fold_seconds`,
`noonien_mcp_shards_merged`, `noonien_mcp_shard_stat_total`, `noonien_mcp_ops_decoded_total`,
`noonien_mcp_compacted_total`, `noonien_mcp_compaction_failed_total`).

## Drop-in compatibility

The same nine tools, so it slots under the `memory` server name with no agent changes:

`create_entities`, `create_relations`, `add_observations`, `delete_entities`, `delete_observations`,
`delete_relations`, `read_graph`, `search_nodes`, `open_nodes`.

The full graph is also exposed at the `memory://knowledge-graph` resource. The resource is
read-only; clients can subscribe to it and receive `notifications/resources/updated` whenever a
mutation changes the graph — via `resources/subscribe` on the 2025-era protocol, or a
`subscriptions/listen` stream on the 2026-07-28 revision. The server speaks both: it answers the
`initialize` handshake for 2025-era clients and `server/discover` for 2026-07-28 clients.

Entities are keyed by name. Observations behave like the official server: `add_observations` has no
effect when the content is already present, but preserves duplicate contents within a single
request, `create_entities` preserves duplicate contents as given, and deleting an observation
removes every occurrence of that content. Relations are sets: adding the same relation twice has no
effect. `delete_entities` also removes the entity's observations and its incident relations. The
tombstones cover what the deleting node could see: an observation added concurrently on another node
survives as an element, so if the entity is later created again that observation reappears with it.

## Security

- **One writer per shard.** Keep `NOONIEN_NODE_ID` unique and run one server per node id. A node id
  is sanitised to a bounded, path-safe shard-file stem, and every node id that arrives from a peer
  (a `/shards/{node}/ops` path, a gossiped summary, an announced header) is validated before it can
  name a file, enter the peer set or label a metric.
- **Replication.** `nooniend` is a network service. Run it behind a VPN or firewall, and enable
  mTLS (on by default when certificates are configured) so only authenticated peers replicate. The
  client **always verifies the peer certificate** — a configured CA, or the system trust store when
  none is set; an unverified connection is never used. Without TLS the daemon trusts the underlay; a
  peer's advertised address is still validated as a plain `host:port`, and it is adopted only when
  it matches the host the request actually came from (so an announced header cannot point the dialer
  at another host). A refusal (`NOONIEND_REVOKED` / `NOONIEND_DEPARTED`) needs the client
  certificate that mTLS supplies — without it a peer has no identity to refuse. Setting
  `NOONIEND_TLS_REQUIRE_CLIENT=false` turns TLS back into an unauthenticated channel (any client
  can push any shard); the daemon logs a warning at startup in that mode.
- **Trust model.** mTLS authenticates **members**, not individual operations. A node serves every
  shard it holds, so relaying is trusted: a member can carry another node's shard to a third node,
  and the daemon recovers its own lost shard from a peer's replica. Run `nooniend` only on machines
  you trust as peers. The fold's last-writer-wins order trusts the operation's HLC stamp, so a
  member whose clock is far ahead wins every conflict on its elements; a wrong clock is a
  correctness hazard, not a privilege boundary. Collection also **trusts what a member reports**:
  its frontier from `/shards` and the peer set it gossips — the certificate proves *who* it is, not
  that its reports are true — and it assumes the mesh is the only path by which a node learns: a
  node that leaves must not keep receiving operations elsewhere (do not point a daemon and a shared
  `file`/`s3` area at the same directory, and a node bridging two meshes belongs to both or should
  be departed).
- **Reporting a vulnerability.** Do not open a public issue — see [`SECURITY.md`](SECURITY.md).

## Development

```sh
git clone https://github.com/sequico/server-noonien.git
cd server-noonien
npm install

npm run check       # Biome: lint + format + import order
npm run typecheck   # tsc --noEmit
npm run test        # Vitest, including the CRDT property tests
npm run build       # tsc -> dist/
npm run gate        # all of the above
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the workflow and the ground rules.

## Why the name `noonien`?

The name is an homage to *Star Trek: The Next Generation*. The project was first meant to be called
**"Datalore"** — the title of the episode (Season 1, Episode 13, first aired 18 January 1988) that
introduces **Data** and his twin brother **Lore**, the two Soong-type androids built by Dr. **Noonien
Soong**. *Data* is the good one; *Lore* is the flawed, emotional, malicious prototype. Both are
played by the same actor, Brent Spiner.

The episode title is a portmanteau of the two androids, and the two names fit a knowledge graph
almost too well:

- **Data** — a *datum*: a single fact.
- **Lore** — the body of *knowledge and tradition* shared by a community.

So *datalore* would have meant the facts **plus** the shared lore — exactly what a shared agent
memory is. But "Datalore" is also the name of an unrelated commercial product in the same software
space, so rather than carry that brand conflict the project was renamed **`noonien`**, after the
androids' creator, Dr. Noonien Soong. Naming it after their maker keeps the homage to **both** Data
and Lore.

The twin motif maps onto this project's core problem — many copies of the same graph, on different
machines, that must stay consistent. Data's good twin and Lore's evil twin are the two failure
modes; in `server-noonien` the copies cannot drift apart, because the merge is conflict-free by
construction. The graph has **no evil twin**.

A small production gem: the episode was first pitched as a romance for Data with a female android.
It was **Brent Spiner himself who suggested the evil-twin plot** instead — so the actor who played
both twins also shaped the episode's twist.

References:

- Memory Alpha — *Datalore (episode)*: <https://memory-alpha.fandom.com/wiki/Datalore_(episode)>
- Memory Alpha — *Noonien Soong*: <https://memory-alpha.fandom.com/wiki/Noonien_Soong>
- Memory Alpha — *Lore*: <https://memory-alpha.fandom.com/wiki/Lore>

*This project is an independent fan homage. "Star Trek", "Data", "Lore" and "Noonien Soong" are the
property of their respective rights holders; this project is not affiliated with or endorsed by
them.*

## Documentation

- [`PLAN.md`](PLAN.md) — architecture and design decisions.
- [`SCALING.md`](SCALING.md) — the forward-looking plan for 1,000 / 10,000 nodes.
- [`docs/paper.md`](docs/paper.md) — the technical report: the model, the tombstone-collection
  contribution and the evaluation, with the bibliography in
  [`docs/references.bib`](docs/references.bib) (frozen at release 1.0.0; the report is © Sequi
  Company under CC BY 4.0 — see [`NOTICE`](NOTICE)).
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — how to contribute.
- [`AGENTS.md`](AGENTS.md) — the project rules for contributors and agents.
- [`SECURITY.md`](SECURITY.md) — security policy and how to report a vulnerability.
- [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) — the community code of conduct.

## License & Disclaimer

The source code is licensed under the [Mozilla Public License 2.0 (MPL-2.0)](LICENSE); the report
[`docs/paper.md`](docs/paper.md) is © Sequi Company, licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) — see [`NOTICE`](NOTICE).

⚠️ **NO WARRANTY & NO SUPPORT:** This software is provided "as is". The author offers **absolutely
no commercial support, no maintenance guarantees, and no uptime assistance**. If you open an issue,
it will be addressed purely on a voluntary basis.

## ❤️ Support the Project (Passive Monetization)

If this component is saving your company hundreds of hours of infrastructure development, please
consider supporting the project:

- **Sponsor on GitHub:** Help keep this project alive by adding your company logo to this README.
  [👉 Sponsor Now](https://github.com/sponsors/sequico)
- **Back a Feature:** Want a specific bug fixed or a new protocol added? We use Polar.sh. Put a
  bounty on any GitHub Issue to incentivize its development. [👉 View Bounties](https://polar.sh)
