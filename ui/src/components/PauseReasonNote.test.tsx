// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Issue, PausedTask } from "@tickernelz/wardmote-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { pauseActorKind, type PausedTaskNote } from "../lib/tree-hold-reason";
import { IssueRow } from "./IssueRow";
import { KanbanBoard } from "./KanbanBoard";
import { PauseReasonNote } from "./PauseReasonNote";
import { LiveNowPausedCard, LiveNowPausedRow } from "./live-now/LiveNowPaused";

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    to,
    state: _state,
    issuePrefetch: _issuePrefetch,
    disableIssueQuicklook: _disableIssueQuicklook,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    to?: string;
    state?: unknown;
    issuePrefetch?: unknown;
    disableIssueQuicklook?: boolean;
  }) => <a href={to} {...props}>{children}</a>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COMPANY_ID = "company-1";
const AGENT_REASON = "Waiting for the deploy window before running the migration";
const MARKUP_REASON = "<img src=x onerror=alert(1)><b>bold</b> needs a person";
const LONG_REASON = `Hold ${"the database migration until the vendor confirms the cutover window ".repeat(12)}end`;

let container: HTMLDivElement;
let root: Root | null = null;

function issue(id: string, title: string): Issue {
  return {
    id, identifier: id.toUpperCase(), companyId: COMPANY_ID, projectId: null, projectWorkspaceId: null, goalId: null, parentId: null,
    title, description: null, status: "in_progress", workMode: "standard", priority: "medium", reviewPolicy: null,
    assigneeAgentId: "agent-1", assigneeUserId: null, responsibleUserId: null, createdByAgentId: null, createdByUserId: null,
    issueNumber: 1, requestDepth: 0, billingCode: null, assigneeAdapterOverrides: null, executionWorkspaceId: null,
    executionWorkspacePreference: null, executionWorkspaceSettings: null, checkoutRunId: null, executionRunId: null,
    executionAgentNameKey: null, executionLockedAt: null, startedAt: null, completedAt: null, cancelledAt: null, hiddenAt: null,
    createdAt: new Date("2026-11-19T00:00:00.000Z"), updatedAt: new Date("2026-11-19T00:00:00.000Z"), labels: [], labelIds: [],
    myLastTouchAt: null, lastExternalCommentAt: null, lastActivityAt: null, isUnreadForMe: false,
  } as Issue;
}

function pausedTask(overrides: Partial<PausedTask>): PausedTask {
  return {
    holdId: "hold-1", issueId: "zha-1", identifier: "ZHA-1", title: "Migrate billing", status: "in_progress", scope: "task",
    assigneeAgentId: "agent-1", assigneeAgentName: "Raka", pausedAt: new Date(Date.now() - 5 * 60_000),
    pausedByUserId: null, pausedByAgentId: "agent-1", reason: AGENT_REASON, state: "paused", liveRunId: null, lastRun: null,
    ...overrides,
  };
}

function note(pause: PausedTask): PausedTaskNote {
  return {
    pause,
    note: {
      reason: pause.reason,
      pausedAt: pause.pausedAt,
      actorKind: pauseActorKind(pause.pausedByAgentId, pause.pausedByUserId),
      actorLabel: pause.pausedByAgentId ? "Raka" : pause.pausedByUserId ? "Zhafron" : null,
    },
  };
}

function render(node: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  queryClient.setQueryData(queryKeys.agents.list(COMPANY_ID), [{ id: "agent-1", name: "Raka" }]);
  queryClient.setQueryData(queryKeys.access.companyUserDirectory(COMPANY_ID), {
    users: [{ principalId: "user-1", status: "active", user: { id: "user-1", name: "Zhafron", email: null, image: null } }],
  });
  root = createRoot(container);
  flushSync(() => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <ToastProvider>{node}</ToastProvider>
      </QueryClientProvider>,
    );
  });
}

function trigger(scope: ParentNode = container) {
  const button = scope.querySelector<HTMLButtonElement>("button[data-pause-reason]");
  if (!button) throw new Error("pause reason trigger not rendered");
  return button;
}

