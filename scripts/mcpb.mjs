// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Build the MCPB bundle (formerly DXT): the file Claude Desktop installs in one click
 * and the Smithery Local track uploads. The repository holds the manifest and the icon
 * only, so this stages them with the built server — `dist/` plus the production
 * dependencies — and packs the result. Writes `server-noonien-<version>.mcpb` at the
 * repository root.
 */
import { execFileSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))

function fail(message) {
  process.stderr.write(`mcpb: ${message}\n`)
  process.exit(1)
}

function run(command, args, cwd) {
  try {
    execFileSync(command, args, { cwd, stdio: "inherit" })
  } catch {
    fail(`${command} ${args.join(" ")} failed`)
  }
}

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version
const staging = mkdtempSync(join(tmpdir(), "noonien-mcpb-"))
const bundle = join(staging, "bundle")
const server = join(bundle, "server")
const output = join(root, `server-noonien-${version}.mcpb`)

try {
  run("npm", ["run", "build"], root)
  mkdirSync(server, { recursive: true })
  cpSync(join(root, "mcpb", "manifest.json"), join(bundle, "manifest.json"))
  cpSync(join(root, "assets", "icon.png"), join(bundle, "icon.png"))
  cpSync(join(root, "package.json"), join(server, "package.json"))
  cpSync(join(root, "package-lock.json"), join(server, "package-lock.json"))
  cpSync(join(root, "dist"), join(server, "dist"), { recursive: true })
  // The bundle is self-contained: the production dependencies travel inside it.
  run("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], server)
  for (const required of [
    "manifest.json",
    "icon.png",
    "server/dist/index.js",
    "server/node_modules",
  ]) {
    if (!existsSync(join(bundle, required))) {
      fail(`the staged bundle is missing ${required}`)
    }
  }
  // Pinned: `npx` with no version installs and runs whatever the registry serves at
  // the moment, and a bundle is built by hand, so the tool that builds it must be the
  // one that was reviewed.
  run("npx", ["-y", "@anthropic-ai/mcpb@2.1.2", "pack", bundle, output], root)
  if (!existsSync(output)) {
    fail("the packer reported success but wrote no bundle")
  }
  process.stdout.write(`mcpb: wrote ${output}\n`)
} finally {
  rmSync(staging, { recursive: true, force: true })
}
