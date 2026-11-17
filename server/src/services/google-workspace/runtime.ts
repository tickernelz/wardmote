import {
  GOOGLE_WORKSPACE_TOOL_NAMES,
  normalizeGoogleWorkspaceSettings,
  type GoogleWorkspacePolicyAction,
  type GoogleWorkspaceService,
  type GoogleWorkspaceSettings,
  type GoogleWorkspaceTier,
} from "@tickernelz/wardmote-shared";

import {
  createGoogleDiscoveryIndex,
  isGoogleWorkspaceService,
  type GoogleDiscoveryIndex,
  type GoogleMethodClassification,
} from "./discovery.js";
import { GoogleWorkspaceError } from "./errors.js";
import { executeGoogleCall, planGoogleCall, type GoogleCallContext, type GoogleCallInput, type GoogleCallPlan } from "./executor.js";
import {
  createGoogleLocationCache,
  decideGoogleCall,
  googleApprovalSnapshot,
  googlePolicyVerdict,
  matchesGoogleApproval,
  type GoogleFileLocation,
  type GoogleMailSource,
  type GooglePolicyDecision,
  type GooglePolicyDependencies,
} from "./policy.js";

export function isGoogleWorkspaceConnection(connection: { transport: string; config?: Record<string, unknown> }): boolean {
  return connection.transport === "rest_api" && connection.config?.sourceTemplateKey === "google-workspace";
}

export function googleWorkspaceSettings(connection: { config?: Record<string, unknown> }): GoogleWorkspaceSettings {
  return normalizeGoogleWorkspaceSettings(connection.config?.googleWorkspace);
}

export function grantedGoogleScopes(grant: { providerTenant?: { oauth?: { scopes?: string[] } } | null }): string[] {
  const scopes = grant.providerTenant?.oauth?.scopes;
  return Array.isArray(scopes) ? scopes.filter((scope): scope is string => typeof scope === "string") : [];
}

let sharedDiscovery: GoogleDiscoveryIndex | null = null;

export function googleDiscovery(): GoogleDiscoveryIndex {
  sharedDiscovery ??= createGoogleDiscoveryIndex();
  return sharedDiscovery;
}

