import { GOOGLE_WORKSPACE_API_VERSIONS, type GoogleWorkspaceService } from "@tickernelz/wardmote-shared";

import review from "./method-review.json" with { type: "json" };
import { GoogleWorkspaceError } from "./errors.js";

export const GOOGLE_METHOD_CLASSES = ["read", "write", "destructive", "external", "execute"] as const;
export type GoogleMethodClass = (typeof GOOGLE_METHOD_CLASSES)[number];
export type GoogleMethodClassification = GoogleMethodClass | "unreviewed";

export interface DiscoverySchema {
  id?: string;
  type?: string;
  description?: string;
  $ref?: string;
  format?: string;
  enum?: string[];
  readOnly?: boolean;
  properties?: Record<string, DiscoverySchema>;
  items?: DiscoverySchema;
  additionalProperties?: DiscoverySchema;
}

export interface DiscoveryParameter {
  type?: string;
  location?: string;
  required?: boolean;
  repeated?: boolean;
  description?: string;
  format?: string;
  enum?: string[];
  default?: string;
}

export interface DiscoveryMethod {
  id: string;
  httpMethod?: string;
  path: string;
  flatPath?: string;
  description?: string;
  parameters?: Record<string, DiscoveryParameter>;
  parameterOrder?: string[];
  request?: { $ref: string };
  response?: { $ref: string };
  scopes?: string[];
  supportsMediaUpload?: boolean;
  supportsMediaDownload?: boolean;
  mediaUpload?: {
    accept?: string[];
    maxSize?: string;
    protocols?: { simple?: { path: string }; resumable?: { path: string } };
  };
}

export interface DiscoveryResource {
  methods?: Record<string, DiscoveryMethod>;
  resources?: Record<string, DiscoveryResource>;
}

export interface DiscoveryDocument extends DiscoveryResource {
  name: string;
  version: string;
  revision: string;
  rootUrl: string;
  servicePath: string;
  schemas?: Record<string, DiscoverySchema>;
}

export interface GoogleMethodParameter {
  type: string;
  location: string;
  required: boolean;
  repeated: boolean;
  description: string;
  enum?: string[];
}

export interface GoogleMethodEntry {
  id: string;
  service: GoogleWorkspaceService;
  httpMethod: string;
  path: string;
  description: string;
  parameters: Record<string, GoogleMethodParameter>;
  requiredParameters: string[];
  requestRef: string | null;
  responseRef: string | null;
  scopes: string[];
  upload: { accept: string[]; maxBytes: number | null; simplePath: string | null; resumablePath: string | null } | null;
  download: boolean;
  class: GoogleMethodClassification;
  batchRequestKinds: Record<string, GoogleMethodClassification> | null;
}

export interface GoogleServiceIndex {
  service: GoogleWorkspaceService;
  version: string;
  revision: string;
  reviewedRevision: string;
  baseUrl: string;
  rootUrl: string;
  fetchedAt: number;
  methods: ReadonlyMap<string, GoogleMethodEntry>;
  schemas: Readonly<Record<string, DiscoverySchema>>;
  unreviewed: { methods: string[]; batchRequestKinds: string[] };
}

export interface GoogleCallClassification {
  baseClass: GoogleMethodClassification;
  methodClass: GoogleMethodClassification;
  classes: GoogleMethodClassification[];
  batchRequestKinds: { kind: string; class: GoogleMethodClassification }[];
}

export interface GoogleMethodSearchHit {
  id: string;
  kind: string | null;
  class: GoogleMethodClassification;
  summary: string;
  requiredParameters: string[];
}

export interface GoogleMethodDescription {
  id: string;
  kind: string | null;
  class: GoogleMethodClassification;
  httpMethod: string;
  url: string;
  scopes: string[];
  parameters: Record<string, GoogleMethodParameter>;
  requiredParameters: string[];
  request: unknown;
  batchRequestKinds: { kind: string; class: GoogleMethodClassification }[] | null;
  responseFields: string[];
  upload: GoogleMethodEntry["upload"];
  download: boolean;
  example: { method: string; params: Record<string, string>; body?: unknown };
}

