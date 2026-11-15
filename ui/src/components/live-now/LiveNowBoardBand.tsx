import { useState } from "react";
import { Link } from "@/lib/router";
import { rememberIssueDetailLocationState } from "../../lib/issueDetailBreadcrumb";
import { AgentAvatar } from "../AgentAvatar";
import {
  LiveNowActivity,
  LiveNowElapsed,
  LiveNowFeedback,
  LiveNowHealthChip,
  LiveNowMoreMenu,
  LiveNowPauseButton,
  LiveNowStopFlow,
  LiveNowTaskKindTag,
  useLiveNowTaskActions,
} from "./LiveNowRow";
import type { LiveNowGroup } from "./live-now-health";
import type { LiveNowHeartbeatItem, LiveNowItem, LiveNowPausedItem } from "./useLiveNowModel";
import { LiveNowHeartbeatCard } from "./LiveNowHeartbeat";
import { LiveNowPausedCard } from "./LiveNowPaused";

const LANE_CARD_LIMIT = 2;

export const LIVE_NOW_GROUP_LABEL: Record<LiveNowGroup, string> = {
  attention: "Needs attention",
  working: "Working",
  paused: "Paused",
};

/** Live tasks as lanes per state above the status board: what needs a hand first, then what is working. */
export function LiveNowBoardBand({
  companyId,
  lanes,
  failedIds,
  issueLinkState,
  listId,
}: {
  companyId: string;
  lanes: readonly {
    group: LiveNowGroup;
    items: readonly LiveNowItem[];
    heartbeats: readonly LiveNowHeartbeatItem[];
    paused: readonly LiveNowPausedItem[];
  }[];
  failedIds: ReadonlySet<string>;
  issueLinkState?: unknown;
  listId: string;
}) {
  return (
    <div
      id={listId}
      data-slot="tasks-live-now-band"
      className="live-now-band scrollbar-none mt-2 flex snap-x snap-mandatory gap-3 overflow-x-auto pb-1 sm:grid sm:overflow-visible sm:pb-0"
      style={{ gridTemplateColumns: `repeat(${lanes.length}, minmax(0, 1fr))` }}
    >
      {lanes.map((lane) => (
        <LiveNowLane
          key={lane.group}
          companyId={companyId}
          group={lane.group}
          items={lane.items}
          heartbeats={lane.heartbeats}
          paused={lane.paused}
          failedIds={failedIds}
          issueLinkState={issueLinkState}
        />
      ))}
    </div>
  );
}

const EMPTY_LANE_TEXT: Record<LiveNowGroup, string> = {
  attention: "Nothing needs attention",
  working: "Nothing working",
  paused: "Nothing paused",
};

