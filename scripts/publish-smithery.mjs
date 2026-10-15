// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Publish the release to Smithery, whose page carries a ServerCard built from the
 * server's own introspection — so the tool list on it moves with the code instead of
 * being a hand-kept curl. It starts the built server over stdio, reads `tools/list`,
 * and PUTs the release with the MCPB bundle (`npm run mcpb`) attached.
 *
 * Environment: `SMITHERY_API_KEY` (required to publish), `SMITHERY_SERVER` (required to
 * publish: `<namespace>/<name>`, e.g. `sequico/server-noonien`), `SMITHERY_BUNDLE`
 * (optional; defaults to `server-noonien-<version>.mcpb`). `--dry-run` prints the
 * payload and stops, so the introspection is checkable without a token.
 */
import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const dryRun = process.argv.includes("--dry-run")

function fail(message) {
  process.stderr.write(`publish-smithery: ${message}\n`)
  process.exit(1)
}

/** One JSON-RPC line, or `undefined` for a blank or non-JSON one. */
function parseLine(line) {
  const trimmed = line.trim()
  if (trimmed === "") {
    return undefined
  }
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

/** Read one tool list from the built server by speaking stdio JSON-RPC to it. */
function introspect(entry) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "inherit"] })
    let buffer = ""
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error("the server did not answer tools/list"))
    }, 30_000)
    child.on("error", reject)
    const handle = (message) => {
      if (message === undefined) {
        return
      }
      if (message.id === 1 && message.result !== undefined) {
        send({ jsonrpc: "2.0", method: "notifications/initialized" })
        send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
      }
      if (message.id === 2 && message.result !== undefined) {
        clearTimeout(timer)
        child.kill()
        resolve(message.result.tools)
      }
    }
    child.stdout.on("data", (chunk) => {
      buffer += chunk
      let newline = buffer.indexOf("\n")
      while (newline >= 0) {
        handle(parseLine(buffer.slice(0, newline)))
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf("\n")
      }
    })
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "publish-smithery", version: "0.0.0" },
      },
    })
  })
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const entry = join(root, "dist", "index.js")
if (!existsSync(entry)) {
  fail("dist/index.js is missing: run `npm run build` (or `npm run mcpb`) first")
}

const tools = await introspect(entry)
const payload = {
  type: "stdio",
  runtime: "node",
  configSchema: {
    type: "object",
    required: [],
    properties: {
      directory: {
        type: "string",
        description: "Directory holding this machine's shards. Defaults to ~/.noonien.",
      },
      nodeId: {
        type: "string",
        description:
          "This node's shard name. Must be unique per machine; defaults to the hostname.",
      },
    },
  },
  serverCard: {
    serverInfo: { name: pkg.name, version: pkg.version },
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      // Smithery's ToolInputSchema is a closed `{type, properties}` object: it rejects
      // the `$schema`, `required` and `additionalProperties` the SDK's JSON Schema carries.
      inputSchema: {
        type: "object",
        properties: tool.inputSchema?.properties ?? {},
      },
    })),
  },
}

if (dryRun) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  process.exit(0)
}

const token = process.env["SMITHERY_API_KEY"]
if (token === undefined || token === "") {
  fail("SMITHERY_API_KEY is not set (use --dry-run to inspect the payload)")
}
const server = process.env["SMITHERY_SERVER"]
if (server === undefined || server === "") {
  fail("SMITHERY_SERVER is not set (e.g. sequico/server-noonien)")
}
const bundle = process.env["SMITHERY_BUNDLE"] ?? join(root, `server-noonien-${pkg.version}.mcpb`)
if (!existsSync(bundle)) {
  fail(`${bundle} is missing: build it with \`npm run mcpb\``)
}

const form = new FormData()
form.append(
  "payload",
  new Blob([JSON.stringify(payload)], { type: "application/json" }),
  "payload.json",
)
form.append("bundle", new Blob([readFileSync(bundle)]), "bundle.mcpb")

const headers = new Headers()
headers.set("Authorization", `Bearer ${token}`)
const response = await fetch(
  `https://api.smithery.ai/servers/${encodeURIComponent(server)}/releases`,
  { method: "PUT", headers, body: form },
)
const body = await response.text()
if (!response.ok) {
  fail(`Smithery answered ${response.status}: ${body}`)
}
process.stdout.write(`publish-smithery: ${server} published ${pkg.version}\n${body}\n`)
