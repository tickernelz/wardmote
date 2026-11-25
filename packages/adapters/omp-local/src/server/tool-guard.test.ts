import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  OMP_ASYNC_BASH_TIMEOUT_SEC,
  OMP_READ_ONLY_BLOCK_REASON,
  OMP_TOOL_GUARD_FILE_NAME,
  renderOmpToolGuardExtension,
  writeOmpToolGuardExtension,
} from "./tool-guard.js";
import type { RunToolProfile } from "@tickernelz/wardmote-adapter-utils/tool-profile";

type ToolCallHandler = (event: {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}) => { input?: Record<string, unknown>; block?: boolean; reason?: string } | undefined;

async function loadGuard(dir: string, profile: RunToolProfile): Promise<ToolCallHandler> {
  const file = path.join(dir, `${profile}-${OMP_TOOL_GUARD_FILE_NAME}`);
  await fs.writeFile(file, renderOmpToolGuardExtension(profile), "utf8");
  const module = (await import(pathToFileURL(file).href)) as {
    default: (pi: { on: (event: string, fn: ToolCallHandler) => void }) => void;
  };
  const registered: Array<{ event: string; fn: ToolCallHandler }> = [];
  module.default({ on: (event, fn) => registered.push({ event, fn }) });
  expect(registered.map((entry) => entry.event)).toEqual(["tool_call"]);
  return registered[0]!.fn;
}

describe("OMP tool guard extension", () => {
  let dir: string;
  let handler: ToolCallHandler;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "wardmote-omp-guard-test-"));
    handler = await loadGuard(dir, "full");
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function call(toolName: string, input: Record<string, unknown>) {
    return handler({ type: "tool_call", toolCallId: "call-1", toolName, input });
  }

  it("gives an async bash job without a timeout the OMP maximum", () => {
    const input = { command: "pnpm test", async: true };
    expect(call("bash", input)).toEqual({
      input: { command: "pnpm test", async: true, timeout: OMP_ASYNC_BASH_TIMEOUT_SEC },
    });
    expect(input).toEqual({ command: "pnpm test", async: true });
  });

  it("drops a ready spec that carries no condition and fills the async timeout in the same call", () => {
    expect(call("bash", { command: "pnpm build", async: true, ready: {} })).toEqual({
      input: { command: "pnpm build", async: true, timeout: OMP_ASYNC_BASH_TIMEOUT_SEC },
    });
    expect(call("bash", { command: "ls", ready: { log: " ", host: "" } })).toEqual({
      input: { command: "ls" },
    });
  });

  it("keeps an explicit async timeout", () => {
    expect(call("bash", { command: "pnpm test", async: true, timeout: 600 })).toBeUndefined();
  });

  it("keeps a ready spec that carries a condition when no service name is given", () => {
    expect(call("bash", { command: "serve", ready: { port: 3000 } })).toBeUndefined();
    expect(call("bash", { command: "serve", ready: { timeout: 30 } })).toBeUndefined();
  });

  it("leaves service calls with a name untouched", () => {
    expect(call("bash", { command: "serve", name: "web", ready: {} })).toBeUndefined();
    expect(call("bash", { command: "serve", name: "web", async: true })).toBeUndefined();
  });

  it("leaves synchronous bash and other tools untouched", () => {
    expect(call("bash", { command: "ls" })).toBeUndefined();
    expect(call("bash", { command: "ls", async: false })).toBeUndefined();
    expect(call("read", { path: "a.ts", async: true, ready: {} })).toBeUndefined();
  });

  it("lets a full-profile run call write tools", () => {
    expect(call("write", { path: "x.txt", content: "hello" })).toBeUndefined();
    expect(call("edit", { path: "x.txt", input: "patch" })).toBeUndefined();
    expect(call("lsp", { action: "rename", file: "a.ts", new_name: "b" })).toBeUndefined();
  });

  it("writes the extension for the run profile with a cleanup that removes it", async () => {
    for (const profile of ["full", "read_only"] as const) {
      const extension = await writeOmpToolGuardExtension({
        runId: `run-guard-${profile}`,
        target: null,
        remote: false,
        env: {},
        remoteRootDir: null,
        cwd: dir,
        timeoutSec: 0,
        graceSec: 0,
        profile,
      });
      expect(path.basename(extension.path)).toBe(OMP_TOOL_GUARD_FILE_NAME);
      expect(await fs.readFile(extension.path, "utf8")).toBe(renderOmpToolGuardExtension(profile));
      await extension.cleanup();
      await expect(fs.access(extension.path)).rejects.toThrow();
    }
  });
});

