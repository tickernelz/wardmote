// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatEndpointDetail } from "./ChatEndpointDetail";
import { TooltipProvider } from "@/components/ui/tooltip";

const mocks = vi.hoisted(() => ({ get: vi.fn(), agents: vi.fn(), navigate: vi.fn() }));
vi.mock("@/api/chatEndpoints", () => ({ chatEndpointsApi: { get: mocks.get } }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: mocks.agents, get: mocks.agents } }));
vi.mock("./OpenwaSettings", () => ({ OpenwaSettings: () => <h1>OpenWA settings</h1> }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: () => {} }) }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ pushToast: () => {} }) }));
vi.mock("@/lib/router", () => ({
  useLocation: () => ({ state: null }),
  useParams: () => ({ endpointId: "wa", tab: "settings" }),
  useNavigate: () => mocks.navigate,
  Link: ({ children, to, ...props }: React.ComponentProps<"a"> & { to: string }) => <a href={to} {...props}>{children}</a>,
  Navigate: () => null,
}));

const dropping = "Setup is waiting for an owner test message; messages from other senders are dropped until setup is finished";

describe("OpenWA connection waiting for its setup test", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.agents.mockResolvedValue([{ id: "wira", name: "Wira", status: "idle" }]);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  });

  async function render(endpoint: Record<string, unknown>) {
    mocks.get.mockResolvedValue({
      id: "wa", companyId: "company", connectionId: "runtime", provider: "openwa", assignedAgentId: "wira",
      assignedAgentName: "Wira", allowUnlinkedPeople: false, providerAccountLabel: "Ops", ...endpoint,
    });
    await act(async () => root.render(<QueryClientProvider client={client}><TooltipProvider><ChatEndpointDetail /></TooltipProvider></QueryClientProvider>));
    await vi.waitFor(() => expect(container.textContent).toContain("OpenWA settings"), { timeout: 3000 });
  }

  it("puts Finish setup, the verifying state, and the dropped-sender health in the header", async () => {
    await render({ status: "verifying", healthMessage: dropping, setup: { step: "test" } });
    const button = [...container.querySelectorAll("button")].find((node) => node.textContent?.trim() === "Finish setup");
    expect(button).toBeDefined();
    expect(container.querySelector("header")?.textContent).toContain("verifying");
    expect(container.querySelector('[role="status"]')?.textContent).toBe(dropping);
    await act(async () => button!.click());
    expect(mocks.navigate).toHaveBeenCalledWith("/apps/chat/connect?provider=openwa&purpose=chat&resume=wa");
  });

  it("keeps an active connection free of setup prompts", async () => {
    await render({ status: "active", healthMessage: "Connected", setup: { step: "complete" } });
    const labels = [...container.querySelectorAll("button")].map((node) => node.textContent?.trim());
    expect(labels).not.toContain("Finish setup");
    expect(labels).not.toContain("Continue setup");
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});
