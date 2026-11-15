import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { ChevronRight, Rows2, Rows3 } from "lucide-react";
import type { Issue } from "@tickernelz/wardmote-shared";
import type { LiveRunForIssue } from "../api/heartbeats";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { usePausedTasks } from "../hooks/usePausedTasks";
import { cn } from "../lib/utils";
import { Chip } from "./ui/chip";
import { Segmented, SegmentedItem } from "./ui/segmented";
import { AgentAvatar } from "./AgentAvatar";
import { LiveRunDot } from "./IssueColumns";
import { findIssuesScrollContainer } from "./IssuesList";
import { LIVE_NOW_GROUP_LABEL, LiveNowBoardBand } from "./live-now/LiveNowBoardBand";
import { LiveNowRow, type LiveNowDensity } from "./live-now/LiveNowRow";
import { LiveNowPausedRow } from "./live-now/LiveNowPaused";
import { LIVE_NOW_HEARTBEAT_LABEL, LiveNowHeartbeatRow } from "./live-now/LiveNowHeartbeat";
import {
  LIVE_NOW_HEALTH_POSE,
  type LiveNowGroup,
  type LiveNowHealth,
  type LiveNowHealthSignal,
} from "./live-now/live-now-health";
import {
  resolveLiveNowParentPath,
  useLiveNowModel,
  type LiveNowHeartbeatItem,
  type LiveNowItem,
  type LiveNowPausedItem,
  type LiveNowRunSet,
} from "./live-now/useLiveNowModel";

const MAX_VISIBLE_ANCESTORS = 3;
const MAX_STRIP_AVATARS = 5;
const MOBILE_STRIP_AVATARS = 2;
const WORKING_LIMIT_PHONE = 2;
const WORKING_LIMIT_COMFORTABLE = 4;
const GROUP_ORDER: readonly LiveNowGroup[] = ["attention", "working", "paused"];
const DESKTOP_QUERY = "(min-width: 40rem)";

type GroupFilter = "all" | LiveNowGroup;

/** Storage key holding whether the Live now section is collapsed for a company. */
export function liveNowCollapsedStorageKey(companyId: string): string {
  return `wardmote:tasks-live-now:collapsed:${companyId}`;
}

/** Storage key holding the row density the user picked for a company. */
export function liveNowDensityStorageKey(companyId: string): string {
  return `wardmote:tasks-live-now:density:${companyId}`;
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    return;
  }
}

function readDensity(companyId: string): LiveNowDensity | null {
  const stored = readStorage(liveNowDensityStorageKey(companyId));
  return stored === "comfortable" || stored === "compact" ? stored : null;
}

/** Keeps rows below the element still when it resizes above the viewport; the returned callback exempts the next resize. */
export function useAboveViewportResizeCompensation(ref: RefObject<HTMLElement | null>): () => void {
  const skipNextResizeRef = useRef(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const container = findIssuesScrollContainer(element);
    const scrollTarget: HTMLElement | Window = container ?? window;
    const bottomBelowViewportTop = () =>
      element.getBoundingClientRect().bottom - (container ? container.getBoundingClientRect().top : 0);
    let lastBottom = bottomBelowViewportTop();
    const syncBottom = () => {
      lastBottom = bottomBelowViewportTop();
    };
    const observer = new ResizeObserver(() => {
      const bottom = bottomBelowViewportTop();
      const shift = bottom - lastBottom;
      const skip = skipNextResizeRef.current;
      skipNextResizeRef.current = false;
      if (!skip && shift !== 0 && lastBottom <= 0) {
        if (container) container.scrollTop += shift;
        else window.scrollBy(0, shift);
        syncBottom();
        return;
      }
      lastBottom = bottom;
    });
    scrollTarget.addEventListener("scroll", syncBottom, { passive: true });
    observer.observe(element);
    return () => {
      observer.disconnect();
      scrollTarget.removeEventListener("scroll", syncBottom);
    };
  }, [ref]);
  return useCallback(() => {
    skipNextResizeRef.current = true;
  }, []);
}

interface TasksLiveNowSectionProps {
  companyId: string;
  liveRuns: readonly LiveRunForIssue[] | null | undefined;
  issues: readonly Issue[];
  issueLinkState?: unknown;
  view?: "list" | "board";
  issueFilter?: ((issue: Issue) => boolean) | null;
}

