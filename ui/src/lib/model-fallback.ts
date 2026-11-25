import type {
  IssueRunModelOverrideOption,
  RunModelFallbackErrorKind,
  RunModelFallbackReason,
  RunModelFallbackState,
} from "@tickernelz/wardmote-shared";
import {
  describeModelValue,
  modelValueText,
  type ModelValueDisplay,
} from "@/components/task-chat/model-option-display";

export const MODEL_FALLBACK_REASON_LABELS: Record<RunModelFallbackReason, string> = {
  rate_limit: "rate limit",
  upstream: "upstream error",
  refusal: "refusal",
};

export const MODEL_FALLBACK_ERROR_KIND_LABELS: Record<RunModelFallbackErrorKind, string> = {
  no_accounts: "503 no available accounts",
  refusal: "refusal",
  timeout: "timeout",
  concurrency_limit: "concurrency limit",
  rate_limit: "rate limit",
  upstream: "upstream error",
};

const THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max|auto)$/;

/** Display name and provider for an OMP selector, from catalog options or the selector itself. */
export function describeFallbackModel(
  selector: string,
  options: readonly IssueRunModelOverrideOption[],
): ModelValueDisplay {
  const bare = selector.trim().replace(THINKING_SUFFIX, "");
  for (const candidate of [selector.trim(), bare]) {
    const display = describeModelValue(candidate, options);
    if (display.provider) return { ...display, id: selector };
  }
  const slash = bare.indexOf("/");
  if (slash <= 0 || slash === bare.length - 1) return { name: bare, provider: null, id: selector };
  return { name: bare.slice(slash + 1), provider: bare.slice(0, slash), id: selector };
}

/** Human label for a fallback reason, passing unknown reasons through. */
export function modelFallbackReasonLabel(reason: string): string {
  return MODEL_FALLBACK_REASON_LABELS[reason as RunModelFallbackReason] ?? reason.replace(/_/g, " ");
}

/** Label for why a run left its model: the error kind when known, else the reason. */
export function modelFallbackCauseLabel(reason: string, errorKind?: string | null): string {
  const kind = errorKind ? MODEL_FALLBACK_ERROR_KIND_LABELS[errorKind as RunModelFallbackErrorKind] : undefined;
  return kind ?? modelFallbackReasonLabel(reason);
}

/** Live-run badge text such as "Fallback: GPT · openai (primary: rate limit)". */
export function formatModelFallbackLabel(
  state: RunModelFallbackState,
  options: readonly IssueRunModelOverrideOption[],
): string {
  const active = modelValueText(describeFallbackModel(state.activeModel, options));
  const cause = modelFallbackCauseLabel(state.reason, state.errorKind);
  return `Fallback: ${active} (primary: ${cause}${state.error ? ` — ${state.error}` : ""})`;
}

function payloadText(payload: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = payload?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Readable line for model.fallback* run events, or null for any other event type. */
export function describeModelFallbackEvent(
  eventType: string,
  payload: Record<string, unknown> | null | undefined,
): string | null {
  if (eventType === "model.fallback") {
    const to = payloadText(payload, "to") ?? "next model";
    const primary = payloadText(payload, "primary") ?? payloadText(payload, "from");
    const reason = payloadText(payload, "reason");
    const errorKind = payloadText(payload, "errorKind");
    const error = payloadText(payload, "error");
    const cause = reason || errorKind ? modelFallbackCauseLabel(reason ?? "", errorKind) : null;
    const detail = [primary, cause].filter(Boolean).join(": ");
    const head = detail ? `Fallback: ${to} (primary ${detail})` : `Fallback: ${to}`;
    return error ? `${head} — ${error}` : head;
  }
  if (eventType === "model.fallback_restored") {
    const to = payloadText(payload, "to");
    return to ? `Fallback ended: back on ${to}` : "Fallback ended: back on the primary model";
  }
  if (eventType === "model.fallback_exhausted") {
    const primary = payloadText(payload, "primary");
    const tried = Array.isArray(payload?.tried)
      ? payload.tried.filter((entry): entry is string => typeof entry === "string")
      : [];
    const reason = payloadText(payload, "reason");
    const parts = [
      primary ? `primary ${primary}` : null,
      tried.length > 0 ? `tried ${tried.join(", ")}` : null,
      reason ? modelFallbackReasonLabel(reason) : null,
    ].filter(Boolean);
    return parts.length > 0
      ? `Fallback models exhausted (${parts.join("; ")})`
      : "Fallback models exhausted";
  }
  return null;
}
