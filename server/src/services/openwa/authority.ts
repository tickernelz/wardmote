import { and, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  chatActions,
  chatConversations,
  chatEndpoints,
  chatOwnerApprovalRequests,
  chatOwnerGrants,
  heartbeatRuns,
  issueAutonomyWindows,
  type Db,
} from "@tickernelz/wardmote-db";
import {
  OPENWA_TRIGGER_CLASSES,
  type OpenwaApprovalCategory,
  type OpenwaTriggerClass,
} from "@tickernelz/wardmote-shared";
import { RUN_TOOL_PROFILE_CONTEXT_KEY } from "@tickernelz/wardmote-adapter-utils";
import { forbidden } from "../../errors.js";
import { openwaCurrentOwners, openwaPrincipalAuthorization } from "./owners.js";
import { recordOpenwaAudit } from "./audit.js";
import { logger } from "../../middleware/logger.js";
import { openwaOwnerOnlyGroup } from "./owner-group.js";
import { isOpenwaCompletionTurn, openwaCompletionOwedToOwner } from "../chat-completion-delivery.js";

export const OPENWA_RUN_CONTEXT_KEY = "wardmoteOpenwa";
export const OPENWA_AGENT_KEY_READ_ONLY_CODE = "openwa_agent_key_read_only";

/** Whether the run acts on an owner's word (owner message, owner-origin record, board user) or on anyone else's. */
export type OpenwaSenderClass = "owner" | "non_owner";

export interface OpenwaRunContext {
  endpointId: string;
  chatKey: string;
  triggerClass: OpenwaTriggerClass;
  senderClass: OpenwaSenderClass;
  event: string | null;
  grantIds: string[];
  deliveryIds: string[];
  requesterPrincipalId: string | null;
  approvalRequestId: string | null;
  triggerPrincipalId: string | null;
  ownerOrigin?: OpenwaOwnerOrigin;
  ownerGroup?: true;
}

/** Server record that makes a wake without a chat message act for an owner: the owner's own DM, a group holding only owners and this number, or a task an owner run handed off. */
export type OpenwaOwnerOrigin = "owner_chat" | "owner_task" | "owner_group";
const OWNER_ORIGINS: ReadonlySet<string> = new Set<OpenwaOwnerOrigin>(["owner_chat", "owner_task", "owner_group"]);

type RunLike = { id: string; companyId: string; contextSnapshot: unknown };

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const BINDING_CACHE_LIMIT = 10_000;
const BINDING_CACHE_TTL_MS = 5 * 60_000;
const AGENT_KEY_CACHE_LIMIT = 2_000;
const AGENT_KEY_CACHE_TTL_MS = 30_000;
const EVENT_PATTERN = /^[a-z_]{1,40}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type BoundCache = { entries: Map<string, { bound: boolean; at: number }>; epoch: number };
const bindingCache: BoundCache = { entries: new Map(), epoch: 0 };
const agentKeyCache: BoundCache = { entries: new Map(), epoch: 0 };

