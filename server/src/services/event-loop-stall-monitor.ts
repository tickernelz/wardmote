import { PerformanceObserver, performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import type { Request, RequestHandler } from "express";
import type { Logger } from "pino";
import { logger as defaultLogger, requestLogUrl } from "../middleware/logger.js";

const EVENT_LOOP_STALL_THRESHOLD_MS = 5_000;
const GC_PAUSE_THRESHOLD_MS = 1_000;
const HEARTBEAT_MS = 250;
const REQUEST_LOOKBACK_MS = 5 * 60_000;
const MAX_REPORTED_REQUESTS = 15;
const FINISHED_REQUEST_RING = 256;

type ActiveRequest = { req: Request; method: string; rawUrl: string; startedAt: number };
type FinishedRequest = { method: string; rawUrl: string; routePath?: string; startedAt: number; finishedAt: number };

const activeRequests = new Map<number, ActiveRequest>();
const finishedRequests: (FinishedRequest | undefined)[] = new Array(FINISHED_REQUEST_RING);
let finishedCursor = 0;
let nextRequestId = 0;

function routePathOf(req: Request) {
  const path = (req as { route?: { path?: unknown } }).route?.path;
  return typeof path === "string" ? `${req.baseUrl ?? ""}${path}` : undefined;
}

export const trackEventLoopStallRequests: RequestHandler = (req, res, next) => {
  const id = nextRequestId++;
  const entry: ActiveRequest = { req, method: req.method, rawUrl: req.originalUrl ?? req.url, startedAt: Date.now() };
  activeRequests.set(id, entry);
  res.once("close", () => {
    activeRequests.delete(id);
    finishedRequests[finishedCursor] = {
      method: entry.method, rawUrl: entry.rawUrl, routePath: routePathOf(req),
      startedAt: entry.startedAt, finishedAt: Date.now(),
    };
    finishedCursor = (finishedCursor + 1) % FINISHED_REQUEST_RING;
  });
  next();
};

function requestsAroundStall(stallStartedAt: number, stallEndedAt: number) {
  const describe = (request: { method: string; rawUrl: string; routePath?: string; startedAt: number }, finishedAt: number | null) => ({
    method: request.method,
    url: requestLogUrl({ method: request.method, originalUrl: request.rawUrl, url: request.rawUrl }),
    ...(request.routePath ? { routePath: request.routePath } : {}),
    startedBeforeStallMs: stallStartedAt - request.startedAt,
    ...(finishedAt === null ? { active: true } : { durationMs: finishedAt - request.startedAt }),
  });
  const overlaps = (startedAt: number, finishedAt: number) =>
    startedAt <= stallEndedAt && finishedAt >= stallStartedAt && startedAt >= stallStartedAt - REQUEST_LOOKBACK_MS;
  const found: { startedAt: number; summary: ReturnType<typeof describe> }[] = [];
  for (const request of activeRequests.values()) {
    if (!overlaps(request.startedAt, Number.POSITIVE_INFINITY)) continue;
    found.push({ startedAt: request.startedAt, summary: describe({ ...request, routePath: routePathOf(request.req) }, null) });
  }
  for (const request of finishedRequests) {
    if (!request || !overlaps(request.startedAt, request.finishedAt)) continue;
    found.push({ startedAt: request.startedAt, summary: describe(request, request.finishedAt) });
  }
  return found.sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_REPORTED_REQUESTS).map((item) => item.summary);
}

