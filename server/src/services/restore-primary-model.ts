import { and, eq, inArray, or, sql } from "drizzle-orm";
import { agents, heartbeatRuns, type Db } from "@tickernelz/wardmote-db";
import { adapterSupportsFallbackModels, type RestorePrimaryModelResult } from "@tickernelz/wardmote-shared";
import { parseObject } from "../adapters/utils.js";
import { conflict } from "../errors.js";
import { logActivity } from "./activity-log.js";
import type { WakeupOptions } from "./heartbeat/run-preparation.js";
import {
  MODEL_FALLBACK_FORCED_MODEL_KEY,
  MODEL_FALLBACK_PRIMARY_KEY,
  MODEL_FALLBACK_STATE_KEY,
  buildModelChain,
  loadModelCooldowns,
  readRunActiveModel,
  resetModelCooldownsByUser,
} from "./model-fallback.js";

export const RESTORE_PRIMARY_MODEL_COMMENT = "Kembali ke model utama.";
export const RESTORE_PRIMARY_MODEL_ACTION = "issue.run_model_primary_restored";
const OPEN_RUN_STATUSES = ["queued", "running", "scheduled_retry"];

export interface RestorePrimaryModelDeps {
  cancelRun: (runId: string, reason: string, options: { resultJson: Record<string, unknown>; suppressImmediateRecovery: boolean }) => Promise<unknown>;
  addComment: (issueId: string, body: string, actor: { userId: string }) => Promise<{ id: string }>;
  wakeup: (agentId: string, options: WakeupOptions) => Promise<{ id: string } | null>;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

/** The model an open run is on or will start on, read from its live fallback state or the retry lineage's forced model. */
function openRunModel(run: { contextSnapshot: unknown; resultJson: unknown }) {
  const context = parseObject(run.contextSnapshot);
  const forced = text(context[MODEL_FALLBACK_FORCED_MODEL_KEY]);
  const state = parseObject(context[MODEL_FALLBACK_STATE_KEY]);
  return text(state.activeModel) || forced || (context[MODEL_FALLBACK_PRIMARY_KEY] ? readRunActiveModel(run) : null) || null;
}

/** A user's forced switch of the task's assignee back to its primary model, ahead of any cooldown or probe. */
export async function restoreIssuePrimaryModel(
  db: Db,
  deps: RestorePrimaryModelDeps,
  input: { issue: { id: string; companyId: string; assigneeAgentId: string | null }; userId: string; now?: Date },
): Promise<RestorePrimaryModelResult> {
  const { issue } = input;
  if (!issue.assigneeAgentId) throw conflict("This task has no agent assignee to wake on its primary model");
  const [agent] = await db
    .select({ id: agents.id, adapterType: agents.adapterType, adapterConfig: agents.adapterConfig })
    .from(agents)
    .where(and(eq(agents.id, issue.assigneeAgentId), eq(agents.companyId, issue.companyId)))
    .limit(1);
  const config = parseObject(agent?.adapterConfig);
  const primary = text(config.model);
  const chain = agent && primary && adapterSupportsFallbackModels(agent.adapterType) ? buildModelChain(primary, config.fallbackModels) : [];
  if (!agent || chain.length < 2) throw conflict("The assignee has no fallback models, so it already runs on its primary model");

  const openRuns = await db
    .select({ id: heartbeatRuns.id, status: heartbeatRuns.status, contextSnapshot: heartbeatRuns.contextSnapshot, resultJson: heartbeatRuns.resultJson })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, issue.companyId),
      eq(heartbeatRuns.agentId, agent.id),
      inArray(heartbeatRuns.status, OPEN_RUN_STATUSES),
      or(eq(heartbeatRuns.issueId, issue.id), sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`),
    ));
  const onFallback = openRuns.flatMap((run) => {
    const model = openRunModel(run);
    return model && model !== primary ? [{ id: run.id, index: chain.indexOf(model) }] : [];
  });
  const cancelledRunIds: string[] = [];
  for (const run of onFallback) {
    const cancelled = await deps.cancelRun(run.id, "Cancelled to restore the primary model", {
      resultJson: { cancelledByActorType: "user", cancelledByUserId: input.userId, restorePrimaryModel: true },
      suppressImmediateRecovery: true,
    });
    if (cancelled) cancelledRunIds.push(run.id);
  }

  const now = input.now ?? new Date();
  const fallbackIndex = Math.max(-1, ...onFallback.map((run) => run.index));
  const cooling = fallbackIndex > 0 ? null : await loadModelCooldowns(db, issue.companyId, chain, now);
  const nextStart = fallbackIndex > 0 ? fallbackIndex : chain.findIndex((selector) => !cooling!.has(selector));
  const resetUpTo = Math.max(1, nextStart < 0 ? chain.length : nextStart);
  const resetSelectors = await resetModelCooldownsByUser(db, { companyId: issue.companyId, selectors: chain.slice(0, resetUpTo), now });

  const comment = await deps.addComment(issue.id, RESTORE_PRIMARY_MODEL_COMMENT, { userId: input.userId });
  const wake = await deps.wakeup(agent.id, {
    source: "on_demand",
    triggerDetail: "manual",
    reason: "issue_commented",
    payload: { issueId: issue.id, commentId: comment.id, mutation: "comment", restorePrimaryModel: true },
    requestedByActorType: "user",
    requestedByActorId: input.userId,
    allowRunCoalescing: false,
    contextSnapshot: {
      issueId: issue.id,
      taskId: issue.id,
      commentId: comment.id,
      wakeCommentId: comment.id,
      source: "issue.restore_primary_model",
      wakeReason: "issue_commented",
      [MODEL_FALLBACK_FORCED_MODEL_KEY]: primary,
    },
  });

  const result: RestorePrimaryModelResult = { primary, chain, cancelledRunIds, resetSelectors, commentId: comment.id, wakeRunId: wake?.id ?? null };
  await logActivity(db, {
    companyId: issue.companyId,
    actorType: "user",
    actorId: input.userId,
    agentId: agent.id,
    runId: null,
    action: RESTORE_PRIMARY_MODEL_ACTION,
    entityType: "issue",
    entityId: issue.id,
    details: { ...result },
  });
  return result;
}
