import {
  GOOGLE_WORKSPACE_SERVICE_IDS,
  type GoogleWorkspacePolicyAction,
  type GoogleWorkspaceService,
  type GoogleWorkspaceTier,
} from "@tickernelz/wardmote-shared";

import { GoogleWorkspaceError } from "./errors.js";
import { executeGoogleCall, planGoogleCall, type GoogleCallInput } from "./executor.js";
import { decideGoogleCall } from "./policy.js";
import type { GoogleWorkspaceToolRuntime } from "./runtime.js";

const MISSING_ID = "wardmote-connection-test";

const READ_PROBES: Record<GoogleWorkspaceService, { input: GoogleCallInput; missingIsOk: boolean }> = {
  drive: { input: { method: "drive.about.get", fields: "user" }, missingIsOk: false },
  sheets: { input: { method: "sheets.spreadsheets.get", params: { spreadsheetId: MISSING_ID } }, missingIsOk: true },
  docs: { input: { method: "docs.documents.get", params: { documentId: MISSING_ID } }, missingIsOk: true },
  slides: { input: { method: "slides.presentations.get", params: { presentationId: MISSING_ID } }, missingIsOk: true },
  calendar: { input: { method: "calendar.calendarList.list", params: { maxResults: 1 } }, missingIsOk: false },
  gmail: { input: { method: "gmail.users.getProfile", params: { userId: "me" } }, missingIsOk: false },
  forms: { input: { method: "forms.forms.get", params: { formId: MISSING_ID } }, missingIsOk: true },
  tasks: { input: { method: "tasks.tasklists.list", params: { maxResults: 1 } }, missingIsOk: false },
  chat: { input: { method: "chat.spaces.list", params: { pageSize: 1 } }, missingIsOk: false },
  meet: { input: { method: "meet.spaces.get", params: { name: `spaces/${MISSING_ID}` } }, missingIsOk: true },
  people: { input: { method: "people.people.get", params: { resourceName: "people/me", personFields: "names" } }, missingIsOk: false },
  script: { input: { method: "script.projects.get", params: { scriptId: MISSING_ID } }, missingIsOk: true },
};

const WRITE_PROBES: Partial<Record<GoogleWorkspaceService, GoogleCallInput>> = {
  drive: { method: "drive.files.update", params: { fileId: MISSING_ID }, body: { name: "Wardmote test" } },
  sheets: { method: "sheets.spreadsheets.values.update", params: { spreadsheetId: MISSING_ID, range: "A1", valueInputOption: "RAW" }, body: { values: [["test"]] } },
  docs: { method: "docs.documents.batchUpdate", params: { documentId: MISSING_ID }, body: { requests: [{ insertText: { text: "test", endOfSegmentLocation: {} } }] } },
  calendar: { method: "calendar.events.insert", params: { calendarId: "primary" }, body: { summary: "Wardmote test" } },
  gmail: { method: "gmail.users.drafts.create", params: { userId: "me" }, body: { message: { raw: "" } } },
  tasks: { method: "tasks.tasks.insert", params: { tasklist: "@default" }, body: { title: "Wardmote test" } },
};

export interface GoogleServiceTestResult {
  service: GoogleWorkspaceService;
  tier: GoogleWorkspaceTier;
  ok: boolean;
  method: string;
  code: GoogleWorkspaceError["code"] | null;
  message: string | null;
  hint: string | null;
  enableUrl: string | null;
  write: { method: string; action: GoogleWorkspacePolicyAction; reason: string | null } | null;
}

function failure(service: GoogleWorkspaceService, tier: GoogleWorkspaceTier, method: string, error: unknown): GoogleServiceTestResult {
  const typed = error instanceof GoogleWorkspaceError ? error : null;
  const enableUrl = typed && typeof typed.details.enableUrl === "string" ? typed.details.enableUrl : null;
  return {
    service,
    tier,
    ok: false,
    method,
    code: typed?.code ?? "google_error",
    message: typed?.message ?? (error instanceof Error ? error.message : String(error)),
    hint: typed?.hint ?? null,
    enableUrl,
    write: null,
  };
}

async function writeVerdict(runtime: GoogleWorkspaceToolRuntime, service: GoogleWorkspaceService): Promise<GoogleServiceTestResult["write"]> {
  const input = WRITE_PROBES[service];
  if (!input) return null;
  const { plan } = await planGoogleCall(runtime.discovery, input);
  const decision = await decideGoogleCall(plan, runtime.settings, {
    grantedScopes: runtime.grantedScopes,
    locate: async () => null,
    mailHeaders: async () => null,
  });
  return { method: input.method, action: decision.action, reason: decision.error?.message ?? null };
}

async function testService(runtime: GoogleWorkspaceToolRuntime, service: GoogleWorkspaceService, tier: GoogleWorkspaceTier): Promise<GoogleServiceTestResult> {
  const probe = READ_PROBES[service];
  try {
    await executeGoogleCall({ ...runtime, policy: async () => ({ allowed: true }) }, probe.input);
  } catch (error) {
    const missing = error instanceof GoogleWorkspaceError && error.code === "google_error" && error.details.status === 404;
    if (!(probe.missingIsOk && missing)) return failure(service, tier, probe.input.method, error);
  }
  const write = tier === "read" ? null : await writeVerdict(runtime, service).catch(() => null);
  return { service, tier, ok: true, method: probe.input.method, code: null, message: null, hint: null, enableUrl: null, write };
}

export async function testGoogleWorkspaceConnection(runtime: GoogleWorkspaceToolRuntime): Promise<{ ok: boolean; services: GoogleServiceTestResult[] }> {
  const active = GOOGLE_WORKSPACE_SERVICE_IDS.filter((service) => runtime.settings.capabilities[service] !== "off");
  const services = await Promise.all(active.map((service) => testService(runtime, service, runtime.settings.capabilities[service])));
  return { ok: services.length > 0 && services.every((result) => result.ok), services };
}
