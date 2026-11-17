import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  chatConversations,
  chatEndpoints,
  companies,
  createDb,
  heartbeatRuns,
  issueAttachments,
  issues,
  toolApplications,
  toolConnections,
} from "@tickernelz/wardmote-db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { CROSS_ISSUE_INFLUENCE_LIMIT } from "../services/cross-issue-influence-limit.js";
import type { StorageService } from "../storage/types.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const storage = {
  provider: "local_disk",
  async putFile(input: { companyId: string; namespace: string; originalFilename: string | null; contentType: string }) {
    return {
      provider: "local_disk",
      objectKey: `${input.companyId}/${input.namespace}/${randomUUID()}`,
      contentType: input.contentType,
      byteSize: 6,
      sha256: "0".repeat(64),
      originalFilename: input.originalFilename,
    };
  },
  async deleteObject() {},
} as unknown as StorageService;

async function seedAgent(db: Db, companyId: string, name: string, role = "engineer") {
  const [agent] = await db
    .insert(agents)
    .values({ companyId, name, role, adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions: {} })
    .returning();
  return agent!;
}

async function seedRun(db: Db, companyId: string, agentId: string, issueId: string, status = "running") {
  const [run] = await db
    .insert(heartbeatRuns)
    .values({
      companyId,
      agentId,
      status,
      startedAt: new Date("2026-11-17T03:57:09.000Z"),
      contextSnapshot: { issueId, taskId: issueId },
    })
    .returning();
  return run!;
}

async function seedFixture(db: Db) {
  const nonce = randomUUID().slice(0, 6).toUpperCase();
  const [company] = await db
    .insert(companies)
    .values({ name: `Additive ${nonce}`, issuePrefix: `AD${nonce.slice(0, 4)}` })
    .returning();
  const companyId = company!.id;
  const conversationAgent = await seedAgent(db, companyId, "Conversation Engineer");
  const peer = await seedAgent(db, companyId, "Peer Engineer");
  const [conversationIssue] = await db
    .insert(issues)
    .values({ companyId, title: "WhatsApp chat", status: "in_progress", priority: "medium", assigneeAgentId: conversationAgent.id })
    .returning();
  const [peerIssue] = await db
    .insert(issues)
    .values({ companyId, title: "Peer task", status: "in_progress", priority: "medium", assigneeAgentId: peer.id })
    .returning();
  const endpointId = randomUUID();
  const [application] = await db
    .insert(toolApplications)
    .values({ companyId, applicationKey: `chat:openwa:${endpointId}`, name: "OpenWA", type: "chat", status: "active" })
    .returning();
  const [connection] = await db
    .insert(toolConnections)
    .values({
      companyId,
      applicationId: application!.id,
      name: "OpenWA channel",
      uid: `chat-openwa-${endpointId}`,
      connectionPurpose: "channel",
      transport: "chat_sdk",
      status: "active",
      enabled: true,
    })
    .returning();
  await db.insert(chatEndpoints).values({
    id: endpointId,
    companyId,
    connectionId: connection!.id,
    provider: "openwa",
    publicId: randomUUID(),
    assignedAgentId: conversationAgent.id,
    status: "active",
  });
  await db.insert(chatConversations).values({
    companyId,
    endpointId,
    issueId: conversationIssue!.id,
    externalConversationId: `openwa:session-1:${nonce}@g.us`,
    externalThreadId: `openwa:session-1:${nonce}@g.us`,
    externalLabel: "General",
    state: "active",
    isDirectMessage: false,
  });
  const peerRun = await seedRun(db, companyId, peer.id, peerIssue!.id);
  return { companyId, conversationAgent, peer, conversationIssue: conversationIssue!, peerIssue: peerIssue!, peerRun };
}

