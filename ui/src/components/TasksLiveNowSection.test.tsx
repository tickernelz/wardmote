// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue } from "@tickernelz/wardmote-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveRunForIssue } from "../api/heartbeats";
import { ToastProvider } from "../context/ToastContext";
import {
  TasksLiveNowSection,
  liveNowCollapsedStorageKey,
  liveNowDensityStorageKey,
} from "./TasksLiveNowSection";
import { classifyLiveNowHealth, countLiveNowHealth } from "./live-now/live-now-health";
import { buildLiveNowEntries, buildLiveNowHeartbeats } from "./live-now/useLiveNowModel";

const mockIssuesApi = vi.hoisted(() => ({
  get: vi.fn(),
  addComment: vi.fn(),
  restorePrimaryModel: vi.fn(),
  listPausedTasks: vi.fn(),
  createTreeHold: vi.fn(),
  releaseTreeHold: vi.fn(),
}));
const mockHeartbeatsApi = vi.hoisted(() => ({ cancel: vi.fn() }));

vi.mock("../api/issues", () => ({ issuesApi: mockIssuesApi }));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: mockHeartbeatsApi }));

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    state: _state,
    issuePrefetch: _issuePrefetch,
    disableIssueQuicklook: _disableIssueQuicklook,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string;
    state?: unknown;
    issuePrefetch?: unknown;
    disableIssueQuicklook?: boolean;
  }) => <a href={to} {...props}>{children}</a>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function run(overrides: Partial<LiveRunForIssue>): LiveRunForIssue {
  return {
    id: "run-1",
    status: "running",
    invocationSource: "assignment",
    triggerDetail: null,
    startedAt: "2026-10-08T10:00:00.000Z",
    finishedAt: null,
    createdAt: "2026-10-08T10:00:00.000Z",
    agentId: "agent-1",
    agentName: "Builder",
    adapterType: "process",
    issueId: "issue-1",
    ...overrides,
  };
}

function issue(overrides: Partial<Issue>): Issue {
  return {
    id: "issue-1",
    identifier: "ZHA-1",
    title: "Task",
    status: "in_progress",
    priority: "medium",
    parentId: null,
    ...overrides,
  } as Issue;
}

let container: HTMLDivElement;
let root: Root | null = null;

function render(node: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  flushSync(() => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>{node}</ToastProvider>
      </QueryClientProvider>,
    );
  });
}

async function waitFor(assertion: () => void) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  throw lastError;
}

function liveRows() {
  return [...container.querySelectorAll<HTMLElement>("[data-live-now-issue-id]")];
}

