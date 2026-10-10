# Changelog

Kept concise: one line per release, written by hand. [release-please][rp] computes the version and
creates the tag and the GitHub Release from the Conventional Commits, but it does not write this
file. A change is described under **Unreleased**; cutting a release turns that heading into the
version and its date.

[rp]: https://github.com/googleapis/release-please

## Unreleased

- Discovery: a peer joins the mesh only after its identity handshake, so a device that does not run
  `nooniend` is never adopted, and the sources are re-read periodically so a node joining the network
  is found without a restart.

## 1.0.1 (2026-10-08)

- Ship `mcpName` so the MCP Registry can verify npm ownership.

## 1.0.0 (2026-10-08)

- Release `server-noonien` 1.0.0: the MCP server, the `noonien` CLI and the `nooniend` daemon.
