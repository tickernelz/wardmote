import { and, eq, gt, sql } from "drizzle-orm";
import { agents, companies, heartbeatRuns, type Db } from "@tickernelz/wardmote-db";
import type { AdapterModelProbeResult } from "@tickernelz/wardmote-adapter-utils";
import { isForbiddenConfigEnvKey, parseObject } from "@tickernelz/wardmote-adapter-utils/server-utils";
import { findServerAdapter } from "../adapters/index.js";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import { environmentService } from "./environments.js";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import {
  MODEL_FALLBACK_FORCED_MODEL_KEY,
  extendModelCooldownAfterFailedProbe,
  listProbeableModelCooldowns,
  readProbeableModelCooldown,
  recordModelCooldownProbeOk,
  releaseModelCooldown,
  type ProbeableModelCooldown,
} from "./model-fallback.js";
import { secretService } from "./secrets.js";

/** Wait before each probe after a failed one: 15 s, 30 s, 60 s, 2 min, then 5 min for as long as probes keep failing. */
export const MODEL_COOLDOWN_PROBE_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 300_000] as const;
/** Life a failed probe gives its cooldown past the next probe: one probe (62 s with grace) plus one wait for a busy slot. */
export const MODEL_COOLDOWN_PROBE_EXTENSION_MARGIN_MS = 150_000;
/** Wait before the probe that confirms a successful one. */
export const MODEL_COOLDOWN_PROBE_CONFIRM_DELAY_MS = 15_000;
export const MODEL_COOLDOWN_PROBE_JITTER = 0.2;
/** Consecutive successful probes that end a cooldown. */
export const MODEL_COOLDOWN_PROBE_SUCCESSES = 2;
/** Probes one company and selector may send in any rolling hour. */
export const MODEL_COOLDOWN_PROBE_HOURLY_LIMIT = 20;
/** One omp bench process holds 350-385 MB RSS; two fit the smallest host (integron, about 2 GB available). */
export const MODEL_COOLDOWN_PROBE_CONCURRENCY = 2;
export const MODEL_COOLDOWN_RELEASED_EVENT = "model.cooldown_released";
export const MODEL_COOLDOWN_RELEASED_ACTION = "issue.run_model_cooldown_released";
const HOUR_MS = 60 * 60_000;

export interface ModelCooldownProbeTarget {
  agentId: string;
  adapterType: string;
  config: Record<string, unknown>;
}

export interface ModelCooldownProberDeps {
  now: () => Date;
  random: () => number;
  setTimer: (callback: () => void, delayMs: number) => { cancel: () => void };
  resolveTarget: (cooldown: ProbeableModelCooldown) => Promise<ModelCooldownProbeTarget | null>;
  probe: (target: ModelCooldownProbeTarget, selector: string) => Promise<AdapterModelProbeResult>;
}

interface ProbeState {
  companyId: string;
  selector: string;
  step: number;
  streak: number;
  streakBase: Date | null;
  recentPings: number[];
  pings: number;
  costUsd: number;
  lastLatencyMs: number | null;
  timer: { cancel: () => void } | null;
}

export interface ModelCooldownProber {
  start(overrides?: Partial<ModelCooldownProberDeps>): Promise<number>;
  stop(): void;
  arm(companyId: string, selector: string): void;
  armed(): string[];
  idle(): Promise<void>;
}

const probers = new WeakMap<Db, ModelCooldownProber>();

/** The process-wide cooldown prober for one database: one probe schedule per company and selector. */
export function modelCooldownProber(db: Db): ModelCooldownProber {
  let prober = probers.get(db);
  if (!prober) {
    prober = createModelCooldownProber(db);
    probers.set(db, prober);
  }
  return prober;
}

function keyOf(companyId: string, selector: string) {
  return `${companyId}\u0000${selector}`;
}

function jittered(delayMs: number, random: () => number) {
  return Math.round(delayMs * (1 - MODEL_COOLDOWN_PROBE_JITTER + 2 * MODEL_COOLDOWN_PROBE_JITTER * random()));
}

