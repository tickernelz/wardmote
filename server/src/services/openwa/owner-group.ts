import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { chatEndpointResources, chatEndpoints, type Db } from "@tickernelz/wardmote-db";
import { openwaChatSettingsSchema, openwaEndpointPolicySchema } from "@tickernelz/wardmote-shared";
import { recordOpenwaAudit } from "./audit.js";
import type { OpenwaGatewayClient, OpenwaGroupParticipant } from "./gateway.js";
import { openwaChatKey } from "./outbound.js";
import { openwaChatResource, openwaOwnerReportRoute, openwaReportChatOf, type OpenwaOwnerReportChat } from "./owner-report.js";
import { openwaCurrentOwners, type OpenwaCurrentOwner } from "./owners.js";
import { openwaDigits, openwaParticipantJids, openwaResourceGroupActive } from "./policy.js";

type DbOrTransaction = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type EndpointRow = typeof chatEndpoints.$inferSelect;

export const OPENWA_OWNER_GROUP_ACTOR_ID = "openwa:owner_group";

export type OpenwaOwnerGroupReason = "owner_only" | "non_owner" | "unverified" | "disabled";

export interface OpenwaOwnerGroupCheck {
  source: string;
  runId?: string | null;
  conversationId?: string | null;
}

const groupGateways = new WeakMap<Db, (endpoint: EndpointRow) => Promise<OpenwaGatewayClient>>();

export function registerOpenwaGroupGateway(db: Db, resolve: (endpoint: EndpointRow) => Promise<OpenwaGatewayClient>): () => void {
  groupGateways.set(db, resolve);
  return () => {
    if (groupGateways.get(db) === resolve) groupGateways.delete(db);
  };
}

const groupCheckTimeoutMs = 4_000;
const groupChecks = new AsyncLocalStorage<{ open: boolean; checks: Map<string, Promise<boolean>> }>();

function groupCheckKey(endpointId: string, chatKey: string): string {
  return endpointId + "\u0000" + chatKey;
}

/** Shares one live participant read per chat until the HTTP response closes; work that outlives the response reads the gateway again. */
export function openwaOwnerGroupRequestScope(_req: Request, res: Response, next: NextFunction): void {
  const scope = { open: true, checks: new Map<string, Promise<boolean>>() };
  res.once("close", () => {
    scope.open = false;
    scope.checks.clear();
  });
  groupChecks.run(scope, next);
}

/** Drops a chat's shared live read so a settings change applies inside the same request. */
export function openwaForgetOwnerGroup(endpointId: string, chatKey: string): void {
  groupChecks.getStore()?.checks.delete(groupCheckKey(endpointId, openwaChatKey(chatKey)));
}

export function openwaOwnerKeys(owner: Pick<OpenwaCurrentOwner, "jids" | "digits">): string[] {
  return [...owner.jids.map(openwaChatKey), ...(owner.digits ? [owner.digits + "@c.us"] : [])];
}

/** True when every participant is a current owner or this endpoint's own number, both present; an unknown or partial list is never owner-only. */
export function openwaOnlyOwnersAndBot(
  botExternalId: string | null,
  ownerIdOf: (jid: string) => string | null,
  participants: ReadonlyArray<readonly string[]> | null,
  participantCount: number | null,
): boolean {
  if (!participants || participants.length === 0 || participantCount === null || participantCount < 1) return false;
  const bot = openwaDigits(botExternalId ?? "");
  const people = new Set<string>();
  for (const keys of participants) {
    const jids = keys.map(openwaChatKey);
    if (bot && jids.some((jid) => jid.endsWith("@c.us") && openwaDigits(jid) === bot)) {
      people.add("bot");
      continue;
    }
    const ownerId = jids.map(ownerIdOf).find((id): id is string => id !== null);
    if (!ownerId) return false;
    people.add("owner:" + ownerId);
  }
  return people.has("bot") && people.size > 1 && people.size === participantCount;
}

export function openwaOwnerIdOf(owners: readonly OpenwaCurrentOwner[]): (jid: string) => string | null {
  const byKey = new Map<string, string>();
  for (const owner of owners) for (const key of openwaOwnerKeys(owner)) byKey.set(key, owner.ownerId);
  return (jid) => byKey.get(openwaChatKey(jid)) ?? null;
}

export function openwaGroupParticipantKeys(participants: readonly OpenwaGroupParticipant[]): string[][] {
  return participants.map((participant) => openwaParticipantJids([participant]));
}

