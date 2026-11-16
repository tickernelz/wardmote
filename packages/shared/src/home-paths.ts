import os from "node:os";
import path from "node:path";

export const DEFAULT_WARDMOTE_INSTANCE_ID = "default";
export const WARDMOTE_CONFIG_BASENAME = "config.json";
export const WARDMOTE_ENV_FILENAME = ".env";

const PATH_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;

export function expandHomePrefix(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.resolve(os.homedir(), value.slice(2));
  return value;
}

export const WARDMOTE_HOME_DIRNAME = ".wardmote";
export function resolveDefaultWardmoteHomeDir(userHome: string = os.homedir()): string {
  return path.resolve(userHome, WARDMOTE_HOME_DIRNAME);
}

export function resolveWardmoteHomeDir(homeOverride?: string): string {
  const raw = homeOverride?.trim() || process.env.WARDMOTE_HOME?.trim();
  if (raw) return path.resolve(expandHomePrefix(raw));
  return resolveDefaultWardmoteHomeDir();
}

export function resolveWardmoteInstanceId(instanceIdOverride?: string): string {
  const raw = instanceIdOverride?.trim() || process.env.WARDMOTE_INSTANCE_ID?.trim() || DEFAULT_WARDMOTE_INSTANCE_ID;
  if (!PATH_SEGMENT_RE.test(raw)) {
    throw new Error(`Invalid WARDMOTE_INSTANCE_ID '${raw}'.`);
  }
  return raw;
}

export function resolveWardmoteInstanceRoot(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveWardmoteHomeDir(input.homeDir), "instances", resolveWardmoteInstanceId(input.instanceId));
}

export function resolveWardmoteInstanceConfigPath(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveWardmoteInstanceRoot(input), WARDMOTE_CONFIG_BASENAME);
}

export function resolveWardmoteConfigPathForInstance(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return resolveWardmoteInstanceConfigPath(input);
}

export function resolveWardmoteEnvPathForConfig(configPath: string): string {
  return path.resolve(path.dirname(configPath), WARDMOTE_ENV_FILENAME);
}

export function resolveDefaultEmbeddedPostgresDir(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveWardmoteInstanceRoot(input), "db");
}

export function resolveDefaultLogsDir(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveWardmoteInstanceRoot(input), "logs");
}

export function resolveDefaultSecretsKeyFilePath(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveWardmoteInstanceRoot(input), "secrets", "master.key");
}

export function resolveDefaultStorageDir(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveWardmoteInstanceRoot(input), "data", "storage");
}

export function resolveDefaultBackupDir(input: {
  homeDir?: string;
  instanceId?: string;
} = {}): string {
  return path.resolve(resolveWardmoteInstanceRoot(input), "data", "backups");
}

export function resolveHomeAwarePath(value: string): string {
  return path.resolve(expandHomePrefix(value));
}
