import { normalizeGoogleWorkspaceSettings } from "@tickernelz/wardmote-shared";
import { describe, expect, it } from "vitest";

import { createFakeGoogle, json } from "../../__tests__/helpers/fake-google.js";
import { testGoogleWorkspaceConnection } from "./connection-test.js";
import { createGoogleDiscoveryIndex } from "./discovery.js";
import type { GoogleWorkspaceToolRuntime } from "./runtime.js";

function runtimeFor(capabilities: Record<string, string>) {
  const google = createFakeGoogle();
  const runtime: GoogleWorkspaceToolRuntime = {
    discovery: createGoogleDiscoveryIndex({ fetch: google.fetch }),
    settings: normalizeGoogleWorkspaceSettings({ capabilities, domain: "example.com" }),
    grantedScopes: [],
    credentials: { headers: async () => ({ authorization: `Bearer ${google.token}` }) },
    attachments: {
      read: async () => ({ bytes: new Uint8Array(), contentType: "text/plain", filename: "x" }),
      head: async () => new Uint8Array(),
      store: async () => ({ attachmentId: "a", byteSize: 0, contentType: "", filename: "" }),
    },
    fetch: google.fetch,
    sleep: async () => undefined,
  };
  return { google, runtime };
}

describe("testGoogleWorkspaceConnection", () => {
  it("probes every active service with one cheap read and reports the write policy", async () => {
    const { google, runtime } = runtimeFor({ drive: "delete_share", sheets: "edit", calendar: "read", gmail: "create", tasks: "read", chat: "read", people: "read", docs: "read", slides: "read", forms: "read", meet: "read", script: "read" });
    const result = await testGoogleWorkspaceConnection(runtime);
    expect(result.ok).toBe(true);
    expect(result.services.map((entry) => entry.service)).toEqual(["drive", "sheets", "docs", "slides", "calendar", "gmail", "forms", "tasks", "chat", "meet", "people", "script"]);
    expect(google.requests.every((request) => request.method === "GET")).toBe(true);
    expect(google.requests).toHaveLength(12);
    expect(result.services.find((entry) => entry.service === "sheets")?.write).toEqual({ method: "sheets.spreadsheets.values.update", action: "allow", reason: null });
    expect(result.services.find((entry) => entry.service === "calendar")?.write).toBeNull();
  });

  it("skips services that are off", async () => {
    const { google, runtime } = runtimeFor({ tasks: "read" });
    const result = await testGoogleWorkspaceConnection(runtime);
    expect(result.services.map((entry) => entry.service)).toEqual(["tasks"]);
    expect(google.requests.map((request) => new URL(request.url).pathname)).toEqual(["/tasks/v1/users/@me/lists"]);
  });

  it("reports a disabled API with Google's activation link and keeps testing the others", async () => {
    const { google, runtime } = runtimeFor({ sheets: "read", tasks: "read" });
    google.override(/sheets\.googleapis\.com/, () =>
      json({
        error: {
          code: 403,
          message: "Google Sheets API has not been used in project 1 before or it is disabled.",
          status: "PERMISSION_DENIED",
          details: [{ reason: "SERVICE_DISABLED", metadata: { activationUrl: "https://console.developers.google.com/apis/api/sheets.googleapis.com/overview?project=1" } }],
        },
      }, 403),
    );
    const result = await testGoogleWorkspaceConnection(runtime);
    expect(result.ok).toBe(false);
    expect(result.services[0]).toMatchObject({
      service: "sheets",
      ok: false,
      code: "api_not_enabled",
      enableUrl: "https://console.developers.google.com/apis/api/sheets.googleapis.com/overview?project=1",
    });
    expect(result.services[1]).toMatchObject({ service: "tasks", ok: true });
  });

  it("checks Contacts and Meet without the profile scope or a test ID", async () => {
    const { google, runtime } = runtimeFor({ meet: "read", people: "read" });
    google.override(/people\.googleapis\.com\/v1\/people\/me\?/, () =>
      json({ error: { code: 403, message: "The caller does not have permission to request people/me. Requires one of the following scopes: [profile].", status: "PERMISSION_DENIED" } }, 403),
    );
    google.override(/meet\.googleapis\.com\/v2\/spaces\//, () => json({ error: { code: 400, message: "Request contains an invalid argument.", status: "INVALID_ARGUMENT" } }, 400));
    const result = await testGoogleWorkspaceConnection(runtime);
    expect(result.services).toMatchObject([{ service: "meet", ok: true }, { service: "people", ok: true }]);
  });

  const invalidArgument = () => json({ error: { code: 400, message: "Request contains an invalid argument.", status: "INVALID_ARGUMENT" } }, 400);

  it.each([
    ["400 INVALID_ARGUMENT for the test ID", invalidArgument, { ok: true, code: null, enableUrl: null }],
    ["403 PERMISSION_DENIED", () => json({ error: { code: 403, message: "The caller does not have permission", status: "PERMISSION_DENIED" } }, 403), { ok: false, code: "google_error" }],
    ["401", () => json({ error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } }, 401), { ok: false, code: "auth_expired" }],
    [
      "a disabled API",
      () => json({
        error: {
          code: 403,
          message: "Apps Script API has not been used in project 1 before or it is disabled.",
          status: "PERMISSION_DENIED",
          details: [{ reason: "SERVICE_DISABLED", metadata: { activationUrl: "https://console.developers.google.com/apis/api/script.googleapis.com/overview?project=1" } }],
        },
      }, 403),
      { ok: false, code: "api_not_enabled", enableUrl: "https://console.developers.google.com/apis/api/script.googleapis.com/overview?project=1" },
    ],
  ])("judges Apps Script answering %s", async (_label, respond, expected) => {
    const { google, runtime } = runtimeFor({ script: "read" });
    google.override(/script\.googleapis\.com/, respond);
    const result = await testGoogleWorkspaceConnection(runtime);
    expect(result.services[0]).toMatchObject({ service: "script", method: "script.projects.get", ...expected });
    expect(result.ok).toBe(expected.ok);
  });

  it("fails a 400 INVALID_ARGUMENT from a service whose test ID Google accepts as well formed", async () => {
    const { google, runtime } = runtimeFor({ sheets: "read" });
    google.override(/sheets\.googleapis\.com/, invalidArgument);
    const result = await testGoogleWorkspaceConnection(runtime);
    expect(result.services[0]).toMatchObject({ service: "sheets", ok: false, code: "google_error" });
  });

  it("fails a probe whose 404 means the account is missing, not the test item", async () => {
    const { google, runtime } = runtimeFor({ gmail: "read" });
    google.override(/gmail\.googleapis\.com/, () => json({ error: { code: 404, message: "not found", errors: [{ reason: "notFound" }] } }, 404));
    const result = await testGoogleWorkspaceConnection(runtime);
    expect(result.services[0]).toMatchObject({ service: "gmail", ok: false, code: "google_error" });
  });
});
