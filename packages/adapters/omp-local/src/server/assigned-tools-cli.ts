import path from "node:path";
import type { AdapterExecutionTarget } from "@tickernelz/wardmote-adapter-utils/execution-target";
import { writeWardmoteMcpMount } from "@tickernelz/wardmote-adapter-utils/wardmote-mcp-mount";

export const ASSIGNED_TOOLS_CLI_ENV = "WARDMOTE_TOOL_CLI";
const ASSIGNED_TOOLS_CLI_FILE_NAME = "wardmote-tool.mjs";

const ASSIGNED_TOOLS_CLI_SCRIPT = String.raw`const usage = "usage: wardmote-tool [--server <name>] list | schema <tool> | call <tool> [<json arguments> | -]";
const argv = process.argv.slice(2);
let server = "wardmote-assigned";
const positional = [];
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === "--server") server = argv[++index] ?? "";
  else positional.push(argv[index]);
}
const [command, toolArg, rawArguments] = positional;

function fail(message, code = 1) {
  process.stderr.write(message + "\n");
  process.exit(code);
}

function readJsonEnv(key) {
  try {
    return JSON.parse(process.env[key] ?? "");
  } catch {
    return fail(key + " is missing or not JSON: this run has no Wardmote-provisioned MCP servers.");
  }
}

if (!["list", "schema", "call"].includes(command) || (command !== "list" && !toolArg)) fail(usage, 2);
const servers = readJsonEnv("WARDMOTE_RUNTIME_MCP_SERVERS");
const tokens = readJsonEnv("WARDMOTE_RUNTIME_MCP_TOKENS");
const entry = Array.isArray(servers) ? servers.find((candidate) => candidate && candidate.name === server) : null;
const token = tokens && typeof tokens === "object" ? tokens[server] : null;
if (!entry || typeof entry.url !== "string" || typeof token !== "string") {
  const names = Array.isArray(servers) ? servers.map((candidate) => candidate && candidate.name).join(", ") : "";
  fail("No MCP server \"" + server + "\" in this run. Available: " + (names || "none"));
}

let nextId = 1;
async function rpc(method, params) {
  const response = await fetch(entry.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", authorization: "Bearer " + token },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, ...(params ? { params } : {}) }),
    signal: AbortSignal.timeout(300000),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return fail(method + " failed: HTTP " + response.status + ": " + text.slice(0, 500));
  }
  if (body.error) fail(method + " failed: HTTP " + response.status + ": " + JSON.stringify(body.error));
  return body.result;
}

const shortName = (name) => name.slice(name.lastIndexOf(":") + 1).replaceAll("-", "_");
const displayName = (tool) => tool.title || shortName(tool.name);

function resolveTool(tools, requested) {
  const exact = tools.find((tool) => tool.name === requested);
  if (exact) return exact;
  const wanted = requested.replaceAll("-", "_");
  const matches = tools.filter((tool) => tool.title === requested || shortName(tool.name) === wanted);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    return fail("\"" + requested + "\" matches several tools; pass the full name:\n" + matches.map((tool) => "  " + tool.name).join("\n"));
  }
  return fail("Unknown tool \"" + requested + "\" on " + server + ". Run: wardmote-tool list");
}

async function readArguments() {
  if (rawArguments === undefined) return {};
  let text = rawArguments;
  if (rawArguments === "-") {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    text = Buffer.concat(chunks).toString("utf8");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return fail("Arguments are not valid JSON: " + error.message, 2);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("Arguments must be a JSON object.", 2);
  return parsed;
}

const { tools } = await rpc("tools/list");
if (command === "list") {
  for (const tool of tools) {
    const description = String(tool.description ?? "").split("\n")[0];
    process.stdout.write(displayName(tool) + "\t" + description + "\n");
  }
} else if (command === "schema") {
  const tool = resolveTool(tools, toolArg);
  process.stdout.write(JSON.stringify({ name: tool.name, title: displayName(tool), inputSchema: tool.inputSchema }, null, 2) + "\n");
} else {
  const tool = resolveTool(tools, toolArg);
  const result = await rpc("tools/call", { name: tool.name, arguments: await readArguments() });
  const text = result.structuredContent !== undefined
    ? JSON.stringify(result.structuredContent, null, 2)
    : (result.content ?? []).map((part) => (part.type === "text" ? part.text : JSON.stringify(part))).join("\n");
  process.stdout.write(text + "\n");
  if (result.isError) process.exit(1);
}
`;

/** Node script that lists and calls the run's MCP server tools by short name. */
export function renderAssignedToolsCli(interpreter: string): string {
  return `#!${interpreter}\n${ASSIGNED_TOOLS_CLI_SCRIPT}`;
}

export interface AssignedToolsCli {
  path: string;
  cleanup: () => Promise<void>;
}

export async function writeAssignedToolsCli(input: {
  runId: string;
  target: AdapterExecutionTarget | null | undefined;
  remote: boolean;
  env: Record<string, string>;
  remoteRootDir: string | null;
  cwd: string;
  timeoutSec: number;
  graceSec: number;
}): Promise<AssignedToolsCli> {
  const mount = await writeWardmoteMcpMount({
    runId: input.runId,
    target: input.target,
    remote: input.remote,
    content: renderAssignedToolsCli(input.remote ? "/usr/bin/env node" : process.execPath),
    fileName: ASSIGNED_TOOLS_CLI_FILE_NAME,
    mode: 0o700,
    localPrefix: "wardmote-omp-tools-",
    remoteDir: path.posix.join(
      input.remoteRootDir ?? path.posix.join(input.cwd, ".wardmote-runtime", "omp"),
      "assigned-tools",
    ),
    cwd: input.cwd,
    env: input.env,
    timeoutSec: input.timeoutSec,
    graceSec: input.graceSec,
  });
  return { path: mount.filePath, cleanup: mount.cleanup };
}
