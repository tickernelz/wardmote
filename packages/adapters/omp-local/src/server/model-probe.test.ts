import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeOmpModel } from "./model-probe.js";

let dir = "";
let command = "";

const okReport = JSON.stringify({ failures: 0, models: [{ selector: "fake/m1", results: [{ ok: true, outputTokens: 1, cost: 0.0028, ttftMs: 1248 }] }] });
const failedReport = JSON.stringify({ failures: 1, models: [{ selector: "fake/m1", results: [{ ok: false, error: "503 upstream unavailable (type=server_error)" }] }] });

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-model-probe-"));
  command = path.join(dir, "omp");
  await fs.writeFile(command, `#!/bin/sh
printf '%s\\n' "$*" > "$PROBE_LOG"
printf 'profile=%s config=%s\\n' "$OMP_PROFILE" "$PI_CONFIG_FILES" >> "$PROBE_LOG"
printf 'api=%s cmd=%s private=%s extra=%s\\n' "$WARDMOTE_API_KEY" "$WARDMOTE_CMD" "$WARDMOTE_AGENT_PRIVATE_KEY" "$PROBE_EXTRA" >> "$PROBE_LOG"
printf '%s' "$PROBE_REPORT"
exit "\${PROBE_EXIT:-0}"
`, { mode: 0o755 });
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function config(env: Record<string, string>, extra: Record<string, unknown> = {}) {
  return { command, env: { PROBE_LOG: path.join(dir, "log"), ...env }, ...extra };
}

describe("probeOmpModel", () => {
  it("sends one prompt capped at one output token through the agent's profile and config files", async () => {
    const result = await probeOmpModel({
      config: config({ PROBE_REPORT: okReport }, { profile: "work", configFiles: ["/etc/a.yml", "/etc/b.yml"] }),
      selector: "fake/m1",
    });
    expect(result).toMatchObject({ ok: true, costUsd: 0.0028 });
    const log = await fs.readFile(path.join(dir, "log"), "utf8");
    expect(log).toContain("bench fake/m1 --runs 1 --par 1 --max-tokens 1 --prompt ping --json");
    expect(log).toContain(`profile=work config=/etc/a.yml${path.delimiter}/etc/b.yml`);
  });

  it("keeps the server's Wardmote credentials and agent identity out of the probe process", async () => {
    const saved = { api: process.env.WARDMOTE_API_KEY, cmd: process.env.WARDMOTE_CMD };
    process.env.WARDMOTE_API_KEY = "server-key";
    process.env.WARDMOTE_CMD = "server-cmd";
    try {
      await probeOmpModel({
        config: config({ PROBE_REPORT: okReport, PROBE_EXTRA: "kept", WARDMOTE_API_KEY: "config-key", WARDMOTE_AGENT_PRIVATE_KEY: "pem" }),
        selector: "fake/m1",
      });
    } finally {
      if (saved.api === undefined) delete process.env.WARDMOTE_API_KEY;
      else process.env.WARDMOTE_API_KEY = saved.api;
      if (saved.cmd === undefined) delete process.env.WARDMOTE_CMD;
      else process.env.WARDMOTE_CMD = saved.cmd;
    }
    const log = await fs.readFile(path.join(dir, "log"), "utf8");
    expect(log).toContain("api= cmd= private= extra=kept");
  });

  it("reports the provider error when the attempt failed", async () => {
    const result = await probeOmpModel({ config: config({ PROBE_REPORT: failedReport, PROBE_EXIT: "1" }), selector: "fake/m1" });
    expect(result).toMatchObject({ ok: false, error: "503 upstream unavailable (type=server_error)" });
  });

  it("fails when the command exits non-zero or prints no report, whatever the report says", async () => {
    expect(await probeOmpModel({ config: config({ PROBE_REPORT: okReport, PROBE_EXIT: "2" }), selector: "fake/m1" }))
      .toMatchObject({ ok: false, error: "omp bench exited 2" });
    expect(await probeOmpModel({ config: config({ PROBE_REPORT: "Could not resolve model" }), selector: "fake/m1" }))
      .toMatchObject({ ok: false, error: "omp bench printed no JSON report" });
  });
});
