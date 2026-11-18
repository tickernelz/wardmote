import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderAssignedToolsCli } from "./assigned-tools-cli.js";

const GOOGLE = "app.app-gallery-google-workspace-c5c969fe-16e5cf7a";
const OTHER_GOOGLE = "app.app-gallery-google-workspace-0b1d2e3f-9a8b7c6d";

interface Received {
  authorization: string | undefined;
  method: string;
  params: { name?: string; arguments?: unknown } | undefined;
}

describe("assigned tools CLI", () => {
  let server: http.Server;
  let url: string;
  let root: string;
  let script: string;
  let received: Received[];
  let tools: Array<{ name: string; title?: string; description: string; inputSchema: unknown }>;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const message = JSON.parse(body) as { id: number; method: string; params?: Received["params"] };
        received.push({ authorization: req.headers.authorization, method: message.method, params: message.params });
        res.setHeader("content-type", "application/json");
        if (req.headers.authorization !== "Bearer run-token") {
          res.statusCode = 401;
          res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32001, message: "Unauthorized" } }));
          return;
        }
        if (message.method === "tools/list") {
          res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools } }));
          return;
        }
        const name = message.params?.name ?? "";
        const result = name.endsWith(":google-call")
          ? { content: [{ type: "text", text: "{\"reasonCode\":\"google_error\"}" }], structuredContent: { reasonCode: "google_error" }, isError: true }
          : { content: [{ type: "text", text: "ok" }], structuredContent: { hits: [{ id: "forms.forms.create" }] }, isError: false };
        res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp/gateways/gw_test`;
    root = await fs.mkdtemp(path.join(os.tmpdir(), "wardmote-tool-cli-"));
    script = path.join(root, "wardmote-tool.mjs");
    await fs.writeFile(script, renderAssignedToolsCli(process.execPath), { mode: 0o700 });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    received = [];
    tools = [
      { name: `${GOOGLE}:google-search-methods`, title: "google_search_methods", description: "Find methods.\nMore.", inputSchema: { type: "object" } },
      { name: `${GOOGLE}:google-call`, title: "google_call", description: "Call a method.", inputSchema: { type: "object" } },
      { name: "wardmote_list_resources", description: "List resources.", inputSchema: { type: "object" } },
    ];
  });

  function run(args: string[], options: { token?: string; servers?: string } = {}) {
    const env = {
      PATH: process.env.PATH ?? "",
      WARDMOTE_RUNTIME_MCP_SERVERS: options.servers ?? JSON.stringify([{ name: "wardmote-assigned", url, connectionId: "assignment:x" }]),
      WARDMOTE_RUNTIME_MCP_TOKENS: JSON.stringify({ "wardmote-assigned": options.token ?? "run-token" }),
    };
    return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(script, args, { env }, (error, stdout, stderr) => {
        resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
      });
    });
  }

  it("lists tools by short name with the run's bearer token", async () => {
    const result = await run(["list"]);
    expect(result.code).toBe(0);
    expect(result.stdout.split("\n")).toEqual([
      "google_search_methods\tFind methods.",
      "google_call\tCall a method.",
      "wardmote_list_resources\tList resources.",
      "",
    ]);
    expect(received).toEqual([{ authorization: "Bearer run-token", method: "tools/list", params: undefined }]);
  });

  it.each(["google_search_methods", "google-search-methods", `${GOOGLE}:google-search-methods`])(
    "calls %s with the full prefixed tool name",
    async (requested) => {
      const result = await run(["call", requested, '{"query":"create form"}']);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ hits: [{ id: "forms.forms.create" }] });
      expect(received.at(-1)).toEqual({
        authorization: "Bearer run-token",
        method: "tools/call",
        params: { name: `${GOOGLE}:google-search-methods`, arguments: { query: "create form" } },
      });
    },
  );

  it("refuses an ambiguous short name without calling any tool", async () => {
    tools.push({ name: `${OTHER_GOOGLE}:google-search-methods`, title: "google_search_methods", description: "Find.", inputSchema: {} });
    const result = await run(["call", "google_search_methods", "{}"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${OTHER_GOOGLE}:google-search-methods`);
    expect(received.map((entry) => entry.method)).toEqual(["tools/list"]);
  });

  it("fails on an unknown tool without calling it", async () => {
    const result = await run(["call", "google_forms_create"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Unknown tool "google_forms_create"');
    expect(received.map((entry) => entry.method)).toEqual(["tools/list"]);
  });

  it("exits non-zero and prints the structured error of a failed tool", async () => {
    const result = await run(["call", "google_call", "{}"]);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({ reasonCode: "google_error" });
  });

  it("reports a rejected token as a failure", async () => {
    const result = await run(["list"], { token: "stale" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("HTTP 401");
    expect(result.stderr).not.toContain("stale");
  });

  it("names the available servers when the requested one is absent", async () => {
    const result = await run(["--server", "missing", "list"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('No MCP server "missing" in this run. Available: wardmote-assigned');
    expect(received).toEqual([]);
  });

  it("rejects non-object arguments before calling the server", async () => {
    const result = await run(["call", "google_search_methods", "[1]"]);
    expect(result.code).toBe(2);
    expect(received.map((entry) => entry.method)).toEqual(["tools/list"]);
  });
});
