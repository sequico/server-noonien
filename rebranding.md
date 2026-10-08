# Rebranding plan: `datalore-mcp` → `noonien`

Forward-looking plan (not current-state documentation). This file is **temporary**: it exists to drive
the rename and is removed when the work is done. Do not treat it as project documentation.

## 1. Objective

Rename the project from the `datalore` brand to the **`noonien`** brand — the Star Trek homage stays
in the docs, the trademark-overlapping *name* goes away — and publish the renamed artifact.

- **Old**: package/repo `datalore-mcp`, commands `datalore-mcp` / `datalore` / `datalored`.
- **New**: package/repo `server-noonien`, commands `server-noonien` / `noonien` / `nooniend`.

## 2. Target identity

| Thing | Old | New |
| --- | --- | --- |
| npm package | `datalore-mcp` | `server-noonien` |
| GitHub repo | `sequico/datalore-mcp` | `sequico/server-noonien` |
| MCP server command | `datalore-mcp` → `dist/index.js` | `server-noonien` → `dist/index.js` |
| Maintenance CLI command | `datalore` → `dist/datalore.js` | `noonien` → `dist/noonien.js` |
| Replication daemon command | `datalored` → `dist/gossip.js` | `nooniend` → `dist/gossip.js` |
| CLI source file | `src/datalore.ts` | `src/noonien.ts` |

Why this works with `npx` (the npm rule): with several `bin` entries, `npm exec` runs the one whose
name matches the **unscoped** package name. `server-noonien` (unscoped) matches the `server-noonien`
bin, so `npx -y server-noonien` starts the MCP server. The other two need `-p`:

```sh
npx -y server-noonien                 # MCP server (no arg, or `serve`)
npx -y -p server-noonien noonien help # maintenance CLI
npx -y -p server-noonien nooniend     # replication daemon
```

Note on discovery: the package name no longer contains `mcp`. Compensate with `keywords`
(already include `mcp`, `model-context-protocol`) and, optionally, a `server.json` manifest for the
MCP registry. **Do not** reintroduce `mcp` in the command names.

## 3. Token mapping (all renames)

### 3.1 Names and paths

| Old token | New token |
| --- | --- |
| `datalore-mcp` (package, binaries, diagnostics, docs) | `server-noonien` |
| `datalore` (CLI binary, diagnostics) | `noonien` |
| `datalored` (daemon binary, diagnostics, docs) | `nooniend` |
| `Datalore` (paper title, README homage heading) | `Noonien` |
| `~/.datalore` (default shard directory) | `~/.noonien` |
| `.datalored-peers.json` (daemon state file) | `.nooniend-peers.json` |
| `_datalored._tcp` (DNS SRV service) | `_nooniend._tcp` |
| `x-datalore-node` / `-address` / `-version` (HTTP headers) | `x-noonien-node` / `-address` / `-version` |
| `datalore_gossip_*` (Prometheus metrics) | `noonien_gossip_*` |
| `datalore_mcp_*` (Prometheus metrics) | `noonien_mcp_*` |
| `~/.config/datalore/datalored.env` (systemd example) | `~/.config/noonien/nooniend.env` |
| `%h/.local/bin/datalored` (systemd example) | `%h/.local/bin/nooniend` |
| `https://github.com/sequico/datalore-mcp` (URLs, badges) | `https://github.com/sequico/server-noonien` |
| `https://www.npmjs.com/package/datalore-mcp` | `https://www.npmjs.com/package/server-noonien` |

### 3.2 Environment variables

Two prefixes, renamed mechanically:

- `DATALORE_*` → `NOONIEN_*` (server + CLI): `NOONIEN_BACKEND`, `NOONIEN_DIR`, `NOONIEN_NODE_ID`,
  `NOONIEN_S3_BUCKET`, `NOONIEN_S3_PREFIX`, `NOONIEN_S3_REGION`, `NOONIEN_S3_ENDPOINT`,
  `NOONIEN_S3_FORCE_PATH_STYLE`, `NOONIEN_COMPACT_AFTER`, `NOONIEN_GC`.
