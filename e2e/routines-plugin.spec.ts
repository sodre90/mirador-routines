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
const agentLog = join(host.root, "agent-log");
const agentDid = () => readFileSync(agentLog, "utf8");

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  mkdirSync(join(host.dataDir, "plugins"), { recursive: true });
  symlinkSync(PLUGIN, join(host.dataDir, "plugins", "routines"));
  writeBunProgram(host.fakeProgramsDir, "opencode", join(import.meta.dirname, "fake-acp-agent.ts"), {
    FAKE_ACP_PROMPTS: promptsFile,
    FAKE_ACP_MODES: "1",
    FAKE_ACP_MODELS: "1",
    FAKE_ACP_LOG: agentLog,
  });
  writeFileSync(promptsFile, "");
  writeFileSync(agentLog, "");
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

  await test.step("the empty tab's templates start a routine already written", async () => {
    await tabView(page).locator(".template", { hasText: "Nightly e2e check" }).click();
    await expect(tabView(page).locator('[name="name"]')).toHaveValue("Nightly e2e check");
    await expect(tabView(page).locator('[name="preset"]:checked')).toHaveValue("daily");
    await tabView(page).getByRole("button", { name: "Cancel" }).click();
    await expect(tabView(page).locator(".editor")).toHaveCount(0);
  });

  await test.step("a new routine's editor starts in Name, and never pulls the cursor back there from a field typed in since", async () => {
    const tab = tabView(page);
    await tab.locator("body").evaluate(() => {
      const held: FrameRequestCallback[] = [];
      Object.assign(window, { heldFrames: held, paintedFrames: window.requestAnimationFrame });
      window.requestAnimationFrame = (callback) => held.push(callback);
    });
    await tab.getByRole("button", { name: "New routine" }).click();
    await expect(tab.locator('[name="name"]')).toBeFocused();
    await tab.locator('[name="what"]').click();
    await tab.locator("body").evaluate(() => {
      const { heldFrames, paintedFrames } = window as unknown as { heldFrames: FrameRequestCallback[]; paintedFrames: typeof requestAnimationFrame };
      window.requestAnimationFrame = paintedFrames;
      for (const callback of heldFrames.splice(0)) callback(performance.now());
    });
    await page.keyboard.type("Read the newest e2e results.");
    await expect(tab.locator('[name="what"]')).toHaveValue("Read the newest e2e results.");
    await expect(tab.locator('[name="name"]')).toHaveValue("");
    await tab.getByRole("button", { name: "Cancel" }).click();
    await expect(tab.locator(".editor")).toHaveCount(0);
  });

  await test.step("the editor previews the schedule and saves the routine", async () => {
    await tabView(page).getByRole("button", { name: "New routine" }).click();
    await tabView(page).locator('[name="name"]').fill("Check e2e results");
    await tabView(page).locator('[name="profile"]').selectOption("nightly");
    await tabView(page).locator('[name="what"]').fill("Read the newest e2e results.");
    await tabView(page).locator('[name="outcome"]').fill("a page listing what failed and why.");
    await tabView(page).locator('[name="preset"][value="daily"]').check();
    await tabView(page).locator('[name="time"]').fill("07:30");
    await expect(tabView(page).locator(".preview")).toContainText("Every day at 07:30 · next");
    await tabView(page).getByRole("button", { name: "Save routine" }).click();
    await expect(tabView(page).locator(".routine-list li")).toHaveCount(1);
    await expect(tabView(page).locator(".when-words")).toContainText("Every day at 07:30");
    await expect(tabView(page).locator(".when-words .countdown")).toHaveText(/^in \d+(h \d+m|m|s)$/);
    await expect(tabView(page).locator(".pill.next")).toContainText("Next · Check e2e results in");
    await expect(tabView(page).locator(".week .lane", { hasText: "Check e2e results" }).locator(".dot.slot.next")).toHaveCount(1);
    const looseText = await tabView(page).locator("main").evaluate((main) => [...main.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE).map((node) => node.textContent));
    expect(looseText, "the closed editor leaves nothing behind, not the word null").toEqual([]);
  });

  await test.step("Edit opens the routine as it was saved, with only its chosen days ticked", async () => {
    const tab = tabView(page);
    await tab.getByRole("button", { name: "Edit" }).click();
    await expect(tab.locator('[name="preset"]:checked')).toHaveValue("daily");
    await expect(tab.locator('[name="time"]')).toHaveValue("07:30");
    await tab.locator('[name="preset"][value="days"]').check();
    await expect(tab.locator('[name="day"]:checked'), "a routine with no chosen days starts with none ticked").toHaveCount(0);
    for (const day of ["Mon", "Thu"]) await tab.locator(".day", { hasText: day }).locator("input").check();
    await expect(tab.locator(".preview")).toContainText("Mon, Thu at 07:30 · next");
    await tab.getByRole("button", { name: "Save routine" }).click();
    await expect(tab.locator(".when-words")).toContainText("Mon, Thu at 07:30");

    await tab.getByRole("button", { name: "Edit" }).click();
    await expect(tab.locator('[name="preset"]:checked')).toHaveValue("days");
    await expect(tab.locator('[name="day"]:checked')).toHaveCount(2);
    await expect(tab.locator(".day", { hasText: "Mon" }).locator("input")).toBeChecked();
    await expect(tab.locator(".day", { hasText: "Thu" }).locator("input")).toBeChecked();
    await tab.getByRole("button", { name: "Cancel" }).click();
    await expect(tab.locator(".editor")).toHaveCount(0);
  });

  await test.step("Run now starts a conversation on the profile, which the tab lists as a run", async () => {
    await tabView(page).getByRole("button", { name: "Run now" }).click();
    await expect(tabView(page).locator(".run-list li")).toHaveCount(1);
    await expect(tabView(page).locator(".run-title")).toContainText("Check e2e results ·");
    await expect.poll(agentSaw).toContain("Read the newest e2e results.");
    await expect.poll(agentSaw).toContain("a page listing what failed and why.");
    await expect(tabView(page).locator(".week .lane", { hasText: "Check e2e results" }).locator(".dot:not(.slot)")).toHaveCount(1);
    await expect(tabView(page).locator(".routine-list li .history .dot")).toHaveCount(1);
  });

  await test.step("after a run by hand, Skip next steps over the coming run, and Don't skip puts it back", async () => {
    const card = tabView(page).locator(".routine-list li");
    const lane = tabView(page).locator(".week .lane", { hasText: "Check e2e results" });
    const countdown = card.locator(".when-words .countdown");
    const comingRun = await countdown.getAttribute("data-until");
    await card.getByRole("button", { name: "Skip next" }).click();
    await expect(card.locator(".skipped-note")).toHaveText(/^(Mon|Thu) 07:30 skipped$/);
    await expect(countdown, "the countdown moves on to the run after").not.toHaveAttribute("data-until", comingRun!);
    await expect(lane.locator(".dot.slot.skipped")).toHaveCount(1);
    await expect(tabView(page).locator(".legend")).toHaveText("donefailedworkingcoming upskipped");
    await expect(tabView(page).locator(".pill.next")).toContainText("Next · Check e2e results in");

    await card.getByRole("button", { name: "Don't skip" }).click();
    await expect(card.locator(".skipped-note")).toHaveCount(0);
    await expect(countdown).toHaveAttribute("data-until", comingRun!);
    await expect(lane.locator(".dot.slot.skipped")).toHaveCount(0);
    await expect(tabView(page).locator(".legend")).toHaveText("donefailedworkingcoming up");
    await expect(card.getByRole("button", { name: "Skip next" })).toBeVisible();
  });

  await test.step("the editor offers the models and efforts the profile's agent lists, and a run starts on the ones chosen", async () => {
    const tab = tabView(page);
    await tab.getByRole("button", { name: "Edit" }).click();
    await expect(tab.locator('[name="model"] option')).toHaveText(["Agent's default", "Default (recommended)", "Opus", "Haiku"]);
    await expect(tab.locator('[name="effort"] option')).toHaveText(["Agent's default", "Low", "High"]);
    await expect(tab.locator('[name="model"]'), "a routine that never chose one runs on the profile's own").toHaveValue("");
    await tab.locator('[name="model"]').selectOption("opus");
    await tab.locator('[name="effort"]').selectOption("high");
    await tab.getByRole("button", { name: "Save routine" }).click();
    await expect(tab.locator(".routine-list li .chip")).toHaveText("nightly · Opus · High");

    await tab.getByRole("button", { name: "Edit" }).click();
    await expect(tab.locator('[name="model"]')).toHaveValue("opus");
    await expect(tab.locator('[name="effort"]')).toHaveValue("high");
    await tab.getByRole("button", { name: "Cancel" }).click();

    await tab.getByRole("button", { name: "Run now" }).click();
    await expect(tab.locator(".run-list li")).toHaveCount(2);
    await expect.poll(agentDid).toContain("set model to opus");
    await expect.poll(agentDid).toContain("set effort to high");
  });

  await test.step("a bad cron line is said where the routine is listed", async () => {
    await tabView(page).getByRole("button", { name: "Edit" }).click();
    await tabView(page).locator('[name="preset"][value="cron"]').check();
    await tabView(page).locator('[name="cron"]').fill("70 7 * * *");
    await expect(tabView(page).locator(".preview.failed")).toContainText("is not between 0 and 59");
    await tabView(page).getByRole("button", { name: "Save routine" }).click();
    await expect(tabView(page).locator(".when-words.failed")).toContainText("is not between 0 and 59");
  });

  await test.step("a run opens the conversation it started", async () => {
    const before = page.url();
    await tabView(page).locator(".run-list li button").first().click();
    await expect(page).not.toHaveURL(before);
    await expect(page.locator(".timeline:visible .message.user", { hasText: "Read the newest e2e results." })).toBeVisible();
  });
});
