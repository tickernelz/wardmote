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
  LiveNowStopFlow,
  useLiveNowTaskActions,
} from "./LiveNowRow";
import type { LiveNowGroup } from "./live-now-health";
import type { LiveNowItem } from "./useLiveNowModel";

const LANE_CARD_LIMIT = 2;

export const LIVE_NOW_GROUP_LABEL: Record<LiveNowGroup, string> = {
  attention: "Needs attention",
  working: "Working",
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
  lanes: readonly { group: LiveNowGroup; items: readonly LiveNowItem[] }[];
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
          failedIds={failedIds}
          issueLinkState={issueLinkState}
        />
      ))}
    </div>
  );
}

function LiveNowLane({
  companyId,
  group,
  items,
  failedIds,
  issueLinkState,
}: {
  companyId: string;
  group: LiveNowGroup;
  items: readonly LiveNowItem[];
  failedIds: ReadonlySet<string>;
  issueLinkState?: unknown;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(0, LANE_CARD_LIMIT);
  const hidden = items.length - shown.length;
  const label = LIVE_NOW_GROUP_LABEL[group];
  return (
    <section
      aria-label={`${label}, ${items.length}`}
      data-live-now-lane={group}
      className="live-now-lane flex w-(--live-now-lane-width) shrink-0 snap-start flex-col rounded-lg bg-bg-3/60 p-2 sm:w-auto"
    >
      <h3 className="flex items-center gap-1.5 px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-ink-2">
        <span aria-hidden="true" data-live-group={group} className="live-now-group-dot size-1.5 rounded-full" />
        {label}
        <span className="ml-auto font-normal tabular-nums text-ink-3">{items.length}</span>
      </h3>
      {items.length === 0 ? (
        <p className="px-1 pb-1 text-xs text-ink-3">{group === "attention" ? "Nothing needs attention" : "Nothing working"}</p>
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
        </ul>
      )}
      {items.length > LANE_CARD_LIMIT ? (
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
        <span className="relative z-10">
          <LiveNowMoreMenu
            entry={entry}
            identifier={identifier}
            taskPath={taskPath}
            detailState={detailState}
            stopping={actions.stopping}
            onStop={() => actions.setConfirmingStop(true)}
          />
        </span>
      </span>
      <LiveNowFeedback actions={actions} />
      <LiveNowStopFlow actions={actions} />
    </li>
  );
}
