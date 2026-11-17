import os from "node:os";
import path from "node:path";
import type { AdapterModelProbeInput, AdapterModelProbeResult } from "@tickernelz/wardmote-adapter-utils";
import {
  ensurePathInEnv,
  isForbiddenConfigEnvKey,
  isWardmoteRuntimeEnvKey,
  parseObject,
  runChildProcess,
  sanitizeInheritedWardmoteEnv,
} from "@tickernelz/wardmote-adapter-utils/server-utils";
import { prepareOmpRuntimeConfig, resolveOmpCommand } from "./config.js";
import { applyPreparedOmpAgentEnvironment } from "./execute.js";

/** Matches the server's probation first-event limit: a model slower than the next run would tolerate does not pass. */
export const OMP_MODEL_PROBE_TIMEOUT_SEC = 60;

function stringEnv(value: unknown): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, item] of Object.entries(parseObject(value))) {
    if (typeof item === "string") env[key] = item;
  }
  return env;
}

function probeEnv(config: Record<string, unknown>): Record<string, string> {
  const env = stringEnv(sanitizeInheritedWardmoteEnv(process.env));
  for (const [key, value] of Object.entries(stringEnv(config.env))) {
    if (isForbiddenConfigEnvKey(key) || isWardmoteRuntimeEnvKey(key)) continue;
    env[key] = value;
  }
  return stringEnv(ensurePathInEnv(env));
}

function stringList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\r?\n/) : [];
  return values.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function globalList(value: string | undefined): string[] {
  const text = value?.trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      return stringList(JSON.parse(text));
    } catch {
      return [];
    }
  }
  return text.split(text.includes("\n") ? /\r?\n/ : path.delimiter).map((item) => item.trim()).filter(Boolean);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBenchResult(stdout: string): { ok: boolean; costUsd: number | null; error: string | null } {
  let report: Record<string, unknown>;
  try {
    report = parseObject(JSON.parse(stdout));
  } catch {
    return { ok: false, costUsd: null, error: "omp bench printed no JSON report" };
  }
  const model = parseObject(Array.isArray(report.models) ? report.models[0] : null);
  const attempt = parseObject(Array.isArray(model.results) ? model.results[0] : null);
  const outputTokens = finite(attempt.outputTokens) ?? 0;
  const ok = attempt.ok === true && outputTokens > 0;
  const error = typeof attempt.error === "string" && attempt.error.trim() ? attempt.error.trim() : null;
  return { ok, costUsd: finite(attempt.cost), error: ok ? null : error ?? "the model returned no output token" };
}

/** One-token `omp bench` call under the agent's OMP command, profile, agent dir, sanitized env and config files. */
export async function probeOmpModel(input: AdapterModelProbeInput): Promise<AdapterModelProbeResult> {
  const config = parseObject(input.config);
  const startedAt = Date.now();
  const prepared = await prepareOmpRuntimeConfig(config);
  try {
    const env = probeEnv(config);
    applyPreparedOmpAgentEnvironment(env, prepared);
    if (prepared.profile && !prepared.materialized) env.OMP_PROFILE = prepared.profile;
    const configured = stringList(config.configFiles);
    const configFiles = configured.length ? configured : globalList(process.env.WARDMOTE_OMP_CONFIG_FILES);
    if (configFiles.length) env.PI_CONFIG_FILES = configFiles.join(path.delimiter);
    const result = await runChildProcess(
      `omp-model-probe-${startedAt}-${Math.random().toString(16).slice(2)}`,
      resolveOmpCommand(config),
      ["bench", input.selector, "--runs", "1", "--par", "1", "--max-tokens", "1", "--prompt", "ping", "--json"],
      { cwd: os.tmpdir(), env, timeoutSec: OMP_MODEL_PROBE_TIMEOUT_SEC, graceSec: 2, onLog: async () => {} },
    );
    const latencyMs = Date.now() - startedAt;
    if (result.timedOut) {
      return { ok: false, latencyMs, costUsd: null, error: `omp bench timed out after ${OMP_MODEL_PROBE_TIMEOUT_SEC}s` };
    }
    const report = readBenchResult(result.stdout);
    if ((result.exitCode ?? 1) !== 0 && report.ok) {
      return { ok: false, latencyMs, costUsd: report.costUsd, error: `omp bench exited ${result.exitCode}` };
    }
    return { ok: report.ok, latencyMs, costUsd: report.costUsd, ...(report.error ? { error: report.error } : {}) };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - startedAt, costUsd: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await prepared.cleanup().catch(() => {});
  }
}
