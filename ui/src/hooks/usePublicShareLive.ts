import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  applyPublicIssueSharePatch,
  type PublicIssueSharePatchEvent,
  type PublicIssueShareViewEvent,
} from "@tickernelz/wardmote-shared";
import { publicShareEventsUrl, type PublicShareState } from "../api/issue-share";
import { queryKeys } from "../lib/queryKeys";

const HIDDEN_GRACE_MS = 30_000;
const SILENCE_MS = 50_000;
const MAX_BACKOFF_MS = 60_000;

export function usePublicShareLive(token: string, enabled: boolean, onStreaming: (streaming: boolean) => void) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return;
    const queryKey = queryKeys.publicShare.view(token);
    let source: EventSource | null = null;
    let failures = 0;
    let disposed = false;
    let retryTimer: number | undefined;
    let hideTimer: number | undefined;
    let watchdog: number | undefined;

    const current = () => queryClient.getQueryData<PublicShareState | null>(queryKey);

    function disconnect() {
      window.clearTimeout(watchdog);
      watchdog = undefined;
      source?.close();
      source = null;
      if (!disposed) onStreaming(false);
    }

    function reconnect() {
      disconnect();
      connect();
    }

    function armWatchdog() {
      window.clearTimeout(watchdog);
      watchdog = window.setTimeout(reconnect, SILENCE_MS);
    }

    function retryLater() {
      disconnect();
      void queryClient.invalidateQueries({ queryKey, exact: true });
      const delay = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** failures) * (0.5 + Math.random() / 2);
      failures += 1;
      window.clearTimeout(retryTimer);
      retryTimer = window.setTimeout(connect, delay);
    }

    function connect() {
      window.clearTimeout(retryTimer);
      retryTimer = undefined;
      if (disposed || source || document.visibilityState === "hidden") return;
      const next = new EventSource(publicShareEventsUrl(token, current()?.etag ?? null));
      source = next;
      armWatchdog();
      const on = (type: string, handle: (data: string) => void) =>
        next.addEventListener(type, (event) => {
          if (source !== next) return;
          armWatchdog();
          handle((event as MessageEvent<string>).data);
        });
      next.onopen = () => {
        if (source !== next) return;
        failures = 0;
        onStreaming(true);
      };
      on("view", (data) => {
        const { etag, view } = JSON.parse(data) as PublicIssueShareViewEvent;
        const state: PublicShareState = { view, etag };
        queryClient.setQueryData(queryKey, state);
      });
      on("patch", (data) => {
        const event = JSON.parse(data) as PublicIssueSharePatchEvent;
        const state = current();
        if (!state || state.etag !== event.base) {
          reconnect();
          return;
        }
        const view = (() => {
          try {
            return applyPublicIssueSharePatch(state.view, event.patch);
          } catch {
            return null;
          }
        })();
        if (!view) {
          reconnect();
          return;
        }
        const next: PublicShareState = { view, etag: event.etag };
        queryClient.setQueryData(queryKey, next);
      });
      on("gone", () => {
        disconnect();
        queryClient.setQueryData(queryKey, null);
      });
      next.onerror = () => {
        if (source !== next) return;
        onStreaming(false);
        if (next.readyState === EventSource.CLOSED) retryLater();
      };
    }

    function onVisibility() {
      window.clearTimeout(hideTimer);
      hideTimer = undefined;
      if (document.visibilityState === "hidden") {
        hideTimer = window.setTimeout(disconnect, HIDDEN_GRACE_MS);
        return;
      }
      if (!source) {
        failures = 0;
        connect();
      }
    }

    function onOnline() {
      if (source?.readyState === EventSource.OPEN) return;
      failures = 0;
      reconnect();
    }

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    connect();
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      window.clearTimeout(retryTimer);
      window.clearTimeout(hideTimer);
      disconnect();
    };
  }, [enabled, token, queryClient, onStreaming]);
}
