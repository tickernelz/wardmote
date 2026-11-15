import { ArrowUpRight, MoreHorizontal, Play, Square } from "lucide-react";
import { Link } from "@/lib/router";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTaskPause } from "../../hooks/useTaskPause";
import { createIssueDetailPath, withIssueDetailHeaderSeed } from "../../lib/issueDetailBreadcrumb";
import { cn, relativeTime } from "../../lib/utils";
import { AgentAvatar } from "../AgentAvatar";
import { LiveNowHealthChip, type LiveNowDensity } from "./LiveNowRow";
import { LIVE_NOW_HEALTH_POSE, pauseSignal } from "./live-now-health";
import type { LiveNowPausedItem } from "./useLiveNowModel";

const ICON_BUTTON = "size-11 px-0 sm:size-7 has-[>svg]:px-0";

/** How the last run of a paused task ended, in words. */
export function pausedLastRunText(item: LiveNowPausedItem): string {
  const safePoint = item.pause.lastRun?.safePoint;
  if (safePoint === "reached") return "Stopped after its current step";
  if (safePoint === "timeout") return "Stopped at the 120 s limit";
  return item.pause.lastRun ? "Stopped" : "No run was in progress";
}

function usePausedTaskActions(companyId: string, item: LiveNowPausedItem, issueLinkState?: unknown) {
  const { resume, endPause } = useTaskPause(companyId);
  const task = { issueId: item.pause.issueId, identifier: item.pause.identifier, holdId: item.pause.holdId };
  const pathId = item.pause.identifier ?? item.pause.issueId;
  return {
    title: item.issue?.title ?? item.pause.title,
    taskPath: createIssueDetailPath(pathId),
    detailState: item.issue ? withIssueDetailHeaderSeed(issueLinkState, item.issue) : undefined,
    canRelease: item.pause.state === "paused",
    resuming: resume.isPending,
    ending: endPause.isPending,
    resume: () => resume.mutate(task),
    endPause: () => endPause.mutate(task),
  };
}

type PausedActions = ReturnType<typeof usePausedTaskActions>;

function ResumeButton({ actions, identifier, iconOnly }: { actions: PausedActions; identifier: string; iconOnly: boolean }) {
  return (
    <Button
      type="button"
      variant="primary"
      size="xs"
      className={iconOnly ? ICON_BUTTON : "h-11 sm:h-7"}
      disabled={actions.resuming || actions.ending}
      aria-label={`Resume ${identifier}`}
      title="Resume the task; its agent continues the saved session"
      onClick={actions.resume}
    >
      <Play aria-hidden="true" />
      {iconOnly ? null : actions.resuming ? "Resuming…" : "Resume"}
    </Button>
  );
}

