import { isBrowserUseConnection } from "./browser-use-client.js";
import { isGoogleWorkspaceConnection } from "./google-workspace/runtime.js";

export function isGatewayRestConnection(connection: { transport: string; config?: Record<string, unknown> }): boolean {
  return isBrowserUseConnection(connection) || isGoogleWorkspaceConnection(connection);
}