function openMoreMenu(row: HTMLElement) {
  const trigger = row.querySelector<HTMLButtonElement>("button[aria-label^='More actions for']")!;
  flushSync(() => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
}

function menuItem(text: string) {
  return [...document.body.querySelectorAll<HTMLElement>("[role='menuitem']")].find((item) => item.textContent?.includes(text));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  localStorage.clear();
  mockIssuesApi.get.mockReset();
  mockIssuesApi.addComment.mockReset();
  mockIssuesApi.restorePrimaryModel.mockReset();
  mockIssuesApi.listPausedTasks.mockReset().mockResolvedValue([]);
  mockIssuesApi.createTreeHold.mockReset();
  mockIssuesApi.releaseTreeHold.mockReset();
  mockHeartbeatsApi.cancel.mockReset();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("buildLiveNowEntries", () => {
  it("merges runs on one task into one entry, newest start first", () => {
    const entries = buildLiveNowEntries([
      run({ id: "a", issueId: "issue-1", startedAt: "2026-10-08T10:00:00.000Z" }),
      run({ id: "b", issueId: "issue-2", startedAt: "2026-10-08T10:05:00.000Z" }),
      run({ id: "c", issueId: "issue-1", agentId: "agent-2", startedAt: "2026-10-08T10:10:00.000Z" }),
      run({ id: "d", issueId: "issue-3", status: "succeeded" }),
      run({ id: "e", issueId: null }),
    ], new Map());
    expect(entries.map((entry) => [entry.issueId, entry.runs.map((r) => r.id)])).toEqual([
      ["issue-1", ["c", "a"]],
      ["issue-2", ["b"]],
    ]);
    expect(entries[0]!.earliestStartedAt).toBe("2026-10-08T10:00:00.000Z");
  });

  it("drops runs whose task is already done or cancelled", () => {
    expect(buildLiveNowEntries([run({ issueId: "issue-1" })], new Map([["issue-1", "done"]]))).toEqual([]);
  });
});

describe("TasksLiveNowSection", () => {
  const comfortable = () => localStorage.setItem(liveNowDensityStorageKey("company-1"), "comfortable");

  it("shows a live task from an unloaded page with its parent path from the detail ancestors", async () => {
    comfortable();
    mockIssuesApi.get.mockResolvedValue(issue({
      id: "issue-9",
      identifier: "ZHA-723",
      title: "Deep task",
      parentId: "parent-2",
      ancestors: [
        { id: "parent-2", identifier: "ZHA-500", title: "Middle" },
        { id: "parent-1", identifier: "ZHA-379", title: "Root" },
      ],
    } as Partial<Issue>));

    render(
      <TasksLiveNowSection
        companyId="company-1"
        liveRuns={[run({ issueId: "issue-9", currentStatusMessage: "Running tests" })]}
        issues={[issue({ id: "loaded-1", identifier: "ZHA-1" })]}
      />,
    );

    await waitFor(() => {
      const rows = liveRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.textContent).toContain("ZHA-723");
      expect(rows[0]!.textContent).toContain("Deep task");
      const path = rows[0]!.querySelector("[data-slot='tasks-live-now-path']");
      expect([...path!.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
        ["ZHA-379", "/issues/ZHA-379"],
        ["ZHA-500", "/issues/ZHA-500"],
      ]);
      expect(rows[0]!.textContent).toContain("Running tests");
    });
    expect(mockIssuesApi.get).toHaveBeenCalledWith("issue-9");
    expect(container.querySelector("[data-slot='tasks-live-now-count']")?.textContent).toBe("1");
  });

  it("builds the parent path from loaded tasks and caps it at three ancestors", () => {
    comfortable();
    const loaded = [
      issue({ id: "p1", identifier: "ZHA-1", parentId: null }),
      issue({ id: "p2", identifier: "ZHA-2", parentId: "p1" }),
      issue({ id: "p3", identifier: "ZHA-3", parentId: "p2" }),
      issue({ id: "p4", identifier: "ZHA-4", parentId: "p3" }),
      issue({ id: "leaf", identifier: "ZHA-5", parentId: "p4", title: "Leaf" }),
    ];
    render(<TasksLiveNowSection companyId="company-1" liveRuns={[run({ issueId: "leaf" })]} issues={loaded} />);

    const path = liveRows()[0]!.querySelector("[data-slot='tasks-live-now-path']")!;
    expect([...path.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["ZHA-2", "ZHA-3", "ZHA-4"]);
    expect(path.textContent).toContain("…");
    expect(mockIssuesApi.get).not.toHaveBeenCalled();
  });

  it("renders one row listing every agent when two runs share a task", () => {
    comfortable();
    render(
      <TasksLiveNowSection
        companyId="company-1"
        liveRuns={[
          run({ id: "r1", agentId: "agent-1", agentName: "Builder" }),
          run({ id: "r2", agentId: "agent-2", agentName: "Reviewer", startedAt: "2026-10-08T10:02:00.000Z" }),
        ]}
        issues={[issue({ id: "issue-1", identifier: "ZHA-1", title: "Shared" })]}
      />,
    );

    const rows = liveRows();
    expect(rows).toHaveLength(1);
    const names = [...rows[0]!.querySelectorAll("[title]")].map((el) => el.getAttribute("title"));
    expect(names).toEqual(expect.arrayContaining(["Builder", "Reviewer"]));
  });

  it("renders nothing when no task is live", () => {
    render(
      <TasksLiveNowSection
        companyId="company-1"
        liveRuns={[run({ status: "succeeded" })]}
        issues={[issue({})]}
      />,
    );
    expect(container.querySelector("section")).toBeNull();
    expect(liveRows()).toHaveLength(0);
  });

  it("persists the collapsed state per company", () => {
    const props = {
      companyId: "company-1",
      liveRuns: [run({})],
      issues: [issue({})],
    };
    render(<TasksLiveNowSection {...props} />);
    expect(liveRows()).toHaveLength(1);

    const toggle = container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    flushSync(() => toggle.click());
    expect(liveRows()).toHaveLength(0);
    expect(localStorage.getItem(liveNowCollapsedStorageKey("company-1"))).toBe("true");

    flushSync(() => root!.unmount());
    render(<TasksLiveNowSection {...props} />);
    expect(container.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe("false");
    expect(liveRows()).toHaveLength(0);

    flushSync(() => root!.unmount());
    render(<TasksLiveNowSection {...props} companyId="company-2" />);
    expect(liveRows()).toHaveLength(1);
  });
});

const NOW = new Date("2026-10-08T10:30:00.000Z").getTime();
const at = (msBeforeNow: number) => new Date(NOW - msBeforeNow).toISOString();

function silence(level: "ok" | "suspicious" | "critical", ageMs: number): NonNullable<LiveRunForIssue["outputSilence"]> {
  return {
    lastOutputAt: at(ageMs),
    lastOutputSeq: 3,
    lastOutputStream: "stdout",
    silenceStartedAt: at(ageMs),
    silenceAgeMs: ageMs,
    level,
    suspicionThresholdMs: 5 * 60_000,
    criticalThresholdMs: 15 * 60_000,
    snoozedUntil: null,
    evaluationIssueId: null,
    evaluationIssueIdentifier: null,
    evaluationIssueAssigneeAgentId: null,
  };
}

const healthFixtures = {
  justStarted: run({ id: "start", startedAt: at(10_000), createdAt: at(12_000) }),
  queued: run({ id: "queued", status: "queued", startedAt: null, createdAt: at(5_000) }),
  active: run({
    id: "active",
    startedAt: at(14 * 60_000),
    currentToolName: "bash",
    currentStatusMessage: "Running bash",
    lastAssistantSnippet: "Rebasing before the push.",
    lastEventAt: at(6_000),
  }),
  thinking: run({ id: "thinking", startedAt: at(6 * 60_000), currentStatusMessage: "Thinking", lastEventAt: at(20_000) }),
  finishedTool: run({
    id: "finished",
    startedAt: at(6 * 60_000),
    currentToolName: "fabric_exec",
    currentStatusMessage: "Finished fabric_exec",
    lastEventAt: at(30_000),
  }),
  quietBySilence: run({ id: "quiet-silence", startedAt: at(20 * 60_000), lastEventAt: at(6 * 60_000), outputSilence: silence("suspicious", 6 * 60_000) }),
  quietByClock: run({ id: "quiet-clock", startedAt: at(20 * 60_000), currentToolName: "wait", lastEventAt: at(4 * 60_000) }),
  stalledByWatchdog: run({ id: "stalled-watchdog", startedAt: at(40 * 60_000), lastEventAt: at(2 * 60_000), outputSilence: silence("critical", 19 * 60_000) }),
  stalledByClock: run({ id: "stalled-clock", startedAt: at(60 * 60_000), lastEventAt: at(25 * 60_000) }),
};

describe("classifyLiveNowHealth", () => {
  it.each([
    ["justStarted", "starting", "Starting"],
    ["queued", "starting", "Queued"],
    ["active", "active", "Working"],
    ["thinking", "thinking", "Thinking"],
    ["finishedTool", "thinking", "Thinking"],
    ["quietBySilence", "quiet", "Quiet 6m"],
    ["quietByClock", "quiet", "Quiet 4m"],
    ["stalledByWatchdog", "stalled", "Stalled 2m"],
    ["stalledByClock", "stalled", "Stalled 25m"],
  ] as const)("classifies the %s fixture as %s", (fixture, health, label) => {
    expect(classifyLiveNowHealth(healthFixtures[fixture], NOW)).toMatchObject({ health, label });
  });

  it("counts working, quiet and stalled tasks", () => {
    expect(countLiveNowHealth(["active", "thinking", "starting", "quiet", "stalled", "stalled"])).toEqual({
      working: 3,
      quiet: 1,
      stalled: 2,
    });
  });
});

describe("Live now cards", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("shows the agent, health and current tool, keeps the latest snippet in the tooltip, and puts stalled tasks first", () => {
    render(
      <TasksLiveNowSection
        companyId="company-1"
        liveRuns={[
          { ...healthFixtures.active, issueId: "issue-1" },
          { ...healthFixtures.stalledByClock, issueId: "issue-2", agentId: "agent-2", agentName: "Operator" },
        ]}
        issues={[issue({ id: "issue-1", identifier: "ZHA-1" }), issue({ id: "issue-2", identifier: "ZHA-2" })]}
      />,
    );

    const rows = liveRows();
    expect(rows.map((row) => [row.dataset.liveNowIssueId, row.dataset.liveHealth])).toEqual([
      ["issue-2", "stalled"],
      ["issue-1", "active"],
    ]);
    const active = rows[1]!;
    expect(active.querySelector("[data-slot='tasks-live-now-health']")?.textContent).toBe("Working");
    expect(active.querySelector("[data-slot='tasks-live-now-status']")?.textContent).toContain("Running bash");
    expect(active.querySelector("[data-slot='tasks-live-now-status'] svg")).not.toBeNull();
    expect(active.querySelector("[data-slot='tasks-live-now-status']")?.getAttribute("title")).toContain("Rebasing before the push.");
    expect(container.querySelector("[data-slot='tasks-live-now-groups']")?.textContent).toContain("Needs attention 1");
    expect([...container.querySelectorAll("[data-live-now-group]")].map((group) => group.getAttribute("data-live-now-group"))).toEqual([
      "attention",
      "working",
    ]);
  });

  it("shows a model fallback badge only for a run on a fallback model", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        fields: [{
          key: "model",
          label: "Model",
          type: "combobox",
          options: [{ value: "openai/gpt-5", label: "GPT-5 (openai/gpt-5)", group: "OpenAI", name: "GPT-5" }],
        }],
      }),
    })));
    render(
      <TasksLiveNowSection
        companyId="company-1"
        liveRuns={[
          run({
            adapterType: "omp_local",
            modelFallback: {
              primaryModel: "anthropic/opus",
              activeModel: "openai/gpt-5:high",
              reason: "rate_limit",
              switchedAt: "2026-10-08T10:01:00.000Z",
            },
          }),
          run({ id: "run-2", issueId: "issue-2", agentId: "agent-2", agentName: "Operator", modelFallback: null }),
        ]}
        issues={[issue({ id: "issue-1", identifier: "ZHA-1" }), issue({ id: "issue-2", identifier: "ZHA-2" })]}
      />,
    );

    const byIssue = (id: string) => liveRows().find((row) => row.dataset.liveNowIssueId === id)!;
    await waitFor(() => {
      const badge = byIssue("issue-1").querySelector("[data-slot='live-now-model-fallback']");
      expect(badge?.textContent).toContain("GPT-5 · OpenAI");
      expect(badge?.querySelector(".text-ink-3")?.textContent).toBe(" · primary: rate limit");
    });
    expect(byIssue("issue-2").querySelector("[data-slot='live-now-model-fallback']")).toBeNull();
  });

  it("takes a task back to the primary model from the card", async () => {
    render(
      <TasksLiveNowSection
        companyId="company-1"
        liveRuns={[
          run({
            adapterType: "omp_local",
            modelFallback: {
              primaryModel: "anthropic/opus",
              activeModel: "openai/gpt-5:high",
              reason: "rate_limit",
              switchedAt: "2026-10-08T10:01:00.000Z",
            },
          }),
          run({ id: "run-2", issueId: "issue-2", agentId: "agent-2", agentName: "Operator", modelFallback: null }),
        ]}
        issues={[issue({ id: "issue-1", identifier: "ZHA-1" }), issue({ id: "issue-2", identifier: "ZHA-2" })]}
      />,
    );

    const byIssue = (id: string) => liveRows().find((row) => row.dataset.liveNowIssueId === id)!;
    expect(byIssue("issue-2").querySelector("[data-slot='restore-primary-model']")).toBeNull();

    const control = byIssue("issue-1").querySelector<HTMLElement>("[data-slot='restore-primary-model']")!;
    expect(control.textContent).toContain("Back to primary model");
    flushSync(() => control.querySelector<HTMLButtonElement>("button")!.click());
    await waitFor(() => expect(document.body.querySelector("[role='alertdialog']")).not.toBeNull());
    expect(mockIssuesApi.restorePrimaryModel).not.toHaveBeenCalled();

    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>("[role='alertdialog'] button")].find(
      (button) => button.textContent === "Stop and switch",
    )!;
    flushSync(() => confirm.click());
    await waitFor(() => expect(mockIssuesApi.restorePrimaryModel).toHaveBeenCalledWith("issue-1"));
    expect(mockHeartbeatsApi.cancel).not.toHaveBeenCalled();
    expect(mockIssuesApi.addComment).not.toHaveBeenCalled();
  });

  it("links to the task from the row and to the live run transcript from the More menu", async () => {
    render(<TasksLiveNowSection companyId="company-1" liveRuns={[run({})]} issues={[issue({})]} />);

    const row = liveRows()[0]!;
    expect(row.querySelector("a[aria-label='Open ZHA-1']")?.getAttribute("href")).toBe("/issues/ZHA-1");
    openMoreMenu(row);
    await waitFor(() => expect(menuItem("Run transcript")).toBeDefined());
    expect(menuItem("Run transcript")!.getAttribute("href")).toBe("/agents/agent-1/runs/run-1");
    expect(menuItem("Open task")!.getAttribute("href")).toBe("/issues/ZHA-1");
  });

  it("steers the running turn from the card composer", async () => {
    mockIssuesApi.addComment.mockResolvedValue({ id: "comment-1", deliveredAs: "steered" });
    render(<TasksLiveNowSection companyId="company-1" liveRuns={[run({})]} issues={[issue({})]} />);

    const steer = liveRows()[0]!.querySelector<HTMLButtonElement>("button[aria-label='Steer Builder on ZHA-1']")!;
    expect(steer.getAttribute("aria-expanded")).toBe("false");
    flushSync(() => steer.click());
    expect(steer.getAttribute("aria-expanded")).toBe("true");

    const textarea = container.querySelector<HTMLTextAreaElement>("[data-slot='tasks-live-now-steer'] textarea")!;
    expect(document.activeElement).toBe(textarea);
    flushSync(() => setTextareaValue(textarea, "  check the failing test  "));
    flushSync(() => container.querySelector<HTMLButtonElement>("[data-slot='tasks-live-now-steer'] button[type='submit']")!.click());

    await waitFor(() => expect(container.querySelector("[data-slot='tasks-live-now-steer']")).toBeNull());
    expect(mockIssuesApi.addComment).toHaveBeenCalledWith(
      "issue-1",
      "check the failing test",
      undefined,
      undefined,
      undefined,
      expect.any(String),
      "steer",
    );
    expect(liveRows()[0]!.querySelector("[role='status']")?.textContent).toBe("Steered into Builder's turn");
  });

  it("offers Stop only in the More menu and asks for the same confirmation before stopping the run", async () => {
    mockHeartbeatsApi.cancel.mockResolvedValue(undefined);
    render(<TasksLiveNowSection companyId="company-1" liveRuns={[run({})]} issues={[issue({})]} />);

    const stopFromMenu = async () => {
      openMoreMenu(liveRows()[0]!);
      await waitFor(() => expect(menuItem("Stop run")).toBeDefined());
      const item = menuItem("Stop run")!;
      expect(item.getAttribute("aria-label")).toBe("Stop Builder's run on ZHA-1");
      flushSync(() => item.click());
    };

    expect(liveRows()[0]!.querySelector("button[aria-label=\"Stop Builder's run on ZHA-1\"]")).toBeNull();
    await stopFromMenu();
    await waitFor(() => expect(document.body.querySelector("[role='alertdialog']")).not.toBeNull());
    expect(mockHeartbeatsApi.cancel).not.toHaveBeenCalled();

    const dialog = document.body.querySelector<HTMLElement>("[role='alertdialog']")!;
    const cancel = [...dialog.querySelectorAll("button")].find((button) => button.textContent === "Keep running")!;
    flushSync(() => cancel.click());
    await waitFor(() => expect(document.body.querySelector("[role='alertdialog']")).toBeNull());
    expect(mockHeartbeatsApi.cancel).not.toHaveBeenCalled();

    await stopFromMenu();
    await waitFor(() => expect(document.body.querySelector("[role='alertdialog']")).not.toBeNull());
    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>("[role='alertdialog'] button")].find(
      (button) => button.textContent === "Stop run",
    )!;
    flushSync(() => confirm.click());
    await waitFor(() => expect(mockHeartbeatsApi.cancel).toHaveBeenCalledWith("run-1"));
  });

  it("pauses a task at a safe point from its row, and offers Pause instead of a hard Stop", async () => {
    mockIssuesApi.listPausedTasks.mockResolvedValue([]);
    mockIssuesApi.createTreeHold.mockResolvedValue({ hold: { id: "hold-1" }, preview: { activeRuns: [] } });
    render(<TasksLiveNowSection companyId="company-1" liveRuns={[run({ safePointPause: true })]} issues={[issue({})]} />);

    const pause = liveRows()[0]!.querySelector<HTMLButtonElement>("button[aria-label='Pause ZHA-1']")!;
    flushSync(() => pause.click());
    await waitFor(() =>
      expect(mockIssuesApi.createTreeHold).toHaveBeenCalledWith("issue-1", expect.objectContaining({ mode: "pause", scope: "task", stopAt: "safe_point" })),
    );

    openMoreMenu(liveRows()[0]!);
    await waitFor(() => expect(menuItem("Pause subtree")).toBeDefined());
    flushSync(() => menuItem("Pause subtree")!.click());
    await waitFor(() =>
      expect(mockIssuesApi.createTreeHold).toHaveBeenLastCalledWith("issue-1", expect.objectContaining({ scope: "subtree", stopAt: "safe_point" })),
    );

    openMoreMenu(liveRows()[0]!);
    await waitFor(() => expect(menuItem("Stop run")).toBeDefined());
    flushSync(() => menuItem("Stop run")!.click());
    await waitFor(() => expect(document.body.querySelector("[role='alertdialog']")).not.toBeNull());
    const instead = [...document.body.querySelectorAll<HTMLButtonElement>("[role='alertdialog'] button")].find(
      (button) => button.textContent === "Pause instead",
    )!;
    flushSync(() => instead.click());
    await waitFor(() => expect(mockIssuesApi.createTreeHold).toHaveBeenCalledTimes(3));
    expect(mockHeartbeatsApi.cancel).not.toHaveBeenCalled();
  });

  it("never offers Pause where it cannot keep the session: a run without a safe point or a conversation", () => {
    mockIssuesApi.listPausedTasks.mockResolvedValue([]);
    render(
      <TasksLiveNowSection
        companyId="company-1"
        liveRuns={[
          run({ id: "run-1", issueId: "issue-1", safePointPause: false }),
          run({ id: "run-2", issueId: "issue-2", safePointPause: true }),
        ]}
        issues={[
          issue({ id: "issue-1", identifier: "ZHA-1" }),
          issue({ id: "issue-2", identifier: "ZHA-2", conversationAgentId: "agent-1" } as Partial<Issue>),
        ]}
      />,
    );
    const blocked = container.querySelector<HTMLButtonElement>("button[aria-label='Pause ZHA-1']")!;
    expect(blocked.getAttribute("aria-disabled")).toBe("true");
    expect(blocked.title).toBe("This run can’t stop at a safe point. Use Stop run in More.");
    flushSync(() => blocked.click());
    expect(mockIssuesApi.createTreeHold).not.toHaveBeenCalled();
    expect(container.querySelector("button[aria-label='Pause ZHA-2']")).toBeNull();
  });

  it("shows a pausing task as Pausing with Stop now, and a paused task with no run in the Paused group with Resume", async () => {
    mockHeartbeatsApi.cancel.mockResolvedValue(undefined);
    mockIssuesApi.releaseTreeHold.mockResolvedValue({ id: "hold-2" });
    mockIssuesApi.listPausedTasks.mockResolvedValue([
      {
        holdId: "hold-1", issueId: "issue-1", identifier: "ZHA-1", title: "Task", status: "in_progress", scope: "task",
        assigneeAgentId: "agent-1", assigneeAgentName: "Builder", pausedAt: "2026-10-08T10:05:00.000Z", pausedByUserId: "user-1",
        pausedByAgentId: null, reason: null, state: "pausing", liveRunId: "run-1", lastRun: null,
      },
      {
        holdId: "hold-2", issueId: "issue-9", identifier: "ZHA-9", title: "Waiting task", status: "in_progress", scope: "task",
        assigneeAgentId: "agent-2", assigneeAgentName: "Reviewer", pausedAt: "2026-10-08T09:00:00.000Z", pausedByUserId: "user-1",
        pausedByAgentId: null, reason: null, state: "paused", liveRunId: null,
        lastRun: { id: "run-9", status: "cancelled", finishedAt: "2026-10-08T09:00:30.000Z", safePoint: "reached" },
      },
    ]);
    render(<TasksLiveNowSection companyId="company-1" liveRuns={[run({ safePointPause: true })]} issues={[issue({})]} />);

    await waitFor(() => expect(container.querySelector("[data-live-now-group='paused']")).not.toBeNull());
    const pausing = container.querySelector<HTMLElement>("[data-live-now-issue-id='issue-1']")!;
    expect(pausing.dataset.liveHealth).toBe("pausing");
    expect(pausing.querySelector<HTMLButtonElement>("button[aria-label='Pausing ZHA-1']")!.disabled).toBe(true);
    const paused = container.querySelector<HTMLElement>("[data-live-now-group='paused'] [data-live-now-issue-id='issue-9']")!;
    expect(paused.textContent).toContain("Paused");
    expect(paused.textContent).toContain("Stopped after its current step");

    openMoreMenu(pausing);
    await waitFor(() => expect(menuItem("Stop now")).toBeDefined());
    flushSync(() => menuItem("Stop now")!.click());
    await waitFor(() => expect(mockHeartbeatsApi.cancel).toHaveBeenCalledWith("run-1"));
    expect(document.body.querySelector("[role='alertdialog']")).toBeNull();

    flushSync(() => paused.querySelector<HTMLButtonElement>("button[aria-label='Resume ZHA-9']")!.click());
    await waitFor(() =>
      expect(mockIssuesApi.releaseTreeHold).toHaveBeenCalledWith("issue-9", "hold-2", { reason: null, metadata: { wakeAgents: true } }),
    );
  });

  it("collapses to a strip of agent avatars that expands again on click", () => {
    render(
      <TasksLiveNowSection
        companyId="company-1"
        liveRuns={[
          { ...healthFixtures.active, id: "r1", issueId: "issue-1", agentId: "agent-1", agentName: "Builder" },
          { ...healthFixtures.thinking, id: "r2", issueId: "issue-1", agentId: "agent-2", agentName: "Reviewer" },
          { ...healthFixtures.justStarted, id: "r3", issueId: "issue-2", agentId: "agent-1", agentName: "Builder" },
          { ...healthFixtures.stalledByClock, id: "r4", issueId: "issue-3", agentId: "agent-3", agentName: "Operator" },
        ]}
        issues={[
          issue({ id: "issue-1", identifier: "ZHA-1" }),
          issue({ id: "issue-2", identifier: "ZHA-2" }),
          issue({ id: "issue-3", identifier: "ZHA-3" }),
        ]}
      />,
    );
    expect(container.querySelector("[data-slot='tasks-live-now-avatars']")).toBeNull();

    const toggle = container.querySelector<HTMLButtonElement>("section button[aria-expanded]")!;
    flushSync(() => toggle.click());

    expect(liveRows()).toHaveLength(0);
    const strip = container.querySelector("[data-slot='tasks-live-now-avatars']")!;
    expect([...strip.querySelectorAll("[title]")].map((el) => el.getAttribute("title"))).toEqual([
      "Operator",
      "Builder",
      "Reviewer",
    ]);
    expect(toggle.textContent).toContain("1 needs attention");
    expect(container.querySelector("[data-slot='tasks-live-now-count']")?.textContent).toBe("3");

    flushSync(() => toggle.click());
    expect(liveRows()).toHaveLength(3);
    expect(container.querySelector("[data-slot='tasks-live-now-avatars']")).toBeNull();
  });
});

