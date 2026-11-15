import { useId, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Clock, GitBranch, Loader2, MessageSquare, MoreHorizontal, Pause, PauseCircle, ScrollText, Square, TriangleAlert } from "lucide-react";
import type { Issue, RunModelFallbackState } from "@tickernelz/wardmote-shared";
import { Link } from "@/lib/router";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { heartbeatsApi, type LiveRunForIssue } from "../../api/heartbeats";
import { issuesApi } from "../../api/issues";
import { useSecondTick } from "../../hooks/useSecondTick";
import { useTaskPause } from "../../hooks/useTaskPause";
import {
  createIssueDetailPath,
  rememberIssueDetailLocationState,
  withIssueDetailHeaderSeed,
} from "../../lib/issueDetailBreadcrumb";
import { describeDeliveryDowngrade } from "../../lib/message-delivery-command";
import { describeFallbackModel, modelFallbackReasonLabel } from "../../lib/model-fallback";
import { RestorePrimaryModelControl } from "../task-chat/RestorePrimaryModelControl";
import { modelValueText } from "../task-chat/model-option-display";
import { useConfigSchema } from "../../adapters/schema-config-fields";
import { queryKeys } from "../../lib/queryKeys";
import { cn, formatDurationMs } from "../../lib/utils";
import { AgentAvatar } from "../AgentAvatar";
import { LiveNowTodoLine } from "./LiveNowTodoLine";
import type { LiveNowAncestor, LiveNowItem, LiveNowRunSet } from "./useLiveNowModel";
import {
  LIVE_NOW_HEALTH_POSE,
  describeLiveActivity,
  lastLiveActivityMs,
  type LiveNowHealthSignal,
} from "./live-now-health";

export type LiveNowDensity = "comfortable" | "compact";

const ICON_BUTTON = "size-11 px-0 sm:size-7 has-[>svg]:px-0";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Time since the task's first run started; only this text re-renders every second. */
export function LiveNowElapsed({ entry, className }: { entry: LiveNowRunSet; className?: string }) {
  const startedAt = entry.earliestStartedAt;
  useSecondTick(startedAt !== null);
  const text = startedAt ? formatDurationMs(Math.max(0, Date.now() - new Date(startedAt).getTime())) : "Queued";
  return (
    <time
      dateTime={startedAt ?? entry.latestStartAt}
      title="Time since the run started"
      className={cn("shrink-0 font-mono text-xs tabular-nums text-ink-3", className)}
    >
      {text}
    </time>
  );
}

const HEALTH_ICON: Partial<Record<LiveNowHealthSignal["health"], typeof Clock>> = {
  stalled: TriangleAlert,
  pause_failed: TriangleAlert,
  quiet: Clock,
  pausing: Loader2,
  paused: PauseCircle,
};

/** State as a word with its colour and icon, never colour alone. */
export function LiveNowHealthChip({ signal, className }: { signal: LiveNowHealthSignal; className?: string }) {
  const Icon = HEALTH_ICON[signal.health] ?? null;
  return (
    <span
      data-slot="tasks-live-now-health"
      data-live-health={signal.health}
      className={cn(
        "live-now-health-pill inline-flex max-w-full shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium text-ink",
        className,
      )}
    >
      {Icon ? (
        <Icon
          aria-hidden="true"
          className={cn("live-now-health-icon size-3 shrink-0", signal.health === "pausing" && "animate-spin motion-reduce:animate-none")}
        />
      ) : (
        <span aria-hidden="true" className="live-now-health-dot size-1.5 shrink-0 rounded-full" />
      )}
      <span className="truncate">{signal.label}</span>
    </span>
  );
}

