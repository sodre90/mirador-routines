import type {
  CanvasHost,
  PluginActivityEvent,
  PluginBackgroundContext,
  StartedConversation,
  WorkspaceTabContext,
} from "./mirador/api.ts";
import { MONTHS_ABBREVIATED, UnusableSchedule, clockWords, describeSchedule, dueSlot, nextSlot, runTitle, type Schedule } from "./schedule.ts";

/** A job a workspace runs on its own: what to do, what should come of it, and when. */
export interface Routine {
  id: string;
  name: string;
  /** The profile the run's conversation starts on, by name. */
  profile: string;
  /** What the agent is asked to do. */
  what: string;
  /** What the user wants to be able to see when the run ends. */
  outcome: string;
  schedule: Schedule;
  on: boolean;
}

/** One run of a routine, kept so the tab can say what happened while the user was away. */
export interface Run {
  routineId: string;
  routineName: string;
  /** The slot it ran for, as milliseconds since the epoch. */
  slot: number;
  startedAt: number;
  conversationId: string;
  title: string;
  status: "running" | "finished" | "failed" | "stopped";
}

/** A routine as the tab sees it: with what its schedule says and when it next runs. */
export interface ShownRoutine extends Routine {
  words: string;
  nextRun: string | null;
  problem: string | null;
}

/** How often the clock is looked at again. A timer's wait can stop counting while the computer sleeps, so this is short. */
const CHECK_EVERY_MS = 30_000;
const RUNS_KEPT = 20;

const routinesIn = (context: WorkspaceTabContext) => (context.storage.get("routines") ?? []) as Routine[];
const runsIn = (context: WorkspaceTabContext) => (context.storage.get("runs") ?? []) as Run[];
const firedIn = (context: WorkspaceTabContext) => (context.storage.get("fired") ?? {}) as Record<string, number>;

const saveRoutines = (context: WorkspaceTabContext, routines: Routine[]) => context.storage.set("routines", routines);
const saveRuns = (context: WorkspaceTabContext, runs: Run[]) => context.storage.set("runs", runs.slice(-RUNS_KEPT));

/** The message the run's conversation starts on: the work, and what should come of it. */
export const promptFor = (routine: Routine) =>
  `${routine.what}\n\n---\nThis is a scheduled run of the routine "${routine.name}". End with ${routine.outcome.trim() || "a short page saying what you found"}.`;

const slotWords = (slot: Date | null) => (slot === null ? null : `${slot.getDate()} ${MONTHS_ABBREVIATED[slot.getMonth()]} · ${clockWords(slot)}`);

/** A routine whose schedule can't be read says so, and holds nothing else up. */
function showRoutine(routine: Routine): ShownRoutine {
  const words = describeSchedule(routine.schedule);
  try {
    return { ...routine, words, nextRun: slotWords(nextSlot(routine.schedule, new Date())), problem: null };
  } catch (error) {
    return { ...routine, words, nextRun: null, problem: error instanceof Error ? error.message : String(error) };
  }
}

/** The slot this routine is due for now, or null when it isn't or its schedule can't be read. */
function dueSlotFor(routine: Routine, lastFired: number | null, now: Date): Date | null {
  try {
    return dueSlot(routine.schedule, lastFired === null ? null : new Date(lastFired), now);
  } catch (error) {
    if (!(error instanceof UnusableSchedule)) console.error(`the routine "${routine.name}" has a schedule that can't be read:`, error);
    return null;
  }
}

/**
 * The workspaces shown at Mirador's start, so the activity hook can find the workspace a run's conversation belongs to.
 * Mirador calls `background` before any conversation a routine started can end.
 */
let opened: PluginBackgroundContext | null = null;

const contexts = () => (opened === null ? [] : opened.workspaces().map(({ id }) => opened!.inWorkspace(id)));

/** Starts one routine's conversation in its workspace, and returns the run to keep, saying why it couldn't start. */
async function startRun(context: WorkspaceTabContext, routine: Routine, slot: Date): Promise<Run> {
  const begun = { routineId: routine.id, routineName: routine.name, slot: slot.getTime(), startedAt: Date.now(), title: runTitle(routine.name, slot) };
  try {
    const started: StartedConversation = await context.startConversation({ profile: routine.profile, prompt: promptFor(routine), title: begun.title });
    return { ...begun, conversationId: started.id, status: "running" };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    console.error(`the routine "${routine.name}" couldn't start: ${why}`);
    return { ...begun, conversationId: "", status: "failed" };
  }
}

/**
 * Every workspace's due routines, each started as its own conversation. The slot is saved before the conversation starts,
 * so a Mirador that restarts mid-run doesn't start the same slot again.
 */
