import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  authUsers,
  chatActions,
  chatAuditEntries,
  chatDeliveries,
  chatEndpointResources,
  chatEndpoints,
  chatOutboundMessages,
  companies,
  companyMemberships,
  companySecretBindings,
  createDb,
  toolConnections,
  type Db,
} from "@tickernelz/wardmote-db";
import { startEmbeddedPostgresTestDatabase } from "../helpers/embedded-postgres.js";
import { chatChannelService, type ChatChannelService, type ChatChannelServiceOptions } from "../../services/chat-channels.js";
import { ChatSdkRuntime } from "../../services/chat-sdk-runtime.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { secretService } from "../../services/secrets.js";
import { OPENWA_SESSION_HEALTH_WAKE_ACTION_KIND } from "../../services/openwa/session-health.js";
import { FAKE_OPENWA_KEY, FakeOpenwaGateway } from "./fake-gateway.js";

const SESSION_ID = "61111111-2222-4333-8444-555555555566";
const OLD_PHONE = "628111000611";
const NEW_PHONE = "628111000622";
const OWNER_PHONE = "628333000611";
const MEMBER_PHONE = "628444000611";
const INVITED = "120363000000000611@g.us";
const NOT_INVITED = "120363000000000622@g.us";
const jid = (phone: string) => phone + "@c.us";