/** Collapsible list (or board lanes) of tasks with a run in progress, pinned above the Tasks list. */
export function TasksLiveNowSection({
  companyId,
  liveRuns,
  issues,
  issueLinkState,
  view = "list",
  issueFilter = null,
}: TasksLiveNowSectionProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const skipNextResizeCompensation = useAboveViewportResizeCompensation(rootRef);
  const [collapsed, setCollapsed] = useState(() => readStorage(liveNowCollapsedStorageKey(companyId)) === "true");
  const [storedDensity, setStoredDensity] = useState(() => readDensity(companyId));
  const [groupFilter, setGroupFilter] = useState<GroupFilter>("all");
  const [showFiltered, setShowFiltered] = useState(false);
  const [showAllWorking, setShowAllWorking] = useState(false);
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const listId = useId();

  const pausedTasks = usePausedTasks(companyId);
  const { items, heartbeats, pausedItems, loadedById, detailById, failedIds } = useLiveNowModel(liveRuns, issues, pausedTasks);
  const density: LiveNowDensity = storedDensity ?? (desktop ? "comfortable" : "compact");

  const passesFilter = (issue: Issue | null) => !issueFilter || issue === null || issueFilter(issue);
  const hiddenByFilters = issueFilter
    ? items.filter((item) => !passesFilter(item.issue)).length + pausedItems.filter((item) => !passesFilter(item.issue)).length
    : 0;
  const visible = showFiltered ? items : items.filter((item) => passesFilter(item.issue));
  const visiblePaused = showFiltered ? pausedItems : pausedItems.filter((item) => passesFilter(item.issue));
  const groupCounts: Record<LiveNowGroup, number> = { attention: 0, working: 0, paused: visiblePaused.length };
  for (const item of visible) groupCounts[item.group] += 1;
  for (const item of heartbeats) groupCounts[item.group] += 1;
  const visibleCount = visible.length + heartbeats.length + visiblePaused.length;
  const shownGroups = GROUP_ORDER.filter((group) => groupFilter === "all" || groupFilter === group);
  const announcement = useHealthAnnouncement(
    [
      ...items.map((item) => `${item.identifier}\t${item.signal.health}`),
      ...heartbeats.map((item) => `${item.entry.runs[0]!.agentName} ${LIVE_NOW_HEARTBEAT_LABEL.toLowerCase()}\t${item.signal.health}`),
      ...pausedItems.map((item) => `${item.identifier}\t${item.pause.state}`),
    ].join("\n"),
  );

  const toggle = () => {
    const next = !collapsed;
    skipNextResizeCompensation();
    setCollapsed(next);
    writeStorage(liveNowCollapsedStorageKey(companyId), next ? "true" : null);
  };

  const pickGroup = (group: GroupFilter) => {
    setGroupFilter(group);
    if (collapsed) toggle();
  };

  const pickDensity = (next: LiveNowDensity) => {
    setStoredDensity(next);
    writeStorage(liveNowDensityStorageKey(companyId), next);
  };

  const workingLimit = !desktop ? WORKING_LIMIT_PHONE : density === "comfortable" ? WORKING_LIMIT_COMFORTABLE : Infinity;

  const renderPausedRow = (item: LiveNowPausedItem) => (
    <LiveNowPausedRow
      key={item.pause.holdId}
      companyId={companyId}
      item={item}
      density={density}
      issueLinkState={issueLinkState}
    />
  );

  const renderHeartbeatRow = (item: LiveNowHeartbeatItem) => (
    <LiveNowHeartbeatRow key={item.entry.runs[0]!.id} companyId={companyId} item={item} density={density} />
  );

  const renderRow = (item: LiveNowItem) => {
    const { ancestors, complete } = resolveLiveNowParentPath(
      item.issue,
      loadedById,
      detailById.get(item.entry.issueId)?.ancestors ?? null,
    );
    const visibleAncestors = ancestors.slice(-MAX_VISIBLE_ANCESTORS);
    return (
      <LiveNowRow
        key={item.entry.issueId}
        companyId={companyId}
        item={item}
        density={density}
        loadFailed={failedIds.has(item.entry.issueId)}
        ancestors={visibleAncestors}
        truncatedAncestors={!complete || ancestors.length > visibleAncestors.length}
        issueLinkState={issueLinkState}
      />
    );
  };

  return (
    <div ref={rootRef} data-slot="tasks-live-now" data-view={view}>
      {items.length + heartbeats.length + pausedItems.length > 0 ? (
        <section aria-label="Live now" className="pb-4">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1.5 pl-1.5 pr-2 text-left outline-none hover:bg-bg-3/40 focus-visible:ring-2 focus-visible:ring-focus sm:flex-none"
              aria-expanded={!collapsed}
              aria-controls={collapsed ? undefined : listId}
              onClick={toggle}
            >
              <span className="inline-flex w-4 shrink-0 items-center justify-center">
                <ChevronRight
                  aria-hidden="true"
                  className={cn("h-3.5 w-3.5 shrink-0 text-ink-3 transition-transform", !collapsed && "rotate-90")}
                />
              </span>
              <LiveRunDot />
              <span className="shrink-0 text-sm font-semibold uppercase tracking-wide">Live now</span>
              <span data-slot="tasks-live-now-count" className="text-xs tabular-nums text-ink-3">
                {visibleCount}
              </span>
              {collapsed ? <LiveNowAvatarStrip items={[...visible, ...heartbeats]} /> : null}
              <LiveNowAttentionSummary count={groupCounts.attention} />
            </button>
            <div
              role="group"
              aria-label="Show live tasks"
              data-slot="tasks-live-now-groups"
              className="hidden items-center gap-1.5 sm:ml-auto sm:flex"
            >
              <Chip selected={groupFilter === "all"} onClick={() => pickGroup("all")}>
                All <span className="tabular-nums">{visibleCount}</span>
              </Chip>
              {GROUP_ORDER.filter((group) => groupCounts[group] > 0 || groupFilter === group).map((group) => (
                <Chip key={group} selected={groupFilter === group} onClick={() => pickGroup(group)}>
                  <span aria-hidden="true" data-live-group={group} className="live-now-group-dot size-1.5 rounded-full" />
                  {LIVE_NOW_GROUP_LABEL[group]} <span className="tabular-nums">{groupCounts[group]}</span>
                </Chip>
              ))}
            </div>
            {hiddenByFilters > 0 ? (
              <Chip
                data-slot="tasks-live-now-hidden"
                selected={showFiltered}
                title={showFiltered ? "Hide live tasks the filters exclude" : "Show live tasks the filters exclude"}
                onClick={() => setShowFiltered((value) => !value)}
              >
                {hiddenByFilters} hidden by filters
              </Chip>
            ) : null}
            {view === "list" ? (
              <Segmented aria-label="Row density" className="ml-auto sm:ml-0">
                <SegmentedItem
                  selected={density === "comfortable"}
                  aria-label="Comfortable rows"
                  title="Comfortable rows"
                  onClick={() => pickDensity("comfortable")}
                >
                  <Rows2 aria-hidden="true" />
                  <span className="hidden lg:inline">Comfortable</span>
                </SegmentedItem>
                <SegmentedItem
                  selected={density === "compact"}
                  aria-label="Compact rows"
                  title="Compact rows"
                  onClick={() => pickDensity("compact")}
                >
                  <Rows3 aria-hidden="true" />
                  <span className="hidden lg:inline">Compact</span>
                </SegmentedItem>
              </Segmented>
            ) : null}
          </div>
          {collapsed ? null : view === "board" ? (
            <LiveNowBoardBand
              companyId={companyId}
              listId={listId}
              lanes={shownGroups.map((group) => ({
                group,
                items: visible.filter((item) => item.group === group),
                heartbeats: heartbeats.filter((item) => item.group === group),
                paused: group === "paused" ? visiblePaused : [],
              }))}
              failedIds={failedIds}
              issueLinkState={issueLinkState}
            />
          ) : (
            <div id={listId} data-slot="tasks-live-now-list" className="mt-2 overflow-hidden rounded-xl border border-line bg-bg-2">
              {shownGroups.map((group) => {
                const groupItems = visible.filter((item) => item.group === group);
                const groupHeartbeats = heartbeats.filter((item) => item.group === group);
                const groupPaused = group === "paused" ? visiblePaused : [];
                const groupTotal = groupItems.length + groupHeartbeats.length + groupPaused.length;
                if (groupTotal === 0) return null;
                const limit = group === "working" && !showAllWorking ? workingLimit : Infinity;
                const shown = groupItems.slice(0, limit);
                const shownHeartbeats = groupHeartbeats.slice(0, Math.max(0, limit - shown.length));
                const running = groupItems.length + groupHeartbeats.length;
                const more = running - shown.length - shownHeartbeats.length;
                return (
                  <section key={group} aria-label={`${LIVE_NOW_GROUP_LABEL[group]}, ${groupTotal}`} data-live-now-group={group}>
                    <h3 className="flex items-center gap-1.5 border-b border-line bg-bg-3/40 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-ink-2">
                      <span aria-hidden="true" data-live-group={group} className="live-now-group-dot size-1.5 rounded-full" />
                      {LIVE_NOW_GROUP_LABEL[group]}
                      <span className="font-normal tabular-nums text-ink-3">{groupTotal}</span>
                    </h3>
                    <ul>
                      {shown.map(renderRow)}
                      {shownHeartbeats.map(renderHeartbeatRow)}
                      {groupPaused.map(renderPausedRow)}
                    </ul>
                    {more > 0 || (group === "working" && showAllWorking && running > workingLimit) ? (
                      <button
                        type="button"
                        className="w-full border-t border-line px-3 py-2 text-center text-xs text-ink-3 outline-none hover:bg-bg-3/40 hover:text-ink focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus"
                        onClick={() => setShowAllWorking((value) => !value)}
                      >
                        {showAllWorking ? "Show fewer" : `Show ${more} more working`}
                      </button>
                    ) : null}
                  </section>
                );
              })}
            </div>
          )}
          <p role="status" aria-live="polite" className="sr-only" data-slot="tasks-live-now-announcer">
            {announcement}
          </p>
        </section>
      ) : null}
    </div>
  );
}

