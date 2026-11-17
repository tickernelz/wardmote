import { describe, expect, it } from "vitest";

import {
  GOOGLE_WORKSPACE_DEFAULT_CLASS_POLICY,
  GOOGLE_WORKSPACE_SERVICE_IDS,
  GOOGLE_WORKSPACE_TIERS,
  GOOGLE_WORKSPACE_TIER_SCOPES,
  googleWorkspaceScopeClass,
  googleWorkspaceScopesFor,
  normalizeGoogleWorkspaceSettings,
  parseGoogleClientSecretJson,
} from "./google-workspace-settings.js";

const DRIVE = "https://www.googleapis.com/auth/drive";

describe("Google Workspace settings", () => {
  it("defaults every service off and applies the approved class policy", () => {
    const settings = normalizeGoogleWorkspaceSettings(undefined);
    expect(Object.values(settings.capabilities).every((tier) => tier === "off")).toBe(true);
    expect(settings.classPolicy).toEqual(GOOGLE_WORKSPACE_DEFAULT_CLASS_POLICY);
    expect(settings.classPolicy).toMatchObject({ write: "allow", destructive: "require_approval", external: "require_approval", execute: "block" });
  });

  it("drops values it does not recognise instead of trusting them", () => {
    const settings = normalizeGoogleWorkspaceSettings({
      capabilities: { drive: "everything", sheets: "edit" },
      classPolicy: { destructive: "yes", external: "allow" },
      methodOverrides: { "drive.files.delete": "allow", "not a method": "allow", "sheets.spreadsheets.batchUpdate#deleteSheet": "nope" },
      scope: { driveFolderIds: ["F1", "F1", "../etc", 7] },
      domain: "Example.COM",
    });
    expect(settings.capabilities).toMatchObject({ drive: "off", sheets: "edit" });
    expect(settings.classPolicy).toMatchObject({ destructive: "require_approval", external: "allow" });
    expect(settings.methodOverrides).toEqual({ "drive.files.delete": "allow" });
    expect(settings.scope.driveFolderIds).toEqual(["F1"]);
    expect(settings.domain).toBe("example.com");
  });

  it("asks for the restricted drive scope only at the delete-and-share tier", () => {
    for (const tier of GOOGLE_WORKSPACE_TIERS) {
      if (tier === "off") continue;
      expect(GOOGLE_WORKSPACE_TIER_SCOPES.drive[tier].includes(DRIVE), tier).toBe(tier === "delete_share");
    }
  });

  it("stays under the 25-scope consent ceiling with every service at the highest tier", () => {
    const all = googleWorkspaceScopesFor(Object.fromEntries(GOOGLE_WORKSPACE_SERVICE_IDS.map((service) => [service, "delete_share"])));
    expect(all.length).toBeLessThanOrEqual(25);
    expect(all).toContain("openid");
    expect(googleWorkspaceScopesFor({ sheets: "read" })).toEqual(["openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/spreadsheets.readonly"]);
  });
});

describe("parseGoogleClientSecretJson", () => {
  const redirect = "https://wardmote.example.com/api/tools/oauth/callback";
  const web = (redirectUris: string[], secret = "s3cret") =>
    JSON.stringify({ web: { client_id: "1-abc.apps.googleusercontent.com", project_id: "proj", client_secret: secret, redirect_uris: redirectUris } });

  it("reads a web client whose redirect URI matches this instance", () => {
    expect(parseGoogleClientSecretJson(web([redirect]), redirect)).toEqual({
      clientId: "1-abc.apps.googleusercontent.com",
      clientSecret: "s3cret",
      projectId: "proj",
      redirectUris: [redirect],
      problems: [],
    });
  });

  it("names what is wrong with the file", () => {
    expect(parseGoogleClientSecretJson("{", redirect).problems).toEqual(["not_json"]);
    expect(parseGoogleClientSecretJson("{}", redirect).problems).toEqual(["no_client"]);
    expect(parseGoogleClientSecretJson(web(["https://other.example/cb"]), redirect).problems).toEqual(["redirect_uri_missing"]);
    expect(parseGoogleClientSecretJson(web([redirect], ""), redirect).problems).toEqual(["missing_secret"]);
    expect(parseGoogleClientSecretJson(JSON.stringify({ installed: { client_id: "x", client_secret: "y" } }), redirect).problems).toEqual(["installed_client"]);
  });
});

describe("googleWorkspaceScopeClass", () => {
  it("marks the restricted Drive and Gmail scopes", () => {
    expect(googleWorkspaceScopeClass(DRIVE)).toBe("restricted");
    expect(googleWorkspaceScopeClass(`${DRIVE}.readonly`)).toBe("restricted");
    expect(googleWorkspaceScopeClass(`${DRIVE}.file`)).toBe("sensitive");
    expect(googleWorkspaceScopeClass("https://www.googleapis.com/auth/gmail.send")).toBe("sensitive");
    expect(googleWorkspaceScopeClass("openid")).toBe("basic");
  });
});