export function openwaRunAuthoritySnapshot() {
  return sql<Record<string, unknown> | null>`jsonb_build_object(
  'wardmoteOpenwa', ${heartbeatRuns.contextSnapshot} -> 'wardmoteOpenwa',
  'wardmoteToolProfile', ${heartbeatRuns.contextSnapshot} -> 'wardmoteToolProfile',
  'issueId', ${heartbeatRuns.contextSnapshot} -> 'issueId',
  'taskId', ${heartbeatRuns.contextSnapshot} -> 'taskId')`;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function uuid(value: unknown): string | null {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : null;
}

function triggerClass(value: unknown): OpenwaTriggerClass | null {
  return OPENWA_TRIGGER_CLASSES.includes(value as OpenwaTriggerClass)
    ? (value as OpenwaTriggerClass)
    : null;
}

function senderClass(value: unknown): OpenwaSenderClass | null {
  return value === "owner" || value === "non_owner" ? value : null;
}

function uuids(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string" && UUID_PATTERN.test(entry)))];
}

function cacheGet(cache: BoundCache, key: string, ttl: number) {
  const entry = cache.entries.get(key);
  return entry && Date.now() - entry.at < ttl ? entry.bound : null;
}

function cacheSet(cache: BoundCache, key: string, bound: boolean, limit: number, epoch: number) {
  if (epoch !== cache.epoch) return;
  cache.entries.delete(key);
  cache.entries.set(key, { bound, at: Date.now() });
  if (cache.entries.size > limit) cache.entries.delete(cache.entries.keys().next().value!);
}

function cacheInvalidate(cache: BoundCache, key: string) {
  cache.epoch += 1;
  cache.entries.delete(key);
}

/** Forgets the cached OpenWA binding of an issue; call after committing a conversation that binds it. */
export function invalidateOpenwaIssueBinding(companyId: string, issueId: string) {
  cacheInvalidate(bindingCache, `${companyId}:${issueId}`);
}

/** Forgets the cached agent-key answer of an agent; call after committing an OpenWA endpoint assigned to it. */
export function invalidateOpenwaAgentKey(companyId: string, agentId: string) {
  cacheInvalidate(agentKeyCache, `${companyId}:${agentId}`);
}

function normalizeChatKey(value: string): string {
  const chatId = value.trim().toLowerCase();
  return chatId.endsWith("@s.whatsapp.net") ? chatId.slice(0, -"@s.whatsapp.net".length) + "@c.us" : chatId;
}

function chatKeyFromConversation(externalConversationId: string): string {
  const match = /^openwa:[^:]+:(.+)$/.exec(externalConversationId);
  return normalizeChatKey(match?.[1] ?? externalConversationId);
}

/** Reads the normalized OpenWA run context written at run start, or null for other runs. */
export function readOpenwaRunContext(contextSnapshot: unknown): OpenwaRunContext | null {
  const raw = record(record(contextSnapshot)[OPENWA_RUN_CONTEXT_KEY]);
  const endpointId = text(raw.endpointId);
  const chatKey = text(raw.chatKey);
  const cls = triggerClass(raw.triggerClass);
  const sender = senderClass(raw.senderClass) ?? (raw.profile === "full" ? "owner" : raw.profile === "read_only" ? "non_owner" : null);
  if (!endpointId || !chatKey || !cls || !sender) return null;
  const event = text(raw.event);
  return {
    endpointId,
    chatKey,
    triggerClass: cls,
    senderClass: sender,
    event: event && EVENT_PATTERN.test(event) ? event : null,
    grantIds: uuids(raw.grantIds),
    deliveryIds: uuids(raw.deliveryIds),
    requesterPrincipalId: text(raw.requesterPrincipalId),
    approvalRequestId: text(raw.approvalRequestId),
    triggerPrincipalId: text(raw.triggerPrincipalId),
    ...(OWNER_ORIGINS.has(String(raw.ownerOrigin)) ? { ownerOrigin: raw.ownerOrigin as OpenwaOwnerOrigin } : {}),
    ...(raw.ownerGroup === true ? { ownerGroup: true as const } : {}),
  };
}

async function openwaConversationBinding(db: Pick<Db, "select">, companyId: string, issueId: string) {
  const [row] = await db
    .select({
      endpointId: chatConversations.endpointId,
      conversationId: chatConversations.id,
      externalConversationId: chatConversations.externalConversationId,
      isDirectMessage: chatConversations.isDirectMessage,
      companyId: chatEndpoints.companyId,
      id: chatEndpoints.id,
      policy: chatEndpoints.policy,
      status: chatEndpoints.status,
    })
    .from(chatConversations)
    .innerJoin(chatEndpoints, and(
      eq(chatEndpoints.companyId, chatConversations.companyId),
      eq(chatEndpoints.id, chatConversations.endpointId),
    ))
    .where(and(
      eq(chatConversations.companyId, companyId),
      eq(chatConversations.issueId, issueId),
      eq(chatEndpoints.provider, "openwa"),
    ))
    .limit(1);
  return row ?? null;
}

/** True when the issue is bound by a chat conversation to an OpenWA endpoint of the same company. */
export async function isOpenwaConversationIssue(db: Pick<Db, "select">, companyId: string, issueId: string): Promise<boolean> {
  const key = `${companyId}:${issueId}`;
  const cached = cacheGet(bindingCache, key, BINDING_CACHE_TTL_MS);
  if (cached !== null) return cached;
  const epoch = bindingCache.epoch;
  const bound = (await openwaConversationBinding(db, companyId, issueId)) !== null;
  cacheSet(bindingCache, key, bound, BINDING_CACHE_LIMIT, epoch);
  return bound;
}

export interface OpenwaWakeAction {
  event: string | null;
  deliveryIds: string[];
  approvalRequestId: string | null;
}

/** payload.openwa of the chat action whose id is the wake request id, on the issue's endpoint and conversation. */
export async function loadOpenwaWakeAction(
  db: Db,
  input: { companyId: string; endpointId: string; conversationId: string; wakeupRequestId: string | null },
): Promise<OpenwaWakeAction | null> {
  if (!input.wakeupRequestId) return null;
  const [row] = await db
    .select({ openwa: sql<unknown>`${chatActions.payload} -> 'openwa'` })
    .from(chatActions)
    .where(and(
      eq(chatActions.id, input.wakeupRequestId),
      eq(chatActions.companyId, input.companyId),
      eq(chatActions.endpointId, input.endpointId),
      eq(chatActions.conversationId, input.conversationId),
    ))
    .limit(1);
  if (!row || !row.openwa || typeof row.openwa !== "object" || Array.isArray(row.openwa)) return null;
  const raw = row.openwa as Record<string, unknown>;
  const event = text(raw.event);
  return {
    event: event && EVENT_PATTERN.test(event) ? event : null,
    deliveryIds: uuids(raw.deliveryIds),
    approvalRequestId: uuid(raw.approvalRequestId),
  };
}

export interface OpenwaWakeClassFact {
  triggerClass: OpenwaTriggerClass;
  event: string | null;
  principalId: string | null;
  requesterGrants: boolean;
}

function wakeClassFromAction(
  action: { openwa: unknown; principalId: string | null } | undefined,
  grantHolders: ReadonlySet<string>,
): OpenwaWakeClassFact | null {
  const raw = record(action?.openwa);
  const cls = triggerClass(raw.triggerClass);
  if (!cls) return null;
  const event = text(raw.event);
  const principalId = action?.principalId ?? null;
  return {
    triggerClass: cls,
    event: event && EVENT_PATTERN.test(event) ? event : null,
    principalId,
    requesterGrants: cls !== "owner" && principalId !== null && grantHolders.has(principalId),
  };
}

export function openwaRunCarriesGrants(run: Pick<OpenwaRunContext, "grantIds">): boolean {
  return run.grantIds.length > 0;
}

/** Wake classes for admission on an OpenWA conversation issue, from server-written chat actions and the run's resolved context; undefined off OpenWA issues. */
export async function openwaAdmissionClasses(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    incomingWakeupRequestId: string | null;
    activeRun: { contextSnapshot: unknown; wakeupRequestId?: string | null };
  },
): Promise<{ incoming: OpenwaWakeClassFact | null; target: OpenwaWakeClassFact | null } | undefined> {
  if (!(await isOpenwaConversationIssue(db, input.companyId, input.issueId))) return undefined;
  const resolved = readOpenwaRunContext(input.activeRun.contextSnapshot);
  const targetActionId = resolved ? null : uuid(input.activeRun.wakeupRequestId);
  const incomingActionId = uuid(input.incomingWakeupRequestId);
  const ids = [...new Set([incomingActionId, targetActionId].filter((id): id is string => id !== null))];
  const rows = ids.length
    ? await db
        .select({
          id: chatActions.id,
          endpointId: chatActions.endpointId,
          principalId: chatActions.principalId,
          openwa: sql<unknown>`${chatActions.payload} -> 'openwa'`,
        })
        .from(chatActions)
        .where(and(eq(chatActions.companyId, input.companyId), inArray(chatActions.id, ids)))
    : [];
  const principals = [...new Set(rows.flatMap((row) =>
    row.principalId && record(row.openwa).triggerClass !== "owner" ? [row.principalId] : []))];
  const holders = principals.length
    ? await db
        .selectDistinct({ principalId: chatOwnerGrants.requesterPrincipalId })
        .from(chatOwnerGrants)
        .where(and(
          eq(chatOwnerGrants.companyId, input.companyId),
          inArray(chatOwnerGrants.endpointId, [...new Set(rows.map((row) => row.endpointId))]),
          inArray(chatOwnerGrants.requesterPrincipalId, principals),
          eq(chatOwnerGrants.scope, "requester"),
          eq(chatOwnerGrants.status, "live"),
          gt(chatOwnerGrants.expiresAt, new Date()),
        ))
    : [];
  const grantHolders = new Set(holders.flatMap((row) => (row.principalId ? [row.principalId] : [])));
  const fromAction = (id: string | null) => (id ? wakeClassFromAction(rows.find((row) => row.id === id), grantHolders) : null);
  return {
    incoming: fromAction(incomingActionId),
    target: resolved
      ? {
          triggerClass: resolved.triggerClass,
          event: resolved.event,
          principalId: resolved.requesterPrincipalId,
          requesterGrants: openwaRunCarriesGrants(resolved),
        }
      : fromAction(targetActionId),
  };
}

