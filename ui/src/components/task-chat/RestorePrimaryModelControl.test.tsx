// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunModelFallbackState } from "@tickernelz/wardmote-shared";
import { RestorePrimaryModelControl } from "./RestorePrimaryModelControl";

const mockIssuesApi = vi.hoisted(() => ({ restorePrimaryModel: vi.fn() }));

vi.mock("../../api/issues", () => ({ issuesApi: mockIssuesApi }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fallback: RunModelFallbackState = {
  primaryModel: "openai/gpt-5",
  activeModel: "openrouter/qwen3",
  reason: "rate_limit",
  switchedAt: "2026-10-16T10:00:00.000Z",
};

let container: HTMLDivElement;
let root: Root | null = null;
let queryClient: QueryClient;

function render(node: ReactNode) {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  flushSync(() => {
    root!.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
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

function control(issueId = "issue-7", runId = "run-9") {
  return (
    <RestorePrimaryModelControl
      issueId={issueId}
      run={{ id: runId, modelFallback: fallback }}
      companyId="company-1"
      taskLabel="ZHA-1"
    />
  );
}

function trigger(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('[data-slot="restore-primary-model"] button')!;
}

function dialogButton(label: string): HTMLButtonElement {
  const dialog = document.body.querySelector<HTMLElement>("[role='alertdialog']")!;
  return [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === label,
  )!;
}

async function openDialog() {
  flushSync(() => trigger().click());
  await waitFor(() => expect(document.body.querySelector("[role='alertdialog']")).not.toBeNull());
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  mockIssuesApi.restorePrimaryModel.mockReset();
});

afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  container.remove();
  vi.restoreAllMocks();
});

describe("RestorePrimaryModelControl", () => {
  it("stays hidden while the run is on its primary model", () => {
    render(
      <RestorePrimaryModelControl issueId="issue-7" run={{ id: "run-9", modelFallback: null }} />,
    );
    expect(container.querySelector('[data-slot="restore-primary-model"]')).toBeNull();
  });

  it("asks before forcing the switch and says the cooldown reset reaches other agents", async () => {
    render(control());
    expect(trigger().getAttribute("aria-label")).toBe("Back to the primary model on ZHA-1");
    await openDialog();
    const text = document.body.querySelector("[role='alertdialog']")?.textContent ?? "";
    expect(text).toContain("Back to the primary model on ZHA-1?");
    expect(text).toContain("forces the switch");
    expect(text).toContain("other agents");
    expect(text).toContain("60 to 80 seconds");
    expect(mockIssuesApi.restorePrimaryModel).not.toHaveBeenCalled();
  });

  it("does not stop the run when the confirmation is dismissed", async () => {
    render(control());
    await openDialog();
    flushSync(() => dialogButton("Keep running").click());
    await waitFor(() => expect(document.body.querySelector("[role='alertdialog']")).toBeNull());
    expect(mockIssuesApi.restorePrimaryModel).not.toHaveBeenCalled();
  });

  it("forces the switch through one server action on the task", async () => {
    mockIssuesApi.restorePrimaryModel.mockResolvedValue({ primary: fallback.primaryModel });

    render(control());
    await openDialog();
    flushSync(() => dialogButton("Stop and switch").click());

    await waitFor(() => expect(mockIssuesApi.restorePrimaryModel).toHaveBeenCalledTimes(1));
    expect(mockIssuesApi.restorePrimaryModel).toHaveBeenCalledWith("issue-7");
  });

  it("reports a failed restore instead of failing silently", async () => {
    mockIssuesApi.restorePrimaryModel.mockRejectedValue(new Error("The assignee has no fallback models."));
    render(control());
    await openDialog();
    flushSync(() => dialogButton("Stop and switch").click());
    await waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toBe("The assignee has no fallback models."),
    );
  });
});