describe("Live now groups, density, filters and board lanes", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const working = (index: number) => ({
    ...healthFixtures.active,
    id: `working-${index}`,
    issueId: `working-${index}`,
    startedAt: at((10 + index) * 60_000),
  });
  const mixedRuns = [
    working(1),
    working(2),
    working(3),
    working(4),
    { ...healthFixtures.stalledByClock, issueId: "stalled" },
    { ...healthFixtures.quietByClock, issueId: "quiet" },
  ];
  const mixedIssues = ["working-1", "working-2", "working-3", "working-4", "stalled", "quiet"].map((id, index) =>
    issue({ id, identifier: `ZHA-${index + 10}`, title: id }),
  );

  function groupIds(group: string) {
    return [...container.querySelectorAll<HTMLElement>(`[data-live-now-group='${group}'] [data-live-now-issue-id]`)].map(
      (row) => row.dataset.liveNowIssueId,
    );
  }

  it("keeps every task that needs attention visible and only shortens the working group", () => {
    render(<TasksLiveNowSection companyId="company-1" liveRuns={mixedRuns} issues={mixedIssues} />);

    expect(groupIds("attention")).toEqual(["stalled", "quiet"]);
    expect(groupIds("working")).toEqual(["working-1", "working-2"]);
    const more = [...container.querySelectorAll("button")].find((button) => button.textContent === "Show 2 more working")!;
    flushSync(() => more.click());
    expect(groupIds("working")).toEqual(["working-1", "working-2", "working-3", "working-4"]);
  });

  it("moves a task into Needs attention when it goes quiet, without new run data", () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW);
    const goingQuiet = run({ startedAt: at(10 * 60_000), currentToolName: "bash", lastEventAt: at(100_000) });
    render(<TasksLiveNowSection companyId="company-1" liveRuns={[goingQuiet]} issues={[issue({})]} />);
    expect(groupIds("working")).toEqual(["issue-1"]);

    flushSync(() => vi.advanceTimersByTime(19_000));
    expect(groupIds("working")).toEqual(["issue-1"]);
    flushSync(() => vi.advanceTimersByTime(2_000));
    expect(groupIds("attention")).toEqual(["issue-1"]);
    expect(liveRows()[0]!.querySelector("[data-slot='tasks-live-now-health']")?.textContent).toBe("Quiet 2m");
  });

  it("keeps a seconds label ticking when the watchdog already flags a run that showed activity seconds ago", () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(NOW);
    const flagged = run({
      startedAt: at(70 * 60_000),
      lastEventAt: at(5_000),
      outputSilence: silence("suspicious", 65 * 60_000),
    });
    render(<TasksLiveNowSection companyId="company-1" liveRuns={[flagged]} issues={[issue({})]} />);
    const label = () => liveRows()[0]!.querySelector("[data-slot='tasks-live-now-health']")?.textContent;
    expect(label()).toBe("Quiet 5s");

    flushSync(() => vi.advanceTimersByTime(1_100));
    expect(label()).toBe("Quiet 6s");
  });

  it("remembers the row density per company", () => {
    const props = { liveRuns: [run({})], issues: [issue({})] };
    render(<TasksLiveNowSection companyId="company-1" {...props} />);
    expect(liveRows()[0]!.dataset.density).toBe("compact");

    flushSync(() => container.querySelector<HTMLButtonElement>("button[aria-label='Comfortable rows']")!.click());
    expect(liveRows()[0]!.dataset.density).toBe("comfortable");
    expect(localStorage.getItem(liveNowDensityStorageKey("company-1"))).toBe("comfortable");

    flushSync(() => root!.unmount());
    render(<TasksLiveNowSection companyId="company-1" {...props} />);
    expect(liveRows()[0]!.dataset.density).toBe("comfortable");

    flushSync(() => root!.unmount());
    render(<TasksLiveNowSection companyId="company-2" {...props} />);
    expect(liveRows()[0]!.dataset.density).toBe("compact");
  });

  it("applies the board filters and offers the tasks they hide behind a chip", () => {
    const onlyWorking = (candidate: Issue) => candidate.id.startsWith("working");
    render(
      <TasksLiveNowSection companyId="company-1" liveRuns={mixedRuns} issues={mixedIssues} issueFilter={onlyWorking} />,
    );

    expect(groupIds("attention")).toEqual([]);
    const chip = container.querySelector<HTMLButtonElement>("[data-slot='tasks-live-now-hidden']")!;
    expect(chip.textContent).toBe("2 hidden by filters");
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector("[data-slot='tasks-live-now-count']")?.textContent).toBe("4");

    flushSync(() => chip.click());
    expect(groupIds("attention")).toEqual(["stalled", "quiet"]);
    expect(chip.getAttribute("aria-pressed")).toBe("true");
  });

  it("shows no hidden chip when the filters keep every live task", () => {
    render(
      <TasksLiveNowSection companyId="company-1" liveRuns={mixedRuns} issues={mixedIssues} issueFilter={() => true} />,
    );
    expect(container.querySelector("[data-slot='tasks-live-now-hidden']")).toBeNull();
    expect(liveRows()).toHaveLength(4);
  });

  it("renders board lanes per state with two cards each and the rest behind +n more", () => {
    render(<TasksLiveNowSection companyId="company-1" liveRuns={mixedRuns} issues={mixedIssues} view="board" />);

    const lane = (group: string) => container.querySelector<HTMLElement>(`[data-live-now-lane='${group}']`)!;
    const laneIds = (group: string) =>
      [...lane(group).querySelectorAll<HTMLElement>("[data-live-now-issue-id]")].map((card) => card.dataset.liveNowIssueId);
    expect([...container.querySelectorAll("[data-live-now-lane]")].map((el) => el.getAttribute("data-live-now-lane"))).toEqual([
      "attention",
      "working",
      "paused",
    ]);
    expect(laneIds("attention")).toEqual(["stalled", "quiet"]);
    expect(laneIds("working")).toEqual(["working-1", "working-2"]);
    expect(container.querySelector("button[aria-label='Comfortable rows']")).toBeNull();

    const more = [...lane("working").querySelectorAll("button")].find((button) => button.textContent === "+2 more")!;
    flushSync(() => more.click());
    expect(laneIds("working")).toEqual(["working-1", "working-2", "working-3", "working-4"]);
  });
});

