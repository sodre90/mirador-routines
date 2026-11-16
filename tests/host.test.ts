import { beforeEach, describe, expect, test } from "bun:test";
import host, { checkAll, promptFor, watchWorkspaces, type Routine, type Run, type ShownRoutine } from "../host.ts";
import type { PluginActivityEvent, PluginBackgroundContext, StartedConversation, WorkspaceConversationStart, WorkspaceTabContext } from "../mirador/api.ts";
import { runTitle, type Schedule } from "../schedule.ts";

/** A workspace's storage as a plain object, so a test can see what the plugin kept. */
function storageOf(initial: Record<string, unknown> = {}) {
  const kept = { ...initial };
  return { kept, get: (key: string) => kept[key], set: (key: string, value: unknown) => void (kept[key] = value) };
}

interface FakeWorkspace {
  id: string;
  name: string;
  folder: string;
  kept: Record<string, unknown>;
  started: WorkspaceConversationStart[];
  /** The profiles whose agent the tab asked what it offers. */
  asked: string[];
  refreshes: number;
}

/** A background context over the workspaces named, whose conversations start on `id` and whose tabs count refreshes. */
function fakeContext(workspaces: { id: string; name: string; routines?: Routine[]; fired?: Record<string, number>; runs?: Run[] }[]) {
  const made: FakeWorkspace[] = [];
  const contexts = new Map<string, WorkspaceTabContext>();
  for (const { id, name, routines = [], fired = {}, runs = [] } of workspaces) {
    const storage = storageOf({ routines, fired, runs });
    const workspace: FakeWorkspace = { id, name, folder: `/tmp/${name}`, kept: storage.kept, started: [], asked: [], refreshes: 0 };
    made.push(workspace);
    contexts.set(id, {
      workspace: { id, name, folder: workspace.folder },
      storage,
      sharedStorage: storage,
      changed: () => workspace.refreshes++,
      profiles: () => [
        { name: "Daily", agent: "claude", model: { id: "opus", name: "Opus 5.5" }, effort: "high" },
        { name: "Local", agent: "pi", model: null, effort: null },
      ],
      startConversation: async (start) => {
        workspace.started.push(start);
        return { id: `c-${workspace.started.length}`, profile: start.profile } as StartedConversation;
      },
      profileChoices: async (profileName) => {
        workspace.asked.push(profileName);
        return { models: [{ id: "opus", name: "Opus 5.5" }, { id: "haiku", name: "Haiku 5.5" }], efforts: [{ id: "low", name: "Low" }, { id: "high", name: "High" }] };
      },
    });
  }
  const shared = storageOf();
  const context: PluginBackgroundContext = {
    workspaces: () => [...contexts.values()].map((each) => each.workspace),
    inWorkspace: (workspaceId) => {
      const found = contexts.get(workspaceId);
      if (!found) throw new Error(`No workspace ${workspaceId} is open in Mirador.`);
      return found;
    },
    storage: shared,
  };
  return { context, workspaces: made, tabContext: (id: string) => contexts.get(id)! };
}

const routine = (over: Partial<Routine> & { id: string }): Routine => ({
  id: over.id,
  name: over.name ?? "Check e2e results",
  profile: over.profile ?? "Daily",
  ...(over.model !== undefined && { model: over.model }),
  ...(over.effort !== undefined && { effort: over.effort }),
  what: over.what ?? "Read the newest e2e results",
  outcome: over.outcome ?? "a page listing what failed and why",
  schedule: over.schedule ?? ({ kind: "weekdays", time: "09:00" } as Schedule),
  on: over.on ?? true,
});

const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute);
const runsKept = (workspace: FakeWorkspace) => workspace.kept["runs"] as Run[];

