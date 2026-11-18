import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  decisionEffectExecutions,
  decisions,
  decisionTargetIssues,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@tickernelz/wardmote-db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { decisionRoutes } from "../routes/decisions.js";
import { attentionService } from "../services/attention.js";

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

describePg("blocked reason routes", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  let issueId: string;
  let dependencyId: string;
  let runId: string;
  let userId: string;
  let wakes: Array<Record<string, unknown>>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("wardmote-blocked-reason-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  beforeEach(async () => {
    process.env.WARDMOTE_DECISION_SIGNING_SECRET = "0123456789abcdef0123456789abcdef";
    companyId = randomUUID(); agentId = randomUUID(); issueId = randomUUID(); dependencyId = randomUUID(); runId = randomUUID();
    userId = `board-${randomUUID()}`; wakes = [];
    const now = new Date();
    await db.insert(companies).values({ id: companyId, name: "Blocked", issuePrefix: `B${companyId.slice(0, 6)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(authUsers).values({ id: userId, name: "Board", email: `${userId}@example.test`, createdAt: now, updatedAt: now });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", responsibleUserId: userId, contextSnapshot: { issueId } });
    await db.insert(issues).values([
      { id: issueId, companyId, title: "Ship the deploy", identifier: "BLK-1", issueNumber: 1, status: "in_progress", priority: "medium",
        assigneeAgentId: agentId, checkoutRunId: runId, executionRunId: runId, responsibleUserId: userId },
      { id: dependencyId, companyId, title: "Dependency", identifier: "BLK-2", issueNumber: 2, status: "todo", priority: "medium" },
    ]);
  });

  afterEach(async () => {
    await db.delete(decisionEffectExecutions); await db.delete(decisionTargetIssues); await db.delete(decisions); await db.delete(activityLog);
    await db.delete(issueComments); await db.delete(issueRelations); await db.delete(issues); await db.delete(heartbeatRuns);
    await db.delete(agents); await db.delete(companyMemberships); await db.delete(authUsers); await db.delete(companies);
  });
  afterAll(async () => tempDb?.cleanup());

  const agentActor = () => ({ type: "agent" as const, agentId, companyId, runId, source: "agent_jwt" as const });
  const boardActor = () => ({ type: "board" as const, userId, companyIds: [companyId], source: "session" as const, isInstanceAdmin: false,
    memberships: [{ companyId, membershipRole: "owner", status: "active" }] });
  const app = (actor: Express.Request["actor"]) => {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => { req.actor = actor; next(); });
    server.use("/api", issueRoutes(db, {} as never));
    server.use("/api", decisionRoutes(db, { wakeOriginAgent: async (input) => { wakes.push(input); } }));
    server.use(errorHandler);
    return server;
  };
  const issueRow = async () => (await db.select().from(issues).where(eq(issues.id, issueId)))[0]!;
  const feed = () => attentionService(db).list(companyId, { userId });

  const questionCard = {
    reason: "The production deploy needs the owner's approval.",
    suggestion: "Approve the deploy; I will run it and verify health.",
    actions: [
      { id: "approve", label: "Approve deploy", style: "primary",
        effects: [{ type: "update_issue_status", status: "in_progress", comment: "Deploy window: {{input.window}}" }] },
      { id: "hold", label: "Hold", effects: [] },
    ],
    questions: [
      { id: "window", prompt: "When may I deploy?", required: true, answerMode: "single_select",
        options: [{ id: "now", label: "Now" }, { id: "tonight", label: "Tonight" }] },
      { id: "hosts", prompt: "Which hosts?", required: false, answerMode: "multi_select",
        options: [{ id: "lab0", label: "lab0" }, { id: "integron", label: "integron" }] },
      { id: "downtime", prompt: "Max downtime minutes", required: true, answerMode: "text",
        textValidation: { inputType: "integer", minimum: 0, maximum: 60 } },
      { id: "note", prompt: "Anything else?", required: false, answerMode: "text" },
    ],
  };

  it("rejects an agent entering blocked without a reason and returns an example payload", async () => {
    const res = await request(app(agentActor())).patch(`/api/issues/${issueId}`)
      .send({ status: "blocked", blockedByIssueIds: [dependencyId] });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(res.body.code).toBe("blocked_reason_required");
    expect(res.body.example.blockedReason).toMatchObject({ reason: expect.any(String), suggestion: expect.any(String) });
    expect((await issueRow()).status).toBe("in_progress");
  });

  it("rejects a reason without a suggestion and an overlong reason", async () => {
    const missing = await request(app(agentActor())).patch(`/api/issues/${issueId}`)
      .send({ status: "blocked", blockedByIssueIds: [dependencyId], blockedReason: { reason: "Waiting on BLK-2" } });
    expect(missing.status).toBe(400);
    const overlong = await request(app(agentActor())).patch(`/api/issues/${issueId}`)
      .send({ status: "blocked", blockedByIssueIds: [dependencyId], blockedReason: { reason: "x".repeat(1_001), suggestion: "Finish BLK-2" } });
    expect(overlong.status).toBe(400);
    expect((await issueRow()).status).toBe("in_progress");
  });

  it("stores the agent reason and shows it on the Decisions card instead of the count template", async () => {
    const res = await request(app(agentActor())).patch(`/api/issues/${issueId}`)
      .send({ status: "blocked", blockedByIssueIds: [dependencyId],
        blockedReason: { reason: "Waiting on BLK-2 to land the schema.", suggestion: "Assign BLK-2 to an engineer; I resume as soon as it is done." } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await issueRow()).blockedReason).toMatchObject({
      reason: "Waiting on BLK-2 to land the schema.", decisionId: null, authorAgentId: agentId,
    });
    const card = (await feed()).items.find((item) => item.sourceKind === "blocker_attention");
    expect(card?.subject.id).toBe(dependencyId);
    expect(card?.whyNow).toBe("Waiting on BLK-2 to land the schema.");
    expect(card?.detail).toMatchObject({
      kind: "blocker",
      blockedTaskCount: 1,
      blockedReason: { reason: "Waiting on BLK-2 to land the schema.", decisionId: null },
      reasonIssue: { id: issueId, assigneeAgentId: agentId },
    });
  });

  it("does not force board users and marks the reason as missing without a zero count", async () => {
    const res = await request(app(boardActor())).patch(`/api/issues/${issueId}`)
      .send({ status: "blocked", unblockDescriptor: { owner: "board", action: "Decide the deploy" } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await db.update(issues).set({ unblockDescriptor: null }).where(eq(issues.id, issueId));
    const card = (await feed()).items.find((item) => item.sourceKind === "blocker_attention" && item.subject.id === issueId);
    expect(card?.whyNow).toBe("Reason not provided yet.");
    expect(card?.inlineResolvable).toBe(true);
    expect(card?.detail).toMatchObject({ blockedReason: null, reasonIssue: { id: issueId, assigneeAgentId: agentId } });
  });

  it("rejects effects outside the closed set", async () => {
    const res = await request(app(agentActor())).patch(`/api/issues/${issueId}`).send({ status: "blocked", blockedReason: {
      reason: "Need a decision.", suggestion: "Cancel the tree.",
      actions: [{ id: "nuke", label: "Cancel all", effects: [{ type: "cancel_issue_tree", reasonComment: "x" }] }],
    } });
    expect(res.status).toBe(400);
    expect(await db.select().from(decisions)).toHaveLength(0);
    expect((await issueRow()).status).toBe("in_progress");
  });

  it("turns actions and questions into one card, revalidates answers, and reports them once", async () => {
    const blocked = await request(app(agentActor())).patch(`/api/issues/${issueId}`)
      .send({ status: "blocked", blockedReason: questionCard });
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(200);
    const decisionId = (await issueRow()).blockedReason?.decisionId;
    expect(decisionId).toBeTruthy();

    const items = (await feed()).items;
    const card = items.find((item) => item.sourceKind === "blocker_attention" && item.subject.id === issueId);
    expect(card?.whyNow).toBe(questionCard.reason);
    expect(card?.detail).toMatchObject({ blockedReason: { reason: questionCard.reason, suggestion: questionCard.suggestion, decisionId } });
    expect(items.some((item) => item.sourceKind === "decision")).toBe(false);

    const board = app(boardActor());
    const missingRequired = await request(board).post(`/api/decisions/${decisionId}/decide`).send({
      optionId: "approve", idempotencyKey: "k1",
      questionResponse: { schema: "wardmote.question_response.v1", answers: { window: { selectedOptionIds: ["now"] } } },
    });
    expect(missingRequired.status, JSON.stringify(missingRequired.body)).toBe(422);
    const notInteger = await request(board).post(`/api/decisions/${decisionId}/decide`).send({
      optionId: "approve", idempotencyKey: "k2",
      questionResponse: { schema: "wardmote.question_response.v1", answers: { window: { selectedOptionIds: ["now"] }, downtime: { text: "4.5" } } },
    });
    expect(notInteger.status).toBe(422);
    const twoSingles = await request(board).post(`/api/decisions/${decisionId}/decide`).send({
      optionId: "approve", idempotencyKey: "k3",
      questionResponse: { schema: "wardmote.question_response.v1", answers: { window: { selectedOptionIds: ["now", "tonight"] }, downtime: { text: "5" } } },
    });
    expect(twoSingles.status).toBe(422);
    expect((await db.select().from(decisions).where(eq(decisions.id, decisionId!)))[0]?.status).toBe("open");

    const answer = {
      optionId: "approve", idempotencyKey: "k4",
      questionResponse: { schema: "wardmote.question_response.v1", answers: {
        window: { selectedOptionIds: ["tonight"] }, hosts: { selectedOptionIds: ["lab0", "integron"] },
        downtime: { text: "5" }, note: { text: "Ping me after." },
      } },
    };
    const decided = await request(board).post(`/api/decisions/${decisionId}/decide`).send(answer);
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    expect(decided.body.executionStatus).toBe("succeeded");
    const replay = await request(board).post(`/api/decisions/${decisionId}/decide`).send(answer);
    expect(replay.status).toBe(200);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    const answerComments = comments.filter((comment) => comment.body.startsWith("**Answer from the Decisions card.**"));
    expect(answerComments).toHaveLength(1);
    expect(answerComments[0]!.body).toContain("Chosen action: Approve deploy");
    expect(answerComments[0]!.body).toContain("- Which hosts?: lab0, integron");
    expect(answerComments[0]!.body).toContain("- Max downtime minutes: 5");
    expect(answerComments[0]!.authorUserId).toBe(userId);
    expect(comments.some((comment) => comment.body === "Deploy window: Tonight")).toBe(true);
    expect(wakes).toHaveLength(1);
    const after = await issueRow();
    expect(after.status).toBe("in_progress");
    expect(after.blockedReason).toBeNull();
  });

  it("cancels the previous card when the reason is replaced and when the issue leaves blocked", async () => {
    await request(app(agentActor())).patch(`/api/issues/${issueId}`).send({ status: "blocked", blockedReason: questionCard }).expect(200);
    const first = (await issueRow()).blockedReason!.decisionId!;
    await request(app(agentActor())).patch(`/api/issues/${issueId}`)
      .send({ status: "blocked", blockedReason: { ...questionCard, reason: "Still waiting for approval." } }).expect(200);
    const second = (await issueRow()).blockedReason!.decisionId!;
    expect(second).not.toBe(first);
    expect((await db.select().from(decisions).where(eq(decisions.id, first)))[0]?.status).toBe("cancelled");

    await request(app(boardActor())).patch(`/api/issues/${issueId}`).send({ status: "todo" }).expect(200);
    expect((await db.select().from(decisions).where(eq(decisions.id, second)))[0]?.status).toBe("cancelled");
    expect((await issueRow()).blockedReason).toBeNull();
    expect(wakes).toHaveLength(0);
  });
});
