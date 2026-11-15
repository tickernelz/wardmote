import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const migration = readFileSync(
  new URL("./migrations/0391_wardmote_cancel_closed_issue_deferred_wakes.sql", import.meta.url),
  "utf8",
);

(support.supported ? describe : describe.skip)("closed-issue deferred wake cleanup migration", () => {
  it("cancels deferred wakes stranded on closed issues once and leaves every other wake alone", async () => {
    const database = await startEmbeddedPostgresTestDatabase("wardmote-closed-issue-wakes-");
    const sql = postgres(database.connectionString, { max: 1, onnotice: () => {} });
    try {
      const companyId = randomUUID();
      const agentId = randomUUID();
      await sql`INSERT INTO companies (id, name, issue_prefix) VALUES (${companyId}, 'Closed wakes', 'CLW')`;
      await sql`INSERT INTO agents (id, company_id, name, role, adapter_type) VALUES (${agentId}, ${companyId}, 'Agent', 'engineer', 'codex_local')`;
      const issue = async (status: string) => {
        const id = randomUUID();
        await sql`INSERT INTO issues (id, company_id, title, status, priority) VALUES (${id}, ${companyId}, 'Fixture', ${status}, 'medium')`;
        return id;
      };
      const doneIssue = await issue("done");
      const cancelledIssue = await issue("cancelled");
      const openIssue = await issue("in_progress");
      const liveRunIssue = await issue("done");
      await sql`INSERT INTO heartbeat_runs (id, company_id, agent_id, status, context_snapshot)
        VALUES (${randomUUID()}, ${companyId}, ${agentId}, 'running', ${sql.json({ issueId: liveRunIssue })})`;
      const cases = [
        { key: "done-issue-id", payload: { issueId: doneIssue }, status: "deferred_issue_execution", expected: "cancelled" },
        { key: "cancelled-task-id", payload: { taskId: cancelledIssue }, status: "deferred_issue_execution", expected: "cancelled" },
        { key: "cancelled-context", payload: { _wardmoteWakeContext: { issueId: cancelledIssue } }, status: "deferred_issue_execution", expected: "cancelled" },
        { key: "open-issue", payload: { issueId: openIssue }, status: "deferred_issue_execution", expected: "deferred_issue_execution" },
        { key: "live-run", payload: { issueId: liveRunIssue }, status: "deferred_issue_execution", expected: "deferred_issue_execution" },
        { key: "queued-on-done", payload: { issueId: doneIssue }, status: "queued", expected: "queued" },
      ];
      const ids = new Map<string, string>();
      for (const c of cases) {
        const id = randomUUID();
        ids.set(c.key, id);
        await sql`INSERT INTO agent_wakeup_requests (id, company_id, agent_id, source, status, payload)
          VALUES (${id}, ${companyId}, ${agentId}, 'automation', ${c.status}, ${sql.json(c.payload)})`;
      }
      const snapshot = async () =>
        Object.fromEntries(
          (await sql`SELECT id, status, error, finished_at FROM agent_wakeup_requests WHERE company_id = ${companyId}`)
            .map((row) => [row.id, row]),
        );
      const apply = async () => {
        for (const statement of migration.split("--> statement-breakpoint")) {
          if (statement.trim()) await sql.unsafe(statement);
        }
      };

      await apply();
      const first = await snapshot();
      for (const c of cases) expect(first[ids.get(c.key)!].status).toBe(c.expected);
      expect(first[ids.get("done-issue-id")!].error).toBe("issue_closed");
      expect(first[ids.get("done-issue-id")!].finished_at).not.toBeNull();

      await apply();
      expect(await snapshot()).toEqual(first);
    } finally {
      await sql.end();
      await database.cleanup();
    }
  }, 30_000);
});