type ReviewedService = {
  version: string;
  revision: string;
  methods: Record<string, string>;
  batchRequests?: Record<string, Record<string, string>>;
};

const REVIEW = review as { reviewedAt: string; services: Record<GoogleWorkspaceService, ReviewedService> };
const CLASS_RANK: Record<GoogleMethodClassification, number> = {
  read: 0,
  write: 1,
  destructive: 2,
  external: 3,
  unreviewed: 4,
  execute: 5,
};
const METHOD_DESCRIPTION_LIMIT = 400;
const FIELD_DESCRIPTION_LIMIT = 160;
const SEARCH_LIMIT_MAX = 8;
const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_RETRY_MS = 5 * 60 * 1000;
const TRASH_LABEL_METHODS = new Set([
  "gmail.users.messages.modify",
  "gmail.users.messages.batchModify",
  "gmail.users.threads.modify",
]);

export function isGoogleWorkspaceService(value: string): value is GoogleWorkspaceService {
  return Object.prototype.hasOwnProperty.call(GOOGLE_WORKSPACE_API_VERSIONS, value);
}

export function googleDiscoveryUrls(service: GoogleWorkspaceService): string[] {
  const version = GOOGLE_WORKSPACE_API_VERSIONS[service];
  return [
    `https://www.googleapis.com/discovery/v1/apis/${service}/${version}/rest`,
    `https://${service}.googleapis.com/$discovery/rest?version=${version}`,
  ];
}

export function googleMethodService(methodId: string): GoogleWorkspaceService {
  const service = methodId.split(".", 1)[0] ?? "";
  if (!isGoogleWorkspaceService(service)) {
    throw new GoogleWorkspaceError(
      "validation",
      `Unknown Google Workspace service in method "${methodId}"`,
      `Use a method id that starts with one of: ${Object.keys(GOOGLE_WORKSPACE_API_VERSIONS).join(", ")}.`,
      { pointer: "/method" },
    );
  }
  return service;
}

export function highestGoogleMethodClass(classes: Iterable<GoogleMethodClassification>): GoogleMethodClassification {
  let highest: GoogleMethodClassification = "read";
  for (const value of classes) if (CLASS_RANK[value] > CLASS_RANK[highest]) highest = value;
  return highest;
}

function reviewedClass(value: string | undefined): GoogleMethodClassification {
  return (GOOGLE_METHOD_CLASSES as readonly string[]).includes(value ?? "") ? (value as GoogleMethodClass) : "unreviewed";
}

