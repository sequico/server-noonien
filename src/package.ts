// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readFileSync } from "node:fs"

export interface PackageMeta {
  readonly name: string
  readonly version: string
}

/**
 * The single source of truth for the server name and version is the package
 * manifest, so `npx` and the MCP `initialize` result can never disagree. Only
 * the two identity fields are exposed: casting alone would leak the rest of the
 * manifest into `serverInfo`.
 */
const manifest = parseManifest(readFileSync(new URL("../package.json", import.meta.url), "utf8"))

function parseManifest(text: string): PackageMeta {
  const raw = JSON.parse(text) as Partial<Record<keyof PackageMeta, unknown>>
  if (
    typeof raw.name !== "string" ||
    raw.name === "" ||
    typeof raw.version !== "string" ||
    raw.version === ""
  ) {
    throw new Error("package.json must carry a non-empty string name and version")
  }
  return { name: raw.name, version: raw.version }
}

export const PACKAGE: PackageMeta = { name: manifest.name, version: manifest.version }
