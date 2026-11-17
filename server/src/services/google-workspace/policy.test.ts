import { normalizeGoogleWorkspaceSettings, type GoogleWorkspaceSettings } from "@tickernelz/wardmote-shared";
import { describe, expect, it, vi } from "vitest";

import { createFakeGoogle } from "../../__tests__/helpers/fake-google.js";
import { createGoogleDiscoveryIndex } from "./discovery.js";
import { executeGoogleCall, planGoogleCall, type GoogleCallInput } from "./executor.js";
import { decideGoogleCall, googlePolicyVerdict, type GoogleFileLocation, type GooglePolicyDependencies } from "./policy.js";

const ALL = "delete_share";
const google = createFakeGoogle();
const discovery = createGoogleDiscoveryIndex({ fetch: google.fetch });

function settings(overrides: Record<string, unknown> = {}): GoogleWorkspaceSettings {
  return normalizeGoogleWorkspaceSettings({
    capabilities: { drive: ALL, sheets: ALL, docs: ALL, slides: ALL, gmail: ALL, calendar: ALL, script: ALL, forms: ALL, tasks: ALL },
    domain: "example.com",
    ...overrides,
  });
}

function deps(locations: Record<string, GoogleFileLocation> = {}, grantedScopes: string[] = []): GooglePolicyDependencies & { locate: ReturnType<typeof vi.fn> } {
  return { grantedScopes, locate: vi.fn(async (fileId: string) => locations[fileId] ?? null) };
}

async function decide(input: GoogleCallInput, config = settings(), dependencies = deps()) {
  const { plan } = await planGoogleCall(discovery, input);
  return decideGoogleCall(plan, config, dependencies);
}

const raw = (headers: string) => Buffer.from(`${headers}\r\nSubject: hi\r\n\r\nbody`).toString("base64url");
const deleteSheet = { method: "sheets.spreadsheets.batchUpdate", params: { spreadsheetId: "s1" }, body: { requests: [{ repeatCell: { fields: "userEnteredFormat" } }, { deleteSheet: { sheetId: 0 } }] } };
const shareOutside = { method: "drive.permissions.create", params: { fileId: "f1" }, body: { type: "user", role: "writer", emailAddress: "guest@other.org" } };

describe("default policy (write runs, delete/share/send need approval)", () => {
  it("lets writes run", async () => {
    const decision = await decide({ method: "sheets.spreadsheets.values.update", params: { spreadsheetId: "s1", range: "A1", valueInputOption: "RAW" }, body: { values: [[1]] } });
    expect(decision).toMatchObject({ action: "allow", classes: ["write"], error: null });
  });

  it("asks for approval when a batchUpdate contains deleteSheet", async () => {
    const decision = await decide(deleteSheet);
    expect(decision.action).toBe("require_approval");
    expect(decision.classes).toEqual(["write", "destructive"]);
    expect(decision.error?.code).toBe("approval_required");
    expect(decision.reasons).toContain("sheets.spreadsheets.batchUpdate#deleteSheet is destructive: require_approval");
  });

  it("asks for approval when sharing outside the domain or with anyone, but not inside it", async () => {
    const outside = await decide(shareOutside);
    expect(outside).toMatchObject({ action: "require_approval", externalRecipients: ["guest@other.org"] });
    const anyone = await decide({ ...shareOutside, body: { type: "anyone", role: "reader" } });
    expect(anyone.action).toBe("require_approval");
    const domainWide = await decide({ ...shareOutside, body: { type: "domain", role: "reader", domain: "other.org" } });
    expect(domainWide.action).toBe("require_approval");
    const inside = await decide({ ...shareOutside, body: { type: "user", role: "writer", emailAddress: "Colleague@Example.com" } });
    expect(inside).toMatchObject({ action: "allow", classes: ["write"] });
    const calendarInside = await decide({ method: "calendar.acl.insert", params: { calendarId: "primary" }, body: { role: "reader", scope: { type: "user", value: "a@example.com" } } });
    expect(calendarInside.action).toBe("allow");
  });

  it("always asks before sending mail and lists recipients outside the domain", async () => {
    const decision = await decide({ method: "gmail.users.messages.send", params: { userId: "me" }, body: { raw: raw("To: a@example.com, Guest <g@other.org>\r\nCc: c@third.net") } });
    expect(decision).toMatchObject({ action: "require_approval", externalRecipients: ["g@other.org", "c@third.net"] });
    const internal = await decide({ method: "gmail.users.messages.send", params: { userId: "me" }, body: { raw: raw("To: a@example.com") } });
    expect(internal).toMatchObject({ action: "require_approval", externalRecipients: [] });
  });

  it("blocks emptying the trash and running Apps Script", async () => {
    expect(await decide({ method: "drive.files.emptyTrash" })).toMatchObject({ action: "block", error: { code: "capability_off" } });
    expect(await decide({ method: "script.scripts.run", params: { scriptId: "x" }, body: { function: "main" } })).toMatchObject({ action: "block" });
  });

  it("moves Drive delete to trash and still asks for approval", async () => {
    expect(await decide({ method: "drive.files.delete", params: { fileId: "f1" } })).toMatchObject({ action: "require_approval", classes: ["destructive"] });
  });
});

