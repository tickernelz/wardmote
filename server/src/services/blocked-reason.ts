import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@tickernelz/wardmote-db";
import { decisions } from "@tickernelz/wardmote-db";
import { logActivity } from "./activity-log.js";

export const BLOCKED_REASON_DECISION_KIND = "blocked_reason";

/** Closes an obsolete blocked-reason card without waking its origin agent. */
export async function cancelOpenBlockedReasonDecision(
  db: Db,
  input: { companyId: string; decisionId: string; cancelledReason: "issue_left_blocked" | "blocked_reason_replaced" },
) {
  const [cancelled] = await db
    .update(decisions)
    .set({
      status: "cancelled",
      updatedAt: new Date(),
      metadata: sql`coalesce(${decisions.metadata}, '{}'::jsonb) || jsonb_build_object('cancelledReason', ${input.cancelledReason}::text)`,
    })
    .where(and(eq(decisions.id, input.decisionId), eq(decisions.companyId, input.companyId), eq(decisions.status, "open")))
    .returning({ id: decisions.id, originAgentId: decisions.originAgentId, originRunId: decisions.originRunId });
  if (!cancelled) return false;
  await logActivity(db, {
    companyId: input.companyId,
    actorType: "system",
    actorId: "blocked-reason",
    agentId: cancelled.originAgentId,
    runId: cancelled.originRunId,
    action: "decision.cancelled",
    entityType: "decision",
    entityId: cancelled.id,
    details: { cancelledReason: input.cancelledReason },
  });
  return true;
}
