# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Report it privately to
**info@sequi.company**, or use GitHub's [private vulnerability
reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository.

Include what you did, what you expected, what happened, and enough detail to reproduce it (version,
environment, a minimal example). We will acknowledge the report as soon as possible and keep you
informed while we work on a fix.

## Scope

server-noonien is a local MCP server that reads and writes JSONL shards through a pluggable sync
backend (a directory or an S3-compatible object store), plus the optional `nooniend` daemon, a
network service that replicates those shards between nodes over HTTP (TLS/mTLS optional). In scope:
a way to make the server or daemon read or write outside its shard directory, execute unintended
code, lose or corrupt shard data, or accept replication from an unauthorised peer.

Out of scope: the underlay network and its credentials (a VPN, a shared mount, an object store, the
gossip TCP port), the effect of running the gossip daemon without TLS (it trusts the underlay), and
the MCP client's own configuration, and the sync tool's own behaviour in a shared area (its latency,
and the conflict copies it may leave — noonien neither verifies nor retransmits).

Three assumptions the collection gate makes explicit, and does not defend against:

- **A member is benign.** A client certificate proves *which* member is talking to the daemon, not
  that its reports are true. The gate takes a member's advertised frontier (`/shards`) and the peer
  set it gossips at face value; a member that understates its frontier, or hides a peer from the
  gossip, can cause a deletion to be collected while an operation that should beat it still exists.
- **The mesh is the only path.** A node that has left must not keep receiving operations by another
  route (a shared `file`/`s3` area pointed at the same directory, a backup restore, a second mesh).
  A node bridging two meshes must belong to both, or be departed.
- **Coincident independent naming (the gate's causal scope).** The guarantee is *no causal revival*:
  a tombstone is kept while any replica that had **folded** the element could re-deliver a competing
  operation — a delete needs the element, an add needs only the identities it depends on (nothing
  for an entity, the entity for an observation, both endpoints for a relation). A member that never
  folded an element can still mint a coincident one and, if it is older than a tombstone already
  collected, survive the merge; the fold decides it as a concurrent genesis, not a revival of the
  deleted data. Where a name must never be independently minted for the same logical entity, keep
  the element covered by a retained threshold or depart the peer.

## Supported versions

Only the latest release is supported with security fixes.
