// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { PACKAGE } from "../src/package.js"

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  bin?: Record<string, string>
}

describe("PACKAGE", () => {
  it("exposes only the manifest identity fields", () => {
    expect(Object.keys(PACKAGE).sort()).toEqual(["name", "version"])
  })

  it("carries the package name and a semver version", () => {
    expect(PACKAGE.name).toBe("server-noonien")
    expect(PACKAGE.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it("exposes the noonien, server-noonien and nooniend commands", () => {
    expect(manifest.bin).toEqual({
      noonien: "dist/noonien.js",
      "server-noonien": "dist/index.js",
      nooniend: "dist/gossip.js",
    })
  })
})
