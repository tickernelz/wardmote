import { useEffect, useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import type { Issue, PausedTask } from "@tickernelz/wardmote-shared";
import type { LiveRunForIssue } from "../../api/heartbeats";
import { issuesApi } from "../../api/issues";
import { isLiveIssueRun } from "../../lib/liveIssueIds";
import { queryKeys } from "../../lib/queryKeys";
import {
  classifyLiveNowHealth,
  compareLiveNowSeverity,
  liveNowGroupOf,
  mostSevereSignal,
  nextLiveNowHealthChangeMs,
  pauseSignal,
  type LiveNowGroup,
  type LiveNowHealthSignal,
} from "./live-now-health";

const ISSUE_DETAIL_STALE_TIME_MS = 30_000;
const NO_PAUSED_TASKS: readonly PausedTask[] = [];

export interface LiveNowEntry {
  issueId: string;
  runs: LiveRunForIssue[];
  latestStartAt: string;
  earliestStartedAt: string | null;
}

export interface LiveNowAncestor {
  id: string;
  identifier: string | null;
  title: string;
}

export interface LiveNowItem {
  entry: LiveNowEntry;
  issue: Issue | null;
  identifier: string;
  signal: LiveNowHealthSignal;
  group: LiveNowGroup;
  pause: PausedTask | null;
}

/** A paused task with no run left, shown in the Paused group until it is resumed or its pause ends. */
export interface LiveNowPausedItem {
  pause: PausedTask;
  issue: Issue | null;
  identifier: string;
}

type LiveNowIssueNode = Pick<Issue, "id" | "identifier" | "title" | "parentId">;

function runStartAt(run: LiveRunForIssue): string {
  return run.startedAt ?? run.createdAt;
}

function timestampMs(value: string): number {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

/** Groups live runs into one entry per task, most recently started first. */
export function buildLiveNowEntries(
  liveRuns: readonly LiveRunForIssue[] | null | undefined,
  issueStatusById: ReadonlyMap<string, string>,
): LiveNowEntry[] {
  const runsByIssueId = new Map<string, LiveRunForIssue[]>();
  for (const run of liveRuns ?? []) {
    if (!run.issueId || !isLiveIssueRun(run, issueStatusById.get(run.issueId))) continue;
    const runs = runsByIssueId.get(run.issueId);
    if (runs) runs.push(run);
    else runsByIssueId.set(run.issueId, [run]);
  }
  const entries: LiveNowEntry[] = [];
  for (const [issueId, runs] of runsByIssueId) {
    runs.sort((a, b) => timestampMs(runStartAt(b)) - timestampMs(runStartAt(a)));
    const started = runs.filter((run) => run.startedAt !== null);
    entries.push({
      issueId,
      runs,
      latestStartAt: runStartAt(runs[0]!),
      earliestStartedAt: started.length > 0 ? started[started.length - 1]!.startedAt : null,
    });
  }
  return entries.sort((a, b) => timestampMs(b.latestStartAt) - timestampMs(a.latestStartAt));
}

/** Resolves a task's ancestors root-first from loaded tasks, falling back to the detail ancestors. */
export function resolveLiveNowParentPath(
  issue: Pick<Issue, "parentId"> | null | undefined,
  loadedById: ReadonlyMap<string, LiveNowIssueNode>,
  detailAncestors?: readonly LiveNowAncestor[] | null,
): { ancestors: LiveNowAncestor[]; complete: boolean } {
  const chain: LiveNowAncestor[] = [];
  const seen = new Set<string>();
  let parentId = issue?.parentId ?? null;
  let missing = false;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = loadedById.get(parentId);
    if (!parent) {
      missing = true;
      break;
    }
    chain.push({ id: parent.id, identifier: parent.identifier ?? null, title: parent.title });
    parentId = parent.parentId ?? null;
  }
  if (!missing) return { ancestors: chain.reverse(), complete: true };
  if (detailAncestors) {
    return {
      ancestors: [...detailAncestors].reverse().map(({ id, identifier, title }) => ({ id, identifier, title })),
      complete: true,
    };
  }
  return { ancestors: chain.reverse(), complete: false };
}

/** Classifies each live task and orders them: needs attention first (stalled before quiet), then working, newest start first within a group. */
export function buildLiveNowItems(
  entries: readonly LiveNowEntry[],
  issueById: (issueId: string) => Issue | null,
  now: number,
  pauseByIssueId: ReadonlyMap<string, PausedTask> = new Map(),
): LiveNowItem[] {
  const items = entries.map((entry, order) => {
    const issue = issueById(entry.issueId);
    const pause = pauseByIssueId.get(entry.issueId) ?? null;
    const signal = pause
      ? pauseSignal(pause.state)
      : mostSevereSignal(entry.runs.map((run) => classifyLiveNowHealth(run, now)));
    return {
      order,
      item: {
        entry,
        issue,
        identifier: issue?.identifier ?? entry.issueId.slice(0, 8),
        signal,
        group: liveNowGroupOf(signal.health),
        pause,
      } satisfies LiveNowItem,
    };
  });
  items.sort((a, b) => {
    if (a.item.group !== b.item.group) return a.item.group === "attention" ? -1 : 1;
    if (a.item.group === "attention") {
      const severity = compareLiveNowSeverity(a.item.signal.health, b.item.signal.health);
      if (severity !== 0) return severity;
    }
    return a.order - b.order;
  });
  return items.map(({ item }) => item);
}

/** Current time that re-renders the caller only when a run's health or its label changes on its own, not every second. */
export function useLiveNowClock(runs: readonly LiveRunForIssue[]): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const now = Date.now();
    let next: number | null = null;
    for (const run of runs) {
      const at = nextLiveNowHealthChangeMs(run, now);
      if (at !== null && (next === null || at < next)) next = at;
    }
    if (next === null) return;
    const timer = window.setTimeout(() => setTick((value) => value + 1), Math.max(0, next - now) + 50);
    return () => window.clearTimeout(timer);
  }, [runs, tick]);
  return Date.now();
}

