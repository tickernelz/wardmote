import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { agents, chatActions, chatEndpoints, issues, type Db } from "@tickernelz/wardmote-db";
import { OPENWA_AUTONOMOUS_SYSTEM_ACTOR_ID, openwaEndpointPolicySchema } from "@tickernelz/wardmote-shared";
import { logger } from "../../middleware/logger.js";
import { redactSensitiveText } from "../../redaction.js";
import { publicChatTaskUrl } from "../chat-task-url.js";
import { dueChatAction } from "../chat-action-work.js";
import { notifyChatActionWork } from "../chat-work-notifications.js";
import { recordOpenwaAudit } from "./audit.js";
import { formatOpenwaPublication } from "./format.js";
import { openwaChatKey, sendThroughRegistry } from "./outbound.js";
import { openwaOwnerFacingChat } from "./owner-group.js";
import { openwaCurrentOwners } from "./owners.js";
import { openwaToolRuntimeFor } from "./tools.js";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTransaction = Db | DbTransaction;

export const OPENWA_AUTONOMOUS_DIGEST_ACTION_KIND = "openwa_autonomous_digest";
export const OPENWA_AUTONOMOUS_DIGEST_INTERVAL_MS = 30 * 60_000;
export const OPENWA_AUTONOMOUS_DESTRUCTIVE_DELAY_MS = 5 * 60_000;
export const OPENWA_AUTONOMOUS_APPROVAL_NOTE =
  "Autonomous mode is on for this endpoint: approved at once without asking an owner; the owners read it in their next digest.";
const DIGEST_MAX_EVENTS = 30;
const DIGEST_SUMMARY_MAX = 280;
const DIGEST_MAX_ATTEMPTS = 5;
const DIGEST_RETRY_MS = 60_000;
const ANCESTRY_MAX_DEPTH = 32;

export interface OpenwaAutonomousCoverage {
  endpointId: string;
  endpointName: string | null;
  conversationId: string;
  chatKey: string;
}

export interface OpenwaAutonomousAction {
  companyId: string;
  endpointId: string;
  chatKey: string;
  conversationId: string | null;
  runId: string | null;
  agentId: string | null;
  source: "approval_request" | "card";
  destructive: boolean;
  summary: string;
  requesterRole: "owner" | "non_owner" | null;
  requesterName: string | null;
  issueId: string | null;
  refs: Record<string, string>;
}

