import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { IssueTreeHoldScope } from "@tickernelz/wardmote-shared";
import { heartbeatsApi } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";

type TaskRef = { issueId: string; identifier: string | null };

function label(task: TaskRef) {
  return task.identifier ?? "This task";
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Pause, resume, end a pause, or stop a pausing run from any task surface, with the LIVE NOW toasts. */
export function useTaskPause(companyId: string | null | undefined) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  const refresh = async (issueId: string) => {
    if (!companyId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.pausedTasks(companyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.liveRuns(companyId) }),
      queryClient.invalidateQueries({ queryKey: ["issues", "tree-control-state", issueId] }),
    ]);
  };

  const stopNow = useMutation({
    mutationFn: ({ runId }: TaskRef & { runId: string }) => heartbeatsApi.cancel(runId),
    onError: (error, task) => {
      pushToast({ title: `Couldn't stop ${label(task)}`, body: messageOf(error), tone: "error" });
    },
    onSettled: (_data, _error, task) => refresh(task.issueId),
  });

  const pause = useMutation({
    mutationFn: ({ issueId, scope }: TaskRef & { scope: IssueTreeHoldScope }) =>
      issuesApi.createTreeHold(issueId, {
        mode: "pause",
        reason: null,
        releasePolicy: { strategy: "manual" },
        scope,
        stopAt: "safe_point",
      }),
    onSuccess: (created, task) => {
      const liveRun = created.preview.activeRuns.find((run) => run.issueId === task.issueId && run.status === "running");
      if (!liveRun) {
        pushToast({ title: `${label(task)} paused. Session saved.`, tone: "success" });
        return;
      }
      pushToast({
        title: `Pausing ${label(task)}. It stops after the current step.`,
        tone: "info",
        action: { label: "Stop now", onClick: () => stopNow.mutate({ ...task, runId: liveRun.id }) },
      });
    },
    onError: (error, task) => {
      pushToast({ title: `Couldn't pause ${label(task)}`, body: messageOf(error), tone: "error" });
    },
    onSettled: (_data, _error, task) => refresh(task.issueId),
  });

  const release = (wakeAgents: boolean) => ({
    mutationFn: ({ issueId, holdId }: TaskRef & { holdId: string }) =>
      issuesApi.releaseTreeHold(issueId, holdId, { reason: null, metadata: { wakeAgents } }),
    onError: (error: unknown, task: TaskRef) => {
      pushToast({ title: `Couldn't ${wakeAgents ? "resume" : "end the pause of"} ${label(task)}`, body: messageOf(error), tone: "error" });
    },
    onSettled: (_data: unknown, _error: unknown, task: TaskRef) => refresh(task.issueId),
  });

  const resume = useMutation({
    ...release(true),
    onSuccess: (released, task) => {
      const failure = released.wakeFailures?.[0];
      if (failure) {
        pushToast({ title: `${label(task)} resumed, but its agent could not start`, body: failure.message, tone: "warn" });
      }
    },
  });

  const endPause = useMutation(release(false));

  return { pause, resume, endPause, stopNow };
}
