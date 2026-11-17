import { describe, expect, it } from "vitest";
import type { ExecutionContinuationEnvelope } from "@tickernelz/wardmote-shared";
import { renderWardmoteWakePrompt } from "./server-utils.js";
import { estimatePromptTokens, windowContinuationHistory, windowWakeHistory } from "./continuation-history-window.js";

function message(index: number, authorType: "user" | "agent", body = `pesan ${index} ${"x".repeat(900)}`) {
  const at = new Date(Date.UTC(2026, 10, 1) + index * 60_000).toISOString();
  return { id: `c-${index}`, authorType, authorId: authorType === "user" ? "user-1" : "agent-1", body, createdAt: at, updatedAt: at, deleted: false, sourceTrust: null };
}

function envelope(messages: ExecutionContinuationEnvelope["messages"], origin: string[]): ExecutionContinuationEnvelope {
  return {
    version: 1, companyId: "company-1", issueId: "issue-1",
    trigger: { reason: "issue_commented", interactionId: null, sourceRunId: null },
    originCommentIds: origin, objective: "jawab grup", messages, interactionOutcomes: [], completedWork: "ringkasan run terakhir",
    unresolvedInteractionIds: [],
    coverage: { kind: "full_task_history", throughCommentId: messages.at(-1)?.id ?? null, summaryThroughCommentId: null },
  };
}

describe("continuation history window", () => {
  const history = Array.from({ length: 1500 }, (_value, index) => message(index, index % 3 === 2 ? "agent" : "user"));
  history.push(message(1500, "user"), message(1501, "user"));
  const full = envelope(history, ["c-40", "c-1501"]);

  it("keeps a very long history within the token budget and always carries origin, unanswered, and recent messages", () => {
    const { envelope: windowed, window } = windowContinuationHistory(full, 20_000);
    const ids = windowed.messages.map((item) => item.id);
    expect(window.historyTokensBefore).toBeGreaterThan(500_000);
    expect(window.historyTokensAfter).toBeLessThanOrEqual(20_000);
    expect(ids).toEqual(expect.arrayContaining(["c-40", "c-1500", "c-1501", "c-1499"]));
    expect(windowed.coverage).toMatchObject({
      kind: "task_history_window",
      omitted: { messageCount: history.length - ids.length, firstCommentId: "c-0" },
    });
    expect(windowed.coverage.omitted?.read).toContain("wardmoteListComments");
  });

  it("leaves a history that fits untouched", () => {
    const small = envelope(history.slice(-5), []);
    const { envelope: windowed, window } = windowContinuationHistory(small, 20_000);
    expect(windowed).toBe(small);
    expect(window.omittedMessageCount).toBe(0);
  });

  it("tells the agent in the rendered prompt that older history was omitted and how to read it", () => {
    const { wake } = windowWakeHistory({ reason: "issue_commented", issue: { id: "issue-1" }, executionContinuation: full }, 20_000);
    const prompt = renderWardmoteWakePrompt(wake, { resumedSession: false });
    expect(prompt).toContain("Older history is omitted to fit the model's context window");
    expect(prompt).not.toContain("History is complete through the coverage cursor");
    expect(estimatePromptTokens(prompt.length)).toBeLessThan(25_000);
  });
});
