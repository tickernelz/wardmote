import type {
  GoogleWorkspacePolicyAction,
  GoogleWorkspaceService,
  GoogleWorkspaceSettings,
  GoogleWorkspaceTier,
} from "@tickernelz/wardmote-shared";

import type { GoogleMethodClassification } from "./discovery.js";
import { GoogleWorkspaceError } from "./errors.js";
import type { GoogleCallPlan, GooglePolicyVerdict } from "./executor.js";

export interface GoogleFileLocation {
  parents: string[];
  driveId: string | null;
}

export type GoogleMailSource = { draftId: string } | { attachmentId: string };

export interface GooglePolicyDependencies {
  grantedScopes: readonly string[];
  locate(fileId: string): Promise<GoogleFileLocation | null>;
  mailHeaders(source: GoogleMailSource): Promise<string | null>;
}

export interface GooglePolicyDecision {
  action: GoogleWorkspacePolicyAction;
  classes: GoogleMethodClassification[];
  reasons: string[];
  externalRecipients: string[];
  recipientsUnknown: boolean;
  query: [string, string][] | null;
  error: GoogleWorkspaceError | null;
}

const TIER_RANK: Record<GoogleWorkspaceTier, number> = { off: 0, read: 1, edit: 2, create: 3, delete_share: 4 };
const ACTION_RANK: Record<GoogleWorkspacePolicyAction, number> = { allow: 0, require_approval: 1, block: 2 };
const HARD_BLOCKED = new Set(["drive.files.emptyTrash"]);
const CREATE_LEAVES = /^(create|insert|copy|copyTo|import|quickAdd|batchCreateContacts|createContact|copyOtherContactToMyContactsGroup)$/;
const DRIVE_BACKED = new Set<GoogleWorkspaceService>(["drive", "sheets", "docs", "slides", "forms"]);
const TARGET_PARAMS = ["fileId", "spreadsheetId", "documentId", "presentationId", "formId"] as const;
const ROOT_CREATORS = new Set(["sheets.spreadsheets.create", "docs.documents.create", "slides.presentations.create", "forms.forms.create"]);
const MAX_ANCESTRY = 20;
const TARGETLESS_IN_SCOPE = new Set(["drive.about.get", "drive.apps.get", "drive.apps.list", "drive.files.generateIds"]);
const SHARED_DRIVE_SCOPED = new Set(["drive.drives.get", "drive.changes.list", "drive.changes.getStartPageToken"]);
const LOCATION_TTL_MS = 60_000;
const LOCATION_CACHE_MAX = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredTier(plan: GoogleCallPlan, value: GoogleMethodClassification, isKind: boolean): GoogleWorkspaceTier {
  if (value === "read") return "read";
  if (value === "write") {
    const leaf = plan.method.split(".").at(-1) ?? "";
    return !isKind && (plan.upload || CREATE_LEAVES.test(leaf)) ? "create" : "edit";
  }
  if (value === "unreviewed") return "edit";
  return "delete_share";
}

function emailDomain(email: string): string | null {
  const match = /@([a-z0-9.-]+)$/i.exec(email.trim());
  return match ? match[1].toLowerCase() : null;
}

