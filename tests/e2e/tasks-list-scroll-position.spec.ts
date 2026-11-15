import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 } });

const ROW_TOLERANCE_PX = 32;

async function json(response: Awaited<ReturnType<APIRequestContext["get"]>>) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

async function seedCompany(request: APIRequestContext, issueCount: number) {
  const company = await json(await request.post("/api/companies", { data: { name: `Scroll position ${Date.now()}` } }));
  const issues: Array<{ id: string; identifier: string }> = [];
  for (let index = 0; index < issueCount; index += 1) {
    issues.push(await json(await request.post(`/api/companies/${company.id}/issues`, {
      data: {
        title: `Scroll position task ${index} with a title long enough to wrap onto a second line on a phone`,
        status: "backlog",
      },
    })));
  }
  return { company, issues };
}

async function scrollListToMiddle(page: Page) {
  await page.mouse.move(195, 420);
  for (let step = 0; step < 8; step += 1) {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(80);
  }
  await expect.poll(() => page.evaluate(() => document.scrollingElement!.scrollTop)).toBeGreaterThan(2400);
  await page.waitForTimeout(500);
}

async function rowInViewportMiddle(page: Page) {
  return page.evaluate(() => {
    const middle = window.innerHeight / 2;
    const rows = [...document.querySelectorAll<HTMLElement>("[data-issue-row-id]")];
    const index = rows.findIndex((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.top <= middle && rect.bottom > middle;
    });
    if (index < 0) throw new Error("no task row in the middle of the viewport");
    const row = rows[index]!;
    return { id: row.dataset.issueRowId!, top: row.getBoundingClientRect().top, index };
  });
}

async function scrollUntilReadingRow(page: Page, minIndex: number) {
  const viewport = page.viewportSize()!;
  await page.mouse.move(viewport.width * 0.6, viewport.height / 2);
  for (let step = 0; step < 150; step += 1) {
    if ((await rowInViewportMiddle(page).catch(() => ({ index: -1 }))).index >= minIndex) break;
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(500);
  const reading = await rowInViewportMiddle(page);
  expect(reading.index).toBeGreaterThanOrEqual(minIndex);
  return reading;
}

async function rowTop(page: Page, rowId: string) {
  return page.locator(`[data-issue-row-id="${rowId}"]`).evaluate((row) => row.getBoundingClientRect().top);
}

test("returning from a task keeps the row the user was reading in place", async ({ page, request }) => {
  test.setTimeout(120_000);
  const { company } = await seedCompany(request, 90);
  await page.goto(`/${company.issuePrefix}/issues`);
  await expect(page.locator("[data-issue-row-id]").first()).toBeVisible({ timeout: 30_000 });
  await scrollListToMiddle(page);
  const reading = await rowInViewportMiddle(page);

  await page.locator(`[data-issue-row-id="${reading.id}"] [data-inbox-issue-link]`).click();
  await page.waitForURL(/\/issues\/[A-Z]+-\d+/);
  await expect(page.locator("[data-issue-row-id]")).toHaveCount(0);
  await page.waitForTimeout(1500);
  await page.goBack();
  await expect(page.locator(`[data-issue-row-id="${reading.id}"]`)).toBeAttached({ timeout: 30_000 });
  await page.waitForTimeout(1500);

  expect(Math.abs((await rowTop(page, reading.id)) - reading.top)).toBeLessThanOrEqual(ROW_TOLERANCE_PX);
});

test("live reorders and new tasks above the reading position do not move it", async ({ page, request }) => {
  test.setTimeout(120_000);
  const { company, issues } = await seedCompany(request, 90);
  await page.goto(`/${company.issuePrefix}/issues`);
  await expect(page.locator("[data-issue-row-id]").first()).toBeVisible({ timeout: 30_000 });
  await scrollListToMiddle(page);
  const reading = await rowInViewportMiddle(page);
  const firstRowId = () => page.locator("[data-issue-row-id]").first().getAttribute("data-issue-row-id");

  const readingIndex = issues.findIndex((issue) => issue.id === reading.id);
  const below = issues[Math.max(0, readingIndex - 10)]!;
  await json(await request.post(`/api/issues/${below.id}/comments`, { data: { body: "Moves this task to the top." } }));
  await expect.poll(firstRowId, { timeout: 30_000 }).toBe(below.id);
  await page.waitForTimeout(500);
  expect(Math.abs((await rowTop(page, reading.id)) - reading.top)).toBeLessThanOrEqual(4);

  const created = await json(await request.post(`/api/companies/${company.id}/issues`, {
    data: { title: "Scroll position task created while reading", status: "backlog" },
  }));
  await expect.poll(firstRowId, { timeout: 30_000 }).toBe(created.id);
  await page.waitForTimeout(500);
  expect(Math.abs((await rowTop(page, reading.id)) - reading.top)).toBeLessThanOrEqual(4);
});

test("a heartbeat run appearing and ending in Live now above the reading position does not move it", async ({ page, request }) => {
  test.setTimeout(120_000);
  const { company } = await seedCompany(request, 90);
  const agent = await json(await request.post(`/api/companies/${company.id}/agents`, {
    data: {
      name: "Heartbeat agent",
      role: "qa",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "setTimeout(() => {}, 120000)"] },
    },
  }));
  await page.goto(`/${company.issuePrefix}/issues`);
  await expect(page.locator("[data-issue-row-id]").first()).toBeVisible({ timeout: 30_000 });
  await scrollListToMiddle(page);
  const reading = await rowInViewportMiddle(page);
  const heartbeatRow = page.locator("[data-live-now-kind='heartbeat']");

  const run = await json(await request.post(`/api/agents/${agent.id}/heartbeat/invoke`));
  await expect(heartbeatRow).toHaveCount(1, { timeout: 30_000 });
  await expect(heartbeatRow).toContainText("Heartbeat agent");
  await page.waitForTimeout(500);
  expect(Math.abs((await rowTop(page, reading.id)) - reading.top)).toBeLessThanOrEqual(4);

  await json(await request.post(`/api/heartbeat-runs/${run.id}/cancel`, { data: {} }));
  await expect(heartbeatRow).toHaveCount(0, { timeout: 30_000 });
  await page.waitForTimeout(500);
  expect(Math.abs((await rowTop(page, reading.id)) - reading.top)).toBeLessThanOrEqual(4);
});

for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
  test.describe(`at ${viewport.width}px`, () => {
    test.use({ viewport });

    test("returning from a task below the first 100 rows keeps the reading row in place", async ({ page, request }) => {
      test.setTimeout(180_000);
      const { company } = await seedCompany(request, 160);
      await page.goto(`/${company.issuePrefix}/issues`);
      await expect(page.locator("[data-issue-row-id]").first()).toBeVisible({ timeout: 30_000 });
      const reading = await scrollUntilReadingRow(page, 120);

      await page.locator(`[data-issue-row-id="${reading.id}"] [data-inbox-issue-link]`).click();
      await page.waitForURL(/\/issues\/[A-Z]+-\d+/);
      await expect(page.locator("[data-issue-row-id]")).toHaveCount(0);
      await page.waitForTimeout(1500);
      await page.goBack();
      await expect(page.locator(`[data-issue-row-id="${reading.id}"]`)).toBeAttached({ timeout: 30_000 });
      await page.waitForTimeout(1500);

      expect(Math.abs((await rowTop(page, reading.id)) - reading.top)).toBeLessThanOrEqual(ROW_TOLERANCE_PX);
    });
  });
}