export async function checkAll(context: PluginBackgroundContext, now = new Date()): Promise<Run[]> {
  const started: Run[] = [];
  for (const { id } of context.workspaces()) {
    const workspace = context.inWorkspace(id);
    const fired = firedIn(workspace);
    const dueHere: Run[] = [];
    for (const routine of routinesIn(workspace)) {
      if (!routine.on) continue;
      const slot = dueSlotFor(routine, fired[routine.id] ?? null, now);
      if (!slot) continue;
      fired[routine.id] = slot.getTime();
      workspace.storage.set("fired", fired);
      const run = await startRun(workspace, routine, slot);
      saveRuns(workspace, [...runsIn(workspace), run]);
      started.push(run);
      dueHere.push(run);
    }
    if (dueHere.length > 0) workspace.changed();
  }
  return started;
}

/** The run whose conversation ended takes its status, so the tab says what came of it. */
function tellRunEnded(event: PluginActivityEvent) {
  if (event.kind !== "turn-ended") return;
  const workspace = contexts().find((context) => runsIn(context).some((run) => run.conversationId === event.conversationId && run.conversationId !== ""));
  if (!workspace) return;
  const runs = runsIn(workspace);
  if (!runs.some((run) => run.conversationId === event.conversationId && run.status === "running")) return;
  saveRuns(workspace, runs.map((run) => (run.conversationId === event.conversationId ? { ...run, status: event.ended } : run)));
  workspace.changed();
}

/**
 * What the plugin watches: the workspaces Mirador has open, remembered so a run's conversation ending can be placed in
 * its workspace. Runs left working when Mirador stopped ended as stopped: nothing is running them.
 */
export function watchWorkspaces(context: PluginBackgroundContext) {
  opened = context;
  for (const { id } of context.workspaces()) {
    const workspace = context.inWorkspace(id);
    const runs = runsIn(workspace);
    if (!runs.some((run) => run.status === "running")) continue;
    saveRuns(workspace, runs.map((run) => (run.status === "running" ? { ...run, status: "stopped" } : run)));
    workspace.changed();
  }
}

const tabState = (context: WorkspaceTabContext) => ({
  workspace: context.workspace.name,
  routines: routinesIn(context).map(showRoutine),
  runs: runsIn(context).slice().reverse(),
  profiles: context.profiles().map(({ name, agent }) => ({ name, agent })),
});

const blankRoutine = (): Routine => ({ id: crypto.randomUUID(), name: "", profile: "", what: "", outcome: "", schedule: { kind: "weekdays", time: "09:00" }, on: true });

type TabAction =
  | { kind: "new" }
  | { kind: "describe"; schedule: Schedule }
  | { kind: "save"; routine: Routine }
  | { kind: "delete"; id: string }
  | { kind: "toggle"; id: string }
  | { kind: "runNow"; id: string };

const tabAction = {
  state: tabState,
  action(action: unknown, context: WorkspaceTabContext) {
    const asked = action as TabAction;
    switch (asked.kind) {
      case "new":
        return blankRoutine();
      case "describe":
        return showRoutine({ ...blankRoutine(), schedule: asked.schedule });
      case "save": {
        const routines = routinesIn(context);
        const index = routines.findIndex((each) => each.id === asked.routine.id);
        saveRoutines(context, index === -1 ? [asked.routine, ...routines] : routines.map((each, at) => (at === index ? asked.routine : each)));
        context.changed();
        return showRoutine(asked.routine);
      }
      case "delete":
        saveRoutines(context, routinesIn(context).filter((each) => each.id !== asked.id));
        context.changed();
        return null;
      case "toggle":
        saveRoutines(context, routinesIn(context).map((each) => (each.id === asked.id ? { ...each, on: !each.on } : each)));
        context.changed();
        return null;
      case "runNow": {
        const routine = routinesIn(context).find((each) => each.id === asked.id);
        if (!routine) throw new Error("That routine is not in this workspace any more.");
        return startRun(context, routine, new Date()).then((run) => {
          saveRuns(context, [...runsIn(context), run]);
          context.changed();
          return run;
        });
      }
    }
  },
};

/**
 * Routines: jobs a workspace runs on its own. Each is a prompt, what should come of it, a profile to run on and a
 * schedule. When one is due, Mirador starts a fresh conversation for it, which waits for you and notifies you as any
 * other conversation would. Slots missed while the Mac slept come back as one run.
 */
const host: CanvasHost = {
  items: {},
  tools: {},

  background(context) {
    watchWorkspaces(context);
    void checkAll(context);
    setInterval(() => void checkAll(context), CHECK_EVERY_MS).unref?.();
  },

  activity(event) {
    tellRunEnded(event);
  },

  workspaceTab: tabAction,
};

export default host;
