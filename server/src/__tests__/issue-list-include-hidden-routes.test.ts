import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, companyMemberships, createDb, issues } from "@tickernelz/wardmote-db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { ensureHumanRoleDefaultGrants } from "../services/principal-access-compatibility.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres includeHidden route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const BOARD_USER = "board-owner";
const VISIBLE = ["Ship the release", "Review the audit"];
const HIDDEN = "Update status card";
const HARNESS = "Skill test run";

type Actor = Express.Request["actor"];

describeEmbeddedPostgres("issue list includeHidden", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("wardmote-include-hidden-");
    db = createDb(tempDb.connectionString);
    const prefix = () => `H${randomUUID().replace(/-/g, "").slice(0, 4).toUpperCase()}`;
    await db.insert(companies).values([
      { id: companyId, name: "Hidden", issuePrefix: prefix(), requireBoardApprovalForNewAgents: false },
      { id: otherCompanyId, name: "Other", issuePrefix: prefix(), requireBoardApprovalForNewAgents: false },
    ]);
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: BOARD_USER,
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await ensureHumanRoleDefaultGrants(db, {
      companyId,
      principalId: BOARD_USER,
      membershipRole: "owner",
      grantedByUserId: null,
    });
    const row = (cid: string, title: string, extra: Partial<typeof issues.$inferInsert> = {}) => ({
      id: randomUUID(),
      companyId: cid,
      title,
      status: "todo" as const,
      priority: "medium" as const,
      ...extra,
    });
    await db.insert(issues).values([
      ...VISIBLE.map((title) => row(companyId, title)),
      row(companyId, HIDDEN, { hiddenAt: new Date() }),
      row(companyId, HARNESS, { harnessKind: "skill_test" }),
      row(otherCompanyId, "Another company's hidden task", { hiddenAt: new Date() }),
    ]);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const actor: Actor = {
    type: "board",
    source: "session",
    userId: BOARD_USER,
    companyIds: [companyId],
    memberships: [{ companyId, membershipRole: "owner", status: "active" }],
    isInstanceAdmin: false,
  };
  const app = () => {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      (req as { actor?: Actor }).actor = actor;
      next();
    });
    server.use("/api", issueRoutes(db, {} as never));
    server.use(errorHandler);
    return server;
  };

  async function titles(query: Record<string, string>) {
    const res = await request(app()).get(`/api/companies/${companyId}/issues`).query({ limit: "50", ...query });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body as Array<{ title: string }>).map((issue) => issue.title).sort();
  }

  it("adds only this company's hidden tasks when asked, never harness runs, in the compact view the Tasks page reads", async () => {
    expect(await titles({ view: "compact" })).toEqual([...VISIBLE].sort());
    expect(await titles({ view: "compact", includeHidden: "true" })).toEqual([...VISIBLE, HIDDEN].sort());
    expect(await titles({ view: "compact" })).toEqual([...VISIBLE].sort());
  });

  it("keeps search scoped the same way", async () => {
    expect(await titles({ q: "status card" })).toEqual([]);
    expect(await titles({ q: "status card", includeHidden: "1" })).toEqual([HIDDEN]);
  });
});
