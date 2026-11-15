import { AgentIdentity } from "@/components/AgentIdentity";
import { memo } from "react";
import { Link } from "@/lib/router";
import type { Issue } from "@tickernelz/wardmote-shared";
import type { LiveRunForIssue } from "../api/heartbeats";
import type { TranscriptEntry } from "../adapters";
import { cn, relativeTime } from "../lib/utils";
import { Clock3 } from "lucide-react";
import { StatusGlyph } from "./StatusGlyph";
import { RunChatSurface } from "./RunChatSurface";
import { LiveNowTodoLine } from "./live-now/LiveNowTodoLine";

const EMPTY_TRANSCRIPT: TranscriptEntry[] = [];

const runStatusLabels: Record<string, string> = {
  running: "Running",
  queued: "Queued",
  succeeded: "Succeeded",
  failed: "Failed",
  timed_out: "Timed out",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

export const AgentRunCard = memo(function AgentRunCard({
  companyId,
  run,
  issue,
  transcript = EMPTY_TRANSCRIPT,
  hasOutput = false,
  showTranscript = false,
  issueLoadFailed = false,
  className,
}: {
  companyId: string;
  run: LiveRunForIssue;
  issue?: Pick<Issue, "identifier" | "title" | "status" | "externalConversationState">;
  transcript?: TranscriptEntry[];
  hasOutput?: boolean;
  showTranscript?: boolean;
  issueLoadFailed?: boolean;
  className?: string;
}) {
  const statusLabel = runStatusLabels[run.status] ?? run.status.replace(/[_-]/g, " ");
  const runUrl = `/agents/${run.agentId}/runs/${run.id}`;
  const timestamp = run.finishedAt
    ? `Finished ${relativeTime(run.finishedAt)}`
    : run.startedAt ? `Started ${relativeTime(run.startedAt)}` : `Queued ${relativeTime(run.createdAt)}`;
  const taskStatus = issue?.status === "in_review" && issue.externalConversationState === "waiting" ? "idle" : issue?.status ?? "backlog";
  const taskTitle = issue?.title ?? (issueLoadFailed ? "Task unavailable" : "Loading task…");

  return (
    <div className={cn(
      "dashboard-agent-card flex min-w-0 flex-col overflow-hidden rounded-xl border",
      showTranscript && "h-(--sz-320px)",
      run.status === "running"
        ? "border-(--dashboard-run-border) bg-(--dashboard-run-background) shadow-(--shadow-extract-1)"
        : "border-line bg-bg/70",
      className,
    )} data-run-status={run.status}>
      <div className={cn("flex shrink-0 flex-col gap-3 p-3", showTranscript && "border-b border-line/60")}>
        <Link
          to={runUrl}
          title={`${run.agentName} — ${statusLabel} · ${timestamp}`}
          aria-label={`${run.agentName} — ${statusLabel}. View run`}
          className="flex min-w-0 items-center gap-2 rounded-md text-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        >
          <AgentIdentity agent={{ id: run.agentId, name: run.agentName, appearance: run.agentAppearance }} size="sm" className="gap-2 font-medium" />
        </Link>

        {run.issueId ? (
          <Link
            to={`/issues/${issue?.identifier ?? run.issueId}`}
            className="min-w-0 rounded-lg border border-line/60 bg-bg/60 px-2.5 py-2 text-sm text-ink transition-colors hover:bg-bg-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            title={issue ? `${issue.title} · ${issue.identifier}` : taskTitle}
          >
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                <StatusGlyph
                  status={taskStatus}
                  size="md"
                  className="self-center"
                  title={issue ? `Task ${taskStatus.replace(/_/g, " ")}` : undefined}
                />
                <span className="truncate">{taskTitle}</span>
              </span>
              <span className="shrink-0 font-mono text-(length:--text-micro) text-ink-3">{issue?.identifier ?? run.issueId.slice(0, 8)}</span>
            </span>
          </Link>
        ) : (
          <Link to={runUrl} className="flex items-center gap-1.5 rounded-lg border border-line/60 bg-bg/60 px-2.5 py-2 text-sm text-ink-3 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
            <Clock3 className="size-4 shrink-0" aria-hidden />
            <span className="truncate">{run.invocationSource === "timer" ? "Scheduled heartbeat" : "No linked task"}</span>
          </Link>
        )}
        {run.issueId && (run.status === "running" || run.status === "queued") ? (
          <LiveNowTodoLine issueId={run.issueId} runIds={[run.id]} className="px-0.5" />
        ) : null}
        <time
          dateTime={run.finishedAt ?? run.startedAt ?? run.createdAt}
          className="text-right font-sans text-xs text-ink-3/70"
        >
          {timestamp}
        </time>
      </div>

      {showTranscript && (
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <RunChatSurface
            run={run}
            transcript={transcript}
            hasOutput={hasOutput}
            companyId={companyId}
          />
        </div>
      )}
    </div>
  );
});
