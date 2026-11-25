import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  modelCooldowns,
} from "@tickernelz/wardmote-db";
import type { AdapterModelProbeResult } from "@tickernelz/wardmote-adapter-utils";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  MODEL_COOLDOWN_PROBE_EXTENSION_MARGIN_MS,
  MODEL_COOLDOWN_PROBE_HOURLY_LIMIT,
  createModelCooldownProber,
  type ModelCooldownProber,
} from "../services/model-cooldown-prober.ts";
import { OMP_MODEL_PROBATION_KEY } from "@tickernelz/wardmote-shared";
import {
  MODEL_FALLBACK_DEFAULT_COOLDOWN_MS,
  prepareRunModelFallback,
  recordModelCooldown,
  resetModelCooldownsByUser,
} from "../services/model-fallback.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const PRIMARY = "fake/primary";
const BACKUP = "fake/backup";
const LIVE = "fake/live";
const T0 = Date.parse("2026-11-17T08:00:00.000Z");

type Script = (call: number, selector: string) => Promise<AdapterModelProbeResult> | AdapterModelProbeResult;
const ok: AdapterModelProbeResult = { ok: true, latencyMs: 40, costUsd: 0.0001 };
const down: AdapterModelProbeResult = { ok: false, latencyMs: 40, costUsd: null, error: "503 upstream unavailable" };