function trim(text: string | undefined, limit: number): string {
  const value = (text ?? "").replace(/\s+/g, " ").trim();
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function firstSentence(text: string): string {
  const match = /^(.+?[.!?])(\s|$)/.exec(text);
  return trim(match ? match[1] : text, FIELD_DESCRIPTION_LIMIT);
}

function parseMaxSize(value: string | undefined): number | null {
  const match = /^(\d+)(B|KB|MB|GB|TB)?$/.exec(value ?? "");
  if (!match) return null;
  const power = ["B", "KB", "MB", "GB", "TB"].indexOf(match[2] ?? "B");
  return Number(match[1]) * 1024 ** power;
}

function batchKindSchema(doc: DiscoveryDocument, method: DiscoveryMethod): DiscoverySchema | null {
  const requestRef = method.request?.$ref;
  const requests = requestRef ? doc.schemas?.[requestRef]?.properties?.requests : undefined;
  const itemRef = requests?.items?.$ref;
  return itemRef ? (doc.schemas?.[itemRef] ?? null) : null;
}

function collectMethods(resource: DiscoveryResource, out: DiscoveryMethod[]) {
  for (const method of Object.values(resource.methods ?? {})) out.push(method);
  for (const child of Object.values(resource.resources ?? {})) collectMethods(child, out);
}

export function buildGoogleServiceIndex(doc: DiscoveryDocument, fetchedAt: number): GoogleServiceIndex {
  if (!isGoogleWorkspaceService(doc.name)) {
    throw new GoogleWorkspaceError("google_error", `Unsupported Discovery document "${doc.name}"`, "Only the reviewed Google Workspace services are indexed.");
  }
  const service = doc.name;
  const reviewed = REVIEW.services[service];
  const raw: DiscoveryMethod[] = [];
  collectMethods(doc, raw);
  const methods = new Map<string, GoogleMethodEntry>();
  const unreviewedMethods: string[] = [];
  const unreviewedKinds: string[] = [];
  for (const method of raw) {
    const methodClass = reviewedClass(reviewed.methods[method.id]);
    if (methodClass === "unreviewed") unreviewedMethods.push(method.id);
    const reviewedKinds = reviewed.batchRequests?.[method.id];
    let batchRequestKinds: Record<string, GoogleMethodClassification> | null = null;
    if (reviewedKinds) {
      batchRequestKinds = {};
      for (const kind of Object.keys(batchKindSchema(doc, method)?.properties ?? {}).sort()) {
        const kindClass = reviewedClass(reviewedKinds[kind]);
        if (kindClass === "unreviewed") unreviewedKinds.push(`${method.id}#${kind}`);
        batchRequestKinds[kind] = kindClass;
      }
    }
    const parameters: Record<string, GoogleMethodParameter> = {};
    for (const [name, parameter] of Object.entries(method.parameters ?? {})) {
      parameters[name] = {
        type: parameter.type ?? "string",
        location: parameter.location ?? "query",
        required: parameter.required === true,
        repeated: parameter.repeated === true,
        description: trim(parameter.description, FIELD_DESCRIPTION_LIMIT),
        ...(parameter.enum ? { enum: parameter.enum } : {}),
      };
    }
    const upload = method.supportsMediaUpload && method.mediaUpload
      ? {
          accept: method.mediaUpload.accept ?? [],
          maxBytes: parseMaxSize(method.mediaUpload.maxSize),
          simplePath: method.mediaUpload.protocols?.simple?.path ?? null,
          resumablePath: method.mediaUpload.protocols?.resumable?.path ?? null,
        }
      : null;
    methods.set(method.id, {
      id: method.id,
      service,
      httpMethod: method.httpMethod ?? "GET",
      path: method.path,
      description: trim(method.description, METHOD_DESCRIPTION_LIMIT),
      parameters,
      requiredParameters: (method.parameterOrder ?? []).filter((name) => parameters[name]?.required),
      requestRef: method.request?.$ref ?? null,
      responseRef: method.response?.$ref ?? null,
      scopes: method.scopes ?? [],
      upload,
      download: method.supportsMediaDownload === true,
      class: methodClass,
      batchRequestKinds,
    });
  }
  return {
    service,
    version: doc.version,
    revision: doc.revision,
    reviewedRevision: reviewed.revision,
    baseUrl: `${doc.rootUrl}${doc.servicePath}`,
    rootUrl: doc.rootUrl,
    fetchedAt,
    methods,
    schemas: doc.schemas ?? {},
    unreviewed: { methods: unreviewedMethods.sort(), batchRequestKinds: unreviewedKinds.sort() },
  };
}

function requireMethod(index: GoogleServiceIndex, methodId: string): GoogleMethodEntry {
  const entry = index.methods.get(methodId);
  if (!entry) {
    throw new GoogleWorkspaceError(
      "validation",
      `Unknown Google method "${methodId}" in ${index.service} ${index.version}`,
      "Find the method id with google_search_methods first.",
      { pointer: "/method" },
    );
  }
  return entry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function classifyGoogleCall(index: GoogleServiceIndex, methodId: string, body?: unknown): GoogleCallClassification {
  const entry = requireMethod(index, methodId);
  const classes = new Set<GoogleMethodClassification>([entry.class]);
  const batchRequestKinds: GoogleCallClassification["batchRequestKinds"] = [];
  if (entry.batchRequestKinds && isRecord(body) && Array.isArray(body.requests)) {
    for (const request of body.requests) {
      const kinds = isRecord(request) ? Object.keys(request) : [];
      if (kinds.length === 0) kinds.push("");
      for (const kind of kinds) {
        const kindClass = entry.batchRequestKinds[kind] ?? "unreviewed";
        batchRequestKinds.push({ kind, class: kindClass });
        classes.add(kindClass);
      }
    }
  }
  if (methodId === "drive.files.update" && isRecord(body) && body.trashed === true) classes.add("destructive");
  if (TRASH_LABEL_METHODS.has(methodId) && isRecord(body) && Array.isArray(body.addLabelIds) && body.addLabelIds.includes("TRASH")) {
    classes.add("destructive");
  }
  const ordered = [...classes].sort((a, b) => CLASS_RANK[a] - CLASS_RANK[b]);
  return { baseClass: entry.class, methodClass: highestGoogleMethodClass(ordered), classes: ordered, batchRequestKinds };
}

function words(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function wordScore(stem: string, words: string[], exact: number): number {
  let best = 0;
  for (const word of words) {
    if (word === stem || word.replace(/s$/, "") === stem) best = Math.max(best, exact);
    else if (word.startsWith(stem)) best = Math.max(best, exact / 2);
  }
  return best;
}

function scoreEntry(terms: string[], primary: string[], secondary: string[], text: string): number {
  let score = 0;
  let matched = 0;
  for (const term of terms) {
    const stem = term.length > 3 ? term.replace(/s$/, "") : term;
    let best = Math.max(wordScore(stem, primary, 4), wordScore(stem, secondary, 2));
    if (best === 0 && text.includes(stem)) best = 1;
    if (best > 0) matched += 1;
    score += best;
  }
  return matched * 2 >= terms.length ? score + matched * 3 : 0;
}

export function searchGoogleMethods(
  indexes: readonly GoogleServiceIndex[],
  input: { query: string; class?: GoogleMethodClassification; limit?: number },
): GoogleMethodSearchHit[] {
  const terms = words(input.query);
  if (terms.length === 0) {
    throw new GoogleWorkspaceError("validation", "Search query is empty", "Describe the action, for example \"delete sheet tab\".", { pointer: "/query" });
  }
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? SEARCH_LIMIT_MAX)), SEARCH_LIMIT_MAX);
  const scored: { hit: GoogleMethodSearchHit; score: number }[] = [];
  for (const index of indexes) {
    for (const entry of index.methods.values()) {
      const segments = entry.id.split(".");
      const idWords = words(entry.id);
      const consider = (hit: GoogleMethodSearchHit, primary: string[], secondary: string[], text: string) => {
        if (input.class && hit.class !== input.class) return;
        const score = scoreEntry(terms, primary, secondary, text.toLowerCase());
        if (score > 0) scored.push({ hit, score });
      };
      consider(
        { id: entry.id, kind: null, class: entry.class, summary: firstSentence(entry.description), requiredParameters: entry.requiredParameters },
        words(segments.slice(-2).join(".")),
        words(segments.slice(0, -2).join(".")),
        entry.description,
      );
      if (!entry.batchRequestKinds) continue;
      const kindSchema = index.schemas[entry.requestRef ?? ""]?.properties?.requests?.items?.$ref;
      const kindProperties = kindSchema ? (index.schemas[kindSchema]?.properties ?? {}) : {};
      for (const [kind, kindClass] of Object.entries(entry.batchRequestKinds)) {
        const description = kindProperties[kind]?.description ?? "";
        consider(
          { id: entry.id, kind, class: kindClass, summary: firstSentence(description), requiredParameters: entry.requiredParameters },
          words(kind),
          idWords,
          description,
        );
      }
    }
  }
  scored.sort((a, b) => b.score - a.score || (a.hit.kind ? 0 : 1) - (b.hit.kind ? 0 : 1) || a.hit.id.localeCompare(b.hit.id) || (a.hit.kind ?? "").localeCompare(b.hit.kind ?? ""));
  return scored.slice(0, limit).map((item) => item.hit);
}

