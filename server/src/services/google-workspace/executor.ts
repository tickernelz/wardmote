import {
  classifyGoogleCall,
  googleMethodService,
  type DiscoverySchema,
  type GoogleCallClassification,
  type GoogleDiscoveryIndex,
  type GoogleMethodEntry,
  type GoogleServiceIndex,
} from "./discovery.js";
import { GoogleWorkspaceError } from "./errors.js";

export interface GoogleCallInput {
  method: string;
  params?: Record<string, unknown>;
  body?: unknown;
  dryRun?: boolean;
  pageAll?: boolean;
  pageLimit?: number;
  fields?: string;
  upload?: { attachmentId: string; contentType?: string };
  download?: "attachment";
  permanentDelete?: boolean;
}

export interface GoogleCallPlan {
  method: string;
  service: string;
  classification: GoogleCallClassification;
  httpMethod: string;
  url: string;
  query: [string, string][];
  params: Record<string, unknown>;
  body: unknown;
  scopes: string[];
  upload: { attachmentId: string; protocol: "multipart" | "resumable" } | null;
  download: boolean;
  trashInsteadOfDelete: boolean;
  estimatedRequests: number;
}

export type GooglePolicyVerdict = { allowed: true; notes?: string[] } | { allowed: false; error: GoogleWorkspaceError };

export interface GoogleStoredAttachment {
  attachmentId: string;
  byteSize: number;
  contentType: string;
  filename: string;
}

export interface GoogleCallContext {
  discovery: GoogleDiscoveryIndex;
  credentials: { headers(options: { forceRefresh: boolean }): Promise<Record<string, string>> };
  attachments: {
    read(attachmentId: string, maxBytes: number): Promise<{ bytes: Uint8Array; contentType: string; filename: string }>;
    store(input: { filename: string; contentType: string; bytes: Uint8Array }): Promise<GoogleStoredAttachment>;
  };
  policy(plan: GoogleCallPlan): Promise<GooglePolicyVerdict>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  limits?: Partial<GoogleCallLimits>;
}

export interface GoogleCallLimits {
  uploadMaxBytes: number;
  downloadMaxBytes: number;
  inlineTextMaxChars: number;
  requestTimeoutMs: number;
}

export interface GoogleCallResult {
  ok: true;
  dryRun: boolean;
  method: string;
  class: GoogleCallClassification["methodClass"];
  status?: number;
  data?: unknown;
  nextPageToken?: string;
  attachment?: GoogleStoredAttachment;
  plan?: {
    httpMethod: string;
    url: string;
    query: [string, string][];
    upload: GoogleCallPlan["upload"];
    trashInsteadOfDelete: boolean;
    classes: GoogleCallClassification["classes"];
    policy: { allowed: true; notes: string[] } | { allowed: false; code: string; message: string; hint: string };
  };
  quota: { requests: number };
  untrusted: true;
  source: { method: string; url: string };
}

const DEFAULT_LIMITS: GoogleCallLimits = {
  uploadMaxBytes: 50 * 1024 * 1024,
  downloadMaxBytes: 50 * 1024 * 1024,
  inlineTextMaxChars: 100_000,
  requestTimeoutMs: 60_000,
};
const MULTIPART_MAX_BYTES = 5 * 1024 * 1024;
const PAGE_LIMIT_DEFAULT = 10;
const PAGE_LIMIT_MAX = 50;
const INLINE_EXPORT_TYPES = /^(text\/|application\/(json|csv|xml|x-yaml|vnd\.google-apps\.script\+json))/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(pointer: string, message: string, schema?: unknown): GoogleWorkspaceError {
  return new GoogleWorkspaceError("validation", message, "Fix the field at the pointer; google_describe shows the schema.", {
    pointer,
    ...(schema === undefined ? {} : { schema }),
  });
}

function schemaFragment(schema: DiscoverySchema): unknown {
  if (schema.properties) return { type: "object", fields: Object.keys(schema.properties) };
  return { type: schema.type, ...(schema.format ? { format: schema.format } : {}), ...(schema.enum ? { enum: schema.enum } : {}) };
}