describe("OMP tool guard extension in a read_only run", () => {
  let dir: string;
  let handler: ToolCallHandler;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "wardmote-omp-guard-ro-test-"));
    handler = await loadGuard(dir, "read_only");
  });

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function call(toolName: string, input: Record<string, unknown>) {
    return handler({ type: "tool_call", toolCallId: "call-1", toolName, input });
  }

  const blocked = { block: true, reason: OMP_READ_ONLY_BLOCK_REASON };

  it.each([
    ["write", { path: "x.txt", content: "hello" }],
    ["write", { path: "[x.txt#ABCD]", content: "hello" }],
    ["edit", { path: "x.txt", input: "patch" }],
    ["apply_patch", { input: "*** Begin Patch" }],
    ["ast_edit", { ops: [{ pat: "a", out: "b" }], paths: ["src"] }],
    ["lsp", { action: "rename", file: "a.ts", symbol: "a", new_name: "b" }],
    ["lsp", { action: "rename_file", file: "a.ts", new_name: "b.ts" }],
    ["lsp", { action: "code_actions", file: "a.ts", apply: true, query: "fix" }],
    ["lsp", { action: "request", query: "workspace/executeCommand" }],
    ["github", { op: "pr_create", title: "t" }],
    ["github", { op: "pr_push" }],
    ["hub", { op: "send", to: "peer", message: "do it" }],
    ["task", { agent: "task", task: "edit", isolated: true }],
    ["task", { context: "c", tasks: [{ agent: "task", task: "edit", isolated: true }] }],
    ["tts", { text: "hi", output_path: "a.wav" }],
    ["retain", { items: [] }],
    ["memory_edit", { op: "forget", id: "m" }],
    ["learn", { lesson: "x" }],
    ["manage_skill", { op: "create" }],
    ["vibe_spawn", { task: "x" }],
    ["vibe_send", { id: "x", message: "y" }],
  ])("blocks %s with the read-only reason (%j)", (toolName, input) => {
    expect(call(toolName, input)).toEqual(blocked);
  });

  it.each([
    ["read", { path: "a.ts" }],
    ["grep", { pattern: "x" }],
    ["glob", { pattern: "*.ts" }],
    ["ast_grep", { pat: "x" }],
    ["bash", { command: "cat a.ts" }],
    ["eval", { language: "py", code: "1" }],
    ["web_search", { query: "x" }],
    ["browser", { action: "open" }],
    ["write", { path: "xd://resolve", content: "reason" }],
    ["write", { path: "xd://lsp", content: "{}" }],
    ["lsp", { action: "references", file: "a.ts", symbol: "a" }],
    ["lsp", { action: "diagnostics", file: "a.ts" }],
    ["lsp", { action: "rename", file: "a.ts", symbol: "a", new_name: "b", apply: false }],
    ["lsp", { action: "code_actions", file: "a.ts" }],
    ["github", { op: "file_read", path: "README.md" }],
    ["hub", { op: "inbox" }],
    ["task", { agent: "scout", task: "find the bug" }],
    ["recall", { query: "x" }],
  ])("lets %s through (%j)", (toolName, input) => {
    expect(call(toolName, input)).toBeUndefined();
  });

  it("keeps the async bash timeout fix in a read_only run", () => {
    expect(call("bash", { command: "pnpm test", async: true })).toEqual({
      input: { command: "pnpm test", async: true, timeout: OMP_ASYNC_BASH_TIMEOUT_SEC },
    });
  });
});

type HoldHandler = (event: Record<string, unknown>, ctx: { modelRegistry: FakeRegistry }) => void;

class FakeRegistry {
  readonly suppressed = new Map<string, number>();
  suppressSelector(selector: string, until: number) {
    this.suppressed.set(selector, until);
  }
  isSelectorSuppressed(selector: string) {
    return (this.suppressed.get(selector) ?? 0) > Date.now();
  }
  clearSuppressedSelector(selector: string) {
    this.suppressed.delete(selector);
  }
}

