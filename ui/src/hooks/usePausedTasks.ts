import { useQuery } from "@tanstack/react-query";
import type { PausedTask } from "@tickernelz/wardmote-shared";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";

const PAUSING_RECHECK_MS = 30_000;
const NO_PAUSED_TASKS: readonly PausedTask[] = [];

/** Active pauses of a company; rechecks while a run is still stopping so a late stop shows as Pause failed. */
export function usePausedTasks(companyId: string | null | undefined, enabled = true): readonly PausedTask[] {
  const { data } = useQuery({
    queryKey: queryKeys.pausedTasks(companyId ?? "none"),
    queryFn: () => issuesApi.listPausedTasks(companyId!),
    enabled: Boolean(companyId) && enabled,
    refetchInterval: (query) =>
      query.state.data?.some((task) => task.state === "pausing") ? PAUSING_RECHECK_MS : false,
  });
  return data ?? NO_PAUSED_TASKS;
}
