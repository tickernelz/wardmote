export const RETIRED_ENV_PREFIX = "PAPERCLIP_";
const CURRENT_ENV_PREFIX = "WARDMOTE_";

/** Maps a retired-prefix env key to its current name so guards treat both alike. */
export function currentEnvKey(key: string): string {
  return key.startsWith(RETIRED_ENV_PREFIX) ? CURRENT_ENV_PREFIX + key.slice(RETIRED_ENV_PREFIX.length) : key;
}
