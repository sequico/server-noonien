// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * The release preflight: run it on the tree about to be released. It checks what the
 * Release workflow's gate does not — that every versioned artifact carries the version
 * going out, that the packed tarball ships every declared `bin`, that the changelog's
 * top heading is either `Unreleased` or exactly that version, and that the README
 * documents every tool the built server registers. `--tools-only` runs that last check
 * alone, which is what CI does on every pull request.
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const toolsOnly = process.argv.includes("--tools-only")

/** The nine the official server ships; every other tool is ours to name. */
const OFFICIAL_TOOLS = new Set([
  "create_entities",
  "create_relations",
  "add_observations",
  "delete_entities",
  "delete_observations",
  "delete_relations",
  "read_graph",
  "search_nodes",
  "open_nodes",
])

function fail(message) {
  process.stderr.write(`release-check: ${message}\n`)
  process.exit(1)
}

const readJson = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"))

/** The tool names the README's table lists. */
function readmeToolNames() {
  const text = readFileSync(new URL("../README.md", import.meta.url), "utf8")
  const start = text.indexOf("## Tools")
  const end = text.indexOf("## Drop-in compatibility")
  const section = start < 0 ? "" : text.slice(start, end < 0 ? undefined : end)
  return [...section.matchAll(/^\| `([a-z_]+)`\s*\|/gm)]
    .map((match) => match[1])
    .filter((name) => name !== undefined)
}

/** The tools the built server registers, and what it tells the model about them. */
function registeredTools() {
  const bin = join(root, "dist", "index.js")
  const input = `${[
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "release-check", version: "0" },
      },
    }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  ].join("\n")}\n`
  let output
  try {
    output = execFileSync("node", [bin], { input, encoding: "utf8", timeout: 30_000 })
  } catch (error) {
    fail(`the built server did not answer (run npm run build first): ${String(error)}`)
  }
  const messages = output
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line))
  const init = messages.find((message) => message.id === 1)
  const list = messages.find((message) => message.id === 2)
  return {
    names: (list?.result?.tools ?? []).map((tool) => tool.name),
    instructions: init?.result?.instructions ?? "",
  }
}

/** The README table and the built surface must name the same tools. */
function checkTools() {
  const readme = readmeToolNames()
  const { names, instructions } = registeredTools()
  if (readme.length === 0) {
    fail("the README tool table could not be read")
  }
  const registered = new Set(names)
  const documented = new Set(readme)
  for (const name of registered) {
    if (!documented.has(name)) {
      fail(`the server registers ${name}, which the README table does not list`)
    }
  }
  for (const name of documented) {
    if (!registered.has(name)) {
      fail(`the README table lists ${name}, which the server does not register`)
    }
  }
  for (const name of registered) {
    if (!OFFICIAL_TOOLS.has(name) && !instructions.includes(name)) {
      fail(`instructions do not name the extension tool ${name}`)
    }
  }
  return names.length
}

if (toolsOnly) {
  const count = checkTools()
  process.stdout.write(`release-check: ${count} tools, README and instructions agree\n`)
  process.exit(0)
}

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
    `${bins.length} bin targets are packed, the changelog says "${heading}", ` +
    `${checkTools()} tools documented\n`,
)
