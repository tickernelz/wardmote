import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveDefaultBackupDir,
  resolveDefaultEmbeddedPostgresDir,
  resolveDefaultLogsDir,
  resolveDefaultSecretsKeyFilePath,
  resolveDefaultStorageDir,
  resolveWardmoteConfigPathForInstance,
  resolveWardmoteInstanceRoot,
} from "./home-paths.js";

let userHome: string;

async function homePaths() {
  vi.resetModules();
  return import("./home-paths.js");
}

describe("default home", () => {
  beforeEach(() => {
    userHome = fs.mkdtempSync(path.join(os.tmpdir(), "wardmote-home-"));
    vi.spyOn(os, "homedir").mockReturnValue(userHome);
    vi.stubEnv("WARDMOTE_HOME", "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(userHome, { recursive: true, force: true });
  });

  it("starts a new install in ~/.wardmote", async () => {
    const { resolveWardmoteHomeDir } = await homePaths();
    expect(resolveWardmoteHomeDir()).toBe(path.join(userHome, ".wardmote"));
  });

  it("lets an explicit home win", async () => {
    vi.stubEnv("WARDMOTE_HOME", "/srv/wardmote");
    const { resolveWardmoteHomeDir } = await homePaths();
    expect(resolveWardmoteHomeDir()).toBe("/srv/wardmote");
  });

  it("expands a config path without remapping it to another home", async () => {
    const { resolveHomeAwarePath } = await homePaths();
    expect(resolveHomeAwarePath("~/.wardmote/instances/default/db")).toBe(path.join(userHome, ".wardmote/instances/default/db"));
    expect(resolveHomeAwarePath("/srv/db")).toBe("/srv/db");
  });

});

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("home path resolution", () => {
  it("resolves config and runtime data directly under the instance root", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "wardmote-home-paths-"));
    process.env.WARDMOTE_HOME = home;
    delete process.env.WARDMOTE_INSTANCE_ID;

    const instanceRoot = path.join(home, "instances", "default");
    expect(resolveWardmoteInstanceRoot()).toBe(instanceRoot);
    expect(resolveWardmoteConfigPathForInstance()).toBe(path.join(instanceRoot, "config.json"));
    expect(resolveDefaultEmbeddedPostgresDir()).toBe(path.join(instanceRoot, "db"));
    expect(resolveDefaultBackupDir()).toBe(path.join(instanceRoot, "data", "backups"));
    expect(resolveDefaultLogsDir()).toBe(path.join(instanceRoot, "logs"));
    expect(resolveDefaultStorageDir()).toBe(path.join(instanceRoot, "data", "storage"));
    expect(resolveDefaultSecretsKeyFilePath()).toBe(path.join(instanceRoot, "secrets", "master.key"));
  });
});