describe("Live now runs the task list does not show", () => {
  const heartbeatRun = run({ id: "heartbeat-1", issueId: null, agentName: "Wira", invocationSource: "timer" });

  function heartbeatRows() {
    return [...container.querySelectorAll<HTMLElement>("[data-live-now-kind='heartbeat']")];
  }

  it("turns live runs without a task into heartbeat items and leaves finished runs and task runs out", () => {
    const items = buildLiveNowHeartbeats(
      [heartbeatRun, run({ id: "done", issueId: null, status: "succeeded" }), run({ id: "task-run" })],
      Date.parse("2026-10-08T10:00:30.000Z"),
    );
    expect(items.map((item) => item.entry.runs[0]!.id)).toEqual(["heartbeat-1"]);
  });

  it("shows a run with no task as a Heartbeat row under its agent, past the filters, and stops it after confirmation", async () => {
    mockHeartbeatsApi.cancel.mockResolvedValue(undefined);
    render(<TasksLiveNowSection companyId="company-1" liveRuns={[heartbeatRun]} issues={[]} issueFilter={() => false} />);

    const row = heartbeatRows()[0]!;
    expect(row.textContent).toContain("Heartbeat");
    expect(row.textContent).toContain("Wira");
    expect(row.querySelector("a[aria-label='Open Wira heartbeat run']")?.getAttribute("href")).toBe("/agents/agent-1/runs/heartbeat-1");
    expect(container.querySelector("[data-slot='tasks-live-now-count']")?.textContent).toBe("1");
    expect(container.querySelector("[data-slot='tasks-live-now-hidden']")).toBeNull();
    expect(mockIssuesApi.get).not.toHaveBeenCalled();

    openMoreMenu(row);
    await waitFor(() => expect(menuItem("Stop run")).toBeDefined());
    expect(menuItem("Open task")).toBeUndefined();
    flushSync(() => menuItem("Stop run")!.click());
    await waitFor(() => expect(document.body.querySelector("[role='alertdialog']")).not.toBeNull());
    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>("[role='alertdialog'] button")].find(
      (button) => button.textContent === "Stop run",
    )!;
    flushSync(() => confirm.click());
    await waitFor(() => expect(mockHeartbeatsApi.cancel).toHaveBeenCalledWith("heartbeat-1"));
  });

  it("puts a heartbeat card in its board lane", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-08T10:00:30.000Z"));
    try {
      render(
        <TasksLiveNowSection
          companyId="company-1"
          liveRuns={[{ ...heartbeatRun, lastEventAt: "2026-10-08T10:00:20.000Z" }]}
          issues={[]}
          view="board"
        />,
      );
      const card = container.querySelector<HTMLElement>("[data-live-now-kind='heartbeat']")!;
      expect(card.closest("[data-live-now-lane]")?.getAttribute("data-live-now-lane")).toBe("working");
      expect(card.textContent).toContain("Wira");
    } finally {
      vi.useRealTimers();
    }
  });

  it("labels live runs on a hidden task, a routine run and a chat, and keeps them visible", async () => {
    mockIssuesApi.get.mockResolvedValue(
      issue({ id: "hidden-1", identifier: "ZHA-7", title: "Update status card", hiddenAt: new Date("2026-10-08T09:00:00.000Z") }),
    );
    const routine = issue({ id: "routine-1", identifier: "ZHA-8", title: "Nightly digest", originKind: "routine_execution" });
    const chat = issue({ id: "chat-1", identifier: "ZHA-9", title: "OpenWA group", originKind: "chat_channel" });
    render(
      <TasksLiveNowSection
        companyId="company-1"
        liveRuns={[
          run({ id: "run-hidden", issueId: "hidden-1" }),
          run({ id: "run-routine", issueId: "routine-1" }),
          run({ id: "run-chat", issueId: "chat-1" }),
        ]}
        issues={[routine, chat]}
        issueFilter={() => true}
      />,
    );

    const kindOf = (issueId: string) =>
      container.querySelector(`[data-live-now-issue-id='${issueId}'] [data-slot='tasks-live-now-kind']`)?.textContent;
    await waitFor(() => expect(kindOf("hidden-1")).toBe("Hidden"));
    expect(kindOf("routine-1")).toBe("Routine");
    expect(kindOf("chat-1")).toBe("Chat");
    expect(container.querySelector("[data-slot='tasks-live-now-hidden']")).toBeNull();
  });
});
