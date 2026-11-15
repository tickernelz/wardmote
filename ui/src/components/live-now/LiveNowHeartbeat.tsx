import { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { Link } from "@/lib/router";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "../../lib/utils";
import { AgentAvatar } from "../AgentAvatar";
import {
  LiveNowActivity,
  LiveNowElapsed,
  LiveNowHealthChip,
  LiveNowMoreMenu,
  LiveNowStopDialog,
  useLiveNowStop,
  type LiveNowDensity,
} from "./LiveNowRow";
import { LIVE_NOW_HEALTH_POSE } from "./live-now-health";
import type { LiveNowHeartbeatItem } from "./useLiveNowModel";

const ICON_BUTTON = "size-11 px-0 sm:size-7 has-[>svg]:px-0";

export const LIVE_NOW_HEARTBEAT_LABEL = "Heartbeat";

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Couldn’t stop the run.";
}

function useHeartbeatActions(companyId: string, item: LiveNowHeartbeatItem) {
  const run = item.entry.runs[0]!;
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const stop = useLiveNowStop(run, null, companyId, setFeedback);
  return {
    run,
    runPath: `/agents/${run.agentId}/runs/${run.id}`,
    name: `${run.agentName} ${LIVE_NOW_HEARTBEAT_LABEL.toLowerCase()}`,
    confirmingStop,
    setConfirmingStop,
    stop,
    feedback,
    confirmStop: () => {
      setFeedback(null);
      stop.mutate();
    },
  };
}

type HeartbeatActions = ReturnType<typeof useHeartbeatActions>;

function HeartbeatMoreMenu({ actions, item, className }: { actions: HeartbeatActions; item: LiveNowHeartbeatItem; className?: string }) {
  return (
    <LiveNowMoreMenu
      entry={item.entry}
      identifier={actions.name}
      stopping={actions.stop.isPending}
      onStop={() => actions.setConfirmingStop(true)}
      className={className}
    />
  );
}

function HeartbeatStopFlow({ actions, className }: { actions: HeartbeatActions; className?: string }) {
  return (
    <>
      <LiveNowStopDialog
        open={actions.confirmingStop}
        onOpenChange={actions.setConfirmingStop}
        agentName={actions.run.agentName}
        identifier={null}
        onConfirm={actions.confirmStop}
      />
      {actions.feedback || actions.stop.error ? (
        <p role={actions.stop.error ? "alert" : "status"} className={cn("text-xs", actions.stop.error ? "text-bad" : "text-ink-3", className)}>
          {actions.stop.error ? errorMessage(actions.stop.error) : actions.feedback}
        </p>
      ) : null}
    </>
  );
}

/** A live run with no task as a row: the agent, its state and activity, and links to the run. */
export function LiveNowHeartbeatRow({
  companyId,
  item,
  density,
}: {
  companyId: string;
  item: LiveNowHeartbeatItem;
  density: LiveNowDensity;
}) {
  const actions = useHeartbeatActions(companyId, item);
  const { run } = actions;
  const { signal } = item;
  const comfortable = density === "comfortable";
  return (
    <li
      data-live-now-run-id={run.id}
      data-live-now-kind="heartbeat"
      data-live-health={signal.health}
      data-density={density}
      className="live-now-row border-b border-line last:border-b-0"
    >
      <div data-density={density} className="live-now-row-grid">
        <span className="relative shrink-0 self-start [grid-area:avatar] sm:self-center">
          <AgentAvatar
            agent={{ id: run.agentId, name: run.agentName, appearance: run.agentAppearance, avatarUrl: run.avatarUrl }}
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
          <span className="hidden truncate text-xs text-ink-3 [grid-area:id] sm:block">No task</span>
        )}

        <span className="flex min-w-0 items-baseline gap-2 [grid-area:title]">
          <Link
            to={actions.runPath}
            title={`${actions.name}: a run with no task`}
            className="min-w-0 truncate rounded-sm text-sm leading-5 font-semibold text-ink no-underline outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
          >
            {LIVE_NOW_HEARTBEAT_LABEL}
          </Link>
          {comfortable ? null : (
            <span className="min-w-0 shrink truncate text-xs text-ink-3">{run.agentName}</span>
          )}
        </span>

        {comfortable ? (
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-ink-3 [grid-area:meta]">
            <span className="truncate" title={run.agentName}>{run.agentName}</span>
            <span aria-hidden="true">·</span>
            <span className="shrink-0">No task</span>
          </span>
        ) : null}

        <span className="live-now-row-status flex min-w-0 items-center gap-2 [grid-area:status]">
          <LiveNowHealthChip signal={signal} className="[grid-area:chip] sm:justify-self-start" />
          <LiveNowElapsed entry={item.entry} className={cn("[grid-area:duration]", !comfortable && "sm:hidden")} />
          <LiveNowActivity entry={item.entry} className="[grid-area:activity]" />
        </span>

        <span
          className={cn(
            "flex items-center gap-1 [grid-area:actions] sm:justify-end",
            comfortable && "border-t border-line pt-2 sm:border-t-0 sm:pt-0",
          )}
        >
          <Link
            to={actions.runPath}
            aria-label={`Open ${actions.name} run`}
            title="Open run transcript"
            className={cn(buttonVariants({ variant: "secondary", size: "xs" }), ICON_BUTTON, !comfortable && "hidden sm:inline-flex")}
          >
            <ArrowUpRight aria-hidden="true" />
          </Link>
          <HeartbeatMoreMenu actions={actions} item={item} className={comfortable ? "ml-auto sm:ml-0" : undefined} />
        </span>
      </div>
      <HeartbeatStopFlow actions={actions} className="px-3 pb-2 sm:pl-14" />
    </li>
  );
}

/** A live run with no task as a card in its lane of the board band. */
export function LiveNowHeartbeatCard({ companyId, item }: { companyId: string; item: LiveNowHeartbeatItem }) {
  const actions = useHeartbeatActions(companyId, item);
  const { run } = actions;
  return (
    <li
      data-live-now-run-id={run.id}
      data-live-now-kind="heartbeat"
      data-live-health={item.signal.health}
      className="live-now-board-card relative flex flex-col gap-1.5 rounded-md border border-line bg-bg-2 p-2.5 text-ink focus-within:ring-2 focus-within:ring-focus"
    >
      <span className="flex items-center gap-2">
        <span className="text-xs text-ink-3">No task</span>
        <LiveNowHealthChip signal={item.signal} className="ml-auto" />
      </span>
      <Link
        to={actions.runPath}
        className="line-clamp-2 text-sm leading-5 font-semibold text-ink no-underline outline-none after:absolute after:inset-0 after:content-[''] hover:underline"
      >
        {LIVE_NOW_HEARTBEAT_LABEL}
      </Link>
      <LiveNowActivity entry={item.entry} />
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-ink-3">
        <AgentAvatar
          agent={{ id: run.agentId, name: run.agentName, appearance: run.agentAppearance, avatarUrl: run.avatarUrl }}
          size={16}
        />
        <span className="min-w-0 truncate" title={run.agentName}>{run.agentName}</span>
        <LiveNowElapsed entry={item.entry} className="ml-auto" />
        <span className="relative z-10 flex items-center gap-1">
          <HeartbeatMoreMenu actions={actions} item={item} />
        </span>
      </span>
      <HeartbeatStopFlow actions={actions} />
    </li>
  );
}
