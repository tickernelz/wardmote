import { normalizeGoogleWorkspaceSettings } from "@tickernelz/wardmote-shared";
import { describe, expect, it } from "vitest";

import { createFakeGoogle } from "../../__tests__/helpers/fake-google.js";
import { createGoogleDiscoveryIndex } from "./discovery.js";
import { buildPlainTextMessage, decideGoogleWorkspaceTool, googleToolCallInput, runGoogleWorkspaceTool, type GoogleWorkspaceToolRuntime } from "./runtime.js";

function setup(settingsInput: Record<string, unknown> = {}) {
  const google = createFakeGoogle();
  const all = "delete_share";
  const runtime: GoogleWorkspaceToolRuntime = {
    discovery: createGoogleDiscoveryIndex({ fetch: google.fetch }),
    settings: normalizeGoogleWorkspaceSettings({ capabilities: { drive: all, sheets: all, docs: all, gmail: all, calendar: all }, domain: "example.com", ...settingsInput }),
    grantedScopes: [],
    credentials: { headers: async () => ({ authorization: `Bearer ${google.token}` }) },
    attachments: {
      read: async () => ({ bytes: Buffer.from("q1,q2\n1,2\n"), contentType: "text/csv", filename: "report.csv" }),
      store: async (input) => ({ attachmentId: "att-1", byteSize: input.bytes.byteLength, contentType: input.contentType, filename: input.filename }),
    },
    fetch: google.fetch,
    sleep: async () => undefined,
  };
  return { google, runtime };
}

async function step(runtime: GoogleWorkspaceToolRuntime, tool: string, args: Record<string, unknown>) {
  const decision = await decideGoogleWorkspaceTool(runtime, tool, args);
  const action = decision?.action ?? "allow";
  let refused: unknown = null;
  if (action === "require_approval") {
    refused = await runGoogleWorkspaceTool(runtime, tool, args, { approved: false }).catch((error: unknown) => error);
  }
  const result = (await runGoogleWorkspaceTool(runtime, tool, args, { approved: action === "require_approval" })) as { data?: Record<string, unknown>; class?: string };
  return { action, refused, result, decision };
}

