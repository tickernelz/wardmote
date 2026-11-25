import path from "node:path";
import type { AdapterExecutionTarget } from "@tickernelz/wardmote-adapter-utils/execution-target";
import { writeWardmoteMcpMount } from "@tickernelz/wardmote-adapter-utils/wardmote-mcp-mount";
import type { RunToolProfile } from "@tickernelz/wardmote-adapter-utils/tool-profile";
import type { OmpFallbackHold } from "./model-fallback.js";

export const OMP_ASYNC_BASH_TIMEOUT_SEC = 3600;
export const OMP_TOOL_GUARD_FILE_NAME = "wardmote-tool-guard.js";

export interface OmpToolGuardExtension {
  path: string;
  cleanup: () => Promise<void>;
}

export const OMP_READ_ONLY_BLOCK_REASON =
  "This run uses the read_only tool profile, so this tool cannot change files, skills, memory or agents here. Do not retry or work around it; writes need the owner's approval, so request that approval instead.";

const READ_ONLY_GATE = `const READ_ONLY_REASON = ${JSON.stringify(OMP_READ_ONLY_BLOCK_REASON)};
const READ_ONLY_DENIED_TOOLS = new Set(["edit", "apply_patch", "ast_edit", "tts", "retain", "memory_edit", "learn", "manage_skill", "vibe_spawn", "vibe_send"]);
const LSP_READ_ACTIONS = new Set(["diagnostics", "definition", "type_definition", "implementation", "references", "hover", "symbols", "status", "capabilities", "reload"]);
const GITHUB_READ_OPS = new Set(["repo_view", "file_read", "search_issues", "search_prs", "search_code", "search_commits", "search_repos", "run_watch"]);

function lower(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function writeTargetsDevice(input) {
  return lower(input && input.path).replace(/^\\[/, "").startsWith("xd://");
}

function lspMayWrite(input) {
  const action = lower(input && input.action);
  if (LSP_READ_ACTIONS.has(action)) return false;
  if (action === "code_actions") return input.apply === true;
  if (action === "rename" || action === "rename_file") return input.apply !== false;
  return true;
}

function taskRequestsIsolation(input) {
  if (input.isolated === true) return true;
  return Array.isArray(input.tasks) && input.tasks.some((item) => item && item.isolated === true);
}

export function readOnlyBlock(event) {
  const name = event.toolName;
  const input = event.input && typeof event.input === "object" ? event.input : {};
  let blocked = READ_ONLY_DENIED_TOOLS.has(name);
  if (name === "write") blocked = !writeTargetsDevice(input);
  else if (name === "lsp") blocked = lspMayWrite(input);
  else if (name === "github") blocked = !GITHUB_READ_OPS.has(lower(input.op));
  else if (name === "hub") blocked = lower(input.op) === "send";
  else if (name === "task") blocked = taskRequestsIsolation(input);
  return blocked ? { block: true, reason: READ_ONLY_REASON } : undefined;
}

`;

