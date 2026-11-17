import { and, eq, inArray, sql } from "drizzle-orm";
import type { IssueUnblockDescriptor } from "@tickernelz/wardmote-shared";
import { activityLog, heartbeatRuns, issues, type Db } from "@tickernelz/wardmote-db";
import { logActivity, publishActivity, type ActivityPublication } from "../activity-log.js";
import { executeIssuePostCommitActions, type IssuePostCommitAction, type issueService } from "../issues.js";
import { deliverAgentUnblockNotification } from "../routable-blocked.js";
import { readHeartbeatRunErrorFamily } from "./retries.js";

export const PROVIDER_REQUEST_REJECTED_FAMILY = "provider_request_rejected";
export const PROMPT_TOO_LONG_FAMILY = "prompt_too_long";

const PROVIDER_REQUEST_REJECTED_SOURCE = "heartbeat.provider_request_rejected";
const PROMPT_TOO_LONG_SOURCE = "heartbeat.prompt_too_long";
const PROMPT_TOO_LONG_RESUME_SOURCE = "startup.prompt_too_long_resume";
const PROMPT_TOO_LONG_TEXT = "prompt is too long";
const PROMPT_TOO_LONG_TOKENS_RE = /(\d+)\s*tokens\s*>\s*(\d+)\s*maximum/i;

const MAX_ERROR_CHARS = 500;
const BLOCKABLE_STATUSES = ["todo", "in_progress"] as const;

type RejectedRun = Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "agentId" | "errorCode" | "error" | "resultJson">;

type UnblockWakeupOptions = Parameters<Parameters<typeof deliverAgentUnblockNotification>[0]["wakeup"]>[1];

type PromptTooLongResumeWakeupOptions = {
  source: "automation";
  triggerDetail: "system";
  reason: "issue_status_changed";
  idempotencyKey: string;
  payload: { issueId: string; mutation: "prompt_too_long_resume"; rejectedRunId: string };
  contextSnapshot: { wakeReason: "issue_status_changed"; issueId: string; taskId: string; source: typeof PROMPT_TOO_LONG_RESUME_SOURCE };
};

type WakeupOptions = UnblockWakeupOptions | PromptTooLongResumeWakeupOptions;

export interface ProviderRequestRejectionDependencies {
  db: Db;
  issuesSvc: Pick<ReturnType<typeof issueService>, "update" | "addComment">;
  getAgent: (agentId: string) => Promise<{ id: string; companyId: string; reportsTo: string | null } | null>;
  wakeup: (agentId: string, options: WakeupOptions) => Promise<unknown>;
}

async function resolveUnblockOwner(
  deps: ProviderRequestRejectionDependencies,
  run: RejectedRun,
): Promise<IssueUnblockDescriptor["owner"]> {
  const agent = await deps.getAgent(run.agentId);
  const managerId = agent?.companyId === run.companyId ? agent.reportsTo : null;
  if (!managerId) return "board";
  const manager = await deps.getAgent(managerId);
  return manager?.companyId === run.companyId ? { agentId: manager.id } : "board";
}

function unblockAction(run: RejectedRun, family: string): string {
  const error = (run.error ?? run.errorCode ?? "invalid request").trim().slice(0, MAX_ERROR_CHARS);
  if (family === PROMPT_TOO_LONG_FAMILY) {
    const tokens = PROMPT_TOO_LONG_TOKENS_RE.exec(error);
    const size = tokens ? `${tokens[1]} tokens against a ${tokens[2]}-token maximum` : error;
    return (
      `The prompt of run ${run.id} is still too long for the model (${size}) after Wardmote retried with the comment history cut down to its smallest window. ` +
      "The rest of the prompt (agent instructions, skills, issue description, connector context) is too large for this model: shrink it or assign a model with a larger context window, then move this issue back to in_progress."
    );
  }
  return (
    `The model provider rejected run ${run.id} as an invalid request, also after one retry on a fresh session: ${error}. ` +
    "Fix the model or provider configuration of the assignee, then move this issue back to in_progress."
  );
}

export async function blockIssueAfterProviderRequestRejection(
  deps: ProviderRequestRejectionDependencies,
  run: RejectedRun,
  issueId: string | null,
) {
  const family = readHeartbeatRunErrorFamily(run);
  if (!issueId || (family !== PROVIDER_REQUEST_REJECTED_FAMILY && family !== PROMPT_TOO_LONG_FAMILY)) return null;
  const promptTooLong = family === PROMPT_TOO_LONG_FAMILY;
  const unblockDescriptor: IssueUnblockDescriptor = {
    owner: await resolveUnblockOwner(deps, run),
    action: unblockAction(run, family),
  };
  const publications: ActivityPublication[] = [];
  const postCommitActions: IssuePostCommitAction[] = [];
  const blocked = await deps.db.transaction(async (tx) => {
    const current = await tx
      .select()
      .from(issues)
      .where(and(
        eq(issues.companyId, run.companyId),
        eq(issues.id, issueId),
        inArray(issues.status, [...BLOCKABLE_STATUSES]),
        eq(issues.assigneeAgentId, run.agentId),
      ))
      .for("update")
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!current || (current.executionRunId !== null && current.executionRunId !== run.id)) return null;
    const updated = await deps.issuesSvc.update(
      current.id,
      { status: "blocked", unblockDescriptor },
      tx,
      publications,
      postCommitActions,
    );
    if (!updated) return null;
    await deps.issuesSvc.addComment(
      current.id,
      `Wardmote moved this issue to \`blocked\`. ${unblockDescriptor.action}`,
      {},
      {
        authorType: "system",
        presentation: {
          kind: "system_notice",
          tone: "danger",
          title: promptTooLong ? "Prompt too long for the model" : "Provider rejected the request",
          detailsDefaultOpen: false,
          density: "compact",
        },
      },
      tx,
    );
    await logActivity(
      tx as unknown as Db,
      {
        companyId: current.companyId,
        actorType: "system",
        actorId: "heartbeat",
        action: "issue.updated",
        entityType: "issue",
        entityId: current.id,
        issueId: current.id,
        runId: run.id,
        details: {
          source: promptTooLong ? PROMPT_TOO_LONG_SOURCE : PROVIDER_REQUEST_REJECTED_SOURCE,
          status: "blocked",
          previousStatus: current.status,
          runId: run.id,
          unblockOwner: unblockDescriptor.owner,
        },
      },
      publications,
    );
    return updated;
  });
  if (!blocked) return null;
  for (const publication of publications) publishActivity(publication);
  await executeIssuePostCommitActions(deps.db, postCommitActions);
  await deliverAgentUnblockNotification({
    issue: blocked,
    wakeup: deps.wakeup,
    markNotified: (notifiedAt) =>
      deps.db.update(issues).set({ blockedOwnerNotifiedAt: notifiedAt }).where(eq(issues.id, blocked.id)),
  });
  return blocked;
}

