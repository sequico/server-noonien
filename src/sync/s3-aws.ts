// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3"
import type { AwsS3Config, S3Operations } from "./s3.js"

function isNotFound(error: unknown): boolean {
  const name = (error as { name?: unknown }).name
  const status = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode
  // A missing object is `NoSuchKey`/`NotFound`. A bare 404 can also be `NoSuchBucket`
  // (a misconfigured store), which must not be mistaken for an absent shard.
  return name === "NoSuchKey" || name === "NotFound" || (status === 404 && name !== "NoSuchBucket")
}

function isPreconditionFailed(error: unknown): boolean {
  const name = (error as { name?: unknown }).name
  const status = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode
  return name === "PreconditionFailed" || name === "ConditionalRequestConflict" || status === 412
}

/**
 * Conditional writes need a version token. S3 always returns a single-part ETag
 * on a successful GET/HEAD; a missing one means the object changed under us, and a
 * multipart ETag (`"<md5>-<n>"`) is not a valid `If-Match` token, so both fail
 * loudly rather than guarding a write with a token that can never match.
 */
function requireEtag(key: string, etag: string | undefined): string {
  if (etag === undefined) {
    throw new Error(`object ${key} has no ETag; conditional writes need a version token`)
  }
  if (etag.includes("-")) {
    throw new Error(`object ${key} has a multipart ETag; conditional writes are unsupported`)
  }
  return etag
}

/**
 * Adapt an AWS S3 client to the shard store's object operations. This module is
 * loaded lazily by {@link S3Backend}, so the SDK is only required when the S3
 * backend is actually selected.
 */
export function createAwsS3Operations(config: AwsS3Config): S3Operations {
  const client = new S3Client({
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
  })
  return {
    async list(prefix: string): Promise<string[]> {
      const keys: string[] = []
      let token: string | undefined
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: config.bucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        )
        for (const object of page.Contents ?? []) {
          if (object.Key !== undefined) {
            keys.push(object.Key)
          }
        }
        token = page.NextContinuationToken
      } while (token !== undefined)
      return keys
    },

    async getVersioned(key: string) {
      try {
        const object = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))
        const content = object.Body === undefined ? "" : await object.Body.transformToString()
        return { content, version: requireEtag(key, object.ETag) }
      } catch (error) {
        if (isNotFound(error)) {
          return undefined
        }
        throw error
      }
    },

    async head(key: string) {
      try {
        const object = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }))
        return { version: requireEtag(key, object.ETag), size: object.ContentLength ?? 0 }
      } catch (error) {
        if (isNotFound(error)) {
          return undefined
        }
        throw error
      }
    },

    async putConditional(key: string, content: string, version: string | undefined) {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: config.bucket,
            Key: key,
            Body: content,
            ...(version === undefined ? { IfNoneMatch: "*" } : { IfMatch: version }),
          }),
        )
        return true
      } catch (error) {
        if (isPreconditionFailed(error)) {
          return false
        }
        throw error
      }
    },
  }
}