function decodeRaw(raw: string): string {
  return Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function headerRecipients(text: string): string[] {
  const head = text.split(/\r?\n\r?\n/, 1)[0].replace(/\r?\n[ \t]+/g, " ");
  const recipients: string[] = [];
  for (const line of head.split(/\r?\n/)) {
    if (!/^(to|cc|bcc):/i.test(line)) continue;
    for (const match of line.matchAll(/[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) recipients.push(match[0].toLowerCase());
  }
  return [...new Set(recipients)];
}

function sharingTargets(plan: GoogleCallPlan): { recipients: string[]; public: boolean } | null {
  const body = isRecord(plan.body) ? plan.body : {};
  if (plan.method === "drive.permissions.create" || plan.method === "drive.permissions.update") {
    const type = typeof body.type === "string" ? body.type : plan.method === "drive.permissions.update" ? "unknown" : "";
    if (type === "anyone" || type === "unknown" || type === "") return { recipients: [], public: true };
    if (type === "domain") return { recipients: [`*@${String(body.domain ?? "").toLowerCase()}`], public: false };
    return { recipients: typeof body.emailAddress === "string" ? [body.emailAddress.toLowerCase()] : [], public: typeof body.emailAddress !== "string" };
  }
  if (plan.method.startsWith("calendar.acl.")) {
    const scope = isRecord(body.scope) ? body.scope : {};
    if (scope.type === "user" || scope.type === "group") return { recipients: typeof scope.value === "string" ? [scope.value.toLowerCase()] : [], public: typeof scope.value !== "string" };
    if (scope.type === "domain") return { recipients: [`*@${String(scope.value ?? "").toLowerCase()}`], public: false };
    return { recipients: [], public: true };
  }
  return null;
}

const MAIL_SEND_METHODS = new Set(["gmail.users.messages.send", "gmail.users.drafts.send"]);

function mailSources(plan: GoogleCallPlan): (GoogleMailSource | { raw: string })[] {
  const body = isRecord(plan.body) ? plan.body : {};
  const sources: (GoogleMailSource | { raw: string })[] = [];
  if (plan.upload) sources.push({ attachmentId: plan.upload.attachmentId });
  if (plan.method === "gmail.users.drafts.send") {
    const message = isRecord(body.message) ? body.message : {};
    if (typeof message.raw === "string") sources.push({ raw: message.raw });
    if (typeof body.id === "string") sources.push({ draftId: body.id });
  } else if (typeof body.raw === "string") {
    sources.push({ raw: body.raw });
  }
  return sources;
}

async function mailRecipients(plan: GoogleCallPlan, deps: GooglePolicyDependencies): Promise<string[] | null | undefined> {
  if (!MAIL_SEND_METHODS.has(plan.method)) return undefined;
  const sources = mailSources(plan);
  if (sources.length === 0) return null;
  const recipients = new Set<string>();
  try {
    for (const source of sources) {
      const headers = "raw" in source ? decodeRaw(source.raw) : await deps.mailHeaders(source);
      if (headers === null) return null;
      for (const recipient of headerRecipients(headers)) recipients.add(recipient);
    }
  } catch {
    return null;
  }
  return [...recipients];
}

async function effectiveClasses(
  plan: GoogleCallPlan,
  settings: GoogleWorkspaceSettings,
  deps: GooglePolicyDependencies,
  reasons: string[],
  externalRecipients: string[],
): Promise<{ entries: { key: string; value: GoogleMethodClassification; isKind: boolean }[]; recipientsUnknown: boolean }> {
  const kinds = plan.classification.batchRequestKinds;
  const entries = kinds.map((item) => ({ key: `${plan.method}#${item.kind}`, value: item.class, isKind: true }));
  let methodValue = kinds.length > 0 ? plan.classification.baseClass : plan.classification.methodClass;
  let recipientsUnknown = false;
  const mail = await mailRecipients(plan, deps);
  let sharing = sharingTargets(plan);
  if (mail === null) {
    recipientsUnknown = true;
    reasons.push("the recipients could not be read");
  } else if (mail !== undefined) {
    sharing = { recipients: mail, public: false };
  }
  if (sharing && methodValue === "external") {
    const outside = sharing.recipients.filter((recipient) => emailDomain(recipient) !== settings.domain);
    externalRecipients.push(...outside);
    if (sharing.public) reasons.push("shared with anyone or an unnamed recipient");
    const sendsMail = plan.method.startsWith("gmail.");
    if (!sendsMail && !sharing.public && settings.domain && sharing.recipients.length > 0 && outside.length === 0) {
      methodValue = "write";
      reasons.push(`all recipients are inside ${settings.domain}`);
    }
  }
  entries.unshift({ key: plan.method, value: methodValue, isKind: false });
  return { entries, recipientsUnknown };
}

function actionFor(settings: GoogleWorkspaceSettings, key: string, value: GoogleMethodClassification): GoogleWorkspacePolicyAction {
  if (value === "read") return settings.methodOverrides[key] === "block" ? "block" : "allow";
  return settings.methodOverrides[key] ?? settings.classPolicy[value];
}

function scopeLimited(settings: GoogleWorkspaceSettings): boolean {
  const { driveFolderIds, sharedDriveIds, spreadsheetIds } = settings.scope;
  return driveFolderIds.length + sharedDriveIds.length + spreadsheetIds.length > 0;
}

async function withinScope(
  fileId: string,
  settings: GoogleWorkspaceSettings,
  deps: GooglePolicyDependencies,
  memo: Map<string, Promise<boolean>>,
  chain: ReadonlySet<string> = new Set(),
): Promise<boolean> {
  const { driveFolderIds, sharedDriveIds, spreadsheetIds } = settings.scope;
  if (driveFolderIds.includes(fileId) || spreadsheetIds.includes(fileId) || sharedDriveIds.includes(fileId)) return true;
  if (chain.has(fileId) || chain.size >= MAX_ANCESTRY) return false;
  const known = memo.get(fileId);
  if (known) return known;
  const next = new Set(chain).add(fileId);
  const pending = (async () => {
    const location = await deps.locate(fileId);
    if (!location) return false;
    if (location.driveId && sharedDriveIds.includes(location.driveId)) return true;
    for (const parent of location.parents) if (await withinScope(parent, settings, deps, memo, next)) return true;
    return false;
  })();
  memo.set(fileId, pending);
  return pending;
}

export function createGoogleLocationCache(
  locate: (fileId: string) => Promise<GoogleFileLocation | null>,
  options: { ttlMs?: number; now?: () => number; maxEntries?: number } = {},
) {
  const ttlMs = options.ttlMs ?? LOCATION_TTL_MS;
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? LOCATION_CACHE_MAX;
  const entries = new Map<string, { value: Promise<GoogleFileLocation | null>; expiresAt: number }>();
  return {
    locate(fileId: string): Promise<GoogleFileLocation | null> {
      const cached = entries.get(fileId);
      if (cached && cached.expiresAt > now()) return cached.value;
      const value = locate(fileId);
      entries.delete(fileId);
      if (entries.size >= maxEntries) entries.delete(entries.keys().next().value as string);
      entries.set(fileId, { value, expiresAt: now() + ttlMs });
      value.catch(() => entries.delete(fileId));
      return value;
    },
    forget(plan: GoogleCallPlan): void {
      const fileId = plan.params.fileId;
      if (typeof fileId !== "string") return;
      if (plan.method === "drive.files.update" && (plan.params.addParents !== undefined || plan.params.removeParents !== undefined)) entries.delete(fileId);
      if (plan.method === "drive.files.delete") entries.delete(fileId);
    },
  };
}

function balancedDriveQuery(query: string): boolean {
  let depth = 0;
  let quoted = false;
  for (let position = 0; position < query.length; position += 1) {
    const char = query[position];
    if (quoted) {
      if (char === "\\") position += 1;
      else if (char === "'") quoted = false;
      continue;
    }
    if (char === '"') return false;
    if (char === "'") quoted = true;
    else if (char === "(") depth += 1;
    else if (char === ")" && (depth -= 1) < 0) return false;
  }
  return depth === 0 && !quoted;
}

function driveQueryLiteral(id: string): string {
  return `'${id.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

async function scopedFilesListQuery(
  plan: GoogleCallPlan,
  settings: GoogleWorkspaceSettings,
  inScope: (id: string) => Promise<boolean>,
): Promise<{ violation: string } | { query: [string, string][] | null }> {
  const driveId = plan.params.driveId;
  if (typeof driveId === "string" && settings.scope.sharedDriveIds.includes(driveId) && plan.params.corpora === "drive") return { query: null };
  const agentQuery = typeof plan.params.q === "string" ? plan.params.q.trim() : "";
  if (!balancedDriveQuery(agentQuery)) return { violation: "q must have balanced parentheses and single-quoted strings" };
  const named = [...agentQuery.matchAll(/'((?:[^'\\]|\\.)*)'\s+in\s+parents/g)].map((match) => match[1].replace(/\\(.)/g, "$1"));
  const folders = named.length > 0 ? [...new Set(named)] : settings.scope.driveFolderIds;
  if (folders.length === 0) return { violation: "add \"'<allowed folder id>' in parents\" to q, or list an allowed shared drive with corpora=drive" };
  for (const folder of folders) if (!(await inScope(folder))) return { violation: `folder ${folder} is outside the allowed folders` };
  const clause = folders.map((folder) => `${driveQueryLiteral(folder)} in parents`).join(" or ");
  const q = agentQuery ? `(${clause}) and (${agentQuery})` : `(${clause})`;
  const rest = plan.query.filter(([name]) => name !== "q");
  return { query: [...rest, ["q", q]] };
}

function splitIds(value: unknown): string[] {
  return typeof value === "string" ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

async function scopeCheck(
  plan: GoogleCallPlan,
  settings: GoogleWorkspaceSettings,
  deps: GooglePolicyDependencies,
): Promise<{ violation: string } | { query: [string, string][] | null }> {
  if (!scopeLimited(settings) || !DRIVE_BACKED.has(plan.service as GoogleWorkspaceService)) return { query: null };
  const memo = new Map<string, Promise<boolean>>();
  const inScope = (id: string) => withinScope(id, settings, deps, memo);
  if (plan.method === "drive.files.list") return scopedFilesListQuery(plan, settings, inScope);
  const violation = await scopeViolation(plan, settings, inScope);
  return violation ? { violation } : { query: null };
}

async function scopeViolation(plan: GoogleCallPlan, settings: GoogleWorkspaceSettings, inScope: (id: string) => Promise<boolean>): Promise<string | null> {
  const body = isRecord(plan.body) ? plan.body : {};
  const targets = TARGET_PARAMS.flatMap((name) => (typeof plan.params[name] === "string" ? [plan.params[name] as string] : []));
  for (const target of targets) if (!(await inScope(target))) return `${target} is outside the allowed folders or files`;
  for (const parent of splitIds(plan.params.addParents)) if (!(await inScope(parent))) return `folder ${parent} is outside the allowed folders`;
  if (ROOT_CREATORS.has(plan.method)) return "this creates the file in My Drive root; create it with drive.files.create inside an allowed folder";
  if (plan.method === "drive.files.create" || plan.method === "drive.files.copy") {
    const parents = Array.isArray(body.parents) ? body.parents.filter((item): item is string => typeof item === "string") : [];
    if (parents.length === 0) return "set body.parents to an allowed folder";
    for (const parent of parents) if (!(await inScope(parent))) return `folder ${parent} is outside the allowed folders`;
    return null;
  }
  if (targets.length > 0 || TARGETLESS_IN_SCOPE.has(plan.method)) return null;
  const driveId = plan.params.driveId;
  if (SHARED_DRIVE_SCOPED.has(plan.method) && typeof driveId === "string" && settings.scope.sharedDriveIds.includes(driveId)) return null;
  return "this call is not limited to a file, folder or shared drive this connection allows";
}

export async function decideGoogleCall(plan: GoogleCallPlan, settings: GoogleWorkspaceSettings, deps: GooglePolicyDependencies): Promise<GooglePolicyDecision> {
  const reasons: string[] = [];
  const externalRecipients: string[] = [];
  const { entries, recipientsUnknown } = await effectiveClasses(plan, settings, deps, reasons, externalRecipients);
  const classes = [...new Set(entries.map((entry) => entry.value))];
  const block = (error: GoogleWorkspaceError): GooglePolicyDecision => ({
    action: "block",
    classes,
    reasons: [...reasons, error.message],
    externalRecipients,
    recipientsUnknown,
    query: null,
    error,
  });
  const service = plan.service as GoogleWorkspaceService;

  if (HARD_BLOCKED.has(plan.method)) {
    return block(new GoogleWorkspaceError("capability_off", `${plan.method} is blocked for agents`, "Empty the trash in Google Drive yourself.", { method: plan.method }));
  }
  const tier = settings.capabilities[service] ?? "off";
  const needed = entries.reduce<GoogleWorkspaceTier>((max, entry) => {
    const next = requiredTier(plan, entry.value, entry.isKind);
    return TIER_RANK[next] > TIER_RANK[max] ? next : max;
  }, "read");
  if (TIER_RANK[tier] < TIER_RANK[needed]) {
    return block(new GoogleWorkspaceError("capability_off", `${service} is set to "${tier}" for this connection; this call needs "${needed}"`, "Ask the connection owner to raise the capability level for this service.", { service, tier, required: needed }));
  }
  if (deps.grantedScopes.length > 0 && plan.scopes.length > 0 && !plan.scopes.some((scope) => deps.grantedScopes.includes(scope))) {
    return block(new GoogleWorkspaceError("scope_missing", `The Google grant has no scope that allows ${plan.method}`, "Ask the connection owner to grant additional access in the connection page.", { method: plan.method, acceptedScopes: plan.scopes }));
  }
  let action: GoogleWorkspacePolicyAction = "allow";
  for (const entry of entries) {
    const next = actionFor(settings, entry.key, entry.value);
    if (next !== "allow") reasons.push(`${entry.key} is ${entry.value}: ${next}`);
    if (ACTION_RANK[next] > ACTION_RANK[action]) action = next;
  }
  if (action === "block") {
    return block(new GoogleWorkspaceError("capability_off", `${plan.method} is blocked by this connection's policy`, "Ask the connection owner to change the policy for this class or method.", { method: plan.method, classes }));
  }
  const scope = await scopeCheck(plan, settings, deps);
  if ("violation" in scope) {
    return block(new GoogleWorkspaceError("out_of_scope", scope.violation, "Work inside the folders, shared drives or spreadsheets this connection allows.", { scope: settings.scope }));
  }
  const query = scope.query;
  if (externalRecipients.length > 0) reasons.push(`recipients outside the domain: ${externalRecipients.join(", ")}`);
  if (action === "require_approval") {
    return {
      action,
      classes,
      reasons,
      externalRecipients,
      recipientsUnknown,
      query,
      error: new GoogleWorkspaceError("approval_required", `${plan.method} needs approval (${classes.filter((value) => value !== "read" && value !== "write").join(", ")})`, "An approval card was created; the call runs after a person approves it.", {
        classes,
        externalRecipients,
        recipientsUnknown,
      }),
    };
  }
  return { action, classes, reasons, externalRecipients, recipientsUnknown, query, error: null };
}

export function googlePolicyVerdict(decision: GooglePolicyDecision, options: { approved: boolean }): GooglePolicyVerdict {
  if (decision.action === "allow" || (decision.action === "require_approval" && options.approved)) {
    return { allowed: true, notes: decision.reasons, ...(decision.query ? { query: decision.query } : {}) };
  }
  return { allowed: false, error: decision.error as GoogleWorkspaceError };
}
