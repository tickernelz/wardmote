import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { GOOGLE_WORKSPACE_API_VERSIONS, type GoogleWorkspaceService } from "@tickernelz/wardmote-shared";
import { describe, expect, it, vi } from "vitest";

import {
  buildGoogleServiceIndex,
  classifyGoogleCall,
  createGoogleDiscoveryIndex,
  describeGoogleMethod,
  searchGoogleMethods,
  type DiscoveryDocument,
} from "./discovery.js";
import { GoogleWorkspaceError } from "./errors.js";
import review from "./method-review.json" with { type: "json" };

const SERVICES = Object.keys(GOOGLE_WORKSPACE_API_VERSIONS) as GoogleWorkspaceService[];

function recorded(service: GoogleWorkspaceService): DiscoveryDocument {
  const file = new URL(`./__fixtures__/discovery/${service}_${GOOGLE_WORKSPACE_API_VERSIONS[service]}.json.gz`, import.meta.url);
  return JSON.parse(gunzipSync(readFileSync(file)).toString("utf8")) as DiscoveryDocument;
}

const indexes = new Map(SERVICES.map((service) => [service, buildGoogleServiceIndex(recorded(service), 0)]));
const index = (service: GoogleWorkspaceService) => indexes.get(service)!;
const tokens = (value: unknown) => Math.ceil(JSON.stringify(value).length / 4);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("Google Workspace method review", () => {
  it("classifies every method and batchUpdate request kind in the recorded Discovery documents", () => {
    let methods = 0;
    for (const service of SERVICES) {
      const built = index(service);
      expect(built.unreviewed, service).toEqual({ methods: [], batchRequestKinds: [] });
      expect(built.revision, service).toBe(built.reviewedRevision);
      methods += built.methods.size;
    }
    expect(methods).toBe(350);
  });

  it("has no review entries for methods or request kinds the Discovery documents do not contain", () => {
    for (const service of SERVICES) {
      const built = index(service);
      const reviewed = review.services[service] as { methods: Record<string, string>; batchRequests?: Record<string, Record<string, string>> };
      expect(Object.keys(reviewed.methods).filter((id) => !built.methods.has(id)), service).toEqual([]);
      for (const [methodId, kinds] of Object.entries(reviewed.batchRequests ?? {})) {
        const known = built.methods.get(methodId)?.batchRequestKinds ?? {};
        expect(Object.keys(kinds).filter((kind) => !(kind in known)), methodId).toEqual([]);
      }
    }
  });

  it("never reviews an HTTP DELETE method as anything but destructive", () => {
    const wrong = SERVICES.flatMap((service) => [...index(service).methods.values()])
      .filter((entry) => entry.httpMethod === "DELETE" && entry.class !== "destructive")
      .map((entry) => entry.id);
    expect(wrong).toEqual([]);
  });

  it("keeps the classes the plan depends on", () => {
    const classOf = (id: string) => index(id.split(".")[0] as GoogleWorkspaceService).methods.get(id)?.class;
    expect(classOf("drive.files.list")).toBe("read");
    expect(classOf("sheets.spreadsheets.values.update")).toBe("write");
    expect(classOf("drive.files.delete")).toBe("destructive");
    expect(classOf("drive.files.emptyTrash")).toBe("destructive");
    expect(classOf("drive.permissions.create")).toBe("external");
    expect(classOf("gmail.users.messages.send")).toBe("external");
    expect(classOf("gmail.users.drafts.send")).toBe("external");
    expect(classOf("calendar.acl.insert")).toBe("external");
    expect(classOf("script.scripts.run")).toBe("execute");
    const kinds = index("sheets").methods.get("sheets.spreadsheets.batchUpdate")!.batchRequestKinds!;
    expect(Object.values(kinds).filter((value) => value === "destructive")).toHaveLength(17);
    expect(kinds.deleteSheet).toBe("destructive");
    expect(kinds.repeatCell).toBe("write");
  });
});