function fallbackHoldSource(hold: OmpFallbackHold): string {
  return `const HOLD = ${JSON.stringify(hold)};
const FIRST_EVENT_ENV_KEYS = ["PI_STREAM_FIRST_EVENT_TIMEOUT_MS", "PI_OPENAI_STREAM_FIRST_EVENT_TIMEOUT_MS"];
const TRANSIENT_ERROR_RE = /\\b(timed out|timeout|etimedout|econnreset|econnrefused|socket hang up|overloaded|server error|internal error|service unavailable|bad gateway|gateway timeout|50[0234]|stream (?:closed|error)|temporarily unavailable|no available accounts?|concurrency limit|too many concurrent|gateway_concurrency_limit|incomplete or invalid response|stopped the response)\\b/i;
const SWITCH_NOW_RE = /\\b(refus(?:al|ed)|cannot assist|can't assist|content policy|safety (?:policy|filter)|429|too many requests|rate[_ -]?limit|quota|usage limit|insufficient|credit|unauthori[sz]ed|forbidden|invalid api key|401|403|prompt is too long|context_length_exceeded|maximum context length)\\b/i;

function bareSelector(value) {
  return typeof value === "string" ? value.trim().replace(/:(?:auto|off|minimal|low|medium|high|xhigh|max)$/i, "") : "";
}

function transientFailure(message) {
  const text = typeof message === "string" ? message : "";
  if (/\\bconcurrency limit|too many concurrent|gateway_concurrency_limit/i.test(text)) return true;
  return TRANSIENT_ERROR_RE.test(text) && !SWITCH_NOW_RE.test(text);
}

function installFallbackHold(pi) {
  const savedEnv = Object.fromEntries(FIRST_EVENT_ENV_KEYS.map((key) => [key, process.env[key]]));
  const held = new Set();
  let active = HOLD.start;
  let failures = 0;

  function onProbation() {
    return Boolean(HOLD.probation) && active === HOLD.probation.selector;
  }

  function applyFirstEventLimit() {
    for (const key of FIRST_EVENT_ENV_KEYS) {
      if (onProbation()) process.env[key] = String(HOLD.probation.firstEventTimeoutSec * 1000);
      else if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  }

  function holdChain(registry) {
    if (!registry) return;
    const until = Date.now() + HOLD.holdMs;
    for (const selector of HOLD.selectors) {
      if (selector === active || selector === HOLD.primary) continue;
      if (held.has(selector)) {
        registry.suppressSelector(selector, until);
      } else if (!registry.isSelectorSuppressed(selector)) {
        registry.suppressSelector(selector, until);
        held.add(selector);
      }
    }
  }

  function releaseChain(registry) {
    if (registry) for (const selector of held) registry.clearSuppressedSelector(selector);
    held.clear();
  }

  function attemptsFor() {
    return onProbation() ? HOLD.probation.holdAttempts : HOLD.holdAttempts;
  }

  applyFirstEventLimit();

  pi.on("turn_start", (_event, ctx) => {
    if (failures === 0) holdChain(ctx.modelRegistry);
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (!message || message.role !== "assistant") return;
    const served = message.provider && message.model ? bareSelector(message.provider + "/" + message.model) : "";
    if (served && served !== active && HOLD.selectors.includes(served)) {
      active = served;
      failures = 0;
      applyFirstEventLimit();
    }
    if (message.stopReason === "aborted") return;
    if (message.stopReason === "error") {
      failures += 1;
      if (!transientFailure(message.errorMessage) || failures >= attemptsFor()) releaseChain(ctx.modelRegistry);
      else holdChain(ctx.modelRegistry);
      return;
    }
    failures = 0;
    if (ctx.modelRegistry && served) ctx.modelRegistry.clearSuppressedSelector(served);
    holdChain(ctx.modelRegistry);
  });

  pi.on("retry_fallback_applied", (event, ctx) => {
    const to = bareSelector(event.to);
    if (!HOLD.selectors.includes(to)) return;
    releaseChain(ctx.modelRegistry);
    active = to;
    failures = 0;
    applyFirstEventLimit();
    holdChain(ctx.modelRegistry);
  });
}

`;
}

export function renderOmpToolGuardExtension(profile: RunToolProfile = "full", hold: OmpFallbackHold | null = null): string {
  const readOnly = profile === "read_only";
  return `const ASYNC_TIMEOUT_SEC = ${OMP_ASYNC_BASH_TIMEOUT_SEC};

function filled(value) {
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  return false;
}

function readyHasCondition(ready) {
  if (!ready || typeof ready !== "object") return false;
  return filled(ready.log) || filled(ready.host) || filled(ready.port) || filled(ready.timeout);
}

export function guardBashInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  if (typeof input.name === "string" && input.name.trim().length > 0) return null;
  const next = { ...input };
  let changed = false;
  if (next.async === true && next.timeout == null) {
    next.timeout = ASYNC_TIMEOUT_SEC;
    changed = true;
  }
  if ("ready" in next && !readyHasCondition(next.ready)) {
    delete next.ready;
    changed = true;
  }
  return changed ? next : null;
}

${readOnly ? READ_ONLY_GATE : ""}${hold ? fallbackHoldSource(hold) : ""}export default function wardmoteToolGuard(pi) {
${hold ? "  installFallbackHold(pi);\n" : ""}  pi.on("tool_call", (event) => {
${readOnly ? "    const blocked = readOnlyBlock(event);\n    if (blocked) return blocked;\n" : ""}    if (event.toolName !== "bash") return undefined;
    const input = guardBashInput(event.input);
    return input ? { input } : undefined;
  });
}
`;
}

export async function writeOmpToolGuardExtension(input: {
  runId: string;
  target: AdapterExecutionTarget | null | undefined;
  remote: boolean;
  env: Record<string, string>;
  remoteRootDir: string | null;
  cwd: string;
  timeoutSec: number;
  graceSec: number;
  profile: RunToolProfile;
  fallbackHold?: OmpFallbackHold | null;
}): Promise<OmpToolGuardExtension> {
  const mount = await writeWardmoteMcpMount({
    runId: input.runId,
    target: input.target,
    remote: input.remote,
    content: renderOmpToolGuardExtension(input.profile, input.fallbackHold ?? null),
    fileName: OMP_TOOL_GUARD_FILE_NAME,
    localPrefix: "wardmote-omp-guard-",
    remoteDir: path.posix.join(
      input.remoteRootDir ?? path.posix.join(input.cwd, ".wardmote-runtime", "omp"),
      "tool-guard",
    ),
    cwd: input.cwd,
    env: input.env,
    timeoutSec: input.timeoutSec,
    graceSec: input.graceSec,
  });
  return { path: mount.filePath, cleanup: mount.cleanup };
}
