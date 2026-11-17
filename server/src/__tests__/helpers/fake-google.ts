import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import { GOOGLE_WORKSPACE_SERVICES, type GoogleWorkspaceService } from "../../services/google-workspace/discovery.js";

export interface FakeGoogleRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: Buffer;
}

type Handler = (request: FakeGoogleRequest, match: RegExpExecArray) => Response | Promise<Response>;

export function recordedDiscovery(service: GoogleWorkspaceService): Record<string, unknown> {
  const file = new URL(`../../services/google-workspace/__fixtures__/discovery/${service}_${GOOGLE_WORKSPACE_SERVICES[service]}.json.gz`, import.meta.url);
  return JSON.parse(gunzipSync(readFileSync(file)).toString("utf8")) as Record<string, unknown>;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function googleError(status: number, reason: string, message = reason, extra: Record<string, unknown> = {}): Response {
  return json({ error: { code: status, message, errors: [{ reason, message }], ...extra } }, status);
}

interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  trashed: boolean;
  content: Buffer;
  permissions: { id: string; type: string; role: string; emailAddress?: string }[];
}

interface FakeSheet {
  sheetId: number;
  title: string;
}

interface FakeSpreadsheet {
  spreadsheetId: string;
  title: string;
  sheets: FakeSheet[];
  values: Record<string, unknown[][]>;
  formats: unknown[];
}

function multipartParts(request: FakeGoogleRequest): { metadata: Record<string, unknown>; media: Buffer; mediaType: string } {
  const boundary = /boundary=(.+)$/.exec(request.headers.get("content-type") ?? "")?.[1] ?? "";
  const text = request.body.toString("latin1");
  const parts = text.split(`--${boundary}`).slice(1, -1);
  const parse = (part: string) => {
    const split = part.indexOf("\r\n\r\n");
    return { headers: part.slice(0, split), body: part.slice(split + 4, part.length - 2) };
  };
  const metadata = parse(parts[0]);
  const media = parse(parts[1]);
  return {
    metadata: JSON.parse(metadata.body) as Record<string, unknown>,
    media: Buffer.from(media.body, "latin1"),
    mediaType: /content-type: ([^\r\n]+)/i.exec(media.headers)?.[1] ?? "application/octet-stream",
  };
}