describe("classifyGoogleCall", () => {
  it("raises a batchUpdate to destructive when any request deletes", () => {
    const sheets = index("sheets");
    const result = classifyGoogleCall(sheets, "sheets.spreadsheets.batchUpdate", {
      requests: [{ repeatCell: { range: { sheetId: 0 } } }, { deleteSheet: { sheetId: 1 } }],
    });
    expect(result.methodClass).toBe("destructive");
    expect(result.classes).toEqual(["write", "destructive"]);
    expect(result.batchRequestKinds).toEqual([
      { kind: "repeatCell", class: "write" },
      { kind: "deleteSheet", class: "destructive" },
    ]);
    expect(classifyGoogleCall(sheets, "sheets.spreadsheets.batchUpdate", { requests: [{ addSheet: {} }] }).methodClass).toBe("write");
    expect(classifyGoogleCall(index("docs"), "docs.documents.batchUpdate", { requests: [{ deleteContentRange: {} }] }).methodClass).toBe("destructive");
    expect(classifyGoogleCall(index("slides"), "slides.presentations.batchUpdate", { requests: [{ deleteObject: {} }] }).methodClass).toBe("destructive");
    expect(classifyGoogleCall(index("forms"), "forms.forms.batchUpdate", { requests: [{ deleteItem: {} }] }).methodClass).toBe("destructive");
  });

  it("treats unknown or empty batch request kinds as unreviewed", () => {
    const sheets = index("sheets");
    expect(classifyGoogleCall(sheets, "sheets.spreadsheets.batchUpdate", { requests: [{ dropEverything: {} }] }).methodClass).toBe("unreviewed");
    expect(classifyGoogleCall(sheets, "sheets.spreadsheets.batchUpdate", { requests: [{}] }).methodClass).toBe("unreviewed");
  });

  it("classifies moving to trash through update or labels as destructive", () => {
    expect(classifyGoogleCall(index("drive"), "drive.files.update", { trashed: true }).methodClass).toBe("destructive");
    expect(classifyGoogleCall(index("drive"), "drive.files.update", { name: "x" }).methodClass).toBe("write");
    expect(classifyGoogleCall(index("gmail"), "gmail.users.messages.modify", { addLabelIds: ["TRASH"] }).methodClass).toBe("destructive");
  });

  it("classifies cancelling an event or deleting a task through update as destructive", () => {
    for (const id of ["calendar.events.patch", "calendar.events.update"]) {
      expect(classifyGoogleCall(index("calendar"), id, { status: "cancelled" }).methodClass).toBe("destructive");
      expect(classifyGoogleCall(index("calendar"), id, { status: "confirmed" }).methodClass).toBe("write");
    }
    for (const id of ["tasks.tasks.patch", "tasks.tasks.update"]) {
      expect(classifyGoogleCall(index("tasks"), id, { deleted: true }).methodClass).toBe("destructive");
      expect(classifyGoogleCall(index("tasks"), id, { title: "x" }).methodClass).toBe("write");
    }
  });

  it("classifies a Gmail filter that forwards mail as external", () => {
    const gmail = index("gmail");
    expect(classifyGoogleCall(gmail, "gmail.users.settings.filters.create", { action: { forward: "x@evil.example" } }).methodClass).toBe("external");
    expect(classifyGoogleCall(gmail, "gmail.users.settings.filters.create", { action: { addLabelIds: ["L1"] } }).methodClass).toBe("write");
  });

  it("classifies notification channels to an agent-chosen address as external", () => {
    for (const id of ["drive.files.watch", "drive.changes.watch", "calendar.events.watch", "gmail.users.watch", "forms.forms.watches.create"]) {
      expect(classifyGoogleCall(index(id.split(".")[0] as GoogleWorkspaceService), id).methodClass).toBe("external");
    }
  });

  it("never resolves request kinds or body paths through the object prototype", () => {
    const sheets = index("sheets");
    const verdict = classifyGoogleCall(sheets, "sheets.spreadsheets.batchUpdate", { requests: [{ constructor: {} }, { toString: {} }] });
    expect(verdict.methodClass).toBe("unreviewed");
    expect(verdict.classes).toEqual(["write", "unreviewed"]);
    expect(JSON.parse(JSON.stringify(verdict))).toEqual(verdict);
    expect(describeGoogleMethod(sheets, "sheets.spreadsheets.batchUpdate", { path: "requests[].deleteSheet" }).kind).toBe("deleteSheet");
    expect(() => describeGoogleMethod(sheets, "sheets.spreadsheets.batchUpdate", { path: "requests[].constructor" })).toThrow(GoogleWorkspaceError);
  });

  it("marks a method that appears in a newer Discovery revision as unreviewed", () => {
    const doc = recorded("tasks");
    doc.revision = "29990101";
    doc.resources!.tasks.methods!.purgeAll = { id: "tasks.tasks.purgeAll", httpMethod: "POST", path: "tasks/v1/purge" };
    const built = buildGoogleServiceIndex(doc, 0);
    expect(built.unreviewed.methods).toEqual(["tasks.tasks.purgeAll"]);
    expect(built.revision).not.toBe(built.reviewedRevision);
    expect(classifyGoogleCall(built, "tasks.tasks.purgeAll").methodClass).toBe("unreviewed");
  });

  it("rejects a method the service does not have", () => {
    expect(() => classifyGoogleCall(index("drive"), "drive.files.obliterate")).toThrow(GoogleWorkspaceError);
  });
});

