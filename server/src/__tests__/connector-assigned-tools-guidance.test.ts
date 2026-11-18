import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderWardmoteWakePrompt } from "@tickernelz/wardmote-adapter-utils/server-utils";
import { annotateConnectorSkills, applyConnectorSkills, prepareConnectorSkillDelivery } from "../services/connector-runtime.js";

const PREAMBLE = "### Calling assigned connector tools";

const catalog = annotateConnectorSkills(
  { adapterType: "omp_local", supported: true, mode: "ephemeral", desiredSkills: [], entries: [], warnings: [] },
  [],
).entries.map((entry) => entry.runtimeName);

async function deliveredInstructions(connectorKeys: string[]) {
  const config = await applyConnectorSkills({}, [], connectorKeys.map((key) => ({
    key,
    label: key,
    skillKey: `tickernelz/wardmote/${key}`,
    resources: [{ id: `resource-${key}`, label: key, connectionId: `connection-${key}` }],
    tools: [],
  })));
  return (await prepareConnectorSkillDelivery(config, "omp_local")).instructions;
}

describe("assigned connector tool guidance across the connector catalog", () => {
  const previousHome = process.env.WARDMOTE_HOME;
  let home: string;

  beforeAll(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "wardmote-connector-guidance-"));
    process.env.WARDMOTE_HOME = home;
  });

  afterAll(async () => {
    if (previousHome === undefined) delete process.env.WARDMOTE_HOME;
    else process.env.WARDMOTE_HOME = previousHome;
    execFileSync("chmod", ["-R", "u+w", home]);
    await fs.rm(home, { recursive: true, force: true });
  });

  it("covers every catalog connector", () => {
    expect(catalog).toEqual(expect.arrayContaining(["google-workspace", "browser-use-cloud", "speko", "local-browser", "slack", "openwa", "agentmail"]));
  });

  it.each(catalog)("puts the call path above the %s skill only for runtimes that do not load wardmote-assigned", async (key) => {
    const instructions = await deliveredInstructions([key]);
    expect(instructions).toContain(`### ${key}`);
    const overHttp = renderWardmoteWakePrompt({ connectorSkillInstructions: instructions }, { assignedToolsCliEnv: "WARDMOTE_TOOL_CLI" });
    expect(overHttp.split(PREAMBLE)).toHaveLength(2);
    expect(overHttp.indexOf(PREAMBLE)).toBeLessThan(overHttp.indexOf(`### ${key}`));
    for (const fact of ["wardmote-assigned", "$WARDMOTE_RUNTIME_MCP_SERVERS", "$WARDMOTE_RUNTIME_MCP_TOKENS", '"method":"tools/list"', '"method":"tools/call"', "app.app-gallery-google-workspace-<id>:google-search-methods", '"$WARDMOTE_TOOL_CLI" call', "/api/tool-gateway/*", "google_workspace.*", "fabric `mcp.*`"]) {
      expect(overHttp).toContain(fact);
    }
    const native = renderWardmoteWakePrompt({ connectorSkillInstructions: instructions });
    expect(native).toContain(`### ${key}`);
    expect(native).not.toContain(PREAMBLE);
  });

  it("states the call path once for a run holding every connector", async () => {
    const prompt = renderWardmoteWakePrompt(
      { connectorSkillInstructions: await deliveredInstructions(catalog) },
      { assignedToolsCliEnv: "WARDMOTE_TOOL_CLI" },
    );
    expect(prompt.split(PREAMBLE)).toHaveLength(2);
    expect(prompt.split("## Assigned connector skills")).toHaveLength(2);
  });

  it("states the call path for assigned MCP connections that bring no connector skill", () => {
    expect(renderWardmoteWakePrompt({}, { assignedToolsCliEnv: "WARDMOTE_TOOL_CLI" })).toContain(PREAMBLE);
    expect(renderWardmoteWakePrompt({}, {})).toBe("");
  });
});
