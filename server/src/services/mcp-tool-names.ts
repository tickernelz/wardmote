import { createHash } from "node:crypto";
import { WARDMOTE_ASSIGNED_MCP_SERVER_NAME } from "@tickernelz/wardmote-adapter-utils/wardmote-mcp";

// Claude includes this namespace in its 128-character tool-name limit.
// Gateway punctuation is normalized one-for-one by the MCP client.
export const MAX_GATEWAY_TOOL_NAME_LENGTH = 128 - `mcp__${WARDMOTE_ASSIGNED_MCP_SERVER_NAME}__`.length;

/** Preserve existing short names; aliases still resolve through gateway metadata. */
export function boundedMcpToolName(name: string, identity: readonly string[]): string {
  if (name.length <= MAX_GATEWAY_TOOL_NAME_LENGTH) return name;
  const hash = createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 16);
  const separator = name.indexOf(":");
  const namespace = name.slice(0, separator < 0 ? name.length : separator).slice(0, 32);
  const tool = separator < 0 ? "tool" : name.slice(separator + 1);
  const budget = MAX_GATEWAY_TOOL_NAME_LENGTH - namespace.length - hash.length - 2;
  return `${namespace}:${tool.slice(0, budget)}-${hash}`;
}
