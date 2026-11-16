import type {
  CanvasHost,
  PluginActivityEvent,
  PluginBackgroundContext,
  StartedConversation,
  WorkspaceTabContext,
} from "./mirador/api.ts";
import { MONTHS_ABBREVIATED, UnusableSchedule, clockWords, describeSchedule, dueSlot, nextSlot, runTitle, slotsBetween, type Schedule } from "./schedule.ts";

/** A model or effort the profile's agent offered, kept with its name for the tab to show. */
export interface Offered {
  id: string;
  name: string;
}

/** A job a workspace runs on its own: what to do, what should come of it, and when. */
export interface Routine {
  id: string;
  name: string;
  /** The profile the run's conversation starts on, by name. */
  profile: string;
  /** The model the run's conversation starts on; none, or null, for the profile's own. */
  model?: Offered | null;
  /** The effort the run's conversation starts on; none, or null, for the profile's own. */
  effort?: Offered | null;
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
  /** When its conversation's turn ended, or it couldn't start; null while it works, and for a run Mirador's restart cut short. */
  endedAt: number | null;
}

/** A routine as the tab sees it: with what its schedule says, when it next runs, and its slots in the coming week. */
export interface ShownRoutine extends Routine {
  words: string;
  nextRun: string | null;
  nextRunAt: number | null;
  /** Its slots in the coming week, at most UPCOMING_SHOWN of them, as milliseconds since the epoch. */
  upcoming: number[];
  /** The slot the user chose not to run, as milliseconds since the epoch; `nextRunAt` is the one after it. */
  skipped: number | null;
  problem: string | null;
}

/** How often the clock is looked at again. A timer's wait can stop counting while the computer sleeps, so this is short. */
const CHECK_EVERY_MS = 30_000;
/** Enough for the tab's week to show the days before today, for a routine that runs every few hours. */
const RUNS_KEPT = 100;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const UPCOMING_SHOWN = 200;

const routinesIn = (context: WorkspaceTabContext) => (context.storage.get("routines") ?? []) as Routine[];
const runsIn = (context: WorkspaceTabContext) => (context.storage.get("runs") ?? []) as Run[];
const firedIn = (context: WorkspaceTabContext) => (context.storage.get("fired") ?? {}) as Record<string, number>;
/** Each routine's slot that won't run, kept apart from the routine so the editor's Save leaves it be. */
const skipsIn = (context: WorkspaceTabContext) => (context.storage.get("skipped") ?? {}) as Record<string, number>;

const saveRoutines = (context: WorkspaceTabContext, routines: Routine[]) => context.storage.set("routines", routines);
const saveRuns = (context: WorkspaceTabContext, runs: Run[]) => context.storage.set("runs", runs.slice(-RUNS_KEPT));

function setSkip(context: WorkspaceTabContext, routineId: string, slot: number | null) {
  const { [routineId]: _, ...others } = skipsIn(context);
  context.storage.set("skipped", slot === null ? others : { ...others, [routineId]: slot });
}

/** The message the run's conversation starts on: the work, and what should come of it. */
export const promptFor = (routine: Routine) =>
  `${routine.what}\n\n---\nThis is a scheduled run of the routine "${routine.name}". End with ${routine.outcome.trim() || "a short page saying what you found"}.`;

const slotWords = (slot: Date | null) => (slot === null ? null : `${slot.getDate()} ${MONTHS_ABBREVIATED[slot.getMonth()]} · ${clockWords(slot)}`);

/** The first slot after `after` that will run, stepping over the skipped one. */
function nextRunAfter(schedule: Schedule, after: Date, skipped: number | null): Date | null {
  const next = nextSlot(schedule, after);
  return next !== null && next.getTime() === skipped ? nextSlot(schedule, next) : next;
}

