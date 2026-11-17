import type { ExecutionContinuationEnvelope } from "@tickernelz/wardmote-shared";

type ContinuationMessage = ExecutionContinuationEnvelope["messages"][number];

export const PROMPT_CHARS_PER_TOKEN = 1.8;
export const HISTORY_CONTEXT_SHARE = 0.4;
export const DEFAULT_MODEL_CONTEXT_WINDOW = 200_000;
export const ALWAYS_KEPT_RECENT_MESSAGES = 10;

export interface ContinuationHistoryWindow {
  budgetTokens: number;
  messageCount: number;
  keptMessageCount: number;
  omittedMessageCount: number;
  historyTokensBefore: number;
  historyTokensAfter: number;
}

export function estimatePromptTokens(chars: number): number {
  return Math.ceil(chars / PROMPT_CHARS_PER_TOKEN);
}

export function historyTokenBudget(contextWindow: number | null): number {
  const window = contextWindow && contextWindow > 0 ? contextWindow : DEFAULT_MODEL_CONTEXT_WINDOW;
  return Math.floor(window * HISTORY_CONTEXT_SHARE);
}

function isEnvelope(value: unknown): value is ExecutionContinuationEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const envelope = value as Partial<ExecutionContinuationEnvelope>;
  return envelope.version === 1 && Array.isArray(envelope.messages);
}

/** Estimated tokens of the continuation messages a fresh-session wake prompt would carry. */
export function wakeHistoryTokens(wake: unknown): number {
  const continuation = wake && typeof wake === "object" ? (wake as Record<string, unknown>).executionContinuation : null;
  if (!isEnvelope(continuation)) return 0;
  return continuation.messages.reduce((total, message) => total + estimatePromptTokens(JSON.stringify(message).length), 0);
}

function keptIndexes(envelope: ExecutionContinuationEnvelope, costs: number[], budgetTokens: number): Set<number> {
  const { messages } = envelope;
  const required = new Set<string>(envelope.originCommentIds);
  if (envelope.objectiveSource?.kind === "comment") required.add(envelope.objectiveSource.id);
  const lastAgentIndex = messages.findLastIndex((message) => message.authorType === "agent");
  const kept = new Set<number>();
  messages.forEach((message, index) => {
    const unanswered = index > lastAgentIndex && message.authorType === "user" && !message.deleted;
    if (required.has(message.id) || unanswered || index >= messages.length - ALWAYS_KEPT_RECENT_MESSAGES) kept.add(index);
  });
  let used = [...kept].reduce((total, index) => total + costs[index]!, 0);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (kept.has(index)) continue;
    if (used + costs[index]! > budgetTokens) break;
    kept.add(index);
    used += costs[index]!;
  }
  return kept;
}

/** Keeps the newest history that fits the budget, plus origin, objective and unanswered messages, and marks what was left out. */
export function windowContinuationHistory(
  envelope: ExecutionContinuationEnvelope,
  budgetTokens: number,
): { envelope: ExecutionContinuationEnvelope; window: ContinuationHistoryWindow } {
  const { messages } = envelope;
  const costs = messages.map((message) => estimatePromptTokens(JSON.stringify(message).length));
  const historyTokensBefore = costs.reduce((total, cost) => total + cost, 0);
  const unchanged = {
    budgetTokens,
    messageCount: messages.length,
    keptMessageCount: messages.length,
    omittedMessageCount: 0,
    historyTokensBefore,
    historyTokensAfter: historyTokensBefore,
  };
  if (historyTokensBefore <= budgetTokens) return { envelope, window: unchanged };
  const kept = keptIndexes(envelope, costs, budgetTokens);
  const omitted: ContinuationMessage[] = messages.filter((_message, index) => !kept.has(index));
  if (omitted.length === 0) return { envelope, window: unchanged };
  const keptMessages = messages.filter((_message, index) => kept.has(index));
  const first = omitted[0]!;
  const last = omitted.at(-1)!;
  const historyTokensAfter = [...kept].reduce((total, index) => total + costs[index]!, 0);
  return {
    envelope: {
      ...envelope,
      messages: keptMessages,
      coverage: {
        ...envelope.coverage,
        kind: "task_history_window",
        omitted: {
          messageCount: omitted.length,
          firstCommentId: first.id,
          lastCommentId: last.id,
          firstCreatedAt: first.createdAt,
          lastCreatedAt: last.createdAt,
          read: `${omitted.length} older messages of issue ${envelope.issueId} were left out to fit the model's context window. Read them with wardmoteListComments (REST: GET /api/issues/${envelope.issueId}/comments) when the task needs them; completedWork carries the latest run summary.`,
        },
      },
    },
    window: {
      budgetTokens,
      messageCount: messages.length,
      keptMessageCount: keptMessages.length,
      omittedMessageCount: omitted.length,
      historyTokensBefore,
      historyTokensAfter,
    },
  };
}

/** Applies windowContinuationHistory to the continuation inside a Wardmote wake payload. */
export function windowWakeHistory(
  wake: unknown,
  budgetTokens: number,
): { wake: unknown; window: ContinuationHistoryWindow | null } {
  if (!wake || typeof wake !== "object" || Array.isArray(wake)) return { wake, window: null };
  const payload = wake as Record<string, unknown>;
  if (!isEnvelope(payload.executionContinuation)) return { wake, window: null };
  const result = windowContinuationHistory(payload.executionContinuation, budgetTokens);
  return { wake: { ...payload, executionContinuation: result.envelope }, window: result.window };
}
