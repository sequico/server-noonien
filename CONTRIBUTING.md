# Contributing

Thanks for your interest in server-noonien. This is the short version; the project rules in
[`AGENTS.md`](AGENTS.md) are the authoritative ones. Read [`README.md`](README.md) for usage and
[`PLAN.md`](PLAN.md) for the design, and follow the [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). By
contributing you agree that your contributions are licensed under the [Mozilla Public License
2.0](LICENSE).

## Ground rules

- Everything in the repository is in **English**: code, identifiers, comments, docs and commits.
- **SSOT**, no duplication and no workarounds, within code/config and within docs.
- Docs describe the **current state** only: no history, no changelog — except `CHANGELOG.md`, kept
  concise by hand (one line per release, the pending change under `Unreleased`).

## Getting started

```sh
npm install
npm run gate       # check + typecheck + test + build
```

`npm run gate` must pass with **zero errors, zero warnings and zero residual issues** before a
change is done. The four commands are `npm run check` (Biome), `npm run typecheck` (tsc), `npm run
test` (Vitest) and `npm run build` (tsc → `dist/`).

## Making a change

1. Keep the drop-in contract: the same nine tools as `@modelcontextprotocol/server-memory`, with the
   same names, inputs and outputs.
2. Model behaviour as CRDT operations — additive or tombstone, never an in-place mutation — and add
   or extend the property tests when a change touches merge, serialization or ordering.
3. Add unit tests for the logic, keep the tree clean (no leftover files), and do not commit
   `.skip`/`.only`.
4. Update `README.md`/`PLAN.md` when user-visible behaviour changes.

## Commits and pull requests

Small, conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `ci:`, `chore:`). Open a pull
request against `main`; CI runs the whole gate on Node 22, 24 and 26 on `main` (Node 24 on a pull
request), verifies the packed tarball ships the entry points, and lints and security-checks the
workflows. Keep a pull request focused, and describe what changed and why.