describe("searchGoogleMethods", () => {
  const all = SERVICES.map(index);

  it("finds a batchUpdate request kind as its own entry", () => {
    const hits = searchGoogleMethods(all, { query: "delete sheet" });
    expect(hits[0]).toMatchObject({ id: "sheets.spreadsheets.batchUpdate", kind: "deleteSheet", class: "destructive", requiredParameters: ["spreadsheetId"] });
    expect(hits.length).toBeLessThanOrEqual(8);
  });

  it("finds plain methods with their required parameters", () => {
    expect(searchGoogleMethods(all, { query: "share file permission" })[0]).toMatchObject({ id: "drive.permissions.create", class: "external", requiredParameters: ["fileId"] });
    expect(searchGoogleMethods(all, { query: "send email message" }).map((hit) => hit.id)).toContain("gmail.users.messages.send");
  });

  it("filters by class and caps the result at eight", () => {
    const hits = searchGoogleMethods(all, { query: "delete", class: "destructive", limit: 50 });
    expect(hits).toHaveLength(8);
    expect(hits.every((hit) => hit.class === "destructive")).toBe(true);
  });

  it("rejects an empty query", () => {
    expect(() => searchGoogleMethods(all, { query: "  " })).toThrow(expect.objectContaining({ code: "validation" }));
  });
});

describe("describeGoogleMethod", () => {
  const sheets = index("sheets");

  it("cuts a batchUpdate down to one request kind", () => {
    const description = describeGoogleMethod(sheets, "sheets.spreadsheets.batchUpdate", { path: "requests[].deleteSheet" });
    expect(description).toMatchObject({
      kind: "deleteSheet",
      class: "destructive",
      httpMethod: "POST",
      url: "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}:batchUpdate",
      example: { method: "sheets.spreadsheets.batchUpdate", params: { spreadsheetId: "<string>" }, body: { requests: [{ deleteSheet: {} }] } },
    });
    expect(description.request).toMatchObject({ properties: { sheetId: { type: "integer" } } });
    expect(tokens(description.request)).toBeLessThan(80);
  });

  it("lists request kinds instead of expanding the whole batchUpdate body", () => {
    const description = describeGoogleMethod(sheets, "sheets.spreadsheets.batchUpdate");
    expect(description.batchRequestKinds).toHaveLength(74);
    expect(tokens(description)).toBeLessThan(2500);
  });

  it("bounds a deep request kind by depth", () => {
    const shallow = describeGoogleMethod(sheets, "sheets.spreadsheets.batchUpdate", { path: "requests[].repeatCell" });
    const deeper = describeGoogleMethod(sheets, "sheets.spreadsheets.batchUpdate", { path: "requests[].repeatCell", depth: 3 });
    expect(tokens(shallow.request)).toBeLessThan(tokens(deeper.request));
    expect(tokens(shallow.request)).toBeLessThan(2000);
  });

  it("exposes upload and download support", () => {
    const create = describeGoogleMethod(index("drive"), "drive.files.create");
    expect(create.upload).toMatchObject({ simplePath: "/upload/drive/v3/files", resumablePath: "/resumable/upload/drive/v3/files" });
    expect(create.upload?.maxBytes).toBeGreaterThan(0);
    expect(describeGoogleMethod(index("drive"), "drive.files.get").download).toBe(true);
  });

  it("rejects a path the request body does not have", () => {
    expect(() => describeGoogleMethod(sheets, "sheets.spreadsheets.batchUpdate", { path: "requests[].nope" })).toThrow(
      expect.objectContaining({ code: "validation", details: { pointer: "/path" } }),
    );
  });
});

