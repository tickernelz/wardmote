import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { accessApi } from "../api/access";
import { agentsApi } from "../api/agents";
import { buildCompanyUserLabelMap } from "../lib/company-members";
import { queryKeys } from "../lib/queryKeys";
import { pauseActorKind, type PauseNote } from "../lib/tree-hold-reason";

type PauseSource = {
  reason: string | null;
  pausedAt: Date | string;
  pausedByAgentId: string | null;
  pausedByUserId: string | null;
};

/** Builds pause notes with the pausing agent's or user's name from the cached company lists. */
export function usePauseNoteBuilder(companyId: string | null | undefined, enabled = true) {
  const active = Boolean(companyId) && enabled;
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId ?? ""),
    queryFn: () => agentsApi.list(companyId!),
    enabled: active,
  });
  const { data: directory } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId ?? ""),
    queryFn: () => accessApi.listUserDirectory(companyId!),
    enabled: active,
  });
  const agentNames = useMemo(() => new Map((agents ?? []).map((agent) => [agent.id, agent.name])), [agents]);
  const userNames = useMemo(() => buildCompanyUserLabelMap(directory?.users), [directory?.users]);
  return useCallback((source: PauseSource): PauseNote => ({
    reason: source.reason,
    pausedAt: source.pausedAt,
    actorKind: pauseActorKind(source.pausedByAgentId, source.pausedByUserId),
    actorLabel: source.pausedByAgentId
      ? agentNames.get(source.pausedByAgentId) ?? null
      : source.pausedByUserId
        ? userNames.get(source.pausedByUserId) ?? (source.pausedByUserId === "local-board" ? "Board" : null)
        : null,
  }), [agentNames, userNames]);
}
