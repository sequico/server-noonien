# Changelog

Kept concise: one line per release, written by hand. [release-please][rp] computes the version and
creates the tag and the GitHub Release from the Conventional Commits, but it does not write this
file. A change is described under **Unreleased**; cutting a release turns that heading into the
version and its date.

[rp]: https://github.com/googleapis/release-please

## Unreleased

- Add `update_entities` (rename an entity and/or change its type, keeping its observations and its
  relations) and `update_relations` (change a relation's type or repoint its endpoints) — the edits
  the official nine have no operation for.

## 1.0.3 (2026-10-16)

- Change the default `nooniend` listen port to `27878`, the IANA user port the service is being
  registered for.
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