function useHealthAnnouncement(healthKey: string): string {
  const previousRef = useRef<Map<string, LiveNowHealth> | null>(null);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    const next = new Map<string, LiveNowHealth>();
    for (const line of healthKey ? healthKey.split("\n") : []) {
      const [identifier, health] = line.split("\t") as [string, LiveNowHealth];
      next.set(identifier, health);
    }
    const previous = previousRef.current;
    previousRef.current = next;
    if (!previous) return;
    const changes: string[] = [];
    for (const [identifier, health] of next) {
      const before = previous.get(identifier);
      if (!before || before === health) continue;
      if (health === "paused") changes.push(`${identifier} is paused`);
      else if (health === "pause_failed") changes.push(`${identifier} did not stop within 120 seconds`);
      else if (health === "pausing") changes.push(`${identifier} is pausing`);
      else if (health === "stalled" || health === "quiet") changes.push(`${identifier} is ${health}`);
      else if (before === "stalled" || before === "quiet") changes.push(`${identifier} is working again`);
    }
    if (changes.length > 0) setAnnouncement(changes.join(". "));
  }, [healthKey]);
  return announcement;
}

function LiveNowAttentionSummary({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span data-slot="tasks-live-now-summary" className="ml-auto flex shrink-0 items-center gap-1.5 text-xs font-medium text-bad sm:hidden">
      <span aria-hidden="true" data-live-group="attention" className="live-now-group-dot size-1.5 rounded-full" />
      {count} need{count === 1 ? "s" : ""} attention
    </span>
  );
}