describe("per-connection overrides", () => {
  it("lets the owner allow a class or one request kind", async () => {
    expect((await decide(shareOutside, settings({ classPolicy: { external: "allow" } }))).action).toBe("allow");
    expect((await decide(deleteSheet, settings({ methodOverrides: { "sheets.spreadsheets.batchUpdate#deleteSheet": "allow" } }))).action).toBe("allow");
  });

  it("does not let a method-level allow bypass a destructive request kind", async () => {
    expect((await decide(deleteSheet, settings({ methodOverrides: { "sheets.spreadsheets.batchUpdate": "allow" } }))).action).toBe("require_approval");
  });

  it("lets the owner block a read method", async () => {
    expect((await decide({ method: "drive.files.list" }, settings({ methodOverrides: { "drive.files.list": "block" } }))).action).toBe("block");
  });
});

describe("capability tiers and Google scopes", () => {
  it("blocks a call above the service tier", async () => {
    const readOnly = settings({ capabilities: { sheets: "read" } });
    expect(await decide({ method: "sheets.spreadsheets.values.update", params: { spreadsheetId: "s", range: "A1", valueInputOption: "RAW" }, body: { values: [] } }, readOnly)).toMatchObject({
      action: "block",
      error: { code: "capability_off", details: { service: "sheets", tier: "read", required: "edit" } },
    });
    const edit = settings({ capabilities: { drive: "edit" } });
    expect((await decide({ method: "drive.files.create", body: { name: "x" }, upload: { attachmentId: "a" } }, edit)).error?.details).toMatchObject({ required: "create" });
    const create = settings({ capabilities: { drive: "create" } });
    expect((await decide({ method: "drive.files.delete", params: { fileId: "f" } }, create)).error?.details).toMatchObject({ required: "delete_share" });
    expect((await decide({ method: "tasks.tasklists.list" }, settings({ capabilities: {} }))).error?.code).toBe("capability_off");
  });

  it("blocks a call the Google grant has no scope for", async () => {
    const decision = await decide(
      { method: "sheets.spreadsheets.values.update", params: { spreadsheetId: "s", range: "A1", valueInputOption: "RAW" }, body: { values: [] } },
      settings(),
      deps({}, ["https://www.googleapis.com/auth/spreadsheets.readonly"]),
    );
    expect(decision).toMatchObject({ action: "block", error: { code: "scope_missing" } });
  });
});

