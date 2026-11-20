/**
 * Takes the pictures of Routines at work for Mirador's Plugins page, into SCREENSHOTS_DIR. Opt-in because it is not a
 * test, and like routines-plugin.spec.ts it runs from a Mirador checkout's e2e folder:
 *
 *   cp e2e/screenshots.spec.ts ~/prj/mirador/e2e/routines-screenshots.spec.ts
 *   MIRADOR_ROUTINES_PLUGIN=$PWD MIRADOR_SCREENSHOTS=1 SCREENSHOTS_DIR=$PWD/screenshots scripts/e2e.sh e2e/routines-screenshots.spec.ts
 */
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type FrameLocator, type Locator, type Page } from "@playwright/test";
import { addWorkspace, createProfile, signIn, untilFramePainted } from "./helpers.ts";
import { TestHost, writeBunProgram } from "./test-host.ts";

test.skip(process.env.MIRADOR_SCREENSHOTS !== "1", "set MIRADOR_SCREENSHOTS=1 to retake the plugin's screenshots");
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: "light" });

const PLUGIN = process.env.MIRADOR_ROUTINES_PLUGIN ?? import.meta.dirname;
const screenshotsDirectory = process.env.SCREENSHOTS_DIR!;
const host = new TestHost({ fakePrograms: true });

test.beforeAll(async () => {
  mkdirSync(join(host.dataDir, "plugins"), { recursive: true });
  symlinkSync(PLUGIN, join(host.dataDir, "plugins", "routines"));
  const promptsFile = join(host.root, "prompts");
  writeBunProgram(host.fakeProgramsDir, "opencode", join(import.meta.dirname, "fake-acp-agent.ts"), { FAKE_ACP_PROMPTS: promptsFile, FAKE_ACP_MODES: "1", FAKE_ACP_MODELS: "1" });
  writeFileSync(promptsFile, "");
  await host.start();
});
test.afterAll(async () => {
  await host.stop();
  await host.cleanUp();
});

interface Routine {
  name: string;
  profile: string;
  /** The models and efforts the fake agent offers, by id. */
  model?: string;
  effort?: string;
  what: string;
  outcome: string;
  when: { preset: "weekdays" | "daily" | "days"; time: string; days?: string[] };
}

const ROUTINES: Routine[] = [
  {
    name: "Morning triage",
    profile: "main-model",
    what: "Read the issues and pull requests opened since yesterday and sort them: what needs me today, what can wait, and what an agent can take.",
    outcome: "a short list, most urgent first, with a link to each.",
    when: { preset: "weekdays", time: "09:00" },
  },
  {
    name: "Nightly e2e check",
    profile: "qwen3-coder",
    model: "haiku",
    what: "Run the e2e suite on main and read the failures.",
    outcome: "a page listing what failed and why, and an issue for each new failure.",
    when: { preset: "daily", time: "02:30" },
  },
  {
    name: "Dependency updates",
    profile: "qwen3-coder",
    model: "opus",
    effort: "high",
    what: "Look for updates to the project's dependencies, take the safe ones on a branch and run the tests.",
    outcome: "a branch with the updates that pass, and a list of the ones that need me.",
    when: { preset: "days", time: "10:00", days: ["Mon", "Thu"] },
  },
];

const tabView = (page: Page) => page.frameLocator(".canvas-panel:visible .canvas-frame.workspace-tab iframe");

async function fillEditor(tab: FrameLocator, { name, profile, model, effort, what, outcome, when }: Routine) {
  await tab.locator('[name="name"]').fill(name);
  await tab.locator('[name="profile"]').selectOption({ label: `${profile} · opencode` });
  await expect(tab.locator('[name="model"] option', { hasText: "Opus" }), "the agent has said what it offers").toHaveCount(1);
  if (model) await tab.locator('[name="model"]').selectOption(model);
  if (effort) await tab.locator('[name="effort"]').selectOption(effort);
  await tab.locator('[name="what"]').fill(what);
  await tab.locator('[name="outcome"]').fill(outcome);
  await tab.locator(`[name="preset"][value="${when.preset}"]`).check();
  for (const day of when.days ?? []) await tab.locator(".day", { hasText: day }).locator("input").check();
  await tab.locator('[name="time"]').fill(when.time);
}

