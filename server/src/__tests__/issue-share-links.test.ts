import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  assets,
  authUsers,
  companies,
  createDb,
  documents,
  heartbeatRuns,
  issueAttachments,
  issueComments,
  issueDocuments,
  issueRelations,
  issueShareLinks,
  issueWorkProducts,
  issues,
} from "@tickernelz/wardmote-db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createStorageService } from "../storage/service.js";
import { issueRoutes } from "../routes/issues.js";
import { publicIssueShareRoutes } from "../routes/public-issue-share.js";
import { errorHandler } from "../middleware/index.js";
import { createInviteRateLimiter } from "../services/invite-rate-limit.js";
import { issueService } from "../services/issues.js";
import { issueShareLinkService } from "../services/issue-share-links.js";
import { createIssueShareLiveHub, type IssueShareLiveHub } from "../services/issue-share-live.js";
import { publishLiveEvent } from "../services/live-events.js";
import {
  LOW_TRUST_REVIEW_PRESET,
  applyPublicIssueSharePatch,
  type PublicIssueSharePatchEvent,
  type PublicIssueShareViewEvent,
} from "@tickernelz/wardmote-shared";

const renderDocumentPdfMock = vi.hoisted(() => vi.fn(async () => Buffer.from("%PDF-share")));

vi.mock("../services/document-pdf.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/document-pdf.js")>()),
  renderDocumentPdf: renderDocumentPdfMock,
}));

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

const BASE_URL = "https://share.example.test";
const NOT_FOUND = { error: "Not found" };
const FORBIDDEN_PUBLIC_KEYS = [
  "adapterConfig",
  "adapterType",
  "agentId",
  "annotations",
  "approvals",
  "assigneeAgentId",
  "authorAgentId",
  "authorUserId",
  "budget",
  "budgetMonthlyCents",
  "checkoutRunId",
  "companyId",
  "contextSnapshot",
  "cost",
  "costCents",
  "costs",
  "createdByRunId",
  "executionPolicy",
  "executionRunId",
  "interactions",
  "metadata",
  "objectKey",
  "provider",
  "runId",
  "runtimeConfig",
  "sha256",
  "sourceTrust",
  "spentMonthlyCents",
  "usageJson",
];

function deepKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) deepKeys(entry, keys);
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      keys.add(key);
      deepKeys(entry, keys);
    }
  }
  return keys;
}

