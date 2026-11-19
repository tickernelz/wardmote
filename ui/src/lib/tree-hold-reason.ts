import type { PausedTask } from "@tickernelz/wardmote-shared";

const UI_DEFAULT_TREE_HOLD_REASONS = new Set([
  "Paused from Recent Tasks.",
  "Restarted from Recent Tasks.",
  "Subtree resume applied.",
  "Restored by subtree restore operation",
]);

export type PauseActorKind = "agent" | "user" | null;

export interface PauseNote {
  reason: string | null;
  pausedAt: Date | string;
  actorKind: PauseActorKind;
  actorLabel: string | null;
}

export interface PausedTaskNote {
  pause: PausedTask;
  note: PauseNote;
}

/** A hold reason a person or agent wrote, or null for none and for the fixed texts buttons send. */
export function meaningfulTreeHoldReason(reason: string | null | undefined): string | null {
  const trimmed = reason?.trim();
  return trimmed && !UI_DEFAULT_TREE_HOLD_REASONS.has(trimmed) ? trimmed : null;
}

export function pauseActorKind(agentId: string | null | undefined, userId: string | null | undefined): PauseActorKind {
  if (agentId) return "agent";
  if (userId) return "user";
  return null;
}

export function pauseActorName(note: Pick<PauseNote, "actorKind" | "actorLabel">): string {
  if (note.actorLabel) return note.actorLabel;
  if (note.actorKind === "agent") return "an agent";
  if (note.actorKind === "user") return "a board user";
  return "someone";
}

/** One line: who paused, optionally when, and why. */
export function pauseNoteSummary(note: PauseNote, when?: string): string {
  const reason = meaningfulTreeHoldReason(note.reason);
  const who = pauseActorName(note);
  const lead = when ? `${who}, ${when}` : who;
  if (reason) return `${lead}: ${reason}`;
  if (note.actorKind === "agent") return `Paused by ${lead}, no reason given`;
  return `Paused manually by ${lead}`;
}