/** Moves issues blocked by a prompt-too-long rejection that predates history windowing back to work, once per rejected run. */
export async function resumeIssuesBlockedByPromptTooLong(deps: ProviderRequestRejectionDependencies) {
  const candidates = await deps.db
    .select({ issueId: issues.id, runId: heartbeatRuns.id })
    .from(issues)
    .innerJoin(
      heartbeatRuns,
      sql`${heartbeatRuns.id}::text = substring(${issues.unblockDescriptor} ->> 'action' from '^The model provider rejected run ([0-9a-f-]{36}) ')`,
    )
    .where(and(
      eq(issues.status, "blocked"),
      sql`${issues.unblockDescriptor} ->> 'action' like 'The model provider rejected run %'`,
      sql`${heartbeatRuns.error} ilike ${`%${PROMPT_TOO_LONG_TEXT}%`}`,
    ));
  let resumed = 0;
  for (const candidate of candidates) {
    const blockedFrom = await deps.db
      .select({ previousStatus: sql<string | null>`${activityLog.details} ->> 'previousStatus'` })
      .from(activityLog)
      .where(and(
        eq(activityLog.entityType, "issue"),
        eq(activityLog.entityId, candidate.issueId),
        sql`${activityLog.details} ->> 'source' = ${PROVIDER_REQUEST_REJECTED_SOURCE}`,
        sql`${activityLog.details} ->> 'runId' = ${candidate.runId}`,
      ))
      .limit(1)
      .then((rows) => rows[0]?.previousStatus ?? null);
    const status = blockedFrom === "todo" ? "todo" : "in_progress";
    const publications: ActivityPublication[] = [];
    const postCommitActions: IssuePostCommitAction[] = [];
    const updated = await deps.db.transaction(async (tx) => {
      const current = await tx
        .select()
        .from(issues)
        .where(and(eq(issues.id, candidate.issueId), eq(issues.status, "blocked")))
        .for("update")
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!current?.assigneeAgentId) return null;
      const alreadyResumed = await tx
        .select({ id: activityLog.id })
        .from(activityLog)
        .where(and(
          eq(activityLog.entityType, "issue"),
          eq(activityLog.entityId, current.id),
          sql`${activityLog.details} ->> 'source' = ${PROMPT_TOO_LONG_RESUME_SOURCE}`,
          sql`${activityLog.details} ->> 'rejectedRunId' = ${candidate.runId}`,
        ))
        .limit(1)
        .then((rows) => rows.length > 0);
      if (alreadyResumed) return null;
      const next = await deps.issuesSvc.update(
        current.id,
        { status, unblockDescriptor: null },
        tx,
        publications,
        postCommitActions,
      );
      if (!next) return null;
      await deps.issuesSvc.addComment(
        current.id,
        `Wardmote moved this issue back to \`${status}\`. Run ${candidate.runId} was rejected because its prompt was too long for the model; this version fits the comment history into the model's context window and retries with a smaller window when the provider still refuses, so the assignee starts again on a fresh session.`,
        {},
        {
          authorType: "system",
          presentation: {
            kind: "system_notice",
            tone: "info",
            title: "Resumed after a prompt-too-long rejection",
            detailsDefaultOpen: false,
            density: "compact",
          },
        },
        tx,
      );
      await logActivity(
        tx as unknown as Db,
        {
          companyId: current.companyId,
          actorType: "system",
          actorId: "heartbeat",
          action: "issue.updated",
          entityType: "issue",
          entityId: current.id,
          issueId: current.id,
          details: {
            source: PROMPT_TOO_LONG_RESUME_SOURCE,
            status,
            previousStatus: current.status,
            rejectedRunId: candidate.runId,
          },
        },
        publications,
      );
      return next;
    });
    if (!updated?.assigneeAgentId) continue;
    for (const publication of publications) publishActivity(publication);
    await executeIssuePostCommitActions(deps.db, postCommitActions);
    await deps.wakeup(updated.assigneeAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_status_changed",
      idempotencyKey: `prompt-too-long-resume:${updated.id}:${candidate.runId}`,
      payload: { issueId: updated.id, mutation: "prompt_too_long_resume", rejectedRunId: candidate.runId },
      contextSnapshot: {
        wakeReason: "issue_status_changed",
        issueId: updated.id,
        taskId: updated.id,
        source: PROMPT_TOO_LONG_RESUME_SOURCE,
      },
    });
    resumed += 1;
  }
  return { resumed };
}
