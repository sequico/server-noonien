# The `nooniend` wire protocol

Normative description of the protocol the `nooniend` daemon speaks over the network, as implemented
in `src/gossip/`. It is the technical reference for interoperability, for reviewing the replication
design, and for the IANA port/service-name registration of the service (Expert Review; see
[Registration](#registration)). The environment variables that configure the daemon are listed in
[`README.md`](README.md#daemon-variables) and are not repeated here.

## Role

`nooniend` replicates each node's shard directory **peer to peer** so that several machines share one
knowledge graph with no shared folder and no central server. Each node authors exactly one shard
(`<node>.jsonl`); the daemon only ever pushes the shard it authors and pulls the shards it replicates,
so the single-writer rule holds. Replication is **idempotent and best-effort**: the operations form an
append-only log and the merged state is the fold of all shards, so delivery needs no ordering and no
consensus, only eventual completeness.

## Transport

- **TCP.** The daemon binds a single, configurable TCP port (`NOONIEND_LISTEN`; see
  [`README.md`](README.md#daemon-variables)).
- **HTTP/1.1.** Requests and responses use the Node.js `http`/`https` stack; a client uses one request
  per message (no persistent application session, no WebSocket, no multiplexing).
- **Optional TLS.** When a certificate and key are configured the service speaks **HTTPS**; with a CA
  configured it additionally requires and verifies a **client certificate** (mTLS). Plain HTTP is
  intended only on a trusted underlay — a VPN (WireGuard, Tailscale, …) or a LAN.
- **No broadcast or multicast.** Peers are reached by unicast at a known `host:port`; discovery
  produces candidate addresses that are then contacted directly.

## Identity, announcement and discovery

- Every node has a **node id** (unique per machine), a **`host:port` address**, and an integer
  **version** (a logical stamp that increases when the node restarts or its state changes, used only
  to detect staleness in gossip; it is not the protocol revision).
- A discovery source (Tailscale, `_nooniend._tcp` DNS SRV records, or a static seed) returns
  **candidates**. A candidate is adopted into the membership only after it answers `GET /info`; the
  node id always comes from that answer, never from the discovery source, so a device on the network
  that does not run `nooniend` is never adopted.
- Every request carries the caller's identity in three request headers, so a peer that is reached can
  mark the caller alive (and a node it does not yet know can be adopted from its **source-matched**
  address):

  | Header | Meaning |
  | --- | --- |
  | `x-noonien-node` | The caller's node id (a path-safe id). |
  | `x-noonien-address` | The caller's advertised `host:port`. |
  | `x-noonien-version` | The caller's integer version. |

  An announced address is adopted only when its host matches the TCP source address of the request
  (an SSRF guard); a peer whose advertised host differs from its source — a NAT — is not adopted
  automatically and must be added as a seed instead.

## Messages

All routes are read-only except the operations push. Responses are `application/json` unless noted;
the operations routes use `application/x-ndjson`.

| Method | Path | Response |
| --- | --- | --- |
| `GET` | `/health` | Liveness: `{"status":"ok"}`. |
| `GET` | `/info` | This node's entry (`node`, `address`, `version`), the protocol revision (`protocol`) and the advertised `capabilities`. |
| `GET` | `/peers` | The peer set with live health: `{"peers":[{"node","address","version","health"}]}`, `health` one of `alive`, `suspect`, `dead`. |
| `GET` | `/membership` | The peer set without health — the payload nodes gossip: `{"peers":[{"node","address","version"}]}`. |
| `GET` | `/status` | Summary: `{"node","version","protocol","uptimeSec","shards","peers":{"total","alive","suspect","dead"}}` (peer counts exclude the local node). |
| `GET` | `/graph` | The whole knowledge graph folded from the replicas on disk: `{"entities","relations"}`. |
| `GET` | `/shards` | Per-shard summaries: `{"shards":[{"node","count","maxSeq","generation"}]}`. |
| `GET` | `/shards/digest` | The shard digest: `{"root","buckets":[{"index","hash","count"}]}`. With `?buckets=1,3,5`, just those buckets' summaries as `{"shards":[…]}`. |
| `GET` | `/shards/{node}/ops?after=N` | The operations of `{node}` after sequence `N`, as NDJSON (see below). |
| `POST` | `/shards/{node}/ops` | Append operations to `{node}`'s replica (NDJSON body); returns `{"appended","maxSeq"}`. Accepts only operations authored by `{node}`. |
| `GET` | `/metrics` | Prometheus metrics (`text/plain; version=0.0.4`). |
| `GET` | `/watermark` | Per-shard stable high-water mark across the contactable peers: `{"<node>": <seq>, …}`. |

An unknown path answers `404`, an unsupported method `405`, a revoked caller or an unauthorized push
`403`, a malformed node id or bucket list `400`, an oversized body `413`, and an internal failure
`500`. Every error body is `{"error":"<message>"}` and never echoes server-side state.

## Operations

The operations routes carry an **append-only operation log** as NDJSON: one JSON object per line, no
trailing comma, no wrapper array. Each operation is an envelope plus a type-specific payload:

| Field | Type | Meaning |
| --- | --- | --- |
| `v` | integer | Envelope revision (currently `1`). |
| `id` | string | Operation identity, exactly `"<ts>|<node>|<seq>"`; deduplicates a shard read twice. |
| `ts` | string | Canonical UTC ISO-8601 timestamp with milliseconds (as `Date.toISOString()`). |
| `hlc` | string, optional | Hybrid-logical-clock stamp; omitted by operations written before it existed. Orders operations ahead of legacy timestamps. |
| `node` | string | The authoring node id. |
| `seq` | integer | The authoring node's sequence number (per-shard, monotonic). |
| `type` | string | One of the operation types below. |
| … | | The payload fields of that type. |

Operation types:

| `type` | Payload | Effect |
| --- | --- | --- |
| `entity.create` | `name`, `entityType` | Adds an entity. |
| `entity.delete` | `name` | Tombstones an entity. |
| `observation.add` | `entityName`, `content`, `slot?` | Adds an observation occurrence. |
| `observation.delete` | `entityName`, `content` | Tombstones all occurrences of a content. |
| `relation.add` | `from`, `to`, `relationType` | Adds a relation. |
| `relation.delete` | `from`, `to`, `relationType` | Tombstones a relation. |
| `shard.compact` | `generation` | Per-shard metadata written on compaction; **ignored by the fold**. |

The total order used to fold (last-writer-wins) is `(hlc, node, seq)`, with `ts` substituted for a
missing `hlc`.

A `GET /shards/{node}/ops?after=N` response streams the operations **in sequence order**; the cursor
`after` is exclusive and defaults to `-1`. A client that reaches the response cap continues from the
last sequence received, so a shard larger than one response is pulled page by page.

## Synchronisation

- **Cursor.** Reconciliation compares the per-shard high-water `seq`. A node pushes the delta of the
  shard it authors and pulls the delta of the shards it replicates, in whichever direction is behind.
- **Push on change + anti-entropy.** A local change triggers a reconciliation, and a periodic round
  (`NOONIEND_INTERVAL`) reconciles every reachable peer. Operations are idempotent, so a lost or
  duplicated delivery is harmless — completeness, not exactly-once, is the contract.
- **Batching.** A push is split into bounded requests (each batch ≤ 8 MiB) so a large delta transfers
  as several requests rather than one that exceeds the server's body cap.
- **Digest reconciliation.** At or above a shard-count threshold, a node that advertises the `digest`
  capability reconciles through the fixed-size digest instead of the full shard list: it compares the
  digest, fetches only the buckets whose hash differs (`?buckets=…`), and falls back to the plain
  list for a peer that does not advertise `digest`, so a mixed mesh never breaks.
- **Relay.** A node serves every replica it holds, so an offline node keeps converging through any
  peer that has its shard.

## Revision and versioning

- The wire carries a **protocol revision** (`protocol: 1`, in `/info` and `/status`). The first
  exchange validates it, and a peer that answers a different revision fails the exchange rather than
  being misread.
- **Capabilities** (`capabilities: […]` in `/info`) are additive: an older peer ignores one it does
  not know, and a newer peer falls back cleanly. `digest` is the only capability defined so far.

## Limits

| Limit | Value |
| --- | --- |
| Pushed request body | 64 MiB (`64 × 1024 × 1024` bytes) |
| Single operation | 64 MiB |
| Push batch (client) | 8 MiB |
| Response the client buffers | 64 MiB |
| Entries in one list (`/membership`, `/shards`) | 10 000 |
| Capabilities in `/info` | 64 |
| Digest buckets (fixed) | 16 |
| Server request timeout | 60 s |
| Server headers timeout | 20 s |
| Client request timeout | 10 s |

The list, capability and bucket caps are fixed constants of the wire contract: a digest with a
different bucket count is rejected rather than silently reconciled against the wrong buckets, and a
single response cannot force unbounded state out of a peer.

## Security

- **Optional mTLS.** With a certificate and key the service speaks HTTPS; with a CA and
  `NOONIEND_TLS_REQUIRE_CLIENT` (default on) every route requires a client certificate whose
  **common name is the peer's node id**. A peer may therefore only push the shard it authors, while
  reads stay open to any authenticated peer — which is what lets a node relay the shards it holds.
- **Membership controls.** `NOONIEND_REVOKED` refuses specific node ids on every route;
  `NOONIEND_DEPARTED` additionally discards a departed node's replica and unblocks collection.
- **Deployment.** The service is designed to run behind a VPN or firewall; without TLS its routes are
  unauthenticated and must not be exposed to an untrusted network.

## Registration

The service (TCP, service name `noonien`) is being registered with IANA in the **Service Name and
Transport Protocol Port Number Registry** for a **User port** — the requested number is **27878** —
under the **Expert Review** procedure (RFC 6335 §8.1.2, RFC 7605, RFC 8126). The application, its
data and its procedure are tracked in the private `server-noonien-internal` repository; this document
is the technical reference cited by it.
