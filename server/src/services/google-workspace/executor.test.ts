import { describe, expect, it, vi } from "vitest";

import { createFakeGoogle, googleError, json, type FakeGoogle } from "../../__tests__/helpers/fake-google.js";
import { createGoogleDiscoveryIndex } from "./discovery.js";
import { GoogleWorkspaceError } from "./errors.js";
import { executeGoogleCall, type GoogleCallContext, type GoogleCallPlan, type GooglePolicyVerdict } from "./executor.js";

function setup(options: { policy?: (plan: GoogleCallPlan) => GooglePolicyVerdict; attachmentBytes?: Buffer } = {}) {
  const google = createFakeGoogle();
  const stored: { filename: string; contentType: string; bytes: Uint8Array }[] = [];
  const plans: GoogleCallPlan[] = [];
  const headers = vi.fn(async (_: { forceRefresh: boolean }) => ({ authorization: `Bearer ${google.token}` }));
  const context: GoogleCallContext = {
    discovery: createGoogleDiscoveryIndex({ fetch: google.fetch }),
    credentials: { headers },
    attachments: {
      read: async (attachmentId) => ({ bytes: options.attachmentBytes ?? Buffer.from(`bytes of ${attachmentId}`), contentType: "text/csv", filename: "data.csv" }),
      head: async (attachmentId, bytes) => Buffer.from(`bytes of ${attachmentId}`).subarray(0, bytes),
      store: async (input) => {
        stored.push(input);
        return { attachmentId: `att-${stored.length}`, byteSize: input.bytes.byteLength, contentType: input.contentType, filename: input.filename };
      },
    },
    policy: async (plan) => {
      plans.push(plan);
      return options.policy ? options.policy(plan) : { allowed: true };
    },
    fetch: google.fetch,
    sleep: async () => undefined,
  };
  return { google, context, stored, plans, headers };
}

async function newSpreadsheet(google: FakeGoogle, context: GoogleCallContext) {
  const created = await executeGoogleCall(context, { method: "sheets.spreadsheets.create", body: { properties: { title: "Budget" } } });
  google.requests.length = 0;
  return (created.data as { spreadsheetId: string }).spreadsheetId;
}

const approvalRequired = (plan: GoogleCallPlan): GooglePolicyVerdict =>
  plan.classification.classes.includes("destructive")
    ? { allowed: false, error: new GoogleWorkspaceError("approval_required", "Deleting needs approval", "Wait for the approval card.") }
    : { allowed: true };