function PausedMoreMenu({ actions, identifier, className }: { actions: PausedActions; identifier: string; className?: string }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="xs" className={cn(ICON_BUTTON, className)} aria-label={`More actions for ${identifier}`}>
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuItem asChild>
          <Link to={actions.taskPath} state={actions.detailState} disableIssueQuicklook className="no-underline">
            <ArrowUpRight aria-hidden="true" />
            Open task
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!actions.canRelease || actions.ending || actions.resuming} onSelect={actions.endPause}>
          <Square aria-hidden="true" />
          {actions.ending ? "Ending pause…" : "End pause without waking"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function pausedSignal(item: LiveNowPausedItem) {
  return pauseSignal(item.pause.state);
}

/** A paused task with no run in progress, as a row in the Paused group. */
export function LiveNowPausedRow({
  companyId,
  item,
  density,
  issueLinkState,
}: {
  companyId: string;
  item: LiveNowPausedItem;
  density: LiveNowDensity;
  issueLinkState?: unknown;
}) {
  const actions = usePausedTaskActions(companyId, item, issueLinkState);
  const { pause, identifier } = item;
  const signal = pausedSignal(item);
  const comfortable = density === "comfortable";
  const agentName = pause.assigneeAgentName ?? "Unassigned";
  return (
    <li
      data-live-now-issue-id={pause.issueId}
      data-live-health={signal.health}
      data-density={density}
      className="live-now-row border-b border-line last:border-b-0"
    >
      <div data-density={density} className="live-now-row-grid">
        <span className="relative shrink-0 self-start [grid-area:avatar] sm:self-center">
          <AgentAvatar
            agent={pause.assigneeAgentId ? { id: pause.assigneeAgentId, name: agentName } : null}
            name={agentName}
            size={comfortable ? 32 : 20}
            pose={LIVE_NOW_HEALTH_POSE[signal.health]}
            muted
          />
        </span>
        {comfortable ? null : (
          <span className="hidden truncate font-mono text-xs text-ink-3 [grid-area:id] sm:block">{identifier}</span>
        )}
        <span className="flex min-w-0 items-baseline gap-2 [grid-area:title]">
          <Link
            to={actions.taskPath}
            state={actions.detailState}
            disableIssueQuicklook
            title={actions.title}
            className="min-w-0 truncate rounded-sm text-sm leading-5 font-semibold text-ink no-underline outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
          >
            {comfortable ? null : <span className="mr-1.5 font-mono text-xs font-normal text-ink-3 sm:hidden">{identifier}</span>}
            {actions.title}
          </Link>
        </span>
        {comfortable ? (
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-ink-3 [grid-area:meta]">
            <span className="shrink-0 font-mono">{identifier}</span>
            <span aria-hidden="true">·</span>
            <span className="truncate">{agentName}</span>
            {pause.scope === "subtree" ? <span className="shrink-0">· with subtasks</span> : null}
          </span>
        ) : null}
        <span className="live-now-row-status flex min-w-0 items-center gap-2 [grid-area:status]">
          <LiveNowHealthChip signal={signal} className="[grid-area:chip] sm:justify-self-start" />
          <time
            dateTime={new Date(pause.pausedAt).toISOString()}
            className={cn("shrink-0 text-xs text-ink-3 [grid-area:duration]", !comfortable && "sm:hidden")}
          >
            paused {relativeTime(pause.pausedAt)}
          </time>
          <span className="min-w-0 truncate text-xs text-ink-2 [grid-area:activity]">{pausedLastRunText(item)}</span>
        </span>
        <span
          className={cn(
            "flex items-center gap-1 [grid-area:actions] sm:justify-end",
            comfortable && "border-t border-line pt-2 sm:border-t-0 sm:pt-0",
          )}
        >
          {pause.state === "paused" ? <ResumeButton actions={actions} identifier={identifier} iconOnly={!comfortable} /> : null}
          <Link
            to={actions.taskPath}
            state={actions.detailState}
            disableIssueQuicklook
            aria-label={`Open ${identifier}`}
            title={`Open ${identifier}`}
            className={cn(buttonVariants({ variant: "secondary", size: "xs" }), ICON_BUTTON, !comfortable && "hidden sm:inline-flex")}
          >
            <ArrowUpRight aria-hidden="true" />
          </Link>
          <PausedMoreMenu actions={actions} identifier={identifier} className={comfortable ? "ml-auto sm:ml-0" : undefined} />
        </span>
      </div>
    </li>
  );
}

/** A paused task as a card in the Paused lane of the board band. */
export function LiveNowPausedCard({
  companyId,
  item,
  issueLinkState,
}: {
  companyId: string;
  item: LiveNowPausedItem;
  issueLinkState?: unknown;
}) {
  const actions = usePausedTaskActions(companyId, item, issueLinkState);
  const { pause, identifier } = item;
  const signal = pausedSignal(item);
  return (
    <li
      data-live-now-issue-id={pause.issueId}
      data-live-health={signal.health}
      className="live-now-board-card relative flex flex-col gap-1.5 rounded-md border border-line bg-bg-2 p-2.5 text-ink focus-within:ring-2 focus-within:ring-focus"
    >
      <span className="flex items-center gap-2">
        <span className="font-mono text-xs text-ink-3">{identifier}</span>
        <LiveNowHealthChip signal={signal} className="ml-auto" />
      </span>
      <Link
        to={actions.taskPath}
        state={actions.detailState}
        disableIssueQuicklook
        className="line-clamp-2 text-sm leading-5 font-semibold text-ink no-underline outline-none after:absolute after:inset-0 after:content-[''] hover:underline"
      >
        {actions.title}
      </Link>
      <span className="text-xs text-ink-2">{pausedLastRunText(item)}</span>
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-ink-3">
        <span className="min-w-0 truncate">{pause.assigneeAgentName ?? "Unassigned"}</span>
        <span className="ml-auto shrink-0">paused {relativeTime(pause.pausedAt)}</span>
        <span className="relative z-10 flex items-center gap-1">
          {pause.state === "paused" ? <ResumeButton actions={actions} identifier={identifier} iconOnly /> : null}
          <PausedMoreMenu actions={actions} identifier={identifier} />
        </span>
      </span>
    </li>
  );
}
