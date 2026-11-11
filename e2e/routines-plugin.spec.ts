/**
 * Drives the Routines tab in a real Mirador. It needs Mirador's own e2e helpers, so run it from a Mirador checkout with
 * this plugin's folder named, and the spec inside that checkout's e2e folder:
 *
 *   cp e2e/routines-plugin.spec.ts ~/prj/mirador/e2e/
 *   MIRADOR_ROUTINES_PLUGIN=$PWD scripts/e2e.sh e2e/routines-plugin.spec.ts
 */
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { addWorkspace, createProfile, signIn, untilFramePainted } from "./helpers.ts";
import { TestHost, writeBunProgram } from "./test-host.ts";

const PLUGIN = process.env.MIRADOR_ROUTINES_PLUGIN ?? import.meta.dirname;
const host = new TestHost({ fakePrograms: true });
const promptsFile = join(host.root, "prompts");
const agentSaw = () => readFileSync(promptsFile, "utf8");

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  mkdirSync(join(host.dataDir, "plugins"), { recursive: true });
  symlinkSync(PLUGIN, join(host.dataDir, "plugins", "routines"));
  writeBunProgram(host.fakeProgramsDir, "opencode", join(import.meta.dirname, "fake-acp-agent.ts"), { FAKE_ACP_PROMPTS: promptsFile });
  writeFileSync(promptsFile, "");
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

const tabView = (page: Page) => page.frameLocator(".canvas-panel:visible .canvas-frame.workspace-tab iframe");
const tabToggle = (page: Page) => page.locator(".canvas-panel:visible .workspace-tab-toggle", { hasText: "Routines" });

test("the Routines tab draws the workspace's routines, edits one, and runs it now", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  const profiles = await createProfile(page, "nightly", "", "", "opencode");
  await profiles.getByRole("button", { name: "Close" }).click();
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: "nightly · opencode" });
  const previousUrl = page.url();
  await page.getByRole("button", { name: "+ New conversation" }).click();
  await expect(page).not.toHaveURL(previousUrl);

  await test.step("the empty tab offers a new routine", async () => {
    await tabToggle(page).click();
    await untilFramePainted(page, page.locator(".canvas-panel:visible .canvas-frame.workspace-tab iframe"));
    await expect(tabView(page).locator(".routines h1")).toHaveText("Routines");
    await expect(tabView(page).getByText("Nothing runs here yet.")).toBeVisible();
  });

  await test.step("the editor previews the schedule and saves the routine", async () => {
    await tabView(page).getByRole("button", { name: "New routine" }).click();
    await tabView(page).locator('[name="name"]').fill("Check e2e results");
    await tabView(page).locator('[name="profile"]').selectOption("nightly");
    await tabView(page).locator('[name="what"]').fill("Read the newest e2e results.");
    await tabView(page).locator('[name="outcome"]').fill("a page listing what failed and why.");
    await tabView(page).locator('[name="preset"]').selectOption("daily");
    await tabView(page).locator('[name="time"]').fill("07:30");
    await expect(tabView(page).locator(".preview")).toContainText("Every day at 07:30 · next");
    await tabView(page).getByRole("button", { name: "Save routine" }).click();
    await expect(tabView(page).locator(".routine-list li")).toHaveCount(1);
    await expect(tabView(page).locator(".when-words")).toContainText("Every day at 07:30");
  });

  await test.step("Run now starts a conversation on the profile, which the tab lists as a run", async () => {
    await tabView(page).getByRole("button", { name: "Run now" }).click();
    await expect(tabView(page).locator(".run-list li")).toHaveCount(1);
    await expect(tabView(page).locator(".run-title")).toContainText("Check e2e results ·");
    await expect.poll(agentSaw).toContain("Read the newest e2e results.");
    await expect.poll(agentSaw).toContain("a page listing what failed and why.");
  });

  await test.step("a bad cron line is said where the routine is listed", async () => {
    await tabView(page).getByRole("button", { name: "Edit" }).click();
    await tabView(page).locator('[name="preset"]').selectOption("cron");
    await tabView(page).locator('[name="cron"]').fill("70 7 * * *");
    await expect(tabView(page).locator(".preview.failed")).toContainText("is not between 0 and 59");
    await tabView(page).getByRole("button", { name: "Save routine" }).click();
    await expect(tabView(page).locator(".when-words.failed")).toContainText("is not between 0 and 59");
  });
});
