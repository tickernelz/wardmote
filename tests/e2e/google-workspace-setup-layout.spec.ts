import { expect, test, type Page } from "@playwright/test";

const WIDTHS = [390, 768, 1100, 1280];

async function openCapabilities(page: Page, prefix: string) {
  await page.goto(`/${prefix}/apps/connect?source=google-workspace`);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "I created the client", exact: true }).click();
  await page.locator("#gws-client-id").fill("123456789012-abc.apps.googleusercontent.com");
  await page.locator("#gws-client-secret").fill("secret");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("list", { name: "Google service levels" }).waitFor();
}

test.describe("Google Workspace setup layout", () => {
  let prefix: string;

  test.beforeAll(async ({ request }) => {
    const response = await request.post("/api/companies", { data: { name: `Google Workspace layout ${Date.now()}` } });
    expect(response.ok()).toBe(true);
    prefix = ((await response.json()) as { issuePrefix: string }).issuePrefix;
  });

  for (const width of WIDTHS) {
    test(`keeps every level control on one line in one aligned column at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1400 });
      await openCapabilities(page, prefix);
      const rows = await page.getByRole("list", { name: "Google service levels" }).evaluate((list) => {
        const listBox = list.getBoundingClientRect();
        return [...list.querySelectorAll(":scope > li")].map((row) => {
          const controls = [...row.querySelectorAll<HTMLElement>("[aria-labelledby^='gws-tier-']")].filter((control) => control.getClientRects().length > 0);
          const box = controls[0]?.getBoundingClientRect();
          const overflow = [...row.querySelectorAll<HTMLElement>("*")].some((node) => node.getBoundingClientRect().right > listBox.right + 0.5);
          return { visibleControls: controls.length, left: box?.left ?? -1, right: box?.right ?? -1, height: box?.height ?? -1, overflow };
        });
      });
      expect(rows).toHaveLength(12);
      for (const row of rows) {
        expect(row.visibleControls).toBe(1);
        expect(row.height).toBeLessThanOrEqual(40);
        expect(row.overflow).toBe(false);
        expect(row.left).toBeCloseTo(rows[0].left, 0);
        expect(row.right).toBeCloseTo(rows[0].right, 0);
      }
    });
  }

  test("changes a service level from the compact menu at 390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 1400 });
    await openCapabilities(page, prefix);
    const slides = page.locator('select[aria-labelledby="gws-tier-slides"]');
    await slides.selectOption("read");
    await expect(page.getByRole("listitem").filter({ has: slides })).toContainText("presentations.readonly");
  });
});
