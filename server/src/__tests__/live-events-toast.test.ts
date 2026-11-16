import { createServer } from "node:http";
import { once } from "node:events";
import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { activityToastIdentity } from "../realtime/activity-toast-identity.js";
import { WebSocket } from "ws";
import { describe, expect, it, vi } from "vitest";
import { setupLiveEventsWebSocketServer } from "../realtime/live-events-ws.js";
import { publishLiveEvent } from "../services/live-events.js";

vi.mock("../services/authorization.js", () => ({
  authorizationService: () => ({ decide: async ({ resource }: { resource: { issueId: string } }) => ({ allowed: resource.issueId !== "hidden" }) }),
}));
vi.mock("../services/heartbeat-run-privacy.js", () => ({ canActorReadHeartbeatRun: async () => false }));
function database(onPredicate: (kind: "where" | "join", condition: SQL) => void = () => {}) {
  return { select: (fields: Record<string, unknown>) => {
    let table = "";
    const query = {
      from: (value: Parameters<typeof getTableName>[0]) => { table = getTableName(value); return query; },
      innerJoin: (_table: unknown, condition: SQL) => { onPredicate("join", condition); return query; },
      where: (condition: SQL) => { onPredicate("where", condition); return query; },
      limit: async () => {
        if (table === "issues") return [{ id: "task" }];
        if (table === "company_memberships") return fields.name ? [{ name: "Alex Example", image: "/alex.png" }] : [{ id: "membership" }];
        if (table === "agents") return [{ name: "Coder", appearance: { schemaVersion: 1, characterVersion: "cap-v1", paletteId: "bubblegum-sky" } }];
        return [];
      },
      then: (resolve: (rows: unknown[]) => unknown) => resolve(
        table === "company_memberships" && fields.companyId ? [{ companyId: "company" }] : [],
      ),
    };
    return query;
  } };
}
describe("authenticated activity notifications", () => {
  it("keeps actor identity after authorization and excludes hidden tasks and private details", async () => {
    const server = createServer();
    setupLiveEventsWebSocketServer(server, database() as never, { deploymentMode: "authenticated",
      resolveSessionFromHeaders: async () => ({ user: { id: "viewer" }, session: { id: "session" } }) as never });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const socket = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/api/companies/company/events/ws`);
    try {
      await once(socket, "open");
      const messages: Array<{ payload: Record<string, unknown> }> = [];
      socket.on("message", (data) => messages.push(JSON.parse(data.toString())));
      const activity = (entityId: string, actorType = "user") => publishLiveEvent({ companyId: "company", type: "activity.logged", payload: {
        action: "issue.created", entityType: "issue", entityId, actorType, actorId: actorType === "user" ? "viewer" : "agent",
        details: { bodySnippet: "private comment", secret: "not for the socket" },
      } });
      activity("hidden");
      const first = once(socket, "message");
      activity("visible");
      await first;
      expect(messages).toHaveLength(1);
      expect(messages[0].payload).toEqual({ action: "issue.created", entityType: "issue", entityId: "visible", actorType: "user", actorId: "viewer", actorName: "Alex Example", actorImage: "/alex.png" });
      const second = once(socket, "message");
      activity("visible", "agent");
      await second;
      expect(messages[1].payload).toMatchObject({ actorName: "Coder", actorType: "agent", actorId: "agent", actorAppearance: { paletteId: "bubblegum-sky" } });
      expect(messages[1].payload).not.toHaveProperty("details");
      const comment = (entityId: string, source: string) => publishLiveEvent({ companyId: "company", type: "activity.logged", payload: {
        action: "issue.comment_added", entityType: "issue", entityId, actorType: "user", actorId: "viewer",
        details: { commentId: "comment-1", source, bodySnippet: "private comment", identifier: "ZHA-1", secret: "not for the socket" },
      } });
      comment("hidden", "chat:openwa");
      const third = once(socket, "message");
      comment("visible", "chat:openwa");
      await third;
      expect(messages).toHaveLength(3);
      expect(messages[2].payload).toEqual({ action: "issue.comment_added", entityType: "issue", entityId: "visible", actorType: "user", actorId: "viewer",
        details: { commentId: "comment-1", source: "chat:openwa" } });
      const fourth = once(socket, "message");
      comment("visible", "comment");
      await fourth;
      expect(messages[3].payload).toMatchObject({ actorName: "Alex Example", details: { commentId: "comment-1", source: "comment" } });
      expect(Object.keys(messages[3].payload.details as object).sort()).toEqual(["commentId", "source"]);
    } finally {
      socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});


describe("activity profile query boundaries", () => {
  it("requires the exact company, human actor, and active membership before reading a person profile", async () => {
    const predicates: { kind: string; sql: string; params: unknown[] }[] = [];
    const db = database((kind, condition) => {
      const { sql, params } = new PgDialect().sqlToQuery(condition);
      predicates.push({ kind, sql, params });
    });
    await activityToastIdentity(db as never, "company-A", {
      action: "issue.created", actorType: "user", actorId: "person-A",
    });
    expect(predicates).toEqual([
      { kind: "join", sql: '"user"."id" = "company_memberships"."principal_id"', params: [] },
      { kind: "where", sql: '("company_memberships"."company_id" = $1 and "company_memberships"."principal_type" = $2 and "company_memberships"."principal_id" = $3 and "company_memberships"."status" = $4)',
        params: ["company-A", "user", "person-A", "active"] },
    ]);
  });

  it("requires both the exact company and agent ID before reading an agent profile", async () => {
    const predicates: { kind: string; sql: string; params: unknown[] }[] = [];
    const db = database((kind, condition) => {
      const { sql, params } = new PgDialect().sqlToQuery(condition);
      predicates.push({ kind, sql, params });
    });
    await activityToastIdentity(db as never, "company-A", {
      action: "issue.created", actorType: "agent", actorId: "agent-A",
    });
    expect(predicates).toEqual([
      { kind: "where", sql: '("agents"."company_id" = $1 and "agents"."id" = $2)',
        params: ["company-A", "agent-A"] },
    ]);
  });
});