function checkPrimitive(type: string | undefined, format: string | undefined, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string" || (typeof value === "number" && /^u?int64$|^(double|float)$/.test(format ?? ""));
    case "integer":
      return typeof value === "number" ? Number.isInteger(value) : typeof value === "string" && /^-?\d+$/.test(value);
    case "number":
      return typeof value === "number" || (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value)));
    case "boolean":
      return typeof value === "boolean";
    default:
      return true;
  }
}

export function validateGoogleBody(index: GoogleServiceIndex, schema: DiscoverySchema, value: unknown, pointer = "/body"): void {
  const resolved = schema.$ref ? index.schemas[schema.$ref] : schema;
  if (!resolved || value === null || value === undefined) return;
  if (resolved.type === "any") return;
  if (resolved.type === "array") {
    if (!Array.isArray(value)) throw invalid(pointer, `Expected an array at ${pointer}`, schemaFragment(resolved));
    value.forEach((item, position) => resolved.items && validateGoogleBody(index, resolved.items, item, `${pointer}/${position}`));
    return;
  }
  if (resolved.properties || resolved.additionalProperties || resolved.type === "object") {
    if (!isRecord(value)) throw invalid(pointer, `Expected an object at ${pointer}`, schemaFragment(resolved));
    for (const [key, child] of Object.entries(value)) {
      const childPointer = `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
      const childSchema = resolved.properties?.[key] ?? resolved.additionalProperties;
      if (!childSchema) throw invalid(childPointer, `Unknown field "${key}" at ${pointer}`, schemaFragment(resolved));
      validateGoogleBody(index, childSchema, child, childPointer);
    }
    return;
  }
  if (!checkPrimitive(resolved.type, resolved.format, value)) {
    throw invalid(pointer, `Expected ${resolved.type}${resolved.format ? ` (${resolved.format})` : ""} at ${pointer}`, schemaFragment(resolved));
  }
  if (resolved.enum && typeof value === "string" && !resolved.enum.includes(value)) {
    throw invalid(pointer, `Value "${value}" is not allowed at ${pointer}`, schemaFragment(resolved));
  }
}

function expandPath(template: string, values: Map<string, string>): string {
  return template.replace(/\{(\+?)([^}]+)\}/g, (_, reserved: string, name: string) => {
    const value = values.get(name) ?? "";
    return reserved ? value.split("/").map(encodeURIComponent).join("/") : encodeURIComponent(value);
  });
}

function parameterValues(entry: GoogleMethodEntry, params: Record<string, unknown>) {
  const pathValues = new Map<string, string>();
  const query: [string, string][] = [];
  for (const [name, value] of Object.entries(params)) {
    const spec = entry.parameters[name];
    const pointer = `/params/${name}`;
    if (!spec) throw invalid(pointer, `Unknown parameter "${name}" for ${entry.id}`, { parameters: Object.keys(entry.parameters) });
    if (value === undefined || value === null) continue;
    const values = Array.isArray(value) ? value : [value];
    if (Array.isArray(value) && !spec.repeated) throw invalid(pointer, `Parameter "${name}" takes one value`, spec);
    for (const item of values) {
      if (!checkPrimitive(spec.type, undefined, item)) throw invalid(pointer, `Parameter "${name}" must be ${spec.type}`, spec);
      if (spec.enum && !spec.enum.includes(String(item))) throw invalid(pointer, `Parameter "${name}" must be one of ${spec.enum.join(", ")}`, spec);
    }
    if (spec.location === "path") pathValues.set(name, String(values[0]));
    else for (const item of values) query.push([name, String(item)]);
  }
  for (const name of entry.requiredParameters) {
    if (params[name] === undefined || params[name] === null || params[name] === "") {
      throw invalid(`/params/${name}`, `Missing required parameter "${name}" for ${entry.id}`, entry.parameters[name]);
    }
  }
  return { pathValues, query };
}

function urlWithQuery(url: string, query: [string, string][]): string {
  if (query.length === 0) return url;
  const search = new URLSearchParams(query).toString();
  return `${url}${url.includes("?") ? "&" : "?"}${search}`;
}

function joinRoot(rootUrl: string, path: string): string {
  return `${rootUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}

function retryAfterMs(response: Response, attempt: number): number {
  const header = Number(response.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 30_000);
  return 1000 * 2 ** attempt + Math.floor(Math.random() * 250);
}

interface GoogleErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: { reason?: string; message?: string }[];
    details?: { reason?: string; metadata?: Record<string, string>; links?: { url?: string }[] }[];
  };
}

async function readErrorBody(response: Response): Promise<GoogleErrorBody> {
  try {
    return (await response.json()) as GoogleErrorBody;
  } catch {
    return {};
  }
}

function googleReasons(body: GoogleErrorBody): string[] {
  const error = body.error ?? {};
  return [
    ...(error.errors ?? []).map((item) => item.reason ?? ""),
    ...(error.details ?? []).map((item) => item.reason ?? ""),
    error.status ?? "",
  ].filter(Boolean);
}

function enableUrlFrom(body: GoogleErrorBody): string | null {
  for (const detail of body.error?.details ?? []) {
    if (detail.metadata?.activationUrl) return detail.metadata.activationUrl;
    for (const link of detail.links ?? []) if (link.url) return link.url;
  }
  const match = /https:\/\/console\.(?:developers|cloud)\.google\.com\/[^\s"]+/.exec(body.error?.message ?? "");
  return match ? match[0].replace(/[.)]+$/, "") : null;
}

export function googleErrorFromResponse(status: number, body: GoogleErrorBody, retryAfter: number | null): GoogleWorkspaceError {
  const reasons = googleReasons(body);
  const message = body.error?.message ?? `Google answered HTTP ${status}`;
  const has = (...names: string[]) => reasons.some((reason) => names.includes(reason));
  if (has("accessNotConfigured", "SERVICE_DISABLED")) {
    return new GoogleWorkspaceError("api_not_enabled", message, "Ask the connection owner to enable this API in Google Cloud Console.", {
      status,
      enableUrl: enableUrlFrom(body),
    });
  }
  if (has("insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT")) {
    return new GoogleWorkspaceError("scope_missing", message, "The connection lacks the Google scope for this call; the owner must grant more access.", { status });
  }
  if (status === 401) {
    return new GoogleWorkspaceError("auth_expired", message, "The Google grant expired or was revoked; reconnect Google Workspace.", { status });
  }
  if (status === 429 || has("rateLimitExceeded", "userRateLimitExceeded", "RATE_LIMIT_EXCEEDED", "RESOURCE_EXHAUSTED")) {
    return new GoogleWorkspaceError("rate_limited", message, "Wait for retryAfter seconds before calling again.", {
      status,
      retryAfter: retryAfter === null ? null : Math.ceil(retryAfter / 1000),
    });
  }
  return new GoogleWorkspaceError("google_error", message, "Read the Google message and reason; adjust the call.", {
    status,
    reason: reasons[0] ?? null,
  });
}

function isRetryable(status: number, reasons: string[]): boolean {
  return status === 429 || status >= 500 || reasons.some((reason) => ["rateLimitExceeded", "userRateLimitExceeded", "RATE_LIMIT_EXCEEDED"].includes(reason));
}

function mergePages(pages: Record<string, unknown>[]): Record<string, unknown> {
  const [first, ...rest] = pages;
  const merged: Record<string, unknown> = { ...first };
  for (const page of rest) {
    for (const [key, value] of Object.entries(page)) {
      if (Array.isArray(value) && Array.isArray(merged[key])) merged[key] = [...(merged[key] as unknown[]), ...value];
      else if (!(key in merged) || !Array.isArray(merged[key])) merged[key] = value;
    }
  }
  delete merged.nextPageToken;
  return merged;
}

function extensionFor(contentType: string): string {
  const known: Record<string, string> = {
    "application/pdf": "pdf",
    "text/csv": "csv",
    "text/plain": "txt",
    "text/html": "html",
    "application/zip": "zip",
    "image/png": "png",
    "image/jpeg": "jpg",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  };
  return known[contentType.split(";")[0].trim()] ?? "bin";
}

function isPageable(entry: GoogleMethodEntry, input: GoogleCallInput): boolean {
  return input.pageAll === true && entry.httpMethod === "GET" && "pageToken" in entry.parameters;
}

export async function planGoogleCall(discovery: GoogleDiscoveryIndex, input: GoogleCallInput): Promise<{ plan: GoogleCallPlan; index: GoogleServiceIndex; entry: GoogleMethodEntry }> {
  if (typeof input.method !== "string" || input.method.length === 0) throw invalid("/method", "method is required");
  const index = await discovery.service(googleMethodService(input.method));
  const classification = classifyGoogleCall(index, input.method, input.body);
  let entry = index.methods.get(input.method) as GoogleMethodEntry;
  let body = input.body;
  let params = { ...(input.params ?? {}) };
  const trashInsteadOfDelete = entry.id === "drive.files.delete" && input.permanentDelete !== true;
  if (trashInsteadOfDelete) {
    entry = index.methods.get("drive.files.update") as GoogleMethodEntry;
    body = { trashed: true };
    params = Object.fromEntries(Object.entries(params).filter(([name]) => name in entry.parameters));
  }
  if (body !== undefined && body !== null) {
    if (!entry.requestRef) throw invalid("/body", `${entry.id} takes no request body`);
    validateGoogleBody(index, { $ref: entry.requestRef }, body);
  }
  if (entry.batchRequestKinds && isRecord(body) && Array.isArray(body.requests)) {
    body.requests.forEach((request, position) => {
      if (!isRecord(request) || Object.keys(request).length !== 1) {
        throw invalid(`/body/requests/${position}`, "Each batchUpdate request needs exactly one kind key", { kinds: Object.keys(entry.batchRequestKinds ?? {}) });
      }
    });
  }
  const { pathValues, query } = parameterValues(entry, params);
  if (input.fields) query.push(["fields", input.fields]);
  let upload: GoogleCallPlan["upload"] = null;
  let url = joinRoot(index.baseUrl, expandPath(entry.path, pathValues));
  if (input.upload) {
    if (!entry.upload) throw invalid("/upload", `${entry.id} does not accept a file upload`);
    if (typeof input.upload.attachmentId !== "string" || !input.upload.attachmentId) throw invalid("/upload/attachmentId", "upload.attachmentId is required");
    upload = { attachmentId: input.upload.attachmentId, protocol: entry.upload.simplePath ? "multipart" : "resumable" };
    const uploadPath = upload.protocol === "multipart" ? entry.upload.simplePath : entry.upload.resumablePath;
    url = joinRoot(index.rootUrl, expandPath(uploadPath ?? "", pathValues));
  }
  const exporting = entry.id === "drive.files.export";
  if (input.download === "attachment" && !entry.download) throw invalid("/download", `${entry.id} has no file content to download`);
  const download = exporting || input.download === "attachment";
  if (download && !exporting) query.push(["alt", "media"]);
  const pageLimit = Math.min(Math.max(1, Math.floor(input.pageLimit ?? PAGE_LIMIT_DEFAULT)), PAGE_LIMIT_MAX);
  const pageable = isPageable(entry, input) && !download;
  return {
    index,
    entry,
    plan: {
      method: input.method,
      service: index.service,
      classification,
      httpMethod: entry.httpMethod,
      url,
      query,
      params,
      body,
      scopes: entry.scopes,
      upload,
      download,
      trashInsteadOfDelete,
      estimatedRequests: pageable ? pageLimit : 1,
    },
  };
}

export async function executeGoogleCall(context: GoogleCallContext, input: GoogleCallInput): Promise<GoogleCallResult> {
  const limits = { ...DEFAULT_LIMITS, ...context.limits };
  const fetchImpl = context.fetch ?? fetch;
  const sleep = context.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const { plan, entry } = await planGoogleCall(context.discovery, input);
  const verdict = await context.policy(plan);
  const sourceUrl = urlWithQuery(plan.url, plan.query);
  const base = {
    ok: true as const,
    method: plan.method,
    class: plan.classification.methodClass,
    untrusted: true as const,
    source: { method: plan.method, url: sourceUrl },
  };
  if (input.dryRun) {
    return {
      ...base,
      dryRun: true,
      plan: {
        httpMethod: plan.httpMethod,
        url: plan.url,
        query: plan.query,
        upload: plan.upload,
        trashInsteadOfDelete: plan.trashInsteadOfDelete,
        classes: plan.classification.classes,
        policy: verdict.allowed
          ? { allowed: true, notes: verdict.notes ?? [] }
          : { allowed: false, code: verdict.error.code, message: verdict.error.message, hint: verdict.error.hint },
      },
      quota: { requests: plan.estimatedRequests },
    };
  }
  if (!verdict.allowed) throw verdict.error;

  let requests = 0;
  let forceRefresh = false;

  async function authHeaders(): Promise<Record<string, string>> {
    try {
      return await context.credentials.headers({ forceRefresh });
    } catch (error) {
      if (error instanceof GoogleWorkspaceError) throw error;
      throw new GoogleWorkspaceError("auth_expired", "The Google credential could not be refreshed", "Reconnect Google Workspace from the connection page.", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function send(url: string, init: { method: string; headers?: Record<string, string>; body?: BodyInit }): Promise<Response> {
    let refreshed = false;
    for (let attempt = 0; ; attempt += 1) {
      const headers = { ...(await authHeaders()), ...init.headers };
      requests += 1;
      let response: Response;
      try {
        response = await fetchImpl(url, { method: init.method, headers, body: init.body, signal: AbortSignal.timeout(limits.requestTimeoutMs) });
      } catch (error) {
        if (attempt === 0) {
          await sleep(1000);
          continue;
        }
        throw new GoogleWorkspaceError("google_error", "Google did not answer", "Retry later.", { reason: error instanceof Error ? error.message : String(error) });
      }
      if (response.ok) return response;
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        forceRefresh = true;
        continue;
      }
      const body = await readErrorBody(response);
      const wait = retryAfterMs(response, attempt);
      if (attempt === 0 && isRetryable(response.status, googleReasons(body))) {
        await sleep(wait);
        continue;
      }
      throw googleErrorFromResponse(response.status, body, response.status === 429 || isRetryable(response.status, googleReasons(body)) ? wait : null);
    }
  }

  const jsonHeaders = { accept: "application/json", "content-type": "application/json" };
  let response: Response;
  if (plan.upload) {
    const file = await context.attachments.read(plan.upload.attachmentId, Math.min(limits.uploadMaxBytes, entry.upload?.maxBytes ?? limits.uploadMaxBytes));
    const contentType = input.upload?.contentType ?? file.contentType ?? "application/octet-stream";
    const metadataBody: Record<string, unknown> = isRecord(plan.body) ? { ...plan.body } : {};
    if (entry.id === "drive.files.create" && !("name" in metadataBody)) metadataBody.name = file.filename;
    const metadata = JSON.stringify(metadataBody);
    if (plan.upload.protocol === "multipart" && file.bytes.byteLength <= MULTIPART_MAX_BYTES) {
      const boundary = `wardmote_${crypto.randomUUID()}`;
      const head = Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\ncontent-type: ${contentType}\r\n\r\n`);
      const tail = Buffer.from(`\r\n--${boundary}--`);
      response = await send(urlWithQuery(plan.url, [...plan.query, ["uploadType", "multipart"]]), {
        method: plan.httpMethod,
        headers: { accept: "application/json", "content-type": `multipart/related; boundary=${boundary}` },
        body: Buffer.concat([head, Buffer.from(file.bytes), tail]),
      });
    } else {
      const resumablePath = entry.upload?.resumablePath;
      if (!resumablePath) throw invalid("/upload", `${entry.id} cannot upload files larger than ${MULTIPART_MAX_BYTES} bytes`);
      const index = await context.discovery.service(googleMethodService(plan.method));
      const sessionUrl = joinRoot(index.rootUrl, expandPath(resumablePath, parameterValues(entry, plan.params).pathValues));
      const start = await send(urlWithQuery(sessionUrl, [...plan.query, ["uploadType", "resumable"]]), {
        method: plan.httpMethod,
        headers: { ...jsonHeaders, "x-upload-content-type": contentType, "x-upload-content-length": String(file.bytes.byteLength) },
        body: metadata,
      });
      const location = start.headers.get("location");
      if (!location || !/^https:\/\/[a-z0-9.-]+\.googleapis\.com\//.test(location)) {
        throw new GoogleWorkspaceError("google_error", "Google did not return an upload session", "Retry the upload.", { reason: "upload_session_missing" });
      }
      response = await send(location, { method: "PUT", headers: { "content-type": contentType }, body: Buffer.from(file.bytes) });
    }
  } else {
    const hasBody = plan.body !== undefined && plan.body !== null;
    response = await send(urlWithQuery(plan.url, plan.query), {
      method: plan.httpMethod,
      headers: hasBody ? jsonHeaders : { accept: plan.download ? "*/*" : "application/json" },
      body: hasBody ? JSON.stringify(plan.body) : undefined,
    });
  }

  if (plan.download) {
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > limits.downloadMaxBytes) {
      throw new GoogleWorkspaceError("validation", "The file is larger than the download limit", "Export a smaller format or a part of the file.", { byteSize: declared, limit: limits.downloadMaxBytes });
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limits.downloadMaxBytes) {
      throw new GoogleWorkspaceError("validation", "The file is larger than the download limit", "Export a smaller format or a part of the file.", { byteSize: bytes.byteLength, limit: limits.downloadMaxBytes });
    }
    if (input.download !== "attachment" && INLINE_EXPORT_TYPES.test(contentType) && bytes.byteLength <= limits.inlineTextMaxChars) {
      return { ...base, dryRun: false, status: response.status, data: { contentType, text: new TextDecoder().decode(bytes) }, quota: { requests } };
    }
    const fileId = typeof plan.params.fileId === "string" ? plan.params.fileId : "google-file";
    const attachment = await context.attachments.store({ filename: `${fileId}.${extensionFor(contentType)}`, contentType: contentType.split(";")[0].trim(), bytes });
    return { ...base, dryRun: false, status: response.status, attachment, quota: { requests } };
  }

  const text = await response.text();
  let data: unknown = text.length === 0 ? null : (() => {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  })();
  if (isPageable(entry, input) && isRecord(data) && typeof data.nextPageToken === "string") {
    const pages: Record<string, unknown>[] = [data];
    let token: string | undefined = data.nextPageToken;
    while (token && pages.length < plan.estimatedRequests) {
      const query = plan.query.filter(([name]) => name !== "pageToken");
      query.push(["pageToken", token]);
      const next = await send(urlWithQuery(plan.url, query), { method: plan.httpMethod, headers: { accept: "application/json" } });
      const page = (await next.json()) as Record<string, unknown>;
      pages.push(page);
      token = typeof page.nextPageToken === "string" ? page.nextPageToken : undefined;
    }
    data = mergePages(pages);
    return { ...base, dryRun: false, status: response.status, data, ...(token ? { nextPageToken: token } : {}), quota: { requests } };
  }
  const nextPageToken = isRecord(data) && typeof data.nextPageToken === "string" ? data.nextPageToken : undefined;
  return { ...base, dryRun: false, status: response.status, data, ...(nextPageToken ? { nextPageToken } : {}), quota: { requests } };
}
