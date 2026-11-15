import { and, eq } from "drizzle-orm";
import {
  chatEndpointLeases,
  chatEndpoints,
  toolConnections,
  type Db,
} from "@tickernelz/wardmote-db";
import type { ChatSdkStatePersistence } from "../chat-sdk-state.js";
import type { OpenwaGatewayClient } from "./gateway.js";
import type { OpenwaOutboundRegistry } from "./outbound.js";
import { recordOpenwaAudit } from "./audit.js";
import {
  createOpenwaDispatcher,
  isFatalOpenwaReceiverError,
  OpenwaReceiverError,
  type OpenwaDispatcher,
  type OpenwaGroupHandler,
  type OpenwaInboundHandler,
  type OpenwaIngressEvent,
  type OpenwaSessionHealth,
  type OpenwaSessionHealthHandler,
  type OpenwaSessionStatusSource,
} from "./receiver.js";
import {
  dispatchOpenwaSessionHealthWake,
  openwaRestrictionSummary,
  stageOpenwaSessionHealthWake,
  type OpenwaSessionHealthFacts,
} from "./session-health.js";
import { OpenwaState, writeOpenwaCursor, type OpenwaIngestCursor } from "./state.js";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type EndpointRow = typeof chatEndpoints.$inferSelect;
type HealthStatus = "verifying" | "active" | "attention";

const HEALTH_STATUSES: HealthStatus[] = ["verifying", "active", "attention"];
const HEALTH_MESSAGE_LIMIT = 500;
export const OPENWA_CONNECTION_HEALTH_PREFIX = "OpenWA connection: ";
export const OPENWA_SESSION_HEALTH_PREFIX = "OpenWA session: ";
export const OPENWA_RESTRICTION_HEALTH_PREFIX = "OpenWA restriction: ";
const OPENWA_RECONNECTING_MESSAGE = "connection interrupted; reconnecting";

export type OpenwaSessionHealthSource = "event" | OpenwaSessionStatusSource;

/** True when inbound messages are queued for processing; OpenWA session or reconnect health attention holds them until the endpoint recovers instead of dropping them. */
export function chatEndpointQueuesInbound(endpoint: Pick<EndpointRow, "provider" | "status" | "lastError">): boolean {
  if (endpoint.status === "verifying" || endpoint.status === "active") return true;
  if (endpoint.provider !== "openwa" || endpoint.status !== "attention") return false;
  const error = endpoint.lastError ?? "";
  return error.startsWith(OPENWA_SESSION_HEALTH_PREFIX) || error.startsWith(OPENWA_CONNECTION_HEALTH_PREFIX + OPENWA_RECONNECTING_MESSAGE);
}

export interface OpenwaIngressHooks {
  onInbound?: OpenwaInboundHandler;
  onGroup?: OpenwaGroupHandler;
  onSessionHealth?: OpenwaSessionHealthHandler;
}

export interface OpenwaIngressCallbacks {
  onOpenwaAssertOwned(activeThreadId?: string): Promise<void>;
  onOpenwaEvent(event: OpenwaIngressEvent, dedupeKey: string | null): Promise<void>;
  onOpenwaCursor(cursor: OpenwaIngestCursor): Promise<void>;
  onOpenwaBeforeCatchUp(gateway: OpenwaGatewayClient): Promise<void>;
  onOpenwaLive(): Promise<void>;
  onOpenwaFailure(error: unknown): Promise<void>;
  onOpenwaSessionStatus(status: string, source: OpenwaSessionStatusSource): Promise<void>;
}

export interface OpenwaIngressDeps {
  db: Db;
  companyId: string;
  endpointId: string;
  sessionId: string;
  ownJid: string;
  leaseKey: string;
  leaseToken: string;
  outbound: OpenwaOutboundRegistry;
  hooks: OpenwaIngressHooks;
  statePersistence(tx: DbTransaction): ChatSdkStatePersistence;
  ownershipIsCurrent(): boolean;
  refreshOwnership(): Promise<boolean>;
  fence(tx: DbTransaction, statuses: HealthStatus[]): Promise<EndpointRow | null>;
  invalidate(): void;
  redact(error: unknown): string;
}

function bounded(text: string): string {
  return text.length > HEALTH_MESSAGE_LIMIT ? text.slice(0, HEALTH_MESSAGE_LIMIT) + "…" : text;
}

function healthyStatus(endpoint: EndpointRow): "active" | "verifying" {
  return endpoint.setup.step === "complete" ? "active" : "verifying";
}

