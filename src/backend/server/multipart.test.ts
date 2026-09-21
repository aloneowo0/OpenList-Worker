import assert from "node:assert/strict"
import { test } from "node:test"
import { snapshot, type MultipartSession } from "../internal/upload/multipart"

const session = (
  overrides: Partial<MultipartSession> = {},
): MultipartSession => ({
  upload_id: "mp_test",
  state: "receiving",
  attempt: 0,
  path: "/file.bin",
  size: 25,
  chunk_size: 10,
  total_chunks: 3,
  received: new Set<number>(),
  driver_session: "driver",
  partMd5s: ["a", "b", "c"],
  storage_driver: "test",
  sequential_parts: true,
  created_at: Date.now(),
  ...overrides,
})

test("multipart snapshot reports exact short-final bytes and frontier", () => {
  const result = snapshot(session({ received: new Set([0, 2]) }))
  assert.deepEqual(result.received, [
    [0, 0],
    [2, 2],
  ])
  assert.equal(result.received_bytes, 15)
  assert.equal(result.frontier, 1)
  assert.equal("active_chunk" in result, false)
})
