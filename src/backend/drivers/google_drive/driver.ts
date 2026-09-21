import { StorageDriver, FileItem } from "../../internal/driver/base"
import { sortFileItems } from "../../internal/driver/sort"
import {
  GoogleDriveAddition,
  GoogleFile,
  GOOGLE_DRIVE_FOLDER_MIME,
} from "./types"
import { GoogleDriveClient } from "./util"

const GOOGLE_UPLOAD_CHUNK_SIZE = 10 * 1024 * 1024

type GoogleUploadSession = {
  uploadUrl: string
  size: number
  chunkSize: number
  partCount: number
  expectedMd5?: string
}

function encodeUploadSession(session: GoogleUploadSession): string {
  return Buffer.from(JSON.stringify(session), "utf8").toString("base64")
}

function decodeUploadSession(token: string): GoogleUploadSession {
  if (typeof token !== "string" || token.length === 0 || token.length > 16384) {
    throw new Error("[GoogleDrive] Invalid upload session token")
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(token) || token.length % 4 !== 0) {
    throw new Error("[GoogleDrive] Invalid upload session token")
  }
  let session: unknown
  try {
    session = JSON.parse(Buffer.from(token, "base64").toString("utf8"))
  } catch {
    throw new Error("[GoogleDrive] Invalid upload session token")
  }
  const s = session as Partial<GoogleUploadSession>
  const keys = Object.keys(s)
  if (
    keys.some(
      (key) =>
        ![
          "uploadUrl",
          "size",
          "chunkSize",
          "partCount",
          "expectedMd5",
        ].includes(key),
    )
  ) {
    throw new Error("[GoogleDrive] Invalid upload session token")
  }
  const size = s.size as number
  const partCount = s.partCount as number
  if (
    typeof s.uploadUrl !== "string" ||
    !s.uploadUrl ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    !Number.isSafeInteger(partCount) ||
    partCount < 1 ||
    partCount !== Math.max(1, Math.ceil(size / GOOGLE_UPLOAD_CHUNK_SIZE)) ||
    s.chunkSize !== GOOGLE_UPLOAD_CHUNK_SIZE ||
    (s.expectedMd5 !== undefined && !/^[a-f0-9]{32}$/.test(s.expectedMd5))
  ) {
    throw new Error("[GoogleDrive] Invalid upload session token")
  }
  return s as GoogleUploadSession
}

function googleFileToFileItem(f: GoogleFile): FileItem {
  return {
    name: f.name,
    size: f.size ? parseInt(f.size, 10) : 0,
    is_dir: f.mimeType === GOOGLE_DRIVE_FOLDER_MIME,
    modified: f.modifiedTime || f.createdTime || new Date().toISOString(),
    sign: "",
    type: f.mimeType === GOOGLE_DRIVE_FOLDER_MIME ? 1 : 0,
    thumb: f.thumbnailLink || "",
    raw_url: "",
  }
}

export class GoogleDrive implements StorageDriver {
  private client: GoogleDriveClient
  private addition: GoogleDriveAddition

  constructor(addition: GoogleDriveAddition) {
    this.addition = addition
    this.client = new GoogleDriveClient(addition)
  }

  async init(): Promise<void> {
    await this.client.init()
  }

  async list(_virtualPath: string, physicalPath: string): Promise<FileItem[]> {
    const folderId = await this.client.resolveFileId(physicalPath)
    const files = await this.client.listFiles(folderId)
    const items = files.map(googleFileToFileItem)
    return sortFileItems(
      items,
      this.addition.order_by,
      this.addition.order_direction,
    )
  }

  async get(_virtualPath: string, physicalPath: string): Promise<FileItem> {
    const fileId = await this.client.resolveFileId(physicalPath)
    const file = await this.client.getFile(fileId).catch(() => null)
    if (file) {
      const item = googleFileToFileItem(file)
      // Attach download URL + auth header
      item.raw_url = this.client.getDownloadUrl(fileId)
      item.raw_url_headers = this.client.getDownloadHeaders()
      return item
    }
    // Fallback: the path may be a folder that isn't found via getFile
    // (e.g. the storage root). Probe it by listing.
    const parts = physicalPath.split("/").filter(Boolean)
    const name = parts[parts.length - 1] || "root"
    try {
      await this.client.listFiles(fileId)
      return {
        name,
        size: 0,
        is_dir: true,
        modified: new Date().toISOString(),
        sign: "",
        type: 1,
        raw_url: "",
      }
    } catch {}
    return {
      name,
      size: 0,
      is_dir: false,
      modified: new Date().toISOString(),
      sign: "",
      type: 0,
      raw_url: "",
    }
  }

  async mkdir(_virtualPath: string, physicalPath: string): Promise<void> {
    const { parentId, name } =
      await this.client.resolveParentAndName(physicalPath)
    await this.client.mkdir(parentId, name)
  }