export function createOpenwaIngressCallbacks(deps: OpenwaIngressDeps): OpenwaIngressCallbacks & { dispatcher: OpenwaDispatcher } {
  const { db } = deps;

  async function transition(input: {
    healthy: boolean;
    prefix: string;
    message: string;
    fatal?: boolean;
    metadata?: Record<string, unknown>;
    wake?: OpenwaSessionHealthFacts;
  }): Promise<boolean> {
    let wakeActionId: string | null = null;
    const changed = await db.transaction(async (tx) => {
      const endpoint = await deps.fence(tx, HEALTH_STATUSES);
      if (!endpoint) return false;
      const ownsAttention = endpoint.status === "attention" && (endpoint.lastError ?? "").startsWith(input.prefix);
      const now = new Date();
      if (input.healthy) {
        if (!ownsAttention) return false;
        await tx
          .update(chatEndpoints)
          .set({ status: healthyStatus(endpoint), healthMessage: "Connected", lastError: null, updatedAt: now })
          .where(and(eq(chatEndpoints.companyId, deps.companyId), eq(chatEndpoints.id, deps.endpointId)));
      } else {
        const message = bounded(input.prefix + input.message);
        if (endpoint.status === "attention" && endpoint.lastError === message && !input.fatal) return false;
        if (endpoint.status === "attention" && !ownsAttention && !(endpoint.lastError ?? "").startsWith("OpenWA ") && !input.fatal)
          return false;
        await tx
          .update(chatEndpoints)
          .set({ status: "attention", healthMessage: message, lastError: message, updatedAt: now })
          .where(and(eq(chatEndpoints.companyId, deps.companyId), eq(chatEndpoints.id, deps.endpointId)));
        if (input.fatal)
          await tx
            .update(toolConnections)
            .set({ enabled: false, healthStatus: "error", healthMessage: message, updatedAt: now })
            .where(and(eq(toolConnections.companyId, deps.companyId), eq(toolConnections.id, endpoint.connectionId)));
      }
      const stage = input.wake
        ? await stageOpenwaSessionHealthWake(tx, endpoint, { sessionId: deps.sessionId, selfChatKey: deps.ownJid, facts: input.wake })
        : null;
      if (stage?.staged) wakeActionId = stage.actionId;
      await recordOpenwaAudit(tx, {
        companyId: deps.companyId,
        endpointId: deps.endpointId,
        kind: "session_health",
        actorKind: "system",
        conversationId: stage?.staged ? stage.conversationId : null,
        metadata: {
          healthy: input.healthy,
          message: bounded(input.prefix + input.message),
          ...(input.metadata ?? {}),
          ...(stage ? (stage.staged ? { wakeActionId: stage.actionId } : { wakeSkipped: stage.reason }) : {}),
        },
        occurredAt: now,
      });
      return true;
    });
    if (wakeActionId) await dispatchOpenwaSessionHealthWake(db, wakeActionId).catch(() => false);
    return changed;
  }

  async function sessionHealth(health: OpenwaSessionHealth, source: OpenwaSessionHealthSource): Promise<void> {
    if (health.kind === "status")
      await transition({
        healthy: health.healthy,
        prefix: OPENWA_SESSION_HEALTH_PREFIX,
        message: "session is " + health.status,
        metadata: { status: health.status, source },
        wake: { kind: "status", healthy: health.healthy, status: health.status, restriction: null },
      });
    else
      await transition({
        healthy: health.healthy,
        prefix: OPENWA_RESTRICTION_HEALTH_PREFIX,
        message: openwaRestrictionSummary(health.restrictionKind),
        metadata: { active: health.active, kind: health.restrictionKind, code: health.code, expiresAt: health.expiresAt, source },
        wake: {
          kind: "restriction",
          healthy: health.healthy,
          status: null,
          restriction: { active: health.active, kind: health.restrictionKind, code: health.code, expiresAt: health.expiresAt },
        },
      });
  }

  const dispatcher = createOpenwaDispatcher({
    companyId: deps.companyId,
    endpointId: deps.endpointId,
    ownJid: deps.ownJid,
    outbound: deps.outbound,
    onInbound: deps.hooks.onInbound,
    onGroup: deps.hooks.onGroup,
    onSessionHealth: async (health, ctx) => {
      await sessionHealth(health, "event");
      await deps.hooks.onSessionHealth?.(health, ctx);
    },
  });

  return {
    dispatcher,
    async onOpenwaAssertOwned() {
      if (deps.ownershipIsCurrent()) return;
      if (!(await deps.refreshOwnership()) || !deps.ownershipIsCurrent())
        throw new OpenwaReceiverError("ownership", "OpenWA receiver ownership changed", true);
    },
    onOpenwaEvent: (event, dedupeKey) => dispatcher.dispatch(event, dedupeKey),
    async onOpenwaCursor(cursor) {
      await db.transaction(async (tx) => {
        const fenced = await tx
          .update(chatEndpointLeases)
          .set({ updatedAt: new Date() })
          .where(
            and(
              eq(chatEndpointLeases.companyId, deps.companyId),
              eq(chatEndpointLeases.endpointId, deps.endpointId),
              eq(chatEndpointLeases.leaseKey, deps.leaseKey),
              eq(chatEndpointLeases.token, deps.leaseToken),
            ),
          )
          .returning({ id: chatEndpointLeases.id });
        if (!fenced.length) throw new Error("OpenWA receiver lease was replaced");
        await writeOpenwaCursor(
          new OpenwaState({ companyId: deps.companyId, endpointId: deps.endpointId }, deps.statePersistence(tx)),
          deps.sessionId,
          cursor,
        );
      });
    },
    async onOpenwaBeforeCatchUp(gateway) {
      await deps.outbound.preload(deps.companyId, deps.endpointId);
      await deps.outbound.reconcileUncertain(deps.companyId, deps.endpointId, gateway);

    },
    async onOpenwaLive() {
      await transition({ healthy: true, prefix: OPENWA_CONNECTION_HEALTH_PREFIX, message: "" });
    },
    async onOpenwaFailure(error) {
      const fatal = isFatalOpenwaReceiverError(error);
      await transition({
        healthy: false,
        prefix: OPENWA_CONNECTION_HEALTH_PREFIX,
        message: fatal ? deps.redact(error) : OPENWA_RECONNECTING_MESSAGE + " (" + deps.redact(error) + ")",
        fatal,
      }).catch(() => false);
      if (fatal) deps.invalidate();
    },
    async onOpenwaSessionStatus(status, source) {
      const health: OpenwaSessionHealth = { kind: "status", status, healthy: status === "ready" };
      await sessionHealth(health, source);
      await deps.hooks.onSessionHealth?.(health, { companyId: deps.companyId, endpointId: deps.endpointId, outbound: deps.outbound });
    },
  };
}
