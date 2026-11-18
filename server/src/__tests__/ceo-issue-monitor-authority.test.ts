import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
  principalPermissionGrants,
  projects,
} from "@tickernelz/wardmote-db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.hoisted(() => {
  process.env.WARDMOTE_HOME = "/tmp/wardmote-test-home";
  process.env.WARDMOTE_INSTANCE_ID = "vitest";
  process.env.WARDMOTE_LOG_DIR = "/tmp/wardmote-test-home/logs";
  process.env.WARDMOTE_IN_WORKTREE = "false";
  process.env.WARDMOTE_AGENT_JWT_SECRET = "ceo-issue-monitor-secret";
  process.env.WARDMOTE_AGENT_JWT_TTL_SECONDS = "3600";
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

const MONITOR_FORBIDDEN =
  "Only the assignee agent, a CEO or manager agent of its assignee, or a board user can manage issue monitors";

async function createApp(db: Db) {
  const { actorMiddleware } = await import("../middleware/auth.js");
  const { errorHandler } = await import("../middleware/index.js");
  const { issueRoutes } = await import("../routes/issues.js");
  const app = express();
  app.use(express.json());
  app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
  app.use("/api", issueRoutes(db, { wakeup: async () => null } as never));
  app.use(errorHandler);
  return app;
}

