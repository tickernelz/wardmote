import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, chatCompletionDeliveries as deliveries, companies, createDb, heartbeatRuns, issues } from "@tickernelz/wardmote-db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { CHAT_COMPLETION_WAKE_REASON } from "../services/chat-completion-delivery.js";
import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";

const execute = vi.hoisted(() => vi.fn());
vi.mock("../adapters/index.js", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.js")>("../adapters/index.js");
  return { ...actual, getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute })) };
});
const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("chat completion wake with nothing left to report", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("chat-completion-noop-");
    db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });
  beforeEach(() => {
    execute.mockReset();
    execute.mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, summary: "Reported" });
  });

  async function completedTask() {
    const companyId = randomUUID(), agentId = randomUUID(), conversationId = randomUUID(), creatorRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Completion", issuePrefix: "N" + companyId.replaceAll("-", "").slice(0, 6).toUpperCase(), defaultResponsibleUserId: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Lead", role: "engineer", status: "idle", adapterType: "process",
      adapterConfig: {}, permissions: {}, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: conversationId, companyId, title: "Chat", status: "in_review", conversationAgentId: agentId,
      conversationUserId: "owner", conversationState: "waiting", assigneeAgentId: agentId, responsibleUserId: "owner" });
    await db.insert(heartbeatRuns).values({ id: creatorRunId, companyId, agentId, status: "succeeded", responsibleUserId: "owner",
      contextSnapshot: { issueId: conversationId, conversationSessionGeneration: 0 } });
    const task = await issueService(db).create(companyId, { title: "Write note", status: "todo", createdByAgentId: agentId, actorRunId: creatorRunId });
    await issueService(db).update(task.id, { status: "done" });
    const [delivery] = await db.select().from(deliveries).where(eq(deliveries.taskId, task.id));
    return { companyId, agentId, conversationId, delivery };
  }

  async function wakeForDelivery(f: Awaited<ReturnType<typeof completedTask>>) {
    const heartbeat = heartbeatService(db);
    const run = await heartbeat.wakeup(f.agentId, {
      source: "automation", triggerDetail: "system", reason: CHAT_COMPLETION_WAKE_REASON, idempotencyKey: `chat-completion:${f.delivery.id}:0`,
      allowRunCoalescing: false, requestedByActorType: "system", requestedByActorId: "chat_completion_delivery",
      payload: { issueId: f.conversationId, chatCompletionDeliveryIds: [f.delivery.id] },
      contextSnapshot: { issueId: f.conversationId, taskId: f.conversationId, wakeReason: CHAT_COMPLETION_WAKE_REASON,
        chatCompletionDeliveryIds: [f.delivery.id], conversationSessionGeneration: 0 },
    });
    await heartbeat.drainActiveRunExecutions();
    const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id));
    return finished;
  }

  it("closes the turn as a no-op and promotes the next wake when another turn already reported the delivery", async () => {
    const f = await completedTask();
    const reporterRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: reporterRunId, companyId: f.companyId, agentId: f.agentId, status: "succeeded", responsibleUserId: "owner" });
    await db.update(deliveries).set({ status: "delivered", targetRunId: reporterRunId }).where(eq(deliveries.id, f.delivery.id));
    const [deferred] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "on_demand",
      triggerDetail: "manual", reason: "issue_assigned", payload: { issueId: f.conversationId }, status: "deferred_issue_execution" }).returning();

    const run = await wakeForDelivery(f);

    expect(run).toMatchObject({ status: "succeeded", errorCode: null, issueCommentStatus: "not_applicable",
      resultJson: { chatCompletionNothingToReport: true } });
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, run.wakeupRequestId!));
    expect(wake.status).toBe("completed");
    expect((await db.select().from(deliveries).where(eq(deliveries.id, f.delivery.id)))[0]).toMatchObject({ status: "delivered", targetRunId: reporterRunId });
    const [promoted] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, deferred.id));
    expect(promoted.status).not.toBe("deferred_issue_execution");
    expect(promoted.runId).not.toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0].runId).toBe(promoted.runId);
    const [conversation] = await db.select().from(issues).where(and(eq(issues.id, f.conversationId), eq(issues.companyId, f.companyId)));
    expect(conversation.executionRunId).not.toBe(run.id);
  }, 60_000);

  it("still claims and reports a pending delivery", async () => {
    const f = await completedTask();

    const run = await wakeForDelivery(f);

    expect(run.status).toBe("succeeded");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(run.contextSnapshot?.chatCompletionDeliveryIds).toEqual([f.delivery.id]);
    expect(run.resultJson).not.toMatchObject({ chatCompletionNothingToReport: true });
  }, 60_000);
});