/** Live tasks with their issue, health and group, fetching the detail of live tasks the list has not loaded. */
export function useLiveNowModel(
  liveRuns: readonly LiveRunForIssue[] | null | undefined,
  issues: readonly Issue[],
  pausedTasks: readonly PausedTask[] = NO_PAUSED_TASKS,
) {
  const loadedById = useMemo(() => new Map(issues.map((issue) => [issue.id, issue])), [issues]);

  const detailIssueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of liveRuns ?? []) {
      if (!run.issueId || ids.has(run.issueId) || !isLiveIssueRun(run)) continue;
      const loaded = loadedById.get(run.issueId);
      if (!loaded || !resolveLiveNowParentPath(loaded, loadedById).complete) ids.add(run.issueId);
    }
    return [...ids];
  }, [liveRuns, loadedById]);

  const detailQueries = useQueries({
    queries: detailIssueIds.map((issueId) => ({
      queryKey: queryKeys.issues.detail(issueId),
      queryFn: () => issuesApi.get(issueId),
      staleTime: ISSUE_DETAIL_STALE_TIME_MS,
      retry: false,
    })),
  });

  const { detailById, failedIds } = useMemo(() => {
    const details = new Map<string, Issue>();
    const failed = new Set<string>();
    detailQueries.forEach((query, index) => {
      const issueId = detailIssueIds[index]!;
      if (query.data) details.set(issueId, query.data);
      else if (query.isError) failed.add(issueId);
    });
    return { detailById: details, failedIds: failed };
  }, [detailIssueIds, detailQueries]);

  const entries = useMemo(() => {
    const statusById = new Map<string, string>();
    for (const run of liveRuns ?? []) {
      if (!run.issueId) continue;
      const status = loadedById.get(run.issueId)?.status ?? detailById.get(run.issueId)?.status;
      if (status) statusById.set(run.issueId, status);
    }
    return buildLiveNowEntries(liveRuns, statusById);
  }, [detailById, liveRuns, loadedById]);

  const liveEntryRuns = useMemo(() => entries.flatMap((entry) => entry.runs), [entries]);
  const now = useLiveNowClock(liveEntryRuns);
  const pauseByIssueId = useMemo(() => new Map(pausedTasks.map((pause) => [pause.issueId, pause])), [pausedTasks]);
  const issueById = (issueId: string) => loadedById.get(issueId) ?? detailById.get(issueId) ?? null;
  const stillLive = entries.filter((entry) => pauseByIssueId.get(entry.issueId)?.state !== "paused");
  const items = buildLiveNowItems(stillLive, issueById, now, pauseByIssueId);
  const liveIssueIds = new Set(stillLive.map((entry) => entry.issueId));
  const pausedItems: LiveNowPausedItem[] = pausedTasks
    .filter((pause) => !liveIssueIds.has(pause.issueId))
    .map((pause) => ({
      pause,
      issue: issueById(pause.issueId),
      identifier: pause.identifier ?? pause.issueId.slice(0, 8),
    }));
  return { items, pausedItems, loadedById, detailById, failedIds, now };
}