describeEmbeddedPostgres("CEO agent issue monitor authority", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    await import("../routes/issues.js");
    await import("../middleware/auth.js");
  }, 60_000);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("wardmote-ceo-issue-monitor-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.execute(sql`TRUNCATE ${companies}, ${authUsers} CASCADE`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function companyFixture() {
    const [company] = await db.insert(companies).values({
      name: `Monitor ${randomUUID()}`,
      issuePrefix: `MO${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    }).returning();
    const ownerUserId = `owner-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({ id: ownerUserId, name: "Owner", email: `${ownerUserId}@example.test`, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({
      companyId: company!.id, principalType: "user", principalId: ownerUserId, status: "active", membershipRole: "owner",
    });
    const agentWith = async (name: string, role: string, extra: { permissions?: Record<string, unknown>; reportsTo?: string } = {}) => {
      const [agent] = await db.insert(agents).values({
        companyId: company!.id, name, role, status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {},
        permissions: extra.permissions ?? {}, reportsTo: extra.reportsTo ?? null,
      }).returning();
      const [run] = await db.insert(heartbeatRuns).values({
        companyId: company!.id, agentId: agent!.id, status: "running", contextSnapshot: { issueId: randomUUID() },
      }).returning();
      const { createLocalAgentJwt } = await import("../agent-auth-jwt.js");
      return { agent: agent!, token: createLocalAgentJwt(agent!.id, company!.id, "process", run!.id, ownerUserId) };
    };
    return { company: company!, ownerUserId, agentWith };
  }

  async function fixture() {
    const f = await companyFixture();
    const ceo = await f.agentWith("Wira", "ceo");
    const assignee = await f.agentWith("Irfan", "engineer", { reportsTo: ceo.agent.id });
    const peer = await f.agentWith("Peer", "engineer", { reportsTo: ceo.agent.id });
    const [issue] = await db.insert(issues).values({
      companyId: f.company.id, title: "Irfan's task", status: "in_progress", assigneeAgentId: assignee.agent.id, createdByUserId: f.ownerUserId,
    }).returning();
    return { ...f, ceo, assignee, peer, issue: issue! };
  }

  const nextCheckAt = () => new Date(Date.now() + 60 * 60_000).toISOString();
  const schedule = (app: express.Express, issueId: string, auth: string) => request(app)
    .patch(`/api/issues/${issueId}`)
    .set("authorization", `Bearer ${auth}`)
    .send({ executionPolicy: { monitor: { nextCheckAt: nextCheckAt(), notes: "Check the deploy" } } });
  const loadIssue = async (id: string) => (await db.select().from(issues).where(eq(issues.id, id)))[0]!;

  it("lets a standard-trust CEO schedule, trigger and clear a monitor on another agent's issue, attributed to the CEO", async () => {
    const f = await fixture();
    const app = await createApp(db);

    const scheduled = await schedule(app, f.issue.id, f.ceo.token);
    expect(scheduled.status, JSON.stringify(scheduled.body)).toBe(200);
    const afterSchedule = await loadIssue(f.issue.id);
    expect(afterSchedule.monitorNextCheckAt).not.toBeNull();
    expect(afterSchedule.monitorScheduledBy).toBe("board");
    expect(afterSchedule.assigneeAgentId).toBe(f.assignee.agent.id);
    const [scheduledActivity] = await db.select().from(activityLog).where(and(
      eq(activityLog.entityId, f.issue.id), eq(activityLog.action, "issue.monitor_scheduled"),
    ));
    expect(scheduledActivity).toMatchObject({ actorType: "agent", actorId: f.ceo.agent.id, agentId: f.ceo.agent.id });

    const checkNow = await request(app)
      .post(`/api/issues/${f.issue.id}/monitor/check-now`)
      .set("authorization", `Bearer ${f.ceo.token}`);
    expect(checkNow.status, JSON.stringify(checkNow.body)).toBe(200);

    const cleared = await request(app)
      .patch(`/api/issues/${f.issue.id}`)
      .set("authorization", `Bearer ${f.ceo.token}`)
      .send({ executionPolicy: { monitor: null } });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect((await loadIssue(f.issue.id)).monitorNextCheckAt).toBeNull();
  }, 30_000);

  it("keeps a non-CEO agent that neither owns nor manages the assignee at 403", async () => {
    const f = await fixture();
    const app = await createApp(db);

    const res = await schedule(app, f.issue.id, f.peer.token);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.error).toBe(MONITOR_FORBIDDEN);
    const checkNow = await request(app)
      .post(`/api/issues/${f.issue.id}/monitor/check-now`)
      .set("authorization", `Bearer ${f.peer.token}`);
    expect(checkNow.status, JSON.stringify(checkNow.body)).toBe(403);
    expect((await loadIssue(f.issue.id)).monitorNextCheckAt).toBeNull();
  }, 30_000);

  it("does not let a CEO of another company see or schedule the issue", async () => {
    const f = await fixture();
    const other = await companyFixture();
    const foreignCeo = await other.agentWith("Foreign CEO", "ceo");
    const app = await createApp(db);

    const res = await schedule(app, f.issue.id, foreignCeo.token);
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect((await loadIssue(f.issue.id)).monitorNextCheckAt).toBeNull();
  }, 30_000);

  it("withholds CEO monitor authority from a low-trust CEO run that can still read the issue, while its standard run keeps it", async () => {
    const f = await fixture();
    const { createLocalAgentJwt } = await import("../agent-auth-jwt.js");
    const [boundary] = await db.insert(projects).values({ companyId: f.company.id, name: "Boundary" }).returning();
    await db.update(issues).set({ projectId: boundary!.id }).where(eq(issues.id, f.issue.id));
    const lowTrustPolicy = {
      trustPreset: "low_trust_review",
      authorizationPolicy: { trustBoundary: { mode: "low_trust_review", companyId: f.company.id, projectIds: [boundary!.id] } },
    };
    const [lowTrustRun, standardRun] = await db.insert(heartbeatRuns).values([
      { companyId: f.company.id, agentId: f.ceo.agent.id, status: "running", contextSnapshot: { issueId: randomUUID(), executionPolicy: lowTrustPolicy } },
      { companyId: f.company.id, agentId: f.ceo.agent.id, status: "running", contextSnapshot: { issueId: randomUUID() } },
    ]).returning();
    const app = await createApp(db);
    const jwt = (runId: string) => createLocalAgentJwt(f.ceo.agent.id, f.company.id, "process", runId, f.ownerUserId);

    const visible = await request(app).get(`/api/issues/${f.issue.id}`).set("authorization", `Bearer ${jwt(lowTrustRun!.id)}`);
    expect(visible.status, JSON.stringify(visible.body)).toBe(200);
    const restricted = await schedule(app, f.issue.id, jwt(lowTrustRun!.id));
    expect(restricted.status, JSON.stringify(restricted.body)).toBe(403);
    expect((await loadIssue(f.issue.id)).monitorNextCheckAt).toBeNull();

    const full = await schedule(app, f.issue.id, jwt(standardRun!.id));
    expect(full.status, JSON.stringify(full.body)).toBe(200);
    expect((await loadIssue(f.issue.id)).monitorNextCheckAt).not.toBeNull();
  }, 30_000);

  it("lets a CEO, but not a peer agent, force-release a checkout and post a structured comment on another agent's issue", async () => {
    const f = await fixture();
    const app = await createApp(db);
    const forceRelease = (auth: string) => request(app)
      .post(`/api/issues/${f.issue.id}/admin/force-release`)
      .set("authorization", `Bearer ${auth}`);
    const structuredComment = (auth: string) => request(app)
      .post(`/api/issues/${f.issue.id}/comments`)
      .set("authorization", `Bearer ${auth}`)
      .send({ body: "Deploy status", presentation: { kind: "message", tone: "neutral", title: "Deploy" } });

    const peerRelease = await forceRelease(f.peer.token);
    expect(peerRelease.status, JSON.stringify(peerRelease.body)).toBe(403);
    const peerComment = await structuredComment(f.peer.token);
    expect(peerComment.status, JSON.stringify(peerComment.body)).toBe(403);
    expect(peerComment.body.error).toBe("Only board users may set structured comment presentation or metadata");

    const ceoRelease = await forceRelease(f.ceo.token);
    expect(ceoRelease.status, JSON.stringify(ceoRelease.body)).toBe(200);
    const [releaseActivity] = await db.select().from(activityLog).where(and(
      eq(activityLog.entityId, f.issue.id), eq(activityLog.action, "issue.admin_force_release"),
    ));
    expect(releaseActivity).toMatchObject({ actorType: "agent", actorId: f.ceo.agent.id });
    const ceoComment = await structuredComment(f.ceo.token);
    expect(ceoComment.status, JSON.stringify(ceoComment.body)).toBe(201);
  }, 30_000);

  it("lets a manager agent with runtime authority manage a monitor on its report's issue", async () => {
    const f = await companyFixture();
    const ceo = await f.agentWith("Wira", "ceo");
    const lead = await f.agentWith("Lead", "engineer", { reportsTo: ceo.agent.id });
    const report = await f.agentWith("Report", "engineer", { reportsTo: lead.agent.id });
    const outsider = await f.agentWith("Outsider", "engineer", { reportsTo: ceo.agent.id });
    await db.insert(principalPermissionGrants).values([
      ...[lead, outsider].map(({ agent }) => ({
        companyId: f.company.id, principalType: "agent", principalId: agent.id, permissionKey: "runtime:manage",
      })),
      { companyId: f.company.id, principalType: "user", principalId: f.ownerUserId, permissionKey: "tasks:manage_active_checkouts" },
    ]);
    const [issue] = await db.insert(issues).values({
      companyId: f.company.id, title: "Report task", status: "in_progress", assigneeAgentId: report.agent.id, createdByUserId: f.ownerUserId,
    }).returning();
    const app = await createApp(db);

    const byOutsider = await schedule(app, issue!.id, outsider.token);
    expect(byOutsider.status, JSON.stringify(byOutsider.body)).toBe(403);
    const byManager = await schedule(app, issue!.id, lead.token);
    expect(byManager.status, JSON.stringify(byManager.body)).toBe(200);
  }, 30_000);
});
