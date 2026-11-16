import { isPlainRecord } from "../lib/agent-records.js";

export function readPackageMetadataBlock(metadata: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  return isPlainRecord(metadata?.wardmote) ? metadata.wardmote : null;
}
