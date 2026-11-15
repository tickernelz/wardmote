import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
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
  process.env.WARDMOTE_AGENT_JWT_SECRET = "company-owner-trust-secret";
  process.env.WARDMOTE_AGENT_JWT_TTL_SECONDS = "3600";
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

async function createApp(db: Db) {
  const { actorMiddleware } = await import("../middleware/auth.js");
  const { accessRoutes } = await import("../routes/access.js");
  const { assertBoard, assertBoardOrAgentAuthority, assertInstanceAdmin, isCompanyOwnerAgentActor } = await import("../routes/authz.js");
  const { issueReadSqlCondition } = await import("../services/authorization.js");
  const allowed = (check: () => void) => {
    try {
      check();
      return true;
    } catch {
      return false;
    }
  };
  const app = express();
  app.use(express.json());
  app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
  app.get("/probe/:companyId", async (req, res) => {
    const companyId = req.params.companyId;
    const visible = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), await issueReadSqlCondition(db, req.actor)));
    res.json({
      owner: isCompanyOwnerAgentActor(req),
      board: allowed(() => assertBoard(req)),
      instanceAdmin: allowed(() => assertInstanceAdmin(req)),
      companyAgents: allowed(() => assertBoardOrAgentAuthority(req, "company:agents", companyId)),
      visibleIssues: visible.length,
    });
  });
  app.use("/api", accessRoutes(db, {
    deploymentMode: "authenticated",
    deploymentExposure: "private",
    bindHost: "127.0.0.1",
    allowedHostnames: [],
  }));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "Internal server error" });
  });
  return app;
}

describeEmbeddedPostgres("CEO owner authority under a low-trust review boundary", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    await import("../routes/access.js");
    await import("../middleware/auth.js");
  }, 30_000);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("wardmote-company-owner-trust-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentApiKeys);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(companyMemberships);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function fixture() {
    const [company] = await db.insert(companies).values({
      name: `Owner Trust ${randomUUID()}`,
      issuePrefix: `OT${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    }).returning();
    const ownerUserId = `owner-${randomUUID()}`;
    const now = new Date();
    await db.insert(authUsers).values({ id: ownerUserId, name: "Owner", email: `${ownerUserId}@example.test`, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({
      companyId: company!.id, principalType: "user", principalId: ownerUserId, status: "active", membershipRole: "owner",
    });
    const [boundary] = await db.insert(projects).values({ companyId: company!.id, name: "Boundary" }).returning();
    const lowTrustPolicy = {
      trustPreset: "low_trust_review",
      authorizationPolicy: { trustBoundary: { mode: "low_trust_review", companyId: company!.id, projectIds: [boundary!.id] } },
    };
    await db.insert(issues).values({
      companyId: company!.id, title: "Owner-private task", visibility: "private", createdByUserId: ownerUserId,
    });
    const agentWith = async (role: string, permissions: Record<string, unknown>) => {
      const [agent] = await db.insert(agents).values({
        companyId: company!.id, name: role, role, status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {}, permissions,
      }).returning();
      const token = `pcp_${randomUUID()}`;
      await db.insert(agentApiKeys).values({
        agentId: agent!.id, companyId: company!.id, name: "test", keyHash: createHash("sha256").update(token).digest("hex"), responsibleUserId: ownerUserId,
      });
      return { agent: agent!, token };
    };
    return { company: company!, ownerUserId, lowTrustPolicy, agentWith };
  }

  it("withholds every owner shortcut from a CEO whose agent policy is low-trust review, and keeps them for a standard CEO", async () => {
    const f = await fixture();
    const ceo = await f.agentWith("ceo", {});
    const lowTrustCeo = await f.agentWith("ceo", f.lowTrustPolicy);
    const app = await createApp(db);

    const trusted = await request(app).get(`/probe/${f.company.id}`).set("authorization", `Bearer ${ceo.token}`);
    expect(trusted.status, JSON.stringify(trusted.body)).toBe(200);
    expect(trusted.body).toEqual({ owner: true, board: true, instanceAdmin: true, companyAgents: true, visibleIssues: 1 });

    const lowTrust = await request(app).get(`/probe/${f.company.id}`).set("authorization", `Bearer ${lowTrustCeo.token}`);
    expect(lowTrust.status, JSON.stringify(lowTrust.body)).toBe(200);
    expect(lowTrust.body).toEqual({ owner: false, board: false, instanceAdmin: false, companyAgents: false, visibleIssues: 0 });

    const trustedInvites = await request(app).get(`/api/companies/${f.company.id}/invites`).set("authorization", `Bearer ${ceo.token}`);
    expect(trustedInvites.status, JSON.stringify(trustedInvites.body)).toBe(200);
    const lowTrustInvites = await request(app).get(`/api/companies/${f.company.id}/invites`).set("authorization", `Bearer ${lowTrustCeo.token}`);
    expect(lowTrustInvites.status, JSON.stringify(lowTrustInvites.body)).toBe(403);
    expect(lowTrustInvites.body.error).toBe("Permission denied");
  }, 20_000);

  it("withholds owner shortcuts for the one run that carries a low-trust boundary, not for the CEO's other runs", async () => {
    const f = await fixture();
    const { agent } = await f.agentWith("ceo", {});
    const { createLocalAgentJwt } = await import("../agent-auth-jwt.js");
    const [lowTrustRun, standardRun] = await db.insert(heartbeatRuns).values([
      { companyId: f.company.id, agentId: agent.id, status: "running", contextSnapshot: { executionPolicy: f.lowTrustPolicy } },
      { companyId: f.company.id, agentId: agent.id, status: "running", contextSnapshot: {} },
    ]).returning();
    const app = await createApp(db);
    const probe = (runId: string) => request(app)
      .get(`/probe/${f.company.id}`)
      .set("authorization", `Bearer ${createLocalAgentJwt(agent.id, f.company.id, "process", runId, f.ownerUserId)}`);

    const restricted = await probe(lowTrustRun!.id);
    expect(restricted.status, JSON.stringify(restricted.body)).toBe(200);
    expect(restricted.body).toEqual({ owner: false, board: false, instanceAdmin: false, companyAgents: false, visibleIssues: 0 });

    const full = await probe(standardRun!.id);
    expect(full.status, JSON.stringify(full.body)).toBe(200);
    expect(full.body).toEqual({ owner: true, board: true, instanceAdmin: true, companyAgents: true, visibleIssues: 1 });
  }, 20_000);
});