type WakeupOptions = Parameters<ChatChannelServiceOptions["heartbeat"]["wakeup"]>[1];

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("OpenWA session relinked to another number (embedded Postgres + fake gateway)", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let scratch: string;
  const oldKey = process.env.WARDMOTE_SECRETS_MASTER_KEY_FILE;
  const services: ChatChannelService[] = [];
  const gateways: FakeOpenwaGateway[] = [];
  const endpointIds: string[] = [];

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("wardmote-openwa-number-");
    db = createDb(database.connectionString);
    scratch = await mkdtemp(path.join(tmpdir(), "openwa-number-"));
    process.env.WARDMOTE_SECRETS_MASTER_KEY_FILE = path.join(scratch, "master.key");
    await instanceSettingsService(db).updateExperimental({ enableChatConnectors: true });
  }, 60_000);
  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.shutdown()));
    await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
    for (const id of endpointIds.splice(0)) await db.update(chatEndpoints).set({ status: "archived" }).where(eq(chatEndpoints.id, id));
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await database?.cleanup();
    if (scratch) await rm(scratch, { recursive: true, force: true });
    if (oldKey === undefined) delete process.env.WARDMOTE_SECRETS_MASTER_KEY_FILE;
    else process.env.WARDMOTE_SECRETS_MASTER_KEY_FILE = oldKey;
  });

  async function setup(options: { linkedPhone?: string; beforeStart?: (input: { companyId: string; agentId: string; userId: string; service: ChatChannelService }) => Promise<void> } = {}) {
    const gateway = new FakeOpenwaGateway({ sessionId: SESSION_ID, ownPhone: options.linkedPhone ?? OLD_PHONE });
    await gateway.start();
    gateways.push(gateway);
    const companyId = randomUUID();
    const agentId = randomUUID();
    const userId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "OpenWA number",
      issuePrefix: "N" + companyId.replaceAll("-", "").slice(0, 7).toUpperCase(),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "OpenWA Agent",
      role: "engineer",
      status: "idle",
      adapterType: "wardmote_runner",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(authUsers).values({ id: userId, name: "Owner", email: userId + "@example.com", emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "operator" });
    const wakes = new Map<string, WakeupOptions>();
    const wakeup = vi.fn<ChatChannelServiceOptions["heartbeat"]["wakeup"]>(async (wakeAgentId, opts) => {
      const durable = opts.durableChatRequest;
      if (!durable) return { accepted: true } as never;
      await db.transaction(async (tx) => {
        await durable.authorize(tx as unknown as Parameters<typeof durable.authorize>[0]);
        await tx
          .insert(agentWakeupRequests)
          .values({
            id: durable.id,
            companyId: durable.companyId,
            agentId: wakeAgentId,
            source: opts.source ?? "assignment",
            triggerDetail: opts.triggerDetail,
            reason: opts.reason,
            payload: opts.payload,
            requestedByActorType: opts.requestedByActorType,
            requestedByActorId: opts.requestedByActorId,
            idempotencyKey: durable.idempotencyKey,
            requestedAt: durable.requestedAt,
            status: "queued",
          })
          .onConflictDoNothing();
      });
      wakes.set(durable.id, opts);
      return { accepted: true } as never;
    });
    const service = chatChannelService(db, {
      runtime: new ChatSdkRuntime(),
      publicBaseUrl: "https://wardmote.example",
      heartbeat: { wakeup } as never,
      scheduleDeferredWork: () => {},
      discordGatewayLeaseTtlMs: 120_000,
      discordGatewayLeaseRenewalIntervalMs: 60_000,
      discordGatewayLeaseWaitMs: 200,
      openwaBurstWindowMs: 0,
    });
    services.push(service);
    const endpoint = await service.create(companyId, { provider: "openwa", assignedAgentId: agentId } as never, userId);
    endpointIds.push(endpoint.id);
    const secret = await secretService(db).create(
      companyId,
      { name: "openwa-key-" + endpoint.id.slice(0, 8), provider: "local_encrypted", managedMode: "wardmote_managed", value: FAKE_OPENWA_KEY },
      { userId },
    );
    const [row] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, endpoint.id));
    await db
      .update(toolConnections)
      .set({
        status: "active",
        enabled: true,
        credentialSecretRefs: [
          { secretId: secret.id, versionSelector: "latest", configPath: "credentials.apiKey", required: true, label: "apiKey", projectionClass: "unclassified" },
        ],
      })
      .where(eq(toolConnections.id, row!.connectionId));
    await db.insert(companySecretBindings).values({
      companyId,
      secretId: secret.id,
      targetType: "tool_connection",
      targetId: row!.connectionId,
      configPath: "credentials.apiKey",
      versionSelector: "latest",
      required: true,
      label: "apiKey",
      projectionClass: "unclassified",
    });
    await db
      .update(chatEndpoints)
      .set({
        status: "active",
        providerAccountId: gateway.baseUrl + "#" + SESSION_ID,
        botExternalId: OLD_PHONE,
        setup: { step: "complete", testStartedAt: new Date(Date.now() - 60_000).toISOString() },
      })
      .where(eq(chatEndpoints.id, endpoint.id));
    const added = await service.openwa.addOwner(endpoint.id, { e164: "+" + OWNER_PHONE, expiresInSeconds: 1_800 }, userId);
    const token = new URL(added.confirmationUrl!, "https://wardmote.example").searchParams.get("token")!;
    await service.confirmIdentityLink(token, userId);
    await options.beforeStart?.({ companyId, agentId, userId, service });
    expect((await service.reconcileProviderRuntimes()).local).toBe(1);
    if (!options.linkedPhone) await gateway.waitForFirstCatchUp();
    return { gateway, companyId, agentId, userId, endpointId: endpoint.id, service, wakes };
  }

  type Setup = Awaited<ReturnType<typeof setup>>;

  async function endpointRow(t: Setup) {
    return (await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, t.endpointId)))[0]!;
  }

  async function audits(t: Setup, kind: "bot_number_changed" | "group_left" | "trigger_admitted") {
    return db
      .select()
      .from(chatAuditEntries)
      .where(and(eq(chatAuditEntries.endpointId, t.endpointId), eq(chatAuditEntries.kind, kind)))
      .orderBy(asc(chatAuditEntries.occurredAt));
  }

  async function group(t: Setup, chatKey: string) {
    return (await db.select().from(chatEndpointResources).where(and(eq(chatEndpointResources.endpointId, t.endpointId), eq(chatEndpointResources.providerResourceId, "openwa:" + SESSION_ID + ":" + chatKey))))[0];
  }

  async function ownerConversation(t: Setup) {
    t.gateway.inbound({ chatId: jid(OWNER_PHONE), body: "halo" });
    let swept = Date.now();
    await until(async () => {
      if (Date.now() - swept > 1_000) {
        swept = Date.now();
        await t.service.processPendingDeliveries();
      }
      const rows = await db.select().from(chatDeliveries).where(eq(chatDeliveries.endpointId, t.endpointId));
      return rows.length > 0 && rows.every((entry) => entry.state === "processed");
    }, 30_000);
  }

  async function joinGroups(t: Setup) {
    t.gateway.groups.set(INVITED, { id: INVITED, name: "Invited group", participants: [{ id: jid(OLD_PHONE) }, { id: jid(OWNER_PHONE) }, { id: jid(MEMBER_PHONE) }] });
    t.gateway.groups.set(NOT_INVITED, { id: NOT_INVITED, name: "Retired group", participants: [{ id: jid(OLD_PHONE) }, { id: jid(OWNER_PHONE) }] });
    for (const chatKey of [INVITED, NOT_INVITED])
      t.gateway.emit("group.join", { groupId: chatKey, actorId: jid(OWNER_PHONE), participantIds: [jid(OLD_PHONE)], timestamp: Math.floor(Date.now() / 1000) });
    await until(async () => Boolean((await group(t, INVITED))?.enabled && (await group(t, NOT_INVITED))?.enabled));
  }

  function relink(t: Setup) {
    t.gateway.ownJid = jid(NEW_PHONE);
    t.gateway.groups.set(INVITED, { id: INVITED, name: "Invited group", participants: [{ id: jid(NEW_PHONE) }, { id: jid(OWNER_PHONE) }, { id: jid(MEMBER_PHONE) }] });
    t.gateway.groups.set(NOT_INVITED, { id: NOT_INVITED, name: "", participants: [] });
  }

  async function numberNotices(t: Setup) {
    const actions = await db
      .select()
      .from(chatActions)
      .where(and(eq(chatActions.endpointId, t.endpointId), eq(chatActions.kind, OPENWA_SESSION_HEALTH_WAKE_ACTION_KIND)));
    return actions.filter((action) => (action.payload as { openwa?: { sessionHealth?: { kind?: string } } }).openwa?.sessionHealth?.kind === "number_changed");
  }

  it("adopts a relinked number on the same endpoint, recounts groups and notifies the owner once", async () => {
    const t = await setup();
    await ownerConversation(t);
    await joinGroups(t);
    const before = await endpointRow(t);
    relink(t);
    t.gateway.emit("session.status", { sessionId: SESSION_ID, status: "qr" });
    t.gateway.emit("session.status", { sessionId: SESSION_ID, status: "ready" });
    await until(async () => (await endpointRow(t)).botExternalId === NEW_PHONE);
    const adopted = await endpointRow(t);
    expect(adopted).toMatchObject({ id: before.id, status: "active", assignedAgentId: before.assignedAgentId, policyRevision: before.policyRevision, connectionId: before.connectionId });
    expect(adopted.setup.openwaNumber).toMatchObject({ previous: [{ number: OLD_PHONE }], noticePending: true });
    expect((await audits(t, "bot_number_changed"))[0]!.metadata).toMatchObject({ outcome: "adopted", previous: "+62xxx...0611", current: "+62xxx...0622" });
    expect(JSON.stringify((await audits(t, "bot_number_changed"))[0]!.metadata)).not.toContain(NEW_PHONE);

    await t.service.reconcileProviderRuntimes();
    await until(async () => (await endpointRow(t)).setup.openwaNumber?.noticePending === false);
    expect(await group(t, INVITED)).toMatchObject({ enabled: true, availability: "available", label: "Invited group" });
    expect(await group(t, NOT_INVITED)).toMatchObject({ enabled: true, availability: "unavailable", label: "Retired group" });
    expect((await group(t, NOT_INVITED))!.metadata).toMatchObject({ numberNotInvited: true, groupName: "Retired group" });
    const notices = await numberNotices(t);
    expect(notices).toHaveLength(1);
    expect((notices[0]!.payload as { openwa: { sessionHealth: unknown } }).openwa.sessionHealth).toMatchObject({
      kind: "number_changed",
      numberChange: { previous: "+62xxx...0611", current: "+62xxx...0622", activeGroups: 1, notInvitedGroups: ["Retired group"] },
    });

    await t.service.reconcileProviderRuntimes();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await numberNotices(t)).toHaveLength(1);
  });

  it("keeps a group active when the old number leaves it, before and after the adoption", async () => {
    const t = await setup();
    await joinGroups(t);
    relink(t);
    t.gateway.emit("group.leave", { groupId: INVITED, actorId: jid(OWNER_PHONE), participantIds: [jid(OLD_PHONE)], timestamp: Math.floor(Date.now() / 1000) });
    await until(async () => (await endpointRow(t)).botExternalId === NEW_PHONE);
    await t.service.reconcileProviderRuntimes();
    await until(async () => (await endpointRow(t)).setup.openwaNumber?.noticePending === false);
    t.gateway.emit("group.leave", { groupId: INVITED, actorId: jid(OWNER_PHONE), participantIds: [jid(OLD_PHONE)], timestamp: Math.floor(Date.now() / 1000) });
    t.gateway.emit("group.leave", { groupId: NOT_INVITED, actorId: jid(OWNER_PHONE), participantIds: [jid(OLD_PHONE)], timestamp: Math.floor(Date.now() / 1000) });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await audits(t, "group_left")).toHaveLength(0);
    expect(await group(t, INVITED)).toMatchObject({ enabled: true, availability: "available" });
    expect(await group(t, NOT_INVITED)).toMatchObject({ enabled: true, label: "Retired group" });
  });

  it("adopts the number at startup when the session was relinked while Wardmote was down", async () => {
    const t = await setup({ linkedPhone: NEW_PHONE });
    await until(async () => (await endpointRow(t)).botExternalId === NEW_PHONE, 10_000);
    expect((await endpointRow(t)).setup.openwaNumber).toMatchObject({ previous: [{ number: OLD_PHONE }] });
    expect((await audits(t, "bot_number_changed"))[0]!.metadata).toMatchObject({ outcome: "adopted" });
  });

  it("counts a reply to a message the old number sent as reply_to_agent", async () => {
    const t = await setup();
    await joinGroups(t);
    await db.insert(chatOutboundMessages).values({
      companyId: t.companyId,
      endpointId: t.endpointId,
      chatKey: INVITED,
      source: "tool",
      state: "sent",
      bodyHash: "hash",
      clientNonce: randomUUID(),
      providerMessageId: "true_" + INVITED + "_3EB0OLDMESSAGE01_" + jid(OLD_PHONE),
      sentAt: new Date(),
    });
    await db
      .update(chatEndpointResources)
      .set({ settings: { triggers: { allMessages: false, replyToAgent: true } } })
      .where(eq(chatEndpointResources.providerResourceId, "openwa:" + SESSION_ID + ":" + INVITED));
    relink(t);
    t.gateway.emit("session.status", { sessionId: SESSION_ID, status: "qr" });
    t.gateway.emit("session.status", { sessionId: SESSION_ID, status: "ready" });
    await until(async () => (await endpointRow(t)).botExternalId === NEW_PHONE);
    await t.service.reconcileProviderRuntimes();
    await until(async () => (await endpointRow(t)).setup.openwaNumber?.noticePending === false);
    t.gateway.inbound({
      chatId: INVITED,
      from: INVITED,
      author: jid(MEMBER_PHONE),
      body: "setuju",
      extra: { quotedMsg: { id: "false_" + INVITED + "_3EB0OLDMESSAGE01_" + jid(OLD_PHONE), body: "old answer" } },
    });
    let swept = 0;
    await until(async () => {
      if (Date.now() - swept > 1_000) {
        swept = Date.now();
        await t.service.processPendingDeliveries();
      }
      return (await audits(t, "trigger_admitted")).some((entry) => entry.chatKey === INVITED);
    }, 30_000);
    const admitted = (await audits(t, "trigger_admitted")).find((entry) => entry.chatKey === INVITED)!;
    expect((admitted.metadata as { rules?: string[] }).rules).toContain("reply_to_agent");
  });

  it("holds the endpoint in attention when another active channel already uses the new number", async () => {
    let otherId = "";
    const t = await setup({
      beforeStart: async ({ companyId, agentId, userId, service }) => {
        const other = await service.create(companyId, { provider: "openwa", assignedAgentId: agentId } as never, userId);
        otherId = other.id;
        endpointIds.push(other.id);
        await db.update(chatEndpoints).set({ botExternalId: NEW_PHONE, providerAccountId: "http://127.0.0.1:1#other" }).where(eq(chatEndpoints.id, other.id));
      },
    });
    relink(t);
    t.gateway.emit("session.status", { sessionId: SESSION_ID, status: "qr" });
    t.gateway.emit("session.status", { sessionId: SESSION_ID, status: "ready" });
    await until(async () => (await endpointRow(t)).status === "attention");
    const held = await endpointRow(t);
    expect(held.botExternalId).toBe(OLD_PHONE);
    expect(held.lastError).toMatch(/^OpenWA number: this OpenWA session is now linked to \+62xxx\.\.\.0622, which another Wardmote channel already uses/);
    expect((await audits(t, "bot_number_changed"))[0]!.metadata).toMatchObject({ outcome: "conflict", conflictingEndpointId: otherId });
  });
});
