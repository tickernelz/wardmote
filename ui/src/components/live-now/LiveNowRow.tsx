import { useId, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Clock, MessageSquare, MoreHorizontal, ScrollText, Square, TriangleAlert } from "lucide-react";
import type { Issue, RunModelFallbackState } from "@tickernelz/wardmote-shared";
import { Link } from "@/lib/router";
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
import type { LiveNowAncestor, LiveNowEntry, LiveNowItem } from "./useLiveNowModel";
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
export function LiveNowElapsed({ entry, className }: { entry: LiveNowEntry; className?: string }) {
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

/** State as a word with its colour and icon, never colour alone. */
export function LiveNowHealthChip({ signal, className }: { signal: LiveNowHealthSignal; className?: string }) {
  const Icon = signal.health === "stalled" ? TriangleAlert : signal.health === "quiet" ? Clock : null;
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
        <Icon aria-hidden="true" className="live-now-health-icon size-3 shrink-0" />
      ) : (
        <span aria-hidden="true" className="live-now-health-dot size-1.5 shrink-0 rounded-full" />
      )}
      <span className="truncate">{signal.label}</span>
    </span>
  );
}

function useLiveNowStop(entry: LiveNowEntry, companyId: string, onStopping: (message: string) => void) {
  const queryClient = useQueryClient();
  const primary = entry.runs[0]!;
  return useMutation({
    mutationFn: () => heartbeatsApi.cancel(primary.id),
    onSuccess: () => {
      onStopping(`Stopping ${primary.agentName}'s run`);
      void queryClient.invalidateQueries({ queryKey: queryKeys.liveRuns(companyId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(entry.issueId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.activeRun(entry.issueId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.runs(entry.issueId) });
    },
  });
}

function LiveNowStopDialog({
  open,
  onOpenChange,
  agentName,
  identifier,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentName: string;
  identifier: string;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Stop {agentName}&apos;s run?</AlertDialogTitle>
          <AlertDialogDescription>
            {identifier} keeps its status and comments. The agent stops mid-turn, so any unsaved work in this run is lost.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep running</AlertDialogCancel>
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
  className,
}: {
  entry: LiveNowEntry;
  identifier: string;
  taskPath: string;
  detailState?: unknown;
  stopping: boolean;
  onSteer?: () => void;
  onStop: () => void;
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
        <DropdownMenuItem asChild>
          <Link to={taskPath} state={detailState} disableIssueQuicklook className="no-underline">
            <ArrowUpRight aria-hidden="true" />
            Open task
          </Link>
        </DropdownMenuItem>
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
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={stopping}
          aria-label={`Stop ${primary.agentName}'s run on ${identifier}`}
          onSelect={onStop}
        >
          <Square aria-hidden="true" className="fill-current" />
          {stopping ? "Stopping…" : "Stop run…"}
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
}

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
  const stop = useLiveNowStop(entry, companyId, setFeedback);
  const pathId = issue?.identifier ?? entry.issueId;
  return {
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

function LiveNowAgents({ entry }: { entry: LiveNowEntry }) {
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

export function LiveNowActivity({ entry, className }: { entry: LiveNowEntry; className?: string }) {
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
            stopping={actions.stopping}
            onSteer={toggleComposer}
            onStop={() => actions.setConfirmingStop(true)}
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
