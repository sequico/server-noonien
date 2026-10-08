---
name: server-noonien releases description: How server-noonien releases work — release-please,
versioning, npm Trusted Publishing and the release workflow. Use when cutting a release, bumping a
version, or touching the release/CI workflows.
---

# server-noonien releases

Releases are automated with **release-please** and are **never** started by an ordinary push: a push
runs CI only (`.github/workflows/ci.yml`).

## Flow

1. Land feature work on `main` with **Conventional Commits** (`fix:`, `feat:`, `feat!:` / `BREAKING
   CHANGE`).
2. Trigger the **Release** workflow manually (`workflow_dispatch`, the "Run workflow" button). It
   does everything else itself: release-please opens or refreshes the Release PR, the workflow
   merges it, then release-please tags `vX.Y.Z` and creates the GitHub Release, and the same run
   publishes to npm with provenance. Ordinary pushes to `main` run CI only and never release.
3. Nothing else to do: the `npm` environment has no required reviewers, so the publish runs
   automatically.

## Versioning

- `release-type: node` with `bump-minor-pre-major`: while 0.x, `fix` → patch, `feat` → minor,
  breaking → minor (`0.8.0` → `0.8.1` / `0.9.0`).
- Tags are `vX.Y.Z` (`include-component-in-tag: false`).
- `skip-changelog: true`: no `CHANGELOG.md` is written; repository docs stay snapshot-only.

## Files

- `release-please-config.json` — release-please configuration.
- `.release-please-manifest.json` — the last released version; release-please maintains it.
- `.github/workflows/release.yml` — release-please plus the npm publish.

## Rules

- **Never** run `npm publish` by hand, and never create a version tag or a GitHub Release manually.
- npm uses **Trusted Publishing** (OIDC via `id-token: write`); there is no `NPM_TOKEN`. A published
  version is immutable, so any change means a new version.
- The publish step is gated on the action output `release_created`, so it runs only in the run that
  actually creates a release.
- The Release PR is created with `GITHUB_TOKEN`, so its own CI does not run unless a PAT is
  configured; `main` does not require status checks, so it is still mergeable.

## Verification

- After a release: `gh release view vX.Y.Z` and `npm view server-noonien@X.Y.Z` (with its Provenance
  badge).
- To prove a tag reproduces the published artifact: the tarball built from the tag must carry the
  same sha1 as the npm tarball (npm refuses to republish an existing version, which confirms the
  match).