function renderSchema(index: GoogleServiceIndex, schema: DiscoverySchema | undefined, depth: number): unknown {
  if (!schema) return {};
  if (schema.$ref) {
    const target = index.schemas[schema.$ref];
    if (depth <= 0 || !target) return { $ref: schema.$ref };
    return renderSchema(index, target, depth);
  }
  const out: Record<string, unknown> = {};
  if (schema.type) out.type = schema.type;
  if (schema.format) out.format = schema.format;
  if (schema.description) out.description = trim(schema.description, FIELD_DESCRIPTION_LIMIT);
  if (schema.enum) out.enum = schema.enum;
  if (schema.readOnly) out.readOnly = true;
  if (schema.items) out.items = renderSchema(index, schema.items, depth);
  if (schema.additionalProperties) out.additionalProperties = renderSchema(index, schema.additionalProperties, depth);
  if (schema.properties) {
    if (depth <= 0) {
      out.fields = Object.keys(schema.properties);
    } else {
      const properties: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(schema.properties)) properties[name] = renderSchema(index, child, depth - 1);
      out.properties = properties;
    }
  }
  return out;
}

function resolveRef(index: GoogleServiceIndex, schema: DiscoverySchema | undefined): DiscoverySchema | undefined {
  return schema?.$ref ? index.schemas[schema.$ref] : schema;
}