/** The area, from the top of `from` and down to the bottom of `downTo` when given, either of which may sit in the tab's frame. */
async function takeScreenshot(page: Page, name: string, area: Locator, { from, downTo }: { from?: Locator; downTo?: Locator } = {}) {
  mkdirSync(screenshotsDirectory, { recursive: true });
  await moveTheMouseOffTheButtons(page);
  const box = (await area.boundingBox())!;
  const first = from && (await from.boundingBox())!;
  const last = downTo && (await downTo.boundingBox())!;
  const top = first ? Math.max(first.y - 8, box.y) : box.y;
  const bottom = last ? Math.min(last.y + last.height + 16, box.y + box.height) : box.y + box.height;
  await page.screenshot({ path: join(screenshotsDirectory, `${name}.png`), clip: { x: box.x, y: top, width: box.width, height: bottom - top } });
}

/**
 * Onto the tab's heading, which drops the hover of the button clicked last (a pointer that leaves the frame keeps it in
 * WebKit), and its focus; then long enough for a run that just came in to finish sliding into its place.
 */
async function moveTheMouseOffTheButtons(page: Page) {
  await tabView(page).locator(".routines h1").hover();
  await tabView(page).locator("body").evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(1000);
}

/** The workspace sits in a temp folder, which a real one doesn't. */
async function tidyForScreenshot(page: Page) {
  await page.evaluate(() => {
    const textNodes = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = textNodes.nextNode(); node; node = textNodes.nextNode()) {
      if (node.textContent?.startsWith("/var/folders") || node.textContent?.startsWith("/tmp/")) node.textContent = "~/code/project";
    }
  });
}

test("screenshots of routines", async ({ page }) => {
  await signIn(page, host);
  await addWorkspace(page, host.projectDir);
  for (const name of ["main-model", "qwen3-coder"]) {
    const profiles = await createProfile(page, name, "", "", "opencode");
    await profiles.getByRole("button", { name: "Close" }).click();
  }
  await page.getByLabel("Agent", { exact: true }).selectOption({ label: "main-model · opencode" });
  const previousUrl = page.url();
  await page.getByRole("button", { name: "+ New conversation" }).click();
  await expect(page).not.toHaveURL(previousUrl);
  await page.locator(".canvas-panel:visible .workspace-tab-toggle", { hasText: "Routines" }).click();
  await untilFramePainted(page, page.locator(".canvas-panel:visible .canvas-frame.workspace-tab iframe"));
  const tab = tabView(page);

  for (const routine of ROUTINES) {
    await tab.getByRole("button", { name: "New routine" }).click();
    await fillEditor(tab, routine);
    await tab.getByRole("button", { name: "Save routine" }).click();
    await expect(tab.locator(".routine-list li", { hasText: routine.name })).toBeVisible();
  }
  for (const name of ["Nightly e2e check", "Morning triage"]) {
    await tab.locator(".routine-list li", { hasText: name }).getByRole("button", { name: "Run now" }).click();
    await expect(tab.locator(".run-list li", { hasText: name }).locator(".status")).toHaveText("done", { timeout: 30_000 });
  }

  await tidyForScreenshot(page);
  await takeScreenshot(page, "routines-and-runs", page.locator(".canvas-panel:visible"), { downTo: tab.locator(".run-list li").last() });
  await takeScreenshot(page, "runs-in-the-sidebar", page.locator("body"));

  await tab.locator(".routine-list li", { hasText: "Dependency updates" }).getByRole("button", { name: "Edit" }).click();
  await expect(tab.locator(".preview")).toContainText("next");
  await expect(tab.locator(".choices-note")).toHaveText("");
  const editor = tab.locator(".routine-list li.editing");
  await editor.evaluate((row) => row.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(400);
  await takeScreenshot(page, "routine-editor", page.locator(".canvas-panel:visible"), { from: editor, downTo: editor });
});