describe("a routine that is due", () => {
  let workspaces: ReturnType<typeof fakeContext>;

  beforeEach(() => {
    workspaces = fakeContext([{ id: "w1", name: "shop", routines: [routine({ id: "r1" })] }]);
  });

  test("starts its own conversation at its slot, titled after the routine and dated", async () => {
    const started = await checkAll(workspaces.context, at(12, 9));
    expect(workspaces.workspaces[0]!.started).toEqual([
      { profile: "Daily", prompt: promptFor(routine({ id: "r1" })), title: "Check e2e results · 12 Nov" },
    ]);
    expect(started).toEqual([{ routineId: "r1", routineName: "Check e2e results", slot: at(12, 9).getTime(), startedAt: expect.any(Number), conversationId: "c-1", title: "Check e2e results · 12 Nov", status: "running", endedAt: null }]);
    expect(workspaces.workspaces[0]!.refreshes).toBe(1);
  });

  test("runs once per slot: the next look at the clock finds nothing due", async () => {
    await checkAll(workspaces.context, at(12, 9));
    expect(await checkAll(workspaces.context, at(12, 9, 30))).toEqual([]);
    expect(await checkAll(workspaces.context, at(13, 8))).toEqual([]);
    const friday = await checkAll(workspaces.context, at(13, 9, 5));
    expect(friday.map((run) => run.title)).toEqual(["Check e2e results · 13 Nov"]);
    expect(await checkAll(workspaces.context, at(16, 8, 59))).toEqual([]);
    const monday = await checkAll(workspaces.context, at(16, 9, 5));
    expect(monday.map((run) => run.title)).toEqual(["Check e2e results · 16 Nov"]);
    expect(await checkAll(workspaces.context, at(17, 8))).toEqual([]);
  });

  test("a week missed while the Mac slept comes back as one run, on Monday", async () => {
    await checkAll(workspaces.context, at(13, 9));
    const runs = await checkAll(workspaces.context, at(16, 18));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.slot).toBe(at(16, 9).getTime());
  });

  test("a routine switched off runs nowhere, and one with a schedule that can't be read holds the others back nowhere", async () => {
    const mixed = fakeContext([
      {
        id: "w1",
        name: "shop",
        routines: [routine({ id: "off", on: false }), routine({ id: "broken", name: "Broken", schedule: { kind: "cron", cron: "nonsense" } }), routine({ id: "fine", name: "Fine" })],
      },
    ]);
    const runs = await checkAll(mixed.context, at(12, 9));
    expect(runs.map((run) => run.routineName)).toEqual(["Fine"]);
    expect(mixed.workspaces[0]!.started.map(({ prompt }) => prompt)).toEqual([promptFor(routine({ id: "fine", name: "Fine" }))]);
  });

  test("keeps its runs in its own workspace, apart from another's", async () => {
    const two = fakeContext([
      { id: "w1", name: "shop", routines: [routine({ id: "r1", name: "Shop check" })] },
      { id: "w2", name: "home", routines: [routine({ id: "r2", name: "Home check" })] },
    ]);
    await checkAll(two.context, at(12, 9));
    expect(runsKept(two.workspaces[0]!).map((run) => run.routineName)).toEqual(["Shop check"]);
    expect(runsKept(two.workspaces[1]!).map((run) => run.routineName)).toEqual(["Home check"]);
    expect(two.workspaces.map((workspace) => workspace.refreshes)).toEqual([1, 1]);
  });

  test("starts on the model and effort the routine chose, and one that chose none, or was saved before it could, on the profile's own", async () => {
    const chosen = routine({ id: "r1", model: { id: "haiku", name: "Haiku 5.5" }, effort: { id: "low", name: "Low" } });
    const own = routine({ id: "r2", name: "Profile's own", model: null, effort: null });
    const older = routine({ id: "r3", name: "Saved before models" });
    expect("model" in older).toBe(false);
    const { context, workspaces: [workspace] } = fakeContext([{ id: "w1", name: "shop", routines: [chosen, own, older] }]);
    await checkAll(context, at(12, 9));
    expect(workspace!.started.map(({ profile, model, effort }) => ({ profile, model, effort }))).toEqual([
      { profile: "Daily", model: "haiku", effort: "low" },
      { profile: "Daily", model: undefined, effort: undefined },
      { profile: "Daily", model: undefined, effort: undefined },
    ]);
  });

  test("a conversation that can't be started is a failed run, said why, and the rest still run", async () => {
    const broken = fakeContext([{ id: "w1", name: "shop", routines: [routine({ id: "r1", name: "No such profile", profile: "Ghost" })] }]);
    broken.tabContext("w1").startConversation = async () => {
      throw new Error("There is no profile named Ghost; the profiles are Daily, Local.");
    };
    const runs = await checkAll(broken.context, at(12, 9));
    expect(runs[0]).toMatchObject({ status: "failed", conversationId: "", endedAt: expect.any(Number) });
    expect(runsKept(broken.workspaces[0]!)[0]!.status).toBe("failed");
  });
});

