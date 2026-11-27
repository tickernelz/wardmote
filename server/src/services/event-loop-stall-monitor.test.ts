import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Logger } from "pino";
import { startEventLoopStallMonitor, trackEventLoopStallRequests } from "./event-loop-stall-monitor.js";

type Entry = { obj: Record<string, any>; msg: string };

function captureLogger() {
  const entries: Entry[] = [];
  const logger = { warn: (obj: Record<string, any>, msg: string) => { entries.push({ obj, msg }); } } as unknown as Logger;
  return { logger, entries };
}

function spinTheMainThreadFor(ms: number) {
  const end = Date.now() + ms;
  let value = 0;
  while (Date.now() < end) value += Math.sqrt(value + 1);
  return value;
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("event loop stall monitor", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });

  it("reports a main-thread stall with its duration, the stalled code and the request that caused it", async () => {
    const { logger, entries } = captureLogger();
    stop = startEventLoopStallMonitor({ logger, stallThresholdMs: 400 }).stop;
    const app = express();
    app.use(trackEventLoopStallRequests);
    app.post("/api/issues/:id/documents/:key", (_req, res) => {
      spinTheMainThreadFor(1_500);
      res.json({ ok: true });
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      await new Promise((resolve) => setTimeout(resolve, 600));
      const response = await fetch(`http://127.0.0.1:${port}/api/issues/ZHA-1/documents/plan?token=secret`, { method: "POST" });
      expect(response.status).toBe(200);
      const stall = await waitFor(() => entries.find((entry) => entry.msg === "event loop stalled"));
      expect(stall.obj.stalledMs).toBeGreaterThanOrEqual(1_000);
      expect(stall.obj.stalledMs).toBeLessThan(3_000);
      expect(stall.obj.wholeProcessFrozen).toBe(false);
      expect(stall.obj.requests).toContainEqual(expect.objectContaining({
        method: "POST",
        url: "/api/issues/ZHA-1/documents/plan",
        routePath: "/api/issues/:id/documents/:key",
      }));
      const profiled = [stall.obj.profile.top[0].frame, ...stall.obj.profile.top[0].stack].join("\n");
      expect(profiled).toContain("event-loop-stall-monitor.test.ts");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }, 20_000);

  it("stays silent while the event loop keeps turning", async () => {
    const { logger, entries } = captureLogger();
    stop = startEventLoopStallMonitor({ logger, stallThresholdMs: 400 }).stop;
    for (let i = 0; i < 10; i += 1) {
      spinTheMainThreadFor(100);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(entries.filter((entry) => entry.msg === "event loop stalled")).toEqual([]);
  });
});
