import type { ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2 } from "lucide-react";
import type { Agent, AttentionItem } from "@tickernelz/wardmote-shared";
import { Link } from "@/lib/router";
import { issuesApi } from "../api/issues";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { DecisionResolver } from "./DecisionResolver";
import { Button } from "./ui/button";

export const BLOCKED_REASON_NUDGE_COMMENT =
  "This task is blocked without a recorded reason. Please PATCH it with status blocked and blockedReason { reason, suggestion }: say what holds the work, recommend one action with its reason and what you will do once I agree. Add blockedReason.actions (and questions) when a button or an answer from me would unblock it.";

/** Expanded blocked-task card: suggestion, the agent's action card, or a nudge when no reason exists. */
export function BlockedReasonResolver({
  item,
  companyId,
  agentMap,
  toggle,
}: {
  item: AttentionItem;
  companyId: string;
  agentMap?: Map<string, Agent>;
  toggle: ReactNode;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const detail = item.detail?.kind === "blocker" ? item.detail : null;
  const blockedReason = detail?.blockedReason ?? null;
  const reasonIssue = detail?.reasonIssue ?? null;
  const nudge = useMutation({
    mutationFn: () => issuesApi.addComment(reasonIssue!.id, BLOCKED_REASON_NUDGE_COMMENT),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
      pushToast({ title: "Asked the assignee for a reason", tone: "success" });
    },
    onError: (error) => {
      pushToast({ title: "Could not nudge the assignee", body: error instanceof Error ? error.message : undefined, tone: "error" });
    },
  });

  return (
    <div className="space-y-3" data-blocked-reason={blockedReason ? "present" : "missing"}>
      {blockedReason ? (
        <div className="space-y-1">
          {reasonIssue && reasonIssue.id !== item.subject.id ? (
            <p className="text-xs text-ink-3">Reason given on {reasonIssue.identifier ?? "the blocked task"}, which waits on this task.</p>
          ) : null}
          <p className="text-xs font-medium text-ink-3">Suggestion</p>
          <p className="whitespace-pre-wrap break-words text-sm leading-6 text-ink">{blockedReason.suggestion}</p>
        </div>
      ) : (
        <p className="rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-100">
          Reason not provided yet. The assignee has not said why this task is blocked or what would unblock it.
        </p>
      )}
      {blockedReason?.decisionId ? (
        <DecisionResolver companyId={companyId} decisionId={blockedReason.decisionId} originIssue={item.relatedIssue} agentMap={agentMap} />
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center">{toggle}</div>
        <div className="flex flex-wrap items-center gap-2">
          {!blockedReason && reasonIssue?.assigneeAgentId ? (
            <Button
              type="button"
              size="xs"
              variant="primary"
              disabled={nudge.isPending}
              onClick={() => nudge.mutate()}
            >
              {nudge.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              Nudge for reason
            </Button>
          ) : null}
          {item.subject.href ? (
            <Button asChild type="button" variant="secondary" size="xs">
              <Link to={item.subject.href}>
                <ExternalLink className="h-3 w-3" />
                Open task
              </Link>
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
