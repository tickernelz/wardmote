// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { PublicIssueShareView } from "@tickernelz/wardmote-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../context/ThemeContext";
import { PublicIssueShareLegacyRedirect, PublicIssueSharePage } from "./PublicIssueSharePage";

const getPublicShareMock = vi.hoisted(() => vi.fn());

vi.mock("../api/issue-share", () => ({
  issueShareApi: {
    getPublicShare: async (token: string) => {
      const view = await getPublicShareMock(token);
      return view ? { view, etag: "v1" } : view;
    },
  },
  publicShareEventsUrl: (token: string, since: string | null) =>
    `/api/public/share/${token}/events${since ? `?since=${since}` : ""}`,
}));

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close() {
    this.readyState = FakeEventSource.CLOSED;
  }

  emit(type: string, data: unknown) {
    if (type === "open") {
      this.readyState = FakeEventSource.OPEN;
      this.onopen?.();
      return;
    }
    for (const listener of this.listeners.get(type) ?? []) {
      listener(new MessageEvent(type, { data: JSON.stringify(data) }));
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const TOKEN = "Ab3dE5gH9k";

function buildView(overrides: Partial<PublicIssueShareView> = {}): PublicIssueShareView {
  return {
    company: { name: "Acme Robotics", logoUrl: null },
    issue: {
      id: "issue-root",
      identifier: "ACM-12",
      title: "Install the warehouse scanner",
      description: "Scanner install for the north dock.",
      status: "in_progress",
      priority: "high",
      projectName: "Operations",
      assignee: { kind: "agent", name: "Wira", iconUrl: null },
      createdAt: "2026-10-01T08:00:00.000Z",
      updatedAt: "2026-10-07T08:00:00.000Z",
      completedAt: null,
    },
    activeRun: null,
    comments: [],
    documents: [],
    attachments: [],
    workProducts: [],
    ...overrides,
  };
}

describe("PublicIssueSharePage", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function renderAt(
    path: string,
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  ) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <MemoryRouter initialEntries={[path]}>
              <Routes>
                <Route path="/s/:token" element={<PublicIssueSharePage />} />
                <Route path="/s/:token/issues/:issueId" element={<PublicIssueShareLegacyRedirect />} />
              </Routes>
            </MemoryRouter>
          </ThemeProvider>
        </QueryClientProvider>,
      );
    });
    await waitUntilLoaded();
  }

  async function waitUntilLoaded(done = () => !container.querySelector("[aria-busy='true']")) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (done()) break;
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
      });
    }
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: vi.fn(() => ({ fillStyle: "", fillRect: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), fill: vi.fn() })),
    });
    Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", {
      configurable: true,
      value: vi.fn(() => "data:image/png;base64,stub"),
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders a redacted comment as author, time and label without any body", async () => {
    getPublicShareMock.mockResolvedValue(
      buildView({
        comments: [
          {
            id: "c-agent",
            kind: "comment",
            author: { kind: "agent", name: "Wira", iconUrl: null },
            body: "Scanner mounted on dock 3.",
            attachments: [],
            createdAt: "2026-10-07T07:00:00.000Z",
          },
          {
            id: "c-human",
            kind: "redacted",
            author: { kind: "user", name: "Dana Supervisor", iconUrl: null },
            createdAt: "2026-10-07T07:30:00.000Z",
          },
        ],
      }),
    );

    await renderAt(`/s/${TOKEN}`);

    expect(getPublicShareMock).toHaveBeenCalledWith(TOKEN);
    const redacted = container.querySelectorAll("[data-testid='public-share-redacted-comment']");
    expect(redacted).toHaveLength(1);
    const placeholder = redacted[0]!;
    expect(placeholder.textContent).toContain("Dana Supervisor");
    expect(placeholder.textContent).toContain("Internal update");
    expect(placeholder.querySelector("time")).not.toBeNull();
    expect(placeholder.textContent).not.toContain("Scanner mounted");
    expect(container.textContent).toContain("Scanner mounted on dock 3.");
    expect(document.head.querySelector("meta[name='robots']")?.getAttribute("content")).toBe("noindex");
  });

  it("shows a static working pill for an active run and no run transcript", async () => {
    getPublicShareMock.mockResolvedValue(
      buildView({ activeRun: { agentName: "Wira", startedAt: "2026-10-07T08:00:00.000Z" } }),
    );

    await renderAt(`/s/${TOKEN}`);

    const pills = container.querySelectorAll("[data-testid='public-share-run-pill']");
    expect(pills).toHaveLength(1);
    expect(pills[0]!.textContent).toBe("Wira is working…");
    expect(container.querySelector("[data-testid^='task-chat']")).toBeNull();
  });

  it("sends an old sub-task address back to the shared task and links to no other task", async () => {
    getPublicShareMock.mockResolvedValue(buildView());

    await renderAt(`/s/${TOKEN}/issues/issue-child`);

    expect(getPublicShareMock).toHaveBeenCalledWith(TOKEN);
    expect(container.textContent).toContain("Install the warehouse scanner");
    const hrefs = Array.from(container.querySelectorAll("a")).map((node) => node.getAttribute("href") ?? "");
    expect(hrefs.filter((href) => href.startsWith("/s/"))).toEqual([]);
    expect(container.textContent).not.toMatch(/Parent task|Sub-task|Related tasks|Back to main task/);
  });

  it("routes inline attachment images through the share token", async () => {
    getPublicShareMock.mockResolvedValue(
      buildView({
        issue: {
          ...buildView().issue,
          description: "![plan](/api/attachments/att-desc/content)",
        },
        comments: [
          {
            id: "c-agent",
            kind: "comment",
            author: { kind: "agent", name: "Wira", iconUrl: null },
            body: "![photo](https://board.example.test/api/attachments/att-comment/content) ![logo](https://cdn.example.test/logo.png)",
            attachments: [],
            createdAt: "2026-10-07T07:00:00.000Z",
          },
        ],
        documents: [
          {
            key: "spec",
            title: "Spec",
            body: "![diagram](/api/attachments/att-doc/content)",
            updatedAt: "2026-10-07T07:00:00.000Z",
            pdfUrl: `/api/public/share/${TOKEN}/issues/issue-root/documents/spec/pdf`,
          },
        ],
      }),
    );

    await renderAt(`/s/${TOKEN}`);

    const sources = Array.from(container.querySelectorAll("img")).map((image) => image.getAttribute("src"));
    expect(sources).toEqual(expect.arrayContaining([
      `/api/public/share/${TOKEN}/attachments/att-desc/content`,
      `/api/public/share/${TOKEN}/attachments/att-comment/content`,
      `/api/public/share/${TOKEN}/attachments/att-doc/content`,
      "https://cdn.example.test/logo.png",
    ]));
    expect(sources.some((src) => src?.startsWith("/api/attachments/") || src?.includes("board.example.test"))).toBe(false);
  });

  it("renders the not-available state when the link resolves to 404", async () => {
    getPublicShareMock.mockResolvedValue(null);

    await renderAt(`/s/${TOKEN}`);

    expect(container.textContent).toContain("This link is not available");
    expect(container.textContent).not.toContain("Install the warehouse scanner");
  });

  it("names the tab after the task only while the task is on screen", async () => {
    document.title = "Shared task";
    let resolveView: (view: PublicIssueShareView) => void = () => {};
    getPublicShareMock.mockReturnValueOnce(new Promise<PublicIssueShareView>((resolve) => { resolveView = resolve; }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await renderAt(`/s/${TOKEN}`, queryClient);
    expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
    expect(document.title).toBe("Shared task");

    await act(async () => resolveView(buildView()));
    await waitUntilLoaded();
    expect(container.textContent).toContain("Install the warehouse scanner");
    expect(document.title).toBe("Install the warehouse scanner");

    getPublicShareMock.mockResolvedValue(null);
    await act(async () => {
      await queryClient.refetchQueries();
    });
    await waitUntilLoaded(() => Boolean(container.textContent?.includes("This link is not available")));
    expect(container.textContent).toContain("This link is not available");
    expect(document.title).toBe("Shared task");
  });

  describe("live updates", () => {
    beforeEach(() => {
      FakeEventSource.instances = [];
      vi.stubGlobal("EventSource", FakeEventSource);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("applies streamed changes in place and resyncs from the shown version after a gap", async () => {
      getPublicShareMock.mockResolvedValue(buildView());
      await renderAt(`/s/${TOKEN}`);

      const stream = FakeEventSource.instances[0]!;
      expect(stream.url).toBe(`/api/public/share/${TOKEN}/events?since=v1`);
      await act(async () => {
        stream.emit("open", null);
        stream.emit("patch", {
          base: "v1",
          etag: "v2",
          patch: {
            issue: { title: "Scanner installed" },
            comments: {
              upsert: [{
                id: "c-new",
                kind: "comment",
                author: { kind: "agent", name: "Wira", iconUrl: null },
                body: "Dock 3 scanner is live.",
                attachments: [],
                createdAt: "2026-10-07T09:00:00.000Z",
              }],
            },
          },
        });
      });
      expect(container.textContent).toContain("Dock 3 scanner is live.");
      expect(container.querySelector("h1")?.textContent).toBe("Scanner installed");
      expect(getPublicShareMock).toHaveBeenCalledTimes(1);

      await act(async () => {
        stream.emit("patch", { base: "v9", etag: "v10", patch: { issue: { title: "Skipped" } } });
      });
      expect(stream.readyState).toBe(FakeEventSource.CLOSED);
      expect(container.textContent).not.toContain("Skipped");
      expect(FakeEventSource.instances[1]?.url).toBe(`/api/public/share/${TOKEN}/events?since=v2`);
    });

    it("shows the not-available state as soon as the stream reports the link gone", async () => {
      getPublicShareMock.mockResolvedValue(buildView());
      await renderAt(`/s/${TOKEN}`);

      const stream = FakeEventSource.instances[0]!;
      await act(async () => {
        stream.emit("open", null);
        stream.emit("gone", {});
      });
      expect(container.textContent).toContain("This link is not available");
      expect(stream.readyState).toBe(FakeEventSource.CLOSED);
      expect(FakeEventSource.instances).toHaveLength(1);
    });
  });

  it("gives the tab its original title back when the page goes away", async () => {
    document.title = "Shared task";
    getPublicShareMock.mockResolvedValue(buildView());

    await renderAt(`/s/${TOKEN}`);
    expect(document.title).toBe("Install the warehouse scanner");

    act(() => root.unmount());
    expect(document.title).toBe("Shared task");
  });
});
