import type { AdapterRuntimeEvent } from "@tickernelz/wardmote-adapter-utils";
import { OMP_MODEL_PROBATION_KEY } from "@tickernelz/wardmote-shared";
import { classifyFallbackError, type OmpFallbackErrorKind, type OmpFallbackReason } from "./failure.js";

const THINKING_SUFFIX_RE = /:(?:auto|off|minimal|low|medium|high|xhigh|max)$/i;
const DEFAULT_COOLDOWN_MS = 5 * 60_000;
const FALLBACK_KIND_LABELS: Record<OmpFallbackErrorKind, string> = {
  no_accounts: "503 no available accounts",
  refusal: "refusal",
  timeout: "timeout",
  concurrency_limit: "concurrency limit",
  rate_limit: "rate limit",
  upstream: "upstream error",
};

type JsonObject = Record<string, unknown>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

/** Drops an OMP thinking-level suffix so selectors compare by provider/model. */
export function stripOmpThinkingSuffix(selector: string): string {
  return selector.trim().replace(THINKING_SUFFIX_RE, "");
}

function effortOverrides(config: Record<string, unknown>): Record<string, unknown> {
  const raw = config.modelEfforts;
  return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

/** A fallback carries its own effort as an OMP selector suffix, so a mid-run switch does not inherit the primary level. */
function withEffortSuffix(selector: string, efforts: Record<string, unknown>): string {
  if (THINKING_SUFFIX_RE.test(selector)) return selector;
  const effort = text(efforts[selector]);
  return effort ? `${selector}:${effort}` : selector;
}

/** The ordered fallback chain for the run's model, or null when the agent has none. */
export function ompFallbackChain(config: Record<string, unknown>): { key: string; chain: string[] } | null {
  const key = text(config.model);
  if (!key || !Array.isArray(config.fallbackModels)) return null;
  const efforts = effortOverrides(config);
  const chain: string[] = [];
  for (const entry of config.fallbackModels) {
    const selector = text(entry);
    if (!selector || selector === key) continue;
    const suffixed = withEffortSuffix(selector, efforts);
    if (chain.includes(suffixed)) continue;
    chain.push(suffixed);
  }
  return chain.length > 0 ? { key, chain } : null;
}

const HOLD_ATTEMPTS = 2;
const PROBATION_HOLD_ATTEMPTS = 3;
const HOLD_MS = 10 * 60_000;

export interface OmpFallbackHold {
  primary: string;
  start: string;
  selectors: string[];
  holdAttempts: number;
  holdMs: number;
  probation: { selector: string; firstEventTimeoutSec: number; holdAttempts: number } | null;
}

function probationOf(config: Record<string, unknown>): { selector: string; firstEventTimeoutSec: number } | null {
  const raw = object(config[OMP_MODEL_PROBATION_KEY]);
  const selector = stripOmpThinkingSuffix(text(raw?.selector));
  const seconds = raw?.firstEventTimeoutSec;
  if (!selector || typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  return { selector, firstEventTimeoutSec: Math.floor(seconds) };
}

/** What the run's OMP extension needs to keep a transient failure on the model it hit before the chain moves on. */
export function ompFallbackHold(config: Record<string, unknown>, primary: string): OmpFallbackHold | null {
  const fallback = ompFallbackChain(config);
  if (!fallback) return null;
  const start = stripOmpThinkingSuffix(fallback.key);
  const selectors = [start, ...fallback.chain.map(stripOmpThinkingSuffix)].filter((selector, index, all) => all.indexOf(selector) === index);
  const probation = probationOf(config);
  return {
    primary: stripOmpThinkingSuffix(primary) || start,
    start,
    selectors,
    holdAttempts: HOLD_ATTEMPTS,
    holdMs: HOLD_MS,
    probation: probation ? { ...probation, holdAttempts: PROBATION_HOLD_ATTEMPTS } : null,
  };
}

export interface OmpModelFallbackSwitch {
  from: string;
  to: string;
  reason: OmpFallbackReason;
  errorKind: OmpFallbackErrorKind;
  error: string | null;
  retryAfterMs: number;
  retryAfterSource: "provider" | "default";
  at: string;
}

export interface OmpModelFallbackTracker {
  ingest(event: JsonObject | null): Promise<void>;
  snapshot(): { primary: string; start: string; active: string; switches: OmpModelFallbackSwitch[] };
}

export function createOmpModelFallbackTracker(input: {
  primary: string;
  start: string;
  emit: ((event: AdapterRuntimeEvent) => Promise<void>) | undefined;
}): OmpModelFallbackTracker {
  let active = input.start;
  let lastRetryError = "";
  const switches: OmpModelFallbackSwitch[] = [];
  const emit = async (event: AdapterRuntimeEvent) => {
    if (!input.emit) return;
    try {
      await input.emit(event);
    } catch {
    }
  };
  return {
    async ingest(event) {
      if (!event) return;
      const type = text(event.type);
      if (type === "auto_retry_start") {
        lastRetryError = text(event.errorMessage);
        return;
      }
      if (type === "retry_fallback_applied") {
        const from = stripOmpThinkingSuffix(text(event.from));
        const to = stripOmpThinkingSuffix(text(event.to));
        if (!from || !to || from === to || from !== active) return;
        const cause = classifyFallbackError(text(event.reason) || lastRetryError);
        const { reason, error } = cause;
        const errorKind = cause.kind;
        const retryAfterMs = cause.retryAfterMs ?? DEFAULT_COOLDOWN_MS;
        const retryAfterSource = cause.providerRetryAfter ? "provider" : "default";
        lastRetryError = "";
        active = to;
        switches.push({ from, to, reason, errorKind, error, retryAfterMs, retryAfterSource, at: new Date().toISOString() });
        await emit({
          eventType: "model.fallback",
          stream: "system",
          level: "warn",
          message: `Fallback: ${to} (primary ${input.primary}: ${FALLBACK_KIND_LABELS[errorKind]}${error ? ` — ${error}` : ""})`,
          payload: { phase: "in_run", from, to, primary: input.primary, reason, errorKind, error, retryAfterMs, retryAfterSource },
        });
        return;
      }
      if (type !== "message_end" && type !== "turn_end") return;
      if (active === input.primary) return;
      const message = object(event.message);
      if (!message || text(message.role) !== "assistant") return;
      const stopReason = text(message.stopReason);
      if (stopReason === "aborted") return;
      const provider = text(message.provider);
      const model = text(message.model);
      if (!provider || !model || `${provider}/${model}` !== stripOmpThinkingSuffix(input.primary)) return;
      const from = active;
      active = input.primary;
      if (stopReason === "error") return;
      await emit({
        eventType: "model.fallback_restored",
        stream: "system",
        level: "info",
        message: `Back on primary model ${input.primary}`,
        payload: { from, to: input.primary },
      });
    },
    snapshot() {
      return { primary: input.primary, start: input.start, active, switches: [...switches] };
    },
  };
}