describe("folder and file scope", () => {
  const limited = settings({ scope: { driveFolderIds: ["F1"], spreadsheetIds: ["S9"] } });
  const tree = { A: { parents: ["F2"], driveId: null }, F2: { parents: ["F1"], driveId: null }, B: { parents: ["root"], driveId: null }, root: { parents: [], driveId: null } };

  it("allows files below an allowed folder and listed spreadsheets", async () => {
    const dependencies = deps(tree);
    expect((await decide({ method: "drive.files.get", params: { fileId: "A" } }, limited, dependencies)).action).toBe("allow");
    expect(dependencies.locate.mock.calls.map(([id]) => id)).toEqual(["A", "F2"]);
    expect((await decide({ method: "sheets.spreadsheets.get", params: { spreadsheetId: "S9" } }, limited, deps(tree))).action).toBe("allow");
  });

  it("rejects files, new parents and uploads outside the scope", async () => {
    expect(await decide({ method: "drive.files.get", params: { fileId: "B" } }, limited, deps(tree))).toMatchObject({ action: "block", error: { code: "out_of_scope" } });
    expect((await decide({ method: "drive.files.update", params: { fileId: "A", addParents: "B" } }, limited, deps(tree))).error?.code).toBe("out_of_scope");
    expect((await decide({ method: "drive.files.create", body: { name: "x" } }, limited, deps(tree))).error?.code).toBe("out_of_scope");
    expect((await decide({ method: "drive.files.create", body: { name: "x", parents: ["F2"] } }, limited, deps(tree))).action).toBe("allow");
    expect((await decide({ method: "sheets.spreadsheets.create", body: {} }, limited, deps(tree))).error?.code).toBe("out_of_scope");
  });

  it("requires a folder clause when listing files", async () => {
    expect((await decide({ method: "drive.files.list" }, limited, deps(tree))).error?.code).toBe("out_of_scope");
    expect((await decide({ method: "drive.files.list", params: { q: "'F1' in parents and trashed = false" } }, limited, deps(tree))).action).toBe("allow");
  });

  it("does not apply Drive scope to Gmail or Calendar", async () => {
    expect((await decide({ method: "gmail.users.messages.list", params: { userId: "me" } }, limited, deps(tree))).action).toBe("allow");
  });
});

describe("policy enforced by executeGoogleCall (negative tests)", () => {
  async function run(input: (fileId: string) => GoogleCallInput, approved: boolean) {
    const fake = createFakeGoogle();
    const config = settings();
    const file = fake.addFile("shared.txt");
    const created = await executeGoogleCall(
      {
        discovery: createGoogleDiscoveryIndex({ fetch: fake.fetch }),
        credentials: { headers: async () => ({ authorization: `Bearer ${fake.token}` }) },
        attachments: { read: async () => ({ bytes: new Uint8Array(), contentType: "text/plain", filename: "x" }), store: async () => ({ attachmentId: "a", byteSize: 0, contentType: "", filename: "" }) },
        policy: async (plan) => googlePolicyVerdict(await decideGoogleCall(plan, config, deps()), { approved }),
        fetch: fake.fetch,
        sleep: async () => undefined,
      },
      input(file.id),
    ).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    return { created, fake, file };
  }

  it("refuses sharing outside the domain without approval and runs it once approved", async () => {
    const share = (fileId: string) => ({ ...shareOutside, params: { fileId } });
    const denied = await run(share, false);
    expect(denied.created).toMatchObject({ ok: false, error: { code: "approval_required" } });
    expect(denied.fake.requests).toEqual([]);
    expect(denied.fake.files.get(denied.file.id)?.permissions).toHaveLength(1);
    const approved = await run(share, true);
    expect(approved.created.ok).toBe(true);
    expect(approved.fake.files.get(approved.file.id)?.permissions.at(-1)).toMatchObject({ emailAddress: "guest@other.org" });
  });

  it("keeps a blocked call blocked even with approval", async () => {
    const blocked = await run(() => ({ method: "drive.files.emptyTrash" }), true);
    expect(blocked.created).toMatchObject({ ok: false, error: { code: "capability_off" } });
    expect(blocked.fake.requests).toEqual([]);
  });
});
