# Changelog

Kept concise: one line per release, written by hand. [release-please][rp] computes the version and
creates the tag and the GitHub Release from the Conventional Commits, but it does not write this
file. A change is described under **Unreleased**; cutting a release turns that heading into the
version and its date.

[rp]: https://github.com/googleapis/release-please

## Unreleased

- **The daemon no longer listens on a port that is not ours.** The default listen port is `49778`,
  self-selected from the dynamic range (49152-65535): the IANA reviewer held the port number
  assignment and asked the service to run on a self-selected dynamic port until a number is
  assigned. The service name `noonien` is still under review.
- The README header carries the mcprush grade badge next to the Glama one, both linking to the
  server listing.
- **Two servers on one node id no longer strand each other's writes.** An append now carries the
  shard state its sequence numbers were derived from, so the writer that loses the race is refused
  and re-derives: both operations land on their own sequences and every peer receives both, instead
  of two operations sharing a sequence that no peer at that sequence ever sees.
- **Only a certificate marks a peer alive.** Reviving health on an announced header let any host
  that could open a socket keep a member that no longer answers "reachable", which suspended
  tombstone collection across the mesh; the round that reaches the peer is what revives it now.
- A lock nobody refreshes is stolen by its age in **either** direction, so a lock replicated from a
  machine whose clock runs ahead no longer stalls every write for the full deadline — and a steal
  that failed no longer spins the retry loop without pausing. An append is synced before it is
  acknowledged, so a write the server confirmed is on disk.
- A durable peer record the daemon cannot parse leaves a **blanket** instead of reading as "this
  peer holds nothing"; the record is synced before the rename and an empty one stops the daemon,
  because the only way it appears is a crash that lost the write.
- On S3, a shard object with a multipart ETag reads and stats normally — only a conditional *write*
  refuses a token the store cannot use, instead of one such object failing every tool call.
- Bound what an unauthenticated request can grow: the discovery candidate set and the forgotten
  versions carry the peer set's ceiling, and a round exchanges with a bounded number of peers at
  once instead of opening one exchange per peer in a single burst.
- Cap the daemon's decode cache at the store's own shard ceiling, so above 256 shards a read no
  longer re-decodes the mesh; report an import's skipped lines once per kind instead of once per
  line, which a pretty-printed `memory.json` turned into a hundred thousand blocking writes.
- Refuse a `NOONIEND_ADVERTISE` value that is not a `host:port` at startup, instead of letting every
  peer drop the entry and leaving the node a member nowhere.
- **A corrupt shard line is now something an operator can find.** The decoder names the lines it
  dropped and reports that corruption once per shard instead of once per read — a peer repeating the
  same body no longer writes the same warning every round — and a rewrite that would erase an
  unreadable line refuses with the line numbers in the message.
- On `s3`, contention is waited out on the same budget the `file` backend gives a lock, with a
  growing pause between attempts, instead of giving up after five immediate retries.
- `npm run gate` (and CI) now runs `npm audit --audit-level=high`, and the release workflow pins
  `mcp-publisher` by version and digest instead of downloading `latest` next to an OIDC token.
- **Security.** A caller that is not a member yet is no longer adopted from the headers of its
  request: nothing it sends becomes membership and its id is never taken on trust. It is offered as a
  discovery candidate instead — the host the request came from, the port it announces — and joins
  only after answering `/info`, so a statically-seeded joiner is still discovered by its seed while an
  address announced for another host is never even probed.
- Record what an **inbound push** carries as the pusher's own knowledge: it authored those
  operations, so it holds them, and the elements it delivered stay frozen even if it never answers
  again — instead of reading as uncontested once it is gone.
- Collection is no longer frozen for ever by a member this node never exchanged with: such a peer cannot
  hold a *causally aware* competitor — that requires the tombstone, and an operation of this node
  leaves here only through a push, which is recorded with the receiver's post-push high-water mark —
  so it no longer counts as "could hold anything" and blocks every deletion on the mesh. The peers
  tolerated this way are published as `noonien_gossip_unreached_peers`.
- Bound the shards a node takes on: the store refuses a new one past the same ceiling a peer may
  advertise (answering `507`), so neither a pushed node id nor an advertised one can fill the
  directory.
- Reconcile shards in bounded parallel batches instead of one round trip each, so a fresh node
  catches up in batches and one round never becomes thousands of simultaneous requests.
- Order each entity's observations while folding instead of sorting every addition in the graph at
  once: restricting a total order to a subsequence keeps the result identical, and the graph-wide
  comparison sort (and its temporary list) is gone.
- Write the daemon's knowledge record only when a round changed it, instead of on every round.
- Cap what one request can ask of the daemon: `/graph` answers `413` above 50 000 operations and asks
  for the shards instead, and the pushed-body cap is configurable per server.
- Answer a push for the local node's own shard with `403` instead of an internal error.
- Run the container as its unprivileged `node` user, keep the S3 not-found predicate named for its
  backend, and export fewer internals.

## 1.1.0 (2026-10-16)

- Add `update_entities` (rename an entity and/or change its type, keeping its observations and its
  relations) and `update_relations` (change a relation's type or repoint its endpoints) — the edits
  the official nine have no operation for.
- Add `update_observations` (replace an observation content), `merge_entities` (union two entities,
  repointing their relations) and `read_conflicts` (the elements more than one node wrote) as further
  extensions, and give `read_graph`/`search_nodes` an optional page and entity-type filter. The
  server's `instructions` name them and each description says what it replaces, so a model reaches
  for an update or a merge instead of composing delete + create.
- Re-probe a discovery candidate as soon as a refresh proposes it again, so a peer that moved port is
  adopted at once, and warn when `NOONIEND_ADVERTISE` and `NOONIEND_LISTEN` disagree on the port.
- `nooniend` POSTs `{ node, watermark }` to `NOONIEND_HOOK_URL` when the stable watermark advances, so
  a listener learns that a peer wrote something (best effort; it never announces a regression).
- Change the default `nooniend` listen port to `27878`, the IANA user port the service is being
  registered for. A mesh must run one port on every node — a discovery seed carries none and takes
  the dialer's own — so upgrade the nodes together, or pin `NOONIEND_LISTEN` while they are mixed.
- Document the `nooniend` wire protocol in [`PROTOCOL.md`](PROTOCOL.md); the README's daemon API
  section now points to it.
- Disclose the package's one process spawn — `execFile` without a shell, in `nooniend` only and
  opt-in — in [`SECURITY.md`](SECURITY.md).

## 1.0.2 (2026-10-10)

- Discovery: a peer joins the mesh only after its identity handshake, so a device that does not run
  `nooniend` is never adopted, and the sources are re-read periodically so a node joining the network
  is found without a restart.

## 1.0.1 (2026-10-08)

- Ship `mcpName` so the MCP Registry can verify npm ownership.

## 1.0.0 (2026-10-08)

- Release `server-noonien` 1.0.0: the MCP server, the `noonien` CLI and the `nooniend` daemon.