/** A routine whose schedule can't be read says so, and holds nothing else up. */
function showRoutine(routine: Routine, skipped: number | null = null): ShownRoutine {
  const words = describeSchedule(routine.schedule);
  const now = new Date();
  try {
    const upcoming = slotsBetween(routine.schedule, now, new Date(now.getTime() + WEEK_MS), UPCOMING_SHOWN);
    const next = upcoming.find((slot) => slot.getTime() !== skipped) ?? nextRunAfter(routine.schedule, now, skipped);
    return {
      ...routine,
      words,
      nextRun: slotWords(next),
      nextRunAt: next?.getTime() ?? null,
      upcoming: upcoming.map((slot) => slot.getTime()),
      skipped,
      problem: null,
    };
  } catch (error) {
    return { ...routine, words, nextRun: null, nextRunAt: null, upcoming: [], skipped: null, problem: error instanceof Error ? error.message : String(error) };
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

/** The slot Skip next steps over: one that came due but hasn't started yet, else the next one. */
function slotToSkip(routine: Routine, lastFired: number | null, now: Date): Date | null {
  try {
    return dueSlotFor(routine, lastFired, now) ?? nextSlot(routine.schedule, now);
  } catch {
    return null;
  }
}

/**
 * Whether the due slot is the one the user skipped. A skip whose slot has come, or that the Mac slept past, is used up
 * either way.
 */
function skipsSlot(workspace: WorkspaceTabContext, routine: Routine, slot: Date): boolean {
  const skipped = skipsIn(workspace)[routine.id];
  if (skipped === undefined || skipped > slot.getTime()) return false;
  setSkip(workspace, routine.id, null);
  return skipped === slot.getTime();
}

/** Marks the slots that passed as run, so a routine switched on or given a new schedule starts from now, not with a catch-up. */
function startFromNow(context: WorkspaceTabContext, routine: Routine) {
  const fired = firedIn(context);
  const passed = dueSlotFor(routine, fired[routine.id] ?? null, new Date());
  if (passed !== null) context.storage.set("fired", { ...fired, [routine.id]: passed.getTime() });
}

/** Drops a skip whose slot passed without coming due, as a routine's first slot does when the Mac slept through it. */
function dropPassedSkip(workspace: WorkspaceTabContext, routine: Routine, now: Date): boolean {
  const skipped = skipsIn(workspace)[routine.id];
  if (skipped === undefined || skipped > now.getTime()) return false;
  setSkip(workspace, routine.id, null);
  return true;
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
    const started: StartedConversation = await context.startConversation({
      profile: routine.profile,
      prompt: promptFor(routine),
      title: begun.title,
      model: routine.model?.id,
      effort: routine.effort?.id,
    });
    return { ...begun, conversationId: started.id, status: "running", endedAt: null };
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    console.error(`the routine "${routine.name}" couldn't start: ${why}`);
    return { ...begun, conversationId: "", status: "failed", endedAt: Date.now() };
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
    let changedHere = false;
    for (const routine of routinesIn(workspace)) {
      if (!routine.on) continue;
      const slot = dueSlotFor(routine, firedIn(workspace)[routine.id] ?? null, now);
      if (!slot) {
        if (dropPassedSkip(workspace, routine, now)) changedHere = true;
        continue;
      }
      workspace.storage.set("fired", { ...firedIn(workspace), [routine.id]: slot.getTime() });
      changedHere = true;
      if (skipsSlot(workspace, routine, slot)) continue;
      const run = await startRun(workspace, routine, slot);
      saveRuns(workspace, [...runsIn(workspace), run]);
      started.push(run);
    }
    if (changedHere) workspace.changed();
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
  saveRuns(workspace, runs.map((run) => (run.conversationId === event.conversationId ? { ...run, status: event.ended, endedAt: event.at } : run)));
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
    saveRuns(workspace, runs.map((run) => (run.status === "running" ? { ...run, status: "stopped", endedAt: null } : run)));
    workspace.changed();
  }
}

const tabState = (context: WorkspaceTabContext) => ({
  workspace: context.workspace.name,
  routines: routinesIn(context).map((routine) => showRoutine(routine, skipsIn(context)[routine.id] ?? null)),
  runs: runsIn(context).slice().reverse(),
  profiles: context.profiles().map(({ name, agent, model, effort }) => ({ name, agent, model: model?.name ?? null, effort })),
});

const blankRoutine = (): Routine => ({
  id: crypto.randomUUID(),
  name: "",
  profile: "",
  model: null,
  effort: null,
  what: "",
  outcome: "",
  schedule: { kind: "weekdays", time: "09:00" },
  on: true,
});

type TabAction =
  | { kind: "new" }
  | { kind: "describe"; schedule: Schedule }
  | { kind: "save"; routine: Routine }
  | { kind: "delete"; id: string }
  | { kind: "toggle"; id: string }
  | { kind: "runNow"; id: string }
  | { kind: "skipNext"; id: string }
  | { kind: "dontSkip"; id: string }
  | { kind: "choices"; profile: string };

/** The routine as the editor sent it back, without what the tab showed beside it. */
const ownFields = ({ id, name, profile, model, effort, what, outcome, schedule, on }: Routine): Routine => ({ id, name, profile, model, effort, what, outcome, schedule, on });

const sameSchedule = (one: Schedule, other: Schedule) => JSON.stringify(one) === JSON.stringify(other);

function routineIn(context: WorkspaceTabContext, id: string): Routine {
  const routine = routinesIn(context).find((each) => each.id === id);
  if (!routine) throw new Error("That routine is not in this workspace any more.");
  return routine;
}

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
        const routine = ownFields(asked.routine);
        const routines = routinesIn(context);
        const before = routines.find((each) => each.id === routine.id);
        const rescheduled = before !== undefined && !sameSchedule(before.schedule, routine.schedule);
        if (rescheduled) setSkip(context, routine.id, null);
        if (routine.on && (rescheduled || before?.on === false)) startFromNow(context, routine);
        saveRoutines(context, before ? routines.map((each) => (each.id === routine.id ? routine : each)) : [routine, ...routines]);
        context.changed();
        return showRoutine(routine, skipsIn(context)[routine.id] ?? null);
      }
      case "delete":
        saveRoutines(context, routinesIn(context).filter((each) => each.id !== asked.id));
        setSkip(context, asked.id, null);
        context.changed();
        return null;
      case "toggle": {
        const switchedOn = routinesIn(context).find((each) => each.id === asked.id && !each.on);
        if (switchedOn) startFromNow(context, { ...switchedOn, on: true });
        saveRoutines(context, routinesIn(context).map((each) => (each.id === asked.id ? { ...each, on: !each.on } : each)));
        setSkip(context, asked.id, null);
        context.changed();
        return null;
      }
      case "skipNext": {
        const slot = slotToSkip(routineIn(context, asked.id), firedIn(context)[asked.id] ?? null, new Date());
        if (slot === null) return null;
        setSkip(context, asked.id, slot.getTime());
        context.changed();
        return slot.getTime();
      }
      case "dontSkip":
        setSkip(context, asked.id, null);
        context.changed();
        return null;
      case "runNow": {
        const routine = routineIn(context, asked.id);
        return startRun(context, routine, new Date()).then((run) => {
          saveRuns(context, [...runsIn(context), run]);
          context.changed();
          return run;
        });
      }
      case "choices":
        return context.profileChoices(asked.profile);
    }
  },
};

/**
 * Routines: jobs a workspace runs on its own. Each is a prompt, what should come of it, a profile to run on, with a
 * model and effort of its own if chosen, and a schedule. When one is due, Mirador starts a fresh conversation for it, which waits for you and notifies you as any
 * other conversation would, unless its next slot was skipped. Slots missed while the Mac slept come back as one run.
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