describe("six-step sample task (plan 3.4) against a fake Google server", () => {
  it("creates, fills, formats, uploads, shares and deletes with approvals where the plan requires them", async () => {
    const { google, runtime } = setup({ scope: { driveFolderIds: [] } });
    const folder = google.addFile("Reports", "application/vnd.google-apps.folder");

    const created = await step(runtime, "google_call", { method: "sheets.spreadsheets.create", body: { properties: { title: "Q4" } } });
    expect(created.action).toBe("allow");
    const spreadsheetId = created.result.data?.spreadsheetId as string;

    const filled = await step(runtime, "google_sheets_append", { spreadsheetId, range: "Sheet1!A1", values: [["region", "total"], ["west", 10]] });
    expect(filled.action).toBe("allow");
    expect(google.spreadsheets.get(spreadsheetId)?.values["Sheet1!A1"]).toEqual([["region", "total"], ["west", 10]]);

    const formatted = await step(runtime, "google_call", {
      method: "sheets.spreadsheets.batchUpdate",
      params: { spreadsheetId },
      body: { requests: [{ addSheet: { properties: { title: "Summary" } } }, { repeatCell: { range: { sheetId: 0 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: "userEnteredFormat.textFormat.bold" } }, { deleteSheet: { sheetId: 0 } }] },
    });
    expect(formatted.action).toBe("require_approval");
    expect(formatted.refused).toMatchObject({ code: "approval_required" });
    expect(google.spreadsheets.get(spreadsheetId)?.sheets.map((sheet) => sheet.title)).toEqual(["Summary"]);

    const uploaded = await step(runtime, "google_drive_upload", { attachmentId: "att-report", folderId: folder.id });
    expect(uploaded.action).toBe("allow");
    const fileId = uploaded.result.data?.id as string;
    expect(google.files.get(fileId)).toMatchObject({ name: "report.csv", parents: [folder.id], mimeType: "text/csv" });

    const shared = await step(runtime, "google_drive_share", { fileId, role: "reader", emailAddress: "auditor@other.org" });
    expect(shared.action).toBe("require_approval");
    expect(shared.decision?.externalRecipients).toEqual(["auditor@other.org"]);
    expect(shared.refused).toMatchObject({ code: "approval_required" });
    expect(google.files.get(fileId)?.permissions.map((permission) => permission.emailAddress)).toEqual(["owner@example.com", "auditor@other.org"]);

    const deleted = await step(runtime, "google_call", { method: "drive.files.delete", params: { fileId } });
    expect(deleted.action).toBe("require_approval");
    expect(google.files.get(fileId)?.trashed).toBe(true);

    const googleCalls = google.requests.map((request) => `${request.method} ${new URL(request.url).pathname}`);
    expect(googleCalls).toEqual([
      "POST /v4/spreadsheets",
      `POST /v4/spreadsheets/${spreadsheetId}/values/Sheet1!A1:append`,
      `POST /v4/spreadsheets/${spreadsheetId}:batchUpdate`,
      "POST /upload/drive/v3/files",
      `POST /drive/v3/files/${fileId}/permissions`,
      `PATCH /drive/v3/files/${fileId}`,
    ]);
  });
});

describe("helpers", () => {
  it("builds a plain-text message with encoded subject and approval for outside recipients", async () => {
    const { runtime } = setup();
    const args = { to: ["a@example.com", "b@other.org"], subject: "Laporan Q4 — final", body: "Halo" };
    const decision = await decideGoogleWorkspaceTool(runtime, "google_gmail_send", args);
    expect(decision).toMatchObject({ action: "require_approval", externalRecipients: ["b@other.org"] });
    const raw = Buffer.from(buildPlainTextMessage({ to: args.to, cc: [], subject: args.subject, body: args.body }), "base64url").toString("utf8");
    expect(raw).toContain("To: a@example.com, b@other.org\r\n");
    expect(raw).toContain(`Subject: =?UTF-8?B?${Buffer.from(args.subject).toString("base64")}?=`);
  });

  it("rejects header injection and malformed addresses", () => {
    expect(() => googleToolCallInput("google_gmail_send", { to: ["a@example.com\r\nBcc: x@evil.org"], subject: "s", body: "b" })).toThrow(expect.objectContaining({ code: "validation" }));
    expect(() => googleToolCallInput("google_gmail_send", { to: ["a@example.com"], subject: "s\r\nBcc: x@evil.org", body: "b" })).toThrow(expect.objectContaining({ code: "validation" }));
    expect(() => googleToolCallInput("google_drive_share", { fileId: "f", role: "reader", type: "user" })).toThrow(expect.objectContaining({ details: { pointer: "/emailAddress" } }));
  });

  it("maps calendar and docs helpers to the reviewed methods", () => {
    expect(googleToolCallInput("google_calendar_insert", { summary: "Sync", start: "2026-11-20", end: "2026-11-21", attendees: ["a@example.com"] })).toMatchObject({
      method: "calendar.events.insert",
      params: { calendarId: "primary", sendUpdates: "none" },
      body: { start: { date: "2026-11-20" }, attendees: [{ email: "a@example.com" }] },
    });
    expect(googleToolCallInput("google_docs_write", { documentId: "d", text: "hi" })).toMatchObject({ body: { requests: [{ insertText: { text: "hi", endOfSegmentLocation: {} } }] } });
  });

  it("annotates search hits with what this connection allows", async () => {
    const { runtime } = setup({ capabilities: { sheets: "edit" } });
    const result = (await runGoogleWorkspaceTool(runtime, "google_search_methods", { query: "delete sheet", service: "sheets" }, { approved: false })) as { hits: { kind: string | null; policy: string }[] };
    expect(result.hits[0]).toMatchObject({ kind: "deleteSheet", policy: "block" });
    const writable = (await runGoogleWorkspaceTool(runtime, "google_search_methods", { query: "append values", service: "sheets" }, { approved: false })) as { hits: { policy: string }[] };
    expect(writable.hits[0].policy).toBe("allow");
  });

  it("skips the approval decision for dry-runs and discovery tools", async () => {
    const { runtime } = setup();
    expect(await decideGoogleWorkspaceTool(runtime, "google_call", { method: "drive.files.delete", params: { fileId: "f" }, dryRun: true })).toBeNull();
    expect(await decideGoogleWorkspaceTool(runtime, "google_describe", { method: "drive.files.delete" })).toBeNull();
  });
});