export function createFakeGoogle(options: { pageSize?: number } = {}) {
  let token = "token-1";
  let sequence = 0;
  const nextId = (prefix: string) => `${prefix}${++sequence}`;
  const files = new Map<string, FakeFile>();
  const spreadsheets = new Map<string, FakeSpreadsheet>();
  const requests: { method: string; url: string }[] = [];
  const queued: Response[] = [];
  const resumable = new Map<string, Record<string, unknown>>();
  const pageSize = options.pageSize ?? 2;

  const createFile = (metadata: Record<string, unknown>, content: Buffer, mimeType: string): FakeFile => {
    const file: FakeFile = {
      id: nextId("file-"),
      name: String(metadata.name ?? "untitled"),
      mimeType: String(metadata.mimeType ?? mimeType),
      parents: Array.isArray(metadata.parents) ? (metadata.parents as string[]) : ["root"],
      trashed: false,
      content,
      permissions: [{ id: "owner", type: "user", role: "owner", emailAddress: "owner@example.com" }],
    };
    files.set(file.id, file);
    return file;
  };
  const fileView = (file: FakeFile) => ({ id: file.id, name: file.name, mimeType: file.mimeType, parents: file.parents, trashed: file.trashed });
  const requireFile = (id: string) => files.get(id);

  const routes: [string, RegExp, Handler][] = [
    ["GET", /^https:\/\/www\.googleapis\.com\/discovery\/v1\/apis\/([a-z]+)\/v\d+\/rest$/, (_, m) => json(recordedDiscovery(m[1] as GoogleWorkspaceService))],
    ["POST", /^https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets$/, (request) => {
      const body = JSON.parse(request.body.toString("utf8") || "{}") as { properties?: { title?: string } };
      const spreadsheet: FakeSpreadsheet = { spreadsheetId: nextId("sheet-"), title: body.properties?.title ?? "Untitled", sheets: [{ sheetId: 0, title: "Sheet1" }], values: {}, formats: [] };
      spreadsheets.set(spreadsheet.spreadsheetId, spreadsheet);
      files.set(spreadsheet.spreadsheetId, {
        id: spreadsheet.spreadsheetId,
        name: spreadsheet.title,
        mimeType: "application/vnd.google-apps.spreadsheet",
        parents: ["root"],
        trashed: false,
        content: Buffer.alloc(0),
        permissions: [{ id: "owner", type: "user", role: "owner", emailAddress: "owner@example.com" }],
      });
      return json({ spreadsheetId: spreadsheet.spreadsheetId, properties: { title: spreadsheet.title }, sheets: spreadsheet.sheets.map((sheet) => ({ properties: sheet })) });
    }],
    ["PUT", /^https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\/([^/]+)\/values\/([^?]+)$/, (request, m) => {
      const spreadsheet = spreadsheets.get(m[1]);
      if (!spreadsheet) return googleError(404, "notFound");
      const body = JSON.parse(request.body.toString("utf8")) as { values: unknown[][] };
      const range = decodeURIComponent(m[2]);
      spreadsheet.values[range] = body.values;
      return json({ spreadsheetId: spreadsheet.spreadsheetId, updatedRange: range, updatedCells: body.values.flat().length });
    }],
    ["POST", /^https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\/([^/:]+):batchUpdate$/, (request, m) => {
      const spreadsheet = spreadsheets.get(m[1]);
      if (!spreadsheet) return googleError(404, "notFound");
      const body = JSON.parse(request.body.toString("utf8")) as { requests: Record<string, Record<string, unknown>>[] };
      const replies: unknown[] = [];
      for (const item of body.requests) {
        const [kind, args] = Object.entries(item)[0];
        if (kind === "addSheet") {
          const sheet = { sheetId: spreadsheet.sheets.length + 100, title: String((args.properties as { title?: string })?.title ?? "New") };
          spreadsheet.sheets.push(sheet);
          replies.push({ addSheet: { properties: sheet } });
        } else if (kind === "deleteSheet") {
          spreadsheet.sheets = spreadsheet.sheets.filter((sheet) => sheet.sheetId !== args.sheetId);
          replies.push({});
        } else {
          spreadsheet.formats.push(item);
          replies.push({});
        }
      }
      return json({ spreadsheetId: spreadsheet.spreadsheetId, replies });
    }],
    ["GET", /^https:\/\/www\.googleapis\.com\/drive\/v3\/files$/, (request) => {
      const all = [...files.values()].filter((file) => !file.trashed);
      const start = Number(request.url.searchParams.get("pageToken") ?? 0);
      const page = all.slice(start, start + pageSize);
      const next = start + pageSize < all.length ? String(start + pageSize) : undefined;
      return json({ kind: "drive#fileList", files: page.map(fileView), ...(next ? { nextPageToken: next } : {}) });
    }],
    ["POST", /^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files$/, (request) => {
      if (request.url.searchParams.get("uploadType") !== "multipart") return googleError(400, "badRequest");
      const parts = multipartParts(request);
      return json(fileView(createFile(parts.metadata, parts.media, parts.mediaType)));
    }],
    ["POST", /^https:\/\/www\.googleapis\.com\/resumable\/upload\/drive\/v3\/files$/, (request) => {
      const session = nextId("session-");
      resumable.set(session, { ...(JSON.parse(request.body.toString("utf8") || "{}") as Record<string, unknown>), mimeType: request.headers.get("x-upload-content-type") });
      return new Response(null, { status: 200, headers: { location: `https://www.googleapis.com/upload/drive/v3/files?upload_id=${session}` } });
    }],
    ["PUT", /^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files$/, (request) => {
      const metadata = resumable.get(request.url.searchParams.get("upload_id") ?? "");
      if (!metadata) return googleError(404, "notFound");
      return json(fileView(createFile(metadata, request.body, String(metadata.mimeType))));
    }],
    ["PATCH", /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^/?]+)$/, (request, m) => {
      const file = requireFile(m[1]);
      if (!file) return googleError(404, "notFound");
      const body = JSON.parse(request.body.toString("utf8") || "{}") as { trashed?: boolean; name?: string };
      if (body.trashed !== undefined) file.trashed = body.trashed;
      if (body.name) file.name = body.name;
      const addParents = request.url.searchParams.get("addParents");
      if (addParents) file.parents = addParents.split(",");
      return json(fileView(file));
    }],
    ["DELETE", /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^/?]+)$/, (_, m) => {
      if (!files.delete(m[1])) return googleError(404, "notFound");
      return new Response(null, { status: 204 });
    }],
    ["GET", /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^/?]+)$/, (request, m) => {
      const file = requireFile(m[1]);
      if (!file) return googleError(404, "notFound");
      if (request.url.searchParams.get("alt") === "media") return new Response(new Uint8Array(file.content), { headers: { "content-type": file.mimeType } });
      return json(fileView(file));
    }],
    ["GET", /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^/?]+)\/export$/, (request, m) => {
      const file = requireFile(m[1]);
      if (!file) return googleError(404, "notFound");
      const mimeType = request.url.searchParams.get("mimeType") ?? "text/plain";
      const body = mimeType === "application/pdf" ? Buffer.from("%PDF-1.7 fake") : Buffer.from("a,b\n1,2\n");
      return new Response(new Uint8Array(body), { headers: { "content-type": mimeType } });
    }],
    ["POST", /^https:\/\/www\.googleapis\.com\/drive\/v3\/files\/([^/?]+)\/permissions$/, (request, m) => {
      const file = requireFile(m[1]);
      if (!file) return googleError(404, "notFound");
      const body = JSON.parse(request.body.toString("utf8")) as { type: string; role: string; emailAddress?: string };
      const permission = { id: nextId("perm-"), ...body };
      file.permissions.push(permission);
      return json(permission);
    }],
  ];

  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const body = init.body === undefined || init.body === null ? Buffer.alloc(0) : Buffer.from(init.body as string | Uint8Array);
    const base = `${url.origin}${url.pathname}`;
    const discovery = url.pathname.startsWith("/discovery/");
    if (!discovery) requests.push({ method, url: url.href });
    if (!discovery && headers.get("authorization") !== `Bearer ${token}`) return googleError(401, "authError", "Invalid Credentials");
    if (!discovery && queued.length > 0) return queued.shift()!;
    for (const [routeMethod, pattern, handler] of routes) {
      const match = pattern.exec(base);
      if (match && routeMethod === method) return handler({ method, url, headers, body }, match);
    }
    return googleError(404, "notFound", `No fake route for ${method} ${base}`);
  };

  return {
    fetch: fetchImpl as typeof fetch,
    files,
    spreadsheets,
    requests,
    get token() {
      return token;
    },
    rotateToken() {
      token = `token-${++sequence}`;
      return token;
    },
    queue(...responses: Response[]) {
      queued.push(...responses);
    },
    addFile(name: string, mimeType = "text/plain", content = Buffer.from("hello")) {
      return createFile({ name, mimeType }, content, mimeType);
    },
  };
}

export type FakeGoogle = ReturnType<typeof createFakeGoogle>;
