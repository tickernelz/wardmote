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

export interface GooglePolicyDependencies {
  grantedScopes: readonly string[];
  locate(fileId: string): Promise<GoogleFileLocation | null>;
}

export interface GooglePolicyDecision {
  action: GoogleWorkspacePolicyAction;
  classes: GoogleMethodClassification[];
  reasons: string[];
  externalRecipients: string[];
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

function headerRecipients(raw: string): string[] {
  let text: string;
  try {
    text = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return [];
  }
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
  if (plan.method === "gmail.users.messages.send" && typeof body.raw === "string") return { recipients: headerRecipients(body.raw), public: false };
  return null;
}

function effectiveClasses(plan: GoogleCallPlan, settings: GoogleWorkspaceSettings, reasons: string[], externalRecipients: string[]) {
  const kinds = plan.classification.batchRequestKinds;
  const entries = kinds.map((item) => ({ key: `${plan.method}#${item.kind}`, value: item.class, isKind: true }));
  let methodValue = kinds.length > 0 ? plan.classification.baseClass : plan.classification.methodClass;
  const sharing = sharingTargets(plan);
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
  return entries;
}

function actionFor(settings: GoogleWorkspaceSettings, key: string, value: GoogleMethodClassification): GoogleWorkspacePolicyAction {
  if (value === "read") return settings.methodOverrides[key] === "block" ? "block" : "allow";
  return settings.methodOverrides[key] ?? settings.classPolicy[value];
}

function scopeLimited(settings: GoogleWorkspaceSettings): boolean {
  const { driveFolderIds, sharedDriveIds, spreadsheetIds } = settings.scope;
  return driveFolderIds.length + sharedDriveIds.length + spreadsheetIds.length > 0;
}

async function withinScope(fileId: string, settings: GoogleWorkspaceSettings, deps: GooglePolicyDependencies, memo: Map<string, Promise<boolean>>, depth = 0): Promise<boolean> {
  const { driveFolderIds, sharedDriveIds, spreadsheetIds } = settings.scope;
  if (driveFolderIds.includes(fileId) || spreadsheetIds.includes(fileId) || sharedDriveIds.includes(fileId)) return true;
  if (depth >= MAX_ANCESTRY) return false;
  const known = memo.get(fileId);
  if (known) return known;
  const pending = (async () => {
    const location = await deps.locate(fileId);
    if (!location) return false;
    if (location.driveId && sharedDriveIds.includes(location.driveId)) return true;
    for (const parent of location.parents) if (await withinScope(parent, settings, deps, memo, depth + 1)) return true;
    return false;
  })();
  memo.set(fileId, pending);
  return pending;
}

function splitIds(value: unknown): string[] {
  return typeof value === "string" ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

async function scopeViolation(plan: GoogleCallPlan, settings: GoogleWorkspaceSettings, deps: GooglePolicyDependencies, readOnly: boolean): Promise<string | null> {
  if (!scopeLimited(settings) || !DRIVE_BACKED.has(plan.service as GoogleWorkspaceService)) return null;
  const memo = new Map<string, Promise<boolean>>();
  const inScope = (id: string) => withinScope(id, settings, deps, memo);
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
  if (targets.length > 0) return null;
  if (plan.method === "drive.files.list") {
    const query = typeof plan.params.q === "string" ? plan.params.q : "";
    const allowed = [...settings.scope.driveFolderIds, ...settings.scope.sharedDriveIds].some((id) => query.includes(`'${id}' in parents`));
    const sharedDrive = typeof plan.params.driveId === "string" && settings.scope.sharedDriveIds.includes(plan.params.driveId);
    return allowed || sharedDrive ? null : "add \"'<allowed folder id>' in parents\" to q, or list an allowed shared drive";
  }
  return readOnly ? null : "this call has no file inside the allowed folders";
}

export async function decideGoogleCall(plan: GoogleCallPlan, settings: GoogleWorkspaceSettings, deps: GooglePolicyDependencies): Promise<GooglePolicyDecision> {
  const reasons: string[] = [];
  const externalRecipients: string[] = [];
  const entries = effectiveClasses(plan, settings, reasons, externalRecipients);
  const classes = [...new Set(entries.map((entry) => entry.value))];
  const block = (error: GoogleWorkspaceError): GooglePolicyDecision => ({ action: "block", classes, reasons: [...reasons, error.message], externalRecipients, error });
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
  const outside = await scopeViolation(plan, settings, deps, classes.every((value) => value === "read"));
  if (outside) {
    return block(new GoogleWorkspaceError("out_of_scope", outside, "Work inside the folders, shared drives or spreadsheets this connection allows.", { scope: settings.scope }));
  }
  if (externalRecipients.length > 0) reasons.push(`recipients outside the domain: ${externalRecipients.join(", ")}`);
  if (action === "require_approval") {
    return {
      action,
      classes,
      reasons,
      externalRecipients,
      error: new GoogleWorkspaceError("approval_required", `${plan.method} needs approval (${classes.filter((value) => value !== "read" && value !== "write").join(", ")})`, "An approval card was created; the call runs after a person approves it.", {
        classes,
        externalRecipients,
      }),
    };
  }
  return { action, classes, reasons, externalRecipients, error: null };
}

export function googlePolicyVerdict(decision: GooglePolicyDecision, options: { approved: boolean }): GooglePolicyVerdict {
  if (decision.action === "allow" || (decision.action === "require_approval" && options.approved)) {
    return { allowed: true, notes: decision.reasons };
  }
  return { allowed: false, error: decision.error as GoogleWorkspaceError };
}