function hasBoardProvenance(
  wake: { requestedByActorType: string | null; requestedByActorId: string | null; idempotencyKey: string | null; payload: unknown } | undefined,
  contextSnapshot: Record<string, unknown>,
): boolean {
  if (!wake || wake.requestedByActorType !== "user" || !text(wake.requestedByActorId)) return false;
  if (wake.idempotencyKey?.startsWith("chat-inbound:")) return false;
  if (text(contextSnapshot.source)?.startsWith("chat:")) return false;
  if (record(wake.payload).chatFailedRunRetry !== undefined || contextSnapshot.chatFailedRunRetry !== undefined) return false;
  return true;
}

async function chatActionBacked(db: Db, companyId: string, wakeupRequestId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: chatActions.id })
    .from(chatActions)
    .where(and(eq(chatActions.id, wakeupRequestId), eq(chatActions.companyId, companyId)))
    .limit(1);
  return Boolean(row);
}

type OpenwaRunDelivery = {
  id: string;
  found: boolean;
  principalId: string | null;
  triggerClass: OpenwaTriggerClass | null;
  principalRole: string | null;
  chatKey: string | null;
};

async function loadOpenwaRunDeliveries(
  db: Db,
  input: {
    companyId: string;
    endpointId: string;
    issueId: string;
    runId: string;
    wakeupRequestId: string | null;
    wakeDeliveryIds: string[];
    contextDeliveryIds: string[];
  },
): Promise<OpenwaRunDelivery[]> {
  const rows = (await db.execute(sql`
    with wanted(id) as (
      select value from jsonb_array_elements_text(${JSON.stringify(input.wakeDeliveryIds)}::jsonb)
      union
      select value from jsonb_array_elements_text(${JSON.stringify(input.contextDeliveryIds)}::jsonb)
      union
      select merged.id
      from agent_wakeup_requests receipt
      join chat_actions action on action.id = receipt.id and action.company_id = receipt.company_id
      cross join lateral (
        select value as id from jsonb_array_elements_text(
          case when jsonb_typeof(action.payload -> 'openwa' -> 'deliveryIds') = 'array' then action.payload -> 'openwa' -> 'deliveryIds' else '[]'::jsonb end
        )
        union all
        select action.delivery_id::text where action.delivery_id is not null
      ) merged
      where receipt.company_id = ${input.companyId}
        and receipt.payload ->> 'issueId' = ${input.issueId}
        and receipt.status = 'coalesced'
        and (receipt.run_id = ${input.runId} or receipt.payload ->> 'coalescedIntoWakeupRequestId' = ${input.wakeupRequestId ?? ""})
    ),
    ids as (
      select id, case when id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then id::uuid end as uid
      from wanted
    )
    select ids.id, delivery.id is not null as found, delivery.principal_id, delivery.trigger_class, delivery.principal_role,
      delivery.normalized_event -> 'openwa' ->> 'chatKey' as chat_key
    from ids
    left join chat_deliveries delivery
      on delivery.company_id = ${input.companyId} and delivery.endpoint_id = ${input.endpointId} and delivery.id = ids.uid
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    found: row.found === true,
    principalId: text(row.principal_id),
    triggerClass: triggerClass(row.trigger_class),
    principalRole: text(row.principal_role),
    chatKey: text(row.chat_key),
  }));
}

function mergedDeliveriesShare(deliveries: readonly OpenwaRunDelivery[], principalId: string, chatKey: string): boolean {
  return deliveries.every((delivery) =>
    delivery.found && delivery.chatKey !== null && normalizeChatKey(delivery.chatKey) === chatKey &&
    (delivery.triggerClass === "owner" || delivery.principalId === principalId));
}

/** Resolves the run's OpenWA authority from server-written wake records at run start; null off OpenWA issues. */
export async function resolveOpenwaRunContext(
  db: Db,
  input: { companyId: string; issueId: string; runId: string; contextSnapshot: Record<string, unknown>; wakeupRequestId: string | null },
): Promise<OpenwaRunContext | null> {
  const key = `${input.companyId}:${input.issueId}`;
  if (cacheGet(bindingCache, key, BINDING_CACHE_TTL_MS) === false) return null;
  const epoch = bindingCache.epoch;
  const binding = await openwaConversationBinding(db, input.companyId, input.issueId);
  cacheSet(bindingCache, key, binding !== null, BINDING_CACHE_LIMIT, epoch);
  if (!binding) return null;
  const chatKey = chatKeyFromConversation(binding.externalConversationId);
  const [wakeAction, wake] = input.wakeupRequestId
    ? await Promise.all([
        loadOpenwaWakeAction(db, {
          companyId: input.companyId,
          endpointId: binding.endpointId,
          conversationId: binding.conversationId,
          wakeupRequestId: input.wakeupRequestId,
        }),
        db
          .select({
            requestedByActorType: agentWakeupRequests.requestedByActorType,
            requestedByActorId: agentWakeupRequests.requestedByActorId,
            idempotencyKey: agentWakeupRequests.idempotencyKey,
            payload: agentWakeupRequests.payload,
          })
          .from(agentWakeupRequests)
          .where(and(eq(agentWakeupRequests.id, input.wakeupRequestId), eq(agentWakeupRequests.companyId, input.companyId)))
          .limit(1)
          .then((rows) => rows[0]),
      ])
    : [null, undefined];
  const base = { endpointId: binding.endpointId, chatKey };
  if (
    !wakeAction &&
    hasBoardProvenance(wake, input.contextSnapshot) &&
    !(await chatActionBacked(db, input.companyId, input.wakeupRequestId!))
  ) {
    const boardOwner = binding.status === "archived"
      ? undefined
      : (await openwaCurrentOwners(db, { companyId: input.companyId, id: binding.endpointId }))
          .find((owner) => owner.userId === wake!.requestedByActorId);
    return {
      ...base,
      triggerClass: boardOwner ? "owner" : "other",
      senderClass: "owner",
      event: null,
      grantIds: [],
      deliveryIds: [],
      requesterPrincipalId: null,
      approvalRequestId: null,
      triggerPrincipalId: boardOwner?.principalId ?? null,
    };
  }
  const deliveryIds = wakeAction?.deliveryIds ?? [];
  const runDeliveries = deliveryIds.length > 0
    ? await loadOpenwaRunDeliveries(db, {
        companyId: input.companyId,
        endpointId: binding.endpointId,
        issueId: input.issueId,
        runId: input.runId,
        wakeupRequestId: input.wakeupRequestId,
        wakeDeliveryIds: deliveryIds,
        contextDeliveryIds: [...new Set([
          ...uuids(record(input.contextSnapshot.openwa).deliveryIds),
          ...uuids(record(input.contextSnapshot[OPENWA_RUN_CONTEXT_KEY]).deliveryIds),
        ])],
      })
    : [];
  const deliveriesById = new Map(runDeliveries.map((delivery) => [delivery.id, delivery]));
  const deliveries = deliveryIds.flatMap((id) => {
    const delivery = deliveriesById.get(id);
    return delivery?.found ? [delivery] : [];
  });
  const sameChat = deliveries.length > 0 && deliveries.length === deliveryIds.length &&
    deliveries.every((delivery) => delivery.principalId && delivery.chatKey && normalizeChatKey(delivery.chatKey) === chatKey);
  const principals = sameChat ? [...new Set(deliveries.map((delivery) => delivery.principalId!))] : [];
  let cls: OpenwaTriggerClass = "other";
  if (principals.length > 0 && binding.status !== "archived" && deliveries.every((delivery) => delivery.triggerClass === "owner")) {
    let owners = true;
    for (const principalId of principals) {
      const current = await db.transaction((tx) =>
        openwaPrincipalAuthorization(tx, binding, principalId, { isDirectMessage: binding.isDirectMessage }));
      if (current.role !== "owner") {
        owners = false;
        break;
      }
    }
    if (owners) cls = "owner";
  }
  const approval = wakeAction?.approvalRequestId
    ? await db
        .select({
          id: chatOwnerApprovalRequests.id,
          status: chatOwnerApprovalRequests.status,
          requesterPrincipalId: chatOwnerApprovalRequests.requestedByPrincipalId,
        })
        .from(chatOwnerApprovalRequests)
        .where(and(
          eq(chatOwnerApprovalRequests.id, wakeAction.approvalRequestId),
          eq(chatOwnerApprovalRequests.companyId, input.companyId),
          eq(chatOwnerApprovalRequests.endpointId, binding.endpointId),
          eq(chatOwnerApprovalRequests.originChatKey, chatKey),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null)
    : null;
  const grantRequest = cls !== "owner" && wakeAction?.event === "approval_resolved" && approval?.status === "approved" ? approval : null;
  const requesterPrincipalId = cls === "owner"
    ? null
    : grantRequest
      ? grantRequest.requesterPrincipalId
      : principals.length === 1 && mergedDeliveriesShare(runDeliveries, principals[0]!, chatKey) ? principals[0]! : null;
  const now = new Date();
  const grantFilters = [
    ...(grantRequest
      ? [and(
          eq(chatOwnerGrants.requestId, grantRequest.id),
          or(eq(chatOwnerGrants.status, "live"), and(eq(chatOwnerGrants.status, "consumed"), eq(chatOwnerGrants.consumedByRunId, input.runId))),
        )!]
      : []),
    ...(requesterPrincipalId
      ? [and(
          eq(chatOwnerGrants.scope, "requester"),
          eq(chatOwnerGrants.requesterPrincipalId, requesterPrincipalId),
          eq(chatOwnerGrants.status, "live"),
        )!]
      : []),
  ];
  const grants = cls !== "owner" && grantFilters.length > 0
    ? await db
        .select({
          id: chatOwnerGrants.id,
          requestId: chatOwnerGrants.requestId,
          category: chatOwnerGrants.category,
          scope: chatOwnerGrants.scope,
          status: chatOwnerGrants.status,
        })
        .from(chatOwnerGrants)
        .where(and(
          eq(chatOwnerGrants.companyId, input.companyId),
          eq(chatOwnerGrants.endpointId, binding.endpointId),
          eq(chatOwnerGrants.originChatKey, chatKey),
          gt(chatOwnerGrants.expiresAt, now),
          or(...grantFilters),
        ))
    : [];
  if (grantRequest && grants.some((grant) => grant.requestId === grantRequest.id)) cls = "grant";
  const completionTurn = !wakeAction && cls === "other" && deliveries.length === 0 &&
    (await isOpenwaCompletionTurn(db, { companyId: input.companyId, runId: input.runId, issueId: input.issueId }));
  const ownerGroup = cls === "other" && deliveryIds.length === 0 && !binding.isDirectMessage && binding.status !== "archived" &&
    (await openwaBindingOwnerGroup(db, { companyId: input.companyId, endpointId: binding.endpointId, chatKey, runId: input.runId, conversationId: binding.conversationId }));
  const ownerOrigin = cls === "other" && deliveryIds.length === 0
    ? await openwaOwnerOrigin(db, { binding, chatKey, companyId: input.companyId, runId: input.runId, issueId: input.issueId, completionTurn, ownerGroup })
    : null;
  return {
    ...base,
    triggerClass: cls,
    senderClass: cls === "owner" || ownerOrigin ? "owner" : "non_owner",
    event: wakeAction?.event ?? (completionTurn ? "task_completion" : null),
    grantIds: grants.map((grant) => grant.id).sort(),
    deliveryIds: deliveries
      .filter((delivery) => delivery.chatKey && normalizeChatKey(delivery.chatKey) === chatKey)
      .map((delivery) => delivery.id),
    requesterPrincipalId,
    approvalRequestId: approval?.id ?? null,
    triggerPrincipalId: cls === "owner"
      ? (deliveries.find((delivery) => delivery.id === deliveryIds[deliveryIds.length - 1])?.principalId ?? null)
      : null,
    ...(ownerOrigin ? { ownerOrigin } : {}),
    ...(ownerGroup ? { ownerGroup: true as const } : {}),
  };
}

async function openwaBindingOwnerGroup(
  db: Db,
  input: { companyId: string; endpointId: string; chatKey: string; runId: string; conversationId: string | null; source?: string },
): Promise<boolean> {
  const [endpoint] = await db
    .select()
    .from(chatEndpoints)
    .where(and(eq(chatEndpoints.companyId, input.companyId), eq(chatEndpoints.id, input.endpointId)))
    .limit(1);
  if (!endpoint || endpoint.status === "archived" || endpoint.provider !== "openwa") return false;
  return openwaOwnerOnlyGroup(db, endpoint, input.chatKey, { source: input.source ?? "run_start", runId: input.runId, conversationId: input.conversationId });
}

async function openwaOwnerOrigin(
  db: Db,
  input: {
    binding: { endpointId: string; isDirectMessage: boolean; status: string };
    chatKey: string;
    companyId: string;
    runId: string;
    issueId: string;
    completionTurn: boolean;
    ownerGroup: boolean;
  },
): Promise<OpenwaOwnerOrigin | null> {
  if (input.binding.status === "archived") return null;
  if (input.binding.isDirectMessage) {
    const owners = await openwaCurrentOwners(db, { companyId: input.companyId, id: input.binding.endpointId });
    if (owners.some((owner) => owner.jids.some((jid) => normalizeChatKey(jid) === input.chatKey))) return "owner_chat";
  }
  if (input.ownerGroup) return "owner_group";
  if (input.completionTurn && (await openwaCompletionOwedToOwner(db, { companyId: input.companyId, runId: input.runId, issueId: input.issueId })))
    return "owner_task";
  return null;
}

/** Writes the resolved context and the full tool profile every run gets. */
export function applyOpenwaRunContext(context: Record<string, unknown>, openwa: OpenwaRunContext | null) {
  if (!openwa) {
    delete context[OPENWA_RUN_CONTEXT_KEY];
    context[RUN_TOOL_PROFILE_CONTEXT_KEY] = "full";
    return;
  }
  context[OPENWA_RUN_CONTEXT_KEY] = openwa;
  context[RUN_TOOL_PROFILE_CONTEXT_KEY] = "full";
}

export function clearOpenwaRunContext(context: Record<string, unknown>) {
  delete context[OPENWA_RUN_CONTEXT_KEY];
  delete context[RUN_TOOL_PROFILE_CONTEXT_KEY];
}

const WINDOW_ANCESTRY_MAX_DEPTH = 64;

/** Root of the usable live autonomy window over the issue or one of its ancestors. */
export async function openwaLiveWindowRoot(db: Db, companyId: string, issueId: string): Promise<string | null> {
  const [anyLive] = await db
    .select({ id: issueAutonomyWindows.id })
    .from(issueAutonomyWindows)
    .where(and(eq(issueAutonomyWindows.companyId, companyId), eq(issueAutonomyWindows.status, "live"), gt(issueAutonomyWindows.expiresAt, new Date())))
    .limit(1);
  if (!anyLive) return null;
  const rows = await db.execute(sql`
    with recursive chain(id, parent_id, depth) as (
      select id, parent_id, 0 from issues where company_id = ${companyId}::uuid and id = ${issueId}::uuid
      union all
      select parent.id, parent.parent_id, chain.depth + 1 from issues parent
      join chain on parent.id = chain.parent_id
      where parent.company_id = ${companyId}::uuid and chain.depth < ${WINDOW_ANCESTRY_MAX_DEPTH}
    )
    select live.root_issue_id from ${issueAutonomyWindows} live
    join chain on live.root_issue_id = chain.id
    where live.company_id = ${companyId}::uuid and live.status = 'live' and live.expires_at > now()
      and (live.max_accepts is null or live.accept_count < live.max_accepts)
    order by live.expires_at desc
    limit 1`);
  const [row] = Array.from(rows as Iterable<Record<string, unknown>>);
  return row ? String(row.root_issue_id) : null;
}

/** Records an action of an OpenWA run in the endpoint audit without waiting for the write; it never blocks the action. */
export function noteOpenwaRunAction(
  db: Db,
  run: RunLike,
  detail: { seam: string; category?: OpenwaApprovalCategory; method?: string; path?: string },
): void {
  const openwa = readOpenwaRunContext(run.contextSnapshot);
  if (!openwa) return;
  void recordOpenwaAudit(db, {
    companyId: run.companyId,
    endpointId: openwa.endpointId,
    kind: "tool_called",
    actorKind: "agent",
    runId: run.id,
    chatKey: openwa.chatKey,
    metadata: { ...detail, senderClass: openwa.senderClass, triggerClass: openwa.triggerClass },
  }).catch((error: unknown) => logger.warn({ err: error, runId: run.id, seam: detail.seam }, "OpenWA run action audit write failed"));
}

/** Records a mutating REST request made with an OpenWA run's token. */
export function noteOpenwaRestMutation(db: Db, input: { run: RunLike; method: string; path: string }): void {
  const method = input.method.toUpperCase();
  if (!SAFE_METHODS.has(method)) noteOpenwaRunAction(db, input.run, { seam: "rest", method, path: input.path });
}

const OPENWA_TREE_MAX_DEPTH = 32;
const ISSUE_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when the issue (id or identifier) is the conversation issue or one of its descendants by parentId, within the company. */
export async function isOpenwaConversationTreeIssue(
  db: Db,
  input: { companyId: string; rootIssueId: string; issueKey: string },
): Promise<boolean> {
  if (!ISSUE_UUID_PATTERN.test(input.rootIssueId)) return false;
  const start = ISSUE_UUID_PATTERN.test(input.issueKey)
    ? sql`id = ${input.issueKey}::uuid`
    : sql`identifier = ${input.issueKey.toUpperCase()}`;
  const rows = await db.execute(sql`
    with recursive chain(id, parent_id, depth) as (
      select id, parent_id, 0 from issues
      where company_id = ${input.companyId}::uuid and ${start}
      union all
      select parent.id, parent.parent_id, chain.depth + 1 from issues parent
      join chain on parent.id = chain.parent_id
      where parent.company_id = ${input.companyId}::uuid and chain.depth < ${OPENWA_TREE_MAX_DEPTH} and chain.id <> ${input.rootIssueId}::uuid
    )
    select 1 as found from chain where id = ${input.rootIssueId}::uuid limit 1`);
  return Array.from(rows as Iterable<unknown>).length > 0;
}

/** D35: persistent keys of an agent bound to a non-archived OpenWA endpoint never mutate. */
export async function assertOpenwaAgentKeyMethodAllowed(
  db: Db,
  input: { companyId: string; agentId: string; method: string },
): Promise<void> {
  if (SAFE_METHODS.has(input.method.toUpperCase())) return;
  const key = `${input.companyId}:${input.agentId}`;
  let bound = cacheGet(agentKeyCache, key, AGENT_KEY_CACHE_TTL_MS);
  if (bound === null) {
    const epoch = agentKeyCache.epoch;
    const [row] = await db
      .select({ id: chatEndpoints.id })
      .from(chatEndpoints)
      .where(and(
        eq(chatEndpoints.companyId, input.companyId),
        eq(chatEndpoints.assignedAgentId, input.agentId),
        eq(chatEndpoints.provider, "openwa"),
        ne(chatEndpoints.status, "archived"),
      ))
      .limit(1);
    bound = Boolean(row);
    cacheSet(agentKeyCache, key, bound, AGENT_KEY_CACHE_LIMIT, epoch);
  }
  if (bound) {
    throw forbidden("Persistent agent keys of an OpenWA agent are read-only; use run-bound credentials", {
      code: OPENWA_AGENT_KEY_READ_ONLY_CODE,
    });
  }
}