const WATCHDOG_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { thresholdMs, heartbeatMs } = workerData;
const beat = new BigInt64Array(workerData.heartbeat);
let stall = null;
let lastTick = Date.now();
const frameName = (frame) => {
  const url = frame.url ? frame.url.replace(/^file:\/\//, "").split("/").slice(-3).join("/") : "";
  return (frame.functionName || "(anonymous)") + (url ? " " + url + ":" + (frame.lineNumber + 1) : "");
};
const summarize = (profile) => {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map();
  for (const node of profile.nodes) for (const child of node.children || []) parents.set(child, node.id);
  const selfByNode = new Map();
  for (const id of profile.samples) selfByNode.set(id, (selfByNode.get(id) || 0) + 1);
  const byFrame = new Map();
  for (const [id, count] of selfByNode) {
    const key = frameName(nodes.get(id).callFrame);
    const entry = byFrame.get(key) || { samples: 0, node: id, nodeSamples: 0 };
    entry.samples += count;
    if (count > entry.nodeSamples) { entry.node = id; entry.nodeSamples = count; }
    byFrame.set(key, entry);
  }
  const total = profile.samples.length;
  const top = [...byFrame].sort((a, b) => b[1].samples - a[1].samples).slice(0, 5).map(([frame, entry]) => {
    const stack = [];
    for (let id = parents.get(entry.node); id !== undefined && stack.length < 8; id = parents.get(id)) {
      const name = frameName(nodes.get(id).callFrame);
      if (name !== "(root)") stack.push(name);
    }
    return { frame, pct: total ? Math.round((entry.samples * 100) / total) : 0, stack };
  });
  return { samples: total, profiledMs: Math.round((profile.endTime - profile.startTime) / 1000), top };
};
const startProfile = (current) => {
  try {
    const inspector = require("node:inspector");
    const session = new inspector.Session();
    session.connectToMainThread();
    current.session = session;
    session.post("Profiler.enable", () => session.post("Profiler.start", (err) => {
      if (err) current.profileError = String(err.message || err);
    }));
  } catch (err) {
    current.profileError = String((err && err.message) || err);
  }
};
const finish = (current, endedAt) => {
  const report = {
    startedAt: current.startedAt,
    endedAt,
    watchdogLagMs: current.maxLag,
    majorPageFaults: process.resourceUsage().majorPageFault - current.majorPageFaults,
    profileError: current.profileError,
  };
  if (!current.session || current.profileError) {
    if (current.session) current.session.disconnect();
    parentPort.postMessage(report);
    return;
  }
  current.session.post("Profiler.stop", (err, result) => {
    if (err) report.profileError = String(err.message || err);
    else report.profile = summarize(result.profile);
    current.session.disconnect();
    parentPort.postMessage(report);
  });
};
setInterval(() => {
  const now = Date.now();
  const lag = Math.max(0, now - lastTick - heartbeatMs);
  lastTick = now;
  const lastBeat = Number(Atomics.load(beat, 0));
  if (!stall) {
    if (now - lastBeat < thresholdMs) return;
    stall = { startedAt: lastBeat, maxLag: lag, majorPageFaults: process.resourceUsage().majorPageFault };
    startProfile(stall);
    return;
  }
  stall.maxLag = Math.max(stall.maxLag, lag);
  if (lastBeat <= stall.startedAt) return;
  const current = stall;
  stall = null;
  finish(current, lastBeat);
}, heartbeatMs);
`;

type WatchdogReport = {
  startedAt: number;
  endedAt: number;
  watchdogLagMs: number;
  majorPageFaults: number;
  profileError?: string;
  profile?: { samples: number; profiledMs: number; top: { frame: string; pct: number; stack: string[] }[] };
};

const mib = (bytes: number) => Math.round(bytes / 1048576);

function memorySnapshot() {
  const memory = process.memoryUsage();
  return {
    rssMiB: mib(memory.rss), heapUsedMiB: mib(memory.heapUsed), heapTotalMiB: mib(memory.heapTotal),
    externalMiB: mib(memory.external), arrayBuffersMiB: mib(memory.arrayBuffers),
  };
}

const GC_KINDS: Record<number, string> = { 1: "minor", 2: "major", 4: "incremental", 8: "weakcb" };

export function startEventLoopStallMonitor(options: {
  logger?: Logger;
  stallThresholdMs?: number;
  gcThresholdMs?: number;
} = {}) {
  const log = options.logger ?? defaultLogger;
  const stallThresholdMs = options.stallThresholdMs ?? EVENT_LOOP_STALL_THRESHOLD_MS;
  const gcThresholdMs = options.gcThresholdMs ?? GC_PAUSE_THRESHOLD_MS;
  const heartbeat = new BigInt64Array(new SharedArrayBuffer(8));
  const beat = () => Atomics.store(heartbeat, 0, BigInt(Date.now()));
  beat();
  const heartbeatTimer = setInterval(beat, HEARTBEAT_MS);
  heartbeatTimer.unref?.();

  const gcObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.duration < gcThresholdMs) continue;
      const detail = (entry as { detail?: { kind?: number; flags?: number } }).detail;
      log.warn({
        durationMs: Math.round(entry.duration),
        kind: GC_KINDS[detail?.kind ?? 0] ?? detail?.kind,
        flags: detail?.flags,
        startedAt: new Date(performance.timeOrigin + entry.startTime).toISOString(),
        ...memorySnapshot(),
      }, "long garbage collection pause");
    }
  });
  gcObserver.observe({ entryTypes: ["gc"] });

  const worker = new Worker(WATCHDOG_SOURCE, {
    eval: true,
    name: "event-loop-stall-watchdog",
    workerData: { heartbeat: heartbeat.buffer, thresholdMs: stallThresholdMs, heartbeatMs: HEARTBEAT_MS },
  });
  worker.unref();
  worker.on("message", (report: WatchdogReport) => {
    const stalledMs = report.endedAt - report.startedAt;
    log.warn({
      stalledMs,
      startedAt: new Date(report.startedAt).toISOString(),
      wholeProcessFrozen: report.watchdogLagMs >= stalledMs / 2,
      watchdogLagMs: report.watchdogLagMs,
      majorPageFaults: report.majorPageFaults,
      ...memorySnapshot(),
      requests: requestsAroundStall(report.startedAt, report.endedAt),
      ...(report.profile ? { unprofiledMs: Math.max(0, stalledMs - report.profile.profiledMs), profile: report.profile } : {}),
      ...(report.profileError ? { profileError: report.profileError } : {}),
    }, "event loop stalled");
  });
  worker.on("error", (err) => log.warn({ err }, "event loop stall watchdog failed; stall reports are off"));

  return {
    stop() {
      clearInterval(heartbeatTimer);
      gcObserver.disconnect();
      void worker.terminate();
    },
  };
}