export interface GoogleWorkspaceToolRuntime {
  connectionId?: string;
  discovery: GoogleDiscoveryIndex;
  settings: GoogleWorkspaceSettings;
  grantedScopes: string[];
  credentials: GoogleCallContext["credentials"];
  attachments: GoogleCallContext["attachments"];
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const TOOL_NAMES = new Set<string>(GOOGLE_WORKSPACE_TOOL_NAMES);
const EMAIL = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const TIER_RANK: Record<GoogleWorkspaceTier, number> = { off: 0, read: 1, edit: 2, create: 3, delete_share: 4 };
const LOCATION_CACHE_CONNECTIONS = 200;
const MAIL_HEADER_BYTES = 64 * 1024;

export function isGoogleWorkspaceToolName(name: string): boolean {
  return TOOL_NAMES.has(name);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(args: Record<string, unknown>, name: string, required = true): string | undefined {
  const value = args[name];
  if (value === undefined || value === null || value === "") {
    if (required) throw new GoogleWorkspaceError("validation", `${name} is required`, `Pass ${name}.`, { pointer: `/${name}` });
    return undefined;
  }
  if (typeof value !== "string") throw new GoogleWorkspaceError("validation", `${name} must be a string`, `Pass ${name} as text.`, { pointer: `/${name}` });
  return value;
}

function emails(args: Record<string, unknown>, name: string, required: boolean): string[] {
  const value = args[name];
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || (required && value.length === 0)) {
    throw new GoogleWorkspaceError("validation", `${name} must be a list of email addresses`, `Pass ${name} as ["name@example.com"].`, { pointer: `/${name}` });
  }
  return value.map((item, position) => {
    if (typeof item !== "string" || !EMAIL.test(item.trim())) {
      throw new GoogleWorkspaceError("validation", `${name}[${position}] is not an email address`, "Use a plain address without a display name.", { pointer: `/${name}/${position}` });
    }
    return item.trim();
  });
}

function encodeHeader(value: string): string {
  if (/[\r\n]/.test(value)) throw new GoogleWorkspaceError("validation", "Header values cannot contain line breaks", "Put the text on one line.", { pointer: "/subject" });
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export function buildPlainTextMessage(input: { to: string[]; cc: string[]; subject: string; body: string }): string {
  const lines = [
    `To: ${input.to.join(", ")}`,
    ...(input.cc.length ? [`Cc: ${input.cc.join(", ")}`] : []),
    `Subject: ${encodeHeader(input.subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(input.body, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n"),
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

function eventTime(value: string, timeZone: string | undefined) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { date: value };
  if (Number.isNaN(Date.parse(value))) throw new GoogleWorkspaceError("validation", `"${value}" is not a date or date-time`, "Use RFC 3339, for example 2026-11-20T09:00:00+07:00.", { pointer: "/start" });
  return { dateTime: value, ...(timeZone ? { timeZone } : {}) };
}

export function googleToolCallInput(toolName: string, rawArgs: unknown): GoogleCallInput {
  const args = record(rawArgs);
  switch (toolName) {
    case "google_call":
      return {
        method: text(args, "method") as string,
        params: args.params === undefined ? undefined : record(args.params),
        body: args.body,
        dryRun: args.dryRun === true,
        pageAll: args.pageAll === true,
        pageLimit: typeof args.pageLimit === "number" ? args.pageLimit : undefined,
        fields: text(args, "fields", false),
        upload: args.upload === undefined ? undefined : (record(args.upload) as GoogleCallInput["upload"]),
        download: args.download === "attachment" ? "attachment" : undefined,
        permanentDelete: args.permanentDelete === true,
      };
    case "google_sheets_append":
      return {
        method: "sheets.spreadsheets.values.append",
        params: { spreadsheetId: text(args, "spreadsheetId"), range: text(args, "range"), valueInputOption: text(args, "valueInputOption", false) ?? "USER_ENTERED" },
        body: { values: args.values },
      };
    case "google_sheets_read":
      return { method: "sheets.spreadsheets.values.get", params: { spreadsheetId: text(args, "spreadsheetId"), range: text(args, "range") } };
    case "google_drive_upload": {
      const folderId = text(args, "folderId", false);
      const mimeType = text(args, "mimeType", false);
      return {
        method: "drive.files.create",
        params: { supportsAllDrives: true },
        body: { ...(args.name ? { name: text(args, "name") } : {}), ...(folderId ? { parents: [folderId] } : {}), ...(mimeType ? { mimeType } : {}) },
        upload: { attachmentId: text(args, "attachmentId") as string },
      };
    }
    case "google_drive_share": {
      const emailAddress = text(args, "emailAddress", false);
      const type = text(args, "type", false) ?? (emailAddress ? "user" : undefined);
      if (!type) {
        throw new GoogleWorkspaceError("validation", "type is required when no emailAddress is given", "Pass type \"domain\" or \"anyone\" explicitly, or an emailAddress.", { pointer: "/type" });
      }
      if ((type === "user" || type === "group") && (!emailAddress || !EMAIL.test(emailAddress))) {
        throw new GoogleWorkspaceError("validation", "emailAddress is required for user and group sharing", "Pass the person's email address.", { pointer: "/emailAddress" });
      }
      return {
        method: "drive.permissions.create",
        params: { fileId: text(args, "fileId"), sendNotificationEmail: args.notify === true, supportsAllDrives: true },
        body: { role: text(args, "role"), type, ...(emailAddress ? { emailAddress } : {}), ...(type === "domain" ? { domain: text(args, "domain") } : {}) },
      };
    }
    case "google_docs_write": {
      const insert = typeof args.index === "number" ? { text: text(args, "text"), location: { index: args.index } } : { text: text(args, "text"), endOfSegmentLocation: {} };
      return { method: "docs.documents.batchUpdate", params: { documentId: text(args, "documentId") }, body: { requests: [{ insertText: insert }] } };
    }
    case "google_calendar_insert": {
      const timeZone = text(args, "timeZone", false);
      const attendees = emails(args, "attendees", false);
      return {
        method: "calendar.events.insert",
        params: { calendarId: text(args, "calendarId", false) ?? "primary", sendUpdates: args.notify === true ? "all" : "none" },
        body: {
          summary: text(args, "summary"),
          ...(args.description ? { description: text(args, "description") } : {}),
          start: eventTime(text(args, "start") as string, timeZone),
          end: eventTime(text(args, "end") as string, timeZone),
          ...(attendees.length ? { attendees: attendees.map((email) => ({ email })) } : {}),
        },
      };
    }
    case "google_gmail_send":
      return {
        method: "gmail.users.messages.send",
        params: { userId: "me" },
        body: { raw: buildPlainTextMessage({ to: emails(args, "to", true), cc: emails(args, "cc", false), subject: text(args, "subject") as string, body: text(args, "body") as string }) },
      };
    default:
      throw new GoogleWorkspaceError("validation", `Unknown Google Workspace tool "${toolName}"`, "Use google_search_methods, google_describe or google_call.");
  }
}

function previewAction(settings: GoogleWorkspaceSettings, service: string, value: GoogleMethodClassification): GoogleWorkspacePolicyAction {
  if (!isGoogleWorkspaceService(service)) return "block";
  const tier = settings.capabilities[service as GoogleWorkspaceService];
  const needed: GoogleWorkspaceTier = value === "read" ? "read" : value === "write" || value === "unreviewed" ? "edit" : "delete_share";
  if (TIER_RANK[tier] < TIER_RANK[needed]) return "block";
  return value === "read" ? "allow" : settings.classPolicy[value];
}

function locator(runtime: GoogleWorkspaceToolRuntime) {
  return async (fileId: string): Promise<GoogleFileLocation | null> => {
    try {
      const result = await executeGoogleCall(
        { ...runtime, policy: async () => ({ allowed: true }) },
        { method: "drive.files.get", params: { fileId, supportsAllDrives: true }, fields: "parents,driveId" },
      );
      const data = record(result.data);
      return {
        parents: Array.isArray(data.parents) ? data.parents.filter((item): item is string => typeof item === "string") : [],
        driveId: typeof data.driveId === "string" ? data.driveId : null,
      };
    } catch (error) {
      if (error instanceof GoogleWorkspaceError && error.details.status === 404) return null;
      throw error;
    }
  };
}

type GoogleLocationCache = ReturnType<typeof createGoogleLocationCache>;
const locationCaches = new Map<string, { cache: GoogleLocationCache; load: (fileId: string) => Promise<GoogleFileLocation | null> }>();

function locationCache(runtime: GoogleWorkspaceToolRuntime): GoogleLocationCache {
  const load = locator(runtime);
  if (!runtime.connectionId) return createGoogleLocationCache(load);
  let entry = locationCaches.get(runtime.connectionId);
  if (!entry) {
    if (locationCaches.size >= LOCATION_CACHE_CONNECTIONS) locationCaches.delete(locationCaches.keys().next().value as string);
    const created: { cache: GoogleLocationCache; load: typeof load } = { load, cache: createGoogleLocationCache((fileId) => created.load(fileId)) };
    entry = created;
    locationCaches.set(runtime.connectionId, entry);
  }
  entry.load = load;
  return entry.cache;
}

function mailHeaders(runtime: GoogleWorkspaceToolRuntime) {
  return async (source: GoogleMailSource): Promise<string | null> => {
    if ("attachmentId" in source) {
      return new TextDecoder().decode(await runtime.attachments.head(source.attachmentId, MAIL_HEADER_BYTES));
    }
    const result = await executeGoogleCall(
      { ...runtime, policy: async () => ({ allowed: true }) },
      { method: "gmail.users.drafts.get", params: { userId: "me", id: source.draftId, format: "metadata" } },
    );
    const headers = record(record(record(result.data).message).payload).headers;
    if (!Array.isArray(headers)) return null;
    return headers
      .map(record)
      .filter((header) => typeof header.name === "string" && /^(to|cc|bcc)$/i.test(header.name))
      .map((header) => `${String(header.name)}: ${String(header.value)}`)
      .join("\r\n");
  };
}

function policyDependencies(runtime: GoogleWorkspaceToolRuntime, cache: GoogleLocationCache): GooglePolicyDependencies {
  return { grantedScopes: runtime.grantedScopes, locate: cache.locate, mailHeaders: mailHeaders(runtime) };
}

export async function decideGoogleWorkspaceTool(runtime: GoogleWorkspaceToolRuntime, toolName: string, args: unknown): Promise<GooglePolicyDecision | null> {
  if (toolName === "google_search_methods" || toolName === "google_describe") return null;
  const input = googleToolCallInput(toolName, args);
  if (input.dryRun) return null;
  const { plan } = await planGoogleCall(runtime.discovery, input);
  return decideGoogleCall(plan, runtime.settings, policyDependencies(runtime, locationCache(runtime)));
}

export async function runGoogleWorkspaceTool(
  runtime: GoogleWorkspaceToolRuntime,
  toolName: string,
  rawArgs: unknown,
  options: { approved: boolean; approvedSnapshot?: unknown },
): Promise<unknown> {
  const args = record(rawArgs);
  if (toolName === "google_search_methods") {
    const service = text(args, "service", false);
    if (service !== undefined && !isGoogleWorkspaceService(service)) {
      throw new GoogleWorkspaceError("validation", `Unknown service "${service}"`, "Omit service or use one of the listed services.", { pointer: "/service" });
    }
    const { methods, unavailableServices } = await runtime.discovery.search({
      query: text(args, "query") as string,
      service: service as GoogleWorkspaceService | undefined,
      class: text(args, "class", false) as GoogleMethodClassification | undefined,
      limit: typeof args.limit === "number" ? args.limit : undefined,
    });
    return {
      hits: methods.map((hit) => ({ ...hit, policy: previewAction(runtime.settings, hit.id.split(".")[0], hit.class) })),
      ...(unavailableServices.length > 0 ? { unavailableServices } : {}),
    };
  }
  if (toolName === "google_describe") {
    return runtime.discovery.describe(text(args, "method") as string, {
      path: text(args, "path", false),
      depth: typeof args.depth === "number" ? args.depth : undefined,
    });
  }
  const cache = locationCache(runtime);
  const dependencies = policyDependencies(runtime, cache);
  let planned: GoogleCallPlan | null = null;
  const result = await executeGoogleCall(
    {
      ...runtime,
      policy: async (plan) => {
        planned = plan;
        const decision = await decideGoogleCall(plan, runtime.settings, dependencies);
        if (options.approved && decision.action === "require_approval" && !matchesGoogleApproval(options.approvedSnapshot, decision)) {
          return {
            allowed: false,
            error: new GoogleWorkspaceError(
              "approval_required",
              `${plan.method} changed after it was approved (classes or recipients differ)`,
              "Call it again to create a new approval card for what will actually run.",
              { approved: options.approvedSnapshot ?? null, current: googleApprovalSnapshot(decision) },
            ),
          };
        }
        return googlePolicyVerdict(decision, { approved: options.approved });
      },
    },
    googleToolCallInput(toolName, args),
  );
  if (planned) cache.forget(planned);
  return result;
}
