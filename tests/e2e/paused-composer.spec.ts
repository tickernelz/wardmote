import { test, expect, type APIResponse } from "@playwright/test";

async function json(response: APIResponse) {
  const body = await response.json();
  expect(response.ok(), JSON.stringify(body)).toBe(true);
  return body;
}

test("paused composer: a paused task keeps accepting messages that wait for resume", async ({ page, request }) => {
  test.setTimeout(120_000);
  const company = await json(await request.post("/api/companies", { data: { name: `Paused composer ${Date.now()}` } }));
  try {
    const agent = await json(await request.post(`/api/companies/${company.id}/agents`, { data: {
      name: "Paused composer fixture", role: "engineer", adapterType: "process",
      adapterConfig: { command: "/usr/bin/true" },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
    } }));
    const task = await json(await request.post(`/api/companies/${company.id}/issues`, { data: {
      title: "Review the paused composer", status: "backlog", assigneeAgentId: agent.id,
    } }));
    await page.goto(`/${company.issuePrefix}/issues/${task.identifier}`);
    const editor = page.getByRole("textbox", { name: "editable markdown" });
    await page.getByRole("button", { name: "More task actions", exact: true }).click();
    await page.getByRole("button", { name: "Pause work", exact: true }).click();
    const notice = page.getByTestId("paused-composer-notice");
    await expect(notice).toBeVisible();
    await expect(notice).toContainText("Task is paused. Your message waits until Resume.");
    const hold = (await json(await request.get(`/api/issues/${task.id}/tree-control/state`))).activePauseHold;
    expect(hold).toMatchObject({ rootIssueId: task.id, isRoot: true });

    await editor.fill("Pick this up after the pause.");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(async () => (await json(await request.get(`/api/issues/${task.id}/comments`))).map((comment: { body: string }) => comment.body))
      .toEqual(["Pick this up after the pause."]);
    expect(await json(await request.get(`/api/issues/${task.id}/live-runs`))).toEqual([]);

    await page.reload();
    await expect(notice).toBeVisible();
    await notice.getByRole("button", { name: "Resume" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Resume work", exact: true }).click();
    await expect(notice).toHaveCount(0);
    expect((await json(await request.get(`/api/issues/${task.id}/tree-control/state`))).activePauseHold).toBeNull();

    await page.getByRole("button", { name: "More task actions", exact: true }).click();
    await page.getByRole("button", { name: "Pause work", exact: true }).click();
    await expect(notice).toBeVisible();
    const child = await json(await request.post(`/api/companies/${company.id}/issues`, { data: {
      title: "Child of a paused task", parentId: task.id, status: "backlog", assigneeAgentId: agent.id,
    } }));
    expect((await json(await request.get(`/api/issues/${child.id}/tree-control/state`))).activePauseHold).toBeNull();
    await page.goto(`/${company.issuePrefix}/issues/${child.identifier}`);
    await expect(editor).toBeVisible();
    await expect(notice).toHaveCount(0);
  } finally {
    await request.patch(`/api/companies/${company.id}`, { data: { status: "archived" } });
  }
});
