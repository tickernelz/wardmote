import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { RotateCcw } from "lucide-react";
import type { RunModelFallbackState } from "@tickernelz/wardmote-shared";
import { issuesApi } from "../../api/issues";
import { queryKeys } from "../../lib/queryKeys";
import { cn } from "../../lib/utils";
import { Button } from "@/components/ui/button";
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

export interface RestorePrimaryModelRun {
  id: string;
  modelFallback?: RunModelFallbackState | null;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function RestorePrimaryModelControl({
  issueId,
  run,
  companyId,
  taskLabel,
  className,
}: {
  issueId: string | null | undefined;
  run: RestorePrimaryModelRun | null | undefined;
  companyId?: string | null;
  taskLabel?: string | null;
  className?: string;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const fallback = run?.modelFallback ?? null;
  const restore = useMutation({
    mutationFn: async () => {
      if (!issueId || !run) throw new Error("This task has no run on a fallback model.");
      return issuesApi.restorePrimaryModel(issueId);
    },
    onSuccess: () => {
      if (companyId) void queryClient.invalidateQueries({ queryKey: queryKeys.liveRuns(companyId) });
      if (!issueId) return;
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(issueId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.activeRun(issueId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.runs(issueId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(issueId) });
    },
  });

  if (!issueId || !run || !fallback) return null;

  const task = taskLabel ? ` on ${taskLabel}` : "";
  return (
    <span data-slot="restore-primary-model" className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <Button
        type="button"
        variant="secondary"
        size="xs"
        disabled={restore.isPending}
        aria-label={`Back to the primary model${task}`}
        title={`Back to the primary model — forces the next run onto ${fallback.primaryModel} and clears its cooldown`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setConfirming(true);
        }}
      >
        <RotateCcw aria-hidden="true" />
        {restore.isPending ? "Restoring…" : "Back to primary model"}
      </Button>
      {restore.error ? (
        <span role="alert" className="text-xs text-bad">
          {errorMessage(restore.error, "Couldn’t restore the primary model.")}
        </span>
      ) : null}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Back to the primary model{task}?</AlertDialogTitle>
            <AlertDialogDescription>
              This forces the switch. It stops the run on {fallback.activeModel} now, so any unsaved work in that turn is
              lost, and wakes the assignee on {fallback.primaryModel}. Cooldowns are shared across the company, so other
              agents&apos; next runs try {fallback.primaryModel} again too. If it is still down, one run spends about 60 to
              80 seconds finding out before the cooldown comes back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep running</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirming(false);
                restore.mutate();
              }}
            >
              Stop and switch
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </span>
  );
}
