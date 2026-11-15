import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, approvals, companies, createDb, heartbeatRuns, issues } from "@tickernelz/wardmote-db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { dashboardService, getUtcMonthStart } from "../services/dashboard.ts";
import { selectDashboardRunIds } from "../services/dashboard-run-selection.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres dashboard service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function utcDay(offsetDays: number): Date {
  const now = new Date();
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays, 12);
  return new Date(day);
}

function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

describe("getUtcMonthStart", () => {
  it("anchors the monthly spend window to UTC month boundaries", () => {
    expect(getUtcMonthStart(new Date("2026-03-31T20:30:00.000-05:00")).toISOString()).toBe(
      "2026-04-01T00:00:00.000Z",
    );
    expect(getUtcMonthStart(new Date("2026-04-01T00:30:00.000+14:00")).toISOString()).toBe(
      "2026-03-01T00:00:00.000Z",
    );
  });
});

describeEmbeddedPostgres("dashboard service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("wardmote-dashboard-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentWakeupRequests);
    await db.delete(approvals);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("selects distinct task cards before limiting and keeps taskless runs separate", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const repeatedIssueId = randomUUID();
    const otherIssueId = randomUUID();
    const activeRunId = randomUUID();
    const otherTaskRunId = randomUUID();
    const tasklessRunId = randomUUID();

    await db.insert(companies).values([
      { id: companyId, name: "Dashboard cards", issuePrefix: "CARDS" },
      { id: otherCompanyId, name: "Other company", issuePrefix: "OTHER" },
    ]);
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Builder", role: "engineer", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: otherAgentId, companyId: otherCompanyId, name: "Other", role: "engineer", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(heartbeatRuns).values([
      ...Array.from({ length: 6 }, (_, index) => ({
        id: randomUUID(), companyId, agentId, status: "succeeded",
        contextSnapshot: { issueId: repeatedIssueId },
        createdAt: new Date(`2026-04-10T10:0${index}:00.000Z`),
      })),
      { id: activeRunId, companyId, agentId, status: "running", contextSnapshot: { issueId: repeatedIssueId }, createdAt: new Date("2026-04-10T08:00:00.000Z") },
      { id: otherTaskRunId, companyId, agentId, status: "succeeded", contextSnapshot: { issueId: otherIssueId }, createdAt: new Date("2026-04-10T09:04:00.000Z") },
      { id: tasklessRunId, companyId, agentId, status: "succeeded", createdAt: new Date("2026-04-10T09:03:00.000Z") },
      { id: randomUUID(), companyId: otherCompanyId, agentId: otherAgentId, status: "running", contextSnapshot: { issueId: otherIssueId }, createdAt: new Date("2026-04-10T11:00:00.000Z") },
    ]);

    expect(await selectDashboardRunIds(db, companyId, 3)).toEqual([
      activeRunId, otherTaskRunId, tasklessRunId,
    ]);
  });

  it("aggregates the full 14-day run activity window without recent-run truncation", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const today = utcDay(0);
    const weekAgo = utcDay(-7);

    await db.insert(companies).values([
      {
        id: companyId,
        name: "Wardmote",
        issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
      {
        id: otherCompanyId,
        name: "Other",
        issuePrefix: `T${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
      },
    ]);

    await db.insert(agents).values([
      {
        id: agentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: otherAgentId,
        companyId: otherCompanyId,
        name: "OtherAgent",
        role: "engineer",
        status: "running",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values([
      ...Array.from({ length: 105 }, () => ({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: today,
      })),
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "failed",
        createdAt: weekAgo,
      },
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "timed_out",
        createdAt: weekAgo,
      },
      {
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "cancelled",
        createdAt: weekAgo,
      },
      {
        id: randomUUID(),
        companyId: otherCompanyId,
        agentId: otherAgentId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: weekAgo,
      },
    ]);

    const summary = await dashboardService(db).summary(companyId);

    expect(summary.runActivity).toHaveLength(14);
    const todayBucket = summary.runActivity.find((bucket) => bucket.date === utcDateKey(today));
    const weekAgoBucket = summary.runActivity.find((bucket) => bucket.date === utcDateKey(weekAgo));

    expect(todayBucket).toMatchObject({
      succeeded: 105,
      failed: 0,
      recovered: 0,
      other: 0,
      total: 105,
      failedByErrorCode: {},
    });
    expect(weekAgoBucket).toMatchObject({
      succeeded: 0,
      failed: 2,
      recovered: 0,
      other: 1,
      total: 3,
      // failed + timed_out with no error code both bucket under "unknown"
      failedByErrorCode: { unknown: 2 },
    });
  });

  it("separates recovered restart kills from true failures and breaks failures down by error code", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const day = utcDay(-2);

    await db.insert(companies).values({
      id: companyId,
      name: "Wardmote",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const base = {
      companyId,
      agentId,
      invocationSource: "assignment",
      createdAt: day,
    };

    // Direct recovery: a process-loss kill whose retry succeeded.
    const original = randomUUID();
    const retry = randomUUID();
    // Chained recovery: kill -> failed retry -> succeeded retry (both kills recovered).
    const chainedOriginal = randomUUID();
    const chainedRetry = randomUUID();
    const chainedRetrySuccess = randomUUID();
    // A genuine, unrecovered failure that should remain in the failed count.
    const trueFailure = randomUUID();

    await db.insert(heartbeatRuns).values([
      { ...base, id: original, status: "failed", errorCode: "process_lost" },
      { ...base, id: retry, status: "succeeded", retryOfRunId: original },
      { ...base, id: chainedOriginal, status: "failed", errorCode: "process_lost" },
      { ...base, id: chainedRetry, status: "failed", errorCode: "process_lost", retryOfRunId: chainedOriginal },
      { ...base, id: chainedRetrySuccess, status: "succeeded", retryOfRunId: chainedRetry },
      { ...base, id: trueFailure, status: "failed", errorCode: "provider_quota" },
    ]);

    const summary = await dashboardService(db).summary(companyId);
    const bucket = summary.runActivity.find((b) => b.date === utcDateKey(day));

    expect(bucket).toMatchObject({
      succeeded: 2,
      // original + chainedOriginal + chainedRetry all recovered via a later success
      recovered: 3,
      failed: 1,
      other: 0,
      total: 6,
      failedByErrorCode: { provider_quota: 1 },
    });
    // process_lost kills that recovered must not leak into the failed breakdown.
    expect(bucket?.failedByErrorCode.process_lost).toBeUndefined();
  });
  it("names the agents with unrecovered failures, the run duration spread, the wakes still waiting on open work and the oldest approval", async () => {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const flaky = randomUUID();
    const steady = randomUUID();
    const otherAgent = randomUUID();
    const day = utcDay(-1);
    const prefix = (id: string) => `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values([
      { id: companyId, name: "Summary", issuePrefix: prefix(companyId), requireBoardApprovalForNewAgents: false },
      { id: otherCompanyId, name: "Other", issuePrefix: prefix(otherCompanyId), requireBoardApprovalForNewAgents: false },
    ]);
    const agent = (id: string, cid: string, name: string) => ({
      id, companyId: cid, name, role: "engineer", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(agents).values([agent(flaky, companyId, "Flaky"), agent(steady, companyId, "Steady"), agent(otherAgent, otherCompanyId, "Other")]);
    const finished = (agentId: string, cid: string, minutes: number, status: string, extra: Record<string, unknown> = {}) => ({
      id: randomUUID(), companyId: cid, agentId, status, invocationSource: "assignment", createdAt: day,
      startedAt: day, finishedAt: new Date(day.getTime() + minutes * 60_000), ...extra,
    });
    const killed = randomUUID();
    await db.insert(heartbeatRuns).values([
      finished(flaky, companyId, 1, "failed", { errorCode: "provider_quota" }),
      finished(flaky, companyId, 2, "failed", { id: killed, errorCode: "process_lost" }),
      finished(flaky, companyId, 3, "succeeded", { retryOfRunId: killed }),
      finished(steady, companyId, 4, "succeeded"),
      finished(steady, companyId, 5, "succeeded"),
      finished(otherAgent, otherCompanyId, 90, "failed"),
    ]);
    const openTask = randomUUID();
    const doneTask = randomUUID();
    const cancelledTask = randomUUID();
    await db.insert(issues).values([
      { id: openTask, companyId, title: "Open", status: "todo", priority: "medium" },
      { id: doneTask, companyId, title: "Done", status: "done", priority: "medium" },
      { id: cancelledTask, companyId, title: "Cancelled", status: "cancelled", priority: "medium" },
    ]);
    const requestedAt = new Date("2026-09-25T06:00:00.000Z");
    const wake = (cid: string, agentId: string, status: string, at: Date, payload: Record<string, unknown> | null = null) => ({
      companyId: cid, agentId, source: "assignment", status, requestedAt: at, payload,
    });
    await db.insert(agentWakeupRequests).values([
      wake(companyId, flaky, "deferred_issue_execution", requestedAt, { issueId: openTask }),
      wake(companyId, steady, "queued", new Date("2026-11-01T00:00:00.000Z")),
      wake(companyId, steady, "completed", new Date("2026-08-01T00:00:00.000Z")),
      wake(companyId, flaky, "deferred_issue_execution", new Date("2026-09-01T00:00:00.000Z"), { issueId: doneTask }),
      wake(companyId, flaky, "deferred_issue_execution", new Date("2026-09-02T00:00:00.000Z"), {
        _wardmoteWakeContext: { issueId: cancelledTask },
      }),
      wake(otherCompanyId, otherAgent, "queued", new Date("2026-01-01T00:00:00.000Z")),
    ]);
    const approvalAt = new Date("2026-11-10T00:00:00.000Z");
    await db.insert(approvals).values([
      { companyId, type: "hire_agent", status: "pending", payload: {}, createdAt: approvalAt },
      { companyId, type: "hire_agent", status: "pending", payload: {}, createdAt: new Date("2026-11-12T00:00:00.000Z") },
      { companyId, type: "hire_agent", status: "approved", payload: {}, createdAt: new Date("2026-10-01T00:00:00.000Z") },
    ]);

    const summary = await dashboardService(db).summary(companyId);

    expect(summary.agentFailures).toEqual([{ agentId: flaky, agentName: "Flaky", runs: 3, failed: 1 }]);
    expect(summary.runDurations).toEqual({ p50Ms: 180_000, p95Ms: 288_000 });
    expect(summary.wakeQueue).toEqual({ waiting: 2, oldestWaitingAt: requestedAt.toISOString() });
    expect(summary.pendingApprovals).toBe(2);
    expect(summary.oldestPendingApprovalAt).toBe(approvalAt.toISOString());
  });
});
