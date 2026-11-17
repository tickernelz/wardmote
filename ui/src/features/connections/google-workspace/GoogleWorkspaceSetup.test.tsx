// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GOOGLE_WORKSPACE_DEFAULT_CAPABILITIES,
  GoogleWorkspaceSetup,
  googleWorkspaceEnableApisUrl,
  googleWorkspaceSettingsInput,
  type GoogleWorkspaceSetupDraft,
} from "./GoogleWorkspaceSetup";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CALLBACK = "https://wardmote.example.com/api/tools/oauth/callback";
let container: HTMLDivElement;
let root: Root;

function Harness({ onConnect, initial }: { onConnect: (state: { clientId: string; clientSecret: string; draft: GoogleWorkspaceSetupDraft }) => void; initial?: GoogleWorkspaceSetupDraft }) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [draft, setDraft] = useState<GoogleWorkspaceSetupDraft>(initial ?? { capabilities: GOOGLE_WORKSPACE_DEFAULT_CAPABILITIES, domain: "" });
  return (
    <GoogleWorkspaceSetup
      callbackUrl={CALLBACK}
      clientId={clientId}
      clientSecret={clientSecret}
      onClientIdChange={setClientId}
      onClientSecretChange={setClientSecret}
      draft={draft}
      onDraftChange={setDraft}
      submitting={false}
      error={null}
      onBack={() => undefined}
      onConnect={() => onConnect({ clientId, clientSecret, draft })}
    />
  );
}

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === name);
  if (!found) throw new Error(`No button "${name}"`);
  return found as HTMLButtonElement;
}

async function click(target: HTMLElement) {
  await act(async () => target.click());
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("GoogleWorkspaceSetup", () => {
  it("walks the four steps before Google and blocks Continue until the client is entered", async () => {
    const onConnect = vi.fn();
    await act(async () => root.render(<Harness onConnect={onConnect} />));
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain("Who uses it");
    await click(button("Continue"));
    expect(container.querySelector("#gws-callback")?.textContent).toBe(CALLBACK);
    const enable = [...container.querySelectorAll("a")].find((link) => link.textContent?.includes("Enable APIs"));
    expect(enable?.getAttribute("href")).toBe(googleWorkspaceEnableApisUrl());
    await click(button("I created the client"));
    expect(button("Continue").disabled).toBe(true);
    await type(container.querySelector<HTMLInputElement>("#gws-client-id")!, "123456789012-abc.apps.googleusercontent.com");
    await type(container.querySelector<HTMLInputElement>("#gws-client-secret")!, "secret");
    expect(button("Continue").disabled).toBe(false);
    await click(button("Continue"));
    expect(container.querySelector('[aria-current="step"]')?.textContent).toContain("Capabilities");
    await click(button("Continue to Google"));
    expect(onConnect).toHaveBeenCalledWith({
      clientId: "123456789012-abc.apps.googleusercontent.com",
      clientSecret: "secret",
      draft: { capabilities: GOOGLE_WORKSPACE_DEFAULT_CAPABILITIES, domain: "" },
    });
  });

  it("fills the client from client_secret.json and reports a redirect URI mismatch", async () => {
    await act(async () => root.render(<Harness onConnect={() => undefined} />));
    await click(container.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="false"]')!);
    await click(button("Continue"));
    const file = new File([JSON.stringify({ web: { client_id: "1-x.apps.googleusercontent.com", client_secret: "s", redirect_uris: ["https://other.example/cb"] } })], "client_secret.json", { type: "application/json" });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, "files", { value: [file] });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector<HTMLInputElement>("#gws-client-id")!.value).toBe("1-x.apps.googleusercontent.com");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("redirect URIs do not include");
  });

  it("warns about the restricted drive scope and refuses to continue with every service off", async () => {
    await act(async () => root.render(<Harness onConnect={() => undefined} initial={{ capabilities: { drive: "delete_share" }, domain: "" }} />));
    await click(button("Continue"));
    await click(button("I created the client"));
    await type(container.querySelector<HTMLInputElement>("#gws-client-id")!, "123456789012-abc.apps.googleusercontent.com");
    await type(container.querySelector<HTMLInputElement>("#gws-client-secret")!, "secret");
    await click(button("Continue"));
    expect(container.textContent).toContain("restricted drive scope");
    const driveOff = container.querySelector('[aria-labelledby="gws-tier-drive"]')!.querySelector("button")!;
    await click(driveOff);
    expect(button("Continue to Google").disabled).toBe(true);
  });

  it("saves a level picked from the compact per-service menu used in narrow panels", async () => {
    const onConnect = vi.fn();
    await act(async () => root.render(<Harness onConnect={onConnect} />));
    await click(button("Continue"));
    await click(button("I created the client"));
    await type(container.querySelector<HTMLInputElement>("#gws-client-id")!, "123456789012-abc.apps.googleusercontent.com");
    await type(container.querySelector<HTMLInputElement>("#gws-client-secret")!, "secret");
    await click(button("Continue"));
    const slides = container.querySelector<HTMLSelectElement>('select[aria-labelledby="gws-tier-slides"]')!;
    expect(slides.value).toBe("off");
    await act(async () => {
      slides.value = "create";
      slides.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.textContent).toContain("presentations");
    await click(button("Continue to Google"));
    expect(onConnect.mock.calls[0][0].draft.capabilities).toEqual({ ...GOOGLE_WORKSPACE_DEFAULT_CAPABILITIES, slides: "create" });
  });

  it("sends every service and a lower-case domain to the settings route", () => {
    const input = googleWorkspaceSettingsInput({ capabilities: { sheets: "edit" }, domain: " Example.COM " });
    expect(input.domain).toBe("example.com");
    expect(input.capabilities.sheets).toBe("edit");
    expect(input.capabilities.gmail).toBe("off");
    expect(Object.keys(input.capabilities)).toHaveLength(12);
  });
});