export function createModelCooldownProber(db: Db): ModelCooldownProber {
  const states = new Map<string, ProbeState>();
  const inFlight = new Set<Promise<void>>();
  const waiting: Array<() => void> = [];
  let running = 0;
  let deps: ModelCooldownProberDeps | null = null;

  const defaults = (): ModelCooldownProberDeps => ({
    now: () => new Date(),
    random: Math.random,
    setTimer: (callback, delayMs) => {
      const handle = setTimeout(callback, delayMs);
      handle.unref?.();
      return { cancel: () => clearTimeout(handle) };
    },
    resolveTarget: (cooldown) => resolveProbeTarget(db, cooldown),
    probe: async (target, selector) => {
      const adapter = findServerAdapter(target.adapterType);
      if (!adapter?.probeModel) return { ok: false, latencyMs: 0, costUsd: null, error: "adapter cannot probe models" };
      return adapter.probeModel({ config: target.config, selector });
    },
  });

  function schedule(state: ProbeState, delayMs: number) {
    if (!deps) return;
    state.timer?.cancel();
    state.timer = deps.setTimer(() => {
      state.timer = null;
      const work = tick(state).catch((error) => {
        logger.warn({ err: error, selector: state.selector, companyId: state.companyId }, "model cooldown probe tick threw");
        drop(state);
      });
      inFlight.add(work);
      void work.finally(() => inFlight.delete(work));
    }, Math.max(0, delayMs));
  }

  function drop(state: ProbeState) {
    state.timer?.cancel();
    state.timer = null;
    const key = keyOf(state.companyId, state.selector);
    if (states.get(key) === state) states.delete(key);
  }

  async function withSlot<T>(work: () => Promise<T>): Promise<T> {
    if (running >= MODEL_COOLDOWN_PROBE_CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve));
    running += 1;
    try {
      return await work();
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  }

  function resetStreak(state: ProbeState) {
    state.streak = 0;
    state.streakBase = null;
  }

  async function tick(state: ProbeState) {
    if (!deps || states.get(keyOf(state.companyId, state.selector)) !== state) return;
    const now = deps.now();
    const cooldown = await readProbeableModelCooldown(db, state.companyId, state.selector, now);
    if (!cooldown) return drop(state);
    if (cooldown.probeAfter.getTime() > now.getTime()) {
      return schedule(state, cooldown.probeAfter.getTime() - now.getTime());
    }
    state.recentPings = state.recentPings.filter((at) => at > now.getTime() - HOUR_MS);
    if (state.recentPings.length >= MODEL_COOLDOWN_PROBE_HOURLY_LIMIT) {
      return schedule(state, state.recentPings[0]! + HOUR_MS - now.getTime());
    }
    if (state.streakBase && state.streakBase.getTime() !== cooldown.updatedAt.getTime()) resetStreak(state);
    const target = await deps.resolveTarget(cooldown);
    if (!target) return drop(state);
    const streakBase = state.streakBase ?? cooldown.updatedAt;
    const result = await withSlot(() => deps!.probe(target, state.selector));
    const probedAt = deps.now();
    state.recentPings.push(probedAt.getTime());
    state.pings += 1;
    state.costUsd += result.costUsd ?? 0;
    state.lastLatencyMs = result.latencyMs;
    if (!result.ok) {
      resetStreak(state);
      const failedStep = state.step;
      state.step = Math.min(state.step + 1, MODEL_COOLDOWN_PROBE_DELAYS_MS.length - 1);
      const delayMs = jittered(MODEL_COOLDOWN_PROBE_DELAYS_MS[state.step]!, deps.random);
      const until = await extendModelCooldownAfterFailedProbe(db, {
        companyId: state.companyId,
        selector: state.selector,
        until: new Date(probedAt.getTime() + delayMs + MODEL_COOLDOWN_PROBE_EXTENSION_MARGIN_MS),
        probedAt,
        error: result.error,
      });
      logger.warn({
        companyId: state.companyId,
        selector: state.selector,
        step: failedStep,
        pings: state.pings,
        latencyMs: result.latencyMs,
        error: (result.error ?? "probe failed").slice(0, 200),
        cooldownUntil: until?.toISOString() ?? null,
        nextProbeInMs: until ? delayMs : null,
      }, "model cooldown probe failed");
      if (!until) return drop(state);
      return schedule(state, delayMs);
    }
    await recordModelCooldownProbeOk(db, { companyId: state.companyId, selector: state.selector, probedAt });
    if (cooldown.until.getTime() <= probedAt.getTime()) return drop(state);
    state.streak += 1;
    state.streakBase = streakBase;
    if (state.streak >= MODEL_COOLDOWN_PROBE_SUCCESSES) {
      const released = await releaseModelCooldown(db, {
        companyId: state.companyId,
        selector: state.selector,
        observedUpdatedAt: streakBase,
        now: probedAt,
      });
      if (released) {
        drop(state);
        await recordRelease(cooldown, state, probedAt);
        return;
      }
      resetStreak(state);
    }
    schedule(state, jittered(MODEL_COOLDOWN_PROBE_CONFIRM_DELAY_MS, deps.random));
  }

  async function recordRelease(cooldown: ProbeableModelCooldown, state: ProbeState, releasedAt: Date) {
    const pulled = await db
      .update(heartbeatRuns)
      .set({ scheduledRetryAt: releasedAt, updatedAt: releasedAt })
      .where(and(
        eq(heartbeatRuns.companyId, state.companyId),
        eq(heartbeatRuns.status, "scheduled_retry"),
        gt(heartbeatRuns.scheduledRetryAt, releasedAt),
        sql`${heartbeatRuns.contextSnapshot} ->> ${MODEL_FALLBACK_FORCED_MODEL_KEY} = ${state.selector}`,
        sql`(${heartbeatRuns.contextSnapshot} ->> 'transientRetryNotBefore')::timestamptz = ${heartbeatRuns.scheduledRetryAt}`,
      ))
      .returning({ id: heartbeatRuns.id });
    const details = {
      selector: state.selector,
      reason: "probe_ok",
      cooldownReason: cooldown.reason,
      pings: state.pings,
      consecutiveOk: MODEL_COOLDOWN_PROBE_SUCCESSES,
      costUsd: Number(state.costUsd.toFixed(6)),
      lastLatencyMs: state.lastLatencyMs,
      scheduledUntil: cooldown.until.toISOString(),
      releasedAt: releasedAt.toISOString(),
      retriesPulledForward: pulled.length,
    };
    logger.info(details, "model cooldown released by probe");
    if (!cooldown.sourceRunId) return;
    const [run] = await db
      .select({ id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, issueId: heartbeatRuns.issueId, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, cooldown.sourceRunId), eq(heartbeatRuns.companyId, state.companyId)))
      .limit(1);
    if (!run) return;
    await appendHeartbeatRunEvent(db, {
      companyId: state.companyId,
      runId: run.id,
      agentId: run.agentId,
      eventType: MODEL_COOLDOWN_RELEASED_EVENT,
      stream: "system",
      level: "info",
      message: `Cooldown for ${state.selector} released early: ${MODEL_COOLDOWN_PROBE_SUCCESSES} probes in a row succeeded after ${state.pings} probes`,
      payload: details,
    });
    const issueId = run.issueId ?? (typeof parseObject(run.contextSnapshot).issueId === "string" ? String(parseObject(run.contextSnapshot).issueId) : null);
    if (!issueId) return;
    await logActivity(db, {
      companyId: state.companyId,
      actorType: "system",
      actorId: "model-cooldown-prober",
      agentId: run.agentId,
      runId: run.id,
      action: MODEL_COOLDOWN_RELEASED_ACTION,
      entityType: "issue",
      entityId: issueId,
      details: { runId: run.id, agentId: run.agentId, ...details },
    });
  }

  function armState(companyId: string, selector: string) {
    const key = keyOf(companyId, selector);
    const existing = states.get(key);
    if (existing) {
      resetStreak(existing);
      return;
    }
    const state: ProbeState = {
      companyId,
      selector,
      step: 0,
      streak: 0,
      streakBase: null,
      recentPings: [],
      pings: 0,
      costUsd: 0,
      lastLatencyMs: null,
      timer: null,
    };
    states.set(key, state);
    schedule(state, jittered(MODEL_COOLDOWN_PROBE_DELAYS_MS[0], deps!.random));
  }

  return {
    async start(overrides) {
      deps = { ...defaults(), ...overrides };
      const cooldowns = await listProbeableModelCooldowns(db, deps.now());
      for (const cooldown of cooldowns) armState(cooldown.companyId, cooldown.selector);
      return cooldowns.length;
    },
    stop() {
      for (const state of states.values()) state.timer?.cancel();
      states.clear();
      deps = null;
    },
    arm(companyId, selector) {
      if (!deps || !selector) return;
      armState(companyId, selector);
    },
    armed() {
      return [...states.values()].map((state) => `${state.companyId}:${state.selector}`);
    },
    async idle() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
}