describeEmbeddedPostgres("public issue share links", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  let storage: ReturnType<typeof createStorageService>;
  let fixtureNumber = 0;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("issue-share-links-");
    db = createDb(temporary.connectionString);
    root = await mkdtemp(path.join(tmpdir(), "issue-share-links-"));
    storage = createStorageService(createLocalDiskStorageProvider(path.join(root, "storage")));
  }, 120_000);

  afterAll(async () => {
    await temporary?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  });

  function createApp(
    actor: () => Express.Request["actor"],
    limits: { notFound?: number; requests?: number; live?: IssueShareLiveHub } = {},
  ) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor();
      next();
    });
    app.use("/api", issueRoutes(db, storage, { publicBaseUrl: BASE_URL }));
    app.use(
      "/api",
      publicIssueShareRoutes(db, storage, {
        notFoundLimiter: createInviteRateLimiter({ maxRequests: limits.notFound ?? 1_000, windowMs: 60_000 }),
        requestLimiter: createInviteRateLimiter({ maxRequests: limits.requests ?? 1_000, windowMs: 60_000 }),
        live: limits.live,
      }),
    );
    app.use(errorHandler);
    return app;
  }

  function board(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "local-board",
      source: "local_implicit",
      companyIds: [companyId],
      isInstanceAdmin: false,
    };
  }

  function agent(companyId: string, agentId: string, runId: string | null): Express.Request["actor"] {
    return { type: "agent", agentId, companyId, runId, source: "agent_jwt" };
  }

  async function attach(input: {
    companyId: string;
    issueId: string;
    commentId?: string | null;
    filename: string;
    contentType: string;
    body: string;
  }) {
    const stored = await storage.putFile({
      companyId: input.companyId,
      namespace: `issues/${input.issueId}`,
      originalFilename: input.filename,
      contentType: input.contentType,
      body: Buffer.from(input.body),
    });
    const [asset] = await db.insert(assets).values({
      companyId: input.companyId,
      provider: stored.provider,
      objectKey: stored.objectKey,
      contentType: stored.contentType,
      byteSize: stored.byteSize,
      sha256: stored.sha256,
      originalFilename: input.filename,
    }).returning();
    const [attachment] = await db.insert(issueAttachments).values({
      companyId: input.companyId,
      issueId: input.issueId,
      assetId: asset!.id,
      issueCommentId: input.commentId ?? null,
    }).returning();
    return { assetId: asset!.id, attachmentId: attachment!.id };
  }

  async function seed() {
    fixtureNumber += 1;
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const userId = `user-${randomUUID()}`;
    const prefix = `SHR${fixtureNumber}${randomUUID().slice(0, 4).toUpperCase().replace(/[^A-Z]/g, "X")}`;
    await db.insert(companies).values([
      { id: companyId, name: "Share Co", issuePrefix: prefix, issueCounter: 1 },
      { id: otherCompanyId, name: "Other Co", issuePrefix: `${prefix}O`, issueCounter: 1 },
    ]);
    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "Wira",
        adapterType: "process",
        adapterConfig: { command: "SECRET_ADAPTER" },
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
        budgetMonthlyCents: 5000,
        status: "active",
      },
      {
        id: otherAgentId,
        companyId: otherCompanyId,
        name: "Stranger",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
        status: "active",
      },
    ]);
    await db.insert(authUsers).values({
      id: userId,
      name: "Dina",
      email: `${userId}@example.test`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const ids = {
      parent: randomUUID(),
      root: randomUUID(),
      child: randomUUID(),
      grandchild: randomUUID(),
      blocker: randomUUID(),
      blocked: randomUUID(),
      hiddenChild: randomUUID(),
      unrelated: randomUUID(),
    };
    let number = 0;
    const issue = (id: string, title: string, extra: Partial<typeof issues.$inferInsert> = {}) => {
      number += 1;
      return { id, companyId, title, issueNumber: number, identifier: `${prefix}-${number}`, status: "todo", ...extra };
    };
    await db.insert(issues).values([
      issue(ids.parent, "Umbrella"),
      issue(ids.root, "Shared request", { parentId: ids.parent, assigneeAgentId: agentId, description: "Please build it" }),
      issue(ids.child, "Child step", { parentId: ids.root }),
      issue(ids.grandchild, "Grandchild step", { parentId: ids.child }),
      issue(ids.blocker, "Blocker"),
      issue(ids.blocked, "Blocked later"),
      issue(ids.hiddenChild, "Hidden child", { parentId: ids.root, hiddenAt: new Date() }),
      issue(ids.unrelated, "Unrelated"),
    ]);
    await db.insert(issueRelations).values([
      { companyId, issueId: ids.blocker, relatedIssueId: ids.root, type: "blocks" },
      { companyId, issueId: ids.root, relatedIssueId: ids.blocked, type: "blocks" },
    ]);
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      startedAt: new Date(),
      contextSnapshot: { issueId: ids.root },
      stdoutExcerpt: "TRANSCRIPT_SECRET",
      resultJson: { summary: "RESULT_SECRET" },
    });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, ids.root));
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 7, 8, minute));
    const comments = {
      agent: randomUUID(),
      derived: randomUUID(),
      visibleHuman: randomUUID(),
      privateHuman: randomUUID(),
      system: randomUUID(),
      notice: randomUUID(),
      deleted: randomUUID(),
    };
    await db.insert(issueComments).values([
      { id: comments.agent, companyId, issueId: ids.root, authorType: "agent", authorAgentId: agentId, body: "AGENT_BODY", createdAt: at(1) },
      { id: comments.derived, companyId, issueId: ids.root, authorType: "user", authorUserId: "local-board", derivedAuthorAgentId: agentId, derivedAuthorSource: "run_log", body: "DERIVED_BODY", createdAt: at(2) },
      { id: comments.visibleHuman, companyId, issueId: ids.root, authorType: "user", authorUserId: userId, publicShareVisible: true, body: "VISIBLE_HUMAN_BODY", createdAt: at(3) },
      { id: comments.privateHuman, companyId, issueId: ids.root, authorType: "user", authorUserId: userId, body: "PRIVATE_HUMAN_BODY", createdAt: at(4) },
      { id: comments.system, companyId, issueId: ids.root, authorType: "system", body: "SYSTEM_BODY", createdAt: at(5) },
      { id: comments.notice, companyId, issueId: ids.root, authorType: "agent", authorAgentId: agentId, presentation: { kind: "system_notice", tone: "neutral" }, body: "NOTICE_BODY", createdAt: at(6) },
      { id: comments.deleted, companyId, issueId: ids.root, authorType: "agent", authorAgentId: agentId, body: "DELETED_BODY", deletedAt: at(7), createdAt: at(7) },
    ]);
    const files = {
      agentFile: await attach({ companyId, issueId: ids.root, commentId: comments.agent, filename: "page.html", contentType: "text/html", body: "<script>x</script>" }),
      privateFile: await attach({ companyId, issueId: ids.root, commentId: comments.privateHuman, filename: "private.txt", contentType: "text/plain", body: "private" }),
      issueFile: await attach({ companyId, issueId: ids.root, filename: "brief.txt", contentType: "text/plain", body: "brief" }),
      unrelatedFile: await attach({ companyId, issueId: ids.unrelated, filename: "other.txt", contentType: "text/plain", body: "other" }),
      orphanFile: await attach({ companyId, issueId: ids.root, filename: "orphan.txt", contentType: "text/plain", body: "orphan" }),
    };
    const cancelledCommentId = randomUUID();
    await db.insert(issueComments).values({ id: cancelledCommentId, companyId, issueId: ids.root, authorType: "user", authorUserId: userId, body: "CANCELLED_BODY", createdAt: at(8) });
    await db
      .update(issueAttachments)
      .set({ createdAt: new Date("2026-01-01T00:00:00.000Z"), updatedAt: new Date("2026-01-01T00:00:00.000Z") })
      .where(eq(issueAttachments.id, files.orphanFile.attachmentId));
    await db
      .update(issueAttachments)
      .set({ issueCommentId: cancelledCommentId, updatedAt: new Date() })
      .where(eq(issueAttachments.id, files.orphanFile.attachmentId));
    await db.delete(issueComments).where(eq(issueComments.id, cancelledCommentId));
    await db.insert(issueWorkProducts).values([
      { companyId, issueId: ids.root, type: "preview_url", provider: "custom", title: "Preview", status: "active", url: "https://preview.example.test/app", metadata: { internal: "WP_META" } },
      { companyId, issueId: ids.root, type: "branch", provider: "custom", title: "Branch", status: "active", url: "javascript:alert(1)" },
      { companyId, issueId: ids.root, type: "artifact", provider: "wardmote", title: "Report", status: "active", metadata: { attachmentId: files.issueFile.attachmentId } },
      { companyId, issueId: ids.root, type: "artifact", provider: "wardmote", title: "Private report", status: "active", metadata: { attachmentId: files.privateFile.attachmentId } },
      { companyId, issueId: ids.root, type: "artifact", provider: "wardmote", title: "Orphan report", status: "active", metadata: { attachmentId: files.orphanFile.attachmentId } },
    ]);
    return { companyId, otherCompanyId, agentId, otherAgentId, userId, runId, ids, comments, files };
  }

  type StreamEvent = { event: string; id: string | null; data: string };

  async function openStream(app: express.Express, token: string, headers: Record<string, string> = {}) {
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/api/public/share/${token}/events`, {
      headers,
      signal: controller.signal,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let ended = false;
    async function next(): Promise<StreamEvent | null> {
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const fields = new Map(block.split("\n").map((line) => {
            const colon = line.indexOf(": ");
            return [line.slice(0, colon), line.slice(colon + 2)] as const;
          }));
          if (!fields.has("event") || fields.get("event") === "ping") continue;
          return { event: fields.get("event")!, id: fields.get("id") ?? null, data: fields.get("data") ?? "" };
        }
        if (ended) return null;
        const chunk = await reader.read();
        if (chunk.done) ended = true;
        else buffer += decoder.decode(chunk.value, { stream: true });
      }
    }
    async function close() {
      controller.abort();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    return { status: response.status, next, close };
  }

  function liveHub(options: Partial<Parameters<typeof createIssueShareLiveHub>[0]> = {}) {
    const shares = issueShareLinkService(db);
    return createIssueShareLiveHub({
      resolve: shares.resolve,
      liveTokens: shares.liveTokens,
      buildView: shares.buildView,
      coalesceMs: 20,
      ...options,
    });
  }

  async function share(seeded: Awaited<ReturnType<typeof seed>>, app = createApp(() => board(seeded.companyId))) {
    const response = await request(app).post(`/api/issues/${seeded.ids.root}/share-link`).expect(201);
    return response.body.token as string;
  }

  it("creates one link per issue idempotently and logs only the first creation", async () => {
    const seeded = await seed();
    const app = createApp(() => agent(seeded.companyId, seeded.agentId, seeded.runId));
    const first = await request(app).post(`/api/issues/${seeded.ids.root}/share-link`).expect(201);
    const second = await request(app).post(`/api/issues/${seeded.ids.root}/share-link`).expect(200);
    expect(first.body.url).toMatch(/^https:\/\/share\.example\.test\/s\/[0-9A-Za-z]{10}$/);
    expect(second.body.token).toBe(first.body.token);
    expect(second.body.url).toBe(first.body.url);
    const fetched = await request(app).get(`/api/issues/${seeded.ids.root}/share-link`).expect(200);
    expect(fetched.body.token).toBe(first.body.token);
    const created = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(eq(activityLog.entityId, seeded.ids.root), eq(activityLog.action, "issue.share_link_created")));
    expect(created).toHaveLength(1);
  });

  it("hides another company's issue from an agent", async () => {
    const seeded = await seed();
    const app = createApp(() => agent(seeded.otherCompanyId, seeded.otherAgentId, null));
    await request(app).post(`/api/issues/${seeded.ids.root}/share-link`).expect(404);
    await request(app).get(`/api/issues/${seeded.ids.root}/share-link`).expect(404);
    await request(app).delete(`/api/issues/${seeded.ids.root}/share-link`).expect(404);
  });

  it("lets any company agent create and revoke a link while another agent's run holds the checkout", async () => {
    const seeded = await seed();
    const [holder] = await db
      .insert(agents)
      .values({ companyId: seeded.companyId, name: "Arif", adapterType: "process", adapterConfig: {}, status: "active" })
      .returning();
    const [holderRun] = await db
      .insert(heartbeatRuns)
      .values({ companyId: seeded.companyId, agentId: holder!.id, status: "running", startedAt: new Date(), contextSnapshot: { issueId: seeded.ids.root } })
      .returning();
    await db
      .update(issues)
      .set({ status: "in_progress", assigneeAgentId: holder!.id, checkoutRunId: holderRun!.id, executionRunId: holderRun!.id })
      .where(eq(issues.id, seeded.ids.root));
    const app = createApp(() => agent(seeded.companyId, seeded.agentId, seeded.runId));
    const created = await request(app).post(`/api/issues/${seeded.ids.root}/share-link`).expect(201);
    const fetched = await request(app).get(`/api/issues/${seeded.ids.root}/share-link`).expect(200);
    expect(fetched.body.token).toBe(created.body.token);
    await request(app).delete(`/api/issues/${seeded.ids.root}/share-link`).expect(204);
    await request(app).get(`/api/public/share/${created.body.token}`).expect(404);
    const logged = await db
      .select({ action: activityLog.action, agentId: activityLog.agentId })
      .from(activityLog)
      .where(eq(activityLog.entityId, seeded.ids.root));
    expect(logged).toEqual(
      expect.arrayContaining([
        { action: "issue.share_link_created", agentId: seeded.agentId },
        { action: "issue.share_link_revoked", agentId: seeded.agentId },
      ]),
    );
    const [held] = await db
      .select({ checkoutRunId: issues.checkoutRunId, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, seeded.ids.root));
    expect(held).toEqual({ checkoutRunId: holderRun!.id, assigneeAgentId: holder!.id });
    const boardApp = createApp(() => board(seeded.companyId));
    await request(boardApp).post(`/api/issues/${seeded.ids.root}/share-link`).expect(201);
    await request(boardApp).delete(`/api/issues/${seeded.ids.root}/share-link`).expect(204);
  });

  it("rejects an agent that cannot read the issue", async () => {
    const seeded = await seed();
    const trustBoundary = {
      mode: LOW_TRUST_REVIEW_PRESET,
      companyId: seeded.companyId,
      rootIssueId: seeded.ids.unrelated,
      issueIds: [seeded.ids.unrelated],
    };
    const [restricted] = await db
      .insert(agents)
      .values({
        companyId: seeded.companyId,
        name: "Restricted",
        adapterType: "process",
        adapterConfig: {},
        status: "active",
        permissions: { trustPreset: LOW_TRUST_REVIEW_PRESET, authorizationPolicy: { trustBoundary } },
      })
      .returning();
    const [restrictedRun] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: seeded.companyId,
        agentId: restricted!.id,
        status: "running",
        startedAt: new Date(),
        contextSnapshot: { issueId: seeded.ids.unrelated, executionPolicy: { authorizationPolicy: { trustBoundary } } },
      })
      .returning();
    await share(seeded);
    const app = createApp(() => agent(seeded.companyId, restricted!.id, restrictedRun!.id));
    await request(app).get(`/api/issues/${seeded.ids.root}/share-link`).expect(404);
    await request(app).post(`/api/issues/${seeded.ids.root}/share-link`).expect(404);
    await request(app).delete(`/api/issues/${seeded.ids.root}/share-link`).expect(404);
    const boardApp = createApp(() => board(seeded.companyId));
    const still = await request(boardApp).get(`/api/issues/${seeded.ids.root}/share-link`).expect(200);
    expect(still.body).not.toBeNull();
  });

  it("projects comments by the share rules and leaks no internal data", async () => {
    const seeded = await seed();
    const token = await share(seeded);
    const app = createApp(() => ({ type: "none", source: "none" }));
    const response = await request(app).get(`/api/public/share/${token}`).expect(200);
    const view = response.body;
    expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(Object.keys(view).sort()).toEqual(["activeRun", "attachments", "comments", "company", "documents", "issue", "workProducts"]);
    expect(view.issue).toMatchObject({ title: "Shared request", description: "Please build it", assignee: { kind: "agent", name: "Wira" } });
    expect(view.activeRun).toMatchObject({ agentName: "Wira" });
    const byId = new Map(view.comments.map((comment: { id: string }) => [comment.id, comment]));
    expect(byId.get(seeded.comments.agent)).toMatchObject({ kind: "comment", body: "AGENT_BODY", author: { kind: "agent", name: "Wira" } });
    expect(byId.get(seeded.comments.derived)).toMatchObject({ kind: "comment", body: "DERIVED_BODY", author: { kind: "agent", name: "Wira" } });
    expect(byId.get(seeded.comments.visibleHuman)).toMatchObject({ kind: "comment", body: "VISIBLE_HUMAN_BODY", author: { kind: "user", name: "Dina" } });
    expect(byId.get(seeded.comments.privateHuman)).toEqual({
      id: seeded.comments.privateHuman,
      kind: "redacted",
      author: { kind: "user", name: "Dina", iconUrl: null },
      createdAt: expect.any(String),
    });
    for (const omitted of [seeded.comments.system, seeded.comments.notice, seeded.comments.deleted]) {
      expect(byId.has(omitted)).toBe(false);
    }
    expect(byId.get(seeded.comments.agent)).toMatchObject({
      attachments: [{ id: seeded.files.agentFile.attachmentId, url: `/api/public/share/${token}/attachments/${seeded.files.agentFile.attachmentId}/content` }],
    });
    expect(view.attachments.map((entry: { id: string }) => entry.id)).toEqual([seeded.files.issueFile.attachmentId]);
    expect(view.workProducts).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Preview", url: "https://preview.example.test/app", downloadUrl: null }),
      expect.objectContaining({ title: "Branch", url: null }),
      expect.objectContaining({
        title: "Report",
        downloadUrl: `/api/public/share/${token}/assets/${seeded.files.issueFile.assetId}/content`,
        file: { filename: "brief.txt", contentType: "text/plain", byteSize: 5 },
      }),
    ]));
    const raw = JSON.stringify(view);
    for (const secret of ["PRIVATE_HUMAN_BODY", "SYSTEM_BODY", "NOTICE_BODY", "DELETED_BODY", "TRANSCRIPT_SECRET", "RESULT_SECRET", "SECRET_ADAPTER", "WP_META", "private.txt", "Private report", "orphan.txt", "Orphan report", "CANCELLED_BODY"]) {
      expect(raw).not.toContain(secret);
    }
    const keys = deepKeys(view);
    expect(FORBIDDEN_PUBLIC_KEYS.filter((key) => keys.has(key))).toEqual([]);
    const urls = raw.match(/"(?:url|pdfUrl|downloadUrl|logoUrl)":"[^"]+"/g) ?? [];
    for (const entry of urls.filter((value) => !value.includes("preview.example.test"))) {
      expect(entry).toContain(`"/api/public/share/${token}/`);
    }
  });

  it("shows only the shared issue and serves nothing from its parent, children or blocking issues", async () => {
    const seeded = await seed();
    const neighbours = [seeded.ids.parent, seeded.ids.child, seeded.ids.blocker, seeded.ids.blocked];
    const neighbourFiles: Array<{ assetId: string; attachmentId: string }> = [];
    for (const issueId of neighbours) {
      const file = await attach({ companyId: seeded.companyId, issueId, filename: "neighbour.txt", contentType: "text/plain", body: "neighbour" });
      await db.insert(issueWorkProducts).values({ companyId: seeded.companyId, issueId, type: "artifact", provider: "wardmote", title: "Neighbour report", status: "active", metadata: { attachmentId: file.attachmentId } });
      const [document] = await db
        .insert(documents)
        .values({ companyId: seeded.companyId, title: "Neighbour spec", latestBody: "NEIGHBOUR_DOC" })
        .returning();
      await db.insert(issueDocuments).values({ companyId: seeded.companyId, issueId, documentId: document!.id, key: "spec" });
      neighbourFiles.push(file);
    }
    const token = await share(seeded);
    const app = createApp(() => ({ type: "none", source: "none" }));
    const response = await request(app).get(`/api/public/share/${token}`).expect(200);
    expect(response.body.issue.id).toBe(seeded.ids.root);
    for (const leaked of ["Umbrella", "Child step", "Blocker", "NEIGHBOUR_DOC", "neighbour.txt", ...neighbours]) {
      expect(response.text).not.toContain(leaked);
    }
    for (const id of [seeded.ids.root, ...neighbours, seeded.ids.grandchild, seeded.ids.hiddenChild, seeded.ids.unrelated]) {
      expect((await request(app).get(`/api/public/share/${token}/issues/${id}`).expect(404)).body.issue).toBeUndefined();
    }
    for (const id of neighbours) {
      expect((await request(app).get(`/api/public/share/${token}/issues/${id}/documents/spec/pdf`).expect(404)).body).toEqual(NOT_FOUND);
    }
    for (const file of [...neighbourFiles, seeded.files.unrelatedFile]) {
      expect((await request(app).get(`/api/public/share/${token}/attachments/${file.attachmentId}/content`).expect(404)).body).toEqual(NOT_FOUND);
      expect((await request(app).get(`/api/public/share/${token}/assets/${file.assetId}/content`).expect(404)).body).toEqual(NOT_FOUND);
    }
  });

  it("returns the same 404 for unknown, revoked and hidden shares", async () => {
    const seeded = await seed();
    const boardApp = createApp(() => board(seeded.companyId));
    const anonymous = createApp(() => ({ type: "none", source: "none" }));
    const revokedToken = await share(seeded, boardApp);
    await request(boardApp).delete(`/api/issues/${seeded.ids.root}/share-link`).expect(204);
    const hidden = await seed();
    const hiddenToken = await share(hidden);
    await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, hidden.ids.root));
    const bodies = [];
    for (const token of ["ZZZZZZZZZZ", revokedToken, hiddenToken, "short"]) {
      const response = await request(anonymous).get(`/api/public/share/${token}`).expect(404);
      bodies.push(response.body);
    }
    expect(bodies).toEqual([NOT_FOUND, NOT_FOUND, NOT_FOUND, NOT_FOUND]);
    const renewed = await request(boardApp).post(`/api/issues/${seeded.ids.root}/share-link`).expect(201);
    expect(renewed.body.token).not.toBe(revokedToken);
  });

  it("serves only visible files and stops serving them after revoke", async () => {
    const seeded = await seed();
    const boardApp = createApp(() => board(seeded.companyId));
    const token = await share(seeded, boardApp);
    const anonymous = createApp(() => ({ type: "none", source: "none" }));
    const visible = await request(anonymous)
      .get(`/api/public/share/${token}/attachments/${seeded.files.agentFile.attachmentId}/content`)
      .expect(200);
    expect(visible.headers["x-content-type-options"]).toBe("nosniff");
    expect(visible.headers["content-security-policy"]).toBe("sandbox; default-src 'none'");
    expect(visible.headers["content-disposition"]).toMatch(/^attachment;/);
    expect(visible.headers["cache-control"]).toBe("private, max-age=60");
    expect(visible.headers["x-robots-tag"]).toBe("noindex, nofollow");
    const redacted = await request(anonymous)
      .get(`/api/public/share/${token}/attachments/${seeded.files.privateFile.attachmentId}/content`)
      .expect(404);
    expect(redacted.body).toEqual(NOT_FOUND);
    await request(anonymous)
      .get(`/api/public/share/${token}/assets/${seeded.files.issueFile.assetId}/content`)
      .expect(200);
    await request(anonymous)
      .get(`/api/public/share/${token}/assets/${seeded.files.privateFile.assetId}/content`)
      .expect(404);
    await request(anonymous)
      .get(`/api/public/share/${token}/attachments/${seeded.files.orphanFile.attachmentId}/content`)
      .expect(404);
    await request(anonymous)
      .get(`/api/public/share/${token}/assets/${seeded.files.orphanFile.assetId}/content`)
      .expect(404);
    await request(boardApp).delete(`/api/issues/${seeded.ids.root}/share-link`).expect(204);
    for (const url of [
      `/api/public/share/${token}/attachments/${seeded.files.agentFile.attachmentId}/content`,
      `/api/public/share/${token}/assets/${seeded.files.issueFile.assetId}/content`,
    ]) {
      expect((await request(anonymous).get(url).expect(404)).body).toEqual(NOT_FOUND);
    }
    const revoked = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(eq(activityLog.entityId, seeded.ids.root), eq(activityLog.action, "issue.share_link_revoked")));
    expect(revoked).toHaveLength(1);
  });

  it("keeps files of a hard-deleted comment off the public link", async () => {
    const seeded = await seed();
    const token = await share(seeded);
    const anonymous = createApp(() => ({ type: "none", source: "none" }));
    const commentId = randomUUID();
    await db.insert(issueComments).values({ id: commentId, companyId: seeded.companyId, issueId: seeded.ids.root, authorType: "user", authorUserId: seeded.userId, body: "QUEUED_BODY" });
    const file = await attach({ companyId: seeded.companyId, issueId: seeded.ids.root, commentId, filename: "queued.txt", contentType: "text/plain", body: "queued" });
    expect(await issueService(db).removeComment(commentId)).not.toBeNull();
    const view = (await request(anonymous).get(`/api/public/share/${token}`).expect(200)).body;
    expect(JSON.stringify(view)).not.toContain("queued.txt");
    await request(anonymous)
      .get(`/api/public/share/${token}/attachments/${file.attachmentId}/content`)
      .expect(404);
  });

  it("serves a visible document as PDF until the link is revoked", async () => {
    const seeded = await seed();
    const boardApp = createApp(() => board(seeded.companyId));
    const anonymous = createApp(() => ({ type: "none", source: "none" }));
    const [document] = await db
      .insert(documents)
      .values({ companyId: seeded.companyId, title: "Spec", latestBody: "# Spec body" })
      .returning();
    await db.insert(issueDocuments).values({ companyId: seeded.companyId, issueId: seeded.ids.root, documentId: document!.id, key: "spec" });
    const token = await share(seeded, boardApp);
    const view = (await request(anonymous).get(`/api/public/share/${token}`).expect(200)).body;
    const pdfUrl = `/api/public/share/${token}/issues/${seeded.ids.root}/documents/spec/pdf`;
    expect(view.documents).toEqual([expect.objectContaining({ key: "spec", body: "# Spec body", pdfUrl })]);
    const pdf = await request(anonymous).get(pdfUrl).expect(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(renderDocumentPdfMock).toHaveBeenCalledWith(expect.objectContaining({ title: "Spec", markdown: "# Spec body" }));
    await request(anonymous)
      .get(`/api/public/share/${token}/issues/${seeded.ids.unrelated}/documents/spec/pdf`)
      .expect(404);
    await request(boardApp).delete(`/api/issues/${seeded.ids.root}/share-link`).expect(204);
    expect((await request(anonymous).get(pdfUrl).expect(404)).body).toEqual(NOT_FOUND);
  });

  it("lets only the board reveal a person's comment on the public link", async () => {
    const seeded = await seed();
    const boardApp = createApp(() => board(seeded.companyId));
    const agentApp = createApp(() => agent(seeded.companyId, seeded.agentId, seeded.runId));
    const anonymous = createApp(() => ({ type: "none", source: "none" }));
    const token = await share(seeded, boardApp);
    const path = `/api/issues/${seeded.ids.root}/comments/${seeded.comments.privateHuman}/public-share`;
    await request(agentApp).patch(path).send({ visible: true }).expect(403);
    await request(boardApp)
      .patch(`/api/issues/${seeded.ids.root}/comments/${seeded.comments.agent}/public-share`)
      .send({ visible: true })
      .expect(422);
    const updated = await request(boardApp).patch(path).send({ visible: true }).expect(200);
    expect(updated.body).toMatchObject({ id: seeded.comments.privateHuman, publicShareVisible: true });
    const listed = await request(boardApp).get(`/api/issues/${seeded.ids.root}/comments`).expect(200);
    expect(listed.body.find((comment: { id: string }) => comment.id === seeded.comments.privateHuman))
      .toMatchObject({ publicShareVisible: true });
    const view = (await request(anonymous).get(`/api/public/share/${token}`).expect(200)).body;
    expect(view.comments.find((comment: { id: string }) => comment.id === seeded.comments.privateHuman))
      .toMatchObject({ kind: "comment", body: "PRIVATE_HUMAN_BODY" });
    await request(anonymous)
      .get(`/api/public/share/${token}/attachments/${seeded.files.privateFile.attachmentId}/content`)
      .expect(200);
    expect(view.workProducts).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Private report", downloadUrl: `/api/public/share/${token}/assets/${seeded.files.privateFile.assetId}/content` }),
    ]));
    await request(anonymous)
      .get(`/api/public/share/${token}/assets/${seeded.files.privateFile.assetId}/content`)
      .expect(200);
    await request(boardApp).patch(path).send({ visible: false }).expect(200);
    const hiddenAgain = (await request(anonymous).get(`/api/public/share/${token}`).expect(200)).body;
    expect(JSON.stringify(hiddenAgain)).not.toContain("PRIVATE_HUMAN_BODY");
    const toggled = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(eq(activityLog.entityId, seeded.ids.root), eq(activityLog.action, "issue.comment_public_share_updated")));
    expect(toggled).toHaveLength(2);
  });

  it("rate limits failed share lookups per IP without counting successful views", async () => {
    const seeded = await seed();
    const token = await share(seeded);
    const limited = createApp(() => ({ type: "none", source: "none" }), { notFound: 1 });
    await request(limited).get(`/api/public/share/${token}`).expect(200);
    await request(limited).get(`/api/public/share/${token}`).expect(200);
    await request(limited).get("/api/public/share/ZZZZZZZZZZ").expect(404);
    const response = await request(limited).get(`/api/public/share/${token}`).expect(429);
    expect(response.headers["retry-after"]).toBeDefined();
  });

  it("pushes one patch per change to every viewer that rebuilds the public view without hidden bodies", async () => {
    const seeded = await seed();
    const token = await share(seeded);
    const live = liveHub();
    const app = createApp(() => ({ type: "none", source: "none" }), { live });
    const viewers = [await openStream(app, token), await openStream(app, token)];
    try {
      const initial = await viewers[0]!.next();
      expect(initial?.event).toBe("view");
      expect((await viewers[1]!.next())?.event).toBe("view");
      expect(live.stats()).toEqual({ channels: 1, streams: 2 });
      const start = JSON.parse(initial!.data) as PublicIssueShareViewEvent;

      const visibleId = randomUUID();
      const privateId = randomUUID();
      await db.insert(issueComments).values([
        { id: visibleId, companyId: seeded.companyId, issueId: seeded.ids.root, authorType: "agent", authorAgentId: seeded.agentId, body: "LIVE_AGENT_BODY", createdAt: new Date(Date.UTC(2026, 9, 8, 8, 0)) },
        { id: privateId, companyId: seeded.companyId, issueId: seeded.ids.root, authorType: "user", authorUserId: seeded.userId, body: "LIVE_PRIVATE_BODY", createdAt: new Date(Date.UTC(2026, 9, 8, 8, 1)) },
      ]);
      publishLiveEvent({ companyId: seeded.companyId, type: "activity.logged", payload: { issueId: seeded.ids.root } });
      publishLiveEvent({ companyId: seeded.companyId, type: "activity.logged", payload: { issueId: seeded.ids.root } });

      const patches = [await viewers[0]!.next(), await viewers[1]!.next()];
      expect(patches.map((entry) => entry?.event)).toEqual(["patch", "patch"]);
      expect(patches[1]!.data).toBe(patches[0]!.data);
      expect(patches[0]!.data).toContain("LIVE_AGENT_BODY");
      expect(patches[0]!.data).not.toContain("LIVE_PRIVATE_BODY");
      const event = JSON.parse(patches[0]!.data) as PublicIssueSharePatchEvent;
      expect(event.base).toBe(start.etag);
      expect(event.patch.comments?.upsert?.map((comment) => [comment.id, comment.kind])).toEqual([
        [visibleId, "comment"],
        [privateId, "redacted"],
      ]);

      const fresh = await request(app).get(`/api/public/share/${token}`).expect(200);
      expect(fresh.headers.etag).toBe(`W/"${event.etag}"`);
      expect(applyPublicIssueSharePatch(start.view, event.patch)).toEqual(fresh.body);
    } finally {
      await Promise.all(viewers.map((viewer) => viewer.close()));
      live.close();
    }
  });

  it("resumes from a known version, answers 304 for it and ends the stream within seconds of a revoke", async () => {
    const seeded = await seed();
    const boardApp = createApp(() => board(seeded.companyId));
    const token = await share(seeded, boardApp);
    const live = liveHub();
    const app = createApp(() => ({ type: "none", source: "none" }), { live });
    const etag = (await request(app).get(`/api/public/share/${token}`).expect(200)).headers.etag as string;
    await request(app).get(`/api/public/share/${token}`).set("If-None-Match", etag).expect(304);
    const stream = await openStream(app, token, { "Last-Event-ID": etag.slice(3, -1) });
    try {
      expect((await stream.next())?.event).toBe("ready");
      const revokedAt = Date.now();
      await request(boardApp).delete(`/api/issues/${seeded.ids.root}/share-link`).expect(204);
      expect((await stream.next())?.event).toBe("gone");
      expect(await stream.next()).toBeNull();
      expect(Date.now() - revokedAt).toBeLessThan(5_000);
      expect(live.stats()).toEqual({ channels: 0, streams: 0 });
      await request(app).get(`/api/public/share/${token}/events`).expect(404);
    } finally {
      await stream.close();
      live.close();
    }
  });

  it("closes the stream of a task hidden without any live event and caps viewers per link", async () => {
    const seeded = await seed();
    const token = await share(seeded);
    const live = liveHub({ tickMs: 100, limits: { streamsPerToken: 1 } });
    const app = createApp(() => ({ type: "none", source: "none" }), { live });
    const stream = await openStream(app, token);
    try {
      expect((await stream.next())?.event).toBe("view");
      const refused = await request(app).get(`/api/public/share/${token}/events`).expect(429);
      expect(refused.headers["retry-after"]).toBeDefined();
      const hiddenAt = Date.now();
      await db.update(issues).set({ hiddenAt: new Date() }).where(eq(issues.id, seeded.ids.root));
      expect((await stream.next())?.event).toBe("gone");
      expect(Date.now() - hiddenAt).toBeLessThan(2_000);
      expect(await stream.next()).toBeNull();
    } finally {
      await stream.close();
      live.close();
    }
  });

  it("holds the viewer cap when many viewers connect at the same moment", async () => {
    const seeded = await seed();
    const token = await share(seeded);
    const live = liveHub({ limits: { streamsPerToken: 3 } });
    const server = createApp(() => ({ type: "none", source: "none" }), { live }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const controller = new AbortController();
    try {
      const responses = await Promise.all(Array.from({ length: 10 }, () =>
        fetch(`http://127.0.0.1:${port}/api/public/share/${token}/events`, { signal: controller.signal })));
      expect(responses.filter((response) => response.status === 200)).toHaveLength(3);
      expect(responses.filter((response) => response.status === 429)).toHaveLength(7);
      expect(live.stats().streams).toBe(3);
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      live.close();
    }
  });

  it("frees the slot of a viewer that leaves before the link resolves", async () => {
    const seeded = await seed();
    const token = await share(seeded);
    const live = liveHub();
    const server = createApp(() => ({ type: "none", source: "none" }), { live }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const lock = db.transaction(async (tx) => {
      await tx.execute(sql`lock table ${issueShareLinks} in access exclusive mode`);
      locked();
      await held;
    });
    try {
      await lockTaken;
      const controller = new AbortController();
      const pending = fetch(`http://127.0.0.1:${port}/api/public/share/${token}/events`, {
        signal: controller.signal,
      }).catch(() => null);
      await pause(200);
      controller.abort();
      await pending;
      await pause(100);
      release();
      await lock;
      await pause(300);
      expect(live.stats().streams).toBe(0);
    } finally {
      release();
      await lock;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      live.close();
    }
  });

  it("caps requests per share token and IP", async () => {
    const seeded = await seed();
    const token = await share(seeded);
    const other = await share(await seed());
    const limited = createApp(() => ({ type: "none", source: "none" }), { requests: 1 });
    await request(limited).get(`/api/public/share/${token}`).expect(200);
    await request(limited).get(`/api/public/share/${other}`).expect(200);
    const response = await request(limited).get(`/api/public/share/${token}`).expect(429);
    expect(response.headers["retry-after"]).toBeDefined();
  });
});
