import { logger } from "../../middleware/logger.js";
import type { OpenwaGatewayClient } from "./gateway.js";
import { openwaParticipantJids } from "./policy.js";

export interface OpenwaGroupParticipants {
  keys: ReadonlySet<string>;
  everyPhoneKnown: boolean;
}

const participantTtlMs = 30_000;
const participantReadTimeoutMs = 3_000;
const participantReads = new Map<string, { expiresAt: number; read: Promise<OpenwaGroupParticipants | null> }>();

function participantKey(endpointId: string, chatKey: string): string {
  return endpointId + "\u0000" + chatKey;
}

function summarize(participants: unknown): OpenwaGroupParticipants | null {
  if (!Array.isArray(participants) || participants.length === 0) return null;
  const perParticipant = participants.map((participant) => openwaParticipantJids([participant ?? {}]));
  return {
    keys: new Set(perParticipant.flat()),
    everyPhoneKnown: perParticipant.every((jids) => jids.some((jid) => jid.endsWith("@c.us"))),
  };
}

/** Live participant list of a group, shared per endpoint and chat for a short TTL; null when the gateway cannot read it. */
export function openwaGroupParticipants(
  endpointId: string,
  gateway: Pick<OpenwaGatewayClient, "getGroup">,
  chatKey: string,
  now = Date.now(),
): Promise<OpenwaGroupParticipants | null> {
  const key = participantKey(endpointId, chatKey);
  const cached = participantReads.get(key);
  if (cached && cached.expiresAt > now) return cached.read;
  for (const [stale, entry] of participantReads) if (entry.expiresAt <= now) participantReads.delete(stale);
  const read = gateway.getGroup(chatKey, { timeoutMs: participantReadTimeoutMs }).then(
    (group) => summarize(group?.participants),
    (error: unknown) => {
      logger.warn({ err: error, endpointId }, "failed to read OpenWA group participants");
      return null;
    },
  );
  participantReads.set(key, { expiresAt: now + participantTtlMs, read });
  return read;
}

export function openwaForgetGroupParticipants(endpointId: string, chatKey: string): void {
  participantReads.delete(participantKey(endpointId, chatKey));
}

/** True when the tagged jid is a current participant, false when every participant's phone is known and none matches, null otherwise. */
export function openwaMentionParticipant(participants: OpenwaGroupParticipants | null, jid: string): boolean | null {
  if (!participants) return null;
  if (participants.keys.has(jid)) return true;
  return participants.everyPhoneKnown && jid.endsWith("@c.us") ? false : null;
}