describe("the tab", () => {
  test("shows the routines with what they say and when they next run, the runs newest first, and the profiles", () => {
    const { tabContext } = fakeContext([{ id: "w1", name: "shop", routines: [routine({ id: "r1" })] }]);
    const state = host.workspaceTab!.state!(tabContext("w1") as never) as { routines: ShownRoutine[]; runs: unknown[]; profiles: unknown[] };
    expect(state.routines[0]).toMatchObject({ words: "Weekdays at 09:00", nextRun: expect.stringContaining("· 09:00") });
    const { nextRunAt, upcoming } = state.routines[0]!;
    expect(nextRunAt).toBe(upcoming[0]!);
    expect(upcoming.length, "a week of weekdays").toBeGreaterThanOrEqual(5);
    expect(upcoming.every((slot) => new Date(slot).getHours() === 9 && slot > Date.now() && slot <= Date.now() + 7 * 24 * 3_600_000)).toBe(true);
    expect(state.runs).toEqual([]);
    expect(state.profiles).toEqual([
      { name: "Daily", agent: "claude", model: "Opus 5.5", effort: "high" },
      { name: "Local", agent: "pi", model: null, effort: null },
    ]);
  });

  test("saves a routine the user writes, keeps its own copy of the list, and takes it out again", async () => {
    const { tabContext, workspaces } = fakeContext([{ id: "w1", name: "shop" }]);
    const context = tabContext("w1");
    const written = routine({ id: "r1", name: "Nightly build" });
    const saved = await host.workspaceTab!.action!({ kind: "save", routine: written }, context as never);
    expect(saved).toMatchObject({ name: "Nightly build", words: "Weekdays at 09:00" });
    expect(workspaces[0]!.kept["routines"]).toEqual([written]);
    const edited = await host.workspaceTab!.action!({ kind: "save", routine: { ...written, on: false } }, context as never);
    expect((workspaces[0]!.kept["routines"] as Routine[]).map(({ on }) => on)).toEqual([false]);
    expect(edited).toMatchObject({ on: false });
    await host.workspaceTab!.action!({ kind: "toggle", id: "r1" }, context as never);
    expect((workspaces[0]!.kept["routines"] as Routine[]).map(({ on }) => on)).toEqual([true]);
    await host.workspaceTab!.action!({ kind: "delete", id: "r1" }, context as never);
    expect(workspaces[0]!.kept["routines"]).toEqual([]);
  });

  test("runs a routine now, dated today whatever its slot is, and lists it among the runs", async () => {
    const { tabContext, workspaces } = fakeContext([{ id: "w1", name: "shop", routines: [routine({ id: "r1" })] }]);
    const run = (await host.workspaceTab!.action!({ kind: "runNow", id: "r1" }, tabContext("w1") as never)) as Run;
    expect(run.title).toBe(runTitle("Check e2e results", new Date()));
    expect(workspaces[0]!.started).toHaveLength(1);
    expect(runsKept(workspaces[0]!)).toEqual([run]);
    expect(() => host.workspaceTab!.action!({ kind: "runNow", id: "gone" }, tabContext("w1") as never)).toThrow("That routine is not in this workspace any more.");
  });

  test("asks a profile's agent which models and efforts a routine can choose", async () => {
    const { tabContext, workspaces } = fakeContext([{ id: "w1", name: "shop" }]);
    const choices = await host.workspaceTab!.action!({ kind: "choices", profile: "Local" }, tabContext("w1") as never);
    expect(choices).toEqual({ models: [{ id: "opus", name: "Opus 5.5" }, { id: "haiku", name: "Haiku 5.5" }], efforts: [{ id: "low", name: "Low" }, { id: "high", name: "High" }] });
    expect(workspaces[0]!.asked).toEqual(["Local"]);
  });

  test("previews a schedule the user is writing, saying what is wrong with one that isn't readable", async () => {
    const { tabContext } = fakeContext([{ id: "w1", name: "shop" }]);
    const preview = (await host.workspaceTab!.action!({ kind: "describe", schedule: { kind: "cron", cron: "*/20 * * * *" } }, tabContext("w1") as never)) as ShownRoutine;
    expect(preview.words).toBe('Cron "*/20 * * * *"');
    expect(preview.problem).toBeNull();
    expect(preview.upcoming, "a busy schedule's week is cut short").toHaveLength(200);
    expect(preview.upcoming[1]! - preview.upcoming[0]!).toBe(20 * 60_000);
    const broken = (await host.workspaceTab!.action!({ kind: "describe", schedule: { kind: "daily", time: "9am" } }, tabContext("w1") as never)) as ShownRoutine;
    expect(broken.problem).toContain("is not a time like 07:30");
    expect(broken).toMatchObject({ nextRunAt: null, upcoming: [] });
  });
});