interface DigestEvent {
  at: string;
  source: OpenwaAutonomousAction["source"];
  destructive: boolean;
  summary: string;
  agentId: string | null;
  requesterRole: OpenwaAutonomousAction["requesterRole"];
  requesterName: string | null;
  issueId: string | null;
  chatKey: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function clip(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? single.slice(0, max - 1).trimEnd() + "…" : single;
}

function rows(result: unknown): Record<string, unknown>[] {
  const list = Array.isArray(result) ? result : Array.isArray(record(result).rows) ? (record(result).rows as unknown[]) : [];
  return list.map(record);
}

/** The nearest OpenWA conversation in autonomous mode whose issue is the given issue or one of its ancestors. */
export async function openwaAutonomousCoverage(db: DbOrTransaction, companyId: string, issueId: string): Promise<OpenwaAutonomousCoverage | null> {
  const result = await db.execute(sql`
    WITH RECURSIVE ancestors(id, parent_id, depth) AS (
      SELECT id, parent_id, 0 FROM issues WHERE company_id = ${companyId} AND id = ${issueId}
      UNION ALL
      SELECT parent.id, parent.parent_id, ancestors.depth + 1
      FROM issues parent JOIN ancestors ON parent.id = ancestors.parent_id
      WHERE parent.company_id = ${companyId} AND ancestors.depth < ${ANCESTRY_MAX_DEPTH}
    )
    SELECT e.id AS endpoint_id, coalesce(e.provider_account_label, e.bot_display_name) AS endpoint_name,
      c.id AS conversation_id, c.external_conversation_id AS chat_id
    FROM ancestors a
    JOIN chat_conversations c ON c.company_id = ${companyId} AND c.issue_id = a.id
    JOIN chat_endpoints e ON e.company_id = c.company_id AND e.id = c.endpoint_id
    WHERE e.provider = 'openwa' AND e.status <> 'archived' AND (e.policy -> 'approvals' ->> 'autonomous') = 'true'
    ORDER BY a.depth ASC, c.created_at DESC
    LIMIT 1
  `);
  const row = rows(result)[0];
  if (!row) return null;
  return {
    endpointId: String(row.endpoint_id),
    endpointName: typeof row.endpoint_name === "string" ? row.endpoint_name : null,
    conversationId: String(row.conversation_id),
    chatKey: openwaChatKey(String(row.chat_id)),
  };
}

/** Issue ids of every task tree rooted at one of the endpoint's conversation issues. */
export async function openwaAutonomousTreeIssueIds(db: DbOrTransaction, companyId: string, endpointId: string): Promise<string[]> {
  const result = await db.execute(sql`
    WITH RECURSIVE tree(id, depth) AS (
      SELECT c.issue_id, 0 FROM chat_conversations c
      WHERE c.company_id = ${companyId} AND c.endpoint_id = ${endpointId} AND c.issue_id IS NOT NULL
      UNION
      SELECT child.id, tree.depth + 1 FROM issues child JOIN tree ON child.parent_id = tree.id
      WHERE child.company_id = ${companyId} AND tree.depth < ${ANCESTRY_MAX_DEPTH}
    )
    SELECT DISTINCT id FROM tree
  `);
  return rows(result).map((row) => String(row.id));
}

/** Writes the one audit row for an action taken in autonomous mode and adds it to the endpoint's next owner digest. */
export async function recordOpenwaAutonomousAction(tx: DbTransaction, action: OpenwaAutonomousAction, now = new Date()): Promise<void> {
  const summary = clip(redactSensitiveText(action.summary), DIGEST_SUMMARY_MAX);
  await recordOpenwaAudit(tx, {
    companyId: action.companyId,
    endpointId: action.endpointId,
    kind: "autonomous_action",
    actorKind: action.agentId ? "agent" : "system",
    actorRef: action.agentId ?? OPENWA_AUTONOMOUS_SYSTEM_ACTOR_ID,
    chatKey: action.chatKey,
    conversationId: action.conversationId,
    runId: action.runId,
    metadata: { source: action.source, destructive: action.destructive, requesterRole: action.requesterRole, issueId: action.issueId, ...action.refs },
    content: { summary },
  });
  const event: DigestEvent = {
    at: now.toISOString(),
    source: action.source,
    destructive: action.destructive,
    summary,
    agentId: action.agentId,
    requesterRole: action.requesterRole,
    requesterName: action.requesterName ? clip(action.requesterName, 80) : null,
    issueId: action.issueId,
    chatKey: action.chatKey,
  };
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"openwa-autonomous-digest:" + action.endpointId}, 0))`);
  const [open] = await tx
    .select()
    .from(chatActions)
    .where(
      and(
        eq(chatActions.companyId, action.companyId),
        eq(chatActions.endpointId, action.endpointId),
        eq(chatActions.kind, OPENWA_AUTONOMOUS_DIGEST_ACTION_KIND),
        eq(chatActions.status, "received"),
      ),
    )
    .limit(1);
  const soon = now.getTime() + OPENWA_AUTONOMOUS_DESTRUCTIVE_DELAY_MS;
  if (open) {
    const payload = record(open.payload);
    const events = Array.isArray(payload.events) ? (payload.events as DigestEvent[]) : [];
    const kept = events.length < DIGEST_MAX_EVENTS ? [...events, event] : events;
    const omitted = Number(payload.omitted ?? 0) + (kept === events ? 1 : 0);
    const due = Date.parse(String(record(open.result).retryAt));
    const nextDue = action.destructive && !(due <= soon) ? new Date(soon).toISOString() : String(record(open.result).retryAt);
    await tx
      .update(chatActions)
      .set({ payload: { ...payload, events: kept, omitted }, result: { ...record(open.result), retryAt: nextDue }, updatedAt: now })
      .where(eq(chatActions.id, open.id));
  } else {
    const dueAt = action.destructive ? soon : now.getTime() + OPENWA_AUTONOMOUS_DIGEST_INTERVAL_MS;
    await tx.insert(chatActions).values({
      companyId: action.companyId,
      endpointId: action.endpointId,
      kind: OPENWA_AUTONOMOUS_DIGEST_ACTION_KIND,
      providerActionId: "openwa-autonomous-digest:" + now.toISOString() + ":" + randomUUID(),
      status: "received",
      payload: { version: 1, since: now.toISOString(), events: [event], omitted: 0 },
      result: { retryAt: new Date(dueAt).toISOString() },
    });
  }
  await notifyChatActionWork(tx, OPENWA_AUTONOMOUS_DIGEST_ACTION_KIND);
}

function digestLine(event: DigestEvent, index: number, agentNames: Map<string, string>, issueRefs: Map<string, string>): string {
  const agent = event.agentId ? (agentNames.get(event.agentId) ?? "an agent") : "Wardmote";
  const requester = event.requesterRole ? event.requesterRole + (event.requesterName ? " " + event.requesterName : "") : "-";
  const reference = event.issueId ? (issueRefs.get(event.issueId) ?? event.issueId) : null;
  const link = reference ? " — task " + reference + " (" + (publicChatTaskUrl(reference) ?? "/issues/" + reference) + ")" : "";
  const kind = event.source === "card" ? "card accepted" : "action";
  return index + 1 + ". " + (event.destructive ? "*DESTRUCTIVE* " : "") + kind + ": " + event.summary + " — by " + agent + ", asked by " + requester + link;
}

export function renderOpenwaAutonomousDigest(input: {
  endpointName: string | null;
  since: string;
  events: DigestEvent[];
  omitted: number;
  agentNames: Map<string, string>;
  issueRefs: Map<string, string>;
}): string {
  const destructive = input.events.filter((event) => event.destructive).length;
  const total = input.events.length + input.omitted;
  return [
    "*Autonomous mode digest*" + (input.endpointName ? " (" + input.endpointName + ")" : ""),
    total + " action" + (total === 1 ? "" : "s") + " done without asking an owner since " + input.since.slice(0, 16).replace("T", " ") + " UTC" + (destructive ? ", " + destructive + " marked destructive" : "") + ":",
    ...input.events.map((event, index) => digestLine(event, index, input.agentNames, input.issueRefs)),
    ...(input.omitted ? ["…and " + input.omitted + " more in the OpenWA audit log."] : []),
  ].join("\n");
}

async function destinations(db: Db, endpoint: typeof chatEndpoints.$inferSelect, events: DigestEvent[]): Promise<Map<string, DigestEvent[]>> {
  const byChat = new Map<string, DigestEvent[]>();
  const ownerDms = (await openwaCurrentOwners(db, endpoint)).flatMap((owner) => (owner.digits ? [owner.digits + "@c.us"] : []));
  for (const chatKey of [...new Set(events.map((event) => event.chatKey))]) {
    const route = await openwaOwnerFacingChat(db, endpoint, chatKey, { source: "autonomous_digest" });
    for (const chatId of route ? [route.chatId] : [...new Set(ownerDms)]) {
      const list = byChat.get(chatId) ?? [];
      list.push(...events.filter((event) => event.chatKey === chatKey));
      byChat.set(chatId, list);
    }
  }
  return byChat;
}

/** Sends one staged digest to the owners' report chat (or their direct chats) and records it. */
export async function dispatchOpenwaAutonomousDigest(db: Db, actionId: string): Promise<boolean> {
  const now = new Date();
  const [claimed] = await db
    .update(chatActions)
    .set({ status: "processing", updatedAt: now })
    .where(and(eq(chatActions.id, actionId), dueChatAction(OPENWA_AUTONOMOUS_DIGEST_ACTION_KIND, now.getTime())))
    .returning();
  if (!claimed) return false;
  const attemptCount = Number(record(claimed.result).attemptCount ?? 0) + 1;
  const settle = (status: "processed" | "failed", result: Record<string, unknown>) =>
    db
      .update(chatActions)
      .set({ status, result: { ...result, attemptCount }, updatedAt: new Date() })
      .where(and(eq(chatActions.id, claimed.id), eq(chatActions.status, "processing")));
  try {
    const payload = record(claimed.payload);
    const events = Array.isArray(payload.events) ? (payload.events as DigestEvent[]) : [];
    const [endpoint] = await db.select().from(chatEndpoints).where(and(eq(chatEndpoints.companyId, claimed.companyId), eq(chatEndpoints.id, claimed.endpointId))).limit(1);
    if (!endpoint || !events.length) {
      await settle("processed", { code: "openwa_autonomous_digest_empty" });
      return false;
    }
    const runtime = await openwaToolRuntimeFor(db, endpoint);
    if (!runtime) throw new Error("The OpenWA runtime is not available in this process");
    const agentIds = [...new Set(events.flatMap((event) => (event.agentId ? [event.agentId] : [])))];
    const issueIds = [...new Set(events.flatMap((event) => (event.issueId ? [event.issueId] : [])))];
    const [agentRows, issueRows] = await Promise.all([
      agentIds.length ? db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds)) : [],
      issueIds.length
        ? db.select({ id: issues.id, identifier: issues.identifier }).from(issues).where(and(eq(issues.companyId, claimed.companyId), inArray(issues.id, issueIds)))
        : [],
    ]);
    const agentNames = new Map(agentRows.map((row) => [row.id, row.name]));
    const issueRefs = new Map(issueRows.map((row) => [row.id, row.identifier ?? row.id]));
    const policy = openwaEndpointPolicySchema.parse(endpoint.policy ?? {});
    const prefix = policy.numberMode === "owner_number" && policy.ownerNumberPrefix.enabled ? policy.ownerNumberPrefix.text : null;
    const sent: Array<{ chatKey: string; messageIds: string[] }> = [];
    for (const [chatId, list] of await destinations(db, endpoint, events)) {
      const markdown = renderOpenwaAutonomousDigest({
        endpointName: endpoint.providerAccountLabel ?? endpoint.botDisplayName ?? null,
        since: String(payload.since ?? claimed.createdAt.toISOString()),
        events: list,
        omitted: Number(payload.omitted ?? 0),
        agentNames,
        issueRefs,
      });
      const formatted = formatOpenwaPublication({ markdown, prefix });
      const parts = formatted.kind === "text" ? formatted.parts : [formatted.caption];
      const messageIds: string[] = [];
      for (const part of parts) {
        const result = await sendThroughRegistry({
          registry: runtime.registry,
          companyId: endpoint.companyId,
          endpointId: endpoint.id,
          chatId,
          source: "approval",
          body: part,
          send: () => runtime.gateway.sendText({ chatId, text: part }),
        });
        messageIds.push(result.result.messageId);
      }
      sent.push({ chatKey: openwaChatKey(chatId), messageIds });
    }
    await recordOpenwaAudit(db, {
      companyId: endpoint.companyId,
      endpointId: endpoint.id,
      kind: "autonomous_digest",
      actorKind: "system",
      actorRef: OPENWA_AUTONOMOUS_SYSTEM_ACTOR_ID,
      metadata: {
        actionId: claimed.id,
        events: events.length + Number(payload.omitted ?? 0),
        destructive: events.filter((event) => event.destructive).length,
        destinations: sent.map((entry) => entry.chatKey),
      },
    });
    await settle("processed", { code: "openwa_autonomous_digest_sent", sentAt: new Date().toISOString(), sent });
    return true;
  } catch (error) {
    logger.warn({ err: error, actionId: claimed.id }, "failed to send OpenWA autonomous digest");
    await settle("failed", {
      code: "openwa_autonomous_digest_failed",
      error: error instanceof Error ? error.message : String(error),
      retryable: attemptCount < DIGEST_MAX_ATTEMPTS,
      retryAt: new Date(Date.now() + DIGEST_RETRY_MS * attemptCount).toISOString(),
    });
    return false;
  }
}

export async function processPendingOpenwaAutonomousDigests(db: Db, limit = 25): Promise<number> {
  const due = await db
    .select({ id: chatActions.id })
    .from(chatActions)
    .where(dueChatAction(OPENWA_AUTONOMOUS_DIGEST_ACTION_KIND))
    .orderBy(chatActions.createdAt)
    .limit(limit);
  let sent = 0;
  for (const row of due) if (await dispatchOpenwaAutonomousDigest(db, row.id)) sent++;
  return sent;
}