function schemaAtPath(index: GoogleServiceIndex, root: DiscoverySchema | undefined, path: string): DiscoverySchema {
  let current = root;
  for (const segment of path.split(".").filter(Boolean)) {
    const array = segment.endsWith("[]");
    const name = array ? segment.slice(0, -2) : segment;
    current = resolveRef(index, resolveRef(index, current)?.properties?.[name]);
    if (current && array) current = resolveRef(index, current.items);
    if (!current) {
      throw new GoogleWorkspaceError("validation", `Path "${path}" does not exist in the request body`, "Describe the method without path to list its top-level fields.", { pointer: "/path" });
    }
  }
  return current as DiscoverySchema;
}

function kindFromPath(entry: GoogleMethodEntry, path: string | undefined): string | null {
  const match = /^requests\[\]\.([A-Za-z]+)$/.exec(path ?? "");
  return match && entry.batchRequestKinds && match[1] in entry.batchRequestKinds ? match[1] : null;
}

export function describeGoogleMethod(
  index: GoogleServiceIndex,
  methodId: string,
  options: { path?: string; depth?: number } = {},
): GoogleMethodDescription {
  const entry = requireMethod(index, methodId);
  const depth = Math.min(Math.max(0, Math.floor(options.depth ?? 2)), 5);
  const kind = kindFromPath(entry, options.path);
  const requestRoot = entry.requestRef ? index.schemas[entry.requestRef] : undefined;
  let request: unknown = null;
  let batchRequestKinds: GoogleMethodDescription["batchRequestKinds"] = null;
  if (options.path) {
    request = renderSchema(index, schemaAtPath(index, requestRoot, options.path), depth);
  } else if (entry.batchRequestKinds) {
    batchRequestKinds = Object.entries(entry.batchRequestKinds).map(([name, kindClass]) => ({ kind: name, class: kindClass }));
    request = { requests: { type: "array", items: "One object per request with exactly one kind key; describe with path requests[].<kind>." } };
  } else if (requestRoot) {
    request = renderSchema(index, requestRoot, depth);
  }
  const params: Record<string, string> = {};
  for (const name of entry.requiredParameters) params[name] = `<${entry.parameters[name].type}>`;
  const example: GoogleMethodDescription["example"] = { method: entry.id, params };
  if (kind) example.body = { requests: [{ [kind]: {} }] };
  return {
    id: entry.id,
    kind,
    class: kind ? (entry.batchRequestKinds?.[kind] ?? "unreviewed") : entry.class,
    httpMethod: entry.httpMethod,
    url: `${index.baseUrl}${entry.path}`,
    scopes: entry.scopes,
    parameters: entry.parameters,
    requiredParameters: entry.requiredParameters,
    request,
    batchRequestKinds,
    responseFields: Object.keys(entry.responseRef ? (index.schemas[entry.responseRef]?.properties ?? {}) : {}),
    upload: entry.upload,
    download: entry.download,
    example,
  };
}

