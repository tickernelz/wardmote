import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agentApiKeys,
  agentWakeupRequests,
  agents,
  authUsers,
  chatActions,
  chatAuditEntries,
  chatCompletionDeliveries,
  chatConversations,
  chatDeliveries,
  chatEndpointOwners,
  chatEndpoints,
  chatExternalPrincipals,
  chatIdentityLinks,
  chatOwnerApprovalRequests,
  chatOwnerGrants,
  chatTaskHandoffs,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
  toolApplications,
  toolConnections,
  toolPolicies,
} from "@tickernelz/wardmote-db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { createRuntimeToolsToken } from "../runtime-tools-token.js";
import { runtimeConnectionIntentRoutes } from "../routes/connection-intents.js";
import { connectionIntentService } from "../services/connection-intents.js";
import { projectToolContext } from "../services/project-tool-context.js";
import { WardmoteRunnerToolAuthority } from "../services/native-runtime/wardmote-runner-tool-authority.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { chatChannelService } from "../services/chat-channels.js";
import { ChatSdkRuntime } from "../services/chat-sdk-runtime.js";
import { scheduleOpenwaFollowupForRun } from "../services/openwa/followups.js";
import { openwaTaskChatOrigin } from "../services/chat-completion-delivery.js";
import {
  OPENWA_RUN_CONTEXT_KEY,
  applyOpenwaRunContext,
  isOpenwaConversationIssue,
  openwaRunCarriesGrants,
  resolveOpenwaRunContext,
  type OpenwaRunContext,
} from "../services/openwa/authority.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
let databaseUrl = "";

function loggedDb() {
  const queries: string[] = [];
  const db = createDb(databaseUrl);
  const session = (db as unknown as { session: { logger: unknown; options: { logger?: unknown } } }).session;
  session.logger = { logQuery: (query: string) => { queries.push(query); } };
  session.options.logger = session.logger;
  return { queries, db };
}
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const BOARD_USER = "openwa-board";
const CHAT_KEY = "628111222333@c.us";

type Seed = Awaited<ReturnType<typeof seedCompany>>;

describe("openwaRunCarriesGrants", () => {
  it("counts grant rows only", () => {
    expect(openwaRunCarriesGrants({ grantIds: [] })).toBe(false);
    expect(openwaRunCarriesGrants({ grantIds: ["grant-1"] })).toBe(true);
  });
});

