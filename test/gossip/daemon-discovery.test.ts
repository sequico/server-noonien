// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { rm } from "node:fs/promises"
import { createServer } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { type GossipHandle, startGossip } from "../../src/gossip/daemon.js"
import { createTempDirectory } from "../support/tmp.js"

const directories: string[] = []
const handles: GossipHandle[] = []

async function tempDirectory(): Promise<string> {
  const directory = await createTempDirectory("noonien-discovery-")
  directories.push(directory)
  return directory
}

/** A concrete free port: `startGossip` rejects port 0, and nothing listens after this. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      if (address === null || typeof address === "string") {
        reject(new Error("could not allocate a port"))
        return
      }
      probe.close(() => resolve(address.port))
    })
  })
}

async function startDaemon(
  node: string,
  directory: string,
  port: number,
  seed: string,
): Promise<GossipHandle> {
  const handle = await startGossip(
    {
      NOONIEN_DIR: directory,
      NOONIEN_NODE_ID: node,
      NOONIEND_LISTEN: `127.0.0.1:${port}`,
      NOONIEND_ADVERTISE: `127.0.0.1:${port}`,
      NOONIEND_PEERS: seed,
      // One round per call, no push-on-change: the test drives every round itself.
      NOONIEND_INTERVAL: "3600",
      NOONIEND_PUSH: "false",
      NOONIEND_SUSPECT_AFTER: "1",
      NOONIEND_DEAD_AFTER: "1",
    },
    { quiet: true },
  )
  handles.push(handle)
  return handle
}

/** The membership size from the public metrics. */
async function membershipSize(url: string): Promise<number> {
  const text = await (await fetch(`${url}/metrics`)).text()
  const match = text.match(/^noonien_gossip_membership_size (\d+)$/m)
  return match?.[1] === undefined ? -1 : Number(match[1])
}

/** The peer ids this node knows. */
async function peerIds(url: string): Promise<string[]> {
  const body = (await (await fetch(`${url}/peers`)).json()) as { peers: { node: string }[] }
  return body.peers.map((peer) => peer.node)
}

/** Poll a condition while the daemon runs, so the test never depends on timers. */
async function until(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("condition was not met in time")
}

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()))
  await Promise.all(
    directories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
      ),
  )
})

describe("discovery candidates", () => {
  it("never adopts a bare seed that does not answer `/info`", async () => {
    const port = await freePort()
    const dead = await freePort()
    const handle = await startDaemon("n1", await tempDirectory(), port, `127.0.0.1:${dead}`)
    for (let round = 0; round < 3; round += 1) {
      await handle.syncOnce()
    }
    // The candidate never completed the handshake, so it is not a member: membership
    // stays this node alone, and the phantom never blocks collection.
    await until(async () => (await membershipSize(handle.url)) >= 1)
    expect(await membershipSize(handle.url)).toBe(1)
  })

  it("adopts a candidate once it answers, taking the id from `/info`", async () => {
    const portA = await freePort()
    const dead = await freePort()
    await startDaemon("real-a", await tempDirectory(), portA, `127.0.0.1:${dead}`)
    // B is seeded with a bare address: it must learn A's node id from A's own `/info`,
    // not from anywhere in the seed.
    const b = await startDaemon(
      "real-b",
      await tempDirectory(),
      await freePort(),
      `127.0.0.1:${portA}`,
    )
    await until(async () => (await membershipSize(b.url)) >= 2)
    expect(await peerIds(b.url)).toContain("real-a")
  })
})
