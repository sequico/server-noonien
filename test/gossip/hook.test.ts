// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { createServer, type Server } from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { notifyHook } from "../../src/gossip/hook.js"

const servers: Server[] = []

/** A server that records every body it is POSTed and answers `status`. */
async function collector(status = 204): Promise<{ url: string; bodies: string[] }> {
  const bodies: string[] = []
  const server = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => {
      body += chunk
    })
    request.on("end", () => {
      bodies.push(body)
      response.writeHead(status).end()
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") {
    throw new Error("the test server has no port")
  }
  return { url: `http://127.0.0.1:${address.port}/hook`, bodies }
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        }),
    ),
  )
})

describe("notifyHook", () => {
  it("posts the body and reports success", async () => {
    const { url, bodies } = await collector()
    expect(await notifyHook(url, { node: "n1", watermark: { n1: 3 } })).toBe(true)
    expect(bodies).toEqual(['{"node":"n1","watermark":{"n1":3}}'])
  })

  it("reports failure without throwing when the hook answers an error", async () => {
    const { url } = await collector(500)
    expect(await notifyHook(url, { node: "n1" })).toBe(false)
  })

  it("reports failure without throwing when the hook is unreachable", async () => {
    // Port 1 is reserved and never listening.
    expect(await notifyHook("http://127.0.0.1:1/hook", { node: "n1" })).toBe(false)
  })
})