describe("a run's conversation ending", () => {
  const event = (conversationId: string, ended: "finished" | "failed" | "stopped"): PluginActivityEvent => ({
    kind: "turn-ended",
    ended,
    conversationId,
    conversationTitle: "Check e2e results · 12 Nov",
    at: at(12, 9, 40).getTime(),
  });

  test("marks the run that ended, in the workspace it belongs to, and leaves the others", async () => {
    const two = fakeContext([
      { id: "w1", name: "shop", routines: [routine({ id: "r1", name: "Shop check" })] },
      { id: "w2", name: "home", routines: [routine({ id: "r2", name: "Home check" })] },
    ]);
    watchWorkspaces(two.context);
    await checkAll(two.context, at(12, 9));
    host.activity!(event("c-1", "finished"), { storage: two.tabContext("w1").sharedStorage } as never);
    expect(runsKept(two.workspaces[0]!).map(({ status, endedAt }) => ({ status, endedAt }))).toEqual([{ status: "finished", endedAt: at(12, 9, 40).getTime() }]);
    expect(runsKept(two.workspaces[1]!).map(({ status }) => status)).toEqual(["running"]);
    host.activity!(event("c-1", "failed"), { storage: two.tabContext("w1").sharedStorage } as never);
    expect(runsKept(two.workspaces[0]!)[0]!.status).toBe("finished");
  });

  test("hears of conversations it didn't start, and of a turn that only began", async () => {
    const { context, workspaces } = fakeContext([{ id: "w1", name: "shop", routines: [routine({ id: "r1" })] }]);
    watchWorkspaces(context);
    await checkAll(context, at(12, 9));
    const before = runsKept(workspaces[0]!)[0]!.status;
    host.activity!(event("someone-else", "finished"), { storage: storageOf() } as never);
    host.activity!({ kind: "turn-started", conversationId: "c-1", conversationTitle: "t", at: 1 } as PluginActivityEvent, { storage: storageOf() } as never);
    expect(runsKept(workspaces[0]!)[0]!.status).toBe(before);
  });

  test("a run left working when Mirador stopped is said stopped, and its slot is not run again", async () => {
    const runs = [{ routineId: "r1", routineName: "Check e2e results", slot: at(13, 9).getTime(), startedAt: at(13, 9).getTime(), conversationId: "c-1", title: "Check e2e results · 13 Nov", status: "running" as const, endedAt: null }];
    const restarted = fakeContext([{ id: "w1", name: "shop", routines: [routine({ id: "r1" })], fired: { r1: at(13, 9).getTime() }, runs }]);
    watchWorkspaces(restarted.context);
    expect(runsKept(restarted.workspaces[0]!).map(({ status }) => status)).toEqual(["stopped"]);
    expect(await checkAll(restarted.context, at(16, 9))).toHaveLength(1);
  });
});

test("a run's message says what to do, what should come of it, and that it is a scheduled run", () => {
  expect(promptFor(routine({ id: "r1", what: "Read the newest e2e results", outcome: "a page listing what failed and why" }))).toBe(
    "Read the newest e2e results\n\n---\nThis is a scheduled run of the routine \"Check e2e results\". End with a page listing what failed and why.",
  );
  expect(promptFor(routine({ id: "r1", outcome: "  " }))).toContain("End with a short page saying what you found.");
});
