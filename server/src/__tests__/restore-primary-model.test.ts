import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  modelCooldowns,
} from "@tickernelz/wardmote-db";
import type { AdapterExecutionContext, AdapterExecutionResult } from "@tickernelz/wardmote-adapter-utils";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { issueService } from "../services/issues.ts";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";
import { MODEL_FALLBACK_DEFAULT_COOLDOWN_MS, recordModelCooldown } from "../services/model-fallback.ts";
import {
  RESTORE_PRIMARY_MODEL_ACTION,
  RESTORE_PRIMARY_MODEL_COMMENT,
  restoreIssuePrimaryModel,
  type RestorePrimaryModelDeps,
} from "../services/restore-primary-model.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const PRIMARY = "anthropic/claude-opus";
const BACKUP = "openai/gpt-5";
const SECOND = "google/gemini-pro";
const USER = "board-user";

type Behavior = (ctx: AdapterExecutionContext) => Promise<AdapterExecutionResult>;
const ok: Behavior = async () => ({ exitCode: 0, signal: null, timedOut: false, summary: "done" });

async function waitForRun(heartbeat: ReturnType<typeof heartbeatService>, runId: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return heartbeat.getRun(runId);
}

describeEmbeddedPostgres("restore primary model", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let wardmoteHome: string | null = null;
  const previousHome = process.env.WARDMOTE_HOME;
  const behaviors = new Map<string, Behavior[]>();
  const captured = new Map<string, { config: Record<string, unknown>; context: Record<string, unknown> }>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("restore-primary-model-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    wardmoteHome = await fs.mkdtemp(path.join(os.tmpdir(), "wardmote-restore-primary-home-"));
    process.env.WARDMOTE_HOME = wardmoteHome;
    registerServerAdapter({
      type: "omp_local",
      execute: async (ctx) => {
        captured.set(ctx.runId, { config: { ...ctx.config }, context: { ...ctx.context } });
        const next = (behaviors.get(ctx.agent.id) ?? []).shift() ?? ok;
        return next(ctx);
      },
      testEnvironment: async () => ({ adapterType: "omp_local", status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
  }, 30_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    behaviors.clear();
    captured.clear();
  });

  afterAll(async () => {
    unregisterServerAdapter("omp_local");
    if (previousHome === undefined) delete process.env.WARDMOTE_HOME;
    else process.env.WARDMOTE_HOME = previousHome;
    if (wardmoteHome) await fs.rm(wardmoteHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await tempDb?.cleanup();
  });

  async function seed(adapterConfig: Record<string, unknown> = { model: PRIMARY, fallbackModels: [BACKUP, SECOND] }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Restore",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: USER,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Restore agent",
      role: "engineer",
      status: "idle",
      adapterType: "omp_local",
      adapterConfig,
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({ id: issueId, companyId, title: "Work", status: "in_progress", assigneeAgentId: agentId, responsibleUserId: USER });
    return { companyId, agentId, issueId, issue: { id: issueId, companyId, assigneeAgentId: agentId } };
  }

  function deps(overrides: Partial<RestorePrimaryModelDeps> = {}): RestorePrimaryModelDeps {
    return {
      cancelRun: (runId, reason, options) => heartbeat.cancelRun(runId, reason, options),
      addComment: (issueId, body, actor) => issueService(db).addComment(issueId, body, actor),
      wakeup: (agentId, options) => heartbeat.wakeup(agentId, options),
      ...overrides,
    };
  }

  async function coolPrimary(companyId: string, selector = PRIMARY) {
    const now = new Date();
    await recordModelCooldown(db, {
      companyId,
      selector,
      until: new Date(now.getTime() + MODEL_FALLBACK_DEFAULT_COOLDOWN_MS),
      reason: "upstream",
      sourceRunId: null,
      probeAfter: now,
    });
  }

  async function plainWake(target: { agentId: string; issueId: string }) {
    const queued = await heartbeat.wakeup(target.agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "issue_commented",
      payload: { issueId: target.issueId },
      requestedByActorType: "user",
      requestedByActorId: USER,
      contextSnapshot: { issueId: target.issueId, taskId: target.issueId },
    });
    return waitForRun(heartbeat, queued!.id);
  }

  async function runStartFallbackEvents(runId: string) {
    const events = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, runId), eq(heartbeatRunEvents.eventType, "model.fallback")));
    return events.filter((event) => (event.payload as Record<string, unknown> | null)?.phase === "run_start");
  }

  it("without the button a wake while the primary cools starts on the fallback", async () => {
    const target = await seed();
    await coolPrimary(target.companyId);
    const run = await plainWake(target);
    expect(captured.get(run!.id)!.config.model).toBe(BACKUP);
    expect(await runStartFallbackEvents(run!.id)).toHaveLength(1);
  });

  it("starts the next run on the primary while it cools, resets the cooldown, comments and records the activity", async () => {
    const target = await seed();
    await coolPrimary(target.companyId);
    const result = await restoreIssuePrimaryModel(db, deps(), { issue: target.issue, userId: USER });
    expect(result).toMatchObject({ primary: PRIMARY, chain: [PRIMARY, BACKUP, SECOND], cancelledRunIds: [], resetSelectors: [PRIMARY] });
    const run = await waitForRun(heartbeat, result.wakeRunId!);
    expect(run!.status).toBe("succeeded");
    const seen = captured.get(run!.id)!;
    expect(seen.config.model).toBe(PRIMARY);
    expect(seen.config.fallbackModels).toEqual([BACKUP, SECOND]);
    expect(seen.context.wardmoteForcedModel).toBe(PRIMARY);
    expect(seen.context.wardmoteModelAttempts).toBeUndefined();
    expect(seen.context.wardmoteModelAttemptBudget).toBeUndefined();
    expect(await runStartFallbackEvents(run!.id)).toHaveLength(0);

    const [cooldown] = await db.select().from(modelCooldowns).where(eq(modelCooldowns.companyId, target.companyId));
    expect(cooldown!.releasedBy).toBe("user");
    expect(cooldown!.cooldownUntil.getTime()).toBeLessThanOrEqual(Date.now());
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, target.issueId));
    expect(comments.map((comment) => [comment.body, comment.authorUserId])).toEqual([[RESTORE_PRIMARY_MODEL_COMMENT, USER]]);
    expect(seen.context.wakeCommentId).toBe(comments[0]!.id);
    const activity = await db.select().from(activityLog).where(and(eq(activityLog.companyId, target.companyId), eq(activityLog.action, RESTORE_PRIMARY_MODEL_ACTION)));
    expect(activity).toHaveLength(1);
    expect(activity[0]!.details).toMatchObject({ primary: PRIMARY, resetSelectors: [PRIMARY], wakeRunId: run!.id });
  });

  it("cancels the task's run waiting on a fallback and resets every chain model ahead of it", async () => {
    const target = await seed();
    await coolPrimary(target.companyId, PRIMARY);
    await coolPrimary(target.companyId, BACKUP);
    const waitingId = randomUUID();
    const otherIssueRunId = randomUUID();
    await db.insert(heartbeatRuns).values([
      { id: waitingId, companyId: target.companyId, agentId: target.agentId, status: "scheduled_retry", issueId: target.issueId,
        scheduledRetryAt: new Date(Date.now() + 300_000), contextSnapshot: { issueId: target.issueId, wardmoteForcedModel: SECOND, wardmoteModelAttempts: { [PRIMARY]: 2, [BACKUP]: 1 } } },
      { id: otherIssueRunId, companyId: target.companyId, agentId: target.agentId, status: "scheduled_retry",
        scheduledRetryAt: new Date(Date.now() + 300_000), contextSnapshot: { issueId: randomUUID(), wardmoteForcedModel: SECOND } },
    ]);
    const result = await restoreIssuePrimaryModel(db, deps(), { issue: target.issue, userId: USER });
    expect(result.cancelledRunIds).toEqual([waitingId]);
    expect(result.resetSelectors.sort()).toEqual([BACKUP, PRIMARY].sort());
    const [waiting] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, waitingId));
    const [other] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, otherIssueRunId));
    expect(waiting!.status).toBe("cancelled");
    expect(other!.status).toBe("scheduled_retry");
    const run = await waitForRun(heartbeat, result.wakeRunId!);
    expect(captured.get(run!.id)!.config.model).toBe(PRIMARY);
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, otherIssueRunId));
  });

  it("still starts on the primary when a real failure writes its cooldown again before the forced run starts", async () => {
    const target = await seed();
    await coolPrimary(target.companyId);
    const result = await restoreIssuePrimaryModel(db, deps({
      wakeup: async (agentId, options) => {
        await coolPrimary(target.companyId);
        return heartbeat.wakeup(agentId, options);
      },
    }), { issue: target.issue, userId: USER });
    const [rewritten] = await db.select().from(modelCooldowns).where(eq(modelCooldowns.companyId, target.companyId));
    expect(rewritten!.releasedAt).toBeNull();
    const run = await waitForRun(heartbeat, result.wakeRunId!);
    expect(captured.get(run!.id)!.config.model).toBe(PRIMARY);
    expect(await runStartFallbackEvents(run!.id)).toHaveLength(0);
  });

  describe("route", () => {
    function app(actor: Record<string, unknown>) {
      const server = express();
      server.use(express.json());
      server.use((req, _res, next) => {
        (req as any).actor = actor;
        next();
      });
      server.use("/api", issueRoutes(db, {} as any));
      server.use(errorHandler);
      return server;
    }

    async function member(companyId: string) {
      await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: USER, status: "active", membershipRole: "owner", updatedAt: new Date() });
      await ensureHumanRoleDefaultGrants(db, { companyId, principalId: USER, membershipRole: "owner", grantedByUserId: null });
    }

    function board(companyId: string) {
      return {
        type: "board",
        userId: USER,
        companyIds: [companyId],
        memberships: [{ companyId, membershipRole: "owner", status: "active" }],
        source: "session",
        isInstanceAdmin: false,
      };
    }

    it("rejects an agent key and leaves the cooldown in place", async () => {
      const target = await seed();
      await coolPrimary(target.companyId);
      const response = await request(app({ type: "agent", agentId: target.agentId, companyId: target.companyId, source: "agent_key", runId: randomUUID() }))
        .post(`/api/issues/${target.issueId}/restore-primary-model`)
        .send({});
      expect(response.status).toBe(403);
      const [cooldown] = await db.select().from(modelCooldowns).where(eq(modelCooldowns.companyId, target.companyId));
      expect(cooldown!.releasedAt).toBeNull();
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, target.issueId))).toHaveLength(0);
    });

    it("lets a board member force the primary and refuses an assignee without fallback models", async () => {
      const target = await seed();
      await member(target.companyId);
      await coolPrimary(target.companyId);
      const response = await request(app(board(target.companyId))).post(`/api/issues/${target.issueId}/restore-primary-model`).send({});
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).toMatchObject({ primary: PRIMARY, resetSelectors: [PRIMARY] });
      const run = await waitForRun(heartbeat, response.body.wakeRunId);
      expect(captured.get(run!.id)!.config.model).toBe(PRIMARY);

      const single = await seed({ model: PRIMARY });
      await member(single.companyId);
      const refused = await request(app(board(single.companyId))).post(`/api/issues/${single.issueId}/restore-primary-model`).send({});
      expect(refused.status).toBe(409);
    });
  });
});