  async rename(
    _virtualPath: string,
    physicalPath: string,
    newName: string,
  ): Promise<void> {
    const fileId = await this.client.resolveFileId(physicalPath)
    await this.client.rename(fileId, newName)
  }

  async remove(
    _virtualPath: string,
    physicalPath: string,
    _names: string[],
  ): Promise<void> {
    const fileId = await this.client.resolveFileId(physicalPath)
    await this.client.remove(fileId)
  }

  async move(
    srcDir: string,
    dstDir: string,
    _names: string[],
    srcPhysical: string,
    _dstPhysical: string,
  ): Promise<void> {
    const fileId = await this.client.resolveFileId(srcPhysical)
    const srcParts = srcPhysical.split("/").filter(Boolean)
    srcParts.pop()
    const srcParentId = await this.client.resolveFileId(
      "/" + srcParts.join("/"),
    )
    const dstParentId = await this.client.resolveFileId(dstDir)
    await this.client.move(fileId, srcParentId, dstParentId)
  }

  async copy(
    _srcDir: string,
    dstDir: string,
    _names: string[],
    srcPhysical: string,
    _dstPhysical: string,
  ): Promise<void> {
    const fileId = await this.client.resolveFileId(srcPhysical)
    const name = srcPhysical.split("/").filter(Boolean).pop() || "copy"
    const dstParentId = await this.client.resolveFileId(dstDir)
    await this.client.copy(fileId, dstParentId, name)
  }

  async createUploadSession(
    _virtualDir: string,
    physicalDir: string,
    fileName: string,
    size: number,
    md5 = "",
  ): Promise<{
    reuse: boolean
    partCount: number
    chunkSize: number
    sequentialParts: true
    session: string
  }> {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error("[GoogleDrive] Invalid upload size")
    }
    if (!fileName || fileName.length > 1024) {
      throw new Error("[GoogleDrive] Invalid file name")
    }
    const normalizedMd5 = String(md5 || "")
      .trim()
      .toLowerCase()
    const expectedMd5 = /^[a-f0-9]{32}$/.test(normalizedMd5)
      ? normalizedMd5
      : undefined
    const parentId = await this.client.resolveFileId(physicalDir || "/")
    const uploadUrl = await this.client.initResumableUpload(
      parentId,
      fileName,
      size,
    )
    const partCount = Math.max(1, Math.ceil(size / GOOGLE_UPLOAD_CHUNK_SIZE))
    return {
      reuse: false,
      partCount,
      chunkSize: GOOGLE_UPLOAD_CHUNK_SIZE,
      sequentialParts: true,
      session: encodeUploadSession({
        uploadUrl,
        size,
        chunkSize: GOOGLE_UPLOAD_CHUNK_SIZE,
        partCount,
        expectedMd5,
      }),
    }
  }

  async uploadPart(
    sessionToken: string,
    partNumber: number,
    content: Buffer,
  ): Promise<void> {
    const session = decodeUploadSession(sessionToken)
    if (
      !Number.isSafeInteger(partNumber) ||
      partNumber < 1 ||
      partNumber > session.partCount
    ) {
      throw new Error(`[GoogleDrive] Invalid part number: ${partNumber}`)
    }
    const start = (partNumber - 1) * session.chunkSize
    const expectedLength = Math.max(
      0,
      Math.min(session.chunkSize, session.size - start),
    )
    if (content.length !== expectedLength) {
      throw new Error(
        `[GoogleDrive] Invalid part body length: expected ${expectedLength}, got ${content.length}`,
      )
    }
    await this.client.uploadResumableChunk(
      session.uploadUrl,
      content,
      start,
      session.size,
    )
  }

  async completeUploadSession(sessionToken: string, md5 = ""): Promise<void> {
    const session = decodeUploadSession(sessionToken)
    const normalizedMd5 = String(md5 || "")
      .trim()
      .toLowerCase()
    const requestedMd5 = /^[a-f0-9]{32}$/.test(normalizedMd5)
      ? normalizedMd5
      : undefined
    const expectedMd5 = session.expectedMd5 || requestedMd5
    const probe = await this.client.probeResumableUpload(
      session.uploadUrl,
      session.size,
    )
    if (!probe.complete || probe.receivedBytes !== session.size) {
      throw new Error(
        `[GoogleDrive] Upload incomplete: ${probe.receivedBytes}/${session.size} bytes`,
      )
    }
    const remoteMd5 =
      typeof probe.metadata?.md5Checksum === "string"
        ? probe.metadata.md5Checksum.toLowerCase()
        : undefined
    if (remoteMd5 && expectedMd5 && remoteMd5 !== expectedMd5) {
      throw new Error("[GoogleDrive] Completed upload MD5 mismatch")
    }
  }

  async put(
    _virtualPath: string,
    physicalPath: string,
    content: Buffer,
  ): Promise<void> {
    const { parentId, name } =
      await this.client.resolveParentAndName(physicalPath)
    await this.client.putFile(parentId, name, content)
  }
}