async function seedCompany(db: ReturnType<typeof createDb>, opts: { openwa?: boolean } = {}) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  const issueId = randomUUID();
  const endpointId = randomUUID();
  const prefix = `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
  await db.insert(companies).values({ id: companyId, name: "OpenWA authority", issuePrefix: prefix, issueCounter: 1 });
  await db.insert(companyMemberships).values({
    companyId, principalId: BOARD_USER, principalType: "user", status: "active", membershipRole: "owner",
  });
  await db.insert(agents).values({
    id: agentId, companyId, name: "OpenWA agent", role: "engineer", status: "idle",
    adapterType: "wardmote_runner", adapterConfig: {}, runtimeConfig: {}, permissions: {},
  });
  await db.insert(issues).values({
    id: issueId, companyId, issueNumber: 1, identifier: `${prefix}-1`, title: "WhatsApp chat",
    status: "in_progress", workMode: "standard", assigneeAgentId: agentId, responsibleUserId: BOARD_USER,
  });
  const applicationId = randomUUID();
  const connectionId = randomUUID();
  await db.insert(toolApplications).values({
    id: applicationId, companyId, applicationKey: `chat:openwa:${endpointId}`, name: "OpenWA", type: "chat", status: "active",
  });
  await db.insert(toolConnections).values({
    id: connectionId, companyId, applicationId, name: "OpenWA channel", uid: `chat-openwa-${endpointId}`,
    connectionPurpose: "channel", transport: "chat_sdk", status: "active", enabled: true,
  });
  await db.insert(chatEndpoints).values({
    id: endpointId, companyId, connectionId, provider: opts.openwa === false ? "telegram" : "openwa",
    publicId: randomUUID(), assignedAgentId: agentId, status: "active",
  });
  await db.insert(chatConversations).values({
    companyId, endpointId, issueId,
    externalConversationId: `openwa:session-1:${CHAT_KEY}`,
    externalThreadId: `openwa:session-1:${CHAT_KEY}`,
    externalLabel: "Member", state: "active", isDirectMessage: true,
  });
  return { companyId, agentId, issueId, endpointId };
}

async function seedPlainIssue(db: ReturnType<typeof createDb>, seed: Seed) {
  const issueId = randomUUID();
  await db.insert(issues).values({
    id: issueId, companyId: seed.companyId, title: "Plain task", status: "in_progress", assigneeAgentId: seed.agentId,
  });
  return issueId;
}

async function seedGrant(
  db: ReturnType<typeof createDb>,
  seed: Seed,
  input: {
    category: "create_task" | "external_tools"; scope?: "one_action" | "requester"; chatKey?: string; expiresAt?: Date;
    status?: "live" | "revoked"; requesterPrincipalId?: string; requestStatus?: "approved" | "pending" | "rejected";
  },
) {
  const [approval] = await db.insert(chatOwnerApprovalRequests).values({
    companyId: seed.companyId, endpointId: seed.endpointId, originChatKey: input.chatKey ?? CHAT_KEY,
    requestedByPrincipalId: input.requesterPrincipalId ?? null,
    categories: [input.category], scope: input.scope ?? "one_action", summary: "Create a task", proposedAction: "create",
    status: input.requestStatus ?? "approved",
  }).returning();
  const [grant] = await db.insert(chatOwnerGrants).values({
    companyId: seed.companyId, endpointId: seed.endpointId, requestId: approval!.id,
    originChatKey: input.chatKey ?? CHAT_KEY, category: input.category, scope: input.scope ?? "one_action",
    requesterPrincipalId: input.requesterPrincipalId ?? null,
    status: input.status ?? "live", approvedVia: "wardmote", approvedByUserId: BOARD_USER,
    expiresAt: input.expiresAt ?? new Date(Date.now() + 3_600_000),
  }).returning();
  return { grantId: grant!.id, requestId: approval!.id };
}

function openwaContext(seed: Seed, input: Partial<OpenwaRunContext>): OpenwaRunContext {
  return {
    endpointId: seed.endpointId, chatKey: CHAT_KEY, triggerClass: "other", senderClass: "non_owner", event: null, grantIds: [], deliveryIds: [],
    requesterPrincipalId: null, approvalRequestId: null, triggerPrincipalId: null, ...input,
  };
}

async function seedRun(
  db: ReturnType<typeof createDb>,
  seed: Seed,
  input: { issueId?: string; openwa?: OpenwaRunContext | null; native?: boolean },
) {
  const runId = randomUUID();
  const issueId = input.issueId ?? seed.issueId;
  const contextSnapshot: Record<string, unknown> = { issueId, taskId: issueId };
  if (input.openwa) contextSnapshot.wardmoteOpenwa = input.openwa;
  await db.insert(heartbeatRuns).values({
    id: runId, companyId: seed.companyId, agentId: seed.agentId, status: "running",
    invocationSource: "assignment", triggerDetail: "system", responsibleUserId: BOARD_USER,
    contextSnapshot, ...(input.native ? { runtimeMode: "native", nativeIssueId: issueId } : {}),
  });
  await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
  return { runId, contextSnapshot };
}

async function seedWake(
  db: ReturnType<typeof createDb>,
  seed: Seed,
  input: {
    actorType: "user" | "agent" | "system"; actorId?: string | null; openwaClass?: string; deliveryIds?: string[];
    idempotencyKey?: string;
  },
) {
  const [wake] = await db.insert(agentWakeupRequests).values({
    companyId: seed.companyId, agentId: seed.agentId, source: "automation", reason: "test",
    payload: input.openwaClass ? { openwa: { triggerClass: input.openwaClass, deliveryIds: input.deliveryIds ?? [] } } : {},
    requestedByActorType: input.actorType, requestedByActorId: input.actorId ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
  }).returning();
  return wake!.id;
}

async function seedWakeAction(
  db: ReturnType<typeof createDb>,
  seed: Seed,
  input: { openwa: Record<string, unknown> | null; conversationId?: string | null },
) {
  const [conversation] = await db.select({ id: chatConversations.id }).from(chatConversations)
    .where(eq(chatConversations.issueId, seed.issueId));
  const [action] = await db.insert(chatActions).values({
    companyId: seed.companyId, endpointId: seed.endpointId,
    conversationId: input.conversationId === undefined ? conversation!.id : input.conversationId,
    kind: "inbound_wakeup", providerActionId: "wake:" + randomUUID(), status: "issued",
    payload: input.openwa ? { version: 1, openwa: input.openwa } : { version: 1 },
  }).returning();
  await db.insert(agentWakeupRequests).values({
    id: action!.id, companyId: seed.companyId, agentId: seed.agentId, source: "assignment", reason: "chat",
    payload: input.openwa ? { openwa: input.openwa } : {}, requestedByActorType: "system", requestedByActorId: null,
  }).onConflictDoNothing();
  return action!.id;
}

async function seedPrincipal(db: ReturnType<typeof createDb>, seed: Seed, externalId: string, opts: { owner?: boolean } = {}) {
  const [principal] = await db.insert(chatExternalPrincipals).values({
    companyId: seed.companyId, provider: "openwa", providerAccountId: "acct-" + seed.endpointId, externalId,
  }).returning();
  if (!opts.owner) return { principalId: principal!.id, linkId: null as string | null };
  const [link] = await db.insert(chatIdentityLinks).values({
    companyId: seed.companyId, endpointId: seed.endpointId, principalId: principal!.id, wardmoteUserId: BOARD_USER, status: "linked",
  }).returning();
  await db.insert(chatEndpointOwners).values({ companyId: seed.companyId, endpointId: seed.endpointId, identityLinkId: link!.id });
  return { principalId: principal!.id, linkId: link!.id };
}

async function seedDelivery(
  db: ReturnType<typeof createDb>,
  seed: Seed,
  input: { principalId: string; triggerClass: "owner" | "other"; chatKey?: string },
) {
  const id = randomUUID();
  await db.insert(chatDeliveries).values({
    id, companyId: seed.companyId, endpointId: seed.endpointId, principalId: input.principalId,
    providerEventId: "evt-" + id, deduplicationKey: "openwa:test:" + id, eventKind: "direct_message",
    normalizedEvent: { openwa: { chatKey: input.chatKey ?? CHAT_KEY } }, state: "processed",
    triggerClass: input.triggerClass, principalRole: input.triggerClass === "owner" ? "owner" : "allowed", answerState: "pending",
  });
  return id;
}

describeEmbeddedPostgres("OpenWA run authority", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const previousSecret = process.env.WARDMOTE_AGENT_JWT_SECRET;
  const previousInstance = process.env.WARDMOTE_INSTANCE_ID;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("wardmote-openwa-authority-");
    databaseUrl = tempDb.connectionString;
    db = createDb(tempDb.connectionString);
    await db.insert(authUsers).values({
      id: BOARD_USER, name: "Board", email: "board@openwa.test", emailVerified: true, createdAt: new Date(), updatedAt: new Date(),
    });
  }, 60_000);

  beforeEach(() => {
    process.env.WARDMOTE_AGENT_JWT_SECRET = "openwa-authority-secret";
    delete process.env.WARDMOTE_INSTANCE_ID;
  });

  afterEach(() => {
    if (previousSecret === undefined) delete process.env.WARDMOTE_AGENT_JWT_SECRET;
    else process.env.WARDMOTE_AGENT_JWT_SECRET = previousSecret;
    if (previousInstance === undefined) delete process.env.WARDMOTE_INSTANCE_ID;
    else process.env.WARDMOTE_INSTANCE_ID = previousInstance;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  describe("sender class at run start", () => {
    const resolve = (seed: Seed, wakeupRequestId: string | null, contextSnapshot: Record<string, unknown> = {}, runId = randomUUID()) =>
      resolveOpenwaRunContext(db, { companyId: seed.companyId, issueId: seed.issueId, runId, contextSnapshot, wakeupRequestId });

    it("is read_only without a server-written wake record for agent, system, retry or missing wakes", async () => {
      const seed = await seedCompany(db);
      for (const wakeupRequestId of [
        await seedWake(db, seed, { actorType: "agent", actorId: seed.agentId }),
        await seedWake(db, seed, { actorType: "system" }),
        null,
      ]) {
        await expect(resolve(seed, wakeupRequestId, { issueId: seed.issueId })).resolves.toEqual(openwaContext(seed, {}));
      }
    });

    it("carries an owner's authority into a message-less wake only from the owner's own DM, never a group, a member DM or a context claim", async () => {
      const seed = await seedCompany(db);
      const system = await seedWake(db, seed, { actorType: "system" });
      await expect(resolve(seed, system)).resolves.toEqual(openwaContext(seed, {}));
      const forged = { [OPENWA_RUN_CONTEXT_KEY]: { ...openwaContext(seed, { senderClass: "owner" }), ownerOrigin: "owner_chat", triggerClass: "owner" } };
      await expect(resolve(seed, system, forged)).resolves.toEqual(openwaContext(seed, {}));
      const owner = await seedPrincipal(db, seed, CHAT_KEY, { owner: true });
      await expect(resolve(seed, system)).resolves.toEqual(openwaContext(seed, { senderClass: "owner", ownerOrigin: "owner_chat" }));
      const memberDelivery = await seedDelivery(db, seed, { principalId: (await seedPrincipal(db, seed, "628555000111@c.us")).principalId, triggerClass: "other" });
      const memberWake = await seedWakeAction(db, seed, { openwa: { event: "message", triggerClass: "other", deliveryIds: [memberDelivery] } });
      await expect(resolve(seed, memberWake)).resolves.toMatchObject({ senderClass: "non_owner" });
      await db.update(chatConversations).set({ isDirectMessage: false }).where(eq(chatConversations.issueId, seed.issueId));
      await expect(resolve(seed, system)).resolves.toEqual(openwaContext(seed, {}));
      await db.update(chatConversations).set({ isDirectMessage: true }).where(eq(chatConversations.issueId, seed.issueId));
      await db.update(chatIdentityLinks).set({ status: "revoked" }).where(eq(chatIdentityLinks.id, owner.linkId!));
      await expect(resolve(seed, system)).resolves.toEqual(openwaContext(seed, {}));
    });

    it("carries an owner's authority into a task_completion turn only when every reported task was handed off by an owner run", async () => {
      const seed = await seedCompany(db);
      const handoff = async (reportToOwner: boolean, runId: string) => {
        const taskId = randomUUID();
        await db.insert(issues).values({ id: taskId, companyId: seed.companyId, parentId: seed.issueId, title: "Delegated", status: "done" });
        await db.insert(chatTaskHandoffs).values({
          taskId, companyId: seed.companyId, conversationId: seed.issueId, agentId: seed.agentId, sessionGeneration: 0, channel: "openwa", reportToOwner,
        });
        await db.insert(chatCompletionDeliveries).values({ companyId: seed.companyId, taskId, statusVersion: 1, status: "queued", targetRunId: runId });
      };
      const ownerTurn = await seedRun(db, seed, {});
      await handoff(true, ownerTurn.runId);
      await expect(resolve(seed, null, {}, ownerTurn.runId)).resolves.toEqual(
        openwaContext(seed, { senderClass: "owner", event: "task_completion", ownerOrigin: "owner_task" }),
      );
      const memberTurn = await seedRun(db, seed, {});
      await handoff(false, memberTurn.runId);
      await expect(resolve(seed, null, {}, memberTurn.runId)).resolves.toEqual(openwaContext(seed, { event: "task_completion" }));
      const mixedTurn = await seedRun(db, seed, {});
      await handoff(true, mixedTurn.runId);
      await handoff(false, mixedTurn.runId);
      await expect(resolve(seed, null, {}, mixedTurn.runId)).resolves.toMatchObject({ senderClass: "non_owner" });
    });

    it("is full only for a board user wake without chat provenance", async () => {
      const seed = await seedCompany(db);
      const board = await seedWake(db, seed, { actorType: "user", actorId: BOARD_USER });
      await expect(resolve(seed, board)).resolves.toEqual(openwaContext(seed, { senderClass: "owner" }));
      await expect(resolve(seed, board, { source: "chat:openwa" })).resolves.toMatchObject({ senderClass: "non_owner" });
      await expect(resolve(seed, board, { chatFailedRunRetry: { version: 1 } })).resolves.toMatchObject({ senderClass: "non_owner" });
      const inbound = await seedWake(db, seed, { actorType: "user", actorId: BOARD_USER, idempotencyKey: "chat-inbound:" + randomUUID() });
      await expect(resolve(seed, inbound)).resolves.toMatchObject({ senderClass: "non_owner" });
      const action = await seedWakeAction(db, seed, { openwa: null });
      await db.update(agentWakeupRequests).set({ requestedByActorType: "user", requestedByActorId: BOARD_USER }).where(eq(agentWakeupRequests.id, action));
      await expect(resolve(seed, action)).resolves.toMatchObject({ senderClass: "non_owner" });
    });

    it("classes a board wake by the endpoint's owner user as owner and any other board user as other", async () => {
      const seed = await seedCompany(db);
      const owner = await seedPrincipal(db, seed, "628999000111@c.us", { owner: true });
      const ownerComment = await seedWake(db, seed, { actorType: "user", actorId: BOARD_USER });
      const otherComment = await seedWake(db, seed, { actorType: "user", actorId: "openwa-other-board-user" });

      await expect(resolve(seed, ownerComment)).resolves.toEqual(
        openwaContext(seed, { triggerClass: "owner", senderClass: "owner", triggerPrincipalId: owner.principalId }),
      );
      await expect(resolve(seed, otherComment)).resolves.toEqual(openwaContext(seed, { senderClass: "owner" }));

      await db.update(chatIdentityLinks).set({ status: "revoked" }).where(eq(chatIdentityLinks.id, owner.linkId!));
      await expect(resolve(seed, ownerComment)).resolves.toEqual(openwaContext(seed, { senderClass: "owner" }));
    });

    it("derives owner only from admitted owner deliveries whose principal is still an owner", async () => {
      const seed = await seedCompany(db);
      const owner = await seedPrincipal(db, seed, "628999000111@c.us", { owner: true });
      const member = await seedPrincipal(db, seed, CHAT_KEY);
      const ownerDelivery = await seedDelivery(db, seed, { principalId: owner.principalId, triggerClass: "owner" });
      const memberDelivery = await seedDelivery(db, seed, { principalId: member.principalId, triggerClass: "other" });
      const ownerWake = await seedWakeAction(db, seed, { openwa: { event: "message", triggerClass: "owner", deliveryIds: [ownerDelivery] } });
      await expect(resolve(seed, ownerWake)).resolves.toEqual(
        openwaContext(seed, { triggerClass: "owner", senderClass: "owner", event: "message", deliveryIds: [ownerDelivery], triggerPrincipalId: owner.principalId }),
      );
      const mixed = await seedWakeAction(db, seed, { openwa: { event: "message", triggerClass: "owner", deliveryIds: [ownerDelivery, memberDelivery] } });
      const mixedContext = await resolve(seed, mixed);
      expect(mixedContext).toMatchObject({ triggerClass: "other", senderClass: "non_owner", requesterPrincipalId: null });
      expect(mixedContext!.deliveryIds.sort()).toEqual([ownerDelivery, memberDelivery].sort());
      await db.update(chatIdentityLinks).set({ status: "revoked" }).where(eq(chatIdentityLinks.id, owner.linkId));
      await expect(resolve(seed, ownerWake)).resolves.toMatchObject({ triggerClass: "other", senderClass: "non_owner" });
    });

    it("never trusts class claims in the wake payload or the copied context", async () => {
      const seed = await seedCompany(db);
      const owner = await seedPrincipal(db, seed, "628999000111@c.us", { owner: true });
      const ownerDelivery = await seedDelivery(db, seed, { principalId: owner.principalId, triggerClass: "owner" });
      const forged = await seedWake(db, seed, { actorType: "agent", actorId: seed.agentId, openwaClass: "owner", deliveryIds: [ownerDelivery] });
      await expect(resolve(seed, forged, {
        openwa: { triggerClass: "owner", deliveryIds: [ownerDelivery] },
        wardmoteOpenwa: { triggerClass: "owner", senderClass: "owner" },
        wardmoteToolProfile: "full",
      })).resolves.toMatchObject({ triggerClass: "other", senderClass: "non_owner" });
      const otherConversation = await seedWakeAction(db, seed, {
        openwa: { event: "message", triggerClass: "owner", deliveryIds: [ownerDelivery] }, conversationId: null,
      });
      await expect(resolve(seed, otherConversation)).resolves.toMatchObject({ triggerClass: "other", senderClass: "non_owner" });
    });

    it("resolves a grant run from an approved request with live grants of this chat and company", async () => {
      const seed = await seedCompany(db);
      const foreign = await seedCompany(db);
      const requester = await seedPrincipal(db, seed, CHAT_KEY);
      const live = await seedGrant(db, seed, { category: "create_task", requesterPrincipalId: requester.principalId });
      const expired = await seedGrant(db, seed, { category: "create_task", expiresAt: new Date(Date.now() - 1_000) });
      const otherChat = await seedGrant(db, seed, { category: "create_task", chatKey: "628999@c.us" });
      const foreignGrant = await seedGrant(db, foreign, { category: "create_task" });
      const wake = await seedWakeAction(db, seed, { openwa: { event: "approval_resolved", triggerClass: "grant", deliveryIds: [], approvalRequestId: live.requestId } });
      await expect(resolve(seed, wake, {
        wardmoteOpenwa: { grantIds: [expired.grantId, otherChat.grantId, foreignGrant.grantId] },
      })).resolves.toEqual(openwaContext(seed, {
        triggerClass: "grant", event: "approval_resolved", grantIds: [live.grantId], approvalRequestId: live.requestId,
        requesterPrincipalId: requester.principalId,
      }));
      for (const request of [expired, otherChat]) {
        const stale = await seedWakeAction(db, seed, { openwa: { event: "approval_resolved", deliveryIds: [], approvalRequestId: request.requestId } });
        await expect(resolve(seed, stale)).resolves.toMatchObject({ triggerClass: "other", grantIds: [] });
      }
      const pending = await seedGrant(db, seed, { category: "create_task", requestStatus: "pending" });
      const unapproved = await seedWakeAction(db, seed, { openwa: { event: "approval_resolved", deliveryIds: [], approvalRequestId: pending.requestId } });
      await expect(resolve(seed, unapproved)).resolves.toMatchObject({ triggerClass: "other", grantIds: [] });
    });

    it("drops requester grants when any delivery merged into the run belongs to another principal or cannot be verified", async () => {
      const seed = await seedCompany(db);
      const member = await seedPrincipal(db, seed, CHAT_KEY);
      const other = await seedPrincipal(db, seed, "628777000111@c.us");
      const owner = await seedPrincipal(db, seed, "628999000222@c.us", { owner: true });
      const own = await seedDelivery(db, seed, { principalId: member.principalId, triggerClass: "other" });
      const ownLater = await seedDelivery(db, seed, { principalId: member.principalId, triggerClass: "other" });
      const foreign = await seedDelivery(db, seed, { principalId: other.principalId, triggerClass: "other" });
      const ownerDelivery = await seedDelivery(db, seed, { principalId: owner.principalId, triggerClass: "owner" });
      const otherChat = await seedDelivery(db, seed, { principalId: member.principalId, triggerClass: "other", chatKey: "628555000999@c.us" });
      const grant = await seedGrant(db, seed, { category: "external_tools", scope: "requester", requesterPrincipalId: member.principalId });
      const wake = await seedWakeAction(db, seed, { openwa: { event: "message", triggerClass: "other", deliveryIds: [own] } });
      const granted = { requesterPrincipalId: member.principalId, grantIds: [grant.grantId] };
      const denied = { triggerClass: "other", senderClass: "non_owner", requesterPrincipalId: null, grantIds: [] };
      await expect(resolve(seed, wake)).resolves.toMatchObject(granted);
      await expect(resolve(seed, wake, { openwa: { deliveryIds: [own, ownLater] } })).resolves.toMatchObject(granted);
      await expect(resolve(seed, wake, { openwa: { deliveryIds: [own, ownerDelivery] } })).resolves.toMatchObject(granted);
      const foreignCompany = await seedCompany(db);
      const foreignCompanyDelivery = await seedDelivery(db, foreignCompany, { principalId: (await seedPrincipal(db, foreignCompany, CHAT_KEY)).principalId, triggerClass: "other" });
      for (const merged of [foreign, otherChat, randomUUID(), foreignCompanyDelivery]) {
        await expect(resolve(seed, wake, { openwa: { deliveryIds: [own, merged] } })).resolves.toMatchObject(denied);
        await expect(resolve(seed, wake, { wardmoteOpenwa: { deliveryIds: [merged] } })).resolves.toMatchObject(denied);
      }

      const runId = randomUUID();
      const coalesced = await seedWakeAction(db, seed, { openwa: { event: "message", triggerClass: "other", deliveryIds: [foreign] } });
      await db.update(agentWakeupRequests).set({ status: "coalesced", runId, payload: { issueId: seed.issueId } }).where(eq(agentWakeupRequests.id, coalesced));
      await expect(resolve(seed, wake, {}, runId)).resolves.toMatchObject(denied);
      await expect(resolve(seed, wake)).resolves.toMatchObject(granted);
      await db.update(agentWakeupRequests).set({ runId: null, payload: { issueId: seed.issueId, coalescedIntoWakeupRequestId: wake } }).where(eq(agentWakeupRequests.id, coalesced));
      await expect(resolve(seed, wake)).resolves.toMatchObject(denied);
      await db.update(agentWakeupRequests).set({ payload: { issueId: await seedPlainIssue(db, seed), coalescedIntoWakeupRequestId: wake } }).where(eq(agentWakeupRequests.id, coalesced));
      await expect(resolve(seed, wake)).resolves.toMatchObject(granted);
    });

    it("checks merged deliveries in the one delivery query it already made and leaves owner and grant runs unchanged", async () => {
      const seed = await seedCompany(db);
      const member = await seedPrincipal(db, seed, CHAT_KEY);
      const other = await seedPrincipal(db, seed, "628777000333@c.us");
      const owner = await seedPrincipal(db, seed, "628999000444@c.us", { owner: true });
      const own = await seedDelivery(db, seed, { principalId: member.principalId, triggerClass: "other" });
      const foreign = await seedDelivery(db, seed, { principalId: other.principalId, triggerClass: "other" });
      const ownerDelivery = await seedDelivery(db, seed, { principalId: owner.principalId, triggerClass: "owner" });
      const wake = await seedWakeAction(db, seed, { openwa: { event: "message", triggerClass: "other", deliveryIds: [own] } });
      await seedGrant(db, seed, { category: "external_tools", scope: "requester", requesterPrincipalId: member.principalId });
      const counted = loggedDb();
      const deliveryQueries = async (wakeupRequestId: string, contextSnapshot: Record<string, unknown>) => {
        const before = counted.queries.length;
        const resolved = await resolveOpenwaRunContext(counted.db, { companyId: seed.companyId, issueId: seed.issueId, runId: randomUUID(), contextSnapshot, wakeupRequestId });
        return { resolved, queries: counted.queries.slice(before).filter((query) => query.includes("chat_deliveries")).length };
      };
      expect((await deliveryQueries(wake, {})).queries).toBe(1);
      const merged = await deliveryQueries(wake, { openwa: { deliveryIds: [own, foreign] } });
      expect(merged).toMatchObject({ queries: 1, resolved: { requesterPrincipalId: null, grantIds: [] } });

      const ownerWake = await seedWakeAction(db, seed, { openwa: { event: "message", triggerClass: "owner", deliveryIds: [ownerDelivery] } });
      await expect(resolve(seed, ownerWake, { openwa: { deliveryIds: [ownerDelivery, foreign] } })).resolves.toMatchObject({
        triggerClass: "owner", senderClass: "owner", grantIds: [], requesterPrincipalId: null, triggerPrincipalId: owner.principalId,
      });
      const oneAction = await seedGrant(db, seed, { category: "external_tools", requesterPrincipalId: member.principalId });
      const grantWake = await seedWakeAction(db, seed, { openwa: { event: "approval_resolved", triggerClass: "grant", deliveryIds: [], approvalRequestId: oneAction.requestId } });
      const run = await seedRun(db, seed, {});
      await expect(resolve(seed, grantWake, { openwa: { deliveryIds: [foreign] } }, run.runId)).resolves.toMatchObject({
        triggerClass: "grant", requesterPrincipalId: member.principalId,
      });
    });

    it("leaves runs on non-OpenWA issues untouched and scopes the binding by company", async () => {
      const seed = await seedCompany(db);
      const telegram = await seedCompany(db, { openwa: false });
      const plainIssue = await seedPlainIssue(db, seed);
      const runId = randomUUID();
      await expect(resolveOpenwaRunContext(db, {
        companyId: seed.companyId, issueId: plainIssue, runId, contextSnapshot: {}, wakeupRequestId: null,
      })).resolves.toBeNull();
      await expect(resolveOpenwaRunContext(db, {
        companyId: telegram.companyId, issueId: telegram.issueId, runId, contextSnapshot: {}, wakeupRequestId: null,
      })).resolves.toBeNull();
      await expect(resolveOpenwaRunContext(db, {
        companyId: telegram.companyId, issueId: seed.issueId, runId, contextSnapshot: {}, wakeupRequestId: null,
      })).resolves.toBeNull();
      await expect(isOpenwaConversationIssue(db, telegram.companyId, seed.issueId)).resolves.toBe(false);
      await expect(isOpenwaConversationIssue(db, seed.companyId, seed.issueId)).resolves.toBe(true);
      const context: Record<string, unknown> = { wardmoteOpenwa: { triggerClass: "owner" } };
      applyOpenwaRunContext(context, null);
      expect(context).toEqual({ wardmoteToolProfile: "full" });
    });

    it("queries the binding of a non-OpenWA issue once across run starts and still resolves OpenWA issues", async () => {
      const seed = await seedCompany(db);
      const plainIssue = await seedPlainIssue(db, seed);
      const counted = loggedDb();
      const bindingQueries = async (issueId: string) => {
        const before = counted.queries.length;
        const resolved = await resolveOpenwaRunContext(counted.db, {
          companyId: seed.companyId, issueId, runId: randomUUID(), contextSnapshot: {}, wakeupRequestId: null,
        });
        return { resolved, queries: counted.queries.slice(before).filter((query) => query.includes('from "chat_conversations"')).length };
      };
      expect(await bindingQueries(plainIssue)).toEqual({ resolved: null, queries: 1 });
      expect(await bindingQueries(plainIssue)).toEqual({ resolved: null, queries: 0 });
      const openwa = await bindingQueries(seed.issueId);
      expect(openwa.resolved).toMatchObject({ endpointId: seed.endpointId, senderClass: "non_owner" });
    });
  });

  describe("task chat origin", () => {
    it("reads a task's chat origin from the handoff record and the creating run, nearest first and company scoped", async () => {
      const seed = await seedCompany(db);
      const member = await seedPrincipal(db, seed, CHAT_KEY);
      const delivery = await seedDelivery(db, seed, { principalId: member.principalId, triggerClass: "other" });
      const creator = await seedRun(db, seed, { openwa: openwaContext(seed, { deliveryIds: [delivery] }) });
      const child = randomUUID();
      const grandchild = randomUUID();
      await db.insert(issues).values([
        { id: child, companyId: seed.companyId, parentId: seed.issueId, title: "Asked by a member", status: "todo", originRunId: creator.runId },
        { id: grandchild, companyId: seed.companyId, parentId: child, title: "Split further", status: "todo" },
      ]);
      await db.insert(chatTaskHandoffs).values({
        taskId: child, companyId: seed.companyId, conversationId: seed.issueId, agentId: seed.agentId, sessionGeneration: 0, channel: "openwa", reportToOwner: false,
      });
      const [conversation] = await db.select({ identifier: issues.identifier }).from(issues).where(eq(issues.id, seed.issueId));
      const expected = { conversation: conversation!.identifier, requester: "non_owner", triggerClass: "other", requesterRole: "allowed" };
      await expect(openwaTaskChatOrigin(db, { companyId: seed.companyId, issueIds: [child, seed.issueId] })).resolves.toEqual(expected);
      await expect(openwaTaskChatOrigin(db, { companyId: seed.companyId, issueIds: [grandchild, child, seed.issueId] })).resolves.toEqual(expected);
      await expect(openwaTaskChatOrigin(db, { companyId: seed.companyId, issueIds: [seed.issueId] })).resolves.toBeNull();
      const foreign = await seedCompany(db);
      await expect(openwaTaskChatOrigin(db, { companyId: foreign.companyId, issueIds: [child] })).resolves.toBeNull();
    });

  });

  describe("JWT REST seam", () => {
    function app(
      handler: express.RequestHandler = (req, res) => { res.status(req.method === "POST" ? 201 : 200).json({ reached: true, actor: req.actor.type }); },
      database: ReturnType<typeof createDb> = db,
    ) {
      const server = express();
      server.use(express.json());
      server.use(actorMiddleware(database, { deploymentMode: "authenticated", resolveSession: async () => null }));
      server.all("/api/{*rest}", handler);
      server.use(errorHandler);
      return server;
    }
    function jwt(seed: Seed, runId: string) {
      return createLocalAgentJwt(seed.agentId, seed.companyId, "process", runId, BOARD_USER)!;
    }

    it("lets every run class mutate and audits each mutation with its sender class, never a safe read", async () => {
      const seed = await seedCompany(db);
      const member = await seedRun(db, seed, { openwa: openwaContext(seed, {}) });
      const owner = await seedRun(db, seed, { openwa: openwaContext(seed, { triggerClass: "owner", senderClass: "owner" }) });
      const unmarked = await seedRun(db, seed, {});
      const outside = await seedPlainIssue(db, seed);
      const auth = (runId: string) => ({ Authorization: "Bearer " + jwt(seed, runId) });
      const writes = [
        await request(app()).post("/api/companies/" + seed.companyId + "/issues").set(auth(member.runId)).send({ title: "x" }),
        await request(app()).delete("/api/issues/" + outside).set(auth(member.runId)).send(),
        await request(app()).post("/api/agents/me/secret-proposals").set(auth(member.runId)).send({}),
        await request(app()).patch("/api/issues/" + outside).set(auth(owner.runId)).send({ visibility: "private" }),
        await request(app()).post("/api/companies/" + seed.companyId + "/issues").set(auth(unmarked.runId)).send({ title: "y" }),
      ];
      expect(writes.map((res) => res.status)).toEqual([201, 200, 201, 200, 201]);
      expect((await request(app()).get("/api/companies/" + seed.companyId + "/issues").set(auth(member.runId))).status).toBe(200);
      let rows: Array<{ runId: string | null; metadata: Record<string, unknown> }> = [];
      for (let attempt = 0; attempt < 100 && rows.length < 4; attempt++) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, 20));
        rows = await db.select({ runId: chatAuditEntries.runId, metadata: chatAuditEntries.metadata }).from(chatAuditEntries)
          .where(and(eq(chatAuditEntries.endpointId, seed.endpointId), eq(chatAuditEntries.kind, "tool_called")));
      }
      expect(rows).toHaveLength(4);
      expect(rows).toEqual(expect.arrayContaining([
        { runId: member.runId, metadata: { seam: "rest", method: "POST", path: "/api/companies/" + seed.companyId + "/issues", senderClass: "non_owner", triggerClass: "other" } },
        { runId: member.runId, metadata: { seam: "rest", method: "DELETE", path: "/api/issues/" + outside, senderClass: "non_owner", triggerClass: "other" } },
        { runId: member.runId, metadata: { seam: "rest", method: "POST", path: "/api/agents/me/secret-proposals", senderClass: "non_owner", triggerClass: "other" } },
        { runId: owner.runId, metadata: { seam: "rest", method: "PATCH", path: "/api/issues/" + outside, senderClass: "owner", triggerClass: "owner" } },
      ]));
    });

    it("allows full runs and runs on non-OpenWA issues", async () => {
      const seed = await seedCompany(db);
      const full = await seedRun(db, seed, { openwa: openwaContext(seed, { triggerClass: "owner", senderClass: "owner" }) });
      const fullRes = await request(app()).post(`/api/companies/${seed.companyId}/issues`).set("Authorization", `Bearer ${jwt(seed, full.runId)}`).send({ title: "x" });
      expect(fullRes.status).toBe(201);
      const plain = await seedRun(db, seed, { issueId: await seedPlainIssue(db, seed) });
      const plainRes = await request(app()).post(`/api/companies/${seed.companyId}/issues`).set("Authorization", `Bearer ${jwt(seed, plain.runId)}`).send({ title: "x" });
      expect(plainRes.status).toBe(201);
    });

    it("adds no database query to the JWT path of a run without OpenWA context", async () => {
      const seed = await seedCompany(db);
      const plainIssue = await seedPlainIssue(db, seed);
      const marked = await seedRun(db, seed, { issueId: plainIssue });
      const unmarked = await seedRun(db, seed, { issueId: await seedPlainIssue(db, seed) });
      const counted = loggedDb();
      const server = app(undefined, counted.db);
      const measure = async (runId: string, method: "get" | "post") => {
        const before = counted.queries.length;
        const res = await request(server)[method](`/api/companies/${seed.companyId}/routines`).set("Authorization", `Bearer ${jwt(seed, runId)}`).send({});
        expect(res.status).toBeLessThan(300);
        return counted.queries.slice(before);
      };
      await measure(marked.runId, "get");
      const read = await measure(marked.runId, "get");
      const write = await measure(marked.runId, "post");
      expect(write).toEqual(read);
      const conversationRun = await seedRun(db, seed, {});
      expect(await measure(unmarked.runId, "post")).toEqual(read);
      expect(await measure(conversationRun.runId, "post")).toEqual(read);
    });
  });

  describe("persistent agent key seam", () => {
    function app(database: ReturnType<typeof createDb> = db) {
      const server = express();
      server.use(express.json());
      server.use(actorMiddleware(database, { deploymentMode: "authenticated", resolveSession: async () => null }));
      server.all("/api/{*rest}", (req, res) => res.json({ reached: true, actor: req.actor.type }));
      server.use(errorHandler);
      return server;
    }
    async function key(seed: Seed) {
      const token = `pcp_${randomUUID()}`;
      await db.insert(agentApiKeys).values({
        agentId: seed.agentId, companyId: seed.companyId, name: "persistent",
        keyHash: createHash("sha256").update(token).digest("hex"), responsibleUserId: BOARD_USER,
      });
      return token;
    }

    it("denies every non-safe method for an agent bound to a live OpenWA endpoint", async () => {
      const seed = await seedCompany(db);
      const token = await key(seed);
      for (const method of ["post", "patch", "put", "delete"] as const) {
        const res = await request(app())[method](`/api/issues/${seed.issueId}/comments`).set("Authorization", `Bearer ${token}`).send({});
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ code: "openwa_agent_key_read_only" });
      }
      const read = await request(app()).get(`/api/issues/${seed.issueId}`).set("Authorization", `Bearer ${token}`);
      expect(read.status).toBe(200);
    });

    it("ends a run without OpenWA context with one run lookup and no chat_actions scan", async () => {
      const telegram = await seedCompany(db, { openwa: false });
      const { runId } = await seedRun(db, telegram, {});
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
      const counted = loggedDb();
      await expect(scheduleOpenwaFollowupForRun(counted.db, { companyId: telegram.companyId, runId })).resolves.toEqual([]);
      expect(counted.queries).toHaveLength(1);
      expect(counted.queries.some((query) => query.includes('from "chat_actions"'))).toBe(false);
    });

    it("caches the unbound answer: a second mutation of an agent without OpenWA issues no chat_endpoints query", async () => {
      const telegram = await seedCompany(db, { openwa: false });
      const token = await key(telegram);
      const counted = loggedDb();
      const server = app(counted.db);
      const endpointQueries = async () => {
        const before = counted.queries.length;
        const res = await request(server).post("/api/x").set("Authorization", `Bearer ${token}`).send({});
        expect(res.status).toBe(200);
        return counted.queries.slice(before).filter((query) => query.includes('from "chat_endpoints"')).length;
      };
      expect(await endpointQueries()).toBe(1);
      expect(await endpointQueries()).toBe(0);
    });

    it("turns a key read-only as soon as its agent gets an OpenWA endpoint through the service", async () => {
      const telegram = await seedCompany(db, { openwa: false });
      const token = await key(telegram);
      const before = await request(app()).post("/api/x").set("Authorization", `Bearer ${token}`).send({});
      expect(before.status).toBe(200);
      const service = chatChannelService(db, {
        runtime: new ChatSdkRuntime(),
        publicBaseUrl: "https://wardmote.example",
        heartbeat: { wakeup: async () => ({ accepted: true }) } as never,
        discordGatewayLeaseTtlMs: 120_000,
        discordGatewayLeaseRenewalIntervalMs: 60_000,
        discordGatewayLeaseWaitMs: 200,
      });
      try {
        await service.create(telegram.companyId, { provider: "openwa", assignedAgentId: telegram.agentId } as never, BOARD_USER);
      } finally {
        await service.shutdown();
      }
      const after = await request(app()).post("/api/x").set("Authorization", `Bearer ${token}`).send({});
      expect(after.status).toBe(403);
      expect(after.body).toMatchObject({ code: "openwa_agent_key_read_only" });
    });

    it("allows keys of agents without a live OpenWA endpoint, including other companies", async () => {
      const telegram = await seedCompany(db, { openwa: false });
      const res = await request(app()).post(`/api/issues/${telegram.issueId}/comments`).set("Authorization", `Bearer ${await key(telegram)}`).send({});
      expect(res.status).toBe(200);
      const archived = await seedCompany(db);
      await db.update(chatEndpoints).set({ status: "archived" }).where(eq(chatEndpoints.id, archived.endpointId));
      const archivedRes = await request(app()).post("/api/x").set("Authorization", `Bearer ${await key(archived)}`).send({});
      expect(archivedRes.status).toBe(200);
    });
  });

  describe("GitHub credential export and connection_request seam", () => {
    function app() {
      const server = express();
      server.use(express.json());
      server.use(runtimeConnectionIntentRoutes(db));
      server.use(errorHandler);
      return server;
    }

    it("reaches the GitHub credential resolver in member and owner runs", async () => {
      const seed = await seedCompany(db);
      const readOnly = await seedRun(db, seed, { openwa: openwaContext(seed, {}) });
      const denied = await request(app()).post("/runtime-tools/github/credentials").set(
        "x-wardmote-github-capability",
        createRuntimeToolsToken({ agentId: seed.agentId, companyId: seed.companyId, runId: readOnly.runId, responsibleUserId: BOARD_USER, scope: "github_credentials" })!.token,
      ).send({});
      expect(denied.body.code).not.toBe("openwa_approval_required");
      expect(denied.body.error).toBe("This run predates managed GitHub credentials");
      const full = await seedRun(db, seed, { openwa: openwaContext(seed, { triggerClass: "owner", senderClass: "owner" }) });
      const reached = await request(app()).post("/runtime-tools/github/credentials").set(
        "x-wardmote-github-capability",
        createRuntimeToolsToken({ agentId: seed.agentId, companyId: seed.companyId, runId: full.runId, responsibleUserId: BOARD_USER, scope: "github_credentials" })!.token,
      ).send({});
      expect(reached.body.code).not.toBe("openwa_approval_required");
      expect(reached.body.error).toBe("This run predates managed GitHub credentials");
    });

    it("adds no heartbeat_runs read of its own to a GitHub credential export", async () => {
      const seed = await seedCompany(db);
      const full = await seedRun(db, seed, { openwa: openwaContext(seed, { triggerClass: "owner", senderClass: "owner" }) });
      const counted = loggedDb();
      const server = express();
      server.use(express.json());
      server.use(runtimeConnectionIntentRoutes(counted.db));
      server.use(errorHandler);
      const before = counted.queries.length;
      await request(server).post("/runtime-tools/github/credentials").set(
        "x-wardmote-github-capability",
        createRuntimeToolsToken({ agentId: seed.agentId, companyId: seed.companyId, runId: full.runId, responsibleUserId: BOARD_USER, scope: "github_credentials" })!.token,
      ).send({});
      expect(counted.queries.slice(before).filter((query) => query.includes('from "heartbeat_runs"')).length).toBe(2);
    });

    it("lets a member run request a connection without owner approval", async () => {
      const seed = await seedCompany(db);
      const service = connectionIntentService(db);
      const member = await seedRun(db, seed, { openwa: openwaContext(seed, {}) });
      const claims = { sub: seed.agentId, company_id: seed.companyId, run_id: member.runId, responsible_user_id: BOARD_USER };
      const outcome = await service.request(claims, "github").catch((err: { details?: { code?: string } }) => err);
      expect(outcome?.details?.code).not.toBe("openwa_approval_required");
    });
  });

  describe("native runner tool seam", () => {
    function authority(seed: Seed, runId: string) {
      return new WardmoteRunnerToolAuthority(db, {
        companyId: seed.companyId, agentId: seed.agentId, issueId: seed.issueId, runId, workMode: "standard",
        enqueueWakeup: async () => null,
      });
    }
    const createTask = (key: string) => ({ tool: "create_task", callId: key, arguments: { idempotencyKey: key, title: `Child ${key}` } });

    it("lets a member run create and reassign tasks like an owner run", async () => {
      const seed = await seedCompany(db);
      const member = await seedRun(db, seed, { openwa: openwaContext(seed, {}), native: true });
      await expect(authority(seed, member.runId).execute(createTask("member-1"))).resolves.toMatchObject({
        disposition: "applied", task: { parentId: seed.issueId },
      });
    });
  });

  describe("project tool write seam", () => {
    const actor = (seed: Seed, runId: string) => ({
      type: "agent" as const, source: "agent_jwt" as const, agentId: seed.agentId, companyId: seed.companyId, runId,
    });

    it("allows project creation context in member and owner runs", async () => {
      const seed = await seedCompany(db);
      for (const openwa of [openwaContext(seed, {}), openwaContext(seed, { triggerClass: "owner", senderClass: "owner" })]) {
        const run = await seedRun(db, seed, { openwa });
        await expect(projectToolContext(db, actor(seed, run.runId), true)).resolves.toMatchObject({ issue: { id: seed.issueId } });
      }
    });
  });

  describe("tool gateway policy seam", () => {
    async function gatewayFor(seed: Seed, runId: string) {
      await db.insert(toolPolicies).values({
        companyId: seed.companyId, name: "Review note writes", policyType: "require_approval",
        selectors: { toolName: "mcp-remote-fixture:update_note" },
      });
      const gateway = createToolGatewayService(db, { toolActionSigningSecret: "openwa-authority-signing" });
      const session = await gateway.createSession({ companyId: seed.companyId, agentId: seed.agentId, runId });
      return { gateway, session };
    }

    it("applies the normal policy decision to member and owner runs alike", async () => {
      const seed = await seedCompany(db);
      for (const openwa of [openwaContext(seed, {}), openwaContext(seed, { triggerClass: "owner", senderClass: "owner" })]) {
        const run = await seedRun(db, seed, { openwa });
        const { gateway, session } = await gatewayFor(seed, run.runId);
        await expect(gateway.executeTool({
          sessionToken: session.token, tool: "mcp-remote-fixture:update_note", parameters: { noteId: "n1", body: "x" },
        })).rejects.toMatchObject({ reasonCode: "approval_required" });
        await db.delete(toolPolicies).where(eq(toolPolicies.companyId, seed.companyId));
      }
    });

    it("adds no heartbeat_runs read per write-tool call for a non-OpenWA run", async () => {
      const seed = await seedCompany(db);
      const run = await seedRun(db, seed, { issueId: await seedPlainIssue(db, seed), senderClass: "owner" });
      await db.insert(toolPolicies).values({
        companyId: seed.companyId, name: "Review note writes", policyType: "require_approval",
        selectors: { toolName: "mcp-remote-fixture:update_note" },
      });
      const counted = loggedDb();
      const gateway = createToolGatewayService(counted.db, { toolActionSigningSecret: "openwa-authority-signing" });
      const session = await gateway.createSession({ companyId: seed.companyId, agentId: seed.agentId, runId: run.runId });
      const call = async (tool: string, parameters: Record<string, unknown>) => {
        const before = counted.queries.length;
        await gateway.executeTool({ sessionToken: session.token, tool, parameters }).catch(() => null);
        return counted.queries.slice(before).filter((query) =>
          query.includes("'wardmoteOpenwa'") || query.includes('"chat_owner_grants"') || query.includes('"chat_conversations"."is_direct_message", "chat_endpoints"')).length;
      };
      await call("mcp-remote-fixture:echo", { message: "warm" });
      const read = await call("mcp-remote-fixture:echo", { message: "read" });
      const write = await call("mcp-remote-fixture:update_note", { noteId: "n1", body: "x" });
      expect(read).toBe(1);
      expect(write).toBe(read);
    });
  });

});