/** Cancels a live run and refreshes the live lists that show it. */
export function useLiveNowStop(
  run: LiveRunForIssue,
  issueId: string | null,
  companyId: string,
  onStopping: (message: string) => void,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => heartbeatsApi.cancel(run.id),
    onSuccess: () => {
      onStopping(`Stopping ${run.agentName}'s run`);
      void queryClient.invalidateQueries({ queryKey: queryKeys.liveRuns(companyId) });
      if (!issueId) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(issueId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.activeRun(issueId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.runs(issueId) });
    },
  });
}

export function LiveNowStopDialog({
  open,
  onOpenChange,
  agentName,
  identifier,
  onConfirm,
  onPauseInstead,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentName: string;
  identifier: string | null;
  onConfirm: () => void;
  onPauseInstead?: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Stop {agentName}&apos;s run?</AlertDialogTitle>
          <AlertDialogDescription>
            {identifier ? `${identifier} keeps its status and comments. ` : null}
            The agent stops mid-turn, so any unsaved work in this run is lost.
            {onPauseInstead ? " Pause instead lets the current step finish, keeps the session, and continues on Resume." : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep running</AlertDialogCancel>
          {onPauseInstead ? (
            <AlertDialogAction className={buttonVariants({ variant: "secondary" })} onClick={onPauseInstead}>
              <Pause aria-hidden="true" />
              Pause instead
            </AlertDialogAction>
          ) : null}
          <AlertDialogAction className={buttonVariants({ variant: "danger" })} onClick={onConfirm}>
            Stop run
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Secondary actions for one live task; Stop sits last, behind the confirmation dialog. */
export function LiveNowMoreMenu({
  entry,
  identifier,
  taskPath,
  detailState,
  stopping,
  onSteer,
  onStop,
  stopNow = false,
  onPauseSubtree,
  className,
}: {
  entry: LiveNowRunSet;
  identifier: string;
  taskPath?: string;
  detailState?: unknown;
  stopping: boolean;
  onSteer?: () => void;
  onStop: () => void;
  stopNow?: boolean;
  onPauseSubtree?: () => void;
  className?: string;
}) {
  const primary = entry.runs[0]!;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className={cn(ICON_BUTTON, className)}
          aria-label={`More actions for ${identifier}`}
        >
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        {taskPath ? (
          <DropdownMenuItem asChild>
            <Link to={taskPath} state={detailState} disableIssueQuicklook className="no-underline">
              <ArrowUpRight aria-hidden="true" />
              Open task
            </Link>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem asChild>
          <Link to={`/agents/${primary.agentId}/runs/${primary.id}`} className="no-underline">
            <ScrollText aria-hidden="true" />
            Run transcript
          </Link>
        </DropdownMenuItem>
        {onSteer ? (
          <DropdownMenuItem onSelect={onSteer}>
            <MessageSquare aria-hidden="true" />
            Steer {primary.agentName}
          </DropdownMenuItem>
        ) : null}
        {onPauseSubtree ? (
          <DropdownMenuItem onSelect={onPauseSubtree}>
            <GitBranch aria-hidden="true" />
            Pause subtree
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={stopping}
          aria-label={`${stopNow ? "Stop now" : "Stop"} ${primary.agentName}'s run on ${identifier}`}
          onSelect={onStop}
        >
          <Square aria-hidden="true" className="fill-current" />
          {stopping ? "Stopping…" : stopNow ? "Stop now" : "Stop run…"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface LiveNowTaskActions {
  primary: LiveRunForIssue;
  identifier: string;
  title: string;
  taskPath: string;
  detailState: unknown;
  pathId: string;
  stopping: boolean;
  stopError: unknown;
  confirmingStop: boolean;
  setConfirmingStop: (open: boolean) => void;
  confirmStop: () => void;
  feedback: string | null;
  setFeedback: (message: string | null) => void;
  pausable: boolean;
  pauseBlockedReason: string | null;
  pausing: boolean;
  pauseFailed: boolean;
  pause: (scope: "task" | "subtree") => void;
  stopNow: () => void;
  stopNowPending: boolean;
}

const SAFE_POINT_UNAVAILABLE = "This run can’t stop at a safe point. Use Stop run in More.";

/** Task identity, links and the Stop flow shared by the list row and the board card. */
export function useLiveNowTaskActions({
  companyId,
  item,
  loadFailed,
  issueLinkState,
}: {
  companyId: string;
  item: LiveNowItem;
  loadFailed: boolean;
  issueLinkState?: unknown;
}): LiveNowTaskActions {
  const { entry, issue, identifier } = item;
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const stop = useLiveNowStop(entry.runs[0]!, entry.issueId, companyId, setFeedback);
  const taskPause = useTaskPause(companyId);
  const pathId = issue?.identifier ?? entry.issueId;
  const task = { issueId: entry.issueId, identifier: issue?.identifier ?? null };
  const pausable = Boolean(issue) && !issue?.conversationAgentId && item.pause === null;
  return {
    pausable,
    pauseBlockedReason: pausable && entry.runs.some((run) => run.safePointPause === false) ? SAFE_POINT_UNAVAILABLE : null,
    pausing: item.pause?.state === "pausing" || item.pause?.state === "paused" || taskPause.pause.isPending,
    pauseFailed: item.pause?.state === "pause_failed",
    pause: (scope) => taskPause.pause.mutate({ ...task, scope }),
    stopNow: () => taskPause.stopNow.mutate({ ...task, runId: entry.runs[0]!.id }),
    stopNowPending: taskPause.stopNow.isPending,
    primary: entry.runs[0]!,
    identifier,
    title: issue?.title ?? (loadFailed ? "Task unavailable" : "Loading task…"),
    taskPath: createIssueDetailPath(pathId),
    detailState: issue ? withIssueDetailHeaderSeed(issueLinkState, issue) : undefined,
    pathId,
    stopping: stop.isPending,
    stopError: stop.error,
    confirmingStop,
    setConfirmingStop,
    confirmStop: () => {
      setFeedback(null);
      stop.mutate();
    },
    feedback,
    setFeedback,
  };
}

export function LiveNowStopFlow({ actions }: { actions: LiveNowTaskActions }) {
  return (
    <LiveNowStopDialog
      open={actions.confirmingStop}
      onOpenChange={actions.setConfirmingStop}
      agentName={actions.primary.agentName}
      identifier={actions.identifier}
      onConfirm={actions.confirmStop}
      onPauseInstead={actions.pausable && !actions.pauseBlockedReason ? () => actions.pause("task") : undefined}
    />
  );
}

export function LiveNowFeedback({ actions, className }: { actions: LiveNowTaskActions; className?: string }) {
  if (!actions.feedback && !actions.stopError) return null;
  return (
    <p
      role={actions.stopError ? "alert" : "status"}
      className={cn("text-xs", actions.stopError ? "text-bad" : "text-ink-3", className)}
    >
      {actions.stopError ? errorMessage(actions.stopError, "Couldn’t stop the run.") : actions.feedback}
    </p>
  );
}

/** The primary labelled control of a live task: Pause, the Pausing state, or Stop now after a pause failed. */
export function LiveNowPauseButton({
  actions,
  iconOnly = false,
  className,
}: {
  actions: LiveNowTaskActions;
  iconOnly?: boolean;
  className?: string;
}) {
  const sizing = iconOnly ? ICON_BUTTON : "h-11 sm:h-7";
  if (actions.pauseFailed) {
    return (
      <Button
        type="button"
        variant="danger"
        size="xs"
        className={cn(sizing, className)}
        disabled={actions.stopNowPending}
        aria-label={`Stop ${actions.identifier} now`}
        title="The run did not stop within 120 s. Stop it now; the task stays paused."
        onClick={actions.stopNow}
      >
        <Square aria-hidden="true" className="fill-current" />
        {iconOnly ? null : actions.stopNowPending ? "Stopping…" : "Stop now"}
      </Button>
    );
  }
  if (actions.pausing) {
    return (
      <Button
        type="button"
        variant="secondary"
        size="xs"
        className={cn(sizing, className)}
        disabled
        aria-label={`Pausing ${actions.identifier}`}
        title="Stops after the current step"
      >
        <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
        {iconOnly ? null : "Pausing…"}
      </Button>
    );
  }
  if (!actions.pausable) return null;
  const blocked = actions.pauseBlockedReason;
  return (
    <Button
      type="button"
      variant="secondary"
      size="xs"
      className={cn(sizing, blocked && "opacity-50", className)}
      aria-disabled={blocked ? true : undefined}
      aria-label={`Pause ${actions.identifier}`}
      title={blocked ?? "Pause after the current step"}
      onClick={blocked ? undefined : () => actions.pause("task")}
    >
      <Pause aria-hidden="true" />
      {iconOnly ? null : "Pause"}
    </Button>
  );
}

function LiveNowTitleLink({
  actions,
  issue,
  className,
  children,
}: {
  actions: LiveNowTaskActions;
  issue: Issue | null;
  className?: string;
  children: ReactNode;
}) {
  const { detailState, pathId } = actions;
  return (
    <Link
      to={actions.taskPath}
      state={detailState}
      issuePrefetch={issue}
      disableIssueQuicklook
      title={actions.title}
      onClickCapture={detailState ? () => rememberIssueDetailLocationState(pathId, detailState) : undefined}
      className={cn(
        "min-w-0 truncate rounded-sm font-semibold text-ink no-underline outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus",
        className,
      )}
    >
      {children}
    </Link>
  );
}

function LiveNowAgents({ entry }: { entry: LiveNowRunSet }) {
  const primary = entry.runs[0]!;
  const others = [
    ...new Map(entry.runs.slice(1).filter((run) => run.agentId !== primary.agentId).map((run) => [run.agentId, run])).values(),
  ];
  return (
    <span className="flex min-w-0 shrink items-center gap-1" data-slot="tasks-live-now-agents">
      <span title={primary.agentName} className="truncate">
        {primary.agentName}
      </span>
      {others.map((run) => (
        <span key={run.agentId} title={run.agentName} className="hidden shrink-0 truncate sm:inline">
          + {run.agentName}
        </span>
      ))}
      {entry.runs.length > 1 ? <span className="shrink-0">· {entry.runs.length} runs</span> : null}
    </span>
  );
}

type LiveNowTaskKind = "hidden" | "routine" | "chat";

const TASK_KIND_TEXT: Record<LiveNowTaskKind, { label: string; title: string }> = {
  hidden: { label: "Hidden", title: "Hidden from the task list. Filters › Show hidden tasks lists it." },
  routine: { label: "Routine", title: "A routine run" },
  chat: { label: "Chat", title: "A chat conversation" },
};

/** Why a live task may be missing from the list below: hidden, a routine run, or a chat conversation. */
export function liveNowTaskKind(
  issue: Pick<Issue, "hiddenAt" | "originKind" | "conversationAgentId"> | null,
): LiveNowTaskKind | null {
  if (!issue) return null;
  if (issue.hiddenAt) return "hidden";
  if (issue.originKind === "routine_execution") return "routine";
  if (issue.conversationAgentId || issue.originKind === "chat_channel") return "chat";
  return null;
}

export function LiveNowTaskKindTag({ issue, className }: { issue: Issue | null; className?: string }) {
  const kind = liveNowTaskKind(issue);
  if (!kind) return null;
  const text = TASK_KIND_TEXT[kind];
  return (
    <Badge
      variant="outline"
      data-slot="tasks-live-now-kind"
      data-task-kind={kind}
      title={text.title}
      className={cn("self-center px-1.5 py-0 font-normal text-ink-3", className)}
    >
      {text.label}
    </Badge>
  );
}

function LiveNowParentPath({ ancestors, truncated }: { ancestors: readonly LiveNowAncestor[]; truncated: boolean }) {
  if (ancestors.length === 0 && !truncated) return null;
  return (
    <nav
      aria-label="Parent tasks"
      data-slot="tasks-live-now-path"
      className="flex min-w-0 shrink items-center gap-1 overflow-hidden whitespace-nowrap"
    >
      <span aria-hidden="true">· in</span>
      {truncated ? <span aria-hidden="true">… ›</span> : null}
      {ancestors.map((ancestor, index) => (
        <span key={ancestor.id} className="flex min-w-0 items-center gap-1">
          {index > 0 ? <span aria-hidden="true">›</span> : null}
          <Link
            to={createIssueDetailPath(ancestor.identifier ?? ancestor.id)}
            title={ancestor.title}
            className="truncate font-mono text-ink-3 no-underline hover:text-ink hover:underline"
          >
            {ancestor.identifier ?? ancestor.id.slice(0, 8)}
          </Link>
        </span>
      ))}
    </nav>
  );
}

export function LiveNowActivity({ entry, className }: { entry: LiveNowRunSet; className?: string }) {
  const primary = entry.runs[0]!;
  const activityRun = entry.runs.reduce<LiveRunForIssue>(
    (latest, run) => ((lastLiveActivityMs(run) ?? 0) > (lastLiveActivityMs(latest) ?? 0) ? run : latest),
    primary,
  );
  const activity = describeLiveActivity(activityRun) ?? entry.runs.map(describeLiveActivity).find(Boolean) ?? null;
  const snippet = entry.runs.find((run) => run.lastAssistantSnippet?.trim())?.lastAssistantSnippet?.trim()
    ?? entry.runs.map((run) => run.nextAction?.trim()).filter(Boolean).map((next) => `Next: ${next}`)[0]
    ?? null;
  const ActivityIcon = activity?.icon ?? null;
  const text = activity?.text ?? "Waiting for the first event";
  return (
    <span
      data-slot="tasks-live-now-status"
      title={snippet ? `${text}\n\n${snippet}` : text}
      className={cn("flex min-w-0 items-center gap-1.5 text-xs text-ink-2", className)}
    >
      {ActivityIcon ? <ActivityIcon aria-hidden="true" className="size-3.5 shrink-0 text-ink-3" /> : null}
      <span className="min-w-0 truncate">{text}</span>
    </span>
  );
}

function LiveNowModelFallbackPill({ adapterType, fallback }: { adapterType: string; fallback: RunModelFallbackState }) {
  const schema = useConfigSchema(adapterType);
  const options = schema?.fields.find((field) => field.key === "model")?.options ?? [];
  return (
    <span
      data-slot="live-now-model-fallback"
      title={`${fallback.activeModel} (primary ${fallback.primaryModel})`}
      className="inline-flex min-w-0 max-w-full items-start gap-1.5 rounded-md border border-amber-500/25 bg-amber-500/10 px-2 py-1 text-left text-xs font-medium leading-snug text-amber-800 dark:text-amber-200"
    >
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-amber-500 dark:text-amber-400" />
      <span className="min-w-0 whitespace-normal break-words">
        {modelValueText(describeFallbackModel(fallback.activeModel, options))}
        <span className="text-ink-3">{" · primary: "}{modelFallbackReasonLabel(fallback.reason)}</span>
      </span>
    </span>
  );
}

interface LiveNowRowProps {
  companyId: string;
  item: LiveNowItem;
  density: LiveNowDensity;
  loadFailed: boolean;
  ancestors: readonly LiveNowAncestor[];
  truncatedAncestors: boolean;
  issueLinkState?: unknown;
}

/** One live task as a scannable row: identity, activity, state and the Steer, Open and More actions. */
export function LiveNowRow({
  companyId,
  item,
  density,
  loadFailed,
  ancestors,
  truncatedAncestors,
  issueLinkState,
}: LiveNowRowProps) {
  const { entry, issue, signal } = item;
  const composerId = useId();
  const [composing, setComposing] = useState(false);
  const actions = useLiveNowTaskActions({ companyId, item, loadFailed, issueLinkState });
  const { primary, identifier, title, taskPath, detailState } = actions;
  const runIds = entry.runs.map((run) => run.id);
  const comfortable = density === "comfortable";

  const toggleComposer = () => {
    actions.setFeedback(null);
    setComposing((open) => !open);
  };

  return (
    <li
      data-live-now-issue-id={entry.issueId}
      data-live-health={signal.health}
      data-density={density}
      className="live-now-row border-b border-line last:border-b-0"
    >
      <div data-density={density} className="live-now-row-grid">
        <span className="relative shrink-0 self-start [grid-area:avatar] sm:self-center">
          <AgentAvatar
            agent={{ id: primary.agentId, name: primary.agentName, appearance: primary.agentAppearance, avatarUrl: primary.avatarUrl }}
            size={comfortable ? 32 : 20}
            pose={LIVE_NOW_HEALTH_POSE[signal.health]}
          />
          <span
            aria-hidden="true"
            className={cn(
              "live-now-health-dot absolute -right-0.5 -bottom-0.5 rounded-full ring-2 ring-bg-2",
              comfortable ? "size-2.5" : "size-2",
              (signal.health === "active" || signal.health === "thinking") && "live-now-breathe",
            )}
          />
        </span>

        {comfortable ? null : (
          <span className="hidden truncate font-mono text-xs text-ink-3 [grid-area:id] sm:block">{identifier}</span>
        )}

        <span className="flex min-w-0 items-baseline gap-2 [grid-area:title]">
          <LiveNowTitleLink actions={actions} issue={issue} className="text-sm leading-5">
            {comfortable ? null : <span className="mr-1.5 font-mono text-xs font-normal text-ink-3 sm:hidden">{identifier}</span>}
            {title}
          </LiveNowTitleLink>
          <LiveNowTaskKindTag issue={issue} />
          {comfortable ? null : (
            <span className="hidden min-w-0 shrink truncate text-xs text-ink-3 sm:inline">{primary.agentName}</span>
          )}
        </span>

        {comfortable ? (
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-ink-3 [grid-area:meta]">
            <span className="shrink-0 font-mono">{identifier}</span>
            <span aria-hidden="true">·</span>
            <LiveNowAgents entry={entry} />
            <LiveNowParentPath ancestors={ancestors} truncated={truncatedAncestors} />
          </span>
        ) : null}

        <span className="live-now-row-status flex min-w-0 items-center gap-2 [grid-area:status]">
          <LiveNowHealthChip signal={signal} className="[grid-area:chip] sm:justify-self-start" />
          <LiveNowElapsed entry={entry} className={cn("[grid-area:duration]", !comfortable && "sm:hidden")} />
          <LiveNowActivity entry={entry} className="[grid-area:activity]" />
        </span>

        {comfortable ? (
          <LiveNowTodoLine issueId={entry.issueId} runIds={runIds} className="[grid-area:todo]" />
        ) : null}

        <span
          className={cn(
            "flex items-center gap-1 [grid-area:actions] sm:justify-end",
            comfortable && "border-t border-line pt-2 sm:border-t-0 sm:pt-0",
          )}
        >
          <LiveNowPauseButton actions={actions} iconOnly={!comfortable} />
          <Button
            type="button"
            variant="secondary"
            size="xs"
            className={cn(ICON_BUTTON, !comfortable && "hidden sm:inline-flex")}
            aria-expanded={composing}
            aria-controls={composing ? composerId : undefined}
            aria-label={`Steer ${primary.agentName} on ${identifier}`}
            title={`Steer ${primary.agentName}`}
            onClick={toggleComposer}
          >
            <MessageSquare aria-hidden="true" />
          </Button>
          <Link
            to={taskPath}
            state={detailState}
            disableIssueQuicklook
            aria-label={`Open ${identifier}`}
            title={`Open ${identifier}`}
            className={cn(buttonVariants({ variant: "secondary", size: "xs" }), ICON_BUTTON, !comfortable && "hidden sm:inline-flex")}
          >
            <ArrowUpRight aria-hidden="true" />
          </Link>
          <LiveNowMoreMenu
            entry={entry}
            identifier={identifier}
            taskPath={taskPath}
            detailState={detailState}
            stopping={actions.stopping || actions.stopNowPending}
            onSteer={toggleComposer}
            stopNow={actions.pausing}
            onStop={actions.pausing ? actions.stopNow : () => actions.setConfirmingStop(true)}
            onPauseSubtree={actions.pausable && !actions.pauseBlockedReason ? () => actions.pause("subtree") : undefined}
            className={comfortable ? "ml-auto sm:ml-0" : undefined}
          />
        </span>
      </div>

      {primary.modelFallback ? (
        <div className="flex flex-wrap items-center gap-2 px-3 pb-2 sm:pl-14">
          <LiveNowModelFallbackPill adapterType={primary.adapterType} fallback={primary.modelFallback} />
          <RestorePrimaryModelControl issueId={entry.issueId} run={primary} companyId={companyId} taskLabel={identifier} />
        </div>
      ) : null}

      {composing ? (
        <LiveNowSteerForm
          id={composerId}
          issueId={entry.issueId}
          agentName={primary.agentName}
          identifier={identifier}
          onSent={(message) => {
            setComposing(false);
            actions.setFeedback(message);
          }}
          onCancel={() => setComposing(false)}
        />
      ) : null}
      <LiveNowFeedback actions={actions} className="px-3 pb-2 sm:pl-14" />
      <LiveNowStopFlow actions={actions} />
    </li>
  );
}

function LiveNowSteerForm({
  id,
  issueId,
  agentName,
  identifier,
  onSent,
  onCancel,
}: {
  id: string;
  issueId: string;
  agentName: string;
  identifier: string;
  onSent: (message: string) => void;
  onCancel: () => void;
}) {
  const queryClient = useQueryClient();
  const [body, setBody] = useState("");
  const fieldId = `${id}-field`;
  const send = useMutation({
    mutationFn: (text: string) =>
      issuesApi.addComment(issueId, text, undefined, undefined, undefined, crypto.randomUUID(), "steer"),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issueId) });
      onSent(
        describeDeliveryDowngrade(result)
          ?? (result?.deliveredAs === "steered" ? `Steered into ${agentName}'s turn` : `Sent to ${agentName}`),
      );
    },
  });
  const text = body.trim();

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!text || send.isPending) return;
    send.mutate(text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      submit(event);
    }
  };

  return (
    <form id={id} data-slot="tasks-live-now-steer" className="space-y-2 px-3 pb-3 sm:pl-14" onSubmit={submit}>
      <label htmlFor={fieldId} className="sr-only">
        Steer {agentName} on {identifier}
      </label>
      <Textarea
        id={fieldId}
        rows={2}
        autoFocus
        value={body}
        placeholder={`Steer ${agentName}…`}
        className="min-h-14 resize-none text-sm"
        disabled={send.isPending}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={onKeyDown}
      />
      {send.error ? (
        <p role="alert" className="text-xs text-bad">
          {errorMessage(send.error, "Couldn’t send the message.")}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-1.5">
        <span className="mr-auto text-xs text-ink-3">Enter to send · Esc to cancel · steers the running turn</span>
        <Button type="button" variant="ghost" size="xs" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="xs" disabled={!text || send.isPending}>
          {send.isPending ? "Sending…" : "Send"}
        </Button>
      </div>
    </form>
  );
}