/** The agent whose run wrote the cooldown, with its runtime config resolved; null when its run cannot be reproduced on this host. */
export async function resolveProbeTarget(db: Db, cooldown: ProbeableModelCooldown): Promise<ModelCooldownProbeTarget | null> {
  if (!cooldown.sourceRunId) return null;
  const [row] = await db
    .select({ agent: agents, responsibleUserId: companies.defaultResponsibleUserId })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
    .innerJoin(companies, eq(companies.id, agents.companyId))
    .where(and(eq(heartbeatRuns.id, cooldown.sourceRunId), eq(heartbeatRuns.companyId, cooldown.companyId)))
    .limit(1);
  if (!row) return null;
  const { agent } = row;
  if (parseObject(agent.runtimeConfig).aiConnection) return null;
  const environments = environmentService(db);
  const environment = agent.defaultEnvironmentId ? await environments.getById(agent.defaultEnvironmentId) : null;
  if (environment && environment.driver !== "local") return null;
  const secrets = secretService(db);
  const context = {
    consumerType: "agent" as const,
    consumerId: agent.id,
    actorType: "system" as const,
    actorId: "model-cooldown-prober",
    responsibleUserId: row.responsibleUserId,
  };
  let config = (await secrets.resolveAdapterConfigForRuntime(agent.companyId, agent.adapterConfig, context, { adapterType: agent.adapterType })).config;
  if (environment) {
    const env = Object.fromEntries(Object.entries(parseObject(environment.envVars)).filter(([key]) => !isForbiddenConfigEnvKey(key)));
    const resolved = await secrets.resolveEnvBindings(agent.companyId, env, { ...context, consumerType: "environment", consumerId: environment.id });
    config = { ...config, env: { ...resolved.env, ...parseObject(config.env) } };
  }
  return { agentId: agent.id, adapterType: agent.adapterType, config };
}
