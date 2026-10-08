// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { request as httpsRequest, type RequestOptions } from "node:https"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ReplicaStore } from "../../src/gossip/replica.js"
import { type GossipServer, type ServerTls, startGossipServer } from "../../src/gossip/server.js"
import { type ClientTls, HttpTransport } from "../../src/gossip/transport.js"
import { encodeOperation } from "../../src/graph/codec.js"
import { testMembership } from "../support/gossip.js"
import { op } from "../support/operations.js"

interface KeyPair {
  readonly key: Buffer
  readonly cert: Buffer
}

interface Certificates {
  readonly ca: Buffer
  readonly server: KeyPair
  /** CN `noonien-test-client`, not a node id. */
  readonly client: KeyPair
  /** CN `ai`, the node id of the server under test. */
  readonly ai: KeyPair
}

interface RawResponse {
  readonly status: number
  readonly body: string
}

let directory = ""
let certificates: Certificates

function openssl(args: readonly string[]): void {
  execFileSync("openssl", args, { cwd: directory, stdio: "pipe" })
}

function selfSigned(name: string, commonName: string): void {
  openssl(["genrsa", "-out", `${name}.key`, "2048"])
  openssl([
    "req",
    "-new",
    "-key",
    `${name}.key`,
    "-subj",
    `/CN=${commonName}`,
    "-out",
    `${name}.csr`,
  ])
  openssl([
    "x509",
    "-req",
    "-in",
    `${name}.csr`,
    "-CA",
    "ca.crt",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-days",
    "1",
    "-out",
    `${name}.crt`,
  ])
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), "noonien-tls-"))
  writeFileSync(join(directory, "server.ext"), "subjectAltName=IP:127.0.0.1\n")
  openssl(["genrsa", "-out", "ca.key", "2048"])
  openssl([
    "req",
    "-x509",
    "-new",
    "-key",
    "ca.key",
    "-days",
    "1",
    "-subj",
    "/CN=noonien-test-ca",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-out",
    "ca.crt",
  ])
  openssl(["genrsa", "-out", "server.key", "2048"])
  openssl(["req", "-new", "-key", "server.key", "-subj", "/CN=127.0.0.1", "-out", "server.csr"])
  openssl([
    "x509",
    "-req",
    "-in",
    "server.csr",
    "-CA",
    "ca.crt",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-days",
    "1",
    "-extfile",
    "server.ext",
    "-out",
    "server.crt",
  ])
  selfSigned("client", "noonien-test-client")
  selfSigned("ai", "ai")
  const read = (name: string): Buffer => readFileSync(join(directory, name))
  certificates = {
    ca: read("ca.crt"),
    server: { key: read("server.key"), cert: read("server.crt") },
    client: { key: read("client.key"), cert: read("client.crt") },
    ai: { key: read("ai.key"), cert: read("ai.crt") },
  }
})

afterAll(() => {
  rmSync(directory, { recursive: true, force: true })
})

async function startNode(
  requireClient: boolean,
  revoked?: ReadonlySet<string>,
): Promise<GossipServer> {
  const tls: ServerTls = {
    key: certificates.server.key,
    cert: certificates.server.cert,
    ca: certificates.ca,
    requireClient,
  }
  return startGossipServer({
    host: "127.0.0.1",
    port: 0,
    tls,
    replica: new ReplicaStore(directory, "server"),
    membership: testMembership("server", "server:0"),
    ...(revoked === undefined ? {} : { revoked }),
  })
}

function clientTls(pair: KeyPair): ClientTls {
  return { key: pair.key, cert: pair.cert, ca: certificates.ca, rejectUnauthorized: true }
}

function rawRequest(
  method: string,
  url: string,
  options: RequestOptions,
  body?: string,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { ...options, method }, (response) => {
      const chunks: Buffer[] = []
      response.on("data", (chunk: Buffer) => chunks.push(chunk))
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
      )
    })
    request.on("error", reject)
    request.end(body)
  })
}

const CREATE_ADA = op(
  { type: "entity.create", name: "Ada", entityType: "person" },
  { node: "ai", seq: 0 },
)

describe("gossip mTLS", () => {
  it("serves a peer that presents a valid client certificate", async () => {
    const server = await startNode(true)
    try {
      const transport = new HttpTransport(server.address, clientTls(certificates.client))
      expect((await transport.info()).node).toBe("server")
    } finally {
      await server.close()
    }
  })

  it("refuses a server whose certificate the client cannot verify", async () => {
    const server = await startNode(true)
    try {
      // The client trusts a leaf certificate instead of the CA that signed the
      // server: with verification on, the handshake must fail rather than silently
      // accept the peer (the daemon always sets `rejectUnauthorized: true`).
      const transport = new HttpTransport(server.address, {
        key: certificates.client.key,
        cert: certificates.client.cert,
        ca: certificates.ai.cert,
        rejectUnauthorized: true,
      })
      await expect(transport.info()).rejects.toThrow()
    } finally {
      await server.close()
    }
  })

  it("refuses a client without a certificate when one is required", async () => {
    const server = await startNode(true)
    try {
      await expect(
        rawRequest("GET", `https://${server.address}/info`, {
          ca: certificates.ca,
          rejectUnauthorized: false,
        }),
      ).rejects.toThrow()
    } finally {
      await server.close()
    }
  })

  it("serves an unauthenticated client when no client certificate is required", async () => {
    const server = await startNode(false)
    try {
      const response = await rawRequest("GET", `https://${server.address}/info`, {
        ca: certificates.ca,
        rejectUnauthorized: true,
      })
      expect(response.status).toBe(200)
    } finally {
      await server.close()
    }
  })

  it("rejects a push whose certificate does not match the shard's node", async () => {
    const server = await startNode(true)
    try {
      const response = await rawRequest(
        "POST",
        `https://${server.address}/shards/ai/ops`,
        clientTls(certificates.client),
        `${encodeOperation(CREATE_ADA)}\n`,
      )
      expect(response.status).toBe(403)
    } finally {
      await server.close()
    }
  })

  it("accepts a push from the certificate of that shard's node", async () => {
    const server = await startNode(true)
    try {
      const response = await rawRequest(
        "POST",
        `https://${server.address}/shards/ai/ops`,
        clientTls(certificates.ai),
        `${encodeOperation(CREATE_ADA)}\n`,
      )
      expect(response.status).toBe(200)
      expect(JSON.parse(response.body)).toEqual({ appended: 1, maxSeq: 0 })
    } finally {
      await server.close()
    }
  })

  it("refuses a revoked node's certificate on every route", async () => {
    const server = await startNode(true, new Set(["ai"]))
    try {
      const info = await rawRequest(
        "GET",
        `https://${server.address}/info`,
        clientTls(certificates.ai),
      )
      expect(info.status).toBe(403)
      const push = await rawRequest(
        "POST",
        `https://${server.address}/shards/ai/ops`,
        clientTls(certificates.ai),
        `${encodeOperation(CREATE_ADA)}\n`,
      )
      expect(push.status).toBe(403)
    } finally {
      await server.close()
    }
  })
})