describe("executeGoogleCall dry-run", () => {
  it("plans a destructive batchUpdate without calling Google and reports the policy verdict", async () => {
    const { google, context } = setup({ policy: approvalRequired });
    const spreadsheetId = await newSpreadsheet(google, context);
    const result = await executeGoogleCall(context, {
      method: "sheets.spreadsheets.batchUpdate",
      params: { spreadsheetId },
      body: { requests: [{ repeatCell: { range: { sheetId: 0 }, fields: "userEnteredFormat" } }, { deleteSheet: { sheetId: 0 } }] },
      dryRun: true,
    });
    expect(google.requests).toEqual([]);
    expect(result).toMatchObject({
      ok: true,
      dryRun: true,
      class: "destructive",
      plan: {
        httpMethod: "POST",
        url: `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
        classes: ["write", "destructive"],
        policy: { allowed: false, code: "approval_required" },
      },
      quota: { requests: 1 },
    });
  });

  it("refuses the real call when policy denies it and never reaches Google", async () => {
    const { google, context } = setup({ policy: approvalRequired });
    const spreadsheetId = await newSpreadsheet(google, context);
    await expect(
      executeGoogleCall(context, { method: "sheets.spreadsheets.batchUpdate", params: { spreadsheetId }, body: { requests: [{ deleteSheet: { sheetId: 0 } }] } }),
    ).rejects.toMatchObject({ code: "approval_required" });
    expect(google.requests).toEqual([]);
    expect(google.spreadsheets.get(spreadsheetId)?.sheets).toHaveLength(1);
  });
});

describe("executeGoogleCall validation", () => {
  it("points at an unknown body field with the schema around it", async () => {
    const { context } = setup();
    await expect(
      executeGoogleCall(context, { method: "sheets.spreadsheets.batchUpdate", params: { spreadsheetId: "s" }, body: { requests: [{ deleteSheet: { sheetIdd: 1 } }] } }),
    ).rejects.toMatchObject({ code: "validation", details: { pointer: "/body/requests/0/deleteSheet/sheetIdd", schema: { type: "object", fields: ["sheetId"] } } });
  });

  it("rejects a wrong primitive type, two kinds in one request, and an unknown kind", async () => {
    const { context } = setup();
    const call = (body: unknown) => executeGoogleCall(context, { method: "sheets.spreadsheets.batchUpdate", params: { spreadsheetId: "s" }, body });
    await expect(call({ requests: [{ deleteSheet: { sheetId: "first" } }] })).rejects.toMatchObject({ details: { pointer: "/body/requests/0/deleteSheet/sheetId" } });
    await expect(call({ requests: [{ addSheet: {}, deleteSheet: { sheetId: 1 } }] })).rejects.toMatchObject({ details: { pointer: "/body/requests/0" } });
    await expect(call({ requests: [{ dropEverything: {} }] })).rejects.toMatchObject({ details: { pointer: "/body/requests/0/dropEverything" } });
  });

  it("rejects missing and unknown parameters", async () => {
    const { context } = setup();
    await expect(executeGoogleCall(context, { method: "drive.files.get" })).rejects.toMatchObject({ code: "validation", details: { pointer: "/params/fileId" } });
    await expect(executeGoogleCall(context, { method: "drive.files.get", params: { fileId: "f", fileIdd: "x" } })).rejects.toMatchObject({ details: { pointer: "/params/fileIdd" } });
    await expect(executeGoogleCall(context, { method: "drive.files.list", params: { pageSize: "ten" } })).rejects.toMatchObject({ details: { pointer: "/params/pageSize" } });
  });
});

describe("executeGoogleCall requests", () => {
  it("sends a JSON call and marks the result untrusted", async () => {
    const { google, context } = setup();
    const spreadsheetId = await newSpreadsheet(google, context);
    const result = await executeGoogleCall(context, {
      method: "sheets.spreadsheets.values.update",
      params: { spreadsheetId, range: "Sheet1!A1:B2", valueInputOption: "RAW" },
      body: { values: [["a", "b"], [1, 2]] },
    });
    expect(result).toMatchObject({ ok: true, dryRun: false, status: 200, class: "write", untrusted: true, data: { updatedCells: 4 }, quota: { requests: 1 } });
    expect(result.source.url).toBe(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/Sheet1!A1%3AB2?valueInputOption=RAW`);
    expect(google.spreadsheets.get(spreadsheetId)?.values["Sheet1!A1:B2"]).toEqual([["a", "b"], [1, 2]]);
  });

  it("follows pages up to pageLimit and returns the remaining token", async () => {
    const { google, context } = setup();
    for (const name of ["a", "b", "c", "d", "e"]) google.addFile(name);
    const all = await executeGoogleCall(context, { method: "drive.files.list", pageAll: true });
    expect((all.data as { files: unknown[] }).files).toHaveLength(5);
    expect(all.nextPageToken).toBeUndefined();
    expect(all.quota.requests).toBe(3);
    const limited = await executeGoogleCall(context, { method: "drive.files.list", pageAll: true, pageLimit: 2 });
    expect((limited.data as { files: unknown[] }).files).toHaveLength(4);
    expect(limited.nextPageToken).toBe("4");
    const single = await executeGoogleCall(context, { method: "drive.files.list" });
    expect(single.nextPageToken).toBe("2");
  });

  it("moves a file to trash instead of deleting it unless permanentDelete is set", async () => {
    const { google, context } = setup();
    const file = google.addFile("old.txt");
    const trashed = await executeGoogleCall(context, { method: "drive.files.delete", params: { fileId: file.id } });
    expect(google.requests.at(-1)).toMatchObject({ method: "PATCH" });
    expect(trashed.class).toBe("destructive");
    expect(google.files.get(file.id)?.trashed).toBe(true);
    await executeGoogleCall(context, { method: "drive.files.delete", params: { fileId: file.id }, permanentDelete: true });
    expect(google.requests.at(-1)).toMatchObject({ method: "DELETE" });
    expect(google.files.has(file.id)).toBe(false);
  });
});

describe("executeGoogleCall files", () => {
  it("uploads a small attachment as multipart", async () => {
    const { google, context } = setup();
    const result = await executeGoogleCall(context, { method: "drive.files.create", body: { name: "data.csv", parents: ["folder-1"] }, upload: { attachmentId: "a1" } });
    const id = (result.data as { id: string }).id;
    expect(google.requests.at(-1)?.url).toBe("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart");
    expect(google.files.get(id)).toMatchObject({ name: "data.csv", parents: ["folder-1"], mimeType: "text/csv" });
    expect(google.files.get(id)?.content.toString()).toBe("bytes of a1");
  });

  it("uploads a large attachment through a resumable session", async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 7);
    const { google, context } = setup({ attachmentBytes: big });
    const result = await executeGoogleCall(context, { method: "drive.files.create", body: { name: "big.bin" }, upload: { attachmentId: "a2", contentType: "application/octet-stream" } });
    expect(google.requests.map((request) => request.method)).toEqual(["POST", "PUT"]);
    expect(result.quota.requests).toBe(2);
    expect(google.files.get((result.data as { id: string }).id)?.content.byteLength).toBe(big.byteLength);
  });

  it("stores downloads and binary exports as attachments and inlines text exports", async () => {
    const { google, context, stored } = setup();
    const file = google.addFile("report.pdf", "application/pdf", Buffer.from("%PDF-1.7 bytes"));
    const download = await executeGoogleCall(context, { method: "drive.files.get", params: { fileId: file.id }, download: "attachment" });
    expect(download.attachment).toEqual({ attachmentId: "att-1", byteSize: 14, contentType: "application/pdf", filename: "report.pdf" });
    expect(Buffer.from(stored[0].bytes).toString()).toBe("%PDF-1.7 bytes");
    const csv = await executeGoogleCall(context, { method: "drive.files.export", params: { fileId: file.id, mimeType: "text/csv" } });
    expect(csv).toMatchObject({ untrusted: true, data: { contentType: "text/csv", text: "a,b\n1,2\n" } });
    const pdf = await executeGoogleCall(context, { method: "drive.files.export", params: { fileId: file.id, mimeType: "application/pdf" } });
    expect(pdf.attachment?.attachmentId).toBe("att-2");
  });

  it("names a downloaded file after its Drive name, keeping the fileId only when the name is unreadable", async () => {
    const { google, context } = setup();
    const doc = google.addFile("Q3/plan", "application/vnd.google-apps.document");
    const pdf = await executeGoogleCall(context, { method: "drive.files.export", params: { fileId: doc.id, mimeType: "application/pdf" } });
    expect(pdf.attachment?.filename).toBe("Q3_plan.pdf");
    expect(pdf.quota.requests).toBe(2);
    const photo = google.addFile("holiday.jpeg", "image/jpeg", Buffer.from("jpeg"));
    const image = await executeGoogleCall(context, { method: "drive.files.get", params: { fileId: photo.id }, download: "attachment" });
    expect(image.attachment?.filename).toBe("holiday.jpeg");
    google.override(new RegExp(`/drive/v3/files/${doc.id}\\?fields=name`), () => googleError(403, "insufficientPermissions"));
    const unnamed = await executeGoogleCall(context, { method: "drive.files.export", params: { fileId: doc.id, mimeType: "application/pdf" } });
    expect(unnamed.attachment?.filename).toBe(`${doc.id}.pdf`);
  });

  it("refuses download on a method without file content", async () => {
    const { context } = setup();
    await expect(executeGoogleCall(context, { method: "drive.files.list", download: "attachment" })).rejects.toMatchObject({ code: "validation", details: { pointer: "/download" } });
  });
});

