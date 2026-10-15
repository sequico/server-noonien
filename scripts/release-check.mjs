// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The release preflight: run it on the tree about to be released. It checks what the
 * Release workflow's gate does not — that every versioned artifact carries the version
 * going out, that the packed tarball ships every declared `bin`, and that the
 * changelog's top heading is either `Unreleased` or exactly that version, so a
 * hand-cut heading can never disagree with the version release-please computes.
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))

function fail(message) {
  process.stderr.write(`release-check: ${message}\n`)
  process.exit(1)
}

const readJson = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"))

const pkg = readJson("package.json")
const server = readJson("server.json")
const version = pkg.version

const artifacts = [
  [".release-please-manifest.json", readJson(".release-please-manifest.json")["."]],
  ["server.json $.version", server.version],
  ["server.json $.packages[*].version", server.packages?.[0]?.version],
  ["mcpb/manifest.json $.version", readJson("mcpb/manifest.json").version],
]
for (const [where, value] of artifacts) {
  if (value !== version) {
    fail(`${where} is ${String(value)}, package.json is ${version}`)
  }
}

const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8")
const heading = /^## (.+)$/m.exec(changelog)?.[1] ?? ""
if (heading !== "Unreleased" && !heading.startsWith(`${version} `)) {
  fail(`the changelog's top heading is "${heading}": expected Unreleased or "${version} (<date>)"`)
}

// `--dry-run --json` reports the packaged files without writing a tarball, so the
// preflight leaves no artifact behind. npm keys the report by package name (an array
// on older npm), so accept both shapes.
let packed
try {
  packed = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: root }))
} catch (error) {
  fail(`npm pack --dry-run failed: ${error instanceof Error ? error.message : String(error)}`)
}
const report = Array.isArray(packed) ? packed[0] : Object.values(packed)[0]
const files = new Set((report?.files ?? []).map((file) => file.path))
const bins = Object.values(pkg.bin ?? {})
if (bins.length === 0) {
  fail("package.json declares no bin")
}
for (const target of bins) {
  if (!files.has(target)) {
    fail(`the tarball is missing the bin target ${target}`)
  }
}

process.stdout.write(
  `release-check: ${version} agrees across ${artifacts.length + 1} artifacts, ` +
    `${bins.length} bin targets are packed, the changelog says "${heading}"\n`,
)
