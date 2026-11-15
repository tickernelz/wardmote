// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentRunCard } from "./AgentRunCard";

const mockIssuesApi = vi.hoisted(() => ({
  get: vi.fn(),
  getAgentTodo: vi.fn(),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("./RunChatSurface", () => ({
  RunChatSurface: () => <div>Run output</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function createRun(index: number) {
  return {
    id: `run-${index}`,
    status: "running",
    invocationSource: "assignment",
    triggerDetail: null,
    startedAt: "2026-04-24T12:00:00.000Z",
    finishedAt: null,
    createdAt: `2026-04-24T12:00:0${index}.000Z`,
    agentId: `agent-${index}`,
    agentName: `Agent ${index}`,
    adapterType: "codex_local",
    issueId: null,
  };
}

function createIssueRun(index: number, issueId: string) {
  return {
    ...createRun(index),
    issueId,
  };
}

function withQueryClient(node: ReactNode) {
  return (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>
  );
}

describe("AgentRunCard", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockIssuesApi.get.mockRejectedValue(new Error("Issue not found"));
    mockIssuesApi.getAgentTodo.mockResolvedValue({ snapshot: null });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("keeps run outcomes distinct from the linked task status", async () => {
    const root = createRoot(container);
    const statuses = ["running", "queued", "succeeded", "failed", "timed_out", "cancelled", "interrupted"];
    await act(async () => {
      root.render(withQueryClient(<>{statuses.map((status, index) => (
        <AgentRunCard
          key={status}
          companyId="company-1"
          run={{ ...createIssueRun(index, "issue-1"), status }}
          issue={{ title: "Review release notes", identifier: "PAP-559", status: "in_review" }}
        />
      ))}</>));
    });
    const headers = [...container.querySelectorAll('a[aria-label$=". View run"]')];
    expect(headers.map((header) => header.getAttribute("aria-label"))).toEqual([
      "Agent 0 — Running. View run", "Agent 1 — Queued. View run",
      "Agent 2 — Succeeded. View run", "Agent 3 — Failed. View run",
      "Agent 4 — Timed out. View run", "Agent 5 — Cancelled. View run",
      "Agent 6 — Interrupted. View run",
    ]);
    expect(headers.every((header) => header.querySelector("svg") === null)).toBe(true);
    expect(container.querySelector(".status-chip")).toBeNull();
    expect(container.querySelectorAll('[aria-label="Task in review"]')).toHaveLength(7);
    expect(container.querySelectorAll(".motion-safe\\:animate-spin")).toHaveLength(0);
    expect(container.querySelector('a[aria-label="Agent 0 — Running. View run"]')?.getAttribute("href"))
      .toBe("/agents/agent-0/runs/run-0");
    await act(async () => root.unmount());
  });

  it("shows an answered Slack task as idle without changing the run outcome", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<AgentRunCard companyId="company-1"
        run={{ ...createIssueRun(0, "issue-1"), status: "succeeded" }}
        issue={{ title: "Slack conversation", identifier: "PAP-559", status: "in_review", externalConversationState: "waiting" }} />);
    });
    expect(container.querySelector('[aria-label="Agent 0 — Succeeded. View run"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Task idle"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Task in review"]')).toBeNull();
    await act(async () => root.unmount());
  });

  it("keeps a failed task lookup navigable and shows a clear error", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(withQueryClient(<AgentRunCard companyId="company-1" run={createIssueRun(1, "issue-missing")} issueLoadFailed />));
    });
    expect(container.textContent).toContain("Task unavailable");
    expect(container.querySelector('a[href="/issues/issue-missing"]')).not.toBeNull();
    await act(async () => root.unmount());
  });

  it("does not animate running records while execution is reconnecting", async () => {
    const root = createRoot(container);
    await act(async () => {
      root.render(<AgentRunCard
        companyId="company-1"
        run={{
          ...createRun(0),
          execution: {
            phase: "reconnecting", label: "Reconnecting", cause: null,
            lastConfirmedActivityAt: null, retryAt: null, attempt: 1, maxAttempts: 3,
            recoveryOwner: "agent", nextAction: null, permittedActions: ["inspect_run"],
            predecessorRunId: null, successorRunId: null,
          },
        }}
      />);
    });
    expect(container.querySelector('a[aria-label="Agent 0 — Running. View run"]')).not.toBeNull();
    expect(container.querySelector(".status-chip")).toBeNull();
    expect(container.querySelectorAll(".motion-safe\\:animate-spin")).toHaveLength(0);
    await act(async () => root.unmount());
  });

  it("shows the live run's current todo on its card, but not on a finished run's own todo", async () => {
    const todo = (runId: string, issueId: string, content: string) => ({
      version: 1,
      source: "omp",
      op: "update",
      phases: [{ name: "Fix", tasks: [{ content: "Done step", status: "completed" }, { content, status: "in_progress" }, { content: "Later step", status: "pending" }] }],
      counts: { total: 3, completed: 1, inProgress: 1, pending: 1, blocked: 0, dropped: 0 },
      runId,
      agentId: "agent-0",
      issueId,
      seq: 1,
      createdAt: "2026-04-24T12:00:00.000Z",
      runStatus: "running",
    });
    mockIssuesApi.getAgentTodo.mockImplementation(async (issueId: string) => ({
      snapshot: issueId === "issue-1" ? todo("run-0", "issue-1", "Locate the bug") : todo("run-1", "issue-2", "Finished run step"),
    }));
    const root = createRoot(container);
    await act(async () => {
      root.render(withQueryClient(<>
        <AgentRunCard companyId="company-1" run={createIssueRun(0, "issue-1")} />
        <AgentRunCard companyId="company-1" run={{ ...createIssueRun(1, "issue-2"), status: "succeeded" }} />
      </>));
    });
    await flushReact();
    const lines = container.querySelectorAll('[data-slot="tasks-live-now-todo"]');
    expect(lines).toHaveLength(1);
    expect(lines[0]?.textContent).toContain("Locate the bug");
    expect(lines[0]?.textContent).toContain("1/3");
    expect(container.textContent).not.toContain("Finished run step");
    expect(container.textContent).not.toContain("Later step");
    await act(async () => root.unmount());
  });
});