function LiveNowLane({
  companyId,
  group,
  items,
  heartbeats,
  paused,
  failedIds,
  issueLinkState,
}: {
  companyId: string;
  group: LiveNowGroup;
  items: readonly LiveNowItem[];
  heartbeats: readonly LiveNowHeartbeatItem[];
  paused: readonly LiveNowPausedItem[];
  failedIds: ReadonlySet<string>;
  issueLinkState?: unknown;
}) {
  const [expanded, setExpanded] = useState(false);
  const total = items.length + heartbeats.length + paused.length;
  const shown = expanded ? items : items.slice(0, LANE_CARD_LIMIT);
  const shownHeartbeats = expanded ? heartbeats : heartbeats.slice(0, Math.max(0, LANE_CARD_LIMIT - shown.length));
  const shownPaused = expanded
    ? paused
    : paused.slice(0, Math.max(0, LANE_CARD_LIMIT - shown.length - shownHeartbeats.length));
  const hidden = total - shown.length - shownHeartbeats.length - shownPaused.length;
  const label = LIVE_NOW_GROUP_LABEL[group];
  return (
    <section
      aria-label={`${label}, ${total}`}
      data-live-now-lane={group}
      className="live-now-lane flex w-(--live-now-lane-width) shrink-0 snap-start flex-col rounded-lg bg-bg-3/60 p-2 sm:w-auto"
    >
      <h3 className="flex items-center gap-1.5 px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-ink-2">
        <span aria-hidden="true" data-live-group={group} className="live-now-group-dot size-1.5 rounded-full" />
        {label}
        <span className="ml-auto font-normal tabular-nums text-ink-3">{total}</span>
      </h3>
      {total === 0 ? (
        <p className="px-1 pb-1 text-xs text-ink-3">{EMPTY_LANE_TEXT[group]}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((item) => (
            <LiveNowBoardCard
              key={item.entry.issueId}
              companyId={companyId}
              item={item}
              loadFailed={failedIds.has(item.entry.issueId)}
              issueLinkState={issueLinkState}
            />
          ))}
          {shownHeartbeats.map((item) => (
            <LiveNowHeartbeatCard key={item.entry.runs[0]!.id} companyId={companyId} item={item} />
          ))}
          {shownPaused.map((item) => (
            <LiveNowPausedCard key={item.pause.holdId} companyId={companyId} item={item} issueLinkState={issueLinkState} />
          ))}
        </ul>
      )}
      {total > LANE_CARD_LIMIT ? (
        <button
          type="button"
          className="mt-1.5 self-start rounded-md px-1.5 py-1 text-xs text-ink-3 outline-none hover:bg-bg-3 hover:text-ink focus-visible:ring-2 focus-visible:ring-focus"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show fewer" : `+${hidden} more`}
        </button>
      ) : null}
    </section>
  );
}

function LiveNowBoardCard({
  companyId,
  item,
  loadFailed,
  issueLinkState,
}: {
  companyId: string;
  item: LiveNowItem;
  loadFailed: boolean;
  issueLinkState?: unknown;
}) {
  const { entry, issue, signal } = item;
  const actions = useLiveNowTaskActions({ companyId, item, loadFailed, issueLinkState });
  const { primary, identifier, title, taskPath, detailState, pathId } = actions;
  return (
    <li
      data-live-now-issue-id={entry.issueId}
      data-live-health={signal.health}
      className="live-now-board-card relative flex flex-col gap-1.5 rounded-md border border-line bg-bg-2 p-2.5 text-ink focus-within:ring-2 focus-within:ring-focus"
    >
      <span className="flex items-center gap-2">
        <span className="font-mono text-xs text-ink-3">{identifier}</span>
        <LiveNowTaskKindTag issue={issue} />
        <LiveNowHealthChip signal={signal} className="ml-auto" />
      </span>
      <Link
        to={taskPath}
        state={detailState}
        issuePrefetch={issue}
        disableIssueQuicklook
        onClickCapture={detailState ? () => rememberIssueDetailLocationState(pathId, detailState) : undefined}
        className="line-clamp-2 text-sm leading-5 font-semibold text-ink no-underline outline-none after:absolute after:inset-0 after:content-[''] hover:underline"
      >
        {title}
      </Link>
      <LiveNowActivity entry={entry} />
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-ink-3">
        <AgentAvatar
          agent={{ id: primary.agentId, name: primary.agentName, appearance: primary.agentAppearance, avatarUrl: primary.avatarUrl }}
          size={16}
        />
        <span className="min-w-0 truncate" title={primary.agentName}>{primary.agentName}</span>
        <LiveNowElapsed entry={entry} className="ml-auto" />
        <span className="relative z-10 flex items-center gap-1">
          <LiveNowPauseButton actions={actions} iconOnly />
          <LiveNowMoreMenu
            entry={entry}
            identifier={identifier}
            taskPath={taskPath}
            detailState={detailState}
            stopping={actions.stopping || actions.stopNowPending}
            stopNow={actions.pausing}
            onStop={actions.pausing ? actions.stopNow : () => actions.setConfirmingStop(true)}
            onPauseSubtree={actions.pausable && !actions.pauseBlockedReason ? () => actions.pause("subtree") : undefined}
          />
        </span>
      </span>
      <LiveNowFeedback actions={actions} />
      <LiveNowStopFlow actions={actions} />
    </li>
  );
}
