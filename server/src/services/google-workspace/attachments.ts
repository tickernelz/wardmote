import { and, eq } from "drizzle-orm";
import type { Db } from "@tickernelz/wardmote-db";
import { assets, issueAttachments } from "@tickernelz/wardmote-db";

import { getStorageService } from "../../storage/index.js";
import type { StorageService } from "../../storage/types.js";
import { assetService } from "../assets.js";
import { GoogleWorkspaceError } from "./errors.js";
import type { GoogleCallContext } from "./executor.js";

export interface GoogleAttachmentScope {
  companyId: string;
  issueId: string | null;
  runId: string | null;
  agentId: string | null;
}

async function readLimited(stream: NodeJS.ReadableStream, maxBytes: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > maxBytes) throw new GoogleWorkspaceError("validation", `The attachment is larger than ${maxBytes} bytes`, "Upload a smaller file.", { pointer: "/upload/attachmentId" });
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readHead(stream: AsyncIterable<unknown> & { destroy?: () => void }, bytes: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    chunks.push(buffer);
    size += buffer.length;
    if (size >= bytes) break;
  }
  stream.destroy?.();
  return Buffer.concat(chunks).subarray(0, bytes);
}

export function googleWorkspaceAttachments(db: Db, scope: GoogleAttachmentScope, storage: StorageService = getStorageService()): GoogleCallContext["attachments"] {
  async function attachmentRow(attachmentId: string) {
    if (!scope.issueId) throw new GoogleWorkspaceError("validation", "Uploads need a task", "Run the call from a task that holds the attachment.", { pointer: "/upload/attachmentId" });
    const [row] = await db
      .select({ objectKey: assets.objectKey, contentType: assets.contentType, byteSize: assets.byteSize, originalFilename: assets.originalFilename })
      .from(issueAttachments)
      .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
      .where(and(eq(issueAttachments.companyId, scope.companyId), eq(issueAttachments.issueId, scope.issueId), eq(issueAttachments.id, attachmentId)))
      .limit(1);
    if (!row) throw new GoogleWorkspaceError("validation", "The attachment is not part of this task", "Attach the file to this task first.", { pointer: "/upload/attachmentId" });
    return row;
  }
  return {
    async head(attachmentId, bytes) {
      const row = await attachmentRow(attachmentId);
      const object = await storage.getObject(scope.companyId, row.objectKey);
      return readHead(object.stream as AsyncIterable<unknown> & { destroy?: () => void }, bytes);
    },
    async read(attachmentId, maxBytes) {
      const row = await attachmentRow(attachmentId);
      if (row.byteSize > maxBytes) throw new GoogleWorkspaceError("validation", `The attachment is larger than ${maxBytes} bytes`, "Upload a smaller file.", { pointer: "/upload/attachmentId" });
      const object = await storage.getObject(scope.companyId, row.objectKey);
      return { bytes: await readLimited(object.stream, maxBytes), contentType: row.contentType || "application/octet-stream", filename: row.originalFilename ?? "attachment" };
    },
    async store(input) {
      if (!scope.issueId) throw new GoogleWorkspaceError("validation", "Downloads need a task", "Run the call from a task so the file can be attached.", { pointer: "/download" });
      const stored = await storage.putFile({
        companyId: scope.companyId,
        namespace: "google-workspace/downloads",
        originalFilename: input.filename,
        contentType: input.contentType,
        body: Buffer.from(input.bytes),
      });
      const asset = await assetService(db).create(scope.companyId, {
        provider: stored.provider,
        objectKey: stored.objectKey,
        contentType: stored.contentType,
        byteSize: stored.byteSize,
        sha256: stored.sha256,
        originalFilename: stored.originalFilename,
        createdByAgentId: scope.agentId,
        createdByUserId: null,
      });
      const [attachment] = await db
        .insert(issueAttachments)
        .values({ companyId: scope.companyId, issueId: scope.issueId, assetId: asset.id, originatingRunId: scope.runId })
        .returning({ id: issueAttachments.id });
      return { attachmentId: attachment.id, byteSize: stored.byteSize, contentType: stored.contentType, filename: stored.originalFilename ?? input.filename };
    },
  };
}