async function loadHold(dir: string, name: string, probation: boolean) {
  const file = path.join(dir, `hold-${name}-${OMP_TOOL_GUARD_FILE_NAME}`);
  await fs.writeFile(file, renderOmpToolGuardExtension("full", {
    primary: "a/primary",
    start: "a/primary",
    selectors: ["a/primary", "b/backup", "c/last"],
    holdAttempts: 2,
    holdMs: 600_000,
    probation: probation ? { selector: "a/primary", firstEventTimeoutSec: 60, holdAttempts: 3 } : null,
  }), "utf8");
  const module = (await import(pathToFileURL(file).href)) as {
    default: (pi: { on: (event: string, fn: HoldHandler) => void }) => void;
  };
  const handlers = new Map<string, HoldHandler>();
  module.default({ on: (event, fn) => handlers.set(event, fn) });
  const registry = new FakeRegistry();
  const fire = (event: Record<string, unknown>) => handlers.get(String(event.type))?.({ ...event }, { modelRegistry: registry });
  const failOn = (provider: string, model: string, errorMessage: string) =>
    fire({ type: "message_end", message: { role: "assistant", provider, model, stopReason: "error", errorMessage } });
  return { registry, fire, failOn, held: () => [...registry.suppressed.keys()].filter((key) => registry.isSelectorSuppressed(key)).sort() };
}

describe("OMP fallback hold", () => {
  let dir: string;
  const saved = process.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "wardmote-omp-hold-test-"));
  });

  afterAll(async () => {
    if (saved === undefined) delete process.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS;
    else process.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS = saved;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("keeps the chain closed for one transient failure, then opens it for the next", async () => {
    const hold = await loadHold(dir, "transient", false);
    hold.fire({ type: "turn_start" });
    expect(hold.held()).toEqual(["b/backup", "c/last"]);
    hold.failOn("a", "primary", "503 No available accounts: no available accounts (type=api_error)");
    expect(hold.held()).toEqual(["b/backup", "c/last"]);
    hold.failOn("a", "primary", "OpenAI responses stream timed out while waiting for the first event");
    expect(hold.held()).toEqual([]);
  });

  it("opens the chain at once for a refusal or a quota error", async () => {
    for (const message of ["Refusal (reasoning_extraction): This request was blocked", "429 Too Many Requests: usage limit reached"]) {
      const hold = await loadHold(dir, message.slice(0, 3), false);
      hold.fire({ type: "turn_start" });
      hold.failOn("a", "primary", message);
      expect(hold.held()).toEqual([]);
    }
  });

  it("closes the chain again after a success and after a switch, without touching OMP's own cooldowns", async () => {
    const hold = await loadHold(dir, "switch", false);
    hold.fire({ type: "turn_start" });
    hold.failOn("a", "primary", "503 Service Unavailable");
    hold.fire({ type: "message_end", message: { role: "assistant", provider: "a", model: "primary", stopReason: "stop" } });
    hold.failOn("a", "primary", "503 Service Unavailable");
    expect(hold.held()).toEqual(["b/backup", "c/last"]);
    hold.failOn("a", "primary", "503 Service Unavailable");
    hold.registry.suppressSelector("a/primary", Date.now() + 300_000);
    hold.fire({ type: "retry_fallback_applied", from: "a/primary:high", to: "b/backup:max", role: "a/primary" });
    expect(hold.held()).toEqual(["a/primary", "c/last"]);
    hold.failOn("b", "backup", "503 Service Unavailable");
    expect(hold.held()).toEqual(["a/primary", "c/last"]);
  });

  it("releases the hold when OMP gives up the retry without a switch", async () => {
    const hold = await loadHold(dir, "gave-up", false);
    hold.fire({ type: "turn_start" });
    hold.failOn("a", "primary", "503 Service Unavailable");
    expect(hold.held()).toEqual(["b/backup", "c/last"]);
    hold.fire({ type: "auto_retry_end", success: false, attempt: 1 });
    expect(hold.held()).toEqual([]);
    hold.fire({ type: "auto_retry_end", success: true, attempt: 1 });
    hold.fire({ type: "turn_start" });
    expect(hold.held()).toEqual(["b/backup", "c/last"]);
  });

  it("limits the first response only while the model on probation is active, and holds it one attempt longer", async () => {
    delete process.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS;
    const hold = await loadHold(dir, "probation", true);
    expect(process.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS).toBe("60000");
    hold.fire({ type: "turn_start" });
    hold.failOn("a", "primary", "stream timed out while waiting for the first event");
    hold.failOn("a", "primary", "stream timed out while waiting for the first event");
    expect(hold.held()).toEqual(["b/backup", "c/last"]);
    hold.failOn("a", "primary", "stream timed out while waiting for the first event");
    expect(hold.held()).toEqual([]);
    hold.fire({ type: "retry_fallback_applied", from: "a/primary", to: "b/backup", role: "a/primary" });
    expect(process.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS).toBeUndefined();
  });
});
