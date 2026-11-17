// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { normalizeGoogleWorkspaceSettings, type ToolConnection } from "@tickernelz/wardmote-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { googleWorkspaceSettings, configureGoogleWorkspace, startOAuth, revokeConnectionGrant } = vi.hoisted(() => ({
  googleWorkspaceSettings: vi.fn(),
  configureGoogleWorkspace: vi.fn(),
  startOAuth: vi.fn(),
  revokeConnectionGrant: vi.fn(),
}));

vi.mock("@/api/tools", () => ({ toolsApi: { googleWorkspaceSettings, configureGoogleWorkspace, startOAuth, revokeConnectionGrant } }));

import { GoogleWorkspaceSettingsPanel, parseGoogleIdList } from "./GoogleWorkspaceSettingsPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const connection = { id: "conn-1", credentialPolicy: "shared", config: { sourceTemplateKey: "google-workspace" } } as unknown as ToolConnection;
let container: HTMLDivElement;
let root: Root;

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

function view(capabilities: Record<string, string>, missingScopes: string[] = []) {
  const settings = normalizeGoogleWorkspaceSettings({ capabilities, domain: "example.com" });
  return { settings, requiredScopes: [], grants: [{ grantId: "g1", kind: "organization", grantedScopes: [], missingScopes }] };
}

async function render(canConfigure = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root.render(<QueryClientProvider client={client}><GoogleWorkspaceSettingsPanel connection={connection} canConfigure={canConfigure} /></QueryClientProvider>));
  await flush();
}

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === name);
  if (!found) throw new Error(`No button "${name}"`);
  return found as HTMLButtonElement;
}

async function typeInto(element: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("GoogleWorkspaceSettingsPanel", () => {
  it("revokes Google access after confirmation and then offers sign-in", async () => {
    googleWorkspaceSettings.mockResolvedValueOnce(view({ sheets: "edit" }));
    googleWorkspaceSettings.mockResolvedValue({ ...view({ sheets: "edit" }), grants: [] });
    revokeConnectionGrant.mockResolvedValue({});
    await render();
    await act(async () => button("Revoke Google access").click());
    expect(revokeConnectionGrant).not.toHaveBeenCalled();
    const confirm = [...document.body.querySelectorAll('[role="alertdialog"] button')].find((candidate) => candidate.textContent?.trim() === "Revoke") as HTMLButtonElement;
    await act(async () => confirm.click());
    await flush();
    await flush();
    expect(revokeConnectionGrant).toHaveBeenCalledWith("conn-1", "g1");
    expect(container.textContent).toContain("No Google account is signed in");
    expect(button("Sign in with Google")).toBeTruthy();
  });

  it("saves levels, policy and Drive limits pasted as links", async () => {
    googleWorkspaceSettings.mockResolvedValue(view({ sheets: "edit" }));
    configureGoogleWorkspace.mockImplementation(async (_id, input) => view(input.capabilities));
    await render();
    expect(button("Save").disabled).toBe(true);
    const driveRead = [...container.querySelector('[aria-labelledby="gws-tier-drive"]')!.querySelectorAll("button")].find((b) => b.textContent === "Read")!;
    await act(async () => driveRead.click());
    const folders = container.querySelectorAll("textarea")[0] as HTMLTextAreaElement;
    await typeInto(folders, "https://drive.google.com/drive/folders/FOLDER_1?usp=sharing\nFOLDER_2");
    const destructive = container.querySelector<HTMLSelectElement>('select[id$="-destructive"]')!;
    await act(async () => {
      destructive.value = "allow";
      destructive.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => button("Save").click());
    await flush();
    expect(configureGoogleWorkspace).toHaveBeenCalledWith("conn-1", expect.objectContaining({
      capabilities: expect.objectContaining({ drive: "read", sheets: "edit" }),
      classPolicy: expect.objectContaining({ destructive: "allow", external: "require_approval" }),
      scope: { driveFolderIds: ["FOLDER_1", "FOLDER_2"], sharedDriveIds: [], spreadsheetIds: [] },
      domain: "example.com",
    }));
  });

  it("asks Google for scopes the saved levels still miss", async () => {
    googleWorkspaceSettings.mockResolvedValue(view({ drive: "delete_share" }, ["https://www.googleapis.com/auth/drive"]));
    startOAuth.mockResolvedValue({ authorizationUrl: "about:blank#google" });
    await render();
    expect(container.textContent).toContain("Google has not granted 1 scope");
    await act(async () => button("Grant the added access in Google").click());
    await flush();
    expect(startOAuth).toHaveBeenCalledWith("conn-1", { asCurrentUser: false });
  });

  it("does not load settings for someone who cannot configure the connection", async () => {
    await render(false);
    expect(googleWorkspaceSettings).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Only someone who can configure");
  });

  it("reads IDs out of Drive and Sheets links", () => {
    expect(parseGoogleIdList("https://docs.google.com/spreadsheets/d/SHEET_1/edit#gid=0, bad!id, SHEET_1")).toEqual(["SHEET_1"]);
  });
});
