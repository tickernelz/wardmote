import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

vi.mock("@tickernelz/wardmote-adapter-utils/execution-target", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, runAdapterExecutionTargetProcess: vi.fn() };
});

import { execute } from "./execute.js";
import { runAdapterExecutionTargetProcess } from "@tickernelz/wardmote-adapter-utils/execution-target";

const runProcessMock = vi.mocked(runAdapterExecutionTargetProcess);

const VISION_REJECTION =
  "400 The request contains image input, but this combo has no confirmed vision-capable target (type=invalid_request_error)";

function failedTurn(errorMessage: string) {
  return `${JSON.stringify({
    type: "message_end",
    messageId: "msg-2",
    message: {
      role: "assistant",
      content: [],
      provider: "sub2api-deepseek",
      model: "deepseek-flash",
      stopReason: "error",
      errorStatus: Number(errorMessage.slice(0, 3)),
      errorMessage,
    },
  })}\n`;
}

type Outcome = { exitCode: number; stdout: string };

describe("OMP provider request rejection", () => {
  let root: string;
  let workspaceCwd: string;
  let commandPath: string;
  let calls: string[][];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "wardmote-omp-rejection-"));
    workspaceCwd = path.join(root, "workspace");
    commandPath = path.join(root, "fake-omp");
    await fs.mkdir(workspaceCwd, { recursive: true });
    await fs.writeFile(commandPath, "#!/bin/sh\nexit 0\n", "utf8");
    await fs.chmod(commandPath, 0o755);
    calls = [];
    runProcessMock.mockReset();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function run(outcomes: Outcome[], extra: { config?: Record<string, unknown>; context?: Record<string, unknown> } = {}) {
    runProcessMock.mockImplementation((async (
      _runId: string,
      _target: unknown,
      _command: string,
      args: string[],
      options: { onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void> },
    ) => {
      calls.push(args);
      const outcome = outcomes[Math.min(calls.length - 1, outcomes.length - 1)]!;
      if (outcome.stdout) await options.onLog("stdout", outcome.stdout);
      return {
        exitCode: outcome.exitCode,
        signal: null,
        timedOut: false,
        stdout: outcome.stdout,
        stderr: "",
        pid: 4321,
        startedAt: new Date().toISOString(),
      };
    }) as never);
    return execute({
      runId: "run-rejection",
      agent: { id: "agent-1", companyId: "company-1", name: "OMP", adapterType: "omp_local", adapterConfig: {} },
      runtime: {
        sessionId: "saved-session",
        sessionParams: { sessionId: "saved-session", cwd: workspaceCwd },
        sessionDisplayId: "saved-session",
        taskKey: "task-1",
      },
      config: { command: commandPath, cwd: workspaceCwd, rpcSteering: false, wardmoteMcp: false, ...extra.config },
      context: extra.context ?? {},
      onLog: async () => {},
    });
  }

  it("retries a rejected resumed session once on a fresh session", async () => {
    const result = await run([
      { exitCode: 1, stdout: failedTurn(VISION_REJECTION) },
      { exitCode: 0, stdout: "" },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("--resume");
    expect(calls[1]).not.toContain("--resume");
    expect(result.exitCode).toBe(0);
    expect(result.errorCode).toBeUndefined();
  });

  it("reports the rejection family when the fresh session is rejected too", async () => {
    const result = await run([{ exitCode: 1, stdout: failedTurn(VISION_REJECTION) }]);
    expect(calls).toHaveLength(2);
    expect(calls[1]).not.toContain("--resume");
    expect(result.errorCode).toBe("omp_provider_request_rejected");
    expect(result.errorFamily).toBe("provider_request_rejected");
    expect(result.errorMessage).toContain("invalid_request_error");
  });

  const PROMPT_TOO_LONG = '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 1194922 tokens > 1000000 maximum"}}';

  function longConversationWake() {
    const messages = Array.from({ length: 1500 }, (_value, index) => {
      const at = new Date(Date.UTC(2026, 10, 1) + index * 60_000).toISOString();
      return {
        id: `c-${index}`, authorType: index % 3 === 2 ? "agent" : "user", authorId: "author-1",
        body: `pesan grup ${index} ${"x".repeat(900)}`, createdAt: at, updatedAt: at, deleted: false, sourceTrust: null,
      };
    });
    return {
      reason: "issue_commented",
      issue: { id: "issue-1", identifier: "ZHA-1", title: "Grup", status: "in_progress" },
      executionContinuation: {
        version: 1, companyId: "company-1", issueId: "issue-1",
        trigger: { reason: "issue_commented", interactionId: null, sourceRunId: null },
        originCommentIds: ["c-1499"], objective: "jawab grup", messages, interactionOutcomes: [], completedWork: null,
        unresolvedInteractionIds: [],
        coverage: { kind: "full_task_history", throughCommentId: "c-1499", summaryThroughCommentId: null },
      },
    };
  }

  async function withModelCatalog(contextWindow: number) {
    await fs.writeFile(
      commandPath,
      `#!/bin/sh\nif [ "$1" = "models" ]; then echo '{"models":[{"provider":"fake","id":"small","selector":"fake/small","contextWindow":${contextWindow}}]}'; fi\nexit 0\n`,
      "utf8",
    );
    return { config: { model: "fake/small" }, context: { wardmoteWake: longConversationWake() } };
  }

  function historyWindows(result: Awaited<ReturnType<typeof run>>) {
    return (result.resultJson as { historyWindows?: Array<{ attempt: number; budgetTokens: number; historyTokensAfter: number; contextWindow: number | null }> }).historyWindows ?? [];
  }

  it("retries a too-long prompt on a fresh session with the history cut to the model's context budget and does not report a failure", async () => {
    const result = await run([
      { exitCode: 1, stdout: failedTurn(PROMPT_TOO_LONG) },
      { exitCode: 0, stdout: "" },
    ], await withModelCatalog(40_000));
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("--resume");
    expect(calls[1]).not.toContain("--resume");
    expect(calls[1]!.at(-1)).toContain("Older history is omitted to fit the model's context window");
    expect(result.exitCode).toBe(0);
    expect(result.errorFamily).toBeUndefined();
    expect(historyWindows(result)).toEqual([
      expect.objectContaining({ attempt: 1, contextWindow: 40_000, budgetTokens: 16_000 }),
    ]);
    expect(historyWindows(result)[0]!.historyTokensAfter).toBeLessThanOrEqual(16_000);
  });

  it("halves the history window on every further rejection and reports prompt_too_long once the retries run out", async () => {
    const result = await run([{ exitCode: 1, stdout: failedTurn(PROMPT_TOO_LONG) }], await withModelCatalog(40_000));
    const windows = historyWindows(result);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.length).toBeLessThanOrEqual(4);
    expect(calls.slice(1).every((args) => !args.includes("--resume"))).toBe(true);
    for (let index = 1; index < windows.length; index += 1) {
      expect(windows[index]!.historyTokensAfter).toBeLessThan(windows[index - 1]!.historyTokensAfter);
    }
    expect(result.errorCode).toBe("omp_prompt_too_long");
    expect(result.errorFamily).toBe("prompt_too_long");
  });

  it("keeps a 5xx failure on the existing path without a fresh-session retry", async () => {
    const result = await run([{ exitCode: 1, stdout: failedTurn("502 Bad gateway (type=api_error)") }]);
    expect(calls).toHaveLength(1);
    expect(result.errorFamily).toBe("transient_upstream");
  });
});