- `DATALORED_*` → `NOONIEND_*` (daemon, 22 vars): `NOONIEND_LISTEN`, `NOONIEND_ADVERTISE`,
  `NOONIEND_PEERS`, `NOONIEND_DNS_SRV`, `NOONIEND_TAILSCALE`, `NOONIEND_INTERVAL`, `NOONIEND_PUSH`,
  `NOONIEND_FANOUT`, `NOONIEND_DIGEST_MIN_SHARDS`, `NOONIEND_CHANNELS`, `NOONIEND_RELAY`,
  `NOONIEND_GC`, `NOONIEND_FORGET_AFTER`, `NOONIEND_SUSPECT_AFTER`, `NOONIEND_DEAD_AFTER`,
  `NOONIEND_DEAD_RETRY`, `NOONIEND_MEMBERSHIP_TTL`, `NOONIEND_REVOKED`, `NOONIEND_DEPARTED`,
  `NOONIEND_TLS_CERT`, `NOONIEND_TLS_KEY`, `NOONIEND_TLS_CA`, `NOONIEND_TLS_REQUIRE_CLIENT`.

Decision: **no legacy aliases** (there are no users yet — see §7).

## 4. Complete touch-point inventory

### 4.1 Package metadata

| File | Change |
| --- | --- |
| `package.json` | `name` → `server-noonien`; `repository.url`/`homepage`/`bugs` → the renamed repo; `bin` → `{ "server-noonien": "dist/index.js", "noonien": "dist/noonien.js", "nooniend": "dist/gossip.js" }`; keep `keywords` (they already carry `mcp`); decide `version` (§7). `publishConfig` unchanged. |
| `package-lock.json` | `name` fields (2) → `server-noonien`; regenerate with `npm install` after `package.json`. |

### 4.2 Source code (`src/`)

| File | Change |
| --- | --- |
| `src/datalore.ts` | **Rename to `src/noonien.ts`**; update the CLI comment. |
| `src/index.ts` | Comment (server name); the unknown-argument message (`the maintenance CLI is \`datalore\``) → `noonien`. |
| `src/cli.ts` | `HELP` text (usage, the `datalore-mcp` reference, all `DATALORE_*`/`DATALORED_*` names in the help); `usage: datalore …` error strings; comments. |
| `src/config.ts` | All `DATALORE_*` env reads and messages; default dir `~/.datalore` → `~/.noonien`; comments. |
| `src/diagnostics.ts` | `MCP_PREFIX` → `server-noonien`; `CLI_PREFIX` → `noonien`; `DAEMON_PREFIX` → `nooniend`. |
| `src/host.ts` | `DATALORE_NODE_ID` read. |
| `src/gossip.ts` | Daemon comment. |
| `src/gossip/bootstrap.ts` | `SRV_SERVICE = "_nooniend._tcp"`. |
| `src/gossip/collection.ts` | Comments (`DATALORED_REVOKED`/`_DEPARTED`). |
| `src/gossip/config.ts` | All `DATALORED_*`/`DATALORE_*` reads, error messages, comments. |
| `src/gossip/daemon.ts` | `datalore_gossip_*` metric names; startup warning messages (`DATALORED_*`). |
| `src/gossip/knowledge.ts` | `PEERS_FILE = ".nooniend-peers.json"`; comments. |
| `src/gossip/server.ts` | `x-datalore-*` headers; comments. |
| `src/gossip/transport.ts` | `x-datalore-*` headers; `datalore_gossip_bytes_*` metric constants. |
| `src/graph/graph.ts` | `datalore_mcp_*` metric names. |
| `src/graph/hlc.ts` | Comment (`datalore orders operations …`). |
| `src/store/log.ts` | `datalore_mcp_*` metric names; `DATALORE_NODE_ID` message; comments. |
| `src/sync/backend.ts` | `DATALORE_NODE_ID` message; comments. |
| `src/package.ts` | **No change** — name/version come from `package.json`; `serverInfo.name` becomes `server-noonien` automatically. |
| `src/serve.ts`, `src/migrate.ts`, other `gossip/` files | No change unless a name appears (verify with `rg`). |