async function holdCheckout(db: Db, fixture: Awaited<ReturnType<typeof seedFixture>>, runStatus: string) {
  const run = await seedRun(db, fixture.companyId, fixture.conversationAgent.id, fixture.conversationIssue.id, runStatus);
  await db
    .update(issues)
    .set({ checkoutRunId: run.id, executionRunId: run.id })
    .where(eq(issues.id, fixture.conversationIssue.id));
  return run;
}

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", issueRoutes(db, storage));
  app.use(errorHandler);
  return app;
}

function peerActor(fixture: Awaited<ReturnType<typeof seedFixture>>, companyId = fixture.companyId): Express.Request["actor"] {
  return {
    type: "agent",
    agentId: fixture.peer.id,
    companyId,
    runId: fixture.peerRun.id,
    source: "agent_jwt",
  };
}

function uploadReport(app: express.Express, companyId: string, issueId: string) {
  return request(app)
    .post(`/api/companies/${companyId}/issues/${issueId}/attachments`)
    .attach("file", Buffer.from("report"), { filename: "report.pdf", contentType: "application/pdf" });
}

describeEmbeddedPostgres("additive writes on another agent's in_progress issue", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("wardmote-additive-writes-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it.each(["running", "succeeded"])(
    "accepts a peer agent's attachment on a WhatsApp conversation issue whose checkout run is %s",
    async (runStatus) => {
      const fixture = await seedFixture(db);
      await holdCheckout(db, fixture, runStatus);

      const res = await uploadReport(createApp(db, peerActor(fixture)), fixture.companyId, fixture.conversationIssue.id);

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.createdByAgentId).toBe(fixture.peer.id);
      const rows = await db
        .select()
        .from(issueAttachments)
        .where(eq(issueAttachments.issueId, fixture.conversationIssue.id));
      expect(rows).toHaveLength(1);
      const observed = await db
        .select({ details: activityLog.details })
        .from(activityLog)
        .where(and(eq(activityLog.runId, fixture.peerRun.id), eq(activityLog.action, "issue.cross_issue_influence_observed")));
      expect(observed).toEqual([{ details: expect.objectContaining({ kind: "artifact", targetIssueId: fixture.conversationIssue.id }) }]);
    },
  );

  it("refuses a peer agent's field change only while the assignee's checkout run is live, naming that run", async () => {
    const fixture = await seedFixture(db);
    const liveRun = await holdCheckout(db, fixture, "running");
    const app = createApp(db, peerActor(fixture));

    const locked = await request(app).patch(`/api/issues/${fixture.conversationIssue.id}`).send({ title: "Renamed" });
    expect(locked.status, JSON.stringify(locked.body)).toBe(409);
    expect(locked.body.details).toMatchObject({
      code: "issue_write_assignee_run_lock",
      checkoutRunId: liveRun.id,
      checkoutRunStartedAt: "2026-11-17T03:57:09.000Z",
    });
    expect(locked.body.error).toContain(liveRun.id);

    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, liveRun.id));
    const afterRun = await request(app).patch(`/api/issues/${fixture.conversationIssue.id}`).send({ title: "Renamed" });
    expect(afterRun.status, JSON.stringify(afterRun.body)).toBe(200);
    const [persisted] = await db
      .select({ title: issues.title })
      .from(issues)
      .where(eq(issues.id, fixture.conversationIssue.id));
    expect(persisted?.title).toBe("Renamed");
  });

  it("still refuses an agent of another company", async () => {
    const fixture = await seedFixture(db);
    const other = await seedFixture(db);

    const res = await uploadReport(
      createApp(db, peerActor(other)),
      fixture.companyId,
      fixture.conversationIssue.id,
    );

    expect(res.status, JSON.stringify(res.body)).toBe(403);
    const rows = await db.select().from(issueAttachments).where(eq(issueAttachments.issueId, fixture.conversationIssue.id));
    expect(rows).toEqual([]);
  });

  it("still refuses once the run's cross-issue write cap is spent", async () => {
    const fixture = await seedFixture(db);
    await holdCheckout(db, fixture, "running");
    await db.insert(activityLog).values(
      Array.from({ length: CROSS_ISSUE_INFLUENCE_LIMIT }, () => ({
        companyId: fixture.companyId,
        actorType: "agent",
        actorId: fixture.peer.id,
        agentId: fixture.peer.id,
        runId: fixture.peerRun.id,
        action: "issue.cross_issue_influence_observed",
        entityType: "issue",
        entityId: fixture.peerIssue.id,
      })),
    );

    const res = await uploadReport(createApp(db, peerActor(fixture)), fixture.companyId, fixture.conversationIssue.id);

    expect(res.status, JSON.stringify(res.body)).toBe(429);
    expect(res.body.details.code).toBe("cross_issue_influence_cap_exceeded");
    const rows = await db.select().from(issueAttachments).where(eq(issueAttachments.issueId, fixture.conversationIssue.id));
    expect(rows).toEqual([]);
  });
});