/** Stores the owner-only status of a group and records an owner_group_changed audit row when it flips. */
export async function openwaRecordOwnerGroupStatus(
  db: DbOrTransaction,
  group: { companyId: string; endpointId: string; providerResourceId: string; chatKey: string },
  status: { ownerOnly: boolean; reason: OpenwaOwnerGroupReason; participantCount: number | null },
  check: OpenwaOwnerGroupCheck,
): Promise<void> {
  const key = openwaChatKey(group.chatKey);
  const [flip] = (await db.execute(sql`
    with current as (
      select ${chatEndpointResources.id} as id, ${chatEndpointResources.metadata} as metadata
      from ${chatEndpointResources}
      where ${chatEndpointResources.companyId} = ${group.companyId}::uuid
        and ${chatEndpointResources.endpointId} = ${group.endpointId}::uuid
        and ${chatEndpointResources.type} = 'group_chat'
        and ${chatEndpointResources.providerResourceId} = ${group.providerResourceId}
      for update
    )
    update ${chatEndpointResources} as target
    set metadata = target.metadata || jsonb_build_object('ownerOnly', ${status.ownerOnly}::boolean), updated_at = now()
    from current
    where target.id = current.id
      and (current.metadata ->> 'ownerOnly') is distinct from (${status.ownerOnly}::boolean)::text
    returning (current.metadata ->> 'ownerOnly') as previous
  `)) as unknown as Array<{ previous: string | null }>;
  if (!flip || (flip.previous === "true") === status.ownerOnly) return;
  await recordOpenwaAudit(db, {
    companyId: group.companyId,
    endpointId: group.endpointId,
    conversationId: check.conversationId ?? null,
    chatKey: key,
    kind: "owner_group_changed",
    actorKind: "system",
    actorRef: OPENWA_OWNER_GROUP_ACTOR_ID,
    runId: check.runId ?? null,
    metadata: { ownerOnly: status.ownerOnly, reason: status.reason, participantCount: status.participantCount, source: check.source },
  });
}

/** True only while the chat's ownerGroupAccess is auto and the gateway's live participant list of an active group holds just current owners and this number; fails closed when it cannot be read. */
export async function openwaOwnerOnlyGroup(db: Db, endpoint: EndpointRow, chatKey: string, check: OpenwaOwnerGroupCheck): Promise<boolean> {
  const key = openwaChatKey(chatKey);
  if (!key.endsWith("@g.us")) return false;
  const scope = groupChecks.getStore();
  if (!scope?.open) return readOwnerOnlyGroup(db, endpoint, key, check);
  const scopeKey = groupCheckKey(endpoint.id, key);
  const shared = scope.checks.get(scopeKey) ?? readOwnerOnlyGroup(db, endpoint, key, check);
  scope.checks.set(scopeKey, shared);
  return shared;
}

async function readOwnerOnlyGroup(db: Db, endpoint: EndpointRow, key: string, check: OpenwaOwnerGroupCheck): Promise<boolean> {
  const resource = await openwaChatResource(db, endpoint, key);
  const policy = openwaEndpointPolicySchema.parse(endpoint.policy ?? {});
  if (!resource || resource.type !== "group_chat" || !openwaResourceGroupActive(policy, resource)) return false;
  const group = { companyId: endpoint.companyId, endpointId: endpoint.id, providerResourceId: resource.providerResourceId, chatKey: key };
  const settings = openwaChatSettingsSchema.safeParse(resource.settings ?? {});
  if (settings.success && settings.data.ownerGroupAccess === "off") {
    await openwaRecordOwnerGroupStatus(db, group, { ownerOnly: false, reason: "disabled", participantCount: null }, check);
    return false;
  }
  const resolve = groupGateways.get(db);
  const [live, owners] = await Promise.all([
    resolve ? resolve(endpoint).then((gateway) => gateway.getGroup(key, { timeoutMs: groupCheckTimeoutMs })).catch(() => null) : Promise.resolve(null),
    openwaCurrentOwners(db, endpoint),
  ]);
  const participants = live && Array.isArray(live.participants) ? live.participants : null;
  const ownerOnly = participants !== null && openwaOnlyOwnersAndBot(endpoint.botExternalId, openwaOwnerIdOf(owners), openwaGroupParticipantKeys(participants), participants.length);
  const reason: OpenwaOwnerGroupReason = participants === null ? "unverified" : ownerOnly ? "owner_only" : "non_owner";
  await openwaRecordOwnerGroupStatus(db, group, { ownerOnly, reason, participantCount: participants?.length ?? null }, check);
  return ownerOnly;
}

/** Chat for a chat's owner-facing messages: its usable owner report group, else the chat itself while it is an owner-only group, else null (the owner's direct chat). */
export async function openwaOwnerFacingChat(
  db: Db,
  endpoint: EndpointRow,
  originChatKey: string,
  check: OpenwaOwnerGroupCheck,
): Promise<(OpenwaOwnerReportChat & { via: "owner_report" | "owner_group" }) | null> {
  const report = await openwaOwnerReportRoute(db, endpoint, originChatKey, check);
  if (report) return { ...report, via: "owner_report" };
  const key = openwaChatKey(originChatKey);
  if (!(await openwaOwnerOnlyGroup(db, endpoint, key, check))) return null;
  const resource = await openwaChatResource(db, endpoint, key);
  return resource ? { ...openwaReportChatOf(resource, key), via: "owner_group" } : null;
}