### 4.3 Tests (`test/`)

| File | Change |
| --- | --- |
| `test/package.test.ts` | `PACKAGE.name` assertion → `server-noonien`; the expected `bin` map. |
| `test/server.test.ts` | `serverInfo.name` assertion → `server-noonien`. |
| `test/cli.test.ts` | `DATALORE_*` env; `.datalored-peers.json`; describe titles. |
| `test/config.test.ts`, `test/gossip/config.test.ts`, `test/gossip/daemon-collection.test.ts`, `test/gossip/exchange.test.ts`, `test/gossip/http.test.ts`, `test/gossip/knowledge.test.ts`, `test/gossip/retire.test.ts`, `test/gossip/tls.test.ts`, `test/graph/graph.test.ts`, `test/host.test.ts`, `test/store/log.test.ts`, `test/sync/file.test.ts`, `test/sync/s3.test.ts`, `test/support/rpc.ts` | `DATALORE_*`/`DATALORED_*` env; `datalore_*` metric names; temp-dir prefixes (`datalore-tests`, `datalore-test-client`, `datalore-test-ca`, …); comments. |
| All test files | Any remaining `datalore` string (temp names, titles) for consistency. |

### 4.4 Documentation

| File | Change |
| --- | --- |
| `README.md` | Title; badges (repo + npm URLs); the two `git clone` URLs; package and command names; the three-command table and all `npx` examples; the OpenCode config example (`DATALORE_DIR` → `NOONIEN_DIR`, `~/.datalore` → `~/.noonien`); the systemd unit; every `DATALORE_*`/`DATALORED_*` table; every metric name; the **"Why the name"** section (rewrite for `Noonien`: Dr. Noonien Soong, creator of Data and Lore — keep the twin-motif mapping and the Star Trek disclaimer); the Table of Contents anchors (`#why-datalore-mcp` → `#why-noonien`, and the name-of-the-project anchor). |
| `PLAN.md` | Title; name in prose; the CLI section (commands, env vars); Distribution; Documentation section; Current state. |
| `SCALING.md` | Title; name in prose. |
| `SECURITY.md` | "datalore-mcp is a local MCP server…", `datalored`. |
| `CONTRIBUTING.md` | "Thanks for your interest in datalore-mcp…". |
| `AGENTS.md` | Title; "What this is" (`datalored`); any name in the rules. |
| `NOTICE` | Title `datalore-mcp`; the "Trademarks" paragraph (keep the independent-homage disclaimer). |
| `docs/paper.md` | Title `# Datalore: …` → `# Noonien: …`; every `datalore`/`datalored` in prose; env var names; the `git clone`/`cd` snippet; the "report at release `datalore-mcp` 0.9.0" line → the new package/version. |
| `docs/references.bib` | The `@misc{datalore, …}` entry: key → `noonien`, title and URL. Update the citing text in `paper.md` if the author-year form embeds the name. |
| `docs/paper.meta.yaml`, `LICENSE`, `docs/LICENSE`, `CODE_OF_CONDUCT.md` | No name — verify only. |

### 4.5 GitHub

| File | Change |
| --- | --- |
| `.github/workflows/ci.yml` | The tarball glob `datalore-mcp-*.tgz` → `server-noonien-*.tgz` (bin verification step). |
| `.github/workflows/release.yml` | The tarball glob `datalore-mcp-*.tgz` → `server-noonien-*.tgz`. |
| `.github/workflows/codeql.yml` | No name. |
| `.github/ISSUE_TEMPLATE/bug_report.yml` | Input label "datalore-mcp version" and placeholder. |
| `.github/ISSUE_TEMPLATE/config.yml` | Security-report URL → the renamed repo. |
| Repository settings | Rename the repo (§5). The `npm` Actions **environment** persists across a rename. Branch protection unchanged. |