describeEmbeddedPostgres("additive writes from a second run of the issue's own assignee", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("wardmote-assignee-additive-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function secondRun(fixture: Awaited<ReturnType<typeof seedFixture>>) {
    const [otherIssue] = await db
      .insert(issues)
      .values({
        companyId: fixture.companyId,
        title: "Assignee's other task",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: fixture.conversationAgent.id,
      })
      .returning();
    const run = await seedRun(db, fixture.companyId, fixture.conversationAgent.id, otherIssue!.id);
    const actor: Express.Request["actor"] = {
      type: "agent",
      agentId: fixture.conversationAgent.id,
      companyId: fixture.companyId,
      runId: run.id,
      source: "agent_jwt",
    };
    return { run, app: createApp(db, actor) };
  }

  it("accepts the attachment while the assignee's other run holds the checkout, and leaves that checkout alone", async () => {
    const fixture = await seedFixture(db);
    const holder = await holdCheckout(db, fixture, "running");
    const second = await secondRun(fixture);

    const res = await uploadReport(second.app, fixture.companyId, fixture.conversationIssue.id);

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.createdByAgentId).toBe(fixture.conversationAgent.id);
    const [persisted] = await db
      .select({ checkoutRunId: issues.checkoutRunId, executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, fixture.conversationIssue.id));
    expect(persisted).toEqual({ checkoutRunId: holder.id, executionRunId: holder.id });
    const observed = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.runId, second.run.id), eq(activityLog.action, "issue.cross_issue_influence_observed")));
    expect(observed).toEqual([{ details: expect.objectContaining({ kind: "artifact", targetIssueId: fixture.conversationIssue.id }) }]);
  });

  it("still refuses the second run a field change while the other run holds the checkout", async () => {
    const fixture = await seedFixture(db);
    const holder = await holdCheckout(db, fixture, "running");
    const second = await secondRun(fixture);

    const res = await request(second.app).patch(`/api/issues/${fixture.conversationIssue.id}`).send({ title: "Renamed" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe("Issue run ownership conflict");
    expect(res.body.details).toMatchObject({ checkoutRunId: holder.id, actorRunId: second.run.id });
  });

  it("still refuses the second run's attachment once its cross-issue write cap is spent", async () => {
    const fixture = await seedFixture(db);
    await holdCheckout(db, fixture, "running");
    const second = await secondRun(fixture);
    await db.insert(activityLog).values(
      Array.from({ length: CROSS_ISSUE_INFLUENCE_LIMIT }, () => ({
        companyId: fixture.companyId,
        actorType: "agent",
        actorId: fixture.conversationAgent.id,
        agentId: fixture.conversationAgent.id,
        runId: second.run.id,
        action: "issue.cross_issue_influence_observed",
        entityType: "issue",
        entityId: fixture.peerIssue.id,
      })),
    );

    const res = await uploadReport(second.app, fixture.companyId, fixture.conversationIssue.id);

    expect(res.status, JSON.stringify(res.body)).toBe(429);
    expect(res.body.details.code).toBe("cross_issue_influence_cap_exceeded");
    const rows = await db.select().from(issueAttachments).where(eq(issueAttachments.issueId, fixture.conversationIssue.id));
    expect(rows).toEqual([]);
  });
});
