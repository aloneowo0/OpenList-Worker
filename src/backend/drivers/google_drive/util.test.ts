import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import { GoogleDrive } from "./driver"
import { GoogleDriveClient } from "./util"

const originalFetch = globalThis.fetch

function response(
  status: number,
  headers: Record<string, string> = {},
  body = "",
): Response {
  return new Response(body, { status, headers })
}

function client(): GoogleDriveClient {
  const value: any = new GoogleDriveClient({ refresh_token: "" })
  value.accessToken = "test-token"
  value.tokenExpiresAt = Date.now() + 60_000
  return value as GoogleDriveClient
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

test("probe reports received bytes for an incomplete 308 session", async () => {
  globalThis.fetch = async () => response(308, { range: "bytes=0-9" })

  const result = await client().probeResumableUpload("https://upload", 20)
  assert.deepEqual(result, { receivedBytes: 10, complete: false })
})

test("probe reports completion metadata for a 200 session", async () => {
  globalThis.fetch = async () =>
    response(200, {}, JSON.stringify({ id: "file-1", md5Checksum: "abc" }))

  const result = await client().probeResumableUpload("https://upload", 20)
  assert.equal(result.receivedBytes, 20)
  assert.equal(result.complete, true)
  assert.deepEqual(result.metadata, { id: "file-1", md5Checksum: "abc" })
})

test("chunk rejects an offset inside the current chunk", async () => {
  let requests = 0
  globalThis.fetch = async () => {
    requests++
    return response(308, { range: "bytes=0-3" })
  }

  await assert.rejects(
    client().uploadResumableChunk("https://upload", Buffer.alloc(10), 0, 20),
    /inside the current chunk/,
  )
  assert.equal(requests, 1)
})

test("chunk rejects a remote offset with a gap before the current chunk", async () => {
  globalThis.fetch = async () => response(308, { range: "bytes=0-3" })

  await assert.rejects(
    client().uploadResumableChunk("https://upload", Buffer.alloc(10), 10, 20),
    /gap before the current chunk/,
  )
})

test("chunk is idempotent when the remote session already covers it", async () => {
  let requests = 0
  globalThis.fetch = async () => {
    requests++
    return response(308, { range: "bytes=0-9" })
  }

  const result = await client().uploadResumableChunk(
    "https://upload",
    Buffer.alloc(10),
    0,
    20,
  )
  assert.deepEqual(result, { receivedBytes: 10, complete: false })
  assert.equal(requests, 1)
})

test("chunk probes once after an ambiguous 5xx and accepts covered data", async () => {
  let requests = 0
  globalThis.fetch = async () => {
    requests++
    if (requests === 2) return response(500, {}, "temporary failure")
    if (requests === 3) return response(308, { range: "bytes=0-9" })
    return response(308)
  }

  const result = await client().uploadResumableChunk(
    "https://upload",
    Buffer.alloc(10),
    0,
    20,
  )
  assert.deepEqual(result, { receivedBytes: 10, complete: false })
  assert.equal(requests, 3)
})

test("driver validates a part then delegates to the resumable helper", async () => {
  const size = 1024 * 1024
  const token = Buffer.from(
    JSON.stringify({
      uploadUrl: "https://upload",
      size,
      chunkSize: 10 * 1024 * 1024,
      partCount: 1,
    }),
  ).toString("base64")
  const driver: any = new GoogleDrive({ refresh_token: "" })
  let call: unknown[] | undefined
  driver.client = {
    uploadResumableChunk: async (...args: unknown[]) => {
      call = args
    },
  }

  await driver.uploadPart(token, 1, Buffer.alloc(size))
  assert.deepEqual(call?.slice(1), [Buffer.alloc(size), 0, size])
})