function openPopover(scope: ParentNode = container) {
  const button = trigger(scope);
  flushSync(() => {
    button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    button.click();
  });
  const content = document.body.querySelector<HTMLElement>("[data-slot='popover-content']");
  if (!content) throw new Error("pause reason popover did not open");
  return content;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("pause reasons on task surfaces", () => {
  it("shows the agent, the time and the reason on a Live Now row next to Resume", () => {
    const pause = pausedTask({});
    render(<LiveNowPausedRow companyId={COMPANY_ID} item={{ pause, issue: null, identifier: "ZHA-1" }} density="comfortable" />);
    const row = container.querySelector<HTMLElement>("[data-live-now-issue-id='zha-1']")!;
    expect(trigger(row).textContent).toContain(`Raka: ${AGENT_REASON}`);
    expect(trigger(row).dataset.pauseReason).toBe("given");
    expect(row.querySelector("button[aria-label='Resume ZHA-1']")).not.toBeNull();
    const content = openPopover(row);
    expect(content.textContent).toContain("Paused by Raka");
    expect(content.textContent).toContain("5m ago");
    expect(content.querySelector("time")?.getAttribute("dateTime")).toBe(new Date(pause.pausedAt).toISOString());
  });

  it("shows a button-made pause as a neutral manual pause on a Live Now card", () => {
    const pause = pausedTask({ pausedByAgentId: null, pausedByUserId: "user-1", reason: "Paused from Recent Tasks." });
    render(<LiveNowPausedCard companyId={COMPANY_ID} item={{ pause, issue: null, identifier: "ZHA-1" }} />);
    expect(trigger().textContent).toContain("Paused manually by Zhafron");
    expect(trigger().textContent).not.toContain("Recent Tasks");
    expect(trigger().dataset.pauseReason).toBe("none");
    expect(openPopover().textContent).toContain("No reason was given.");
  });

  it("shows who paused a kanban card and when, and keeps markup as plain text", () => {
    const pause = pausedTask({ reason: MARKUP_REASON });
    render(
      <KanbanBoard
        issues={[issue("zha-1", "Migrate billing")]}
        agents={[{ id: "agent-1", name: "Raka" } as never]}
        pausedTaskByIssueId={new Map([["zha-1", note(pause)]])}
        onUpdateIssue={vi.fn()}
      />,
    );
    expect(container.querySelector("[data-live-marker='paused']")?.textContent).toContain("Paused");
    expect(trigger().textContent).toContain(`Raka, 5m ago: ${MARKUP_REASON}`);
    expect(trigger().closest("a")).toBeNull();
    const content = openPopover();
    expect(content.querySelector("img, b")).toBeNull();
    expect(content.querySelector("[data-testid='pause-reason-text']")?.textContent).toBe(MARKUP_REASON);
  });

  it("keeps a very long reason on one truncated line in a list row and shows it whole on open", () => {
    const pause = pausedTask({ reason: LONG_REASON });
    render(
      <IssueRow
        issue={issue("zha-1", "Migrate billing")}
        presentation="task"
        titleNote={<PauseReasonNote note={note(pause).note} identifier="ZHA-1" showTime />}
      />,
    );
    const slot = container.querySelector<HTMLElement>("[data-slot='task-row-title-note']")!;
    expect(slot.className).toContain("min-w-0");
    const line = trigger(slot).querySelector("span.truncate");
    expect(line?.textContent).toBe(`Raka, 5m ago: ${LONG_REASON}`);
    expect(trigger(slot).getAttribute("title")).toBe(`Raka, 5m ago: ${LONG_REASON}`);
    expect(openPopover(slot).querySelector("[data-testid='pause-reason-text']")?.textContent).toBe(LONG_REASON);
  });

  it("renders a pause without reason or known actor tidily", () => {
    render(
      <PauseReasonNote
        note={{ reason: null, pausedAt: new Date(), actorKind: null, actorLabel: null }}
        identifier="ZHA-1"
      />,
    );
    expect(trigger().textContent).toContain("Paused manually by someone");
    expect(openPopover().textContent).toContain("No reason was given.");
  });

  it("opens from the keyboard", () => {
    render(<PauseReasonNote note={note(pausedTask({})).note} identifier="ZHA-1" />);
    const button = trigger();
    button.focus();
    expect(document.activeElement).toBe(button);
    flushSync(() => {
      button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      button.click();
    });
    expect(document.body.querySelector("[data-slot='popover-content']")?.textContent).toContain(AGENT_REASON);
  });
});
