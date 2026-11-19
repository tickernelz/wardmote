import fs from "node:fs";
import path from "node:path";
import { applyUiBranding } from "./ui-branding.js";

const PUBLIC_SHARE_PAGE_PATH = /^\/s\/[^/]+(?:\/issues\/[^/]+)?\/?$/;

export function readBrandedStaticIndexHtml(uiDist: string, fileName = "index.html"): string {
  return applyUiBranding(fs.readFileSync(path.join(uiDist, fileName), "utf-8"));
}

export function readBrandedStaticHtmlForPath(uiDist: string, requestPath: string): string {
  const sharePage = PUBLIC_SHARE_PAGE_PATH.test(requestPath) && fs.existsSync(path.join(uiDist, "share.html"));
  return readBrandedStaticIndexHtml(uiDist, sharePage ? "share.html" : "index.html");
}