describe("createGoogleDiscoveryIndex", () => {
  it("fetches a Discovery document once per day and records the new revision", async () => {
    let clock = 1_000;
    const doc = recorded("tasks");
    const fetchMock = vi.fn(async () => jsonResponse(doc));
    const discovery = createGoogleDiscoveryIndex({ fetch: fetchMock as typeof fetch, now: () => clock });
    const [first, second] = await Promise.all([discovery.service("tasks"), discovery.service("tasks")]);
    expect(first).toBe(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toEqual(["https://www.googleapis.com/discovery/v1/apis/tasks/v1/rest", expect.anything()]);
    clock += 23 * 60 * 60 * 1000;
    await discovery.service("tasks");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clock += 2 * 60 * 60 * 1000;
    doc.revision = "29990101";
    const refreshed = await discovery.service("tasks");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshed.revision).toBe("29990101");
    expect(refreshed.fetchedAt).toBe(clock);
  });

  it("falls back to the service-hosted Discovery URL", async () => {
    const fetchMock = vi.fn(async (url: string) => (url.includes("www.googleapis.com") ? jsonResponse({}, 404) : jsonResponse(recorded("forms"))));
    const discovery = createGoogleDiscoveryIndex({ fetch: fetchMock as unknown as typeof fetch });
    expect((await discovery.service("forms")).methods.size).toBe(10);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://forms.googleapis.com/$discovery/rest?version=v1");
  });

  it("keeps serving the cached index when a refresh fails", async () => {
    let clock = 0;
    let fail = false;
    const fetchMock = vi.fn(async () => {
      if (fail) throw new Error("network down");
      return jsonResponse(recorded("tasks"));
    });
    const discovery = createGoogleDiscoveryIndex({ fetch: fetchMock as typeof fetch, now: () => clock });
    const first = await discovery.service("tasks");
    fail = true;
    clock += 25 * 60 * 60 * 1000;
    expect(await discovery.service("tasks")).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("reports a typed error when no Discovery document can be loaded", async () => {
    const discovery = createGoogleDiscoveryIndex({ fetch: (async () => jsonResponse({}, 503)) as typeof fetch });
    await expect(discovery.service("drive")).rejects.toMatchObject({ code: "google_error", details: { reason: "discovery_unavailable" } });
  });

  it("searches the services that loaded when another one is unavailable", async () => {
    const fetchMock = vi.fn(async (url: string) => (url.includes("/sheets/") ? jsonResponse(recorded("sheets")) : jsonResponse({}, 503)));
    const discovery = createGoogleDiscoveryIndex({ fetch: fetchMock as unknown as typeof fetch });
    const result = await discovery.search({ query: "append values" });
    expect(result.methods[0]?.id).toBe("sheets.spreadsheets.values.append");
    expect(result.unavailableServices).toContain("drive");
    expect(result.unavailableServices).not.toContain("sheets");
  });

  it("rejects a document for another service", async () => {
    const discovery = createGoogleDiscoveryIndex({ fetch: (async () => jsonResponse(recorded("tasks"))) as typeof fetch });
    await expect(discovery.service("drive")).rejects.toMatchObject({ code: "google_error" });
  });

  it("routes describe and classify by the method's service", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(recorded("sheets")));
    const discovery = createGoogleDiscoveryIndex({ fetch: fetchMock as typeof fetch });
    const verdict = await discovery.classify("sheets.spreadsheets.batchUpdate", { requests: [{ deleteSheet: { sheetId: 1 } }] });
    expect(verdict.methodClass).toBe("destructive");
    expect((await discovery.search({ query: "append values", service: "sheets" })).methods[0]?.id).toBe("sheets.spreadsheets.values.append");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(discovery.describe("keep.notes.list")).rejects.toMatchObject({ code: "validation" });
  });
});