function LiveNowAvatarStrip({ items }: { items: readonly { entry: LiveNowRunSet; signal: LiveNowHealthSignal }[] }) {
  const agents = new Map<string, { run: LiveRunForIssue; health: LiveNowHealth }>();
  for (const item of items) {
    for (const run of item.entry.runs) {
      if (!agents.has(run.agentId)) agents.set(run.agentId, { run, health: item.signal.health });
    }
  }
  const all = [...agents.values()];
  const shown = all.slice(0, MAX_STRIP_AVATARS);
  const extra = all.length - shown.length;
  const mobileExtra = all.length - Math.min(all.length, MOBILE_STRIP_AVATARS);
  return (
    <span data-slot="tasks-live-now-avatars" className="flex shrink-0 items-center pl-1">
      {shown.map(({ run, health }, index) => (
        <span
          key={run.agentId}
          title={run.agentName}
          className={cn(
            "-ml-1.5 inline-flex rounded-full bg-bg-2 ring-2 ring-bg-2 first:ml-0",
            index >= MOBILE_STRIP_AVATARS && "hidden sm:inline-flex",
          )}
        >
          <AgentAvatar
            agent={{ id: run.agentId, name: run.agentName, appearance: run.agentAppearance }}
            size={24}
            pose={LIVE_NOW_HEALTH_POSE[health]}
          />
        </span>
      ))}
      {mobileExtra > 0 ? (
        <span aria-hidden="true" className="ml-1 text-xs tabular-nums text-ink-3 sm:hidden">+{mobileExtra}</span>
      ) : null}
      {extra > 0 ? (
        <span aria-hidden="true" className="ml-1 hidden text-xs tabular-nums text-ink-3 sm:inline">+{extra}</span>
      ) : null}
      <span className="sr-only">{all.map(({ run }) => run.agentName).join(", ")}</span>
    </span>
  );
}