describe("executeGoogleCall credentials and errors", () => {
  it("refreshes the token once after a 401", async () => {
    const { google, context, headers } = setup();
    const file = google.addFile("x");
    const stale = `Bearer ${google.token}`;
    google.rotateToken();
    headers.mockImplementationOnce(async () => ({ authorization: stale }));
    const result = await executeGoogleCall(context, { method: "drive.files.get", params: { fileId: file.id } });
    expect(result.status).toBe(200);
    expect(headers.mock.calls.map(([options]) => options.forceRefresh)).toEqual([false, true]);
  });

  it("reports auth_expired when the refreshed token is still rejected or refresh fails", async () => {
    const { context, headers } = setup();
    headers.mockImplementation(async () => ({ authorization: "Bearer revoked" }));
    await expect(executeGoogleCall(context, { method: "drive.files.list" })).rejects.toMatchObject({ code: "auth_expired" });
    headers.mockImplementation(async () => {
      throw new Error("invalid_grant");
    });
    await expect(executeGoogleCall(context, { method: "drive.files.list" })).rejects.toMatchObject({ code: "auth_expired", details: { cause: "invalid_grant" } });
  });

  it("maps a disabled API to api_not_enabled with the activation link", async () => {
    const { google, context } = setup();
    google.queue(
      json({
        error: {
          code: 403,
          message: "Google Sheets API has not been used in project 1 before or it is disabled.",
          status: "PERMISSION_DENIED",
          details: [{ reason: "SERVICE_DISABLED", metadata: { activationUrl: "https://console.developers.google.com/apis/api/sheets.googleapis.com/overview?project=1" } }],
        },
      }, 403),
    );
    await expect(executeGoogleCall(context, { method: "sheets.spreadsheets.get", params: { spreadsheetId: "s" } })).rejects.toMatchObject({
      code: "api_not_enabled",
      details: { enableUrl: "https://console.developers.google.com/apis/api/sheets.googleapis.com/overview?project=1" },
    });
  });

  it("maps a missing Chat app to api_not_enabled with the Chat configuration link", async () => {
    const { google, context } = setup();
    google.queue(json({
      error: {
        code: 404,
        message: "Google Chat app not found. To create a Chat app, you must turn on the Chat API and configure the app in the Google Cloud console.",
        status: "NOT_FOUND",
      },
    }, 404));
    await expect(executeGoogleCall(context, { method: "chat.spaces.create", body: { spaceType: "SPACE", displayName: "Team" } })).rejects.toMatchObject({
      code: "api_not_enabled",
      details: { status: 404, enableUrl: "https://console.cloud.google.com/apis/api/chat.googleapis.com/hangouts-chat" },
    });
    google.queue(json({ error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } }, 404));
    await expect(executeGoogleCall(context, { method: "chat.spaces.get", params: { name: "spaces/missing" } })).rejects.toMatchObject({ code: "google_error" });
  });

  it("maps a missing scope to scope_missing", async () => {
    const { google, context } = setup();
    google.queue(googleError(403, "insufficientPermissions", "Request had insufficient authentication scopes."));
    await expect(executeGoogleCall(context, { method: "drive.files.list" })).rejects.toMatchObject({ code: "scope_missing" });
  });

  it("retries a rate limit once with backoff, then reports retryAfter", async () => {
    const { google, context } = setup();
    const sleep = vi.fn(async () => undefined);
    context.sleep = sleep;
    google.queue(googleError(429, "rateLimitExceeded"), json({ files: [] }));
    expect((await executeGoogleCall(context, { method: "drive.files.list" })).quota.requests).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    google.queue(
      new Response(JSON.stringify({ error: { code: 429, message: "slow down", errors: [{ reason: "rateLimitExceeded" }] } }), { status: 429, headers: { "retry-after": "7" } }),
      new Response(JSON.stringify({ error: { code: 429, message: "slow down", errors: [{ reason: "rateLimitExceeded" }] } }), { status: 429, headers: { "retry-after": "7" } }),
    );
    await expect(executeGoogleCall(context, { method: "drive.files.list" })).rejects.toMatchObject({ code: "rate_limited", details: { retryAfter: 7 } });
  });

  it("never sends a non-idempotent call twice after a timeout or a server error", async () => {
    const { google, context } = setup();
    const fetchImpl = context.fetch!;
    let calls = 0;
    context.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/gmail/v1/users/me/messages/send")) {
        calls += 1;
        if (calls === 1) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }
      return fetchImpl(url, init);
    }) as typeof fetch;
    const raw = Buffer.from("To: a@corp.example\r\nSubject: hi\r\n\r\nbody").toString("base64url");
    await expect(executeGoogleCall(context, { method: "gmail.users.messages.send", params: { userId: "me" }, body: { raw } })).rejects.toMatchObject({
      code: "google_error",
      details: { outcomeUnknown: true },
    });
    expect(calls).toBe(1);
    google.queue(googleError(503, "backendError"));
    await expect(executeGoogleCall(context, { method: "gmail.users.messages.send", params: { userId: "me" }, body: { raw } })).rejects.toMatchObject({
      code: "google_error",
      details: { status: 503, outcomeUnknown: true },
    });
    google.queue(googleError(429, "rateLimitExceeded"), json({ id: "m1" }));
    expect((await executeGoogleCall(context, { method: "gmail.users.messages.send", params: { userId: "me" }, body: { raw } })).quota.requests).toBe(2);
  });

  it("retries a POST that failed before reaching Google", async () => {
    const { context } = setup();
    const fetchImpl = context.fetch!;
    let calls = 0;
    context.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        calls += 1;
        if (calls === 1) throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
      }
      return fetchImpl(url, init);
    }) as typeof fetch;
    const created = await executeGoogleCall(context, { method: "sheets.spreadsheets.create", body: { properties: { title: "Budget" } } });
    expect(created.quota.requests).toBe(2);
  });

  it("rejects dot segments in a reserved path parameter", async () => {
    const { context } = setup();
    await expect(
      executeGoogleCall(context, { method: "chat.spaces.messages.get", params: { name: "spaces/A/../../v1/spaces/B/messages/C" }, dryRun: true }),
    ).rejects.toMatchObject({ code: "validation", details: { pointer: "/params/name" } });
  });

  it("rejects body fields that only exist on the object prototype", async () => {
    const { google, context } = setup();
    const spreadsheetId = await newSpreadsheet(google, context);
    await expect(
      executeGoogleCall(context, { method: "sheets.spreadsheets.values.update", params: { spreadsheetId, range: "A1", valueInputOption: "RAW" }, body: { constructor: {} }, dryRun: true }),
    ).rejects.toMatchObject({ code: "validation", details: { pointer: "/body/constructor" } });
  });

  it("stops reading a download without content-length at the limit", async () => {
    const { google, context } = setup();
    const file = google.addFile("big.bin", "application/octet-stream", Buffer.alloc(64));
    context.limits = { ...context.limits, downloadMaxBytes: 16 };
    const fetchImpl = context.fetch!;
    let pulled = 0;
    context.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).includes("alt=media")) return fetchImpl(url, init);
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          if (pulled > 100) controller.close();
          else controller.enqueue(new Uint8Array(8));
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "application/octet-stream" } });
    }) as typeof fetch;
    await expect(executeGoogleCall(context, { method: "drive.files.get", params: { fileId: file.id }, download: "attachment" })).rejects.toMatchObject({
      code: "validation",
      details: { limit: 16 },
    });
    expect(pulled).toBeLessThan(10);
  });

  it("retries a server error once and reports google_error after that", async () => {
    const { google, context } = setup();
    google.queue(googleError(503, "backendError"), json({ files: [] }));
    expect((await executeGoogleCall(context, { method: "drive.files.list" })).status).toBe(200);
    google.queue(googleError(503, "backendError"), googleError(503, "backendError"));
    await expect(executeGoogleCall(context, { method: "drive.files.list" })).rejects.toMatchObject({ code: "google_error", details: { status: 503, reason: "backendError" } });
    google.queue(googleError(404, "notFound", "File not found: x"));
    await expect(executeGoogleCall(context, { method: "drive.files.get", params: { fileId: "x" } })).rejects.toMatchObject({ code: "google_error", details: { status: 404 } });
  });
});