describeEmbeddedPostgres("model cooldown prober", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("model-cooldown-prober-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Prober",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "board-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Prober agent",
      role: "engineer",
      status: "idle",
      adapterType: "omp_local",
      adapterConfig: { model: PRIMARY, fallbackModels: [BACKUP] },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({ id: issueId, companyId, title: "Work", status: "todo", assigneeAgentId: agentId, responsibleUserId: "board-user" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded", issueId, scopeKind: "issue", responsibleUserId: "board-user", contextSnapshot: { issueId } });
    return { companyId, agentId, issueId, runId };
  }

  function harness(companyId: string, script: Script) {
    let nowMs = T0;
    const timers: Array<{ at: number; callback: () => void; cancelled: boolean }> = [];
    const calls: number[] = [];
    const busy = { value: false };
    const prober: ModelCooldownProber = createModelCooldownProber(db);
    const deps = {
      now: () => new Date(nowMs),
      random: () => 0.5,
      setTimer: (callback: () => void, delayMs: number) => {
        const timer = { at: nowMs + delayMs, callback, cancelled: false };
        timers.push(timer);
        return { cancel: () => { timer.cancelled = true; } };
      },
      resolveTarget: async (cooldown: { companyId: string }) =>
        cooldown.companyId === companyId ? { agentId: "agent", adapterType: "omp_local", config: {} } : null,
      probe: async (_target: unknown, selector: string) => {
        calls.push(nowMs);
        return script(calls.length, selector);
      },
      providerBusy: async (_companyId: string, _selector: string) => busy.value,
    };
    async function advance(ms: number) {
      const until = nowMs + ms;
      for (;;) {
        const due = timers.filter((timer) => !timer.cancelled && timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.cancelled = true;
        nowMs = Math.max(nowMs, due.at);
        due.callback();
        await prober.idle();
      }
      nowMs = until;
    }
    const pending = () => timers.filter((timer) => !timer.cancelled).length;
    return { prober, deps, advance, calls, pending, busy, now: () => new Date(nowMs) };
  }

  async function cool(
    target: { companyId: string; runId: string },
    at: Date,
    options: { probeAfter?: Date | null; until?: Date; selector?: string; reason?: "rate_limit" | "upstream" } = {},
  ) {
    await recordModelCooldown(db, {
      companyId: target.companyId,
      selector: options.selector ?? PRIMARY,
      until: options.until ?? new Date(at.getTime() + MODEL_FALLBACK_DEFAULT_COOLDOWN_MS),
      reason: options.reason ?? "upstream",
      sourceRunId: target.runId,
      probeAfter: options.probeAfter === undefined ? at : options.probeAfter,
      now: at,
    });
  }

  async function row(companyId: string, selector = PRIMARY) {
    const [cooldown] = await db.select().from(modelCooldowns).where(and(eq(modelCooldowns.companyId, companyId), eq(modelCooldowns.selector, selector)));
    return cooldown!;
  }

  async function startModel(companyId: string, now: Date, chain: string[] = [PRIMARY, BACKUP, LIVE]) {
    const config: Record<string, unknown> = { model: chain[0], fallbackModels: chain.slice(1) };
    const prepared = await prepareRunModelFallback({ db, companyId, adapterType: "omp_local", config, context: {}, now });
    return prepared!;
  }

  it("releases after two successful probes in a row and the next fresh run starts on the primary under probation", async () => {
    const target = await seed();
    const h = harness(target.companyId, () => ok);
    await h.prober.start(h.deps);
    await cool(target, h.now());
    h.prober.arm(target.companyId, PRIMARY);

    const coolingConfig: Record<string, unknown> = { model: PRIMARY, fallbackModels: [BACKUP] };
    const cooling = await prepareRunModelFallback({ db, companyId: target.companyId, adapterType: "omp_local", config: coolingConfig, context: {}, now: h.now() });
    expect(cooling!.selection.start).toBe(BACKUP);
    expect(cooling!.state).toMatchObject({ activeModel: BACKUP, reason: "upstream" });

    await h.advance(14_000);
    expect(h.calls).toHaveLength(0);
    await h.advance(1_000);
    expect(h.calls).toEqual([T0 + 15_000]);
    expect((await row(target.companyId)).cooldownUntil.getTime()).toBe(T0 + MODEL_FALLBACK_DEFAULT_COOLDOWN_MS);
    await h.advance(15_000);
    expect(h.calls).toEqual([T0 + 15_000, T0 + 30_000]);
    const released = await row(target.companyId);
    expect(released.cooldownUntil.getTime()).toBe(T0 + 30_000);
    expect(released.releasedAt?.getTime()).toBe(T0 + 30_000);
    expect(h.prober.armed()).toEqual([]);

    const events = await db.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, target.runId), eq(heartbeatRunEvents.eventType, "model.cooldown_released")));
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ selector: PRIMARY, reason: "probe_ok", pings: 2, consecutiveOk: 2, costUsd: 0.0002 });
    const activity = await db.select().from(activityLog).where(and(eq(activityLog.companyId, target.companyId), eq(activityLog.action, "issue.run_model_cooldown_released")));
    expect(activity).toHaveLength(1);
    expect(activity[0]!.entityId).toBe(target.issueId);

    const nextConfig: Record<string, unknown> = { model: PRIMARY, fallbackModels: [BACKUP] };
    const next = await prepareRunModelFallback({ db, companyId: target.companyId, adapterType: "omp_local", config: nextConfig, context: {}, now: new Date(T0 + 60_000) });
    expect(next!.selection.start).toBe(PRIMARY);
    expect(next!.state).toBeNull();
    expect(next!.selection.probation).toMatchObject({ selector: PRIMARY, firstEventTimeoutSec: 60 });
    expect(nextConfig[OMP_MODEL_PROBATION_KEY]).toEqual({ selector: PRIMARY, firstEventTimeoutSec: 60 });
    expect(nextConfig.ompSettings).toBeUndefined();

    const laterConfig: Record<string, unknown> = { model: PRIMARY, fallbackModels: [BACKUP] };
    const later = await prepareRunModelFallback({ db, companyId: target.companyId, adapterType: "omp_local", config: laterConfig, context: {}, now: new Date(T0 + 20 * 60_000) });
    expect(later!.selection.probation).toBeNull();
    expect(laterConfig[OMP_MODEL_PROBATION_KEY]).toBeUndefined();
    h.prober.stop();
  });

  it("starts the streak over when a probe fails between two successes", async () => {
    const target = await seed();
    const outcomes = [ok, down, ok, ok];
    const h = harness(target.companyId, (call) => outcomes[call - 1] ?? ok);
    await h.prober.start(h.deps);
    await cool(target, h.now());
    h.prober.arm(target.companyId, PRIMARY);
    await h.advance(15_000);
    await h.advance(15_000);
    expect(h.calls).toHaveLength(2);
    expect((await row(target.companyId)).releasedAt).toBeNull();
    await h.advance(30_000);
    expect(h.calls).toEqual([T0 + 15_000, T0 + 30_000, T0 + 60_000]);
    expect((await row(target.companyId)).releasedAt).toBeNull();
    await h.advance(15_000);
    expect(h.calls).toHaveLength(4);
    expect((await row(target.companyId)).releasedAt?.getTime()).toBe(h.calls[3]);
    h.prober.stop();
  });

  it("waits while live runs use the provider and never extends a cooldown for the gateway's concurrency cap", async () => {
    const target = await seed();
    const capped: AdapterModelProbeResult = { ok: false, latencyMs: 30, costUsd: null, error: "Concurrency limit exceeded for user, please retry later (gateway_concurrency_limit)" };
    const outcomes = [capped, ok, ok];
    const h = harness(target.companyId, (call) => outcomes[call - 1] ?? ok);
    await h.prober.start(h.deps);
    await cool(target, h.now());
    const until = (await row(target.companyId)).cooldownUntil.getTime();
    h.busy.value = true;
    h.prober.arm(target.companyId, PRIMARY);
    await h.advance(60_000);
    expect(h.calls).toHaveLength(0);
    h.busy.value = false;
    await h.advance(30_000);
    expect(h.calls).toHaveLength(1);
    const afterCap = await row(target.companyId);
    expect(afterCap.cooldownUntil.getTime()).toBe(until);
    expect(afterCap.probeFailingSince).toBeNull();
    await h.advance(30_000);
    await h.advance(15_000);
    expect(h.calls).toHaveLength(3);
    expect((await row(target.companyId)).releasedAt?.getTime()).toBe(h.calls[2]);
    h.prober.stop();
  });

  it("counts a live run on another model of the same provider as busy, and ignores other providers", async () => {
    const target = await seed();
    const { providerHasLiveRuns } = await import("../services/model-cooldown-prober.ts");
    expect(await providerHasLiveRuns(db, target.companyId, PRIMARY)).toBe(false);
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId, companyId: target.companyId, agentId: target.agentId, status: "running", issueId: target.issueId, scopeKind: "issue",
      responsibleUserId: "board-user", contextSnapshot: { issueId: target.issueId, wardmotePrimaryModel: PRIMARY, wardmoteModelFallback: { activeModel: "other/model" } },
    });
    expect(await providerHasLiveRuns(db, target.companyId, PRIMARY)).toBe(false);
    expect(await providerHasLiveRuns(db, target.companyId, "other/anything")).toBe(true);
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: target.issueId } }).where(eq(heartbeatRuns.id, runId));
    expect(await providerHasLiveRuns(db, target.companyId, "fake/another")).toBe(true);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
    expect(await providerHasLiveRuns(db, target.companyId, "fake/another")).toBe(false);
  });

  it("never probes before the provider's own retry-after", async () => {
    const target = await seed();
    const h = harness(target.companyId, () => down);
    await h.prober.start(h.deps);
    await cool(target, h.now(), { probeAfter: null, until: new Date(T0 + 10 * 60_000) });
    h.prober.arm(target.companyId, PRIMARY);
    await h.advance(11 * 60_000);
    expect(h.calls).toHaveLength(0);
    expect(h.pending()).toBe(0);

    await cool(target, h.now(), { probeAfter: new Date(h.now().getTime() + 90_000) });
    const startedAt = h.now().getTime();
    h.prober.arm(target.companyId, PRIMARY);
    await h.advance(89_000);
    expect(h.calls).toHaveLength(0);
    await h.advance(1_000);
    expect(h.calls).toEqual([startedAt + 90_000]);
    h.prober.stop();
  });

  it("keeps one probe schedule per company and selector however often the cooldown is written", async () => {
    const target = await seed();
    const h = harness(target.companyId, () => down);
    await h.prober.start(h.deps);
    const before = h.prober.armed().length;
    for (let index = 0; index < 3; index += 1) {
      await cool(target, h.now());
      h.prober.arm(target.companyId, PRIMARY);
    }
    expect(h.prober.armed().filter((key) => key.startsWith(target.companyId))).toHaveLength(1);
    expect(h.prober.armed()).toHaveLength(before + 1);
    await h.advance(15_000);
    expect(h.calls).toHaveLength(1);
    h.prober.stop();
  });

  it("rebuilds the schedule from model_cooldowns after a restart", async () => {
    const target = await seed();
    const before = harness(target.companyId, () => down);
    await before.prober.start(before.deps);
    await cool(target, before.now());
    before.prober.arm(target.companyId, PRIMARY);
    before.prober.stop();

    const after = harness(target.companyId, () => ok);
    expect(await after.prober.start(after.deps)).toBeGreaterThanOrEqual(1);
    expect(after.prober.armed()).toContain(`${target.companyId}:${PRIMARY}`);
    await after.advance(30_000);
    expect((await row(target.companyId)).releasedAt?.getTime()).toBe(T0 + 30_000);
    after.prober.stop();
  });

  it("writes no cooldown for a refusal, so nothing is probed", async () => {
    const target = await seed();
    const h = harness(target.companyId, () => ok);
    await h.prober.start(h.deps);
    const written = await recordModelCooldown(db, { companyId: target.companyId, selector: PRIMARY, until: new Date(T0 + 60_000), reason: "refusal", sourceRunId: target.runId, probeAfter: h.now() });
    expect(written).toBe(false);
    expect(await db.select().from(modelCooldowns).where(eq(modelCooldowns.companyId, target.companyId))).toHaveLength(0);
    h.prober.stop();
  });

  it("does not release a cooldown that a real run failure extended while the probes ran", async () => {
    const target = await seed();
    const h = harness(target.companyId, async (call) => {
      if (call === 2) await cool(target, h.now(), { until: new Date(h.now().getTime() + MODEL_FALLBACK_DEFAULT_COOLDOWN_MS) });
      return ok;
    });
    await h.prober.start(h.deps);
    await cool(target, h.now());
    h.prober.arm(target.companyId, PRIMARY);
    await h.advance(30_000);
    expect(h.calls).toHaveLength(2);
    const extended = await row(target.companyId);
    expect(extended.releasedAt).toBeNull();
    expect(extended.cooldownUntil.getTime()).toBe(T0 + 30_000 + MODEL_FALLBACK_DEFAULT_COOLDOWN_MS);
    await h.advance(30_000);
    expect((await row(target.companyId)).releasedAt?.getTime()).toBe(T0 + 60_000);
    h.prober.stop();
  });

  it("sends at most the hourly limit of probes while real runs keep failing", async () => {
    const target = await seed();
    const h = harness(target.companyId, async () => {
      await cool(target, h.now(), { until: new Date(h.now().getTime() + 2 * 60 * 60_000) });
      return ok;
    });
    await h.prober.start(h.deps);
    await cool(target, h.now(), { until: new Date(T0 + 2 * 60 * 60_000) });
    h.prober.arm(target.companyId, PRIMARY);
    await h.advance(60 * 60_000 - 1);
    expect(h.calls).toHaveLength(MODEL_COOLDOWN_PROBE_HOURLY_LIMIT);
    expect((await row(target.companyId)).releasedAt).toBeNull();
    h.prober.stop();
  });

  it("keeps two dead models cooling while their probes fail, so runs more than five minutes apart start on the live model", async () => {
    const target = await seed();
    const h = harness(target.companyId, (_call, selector) => (selector === LIVE ? ok : down));
    await h.prober.start(h.deps);
    await cool(target, h.now(), { selector: PRIMARY });
    await cool(target, h.now(), { selector: BACKUP });
    h.prober.arm(target.companyId, PRIMARY);
    h.prober.arm(target.companyId, BACKUP);

    expect((await startModel(target.companyId, new Date(T0 + 1_000))).selection.start).toBe(LIVE);
    for (const minutes of [6, 12, 30]) {
      await h.advance(T0 + minutes * 60_000 - h.now().getTime());
      const run = await startModel(target.companyId, h.now());
      expect(run.selection.start, `run at minute ${minutes}`).toBe(LIVE);
      expect(run.selection.cooling.map((model) => model.selector)).toEqual([PRIMARY, BACKUP]);
      expect(run.selection.cooling[0]).toMatchObject({ probeFailingSince: new Date(T0 + 15_000), lastProbeError: "503 upstream unavailable" });
    }
    const primary = await row(target.companyId, PRIMARY);
    expect(primary.releasedAt).toBeNull();
    expect(primary.cooldownUntil.getTime()).toBeGreaterThan(T0 + 30 * 60_000);
    expect(primary.updatedAt.getTime()).toBe(T0);
    h.prober.stop();
  });

  it("hands the primary back within two successful probes once it recovers after failing", async () => {
    const target = await seed();
    let alive = false;
    const h = harness(target.companyId, () => (alive ? ok : down));
    await h.prober.start(h.deps);
    await cool(target, h.now());
    h.prober.arm(target.companyId, PRIMARY);
    await h.advance(10 * 60_000);
    expect((await startModel(target.companyId, h.now(), [PRIMARY, BACKUP])).selection.start).toBe(BACKUP);

    alive = true;
    const recoveredAt = h.now().getTime();
    const before = h.calls.length;
    await h.advance(6 * 60_000);
    const released = await row(target.companyId);
    expect(released.releasedAt).not.toBeNull();
    expect(released.releasedBy).toBe("probe");
    expect(h.calls.length - before).toBe(2);
    expect(released.releasedAt!.getTime()).toBe(h.calls[h.calls.length - 1]);
    expect(released.releasedAt!.getTime() - recoveredAt).toBeLessThanOrEqual(6 * 60_000 + 15_000);
    expect((await startModel(target.companyId, h.now(), [PRIMARY, BACKUP])).selection.start).toBe(PRIMARY);
    h.prober.stop();
  });

  it("picks up a cooldown that expired while the server was down and keeps it while the model is still dead", async () => {
    const target = await seed();
    const before = harness(target.companyId, () => down);
    await before.prober.start(before.deps);
    await cool(target, before.now());
    before.prober.arm(target.companyId, PRIMARY);
    await before.advance(4 * 60_000);
    before.prober.stop();
    const downUntil = (await row(target.companyId)).cooldownUntil.getTime();

    const after = harness(target.companyId, () => down);
    await after.advance(downUntil + 3 * 60_000 - after.now().getTime());
    expect((await startModel(target.companyId, after.now(), [PRIMARY, BACKUP])).selection.start).toBe(PRIMARY);
    await after.prober.start(after.deps);
    expect(after.prober.armed()).toContain(`${target.companyId}:${PRIMARY}`);
    await after.advance(15_000);
    expect(after.calls).toHaveLength(1);
    expect((await startModel(target.companyId, after.now(), [PRIMARY, BACKUP])).selection.start).toBe(BACKUP);
    after.prober.stop();
  });

  it("never shortens or re-arms a cooldown a real run rewrote during a failing probe", async () => {
    const target = await seed();
    const quotaUntil = new Date(T0 + 60 * 60_000);
    const h = harness(target.companyId, async (call) => {
      if (call === 4) await cool(target, h.now(), { until: quotaUntil, probeAfter: null, reason: "rate_limit" });
      return down;
    });
    await h.prober.start(h.deps);
    await cool(target, h.now());
    h.prober.arm(target.companyId, PRIMARY);
    await h.advance(3 * 60_000);
    expect(h.calls).toHaveLength(3);
    await cool(target, h.now(), { until: new Date(h.now().getTime() + 60_000) });
    const realWrite = await row(target.companyId);
    expect(realWrite.cooldownUntil.getTime()).toBe(T0 + 105_000 + 120_000 + MODEL_COOLDOWN_PROBE_EXTENSION_MARGIN_MS);
    expect(realWrite.updatedAt.getTime()).toBe(h.now().getTime());

    await h.advance(60_000);
    expect(h.calls).toHaveLength(4);
    const quota = await row(target.companyId);
    expect(quota.cooldownUntil.getTime()).toBe(quotaUntil.getTime());
    expect(quota.reason).toBe("rate_limit");
    expect(quota.probeAfter).toBeNull();
    expect(h.prober.armed()).not.toContain(`${target.companyId}:${PRIMARY}`);
    await h.advance(30 * 60_000);
    expect(h.calls).toHaveLength(4);
    h.prober.stop();
  });

  it("leaves a cooldown a user reset alone, even when a failing probe was in flight or the server restarts", async () => {
    const target = await seed();
    const h = harness(target.companyId, async (call) => {
      if (call === 2) await resetModelCooldownsByUser(db, { companyId: target.companyId, selectors: [PRIMARY], now: h.now() });
      return down;
    });
    await h.prober.start(h.deps);
    await cool(target, h.now());
    h.prober.arm(target.companyId, PRIMARY);
    await h.advance(45_000);
    expect(h.calls).toHaveLength(2);
    const reset = await row(target.companyId);
    expect(reset.releasedBy).toBe("user");
    expect(reset.cooldownUntil.getTime()).toBe(T0 + 45_000);
    expect(h.prober.armed()).not.toContain(`${target.companyId}:${PRIMARY}`);
    h.prober.stop();

    const after = harness(target.companyId, () => down);
    await after.advance(60_000);
    await after.prober.start(after.deps);
    expect(after.prober.armed()).not.toContain(`${target.companyId}:${PRIMARY}`);
    await after.advance(10 * 60_000);
    expect(after.calls).toHaveLength(0);
    expect((await row(target.companyId)).cooldownUntil.getTime()).toBe(T0 + 45_000);
    expect((await startModel(target.companyId, after.now(), [PRIMARY, BACKUP])).selection.start).toBe(PRIMARY);

    await cool(target, after.now());
    expect((await row(target.companyId)).releasedAt).toBeNull();
    after.prober.arm(target.companyId, PRIMARY);
    expect(after.prober.armed()).toContain(`${target.companyId}:${PRIMARY}`);
    after.prober.stop();
  });

  it("starts on the model no probe has proven dead when every chain model is cooling", async () => {
    const target = await seed();
    const h = harness(target.companyId, (_call, selector) => (selector === LIVE ? ok : down));
    await h.prober.start(h.deps);
    await cool(target, h.now(), { selector: PRIMARY });
    await cool(target, h.now(), { selector: BACKUP });
    h.prober.arm(target.companyId, PRIMARY);
    h.prober.arm(target.companyId, BACKUP);
    await h.advance(10 * 60_000);
    await cool(target, h.now(), { selector: LIVE, probeAfter: null });

    const run = await startModel(target.companyId, h.now());
    expect(run.selection.start).toBe(LIVE);
    expect(run.selection.cooling.map((model) => model.selector)).toEqual([PRIMARY, BACKUP]);

    const backupUntil = (await row(target.companyId, BACKUP)).cooldownUntil.getTime();
    await db.update(modelCooldowns).set({ probeFailingSince: h.now() }).where(and(eq(modelCooldowns.companyId, target.companyId), eq(modelCooldowns.selector, LIVE)));
    await db.update(modelCooldowns).set({ cooldownUntil: new Date(backupUntil + 60 * 60_000) }).where(and(eq(modelCooldowns.companyId, target.companyId), eq(modelCooldowns.selector, LIVE)));
    const primaryUntil = (await row(target.companyId, PRIMARY)).cooldownUntil.getTime();
    const soonest = primaryUntil <= backupUntil ? PRIMARY : BACKUP;
    expect((await startModel(target.companyId, h.now())).selection.start).toBe(soonest);
    h.prober.stop();
  });

  it("pulls forward a retry that waited only for the released cooldown", async () => {
    const target = await seed();
    const h = harness(target.companyId, () => ok);
    await h.prober.start(h.deps);
    await cool(target, h.now());
    const until = new Date(T0 + MODEL_FALLBACK_DEFAULT_COOLDOWN_MS);
    const waitingId = randomUUID();
    const unrelatedId = randomUUID();
    await db.insert(heartbeatRuns).values([
      { id: waitingId, companyId: target.companyId, agentId: target.agentId, status: "scheduled_retry", scheduledRetryAt: until,
        contextSnapshot: { wardmoteForcedModel: PRIMARY, transientRetryNotBefore: until.toISOString() } },
      { id: unrelatedId, companyId: target.companyId, agentId: target.agentId, status: "scheduled_retry", scheduledRetryAt: until,
        contextSnapshot: { wardmoteForcedModel: BACKUP, transientRetryNotBefore: until.toISOString() } },
    ]);
    h.prober.arm(target.companyId, PRIMARY);
    await h.advance(30_000);
    const [waiting] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, waitingId));
    const [unrelated] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, unrelatedId));
    expect(waiting!.scheduledRetryAt!.getTime()).toBe(T0 + 30_000);
    expect(unrelated!.scheduledRetryAt!.getTime()).toBe(until.getTime());
    h.prober.stop();
  });
});
