import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  approvals,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
  toolAccessAuditEvents,
  toolActionRequests,
  toolInvocations,
  toolPolicies,
  toolProfileBindings,
  toolProfiles,
} from "@tickernelz/wardmote-db";
import { googleWorkspaceScopesFor } from "@tickernelz/wardmote-shared";
import { toolAccessService } from "../services/tool-access.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { registerAssignedMcpGateway } from "../services/native-runtime/assigned-mcp-tools.js";
import { resolveConnectorAssignments } from "../services/connector-runtime.js";
import { createFakeGoogle } from "./helpers/fake-google.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const actor = { actorType: "user" as const, actorId: "google-reviewer" };
const redirectUri = "https://wardmote.example.test/api/tools/oauth/callback";

(support.supported ? describe : describe.skip)("Google Workspace through the tool gateway", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("wardmote-google-workspace-");
    db = createDb(temp.connectionString);
  }, 30000);
  afterAll(async () => {
    await temp?.cleanup();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Google fixture", issuePrefix: `GW${randomUUID().slice(0, 6)}` }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: actor.actorId, membershipRole: "admin", status: "active" });
    const google = createFakeGoogle();
    const scopes = googleWorkspaceScopesFor({ gmail: "delete_share" });
    const revoked: string[] = [];
    let revokeStatus = 200;
    const handle = async (url: string, init: RequestInit = {}): Promise<Response> => {
      const href = String(url);
      if (href.startsWith("https://accounts.google.com/.well-known/openid-configuration")) {
        return Response.json({
          issuer: "https://accounts.google.com",
          authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
          token_endpoint: "https://oauth2.googleapis.com/token",
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
        });
      }
      if (href === "https://oauth2.googleapis.com/revoke") {
        revoked.push(String(init.body ?? ""));
        return new Response("", { status: revokeStatus });
      }
      if (href === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: google.token, refresh_token: "refresh-fixture", expires_in: 3600, token_type: "Bearer", scope: scopes.join(" ") });
      }
      return google.fetch(href, init);
    };
    const request = vi.fn(handle);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => handle(String(url instanceof Request ? url.url : url), init ?? {}));
    const access = toolAccessService(db, { remoteHttpRequest: request, remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }] });
    const connected = await access.connectGalleryApp(company.id, {
      galleryKey: "google-workspace",
      connectionMethodKey: "customer-oauth",
      name: "Google Workspace",
      oauthClient: { clientId: "123456789012-fixture.apps.googleusercontent.com", clientSecret: "fixture-secret" },
      googleWorkspace: { capabilities: { gmail: "delete_share" }, domain: "example.com" },
    }, actor);
    const started = await access.startOAuth(company.id, connected.connectionId, { redirectUri, actor });
    await access.completeOAuthCallback({ state: new URL(started.authorizationUrl).searchParams.get("state")!, code: "fixture-code", redirectUri, actor });
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Google agent", role: "engineer", adapterType: "process", adapterConfig: {} }).returning();
    const catalog = await access.listCatalog(connected.connectionId, company.id);
    await access.finishGalleryAppConnection(company.id, connected.connectionId, {
      enabledCatalogEntryIds: catalog.map((entry) => entry.id),
      askFirstCatalogEntryIds: [],
      access: { agentIds: [agent.id] },
    }, actor);
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Send the report", assigneeAgentId: agent.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, invocationSource: "on_demand", status: "running", responsibleUserId: actor.actorId, contextSnapshot: { issueId: issue.id } }).returning();
    const [profile] = await db.insert(toolProfiles).values({ companyId: company.id, name: "Google tools", profileKey: randomUUID(), defaultAction: "allow" }).returning();
    await db.insert(toolProfileBindings).values({ companyId: company.id, profileId: profile.id, targetType: "agent", targetId: agent.id });
    const gateway = createToolGatewayService(db, { remoteHttpRequest: request, toolActionSigningSecret: "google-fixture-signing-secret" });
    registerAssignedMcpGateway(db, gateway);
    const session = await gateway.createSession({ companyId: company.id, agentId: agent.id, runId: run.id });
    const tools = await gateway.listToolsForSession(session.token);
    const call = tools.find((tool) => tool.upstreamToolName === "google_call");
    return {
      company, google, gateway, session, call, tools, access, connectionId: connected.connectionId, revoked,
      failRevoke: (status: number) => { revokeStatus = status; },
      binding: { companyId: company.id, agentId: agent.id, runId: run.id, issueId: issue.id },
    };
  }

  async function approvePending(f: Awaited<ReturnType<typeof fixture>>) {
    const pending = (await db.select().from(toolActionRequests).where(eq(toolActionRequests.companyId, f.company.id))).find((row) => row.status === "pending");
    expect(pending).toBeDefined();
    if (pending!.approvalId) {
      await db.update(approvals).set({ status: "approved", decidedByUserId: actor.actorId, decidedAt: new Date() }).where(eq(approvals.id, pending!.approvalId));
    }
    return f.gateway.approveActionRequest({ companyId: f.company.id, actionRequestId: pending!.id, actor: { userId: actor.actorId } });
  }

  it("shows Google's outside recipients on a card a tool policy asked for, and runs it once approved", async () => {
    const f = await fixture();
    await db.insert(toolPolicies).values({ companyId: f.company.id, name: "Review Google calls", policyType: "require_approval", selectors: {}, priority: 10 });
    let sent = 0;
    f.google.override(/\/gmail\/v1\/users\/me\/drafts\/d2\?/, () => Response.json({ id: "d2", message: { payload: { headers: [{ name: "To", value: "g@other.org" }] } } }));
    f.google.override(/\/gmail\/v1\/users\/me\/drafts\/send/, () => {
      sent += 1;
      return Response.json({ id: "m2" });
    });
    const parameters = { method: "gmail.users.drafts.send", params: { userId: "me" }, body: { id: "d2" } };
    await expect(f.gateway.executeTool({ sessionToken: f.session.token, tool: f.call!.name, parameters, idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ reasonCode: "approval_required" });
    const [card] = await db.select().from(toolInvocations).where(eq(toolInvocations.companyId, f.company.id));
    expect(card.policyExplanation).toMatchObject({ google: { externalRecipients: ["g@other.org"], recipientsUnknown: false } });
    await approvePending(f);
    expect(sent).toBe(1);
  });

  it("revokes the Google token when the authorization is removed, even if Google refuses", async () => {
    const f = await fixture();
    const [grant] = (await f.access.listConnectionGrants(f.connectionId, f.company.id)).grants.filter((entry) => entry.status === "active");
    const removed = await f.access.revokeConnectionGrant(f.connectionId, grant.id, actor);
    expect(removed.status).toBe("revoked");
    expect(f.revoked).toEqual(["token=refresh-fixture"]);
    const [event] = (await db.select().from(toolAccessAuditEvents).where(eq(toolAccessAuditEvents.connectionId, f.connectionId)))
      .filter((row) => (row.details as { providerRevocation?: string } | null)?.providerRevocation);
    expect((event.details as { providerRevocation: string }).providerRevocation).toBe("success");

    const g = await fixture();
    g.failRevoke(503);
    const [other] = (await g.access.listConnectionGrants(g.connectionId, g.company.id)).grants.filter((entry) => entry.status === "active");
    expect((await g.access.revokeConnectionGrant(g.connectionId, other.id, actor)).status).toBe("revoked");
  });

  it("revokes the Google token when the whole connection is removed", async () => {
    const f = await fixture();
    const result = await f.access.archiveConnection(f.connectionId, f.company.id, actor);
    expect(f.revoked).toEqual(["token=refresh-fixture"]);
    expect(result.removal.externalCredentialCleanup).toEqual({ provider: "google", tokensAttempted: 1, tokensRevoked: 1, tokenFailures: 0 });
  });

  it("delivers the Google Workspace connector skill to a run that may use the connection", async () => {
    const f = await fixture();
    expect((await resolveConnectorAssignments(db, f.binding)).map((entry) => entry.key)).toEqual(["google-workspace"]);
  });

  it("refuses an approved draft send whose recipients changed after the card was created", async () => {
    const f = await fixture();
    expect(f.call).toBeDefined();
    let to = "a@example.com";
    let sent = 0;
    f.google.override(/\/gmail\/v1\/users\/me\/drafts\/d1\?/, () => Response.json({ id: "d1", message: { payload: { headers: [{ name: "To", value: to }] } } }));
    f.google.override(/\/gmail\/v1\/users\/me\/drafts\/send/, () => {
      sent += 1;
      return Response.json({ id: "m1" });
    });
    const parameters = { method: "gmail.users.drafts.send", params: { userId: "me" }, body: { id: "d1" } };
    await expect(f.gateway.executeTool({ sessionToken: f.session.token, tool: f.call!.name, parameters, idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ reasonCode: "approval_required" });
    to = "x@evil.example";
    await approvePending(f).catch(() => undefined);
    expect(sent).toBe(0);

    await expect(f.gateway.executeTool({ sessionToken: f.session.token, tool: f.call!.name, parameters, idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ reasonCode: "approval_required" });
    await approvePending(f);
    expect(sent).toBe(1);
    const invocations = await db.select().from(toolInvocations).where(eq(toolInvocations.companyId, f.company.id));
    expect(invocations.map((row) => [row.status, row.policyExplanation])).toEqual(expect.arrayContaining([
      ["failed", { google: expect.objectContaining({ externalRecipients: [] }) }],
      ["succeeded", { google: expect.objectContaining({ externalRecipients: ["x@evil.example"] }) }],
    ]));
  });
});
