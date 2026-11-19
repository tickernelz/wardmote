import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { serviceWorkerBuildIdFromFileName } from "./service-worker-build-id";
import {
  SERVICE_WORKER_BUILD_ID_PLACEHOLDER,
  serviceWorkerBuildIdPlugin,
  stampServiceWorkerBuildId,
} from "./vite-sw-build-id";

const swSource = () =>
  `const BUILD_ID = "${SERVICE_WORKER_BUILD_ID_PLACEHOLDER}";\n` +
  "const CACHE_NAME = `wardmote-${BUILD_ID}`;\n";

describe("stampServiceWorkerBuildId", () => {
  it("replaces the placeholder with the build id and leaves no placeholder", () => {
    const out = stampServiceWorkerBuildId(swSource(), "index-abc123");
    expect(out).toContain("index-abc123");
    expect(out).not.toContain(SERVICE_WORKER_BUILD_ID_PLACEHOLDER);
  });

  it("produces different worker bytes for different build ids", () => {
    // This is the whole point: a new bundle -> a new sw.js -> a new worker ->
    // parked tabs reload. Identical build ids must stay byte-identical so the
    // worker does not churn when the app did not change.
    const a = stampServiceWorkerBuildId(swSource(), "index-aaaaaa");
    const b = stampServiceWorkerBuildId(swSource(), "index-bbbbbb");
    const again = stampServiceWorkerBuildId(swSource(), "index-aaaaaa");
    expect(a).not.toEqual(b);
    expect(a).toEqual(again);
  });

  it("throws when the placeholder is missing so a drifted worker fails the build", () => {
    expect(() => stampServiceWorkerBuildId("const CACHE_NAME = 'wardmote';", "x")).toThrow(
      /placeholder/,
    );
  });

  it("throws on an empty build id rather than shipping a nameless cache", () => {
    expect(() => stampServiceWorkerBuildId(swSource(), "")).toThrow();
  });
});

describe("serviceWorkerBuildIdFromFileName", () => {
  it("uses the content-hashed entry file name", () => {
    expect(serviceWorkerBuildIdFromFileName("assets/index-BHbrFFmp.js")).toBe("index-BHbrFFmp");
  });

  it("derives the same id from the page's entry script URL path", () => {
    expect(serviceWorkerBuildIdFromFileName(new URL("https://w.example/assets/index-BHbrFFmp.js").pathname)).toBe(
      serviceWorkerBuildIdFromFileName("assets/index-BHbrFFmp.js"),
    );
  });

  it("sanitizes characters that are unsafe in a cache name", () => {
    expect(serviceWorkerBuildIdFromFileName("assets/index @weird!.js")).toBe("index--weird-");
  });
});

describe("public/sw.js contract", () => {
  it("still contains the placeholder the plugin rewrites", () => {
    const swPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../public/sw.js",
    );
    const source = fs.readFileSync(swPath, "utf8");
    expect(source).toContain(SERVICE_WORKER_BUILD_ID_PLACEHOLDER);
  });
});

describe("serviceWorkerBuildIdPlugin", () => {
  it("stamps the worker with the app entry even when the share page entry comes first", () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-build-id-"));
    try {
      fs.writeFileSync(path.join(outDir, "sw.js"), swSource());
      const plugin = serviceWorkerBuildIdPlugin() as unknown as {
        configResolved: (config: { build: { outDir: string } }) => void;
        generateBundle: (options: unknown, bundle: Record<string, unknown>) => void;
        closeBundle: () => void;
      };
      plugin.configResolved({ build: { outDir } });
      plugin.generateBundle({}, {
        "assets/share-Sh4re000.js": { type: "chunk", isEntry: true, name: "share", fileName: "assets/share-Sh4re000.js" },
        "assets/index-App00000.js": { type: "chunk", isEntry: true, name: "index", fileName: "assets/index-App00000.js" },
      });
      plugin.closeBundle();
      const stamped = fs.readFileSync(path.join(outDir, "sw.js"), "utf8");
      expect(stamped).toContain("index-App00000");
      expect(stamped).not.toContain("share-Sh4re000");
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
