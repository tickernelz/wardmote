import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tickernelz/wardmote-adapter-utils/execution-target", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, runAdapterExecutionTargetProcess: vi.fn() };
});

import { execute } from "./execute.js";
import { runAdapterExecutionTargetProcess } from "@tickernelz/wardmote-adapter-utils/execution-target";
import type { AdapterRuntimeMcpServer } from "@tickernelz/wardmote-adapter-utils";

const runProcessMock = vi.mocked(runAdapterExecutionTargetProcess);
const TOOL = "app.app-gallery-google-workspace-c5c969fe-16e5cf7a:google-search-methods";

interface Observed {
  cliPath: string | undefined;
  prompt: string;
  cliOutput: string;
}

describe("OMP local assigned connector tools", () => {
  let root: string;
  let server: http.Server;
  let gatewayUrl: string;
  let calls: string[];
  let observed: Observed | null;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "wardmote-omp-assigned-"));
    await fs.mkdir(path.join(root, "workspace"));
    await fs.writeFile(path.join(root, "fake-omp"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    calls = [];
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        const message = JSON.parse(body) as { id: number; method: string; params?: { name: string } };
        calls.push(message.method === "tools/call" ? `tools/call ${message.params?.name}` : message.method);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: message.method === "tools/list"
            ? { tools: [{ name: TOOL, title: "google_search_methods", description: "Find.", inputSchema: {} }] }
            : { content: [{ type: "text", text: "hits" }], isError: false },
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    gatewayUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp/gateways/gw_test`;
    observed = null;
    runProcessMock.mockReset();
    runProcessMock.mockImplementation((async (
      _runId: string,
      _target: unknown,
      _command: string,
      args: string[],
      options: { env: Record<string, string>; stdin?: string },
    ) => {
      const cliPath = options.env.WARDMOTE_TOOL_CLI;
      const cliOutput = cliPath
        ? await new Promise<string>((resolve) => {
            execFile(cliPath, ["call", "google_search_methods", '{"query":"create form"}'], { env: options.env }, (error, stdout, stderr) =>
              resolve(error ? `error: ${stderr}` : stdout));
          })
        : "";
      observed = { cliPath, prompt: [...args, options.stdin ?? ""].join("\n"), cliOutput };
      return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "", pid: 4321, startedAt: new Date().toISOString() };
    }) as never);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });

  async function run(servers: AdapterRuntimeMcpServer[]): Promise<Observed> {
    await execute({
      runId: "run-assigned",
      agent: { id: "agent-1", companyId: "company-1", name: "OMP", adapterType: "omp_local", adapterConfig: {} },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { command: path.join(root, "fake-omp"), noSession: true, rpcSteering: false, cwd: path.join(root, "workspace") },
      context: { wardmoteWake: { reason: "issue_assigned", connectorSkillInstructions: "### google-workspace\n\nUse google_search_methods." } },
      runtimeMcp: servers.length ? { getServers: () => servers } : undefined,
      onLog: async () => {},
    });
    expect(observed).not.toBeNull();
    return observed as Observed;
  }

  it("gives the run a helper that reaches wardmote-assigned and tells the agent how to call it", async () => {
    const result = await run([{ name: "wardmote-assigned", url: gatewayUrl, token: "run-token", connectionId: "assignment:x" }]);
    expect(result.cliOutput).toBe("hits\n");
    expect(calls).toEqual(["tools/list", `tools/call ${TOOL}`]);
    expect(result.prompt).toContain("### Calling assigned connector tools");
    expect(result.prompt).toContain('"$WARDMOTE_TOOL_CLI" call google_search_methods');
    expect(result.prompt.indexOf("### Calling assigned connector tools")).toBeLessThan(result.prompt.indexOf("### google-workspace"));
    await expect(fs.stat(result.cliPath!)).rejects.toThrow();
  });

  it("adds no helper guidance when the run has no assigned connector tools", async () => {
    const result = await run([]);
    expect(result.cliPath).toBeUndefined();
    expect(result.prompt).toContain("### google-workspace");
    expect(result.prompt).not.toContain("Calling assigned connector tools");
  });

  it("keeps the helper for other servers without claiming wardmote-assigned exists", async () => {
    const result = await run([{ name: "Wardmote projects", url: gatewayUrl, token: "run-token", connectionId: "wardmote-project-tools" }]);
    expect(result.cliOutput).toContain('No MCP server "wardmote-assigned" in this run. Available: Wardmote projects');
    expect(result.prompt).not.toContain("Calling assigned connector tools");
  });
});
