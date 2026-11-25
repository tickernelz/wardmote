import { and, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { heartbeatRuns, modelCooldowns, type Db } from "@tickernelz/wardmote-db";
import { unprocessable } from "../errors.js";
import {
  AGENT_FALLBACK_EFFORTS_KEY,
  AGENT_FALLBACK_MODELS_KEY,
  adapterSupportsFallbackModels,
  fitAgentFallbackEfforts,
  OMP_MODEL_PROBATION_KEY,
  readAgentFallbackEfforts,
  readAgentFallbackModels,
  validateAgentFallbackModels,
  type RunModelFallbackReason,
  type RunModelFallbackState,
} from "@tickernelz/wardmote-shared";

export const MODEL_FALLBACK_DEFAULT_COOLDOWN_MS = 5 * 60_000;
/** How long after expiry an unreleased probeable cooldown is still picked up by the prober, so a restart keeps its schedule. */
export const MODEL_COOLDOWN_REARM_WINDOW_MS = 10 * 60_000;
const PROBE_ERROR_MAX_CHARS = 300;
export const MODEL_FALLBACK_STATE_KEY = "wardmoteModelFallback";
export const MODEL_FALLBACK_PRIMARY_KEY = "wardmotePrimaryModel";
/** Per-model attempt counts carried by a retry lineage, so a fresh wake always starts over. */
export const MODEL_FALLBACK_ATTEMPTS_KEY = "wardmoteModelAttempts";
/** The model a retry must start on, decided by the lineage that produced it. */
export const MODEL_FALLBACK_FORCED_MODEL_KEY = "wardmoteForcedModel";
/** Why the lineage left the primary, carried so a fallback run reports it. */
export const MODEL_FALLBACK_REASON_KEY = "wardmoteFallbackReason";
/** The primary model is tried twice before the chain moves on. */
export const MODEL_FALLBACK_PRIMARY_ATTEMPTS = 2;
/** The primary retry follows its failure closely so a blip does not look like an outage. */
export const MODEL_FALLBACK_PRIMARY_RETRY_DELAY_MS = 5_000;
/** Every later step of the chain waits one bounded interval. */
export const MODEL_FALLBACK_STEP_DELAY_MS = 30_000;
/** Attempts the lineage may consume, carried so recovery stops escalating once it is spent. */
export const MODEL_FALLBACK_BUDGET_KEY = "wardmoteModelAttemptBudget";
export const MODEL_FALLBACK_EVENT = "model.fallback";
export const MODEL_FALLBACK_RESTORED_EVENT = "model.fallback_restored";
export const MODEL_FALLBACK_EXHAUSTED_EVENT = "model.fallback_exhausted";
export const MODEL_FALLBACK_ACTIVITY_ACTION = "issue.run_model_fallback";
export const MODEL_FALLBACK_PROBATION_EVENT = "model.primary_probation";
/** How long after a probe release a run on that model gets the short first-response limit. */
export const MODEL_FALLBACK_PROBATION_MS = 10 * 60_000;
/** First-response limit for a run on a model a probe just released; OMP's own default is 300 s. */
export const MODEL_FALLBACK_PROBATION_FIRST_EVENT_TIMEOUT_SEC = 60;

export interface ModelCooldown {
  selector: string;
  until: Date;
  reason: RunModelFallbackReason;
}

export interface RunModelSelection {
  primary: string;
  chain: string[];
  start: string;
  overlayChain: string[];
  reason: RunModelFallbackReason | null;
  /** Set when the run starts on a model a probe or a user released within the probation window. */
  probation: { selector: string; releasedAt: Date; releasedBy: string | null; firstEventTimeoutSec: number } | null;
  /** Chain models ahead of the start that were skipped because they are cooling down. */
  cooling: CoolingModel[];
}

export interface CoolingModel {
  selector: string;
  until: Date;
  reason: RunModelFallbackReason;
  /** First failed probe of the current outage; null while no probe has failed. */
  probeFailingSince: Date | null;
  lastProbeAt: Date | null;
  lastProbeError: string | null;
}

export interface ModelFallbackStepPlan {
  chain: string[];
  attempts: Record<string, number>;
  /** The model the next attempt must start on, or null when the chain is spent. */
  start: string | null;
  /** True when the primary gets its immediate second try instead of the chain advancing. */
  fastRetry: boolean;
  /** Attempts the whole lineage may consume, primary retry included. */
  maxAttempts: number;
  /** When the start model's cooldown ends; the retry must not run before it. */
  availableAt: Date | null;
}

export type ModelFallbackRetryPlan = ModelFallbackStepPlan;

const REASON_LABELS: Record<RunModelFallbackReason, string> = {
  rate_limit: "rate limit",
  upstream: "upstream error",
  refusal: "refusal",
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

/** Human label for a fallback reason. */
export function modelFallbackReasonLabel(reason: RunModelFallbackReason): string {
  return REASON_LABELS[reason];
}

/** The fallback reason for a run failure family, or null when the family must not fall back. */
export function modelFallbackReasonForErrorFamily(family: unknown): RunModelFallbackReason | null {
  if (family === "provider_quota") return "rate_limit";
  if (family === "transient_upstream") return "upstream";
  if (family === "model_refusal") return "refusal";
  return null;
}

function isReason(value: unknown): value is RunModelFallbackReason {
  return value === "rate_limit" || value === "upstream" || value === "refusal";
}

/** Validates an agent's fallback list before it is stored; an empty list is removed. */
export function normalizeAgentFallbackModelsConfig(
  adapterType: string | null | undefined,
  adapterConfig: Record<string, unknown>,
  baseAdapterConfig?: Record<string, unknown>,
): Record<string, unknown> {
  if (!adapterSupportsFallbackModels(adapterType ?? "")) return adapterConfig;
  const touchesList = Object.hasOwn(adapterConfig, AGENT_FALLBACK_MODELS_KEY);
  if (!touchesList && !Object.hasOwn(adapterConfig, AGENT_FALLBACK_EFFORTS_KEY)) return adapterConfig;
  const next = { ...adapterConfig };
  let fallbacks = readAgentFallbackModels(baseAdapterConfig?.[AGENT_FALLBACK_MODELS_KEY]);
  if (touchesList) {
    const primary = text(adapterConfig.model) || text(baseAdapterConfig?.model);
    const validation = validateAgentFallbackModels(adapterConfig[AGENT_FALLBACK_MODELS_KEY], primary);
    if (!validation.ok) throw unprocessable(validation.message, { key: AGENT_FALLBACK_MODELS_KEY });
    fallbacks = validation.value;
    if (fallbacks.length === 0) delete next[AGENT_FALLBACK_MODELS_KEY];
    else next[AGENT_FALLBACK_MODELS_KEY] = fallbacks;
  }
  const efforts = fitAgentFallbackEfforts(adapterConfig[AGENT_FALLBACK_EFFORTS_KEY], fallbacks);
  if (Object.keys(efforts).length === 0) delete next[AGENT_FALLBACK_EFFORTS_KEY];
  else next[AGENT_FALLBACK_EFFORTS_KEY] = efforts;
  return next;
}

/** Primary first, then the agent's fallback list, without duplicates. */
export function buildModelChain(primary: string, fallbackModels: unknown): string[] {
  const chain = [primary.trim()];
  for (const selector of readAgentFallbackModels(fallbackModels)) {
    if (!chain.includes(selector)) chain.push(selector);
  }
  return chain;
}

function isCooling(cooldowns: Map<string, ModelCooldown>, selector: string, now: Date): boolean {
  const cooldown = cooldowns.get(selector);
  return Boolean(cooldown && cooldown.until.getTime() > now.getTime());
}

/** Attempts one selector may consume inside a lineage: the primary twice, every fallback once. */
export function modelFallbackAttemptLimit(selector: string, primary: string): number {
  return selector === primary ? MODEL_FALLBACK_PRIMARY_ATTEMPTS : 1;
}

/** Attempts a whole lineage may consume: every chain entry tried to its own limit. */
export function modelFallbackAttemptBudget(chain: readonly string[], primary: string): number {
  return chain.reduce((total, selector) => total + modelFallbackAttemptLimit(selector, primary), 0);
}

/** Decides the model for the next attempt; null start means the chain is spent. */
export function planModelFallbackStep(input: {
  chain: readonly string[];
  primary: string;
  active: string;
  reason: RunModelFallbackReason;
  attempts: Readonly<Record<string, number>>;
  now: Date;
  notBefore?: ReadonlyMap<string, Date>;
}): ModelFallbackStepPlan {
  const chain = [...input.chain];
  const attempts: Record<string, number> = { ...input.attempts };
  attempts[input.active] = (attempts[input.active] ?? 0) + 1;
  const exhausted = (selector: string) =>
    (attempts[selector] ?? 0) >= modelFallbackAttemptLimit(selector, input.primary);
  const retriesPrimary =
    input.reason !== "refusal" &&
    input.active === input.primary &&
    !exhausted(input.primary);
  const candidates = [
    ...(retriesPrimary ? [input.primary] : []),
    ...chain.filter((selector) => selector !== input.active && !exhausted(selector)),
  ];
  const coolingUntil = (selector: string) => {
    const until = input.notBefore?.get(selector);
    return until && until.getTime() > input.now.getTime() ? until : null;
  };
  const blocksStep = (selector: string) => {
    const until = coolingUntil(selector);
    return Boolean(until && until.getTime() > input.now.getTime() + MODEL_FALLBACK_STEP_DELAY_MS);
  };
  const start = candidates.find((selector) => !blocksStep(selector))
    ?? candidates.reduce<string | null>((earliest, selector) =>
      earliest === null || coolingUntil(selector)!.getTime() < coolingUntil(earliest)!.getTime() ? selector : earliest, null);
  return {
    chain,
    attempts,
    start,
    fastRetry: retriesPrimary && start === input.primary,
    maxAttempts: modelFallbackAttemptBudget(chain, input.primary),
    availableAt: start ? coolingUntil(start) : null,
  };
}


/** Active cooldowns for the given selectors in one company. */
export async function loadModelCooldowns(
  db: Db,
  companyId: string,
  selectors: readonly string[],
  now: Date,
): Promise<Map<string, ModelCooldown>> {
  const cooldowns = new Map<string, ModelCooldown>();
  if (selectors.length === 0) return cooldowns;
  const rows = await db
    .select({ selector: modelCooldowns.selector, until: modelCooldowns.cooldownUntil, reason: modelCooldowns.reason })
    .from(modelCooldowns)
    .where(and(
      eq(modelCooldowns.companyId, companyId),
      inArray(modelCooldowns.selector, [...selectors]),
      gt(modelCooldowns.cooldownUntil, now),
    ));
  for (const row of rows) {
    cooldowns.set(row.selector, {
      selector: row.selector,
      until: row.until,
      reason: isReason(row.reason) ? row.reason : "rate_limit",
    });
  }
  return cooldowns;
}

/** Records a company-wide cooldown (later expiry wins, clears a probe release); probeAfter null means never probe. */
export async function recordModelCooldown(
  db: Db,
  input: {
    companyId: string;
    selector: string;
    until: Date;
    reason: RunModelFallbackReason;
    sourceRunId: string | null;
    probeAfter: Date | null;
    now?: Date;
  },
): Promise<boolean> {
  const selector = input.selector.trim();
  if (!selector || input.reason === "refusal") return false;
  const writtenAt = input.now ?? new Date();
  const outageContinuesAfter = new Date(writtenAt.getTime() - MODEL_COOLDOWN_REARM_WINDOW_MS).toISOString();
  await db
    .insert(modelCooldowns)
    .values({
      companyId: input.companyId,
      selector,
      cooldownUntil: input.until,
      reason: input.reason,
      sourceRunId: input.sourceRunId,
      probeAfter: input.probeAfter,
      releasedAt: null,
      createdAt: writtenAt,
      updatedAt: writtenAt,
    })
    .onConflictDoUpdate({
      target: [modelCooldowns.companyId, modelCooldowns.selector],
      set: {
        reason: sql`case when excluded.cooldown_until > ${modelCooldowns.cooldownUntil} then excluded.reason else ${modelCooldowns.reason} end`,
        sourceRunId: sql`case when excluded.cooldown_until > ${modelCooldowns.cooldownUntil} then excluded.source_run_id else ${modelCooldowns.sourceRunId} end`,
        probeAfter: sql`case when excluded.cooldown_until > ${modelCooldowns.cooldownUntil} then excluded.probe_after else ${modelCooldowns.probeAfter} end`,
        cooldownUntil: sql`greatest(${modelCooldowns.cooldownUntil}, excluded.cooldown_until)`,
        probeFailingSince: sql`case when ${modelCooldowns.releasedAt} is null and ${modelCooldowns.cooldownUntil} > ${outageContinuesAfter}::timestamptz then ${modelCooldowns.probeFailingSince} else null end`,
        releasedAt: null,
        releasedBy: null,
        updatedAt: writtenAt,
      },
    });
  return true;
}

export interface ProbeableModelCooldown {
  companyId: string;
  selector: string;
  until: Date;
  probeAfter: Date;
  reason: RunModelFallbackReason;
  sourceRunId: string | null;
  updatedAt: Date;
}

function toProbeable(row: {
  companyId: string;
  selector: string;
  until: Date;
  probeAfter: Date | null;
  reason: string;
  sourceRunId: string | null;
  updatedAt: Date;
}): ProbeableModelCooldown | null {
  if (!row.probeAfter || row.probeAfter.getTime() >= row.until.getTime()) return null;
  if (row.reason !== "rate_limit" && row.reason !== "upstream") return null;
  return { ...row, probeAfter: row.probeAfter, reason: row.reason };
}

const probeableColumns = {
  companyId: modelCooldowns.companyId,
  selector: modelCooldowns.selector,
  until: modelCooldowns.cooldownUntil,
  probeAfter: modelCooldowns.probeAfter,
  reason: modelCooldowns.reason,
  sourceRunId: modelCooldowns.sourceRunId,
  updatedAt: modelCooldowns.updatedAt,
};

function rearmCutoff(now: Date) {
  return new Date(now.getTime() - MODEL_COOLDOWN_REARM_WINDOW_MS);
}

/** Unreleased rate-limit and upstream cooldowns a prober may check, across every company, including ones that expired within the rearm window. */
export async function listProbeableModelCooldowns(db: Db, now: Date): Promise<ProbeableModelCooldown[]> {
  const rows = await db
    .select(probeableColumns)
    .from(modelCooldowns)
    .where(and(gt(modelCooldowns.cooldownUntil, rearmCutoff(now)), isNotNull(modelCooldowns.probeAfter), isNull(modelCooldowns.releasedAt)));
  return rows.map(toProbeable).filter((row): row is ProbeableModelCooldown => row !== null);
}

/** The selector's unreleased probeable cooldown, active or expired within the rearm window. */
export async function readProbeableModelCooldown(
  db: Db,
  companyId: string,
  selector: string,
  now: Date,
): Promise<ProbeableModelCooldown | null> {
  const [row] = await db
    .select(probeableColumns)
    .from(modelCooldowns)
    .where(and(
      eq(modelCooldowns.companyId, companyId),
      eq(modelCooldowns.selector, selector),
      gt(modelCooldowns.cooldownUntil, rearmCutoff(now)),
      isNull(modelCooldowns.releasedAt),
    ))
    .limit(1);
  return row ? toProbeable(row) : null;
}

function shortProbeError(error: string | undefined) {
  const line = (error ?? "probe failed").replace(/\s+/g, " ").trim() || "probe failed";
  return line.length > PROBE_ERROR_MAX_CHARS ? `${line.slice(0, PROBE_ERROR_MAX_CHARS - 1)}…` : line;
}

/** Keeps an unreleased probeable cooldown alive until `until` after a failed probe; null when it is no longer probeable. */
export async function extendModelCooldownAfterFailedProbe(
  db: Db,
  input: { companyId: string; selector: string; until: Date; probedAt: Date; error: string | undefined },
): Promise<Date | null> {
  const [row] = await db
    .update(modelCooldowns)
    .set({
      cooldownUntil: sql`greatest(${modelCooldowns.cooldownUntil}, ${input.until.toISOString()}::timestamptz)`,
      probeFailingSince: sql`coalesce(${modelCooldowns.probeFailingSince}, ${input.probedAt.toISOString()}::timestamptz)`,
      lastProbeAt: input.probedAt,
      lastProbeError: shortProbeError(input.error),
    })
    .where(and(
      eq(modelCooldowns.companyId, input.companyId),
      eq(modelCooldowns.selector, input.selector),
      isNull(modelCooldowns.releasedAt),
      isNotNull(modelCooldowns.probeAfter),
      inArray(modelCooldowns.reason, ["rate_limit", "upstream"]),
      gt(modelCooldowns.cooldownUntil, rearmCutoff(input.probedAt)),
    ))
    .returning({ until: modelCooldowns.cooldownUntil });
  return row?.until ?? null;
}

/** Records a successful probe on an unreleased cooldown; the outage is no longer "failing since" anything. */
export async function recordModelCooldownProbeOk(
  db: Db,
  input: { companyId: string; selector: string; probedAt: Date },
): Promise<void> {
  await db
    .update(modelCooldowns)
    .set({ probeFailingSince: null, lastProbeAt: input.probedAt, lastProbeError: null })
    .where(and(
      eq(modelCooldowns.companyId, input.companyId),
      eq(modelCooldowns.selector, input.selector),
      isNull(modelCooldowns.releasedAt),
    ));
}

/** Ends the given selectors' active cooldowns on a user's request; a prober leaves them alone until a real run failure writes them again. */
export async function resetModelCooldownsByUser(
  db: Db,
  input: { companyId: string; selectors: readonly string[]; now: Date },
): Promise<string[]> {
  if (input.selectors.length === 0) return [];
  const rows = await db
    .update(modelCooldowns)
    .set({
      cooldownUntil: sql`least(${modelCooldowns.cooldownUntil}, ${input.now.toISOString()}::timestamptz)`,
      releasedAt: input.now,
      releasedBy: "user",
      updatedAt: input.now,
    })
    .where(and(
      eq(modelCooldowns.companyId, input.companyId),
      inArray(modelCooldowns.selector, [...input.selectors]),
      gt(modelCooldowns.cooldownUntil, rearmCutoff(input.now)),
      or(gt(modelCooldowns.cooldownUntil, input.now), isNull(modelCooldowns.releasedAt)),
    ))
    .returning({ selector: modelCooldowns.selector });
  return rows.map((row) => row.selector);
}

/** Ends a cooldown after successful probes unless a cooldown write happened since observedUpdatedAt. */
export async function releaseModelCooldown(
  db: Db,
  input: { companyId: string; selector: string; observedUpdatedAt: Date; now: Date },
): Promise<boolean> {
  const released = await db
    .update(modelCooldowns)
    .set({ cooldownUntil: input.now, releasedAt: input.now, releasedBy: "probe", updatedAt: input.now })
    .where(and(
      eq(modelCooldowns.companyId, input.companyId),
      eq(modelCooldowns.selector, input.selector),
      gt(modelCooldowns.cooldownUntil, input.now),
      sql`date_trunc('milliseconds', ${modelCooldowns.updatedAt}) = ${input.observedUpdatedAt.toISOString()}::timestamptz`,
    ))
    .returning({ id: modelCooldowns.id });
  return released.length > 0;
}

interface ModelCooldownState {
  until: Date;
  reason: RunModelFallbackReason;
  releasedAt: Date | null;
  releasedBy: string | null;
  probeFailingSince: Date | null;
  lastProbeAt: Date | null;
  lastProbeError: string | null;
}

async function loadModelCooldownStates(
  db: Db,
  companyId: string,
  selectors: readonly string[],
): Promise<Map<string, ModelCooldownState>> {
  const rows = await db
    .select({
      selector: modelCooldowns.selector,
      until: modelCooldowns.cooldownUntil,
      reason: modelCooldowns.reason,
      releasedAt: modelCooldowns.releasedAt,
      releasedBy: modelCooldowns.releasedBy,
      probeFailingSince: modelCooldowns.probeFailingSince,
      lastProbeAt: modelCooldowns.lastProbeAt,
      lastProbeError: modelCooldowns.lastProbeError,
    })
    .from(modelCooldowns)
    .where(and(eq(modelCooldowns.companyId, companyId), inArray(modelCooldowns.selector, [...selectors])));
  return new Map(rows.map((row) => [row.selector, {
    ...row,
    reason: isReason(row.reason) ? row.reason : "rate_limit",
  }]));
}

function probationFor(
  selector: string,
  state: ModelCooldownState | undefined,
  now: Date,
): RunModelSelection["probation"] {
  const releasedAt = state?.releasedAt;
  if (!releasedAt || state.until.getTime() > now.getTime()) return null;
  if (now.getTime() - releasedAt.getTime() > MODEL_FALLBACK_PROBATION_MS) return null;
  return { selector, releasedAt, releasedBy: state.releasedBy, firstEventTimeoutSec: MODEL_FALLBACK_PROBATION_FIRST_EVENT_TIMEOUT_SEC };
}

/** With every chain model cooling: the first one no probe has failed on, else the one whose cooldown ends first. */
function startWhileAllCooling(chain: readonly string[], states: Map<string, ModelCooldownState>): string {
  const unproven = chain.find((selector) => !states.get(selector)?.probeFailingSince);
  if (unproven) return unproven;
  return chain.reduce((best, selector) => (states.get(selector)!.until.getTime() < states.get(best)!.until.getTime() ? selector : best));
}

/** Starts the run on its lineage's forced model, else the first chain model not cooling down, with the rest as OMP's chain. */
export async function prepareRunModelFallback(input: {
  db: Db;
  companyId: string;
  adapterType: string;
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  now: Date;
}): Promise<{ selection: RunModelSelection; state: RunModelFallbackState | null } | null> {
  if (!adapterSupportsFallbackModels(input.adapterType)) return null;
  const primary = text(input.config.model);
  const chain = primary ? buildModelChain(primary, input.config.fallbackModels) : [];
  if (chain.length < 2) return null;
  const forced = text(input.context[MODEL_FALLBACK_FORCED_MODEL_KEY]);
  const states = await loadModelCooldownStates(input.db, input.companyId, chain);
  const coolingNow = (selector: string) => (states.get(selector)?.until.getTime() ?? 0) > input.now.getTime();
  const start = forced && chain.includes(forced)
    ? forced
    : chain.find((selector) => !coolingNow(selector)) ?? startWhileAllCooling(chain, states);
  input.config.model = start;
  input.config.fallbackModels = chain.filter((selector) => selector !== start);
  const overlayChain = input.config.fallbackModels as string[];
  const reason: RunModelFallbackReason | null = start === primary
    ? null
    : isReason(input.context[MODEL_FALLBACK_REASON_KEY])
      ? (input.context[MODEL_FALLBACK_REASON_KEY] as RunModelFallbackReason)
      : states.get(primary)?.reason ?? "upstream";
  const probation = probationFor(start, states.get(start), input.now);
  if (probation) {
    input.config[OMP_MODEL_PROBATION_KEY] = { selector: probation.selector, firstEventTimeoutSec: probation.firstEventTimeoutSec };
  }
  const primaryEffort = text(input.config.thinking);
  if (start !== primary && primaryEffort) {
    input.config[AGENT_FALLBACK_EFFORTS_KEY] = {
      ...readAgentFallbackEfforts(input.config[AGENT_FALLBACK_EFFORTS_KEY]),
      [primary]: primaryEffort,
    };
  }
  const cooling = chain.slice(0, Math.max(0, chain.indexOf(start))).flatMap((selector): CoolingModel[] => {
    const cooldown = states.get(selector);
    if (!cooldown || !coolingNow(selector)) return [];
    return [{
      selector,
      until: cooldown.until,
      reason: cooldown.reason,
      probeFailingSince: cooldown.probeFailingSince,
      lastProbeAt: cooldown.lastProbeAt,
      lastProbeError: cooldown.lastProbeError,
    }];
  });
  const selection: RunModelSelection = { primary, chain, start, overlayChain, reason, probation, cooling };
  const state: RunModelFallbackState | null = reason
    ? { primaryModel: primary, activeModel: start, reason, switchedAt: input.now.toISOString() }
    : null;
  return { selection, state };
}

/** Persists the live fallback view of a run so live-run readers see it while the run is going. */
export async function persistRunModelFallbackState(
  db: Db,
  runId: string,
  values: { primary?: string | null; state: RunModelFallbackState | null },
): Promise<void> {
  const patch: Record<string, unknown> = { [MODEL_FALLBACK_STATE_KEY]: values.state };
  if (values.primary !== undefined) patch[MODEL_FALLBACK_PRIMARY_KEY] = values.primary;
  await db
    .update(heartbeatRuns)
    .set({
      contextSnapshot: sql`coalesce(${heartbeatRuns.contextSnapshot}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
    })
    .where(eq(heartbeatRuns.id, runId));
}

/** The selector a finished run was on, from the adapter result, else its live state. */
export function readRunActiveModel(run: { resultJson: unknown; contextSnapshot: unknown }): string | null {
  const reported = text(asRecord(asRecord(run.resultJson).modelFallback).active);
  if (reported) return reported;
  const context = asRecord(run.contextSnapshot);
  return text(asRecord(context[MODEL_FALLBACK_STATE_KEY]).activeModel) || text(context[MODEL_FALLBACK_PRIMARY_KEY]) || null;
}

/** Retry plan for a run whose fallback chain was armed, or null when it had none. */
export async function planModelFallbackRetry(input: {
  db: Db;
  run: { companyId: string; contextSnapshot: unknown; resultJson: unknown };
  agentAdapterConfig: unknown;
  now: Date;
}): Promise<ModelFallbackRetryPlan | null> {
  const context = asRecord(input.run.contextSnapshot);
  const primary = text(context[MODEL_FALLBACK_PRIMARY_KEY]);
  if (!primary) return null;
  const chain = buildModelChain(primary, asRecord(input.agentAdapterConfig).fallbackModels);
  if (chain.length < 2) return null;
  const reason = modelFallbackReasonForErrorFamily(asRecord(input.run.resultJson).errorFamily);
  if (!reason) return null;
  const active = readRunActiveModel(input.run) ?? primary;
  if (!chain.includes(active)) return null;
  const cooldowns = await loadModelCooldowns(input.db, input.run.companyId, chain, input.now);
  const notBefore = new Map<string, Date>();
  for (const [selector, cooldown] of cooldowns) {
    if (selector !== active) notBefore.set(selector, cooldown.until);
  }
  const resultJson = asRecord(input.run.resultJson);
  const activeRetryNotBefore = readDate(resultJson.retryNotBefore ?? resultJson.transientRetryNotBefore);
  if (activeRetryNotBefore) notBefore.set(active, activeRetryNotBefore);
  return planModelFallbackStep({
    chain,
    primary,
    active,
    reason,
    attempts: readModelFallbackAttempts(context[MODEL_FALLBACK_ATTEMPTS_KEY]),
    now: input.now,
    notBefore,
  });
}

function readDate(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Attempts a run lineage may spend: its recorded model budget, else the adapter-agnostic budget. */
export function readModelFallbackAttemptBudget(
  contextSnapshot: Record<string, unknown> | null | undefined,
  unbudgetedAttempts: number,
): number {
  const recorded = contextSnapshot?.[MODEL_FALLBACK_BUDGET_KEY];
  if (typeof recorded !== "number" || !Number.isFinite(recorded) || recorded <= 0) return unbudgetedAttempts;
  return Math.floor(recorded);
}

/** Reads a lineage attempt map leniently: non-negative integer counts per selector. */
export function readModelFallbackAttempts(value: unknown): Record<string, number> {
  const record = asRecord(value);
  const attempts: Record<string, number> = {};
  for (const [selector, count] of Object.entries(record)) {
    if (typeof count !== "number" || !Number.isFinite(count) || count < 0) continue;
    const key = selector.trim();
    if (key) attempts[key] = Math.floor(count);
  }
  return attempts;
}
/** Run-event message for a model switch. */
export function modelFallbackEventMessage(input: { to: string; primary: string; reason: RunModelFallbackReason }): string {
  return `Fallback: ${input.to} (primary ${input.primary}: ${modelFallbackReasonLabel(input.reason)})`;
}
