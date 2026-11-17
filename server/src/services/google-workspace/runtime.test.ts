import { normalizeGoogleWorkspaceSettings } from "@tickernelz/wardmote-shared";
import { describe, expect, it } from "vitest";

import { createFakeGoogle } from "../../__tests__/helpers/fake-google.js";
import { createGoogleDiscoveryIndex } from "./discovery.js";
import { googleApprovalSnapshot } from "./policy.js";
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
      head: async () => Buffer.from("To: a@example.com\r\nSubject: report\r\n\r\n"),
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
  const approvedSnapshot = decision ? googleApprovalSnapshot(decision) : undefined;
  const result = (await runGoogleWorkspaceTool(runtime, tool, args, { approved: action === "require_approval", approvedSnapshot })) as { data?: Record<string, unknown>; class?: string };
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
    expect(() => googleToolCallInput("google_drive_share", { fileId: "f", role: "reader" })).toThrow(expect.objectContaining({ details: { pointer: "/type" } }));
    expect(googleToolCallInput("google_drive_share", { fileId: "f", role: "reader", type: "anyone" })).toMatchObject({ body: { type: "anyone" } });
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

  it("reads a draft's recipients from Gmail before asking to send it", async () => {
    const { google, runtime } = setup();
    google.queue(
      new Response(JSON.stringify({ id: "d1", message: { payload: { headers: [{ name: "To", value: "Ann <a@example.com>" }, { name: "Cc", value: "g@other.org" }] } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const decision = await decideGoogleWorkspaceTool(runtime, "google_call", { method: "gmail.users.drafts.send", params: { userId: "me" }, body: { id: "d1" } });
    expect(decision?.reasons).not.toContain("the recipients could not be read");
    expect(decision).toMatchObject({ action: "require_approval", externalRecipients: ["g@other.org"], recipientsUnknown: false });
    const sent = google.requests.at(-1)?.url ?? "";
    expect(sent).toContain("/gmail/v1/users/me/drafts/d1");
    expect(sent).toContain("format=metadata");
  });

  it("refuses an approved send whose recipients changed after the card was created", async () => {
    const { google, runtime } = setup();
    const draft = (to: string) =>
      new Response(JSON.stringify({ id: "d1", message: { payload: { headers: [{ name: "To", value: to }] } } }), { status: 200, headers: { "content-type": "application/json" } });
    let current = "a@example.com";
    google.override(/\/gmail\/v1\/users\/me\/drafts\/d1\?/, () => draft(current));
    let sent = 0;
    google.override(/\/gmail\/v1\/users\/me\/drafts\/send/, () => {
      sent += 1;
      return new Response(JSON.stringify({ id: "m1" }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const args = { method: "gmail.users.drafts.send", params: { userId: "me" }, body: { id: "d1" } };
    const card = await decideGoogleWorkspaceTool(runtime, "google_call", args);
    expect(card).toMatchObject({ action: "require_approval", externalRecipients: [] });
    const approvedSnapshot = googleApprovalSnapshot(card!);
    current = "x@evil.example";
    await expect(runGoogleWorkspaceTool(runtime, "google_call", args, { approved: true, approvedSnapshot })).rejects.toMatchObject({
      code: "approval_required",
      details: { current: { externalRecipients: ["x@evil.example"] } },
    });
    await expect(runGoogleWorkspaceTool(runtime, "google_call", args, { approved: true })).rejects.toMatchObject({ code: "approval_required" });
    expect(sent).toBe(0);
    current = "a@example.com";
    await runGoogleWorkspaceTool(runtime, "google_call", args, { approved: true, approvedSnapshot });
    expect(sent).toBe(1);
  });

  it("reuses file locations across calls on the same connection", async () => {
    const { google, runtime } = setup({ scope: { driveFolderIds: ["F1"] } });
    const folder = google.addFile("sub", "application/vnd.google-apps.folder");
    const file = google.addFile("a.txt");
    google.files.get(folder.id)!.parents = ["F1"];
    google.files.get(file.id)!.parents = [folder.id];
    const shared = { ...runtime, connectionId: "conn-zha6620-cache" };
    expect((await decideGoogleWorkspaceTool(shared, "google_call", { method: "drive.files.get", params: { fileId: file.id } }))?.action).toBe("allow");
    const first = google.requests.length;
    expect((await decideGoogleWorkspaceTool(shared, "google_call", { method: "drive.files.get", params: { fileId: file.id } }))?.action).toBe("allow");
    expect(google.requests.length).toBe(first);
  });

  it("names the services whose Discovery failed in search results", async () => {
    const { google, runtime } = setup();
    const failing = { ...runtime, discovery: createGoogleDiscoveryIndex({ fetch: (async (url: string | URL | Request, init?: RequestInit) => (String(url).includes("/sheets/") ? google.fetch(url, init) : new Response("{}", { status: 503 }))) as typeof fetch }) };
    const result = (await runGoogleWorkspaceTool(failing, "google_search_methods", { query: "append values" }, { approved: false })) as { hits: { id: string }[]; unavailableServices?: string[] };
    expect(result.hits[0].id).toBe("sheets.spreadsheets.values.append");
    expect(result.unavailableServices).toContain("drive");
  });

  it("skips the approval decision for dry-runs and discovery tools", async () => {
    const { runtime } = setup();
    expect(await decideGoogleWorkspaceTool(runtime, "google_call", { method: "drive.files.delete", params: { fileId: "f" }, dryRun: true })).toBeNull();
    expect(await decideGoogleWorkspaceTool(runtime, "google_describe", { method: "drive.files.delete" })).toBeNull();
  });
});
