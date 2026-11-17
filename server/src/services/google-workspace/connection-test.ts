import {
  GOOGLE_WORKSPACE_SERVICE_IDS,
  type GoogleWorkspaceConnectionTest,
  type GoogleWorkspaceService,
  type GoogleWorkspaceServiceTestResult,
  type GoogleWorkspaceTier,
} from "@tickernelz/wardmote-shared";

import { GoogleWorkspaceError } from "./errors.js";
import { executeGoogleCall, planGoogleCall, type GoogleCallInput } from "./executor.js";
import { decideGoogleCall } from "./policy.js";
import type { GoogleWorkspaceToolRuntime } from "./runtime.js";

const MISSING_ID = "wardmote-connection-test";

interface ReadProbe {
  input: GoogleCallInput;
  missingIsOk: boolean;
  malformedIdIsOk?: boolean;
}

const READ_PROBES: Record<GoogleWorkspaceService, ReadProbe> = {
  drive: { input: { method: "drive.about.get", fields: "user" }, missingIsOk: false },
  sheets: { input: { method: "sheets.spreadsheets.get", params: { spreadsheetId: MISSING_ID } }, missingIsOk: true },
  docs: { input: { method: "docs.documents.get", params: { documentId: MISSING_ID } }, missingIsOk: true },
  slides: { input: { method: "slides.presentations.get", params: { presentationId: MISSING_ID } }, missingIsOk: true },
  calendar: { input: { method: "calendar.calendarList.list", params: { maxResults: 1 } }, missingIsOk: false },
  gmail: { input: { method: "gmail.users.getProfile", params: { userId: "me" } }, missingIsOk: false },
  forms: { input: { method: "forms.forms.get", params: { formId: MISSING_ID } }, missingIsOk: true },
  tasks: { input: { method: "tasks.tasklists.list", params: { maxResults: 1 } }, missingIsOk: false },
  chat: { input: { method: "chat.spaces.list", params: { pageSize: 1 } }, missingIsOk: false },
  meet: { input: { method: "meet.conferenceRecords.list", params: { pageSize: 1 } }, missingIsOk: false },
  people: { input: { method: "people.people.connections.list", params: { resourceName: "people/me", personFields: "names", pageSize: 1 } }, missingIsOk: false },
  script: { input: { method: "script.projects.get", params: { scriptId: MISSING_ID } }, missingIsOk: true, malformedIdIsOk: true },
};

const WRITE_PROBES: Partial<Record<GoogleWorkspaceService, GoogleCallInput>> = {
  drive: { method: "drive.files.update", params: { fileId: MISSING_ID }, body: { name: "Wardmote test" } },
  sheets: { method: "sheets.spreadsheets.values.update", params: { spreadsheetId: MISSING_ID, range: "A1", valueInputOption: "RAW" }, body: { values: [["test"]] } },
  docs: { method: "docs.documents.batchUpdate", params: { documentId: MISSING_ID }, body: { requests: [{ insertText: { text: "test", endOfSegmentLocation: {} } }] } },
  calendar: { method: "calendar.events.insert", params: { calendarId: "primary" }, body: { summary: "Wardmote test" } },
  gmail: { method: "gmail.users.drafts.create", params: { userId: "me" }, body: { message: { raw: "" } } },
  tasks: { method: "tasks.tasks.insert", params: { tasklist: "@default" }, body: { title: "Wardmote test" } },
};

function failure(service: GoogleWorkspaceService, tier: GoogleWorkspaceTier, method: string, error: unknown): GoogleWorkspaceServiceTestResult {
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

async function writeVerdict(runtime: GoogleWorkspaceToolRuntime, service: GoogleWorkspaceService): Promise<GoogleWorkspaceServiceTestResult["write"]> {
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

function testItemRejected(probe: ReadProbe, error: unknown): boolean {
  if (!probe.missingIsOk || !(error instanceof GoogleWorkspaceError) || error.code !== "google_error") return false;
  if (error.details.status === 404) return true;
  return probe.malformedIdIsOk === true && error.details.status === 400 && error.details.reason === "INVALID_ARGUMENT";
}

async function testService(runtime: GoogleWorkspaceToolRuntime, service: GoogleWorkspaceService, tier: GoogleWorkspaceTier): Promise<GoogleWorkspaceServiceTestResult> {
  const probe = READ_PROBES[service];
  try {
    await executeGoogleCall({ ...runtime, policy: async () => ({ allowed: true }) }, probe.input);
  } catch (error) {
    if (!testItemRejected(probe, error)) return failure(service, tier, probe.input.method, error);
  }
  const write = tier === "read" ? null : await writeVerdict(runtime, service).catch(() => null);
  return { service, tier, ok: true, method: probe.input.method, code: null, message: null, hint: null, enableUrl: null, write };
}

export async function testGoogleWorkspaceConnection(runtime: GoogleWorkspaceToolRuntime): Promise<GoogleWorkspaceConnectionTest> {
  const active = GOOGLE_WORKSPACE_SERVICE_IDS.filter((service) => runtime.settings.capabilities[service] !== "off");
  const services = await Promise.all(active.map((service) => testService(runtime, service, runtime.settings.capabilities[service])));
  return { ok: services.length > 0 && services.every((result) => result.ok), services };
}