> Changes under `.github/workflows/` need the owner's explicit approval (repository law).

### 4.6 Agent skills

| Path | Change |
| --- | --- |
| `.opencode/skills/datalore-dev/SKILL.md` | **Rename dir** `datalore-dev` → `noonien-dev`; frontmatter `name`/`description`; body (layout, commands, names). |
| `.opencode/skills/datalore-release/SKILL.md` | **Rename dir** `datalore-release` → `noonien-release`; frontmatter and body; the verification commands (`npm view server-noonien@…`). |

> The two skills are the "datalore-mcp development"/"datalore-mcp releases" skills referenced by
> `AGENTS.md`; update that reference too.

### 4.7 Release configuration

| File | Change |
| --- | --- |
| `release-please-config.json` | No package name inside — verify only. |
| `.release-please-manifest.json` | Version only; set per §7. |
| `package.json` `publishConfig` | `{ "access": "public", "provenance": true }` — keep. |

## 5. Repository rename

1. Rename on GitHub: `gh repo rename server-noonien` (run inside the clone so the local remote is
   updated; GitHub redirects the old URL).
2. Confirm `package.json` `repository.url`, `homepage`, `bugs` and the README badges/links all point
   at `sequico/server-noonien`.
3. The Actions environment `npm` and branch protection carry over with the repo.
4. Do this **after** the local commit/push (or before — redirects make it safe either way), but
   **before** the npm trusted-publisher setup, which binds to the repo name.

## 6. npm publishing and authentication

Current state (must be verified against npmjs.com when executing): publishing is **fully automated**
via **Trusted Publishing (OIDC)** — no `NPM_TOKEN`. `.github/workflows/release.yml` runs in the
GitHub environment `npm`, requests `id-token: write`, and runs `npm publish`; provenance is attached
automatically (public package, public repo).

What changes: the **package name changes**, and npm ties a trusted publisher to a package. So the new
package needs its own trusted publisher. Also, per npm docs:

- A trusted publisher for the old package becomes useless (old repo name).
- For GitHub, your `package.json` `repository.url` **must exactly match** the GitHub repository, or
  the OIDC publish fails.
- A newly created trusted publisher configuration must complete its **first successful publish within
  2 days**, or it expires.
- Configurations created recently default to **stage publish only**: you must explicitly tick **Allow
  `npm publish`**, or the release workflow's `npm publish` fails.
- npm requires the package to **already exist** before a trusted publisher can be configured
  (chicken-and-egg — see the bootstrap below).

### Bootstrap sequence

Because a trusted publisher cannot be created until the package exists, the first publish must be
bootstrapped. Options:

1. **Placeholder publish (recommended).** Publish a minimal `server-noonien@0.0.0` once from the
   maintainer account (`npm publish` on a throwaway dir), then configure the trusted publisher, then
   let the Release workflow publish the real version. **This is a manual `npm publish`, which the
   repository law forbids** — the owner must authorize this explicit exception.
2. **`npm trust` CLI.** `npm trust github server-noonien --file release.yml --repo
   sequico/server-noonien --env npm --allow-publish` — still requires the package to exist, an npm
   CLI ≥ 11.15.0 and interactive 2FA.

### Configuring the trusted publisher (npmjs.com → package → Settings → Trusted publishing)

Provider **GitHub Actions**, fields:

| Field | Value |
| --- | --- |
| Organization or user | `sequico` |
| Repository | `server-noonien` |
| Workflow filename | `release.yml` |
| Environment name | `npm` |
| Allowed actions | **Allow `npm publish`** (mandatory) |

Then harden the package: **Settings → Publishing access → "Require two-factor authentication and
disallow tokens"** (trusted publishing keeps working; tokens stop).

