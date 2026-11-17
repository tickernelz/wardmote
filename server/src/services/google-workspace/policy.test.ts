import { normalizeGoogleWorkspaceSettings, type GoogleWorkspaceSettings } from "@tickernelz/wardmote-shared";
import { describe, expect, it, vi } from "vitest";

import { createFakeGoogle } from "../../__tests__/helpers/fake-google.js";
import { createGoogleDiscoveryIndex } from "./discovery.js";
import { executeGoogleCall, planGoogleCall, type GoogleCallInput } from "./executor.js";
import {
  createGoogleLocationCache,
  decideGoogleCall,
  googlePolicyVerdict,
  type GoogleFileLocation,
  type GoogleMailSource,
  type GooglePolicyDependencies,
} from "./policy.js";

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

function deps(
  locations: Record<string, GoogleFileLocation> = {},
  grantedScopes: string[] = [],
  mail: Record<string, string> = {},
): GooglePolicyDependencies & { locate: ReturnType<typeof vi.fn> } {
  return {
    grantedScopes,
    locate: vi.fn(async (fileId: string) => locations[fileId] ?? null),
    mailHeaders: async (source: GoogleMailSource) => mail["draftId" in source ? source.draftId : source.attachmentId] ?? null,
  };
}

async function decide(input: GoogleCallInput, config = settings(), dependencies: GooglePolicyDependencies = deps()) {
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
    expect(internal).toMatchObject({ action: "require_approval", externalRecipients: [], recipientsUnknown: false });
  });

  it("reads the recipients of a sent draft or an uploaded message, and says when it cannot", async () => {
    const mail = { d1: "To: a@example.com\r\nCc: g@other.org", m1: "To: x@third.net\r\nSubject: s\r\n\r\nbody" };
    const draft = await decide({ method: "gmail.users.drafts.send", params: { userId: "me" }, body: { id: "d1" } }, settings(), deps({}, [], mail));
    expect(draft).toMatchObject({ action: "require_approval", externalRecipients: ["g@other.org"], recipientsUnknown: false });
    const upload = await decide({ method: "gmail.users.messages.send", params: { userId: "me" }, upload: { attachmentId: "m1" } }, settings(), deps({}, [], mail));
    expect(upload).toMatchObject({ action: "require_approval", externalRecipients: ["x@third.net"], recipientsUnknown: false });
    const both = await decide({ method: "gmail.users.drafts.send", params: { userId: "me" }, body: { id: "d1", message: { raw: raw("To: a@example.com") } } }, settings(), deps({}, [], mail));
    expect(both).toMatchObject({ action: "require_approval", externalRecipients: ["g@other.org"], recipientsUnknown: false });
    const unknown = await decide({ method: "gmail.users.drafts.send", params: { userId: "me" }, body: { id: "gone" } }, settings(), deps({}, [], mail));
    expect(unknown).toMatchObject({ action: "require_approval", externalRecipients: [], recipientsUnknown: true, error: { details: { recipientsUnknown: true } } });
    expect(unknown.reasons).toContain("the recipients could not be read");
  });

  it("does not read a draft from Gmail when Gmail is off or the grant lacks the scope", async () => {
    const mailHeaders = vi.fn(async () => "To: a@example.com");
    const dependencies = { ...deps(), mailHeaders };
    const off = await decide({ method: "gmail.users.drafts.send", params: { userId: "me" }, body: { id: "d1" } }, settings({ capabilities: { gmail: "off" } }), dependencies);
    expect(off).toMatchObject({ action: "block", error: { code: "capability_off" } });
    const noScope = await decide({ method: "gmail.users.drafts.send", params: { userId: "me" }, body: { id: "d1" } }, settings(), { ...dependencies, grantedScopes: ["https://www.googleapis.com/auth/drive"] });
    expect(noScope).toMatchObject({ action: "block", error: { code: "scope_missing" } });
    expect(mailHeaders).not.toHaveBeenCalled();
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

  it("limits a file listing to allowed folders by rewriting q on the server", async () => {
    const q = (decision: { query: [string, string][] | null }) => decision.query?.find(([name]) => name === "q")?.[1];
    const bare = await decide({ method: "drive.files.list" }, limited, deps(tree));
    expect(bare.action).toBe("allow");
    expect(q(bare)).toBe("('F1' in parents)");
    const bypass = await decide({ method: "drive.files.list", params: { q: "'F1' in parents or trashed = false" } }, limited, deps(tree));
    expect(q(bypass)).toBe("('F1' in parents) and ('F1' in parents or trashed = false)");
    const nested = await decide({ method: "drive.files.list", params: { q: "'F2' in parents" } }, limited, deps(tree));
    expect(q(nested)).toBe("('F2' in parents) and ('F2' in parents)");
    expect((await decide({ method: "drive.files.list", params: { q: "'B' in parents" } }, limited, deps(tree))).error?.code).toBe("out_of_scope");
    for (const escape of ["trashed = false) or (name contains 'a'", "name = \"x\"", "name contains 'a"]) {
      expect((await decide({ method: "drive.files.list", params: { q: escape } }, limited, deps(tree))).error?.code).toBe("out_of_scope");
    }
    const unscoped = await decide({ method: "drive.files.list", params: { q: "trashed = false" } }, settings(), deps(tree));
    expect(unscoped).toMatchObject({ action: "allow", query: null });
  });

  it("sends the rewritten q to Google", async () => {
    const fake = createFakeGoogle();
    const result = await executeGoogleCall(
      {
        discovery: createGoogleDiscoveryIndex({ fetch: fake.fetch }),
        credentials: { headers: async () => ({ authorization: `Bearer ${fake.token}` }) },
        attachments: { read: async () => ({ bytes: new Uint8Array(), contentType: "text/plain", filename: "x" }), head: async () => new Uint8Array(), store: async () => ({ attachmentId: "a", byteSize: 0, contentType: "", filename: "" }) },
        policy: async (plan) => googlePolicyVerdict(await decideGoogleCall(plan, limited, deps(tree)), { approved: false }),
        fetch: fake.fetch,
        sleep: async () => undefined,
      },
      { method: "drive.files.list", params: { q: "'F1' in parents or trashed = false" }, dryRun: true },
    );
    expect(result.plan?.query).toEqual([["q", "('F1' in parents) and ('F1' in parents or trashed = false)"]]);
    expect(new URL(result.source.url).searchParams.get("q")).toBe("('F1' in parents) and ('F1' in parents or trashed = false)");
  });

  it("blocks reads without a file target unless they reveal nothing outside the scope", async () => {
    const shared = settings({ scope: { driveFolderIds: ["F1"], sharedDriveIds: ["D1"] } });
    for (const method of ["drive.changes.list", "drive.drives.list"]) {
      expect((await decide({ method, params: method === "drive.changes.list" ? { pageToken: "1" } : {} }, shared, deps(tree))).error?.code).toBe("out_of_scope");
    }
    expect((await decide({ method: "drive.about.get", fields: "user" }, shared, deps(tree))).action).toBe("allow");
    expect((await decide({ method: "drive.changes.list", params: { pageToken: "1", driveId: "D1" } }, shared, deps(tree))).action).toBe("allow");
    expect((await decide({ method: "drive.drives.get", params: { driveId: "D1" } }, shared, deps(tree))).action).toBe("allow");
    expect((await decide({ method: "drive.drives.get", params: { driveId: "D2" } }, shared, deps(tree))).error?.code).toBe("out_of_scope");
  });

  it("caches file locations across calls and forgets a moved file", async () => {
    const chain: Record<string, GoogleFileLocation> = { L6: { parents: ["L5"], driveId: null } };
    for (let level = 5; level > 1; level -= 1) chain[`L${level}`] = { parents: [`L${level - 1}`], driveId: null };
    chain.L1 = { parents: ["F1"], driveId: null };
    const raw = deps(chain);
    let clock = 0;
    const cache = createGoogleLocationCache(raw.locate, { ttlMs: 1000, now: () => clock });
    const cached = { ...raw, locate: cache.locate };
    expect((await decide({ method: "drive.files.get", params: { fileId: "L6" } }, limited, cached)).action).toBe("allow");
    expect(raw.locate).toHaveBeenCalledTimes(6);
    expect((await decide({ method: "drive.files.get", params: { fileId: "L6" } }, limited, cached)).action).toBe("allow");
    expect(raw.locate).toHaveBeenCalledTimes(6);
    const move = await planGoogleCall(discovery, { method: "drive.files.update", params: { fileId: "L6", removeParents: "L5" } });
    cache.forget(move.plan);
    chain.L6 = { parents: ["root"], driveId: null };
    expect((await decide({ method: "drive.files.get", params: { fileId: "L6" } }, limited, cached)).error?.code).toBe("out_of_scope");
    clock = 2000;
    await decide({ method: "drive.files.get", params: { fileId: "L5" } }, limited, cached);
    expect(raw.locate.mock.calls.filter(([id]) => id === "L5").length).toBe(2);
  });

  it("ends on a parent cycle", async () => {
    const cycle = { C1: { parents: ["C2"], driveId: null }, C2: { parents: ["C1"], driveId: null } };
    const decision = await Promise.race([
      decide({ method: "drive.files.get", params: { fileId: "C1" } }, limited, deps(cycle)),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 2000)),
    ]);
    expect(decision).toMatchObject({ action: "block", error: { code: "out_of_scope" } });
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
        attachments: { read: async () => ({ bytes: new Uint8Array(), contentType: "text/plain", filename: "x" }), head: async () => new Uint8Array(), store: async () => ({ attachmentId: "a", byteSize: 0, contentType: "", filename: "" }) },
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
