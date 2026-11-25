import type { AdapterExecutionResult } from "@tickernelz/wardmote-adapter-utils";

type AdapterExecutionErrorFamily = NonNullable<AdapterExecutionResult["errorFamily"]>;

export interface OmpFailureClassification {
  errorCode: string | null;
  errorFamily: AdapterExecutionErrorFamily | null;
  retryNotBefore: string | null;
}

const QUOTA_RE = /\b(rate[_ -]?limit|quota|too many requests|429|usage limit|insufficient[_ -]?quota|credit balance|out of credits|insufficient (?:credit|balance|funds)|credit insufficient)\b/i;
const TRANSIENT_RE = /\b(overloaded|server error|internal error|service unavailable|bad gateway|gateway timeout|50[0234]|econnreset|etimedout|econnrefused|enotfound|socket hang up|stream (?:closed|error)|temporarily unavailable)\b/i;
const REFUSAL_RE = /\b(refus(?:al|ed)|cannot assist|can't assist|content policy|safety (?:policy|filter)|blocked by (?:the )?provider)\b/i;
const REFRESH_REUSED_RE = /\brefresh token (?:was )?(?:already used|reused|rotation)\b/i;
const REFRESH_EXPIRED_RE = /\brefresh token (?:has )?expired\b/i;
const REFRESH_INVALID_RE = /\brefresh token (?:is )?(?:invalid|revoked|invalidated)\b/i;
const AGENT_START_POLICY_CHANGED_RE = /\bsystem prompt changed repeatedly during before_agent_start\b/i;
const PROVIDER_REQUEST_REJECTED_RE = /\b4(?!29)\d\d\b[^\n]*\binvalid_request_error\b/i;
const PROMPT_TOO_LONG_RE = /\b(?:prompt is too long|context_length_exceeded|maximum context length|exceeds? the (?:model's )?context window|input is too long for)\b/i;
const CONCURRENCY_RE = /\b(?:concurrency limit|concurrent (?:requests?|connections?) limit|too many concurrent|gateway_concurrency_limit)\b/i;
const NO_ACCOUNTS_RE = /\bno available accounts?\b/i;
const TIMEOUT_RE = /\b(?:timed out|timeout|etimedout)\b/i;
const CONCURRENCY_RETRY_MS = 30_000;
const FALLBACK_ERROR_MAX_CHARS = 200;

const RETRY_AFTER_SECONDS_RE = /\bretry[- ]?after["':\s]+(\d+(?:\.\d+)?)\b/i;
const RETRY_IN_RE = /\btry again in (\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|seconds?|m|minutes?|h|hours?)\b/i;
const RETRY_AT_RE = /\bresets? at (\d{4}-\d{2}-\d{2}T[\d:.]+Z)\b/i;
const REQUESTED_WAIT_RE = /\bprovider requested (\d+)\s*ms wait\b/i;
const RETRY_AFTER_MS_RE = /\bretry-after-ms\s*[:=]\s*(\d+)\b/i;

export type OmpFallbackReason = "rate_limit" | "upstream" | "refusal";
export type OmpFallbackErrorKind = "no_accounts" | "refusal" | "timeout" | "concurrency_limit" | "rate_limit" | "upstream";

export interface OmpFallbackError {
  reason: OmpFallbackReason;
  kind: OmpFallbackErrorKind;
  error: string | null;
  retryAfterMs: number | null;
  providerRetryAfter: boolean;
}

/** Maps the error that made OMP switch models onto the fallback reason shown to operators. */
export function classifyFallbackReason(text: string): OmpFallbackReason {
  return classifyFallbackError(text).reason;
}

/** Reason, kind, readable excerpt and wait of the error that made OMP switch models. */
export function classifyFallbackError(raw: string): OmpFallbackError {
  const text = raw.trim();
  const error = text ? text.replace(/^request failed:\s*/i, "").replace(/\s+/g, " ").slice(0, FALLBACK_ERROR_MAX_CHARS) : null;
  const providerRetryAfterMs = retryDelayMsFromText(text);
  const providerRetryAfter = providerRetryAfterMs !== null;
  const cause = (reason: OmpFallbackReason, kind: OmpFallbackErrorKind, retryAfterMs = providerRetryAfterMs): OmpFallbackError =>
    ({ reason, kind, error, retryAfterMs, providerRetryAfter });
  if (CONCURRENCY_RE.test(text)) return cause("rate_limit", "concurrency_limit", providerRetryAfterMs ?? CONCURRENCY_RETRY_MS);
  if (QUOTA_RE.test(text)) return cause("rate_limit", "rate_limit");
  if (REFUSAL_RE.test(text) && !TRANSIENT_RE.test(text)) return cause("refusal", "refusal", null);
  if (NO_ACCOUNTS_RE.test(text)) return cause("upstream", "no_accounts");
  if (TIMEOUT_RE.test(text)) return cause("upstream", "timeout");
  return cause("upstream", "upstream");
}

/** Provider-requested wait parsed from an error message, in milliseconds. */
export function retryDelayMsFromText(text: string): number | null {
  const delay = retryDelayMs(text);
  return delay !== null && Number.isFinite(delay) && delay > 0 ? Math.min(delay, 24 * 3_600_000) : null;
}

function retryDelayMs(text: string): number | null {
  const requested = REQUESTED_WAIT_RE.exec(text)?.[1];
  if (requested) return Number(requested);
  const afterMs = RETRY_AFTER_MS_RE.exec(text)?.[1];
  if (afterMs) return Number(afterMs);
  const after = RETRY_AFTER_SECONDS_RE.exec(text)?.[1];
  if (after) return Number(after) * 1000;
  const relative = RETRY_IN_RE.exec(text);
  const amount = relative?.[1];
  const rawUnit = relative?.[2];
  if (!amount || !rawUnit) return null;
  const value = Number(amount);
  const unit = rawUnit.toLowerCase();
  if (unit.startsWith("ms") || unit.startsWith("milli")) return value;
  if (unit.startsWith("s")) return value * 1000;
  if (unit.startsWith("m")) return value * 60_000;
  return value * 3_600_000;
}

function retryNotBefore(text: string): string | null {
  const absolute = RETRY_AT_RE.exec(text);
  const stamp = absolute?.[1];
  if (stamp) {
    const parsed = new Date(stamp);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  const delay = retryDelayMs(text);
  if (delay === null || !Number.isFinite(delay) || delay <= 0) return null;
  return new Date(Date.now() + Math.min(delay, 24 * 3_600_000)).toISOString();
}

export function classifyOmpFailure(input: {
  parsedError: string;
  stderr: string;
  timedOut: boolean;
  exitCode: number;
  signal: string | null;
}): OmpFailureClassification {
  if (input.timedOut) {
    return { errorCode: "omp_timeout", errorFamily: null, retryNotBefore: null };
  }
  const text = `${input.parsedError}\n${input.stderr}`;
  if (PROMPT_TOO_LONG_RE.test(text)) {
    return { errorCode: "omp_prompt_too_long", errorFamily: "prompt_too_long", retryNotBefore: null };
  }
  if (REFRESH_REUSED_RE.test(text)) {
    return { errorCode: "omp_refresh_token_reused", errorFamily: "refresh_token_reused", retryNotBefore: null };
  }
  if (REFRESH_EXPIRED_RE.test(text)) {
    return { errorCode: "omp_refresh_token_expired", errorFamily: "refresh_token_expired", retryNotBefore: null };
  }
  if (REFRESH_INVALID_RE.test(text)) {
    return { errorCode: "omp_refresh_token_invalidated", errorFamily: "refresh_token_invalidated", retryNotBefore: null };
  }
  if (CONCURRENCY_RE.test(text)) {
    return {
      errorCode: "omp_provider_concurrency_limit",
      errorFamily: "provider_quota",
      retryNotBefore: retryNotBefore(text) ?? new Date(Date.now() + CONCURRENCY_RETRY_MS).toISOString(),
    };
  }
  if (QUOTA_RE.test(text)) {
    return { errorCode: "omp_provider_quota", errorFamily: "provider_quota", retryNotBefore: retryNotBefore(text) };
  }
  if (TRANSIENT_RE.test(text)) {
    return { errorCode: "omp_transient_upstream", errorFamily: "transient_upstream", retryNotBefore: retryNotBefore(text) };
  }
  if (AGENT_START_POLICY_CHANGED_RE.test(text)) {
    return { errorCode: "omp_agent_start_policy_changed", errorFamily: "transient_upstream", retryNotBefore: null };
  }
  if (PROVIDER_REQUEST_REJECTED_RE.test(text)) {
    return { errorCode: "omp_provider_request_rejected", errorFamily: "provider_request_rejected", retryNotBefore: null };
  }
  if (REFUSAL_RE.test(text)) {
    return { errorCode: "omp_model_refusal", errorFamily: "model_refusal", retryNotBefore: null };
  }
  if (input.signal) {
    return { errorCode: `omp_signal_${input.signal.toLowerCase()}`, errorFamily: null, retryNotBefore: null };
  }
  if (input.exitCode !== 0) {
    return { errorCode: `omp_exit_${input.exitCode}`, errorFamily: null, retryNotBefore: null };
  }
  return { errorCode: null, errorFamily: null, retryNotBefore: null };
}