### Handling the old package

`datalore-mcp` cannot be renamed; it must go away:

- **Deprecate** (safe): `npm deprecate datalore-mcp "Renamed to server-noonien — install server-noonien instead."`
- **Unpublish** (optional) if eligible: published < 72 h with no dependents, **or** no dependents +
  < 300 weekly downloads + a single maintainer. Otherwise deprecate. After a full unpublish, the name
  cannot be republished for 24 h.

Owner decides deprecate vs unpublish.

## 7. Versioning

Two viable choices — owner decides:

- **Continuity (recommended):** keep `0.9.0` in `package.json` and `.release-please-manifest.json`;
  the rename lands as a **breaking change** (`feat!:`) → while 0.x it bumps to `0.10.0` on release.
- **Fresh start:** set the new package to `1.0.0` and the manifest to `1.0.0`.

Either way, **never** run `npm publish` or create a tag/release by hand: the Release workflow does it.

## 8. Open decisions (owner)

1. Env prefix `NOONIEN_*` / `NOONIEND_*` and default dir `~/.noonien` — confirm (no aliases).
2. Metrics prefix `datalore_*` → `noonien_*` — confirm.
3. Version: `0.9.0`-continuity vs `1.0.0` (§7).
4. Old npm package: **deprecate** or **unpublish** (§6).
5. Bootstrap exception for the first `server-noonien` publish (§6) — required by npm.
6. `docs/paper.md`: the report is pinned to a release; rebrand its title/name and update the pin, or
   republish as-is? Recommended: rebrand and update the pin to the new package/version.
7. Optional: add a `server.json` (MCP registry manifest) for discovery.

## 9. Execution runbook

1. **Local rename** — apply §3–§4 across code, tests, docs, GitHub files, skills.
2. **Verify** — `npm run gate` (check + typecheck + test + build). Must be 0/0/0. Fix everything;
   do not leave warnings.
3. **Commit + push** — small conventional commit(s), linear on `main` (e.g.
   `refactor!: rename datalore-mcp to server-noonien`).
4. **Rename the GitHub repo** (§5) — owner-gated.
5. **npm bootstrap + trusted publisher** (§6) — owner-gated; do it within 2 days of creating the
   trusted publisher.
6. **Release** — owner triggers the **Release** workflow (`workflow_dispatch`); it opens/merges the
   Release PR, tags, creates the Release and publishes with provenance.
7. **Verify** — `npm view server-noonien`, provenance badge, `gh release view vX.Y.Z`, and
   `npx -y server-noonien` starts the server.
8. **Clean up** — remove this `rebranding.md` (it is temporary), commit.

## 10. Verification checklist

- [ ] No `datalore`/`DATALORE` token remains in `src/`, `test/`, or the tracked docs/config
      (`rg -i datalore` is empty apart from third-party quotes/history that must be resolved).
- [ ] `package.json` name/repository/bin are the new ones; `package-lock.json` regenerated.
- [ ] `npm run gate` green (0 errors, 0 warnings).
- [ ] `npx -y server-noonien` serves over stdio; `noonien help` and `nooniend` work.
- [ ] `rg` finds no `datalore-mcp-*.tgz` globs left in the workflows.
- [ ] Repo renamed; badges and clone URLs resolve.
- [ ] Trusted publisher configured with **Allow `npm publish`**; first publish verified with provenance.
- [ ] Old package deprecated (or unpublished); README points to `server-noonien`.
- [ ] Working tree clean.

## 11. Follow-ups after the rename (this machine / company docs)

- If the machine `ai` switches its MCP memory entry from `@modelcontextprotocol/server-memory` to
  `server-noonien`, update `~/sequicompany/macchine/ai/` (snapshot) and the shared memory graph
  (`memory` MCP) in the same turn.
- `~/sequicompany` may reference the old repo/package; update it (snapshot) once the rename is live.
