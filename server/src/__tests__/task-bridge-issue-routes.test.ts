import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  activityLog,
  agentApiKeys,
  agents,
  companies,
  companyMemberships,
  createDb,
  issues,
  projects,
} from "@tickernelz/wardmote-db";
import type { TaskBridgeAgentKeyScope } from "@tickernelz/wardmote-shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

describeEmbeddedPostgres("task bridge keys on issue routes without a heartbeat run", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("wardmote-task-bridge-issue-routes-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const bridgeAgentId = randomUUID();
    const standardAgentId = randomUUID();
    const scopedProjectId = randomUUID();
    const otherProjectId = randomUUID();
    const bridgeKeyId = randomUUID();
    const otherBridgeKeyId = randomUUID();
    const standardKeyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Bridge company",
      issuePrefix: `B${companyId.slice(0, 7).toUpperCase()}`,
    });
    await db.insert(agents).values([
      { id: bridgeAgentId, companyId, name: "Chat bridge", role: "engineer", adapterType: "process" },
      { id: standardAgentId, companyId, name: "Standard", role: "engineer", adapterType: "process" },
    ]);
    await db.insert(companyMemberships).values([
      { companyId, principalType: "agent", principalId: bridgeAgentId, membershipRole: "member", status: "active" },
      { companyId, principalType: "agent", principalId: standardAgentId, membershipRole: "member", status: "active" },
    ]);
    await db.insert(projects).values([
      { id: scopedProjectId, companyId, name: "Scoped" },
      { id: otherProjectId, companyId, name: "Other" },
    ]);
    const scope: TaskBridgeAgentKeyScope = { kind: "task_bridge", projectIds: [scopedProjectId] };
    await db.insert(agentApiKeys).values([
      { id: bridgeKeyId, agentId: bridgeAgentId, companyId, name: "bridge", keyHash: randomUUID(), scopeConfig: scope },
      { id: otherBridgeKeyId, agentId: bridgeAgentId, companyId, name: "other bridge", keyHash: randomUUID(), scopeConfig: scope },
      { id: standardKeyId, agentId: standardAgentId, companyId, name: "standard", keyHash: randomUUID() },
    ]);
    const [bridgeIssue, otherBridgeIssue, foreignIssue, standardIssue] = await db
      .insert(issues)
      .values([
        {
          companyId,
          projectId: scopedProjectId,
          title: "Bridge request",
          status: "backlog",
          createdByAgentId: bridgeAgentId,
          originKind: "task_bridge",
          originId: bridgeKeyId,
        },
        {
          companyId,
          projectId: scopedProjectId,
          title: "Other bridge key request",
          status: "backlog",
          createdByAgentId: bridgeAgentId,
          originKind: "task_bridge",
          originId: otherBridgeKeyId,
        },
        { companyId, projectId: scopedProjectId, title: "Someone else's work", status: "todo" },
        {
          companyId,
          projectId: scopedProjectId,
          title: "Standard agent work",
          status: "todo",
          assigneeAgentId: standardAgentId,
        },
      ])
      .returning();
    const bridgeActor = (keyId = bridgeKeyId): Express.Request["actor"] => ({
      type: "agent",
      agentId: bridgeAgentId,
      companyId,
      keyId,
      source: "agent_key",
      keyScope: scope,
    });
    const standardActor: Express.Request["actor"] = {
      type: "agent",
      agentId: standardAgentId,
      companyId,
      keyId: standardKeyId,
      source: "agent_key",
    };
    return {
      companyId,
      bridgeAgentId,
      standardAgentId,
      scopedProjectId,
      otherProjectId,
      bridgeKeyId,
      bridgeIssue: bridgeIssue!,
      otherBridgeIssue: otherBridgeIssue!,
      foreignIssue: foreignIssue!,
      standardIssue: standardIssue!,
      bridgeActor,
      standardActor,
    };
  }

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  it("lets a bridge key comment on the issue it created, attributed to that key", async () => {
    const fixture = await seed();
    const app = createApp(fixture.bridgeActor());

    const comment = await request(app)
      .post(`/api/issues/${fixture.bridgeIssue.id}/comments`)
      .send({ body: "Jawaban klarifikasi dari jembatan" });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);

    const patchComment = await request(app)
      .patch(`/api/issues/${fixture.bridgeIssue.id}`)
      .send({ comment: "Tambahan konteks lewat PATCH" });
    expect(patchComment.status, JSON.stringify(patchComment.body)).toBe(200);

    const audit = await db
      .select({ actorType: activityLog.actorType, runId: activityLog.runId, details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.entityId, fixture.bridgeIssue.id),
        eq(activityLog.agentId, fixture.bridgeAgentId),
        eq(activityLog.action, "issue.comment_added"),
      ));
    const attributed = expect.objectContaining({
      actorType: "agent",
      runId: null,
      details: expect.objectContaining({ taskBridgeKeyId: fixture.bridgeKeyId }),
    });
    expect(audit).toEqual([attributed, attributed]);
  });

  it("still requires a heartbeat run for a bridge key to update its own issue", async () => {
    const fixture = await seed();
    const patch = await request(createApp(fixture.bridgeActor()))
      .patch(`/api/issues/${fixture.bridgeIssue.id}`)
      .send({ status: "cancelled" });
    expect(patch.status, JSON.stringify(patch.body)).toBe(403);
    expect(JSON.stringify(patch.body)).toContain("cross_issue_influence_run_context_required");
  });

  it("keeps a bridge key out of issues it neither created nor holds", async () => {
    const fixture = await seed();
    const app = createApp(fixture.bridgeActor());

    for (const issue of [fixture.foreignIssue, fixture.otherBridgeIssue]) {
      const comment = await request(app)
        .post(`/api/issues/${issue.id}/comments`)
        .send({ body: "Should not land" });
      expect([403, 404], JSON.stringify(comment.body)).toContain(comment.status);

      const patch = await request(app)
        .patch(`/api/issues/${issue.id}`)
        .send({ status: "cancelled" });
      expect([403, 404], JSON.stringify(patch.body)).toContain(patch.status);
    }
  });

  it("lets a bridge key answer its request after another agent took it, but not rewrite it", async () => {
    const fixture = await seed();
    await db
      .update(issues)
      .set({ assigneeAgentId: fixture.standardAgentId, status: "todo" })
      .where(eq(issues.id, fixture.bridgeIssue.id));
    const app = createApp(fixture.bridgeActor());

    const comment = await request(app)
      .post(`/api/issues/${fixture.bridgeIssue.id}/comments`)
      .send({ body: "Permintaan dibatalkan oleh peminta di Chat" });
    expect(comment.status, JSON.stringify(comment.body)).toBe(201);

    for (const body of [
      { description: "Rewritten objective" },
      { assigneeAgentId: fixture.bridgeAgentId },
      { status: "done" },
    ]) {
      const patch = await request(app).patch(`/api/issues/${fixture.bridgeIssue.id}`).send(body);
      expect(patch.status, JSON.stringify(patch.body)).toBe(403);
    }
    const [unchanged] = await db.select().from(issues).where(eq(issues.id, fixture.bridgeIssue.id));
    expect(unchanged).toMatchObject({ assigneeAgentId: fixture.standardAgentId, status: "todo", description: null });
  });

  it("still requires a heartbeat run for standard agent keys", async () => {
    const fixture = await seed();
    const res = await request(createApp(fixture.standardActor))
      .post(`/api/issues/${fixture.standardIssue.id}/comments`)
      .send({ body: "No run" });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(JSON.stringify(res.body)).toContain("cross_issue_influence_run_context_required");
  });

  it("lets a bridge key create an issue directly in a project its scope names", async () => {
    const fixture = await seed();
    const app = createApp(fixture.bridgeActor());

    const created = await request(app)
      .post(`/api/companies/${fixture.companyId}/issues`)
      .send({ title: "Permintaan dari Chat", projectId: fixture.scopedProjectId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      projectId: fixture.scopedProjectId,
      originKind: "task_bridge",
      originId: fixture.bridgeKeyId,
    });

    const outside = await request(app)
      .post(`/api/companies/${fixture.companyId}/issues`)
      .send({ title: "Di luar scope", projectId: fixture.otherProjectId });
    expect(outside.status, JSON.stringify(outside.body)).toBe(422);
    expect(outside.body.code).toBe("project_not_found");

    const outsideViaParent = await request(app)
      .post(`/api/companies/${fixture.companyId}/issues`)
      .send({ title: "Di luar scope lewat induk", parentId: created.body.id, projectId: fixture.otherProjectId });
    expect(outsideViaParent.status, JSON.stringify(outsideViaParent.body)).toBe(422);
  });
});