export interface GoogleDiscoveryIndexOptions {
  fetch?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
}

export function createGoogleDiscoveryIndex(options: GoogleDiscoveryIndexOptions = {}) {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DAY_MS;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const cache = new Map<GoogleWorkspaceService, { index: GoogleServiceIndex; expiresAt: number }>();
  const inflight = new Map<GoogleWorkspaceService, Promise<GoogleServiceIndex>>();

  async function download(service: GoogleWorkspaceService): Promise<DiscoveryDocument> {
    const failures: string[] = [];
    for (const url of googleDiscoveryUrls(service)) {
      try {
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
        if (!response.ok) {
          failures.push(`${url}: HTTP ${response.status}`);
          continue;
        }
        const doc = (await response.json()) as DiscoveryDocument;
        if (doc.name !== service || doc.version !== GOOGLE_WORKSPACE_API_VERSIONS[service]) {
          failures.push(`${url}: unexpected document ${doc.name} ${doc.version}`);
          continue;
        }
        return doc;
      } catch (error) {
        failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new GoogleWorkspaceError(
      "google_error",
      `Google Discovery document for ${service} is unavailable`,
      "Retry later; the Discovery service did not answer.",
      { reason: "discovery_unavailable", failures },
    );
  }

  async function load(service: GoogleWorkspaceService): Promise<GoogleServiceIndex> {
    const cached = cache.get(service);
    try {
      const index = buildGoogleServiceIndex(await download(service), now());
      cache.set(service, { index, expiresAt: now() + ttlMs });
      return index;
    } catch (error) {
      if (!cached) throw error;
      cache.set(service, { index: cached.index, expiresAt: now() + Math.min(ttlMs, STALE_RETRY_MS) });
      return cached.index;
    }
  }

  async function service(name: GoogleWorkspaceService): Promise<GoogleServiceIndex> {
    const cached = cache.get(name);
    if (cached && cached.expiresAt > now()) return cached.index;
    const pending = inflight.get(name);
    if (pending) return pending;
    const next = load(name).finally(() => inflight.delete(name));
    inflight.set(name, next);
    return next;
  }

  return {
    service,
    async search(input: { query: string; service?: GoogleWorkspaceService; class?: GoogleMethodClassification; limit?: number }) {
      const names = input.service ? [input.service] : (Object.keys(GOOGLE_WORKSPACE_API_VERSIONS) as GoogleWorkspaceService[]);
      const settled = await Promise.allSettled(names.map(service));
      const loaded = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
      if (loaded.length === 0) throw (settled[0] as PromiseRejectedResult).reason;
      return searchGoogleMethods(loaded, input);
    },
    async describe(methodId: string, describeOptions: { path?: string; depth?: number } = {}) {
      return describeGoogleMethod(await service(googleMethodService(methodId)), methodId, describeOptions);
    },
    async classify(methodId: string, body?: unknown) {
      return classifyGoogleCall(await service(googleMethodService(methodId)), methodId, body);
    },
  };
}

export type GoogleDiscoveryIndex = ReturnType<typeof createGoogleDiscoveryIndex>;
