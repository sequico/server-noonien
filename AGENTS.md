# server-noonien — project rules

Project law for this repository. Where it conflicts with the global agent rules, this file wins.

## What this is

Shared, serverless, conflict-free memory for AI agents: a drop-in replacement for the official
`@modelcontextprotocol/server-memory` knowledge graph that converges across machines without a
server. Nodes need a path between them: the `file`/`s3` backends require a **shared area** (a
replicated shard directory or an object store) because the server merges the shards, it does not
move them, while the companion **`nooniend`** daemon replicates the shards peer to peer and needs
only IP reachability. See [`README.md`](README.md) and [`PLAN.md`](PLAN.md).

## Language

All repository content — code, identifiers, comments, docs and commit messages — is in **English**.

## Compatibility contract

- Expose the same nine tools as `@modelcontextprotocol/server-memory`, with the same names, inputs
  and outputs. Agents must be able to swap the server name without changing anything else.
- Any behaviour change must be reflected in tests and in the README.

## CRDT semantics

- State is an **append-only operation log**. The merged state is the **fold** of all shards: an
  **LWW-Element-Set** whose elements are decided by the greatest `(HLC, node, sequence)` operation
  (adds and tombstones). The log also carries a per-shard `shard.compact` metadata operation, which
  the fold ignores.
- Every change to merge, serialization or ordering **must** ship property tests covering
  **idempotence, commutativity, associativity and convergence**.
- Graph operations are additive or tombstones; the `shard.compact` metadata operation is neither and
  never affects the folded graph. Never mutate shareable state in place.

## Engineering rules

- **SSOT** — one authoritative definition per concept, within code/config and within docs.
- **No duplication, no workarounds** — fix the root cause.
- **Clean tree** — no modified, untracked or temporary file left behind.
- **Gate 0/0/0** — `npm run check`, `npm run typecheck`, `npm run test`, `npm run build` must all
  pass with zero errors, zero warnings, zero residual issues.
- **Tests** — unit tests for logic, property tests for the CRDT. No `.skip`/`.only` committed.
- **Types** — strict; no `any` without a written justification.
- **Docs** — `README.md`/`PLAN.md` describe the current state only: no history, no changelog;
  `CHANGELOG.md` is the one historical artifact, kept concise by hand (one line per release, the
  pending change under `Unreleased`). `SCALING.md` is forward-looking, and the report in `docs/` is
  frozen at the release it pins.
- Use the latest online documentation for libraries instead of relying on memory.

## Commands

```sh
npm run check       # Biome: lint + format check + import order
npm run typecheck   # tsc --noEmit
npm run test        # Vitest
npm run build       # tsc -> dist/
npm run gate        # all of the above
```

## Git

Small, conventional commits. Finished work is **committed locally** as the standard operation — a
review is fixed at full scope without asking — and pushed only when the owner explicitly asks.
History on `main` stays **linear**: integrate by squash or rebase, never with a merge commit.

## Releases

Releases are automated with **release-please** and are never started by an ordinary push — a push
runs CI only.

- A single manual run of the **Release** workflow (`workflow_dispatch`) does the whole release: it
  opens or refreshes the Release PR, merges it, tags `vX.Y.Z`, creates the GitHub Release, and
  publishes to npm with provenance via **Trusted Publishing** (no npm token).
- Ordinary pushes to `main` run CI only; the Release workflow is **not** triggered by a push.
- The publish job runs in the `npm` environment — the name the Trusted Publisher requires, with no
  required reviewers, so the publish is automatic. It installs with `--ignore-scripts` because it
  holds the OIDC token, and verifies the packed `bin` entry points before publishing.
- **Never** run `npm publish` by hand, and never create a version tag or a GitHub Release manually.
- The version lives only in `package.json` and `.release-please-manifest.json`; bumps follow
  Conventional Commits (`fix` → patch, `feat` → minor, breaking → minor while 0.x).
- Changes to `.github/workflows/` and the release configuration need the owner's approval.

See the `server-noonien releases` skill for the step-by-step procedure.
