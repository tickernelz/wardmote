import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readBrandedStaticHtmlForPath, readBrandedStaticIndexHtml } from "../static-index-html.js";

describe("static SPA fallback HTML", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serves the standalone share page for public share links and the app shell elsewhere", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wardmote-share-html-"));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, "index.html"), "<html><body>APP_SHELL</body></html>");
    expect(readBrandedStaticHtmlForPath(dir, "/s/Ab3dE5gH9k")).toContain("APP_SHELL");
    fs.writeFileSync(path.join(dir, "share.html"), "<html><body>SHARE_PAGE</body></html>");
    for (const sharePath of ["/s/Ab3dE5gH9k", "/s/Ab3dE5gH9k/", "/s/Ab3dE5gH9k/issues/0f6c"]) {
      expect(readBrandedStaticHtmlForPath(dir, sharePath)).toContain("SHARE_PAGE");
    }
    for (const appPath of ["/", "/s", "/ACM/issues/ACM-1", "/s/Ab3dE5gH9k/documents", "/settings/s/x"]) {
      expect(readBrandedStaticHtmlForPath(dir, appPath)).toContain("APP_SHELL");
    }
  });

  it("ignores retired snippet settings in managed and self-hosted static HTML", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wardmote-cloud-html-"));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, "index.html"), "<html><body>App</body></html>");
    vi.stubEnv("WARDMOTE_CLOUD_UI_SNIPPET", '<script src="https://example.com/chat.js"></script>');
    vi.stubEnv("WARDMOTE_CLOUD_UI_SNIPPET_B64", Buffer.from('<script src="https://example.com/legacy.js"></script>').toString("base64"));
    vi.stubEnv("WARDMOTE_CLOUD_TENANT_SERVER_TOKEN", undefined);
    vi.stubEnv("WARDMOTE_MANAGED_CONFIG", undefined);
    expect(readBrandedStaticIndexHtml(dir)).not.toContain("chat.js");
    vi.stubEnv("WARDMOTE_MANAGED_CONFIG", "{}");
    expect(readBrandedStaticIndexHtml(dir)).not.toContain("chat.js");
    vi.stubEnv("WARDMOTE_CLOUD_UI_SNIPPET", undefined);
    expect(readBrandedStaticIndexHtml(dir)).not.toContain("legacy.js");
  });

  it("serves the current index.html instead of reusing stale asset hashes", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "wardmote-static-index-"));
    tempDirs.push(tempDir);
    const indexPath = path.join(tempDir, "index.html");
    const app = express();
    app.get(/.*/, (_req, res) => {
      res
        .status(200)
        .set("Content-Type", "text/html")
        .set("Cache-Control", "no-cache")
        .end(readBrandedStaticIndexHtml(tempDir));
    });

    fs.writeFileSync(
      indexPath,
      '<html><body><script type="module" src="/assets/index-old.js"></script></body></html>',
      "utf8",
    );
    await expect(request(app).get("/PAP/issues/PAP-9939")).resolves.toMatchObject({
      text: expect.stringContaining("/assets/index-old.js"),
    });

    fs.writeFileSync(
      indexPath,
      '<html><body><script type="module" src="/assets/index-new.js"></script></body></html>',
      "utf8",
    );
    const res = await request(app).get("/PAP/issues/PAP-9939");
    expect(res.text).toContain("/assets/index-new.js");
    expect(res.text).not.toContain("/assets/index-old.js");
  });
});
