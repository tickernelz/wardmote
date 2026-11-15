import type { Agent, DashboardRunActivityDay } from "@tickernelz/wardmote-shared";
import { describe, expect, it } from "vitest";
import { derivePausedAgentBanner, projectMonthEndSpendCents, summarizeRunHealth } from "./Dashboard";

function agent(overrides: Partial<Agent>): Agent {
  return {
    id: "agent-1",
    name: "Agent",
    status: "idle",
    pauseReason: null,
    ...overrides,
  } as unknown as Agent;
}

describe("derivePausedAgentBanner", () => {
  it("returns null with no agents loaded or an empty company", () => {
    expect(derivePausedAgentBanner(undefined)).toBeNull();
    expect(derivePausedAgentBanner([])).toBeNull();
  });

  it("prefers the imported banner and lists only import-paused agents", () => {
    const banner = derivePausedAgentBanner([
      agent({ id: "a", status: "paused", pauseReason: "import" }),
      agent({ id: "b", status: "paused", pauseReason: "manual" }),
      agent({ id: "c", status: "idle" }),
    ]);
    expect(banner).toEqual({ kind: "imported", pausedImportedAgentIds: ["a"] });
  });

  it("falls back to the all-paused banner when no import pauses exist", () => {
    const banner = derivePausedAgentBanner([
      agent({ id: "a", status: "paused", pauseReason: "manual" }),
      agent({ id: "b", status: "paused", pauseReason: "system" }),
    ]);
    expect(banner).toEqual({ kind: "all-paused" });
  });

  it("shows nothing while at least one agent can run and none are import-paused", () => {
    const banner = derivePausedAgentBanner([
      agent({ id: "a", status: "paused", pauseReason: "manual" }),
      agent({ id: "b", status: "idle" }),
    ]);
    expect(banner).toBeNull();
  });
});

describe("projectMonthEndSpendCents", () => {
  it("extends the spend so far over the whole UTC month", () => {
    expect(projectMonthEndSpendCents(1_000, new Date("2026-11-16T00:00:00.000Z"))).toBe(2_000);
    expect(projectMonthEndSpendCents(0, new Date("2026-11-16T00:00:00.000Z"))).toBe(0);
  });

  it("does not explode in the first minutes of a month", () => {
    expect(projectMonthEndSpendCents(100, new Date("2026-11-01T00:00:30.000Z"))).toBe(72_000);
  });
});

describe("summarizeRunHealth", () => {
  const day = (overrides: Partial<DashboardRunActivityDay>): DashboardRunActivityDay => ({
    date: "2026-11-10", succeeded: 0, failed: 0, recovered: 0, other: 0, total: 0, failedByErrorCode: {}, ...overrides,
  });

  it("counts recovered runs as successes and ranks failure codes across days", () => {
    const health = summarizeRunHealth([
      day({ succeeded: 6, recovered: 1, failed: 2, other: 1, total: 10, failedByErrorCode: { provider_quota: 1, process_lost: 1 } }),
      day({ date: "2026-11-11", succeeded: 9, failed: 1, total: 10, failedByErrorCode: { provider_quota: 1 } }),
    ]);
    expect(health).toEqual({
      runs: 20,
      failed: 3,
      successRate: 80,
      causes: [["provider_quota", 2], ["process_lost", 1]],
    });
  });

  it("has no rate without runs", () => {
    expect(summarizeRunHealth([day({})]).successRate).toBeNull();
  });
});
