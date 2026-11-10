// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Every relative Markdown link resolves, from the directory of the file that carries it.
 * A file that moves takes its links down silently; this is what notices.
 */
import { execFileSync } from "node:child_process"
import { accessSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))

const files = execFileSync("git", ["ls-files", "*.md"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter((file) => file.trim() !== "")

let checked = 0
let broken = 0
for (const file of files) {
  const text = readFileSync(join(root, file), "utf8")
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1]
    if (target === undefined || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) {
      continue
    }
    const path = target.split("#")[0] ?? ""
    if (path === "") {
      continue
    }
    checked += 1
    try {
      accessSync(resolve(root, dirname(file), path))
    } catch {
      process.stderr.write(`links: ${file} -> ${target}\n`)
      broken += 1
    }
  }
}

if (broken > 0) {
  process.stderr.write(`links: ${broken} broken of ${checked} relative links\n`)
  process.exit(1)
}
process.stdout.write(`links: ${checked} relative links in ${files.length} files, none broken\n`)
