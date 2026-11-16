/**
 * Routines, drawn in a workspace's tab: the week of each routine's runs, past and coming, the routines with when each
 * runs next, an editor for one, and the runs the user comes back to. Mirador posts the workspace's state; every change
 * goes back to the plugin's host code with `mirador.send`. A clock ticks the countdowns in place, so the page is drawn
 * again only when the state changes, and an open editor is kept as it is, with what the user is typing in it.
 */

const DAYS_BEFORE_TODAY = 2;
const DAYS_SHOWN = 7;
const RUNS_LISTED = 12;
const HISTORY_DOTS = 10;
/** More slots than this in a lane's week draw as small dots, which would otherwise cover each other. */
const DENSE_LANE = 40;

const PRESETS = [
  { kind: "weekdays", label: "Weekdays" },
  { kind: "daily", label: "Every day" },
  { kind: "days", label: "Chosen days" },
  { kind: "hours", label: "Every few hours" },
  { kind: "cron", label: "Cron" },
];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const STATUS_WORDS = { running: "working", finished: "done", failed: "failed", stopped: "stopped" };
const TEMPLATES = [
  {
    name: "Morning triage",
    what: "Read the issues and pull requests opened since yesterday and sort them: what needs me today, what can wait, and what an agent can take.",
    outcome: "a short list, most urgent first, with a link to each.",
    schedule: { kind: "weekdays", time: "09:00" },
  },
  {
    name: "Nightly e2e check",
    what: "Run the e2e suite on main and read the failures.",
    outcome: "a page listing what failed and why.",
    schedule: { kind: "daily", time: "02:30" },
  },
  {
    name: "Dependency updates",
    what: "Look for updates to the project's dependencies, take the safe ones on a branch and run the tests.",
    outcome: "a branch with the updates that pass, and a list of the ones that need me.",
    schedule: { kind: "days", days: [1, 4], time: "10:00" },
  },
];

const opensConversations = typeof window.mirador.openConversation === "function";

let state = { routines: [], runs: [], profiles: [] };
/** The routine being written, and the editor's own node, which outlives every drawing of the page until it closes. */
let editing = null;
let drawnDay = null;
let drawnBefore = false;
/** Each run's status as last drawn, so a run that starts or ends is the one that moves. */
const runsDrawn = new Map();
let routineSaved = null;

const el = (tag, attributes = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === false || value == null) continue;
    if (name === "class") node.className = value;
    else if (name.startsWith("on")) node.addEventListener(name.slice(2), value);
    else if (name === "text") node.textContent = value;
    else node.setAttribute(name, value === true ? "" : value);
  }
  for (const child of children.flat()) if (child != null && child !== false) node.append(child);
  return node;
};

const svg = (path, viewBox = "0 0 16 16") => {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", viewBox);
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = path;
  return icon;
};
const playIcon = () => svg('<path d="M4.5 2.8v10.4a.6.6 0 0 0 .9.5l8.4-5.2a.6.6 0 0 0 0-1L5.4 2.3a.6.6 0 0 0-.9.5Z" fill="currentColor"/>');
const plusIcon = () => svg('<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>');
const arrowIcon = () => svg('<path d="M6 3.5 10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>');

const page = el("main", { class: "routines" });
const header = el("header");
const notice = el("p", { class: "notice", "aria-live": "polite" });
const week = el("section", { class: "week", "aria-label": "This week" });
const legend = el("p", { class: "legend", "aria-hidden": "true" });
const list = el("ul", { class: "routine-list" });
const adding = el("div", { class: "adding" });
const runsHeading = el("h2", { text: "Recent runs" });
const runs = el("div", { class: "runs" });
const columns = el("div", { class: "columns" }, el("div", { class: "routines-column" }, list, adding), el("section", { class: "runs-column" }, runsHeading, runs));
page.append(header, notice, week, legend, columns);
document.body.append(page);

const say = (text, failed = false) => {
  notice.textContent = text;
  notice.classList.toggle("failed", failed);
};
const send = (action) => window.mirador.send(action).catch((error) => say(error.message, true));
const openConversation = (run) => window.mirador.openConversation(run.conversationId).catch((error) => say(error.message, true));

const pad = (number) => String(number).padStart(2, "0");
const clock = (time) => `${pad(new Date(time).getHours())}:${pad(new Date(time).getMinutes())}`;
const dayWords = (time) => `${DAYS[new Date(time).getDay()]} ${new Date(time).getDate()}`;
const dateWords = (time) => `${dayWords(time)} ${MONTHS[new Date(time).getMonth()]}, ${clock(time)}`;
const runKey = (run) => `${run.routineId}:${run.startedAt}`;

const startOfDay = (time) => {
  const day = new Date(time);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
};
const daysAfter = (time, days) => {
  const later = new Date(time);
  later.setDate(later.getDate() + days);
  return later.getTime();
};

function untilWords(time, now) {
  const left = time - now;
  if (left <= 0) return "due now";
  const minutes = Math.floor(left / 60_000);
  if (minutes < 1) return `in ${Math.ceil(left / 1000)}s`;
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function agoWords(time, now) {
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function lastedWords(since, now) {
  const minutes = Math.floor((now - since) / 60_000);
  if (minutes < 1) return "just started";
  if (minutes < 60) return `for ${minutes}m`;
  return `for ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Text that the clock changes, written as the page is drawn and again on every tick. */
const LIVE_TEXT = [
  ["until", untilWords],
  ["since", agoWords],
  ["working", lastedWords],
];
const live = (kind, time, attributes = {}) => {
  const [, words] = LIVE_TEXT.find(([each]) => each === kind);
  return el("span", { ...attributes, [`data-${kind}`]: time, text: words(time, Date.now()) });
};

/** The week the timeline shows: two days back, today, and four ahead, placed by where a moment falls in it. */
function weekAround(now) {
  const from = daysAfter(startOfDay(now), -DAYS_BEFORE_TODAY);
  const dayStarts = Array.from({ length: DAYS_SHOWN }, (_, offset) => daysAfter(from, offset));
  const to = daysAfter(from, DAYS_SHOWN);
  return { from, to, dayStarts, at: (time) => (time - from) / (to - from) };
}

const runsOf = (routine) => state.runs.filter((run) => run.routineId === routine.id);

/** A run as something to click when its conversation can be opened, and as plain marks where it can't. */
function runControl(run, tag, attributes, ...children) {
  if (!opensConversations || !run.conversationId) return el(tag === "button" ? "span" : tag, attributes, ...children);
  return el("button", { ...attributes, type: "button", onclick: () => openConversation(run) }, ...children);
}

function runDot(run, at, moved) {
  const hint = `${run.routineName} · ${STATUS_WORDS[run.status] ?? run.status} · ${dateWords(run.startedAt)}`;
  return runControl(run, "button", {
    class: `dot ${run.status}${moved.has(runKey(run)) ? " fresh" : ""}`,
    style: at ? `--x:${at(run.startedAt)}` : null,
    "data-hint": opensConversations && run.conversationId ? `${hint} — open its conversation` : hint,
    "aria-label": hint,
  });
}

function slotDot(routine, slot, x) {
  const name = routine.name || "Untitled routine";
  const [kind, words] = slot === routine.skipped ? ["skipped", "skipped,"] : slot === routine.nextRunAt ? ["next", "next run"] : ["", "runs"];
  return el("span", { class: ["dot", "slot", kind].filter(Boolean).join(" "), style: `--x:${x}`, "data-hint": `${name} · ${words} ${dateWords(slot)}` });
}

function lane(routine, week, moved) {
  const ran = runsOf(routine).filter((run) => week.at(run.startedAt) >= 0);
  const coming = routine.on ? routine.upcoming.filter((slot) => week.at(slot) <= 1) : [];
  const name = routine.name || "Untitled routine";
  return el(
    "div",
    { class: ["lane", routine.on ? "" : "off", routine.problem ? "broken" : "", coming.length > DENSE_LANE ? "dense" : ""].filter(Boolean).join(" ") },
    el("button", { class: "lane-name", type: "button", onclick: () => showCard(routine.id), "data-hint": routine.problem ?? `${routine.words} · on ${routine.profile}` }, name),
    el(
      "div",
      { class: "track" },
      routine.on ? null : el("span", { class: "off-note", text: "switched off" }),
      ...ran.map((run) => runDot(run, week.at, moved)),
      ...coming.map((slot) => slotDot(routine, slot, week.at(slot))),
    ),
  );
}

function drawWeek(now, moved) {
  const shown = weekAround(now);
  const today = startOfDay(now);
  const firstDay = new Date(shown.from);
  const lastDay = new Date(shown.dayStarts.at(-1));
  const span = `${MONTHS[firstDay.getMonth()]} ${firstDay.getDate()} – ${firstDay.getMonth() === lastDay.getMonth() ? "" : `${MONTHS[lastDay.getMonth()]} `}${lastDay.getDate()}`;
  const days = el(
    "div",
    { class: "lane days" },
    el("span", { class: "lane-name span", text: span }),
    el("div", { class: "track" }, ...shown.dayStarts.map((start) => el("span", { class: start === today ? "day-label today" : "day-label", text: dayWords(start) }))),
  );
  week.style.setProperty("--today", String(DAYS_BEFORE_TODAY));
  week.style.setProperty("--now", String(shown.at(now)));
  week.classList.toggle("entering", !drawnBefore);
  week.replaceChildren(days, ...state.routines.map((routine) => lane(routine, shown, moved)), el("div", { class: "now", "aria-hidden": "true" }));
  const anySkipped = state.routines.some((routine) => routine.on && routine.skipped !== null);
  legend.replaceChildren(
    el("span", {}, el("i", { class: "finished" }), "done"),
    el("span", {}, el("i", { class: "failed" }), "failed"),
    el("span", {}, el("i", { class: "running" }), "working"),
    el("span", {}, el("i", { class: "slot" }), "coming up"),
    ...(anySkipped ? [el("span", {}, el("i", { class: "slot skipped" }), "skipped")] : []),
  );
}

function showCard(id) {
  const card = list.querySelector(`li[data-id="${CSS.escape(id)}"]`);
  if (!card) return;
  card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  card.classList.remove("flash");
  void card.offsetWidth;
  card.classList.add("flash");
}

function nextUp() {
  const due = state.routines.filter((routine) => routine.on && routine.nextRunAt !== null && !routine.problem).sort((a, b) => a.nextRunAt - b.nextRunAt)[0];
  const working = state.runs.filter((run) => run.status === "running");
  return [
    working.length > 0
      ? el("span", { class: "pill working" }, el("i", { class: "live" }), working.length === 1 ? `${working[0].routineName} is working` : `${working.length} runs working`)
      : null,
    due ? el("span", { class: "pill next", "data-hint": dateWords(due.nextRunAt) }, el("i", { class: "live" }), "Next · ", el("b", { text: due.name || "Untitled routine" }), " ", live("until", due.nextRunAt, { class: "countdown" })) : null,
  ];
}

function deleteButton(routine) {
  let confirming = null;
  const button = el(
    "button",
    {
      class: "btn danger",
      type: "button",
      onclick: () => {
        if (confirming) return send({ kind: "delete", id: routine.id });
        button.textContent = "Delete?";
        button.classList.add("confirming");
        confirming = setTimeout(() => {
          confirming = null;
          button.textContent = "Delete";
          button.classList.remove("confirming");
        }, 3000);
      },
    },
    "Delete",
  );
  return button;
}

function runNowButton(routine) {
  const button = el(
    "button",
    {
      class: "btn go",
      type: "button",
      "data-hint": `Start a conversation on ${routine.profile} now`,
      onclick: () => {
        button.disabled = true;
        button.lastChild.textContent = "Starting…";
        send({ kind: "runNow", id: routine.id }).then((run) => {
          if (run) return;
          button.disabled = false;
          button.lastChild.textContent = "Run now";
        });
      },
    },
    playIcon(),
    el("span", { text: "Run now" }),
  );
  return button;
}

const canSkip = (routine) => routine.on && !routine.problem && (routine.skipped !== null || routine.nextRunAt !== null);

function skipButton(routine) {
  const skipping = routine.skipped !== null;
  const button = el(
    "button",
    {
      class: skipping ? "btn skipping" : "btn",
      type: "button",
      "data-hint": skipping ? `Run it ${dateWords(routine.skipped)} after all` : `Don't run it ${dateWords(routine.nextRunAt)}`,
      onclick: () => {
        button.disabled = true;
        send({ kind: skipping ? "dontSkip" : "skipNext", id: routine.id }).finally(() => (button.disabled = false));
      },
    },
    skipping ? "Don't skip" : "Skip next",
  );
  return button;
}

const skippedNote = (routine) =>
  routine.skipped === null
    ? null
    : [el("span", { class: "skipped-note", "data-hint": `Won't run ${dateWords(routine.skipped)}` }, el("s", { text: `${DAYS[new Date(routine.skipped).getDay()]} ${clock(routine.skipped)}` }), " skipped"), " · "];

function card(routine, moved) {
  const history = runsOf(routine).slice(0, HISTORY_DOTS).reverse();
  const when = routine.problem
    ? el("p", { class: "when-words failed" }, `${routine.words} — ${routine.problem}`)
    : el(
        "p",
        { class: "when-words" },
        `${routine.words} · `,
        routine.on ? skippedNote(routine) : null,
        !routine.on
          ? el("span", { class: "paused", text: "switched off" })
          : routine.nextRunAt === null
            ? el("span", { class: "paused", text: "never runs" })
            : live("until", routine.nextRunAt, { class: "countdown", "data-hint": `Next run ${dateWords(routine.nextRunAt)}` }),
      );
  return el(
    "li",
    { class: [routine.on ? "" : "off", routineSaved === routine.id ? "flash" : ""].filter(Boolean).join(" "), "data-id": routine.id },
    el(
      "div",
      { class: "card" },
      el("button", {
        class: "switch",
        type: "button",
        role: "switch",
        "aria-checked": String(routine.on),
        "aria-label": routine.on ? "Switch off" : "Switch on",
        "data-hint": routine.on ? "On: runs on its schedule. Switch off" : "Off: doesn't run. Switch on",
        onclick: (event) => {
          event.currentTarget.setAttribute("aria-checked", String(!routine.on));
          send({ kind: "toggle", id: routine.id });
        },
      }),
      el(
        "div",
        { class: "about" },
        el("div", { class: "title-line" }, el("h3", { text: routine.name || "Untitled routine" }), el("span", { class: "chip", text: runsOnWords(routine) })),
        when,
        el("p", { class: "what", text: routine.what.split("\n")[0] }),
        history.length > 0 ? el("div", { class: "history", "aria-label": "Last runs" }, ...history.map((run) => runDot(run, null, moved))) : null,
      ),
      el("div", { class: "row-buttons" }, runNowButton(routine), canSkip(routine) ? skipButton(routine) : null, el("button", { class: "btn", type: "button", onclick: () => openEditor(routine) }, "Edit"), deleteButton(routine)),
    ),
  );
}

const runsOnWords = (routine) => [routine.profile || "no profile", routine.model?.name, routine.effort?.name].filter(Boolean).join(" · ");

/** What each profile's agent offers, asked once while the page lives; one that didn't answer is asked again the next time. */
const offeredBy = new Map();
function askOffered(profileName) {
  if (!offeredBy.has(profileName)) {
    const forget = () => offeredBy.delete(profileName);
    const asking = window.mirador.send({ kind: "choices", profile: profileName }).then(
      (offered) => offered ?? (forget(), null),
      (error) => (forget(), Promise.reject(error)),
    );
    offeredBy.set(profileName, asking);
  }
  return offeredBy.get(profileName);
}

/**
 * The editor's Model and Effort, filled from what the profile's agent offers once it answers. What the routine saved stays
 * offered and chosen while the agent is asked, when it can't be, and when it no longer lists it; choosing another
 * profile goes back to that profile's own.
 */
function choicesOf(routine, profileSelect) {
  const model = el("select", { name: "model", "aria-label": "Model" });
  const effort = el("select", { name: "effort", "aria-label": "Effort" });
  const effortField = el("label", { class: "field" }, el("span", { text: "Effort" }), effort);
  const note = el("p", { class: "choices-note", "aria-live": "polite" });
  let saved = { model: routine.model ?? null, effort: routine.effort ?? null };
  const chosen = { model: saved.model?.id ?? "", effort: saved.effort?.id ?? "" };
  model.addEventListener("change", () => (chosen.model = model.value));
  effort.addEventListener("change", () => (chosen.effort = effort.value));

  const profileNow = () => state.profiles.find((each) => each.name === profileSelect.value);
  const fill = (select, ownWords, offered, savedChoice, chosenId) => {
    const unlisted = savedChoice && !offered.some(({ id }) => id === savedChoice.id) ? [savedChoice] : [];
    select.replaceChildren(el("option", { value: "" }, ownWords), ...[...offered, ...unlisted].map(({ id, name }) => el("option", { value: id }, name)));
    select.value = chosenId;
  };
  const show = (offered) => {
    const profile = profileNow();
    fill(model, profile?.model ? `Profile's own · ${profile.model}` : "Agent's default", offered?.models ?? [], saved.model, chosen.model);
    fill(effort, profile?.effort ? `Profile's own · ${profile.effort}` : "Agent's default", offered?.efforts ?? [], saved.effort, chosen.effort);
    effortField.hidden = offered !== null && offered.efforts.length === 0 && !saved.effort;
  };
  const tell = (text, asking = false) => {
    note.textContent = text;
    note.classList.toggle("asking", asking);
  };
  const ask = () => {
    const profileName = profileSelect.value;
    show(null);
    if (!profileName) return tell("");
    tell(`Asking ${profileName}'s agent for its models…`, true);
    askOffered(profileName).then(
      (offered) => {
        if (profileSelect.value !== profileName) return;
        show(offered);
        tell(offered ? "" : "The agent didn't say what it offers, so only the profile's own is here.");
      },
      (error) => profileSelect.value === profileName && tell(error.message),
    );
  };
  profileSelect.addEventListener("change", () => {
    saved = { model: null, effort: null };
    chosen.model = chosen.effort = "";
    ask();
  });
  ask();

  const picked = (select) => (select.value ? { id: select.value, name: select.selectedOptions[0].textContent } : null);
  return {
    nodes: [el("div", { class: "pair" }, el("label", { class: "field" }, el("span", { text: "Model" }), model), effortField), note],
    read: () => ({ model: picked(model), effort: effortField.hidden ? null : picked(effort) }),
  };
}

/** The schedule the editor holds, from whichever controls its preset shows. */
function scheduleFrom(form) {
  const kind = form.querySelector('[name="preset"]:checked').value;
  if (kind === "cron") return { kind, cron: form.querySelector('[name="cron"]').value };
  if (kind === "hours") return { kind, every: Number(form.querySelector('[name="every"]').value) };
  const time = form.querySelector('[name="time"]').value;
  if (kind === "days") return { kind, days: [...form.querySelectorAll('[name="day"]:checked')].map((box) => Number(box.value)), time };
  return { kind, time };
}

function previewOf(form, line) {
  let waiting;
  return () => {
    clearTimeout(waiting);
    waiting = setTimeout(async () => {
      const shown = await window.mirador.send({ kind: "describe", schedule: scheduleFrom(form) }).catch((error) => ({ problem: error.message }));
      if (!shown) return;
      line.classList.toggle("failed", Boolean(shown.problem));
      if (shown.problem) return line.replaceChildren(shown.problem);
      const after = shown.upcoming.slice(1, 3).map((slot) => `${DAYS[new Date(slot).getDay()]} ${clock(slot)}`);
      line.replaceChildren(`${shown.words} · next `, el("b", { text: shown.nextRun ?? "never" }), after.length > 0 ? `, then ${after.join(", ")}` : "");
    }, 150);
  };
}

const choice = (type, name, value, checked, label, className = "choice") =>
  el("label", { class: className }, el("input", { type, name, value, checked }), el("span", { text: label }));

function editorFor(routine) {
  const preset = PRESETS.find((each) => each.kind === routine.schedule.kind) ?? PRESETS[0];
  const form = el("div", { class: "editor" });
  const name = el("input", { name: "name", value: routine.name, placeholder: "Check the e2e results", "aria-label": "Name" });
  const profile = el(
    "select",
    { name: "profile", "aria-label": "Profile" },
    ...state.profiles.map((each) => el("option", { value: each.name, selected: each.name === routine.profile }, `${each.name} · ${each.agent}`)),
  );
  const choices = choicesOf(routine, profile);
  const what = el("textarea", { name: "what", placeholder: "What the agent should do", rows: 3 });
  what.value = routine.what;
  const outcome = el("textarea", { name: "outcome", placeholder: "What you want to see when it ends", rows: 2 });
  outcome.value = routine.outcome;

  const presets = el("div", { class: "presets", role: "radiogroup", "aria-label": "How often" }, ...PRESETS.map((each) => choice("radio", "preset", each.kind, each.kind === preset.kind, each.label)));
  const time = el("input", { type: "time", name: "time", value: routine.schedule.time ?? "09:00", "aria-label": "At" });
  const every = el("input", { type: "number", name: "every", min: 1, max: 24, value: routine.schedule.every ?? 6, "aria-label": "Every how many hours" });
  const cron = el("input", { type: "text", name: "cron", class: "cron", value: routine.schedule.cron ?? "30 7 * * 1-5", spellcheck: false, "aria-label": "Cron line" });
  const dayChips = [1, 2, 3, 4, 5, 6, 0].map((day) => choice("checkbox", "day", day, (routine.schedule.days ?? []).includes(day), DAYS[day], "day"));
  const detail = el("div", { class: "detail" });
  const previewLine = el("p", { class: "preview" });
  const preview = previewOf(form, previewLine);
  const showDetail = () => {
    const kind = form.querySelector('[name="preset"]:checked').value;
    const at = el("span", { class: "at", text: "at" });
    detail.replaceChildren(
      ...(kind === "cron"
        ? [cron, el("span", { class: "hint", text: "minute hour day month weekday" })]
        : kind === "hours"
          ? [el("span", { text: "every" }), every, el("span", { text: "hours" })]
          : kind === "days"
            ? [el("div", { class: "day-chips" }, ...dayChips), at, time]
            : [at, time]),
    );
    preview();
  };
  presets.addEventListener("change", showDetail);
  for (const input of [time, every, cron, ...dayChips.map((chip) => chip.firstChild)]) input.addEventListener("input", preview);

  const close = () => {
    editing = null;
    draw();
  };
  const save = () =>
    send({
      kind: "save",
      routine: { ...routine, name: name.value.trim(), profile: profile.value, ...choices.read(), what: what.value.trim(), outcome: outcome.value.trim(), schedule: scheduleFrom(form) },
    }).then((saved) => {
      if (!saved) return;
      routineSaved = saved.id;
      close();
    });
  form.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) save();
  });

  form.append(
    el("div", { class: "pair" }, el("label", { class: "field" }, el("span", { text: "Name" }), name), el("label", { class: "field" }, el("span", { text: "Runs on" }), profile)),
    ...choices.nodes,
    el("label", { class: "field" }, el("span", { text: "What to do" }), what),
    el("label", { class: "field" }, el("span", { text: "End result" }), outcome),
    el("div", { class: "field" }, el("span", { text: "When" }), presets, detail),
    previewLine,
    el(
      "div",
      { class: "buttons" },
      el("button", { class: "btn primary", type: "button", onclick: save }, "Save routine"),
      el("button", { class: "btn", type: "button", onclick: close }, "Cancel"),
      el("span", { class: "keys", text: "⌘↩ saves · Esc cancels" }),
    ),
  );
  showDetail();
  return el("li", { class: "editing", "data-id": routine.id }, form);
}

/** Focus goes in as the editor is placed, never a frame later, when it could pull the cursor out of a field already typed in. */
function openEditor(routine) {
  editing = { id: routine.id, node: editorFor(routine) };
  draw();
  editing.node.querySelector(routine.name ? '[name="what"]' : '[name="name"]').focus({ preventScroll: true });
  editing.node.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

const openBlank = (template = {}) =>
  send({ kind: "new" }).then((blank) => blank && openEditor({ ...blank, profile: state.profiles[0]?.name ?? "", ...template }));

/**
 * The routines' cards, with the open editor where its routine is, or first for a new one. The editor's node stays in the
 * list as it is while the cards around it are drawn again, so what the user is typing in it, and its focus, stay too.
 */
function placeRoutines(moved) {
  const editingNew = editing !== null && !state.routines.some((routine) => routine.id === editing.id);
  const wanted = [...(editingNew ? [editing.node] : []), ...state.routines.map((routine) => (editing?.id === routine.id ? editing.node : card(routine, moved)))];
  for (const child of [...list.children]) if (!wanted.includes(child)) child.remove();
  wanted.forEach((node, index) => {
    if (list.children[index] !== node) list.insertBefore(node, list.children[index] ?? null);
  });
}

function drawAdding() {
  const add = el("button", { class: "btn add", type: "button", onclick: () => openBlank() }, plusIcon(), el("span", { text: "New routine" }));
  if (state.routines.length > 0 || editing) return adding.replaceChildren(...(editing ? [] : [add]));
  adding.replaceChildren(
    el(
      "div",
      { class: "empty-state" },
      el("div", { class: "orbit", "aria-hidden": "true" }, el("i", { class: "hand" }), el("i", { class: "pin" })),
      el("p", { class: "empty" }, "Nothing runs here yet. A routine is a prompt, what should come of it, a profile to run on and a time to run at. Start from one of these, or write your own."),
    ),
    el(
      "div",
      { class: "templates" },
      ...TEMPLATES.map((template, index) =>
        el(
          "button",
          { class: "template", type: "button", style: `--i:${index}`, onclick: () => openBlank(template) },
          el("b", { text: template.name }),
          el("small", { text: template.schedule.kind === "weekdays" ? `Weekdays at ${template.schedule.time}` : template.schedule.kind === "daily" ? `Every day at ${template.schedule.time}` : `Mon, Thu at ${template.schedule.time}` }),
          el("span", { text: template.what }),
        ),
      ),
    ),
    add,
  );
}

function runRow(run, moved) {
  const key = runKey(run);
  const when =
    run.status === "running"
      ? live("working", run.startedAt, { class: "run-when" })
      : live("since", run.endedAt ?? run.startedAt, { class: "run-when", "data-hint": `Started ${dateWords(run.startedAt)}` });
  return el(
    "li",
    { class: moved.has(key) ? (runsDrawn.has(key) ? "changed" : "fresh") : "" },
    runControl(
      run,
      "div",
      { class: "run-open", "data-hint": opensConversations && run.conversationId ? "Open its conversation" : null },
      el("i", { class: `status-dot ${run.status}` }),
      el("span", { class: `status ${run.status}`, text: STATUS_WORDS[run.status] ?? run.status }),
      el("span", { class: "run-title", text: run.title }),
      when,
      opensConversations && run.conversationId ? el("span", { class: "go-to" }, arrowIcon()) : null,
    ),
  );
}

/** The runs that started or changed status since the page was last drawn; none on the first drawing. */
function runsMoved() {
  const moved = new Set();
  for (const run of state.runs) {
    const key = runKey(run);
    if (drawnBefore && runsDrawn.get(key) !== run.status) moved.add(key);
  }
  return moved;
}

function draw() {
  const now = Date.now();
  drawnDay = startOfDay(now);
  const moved = runsMoved();
  header.replaceChildren(el("h1", { text: "Routines" }), el("div", { class: "pills" }, ...nextUp()));
  week.hidden = legend.hidden = state.routines.length === 0;
  if (!week.hidden) drawWeek(now, moved);
  placeRoutines(moved);
  drawAdding();
  runs.replaceChildren(
    state.runs.length === 0 ? el("p", { class: "empty", text: "No runs yet." }) : el("ul", { class: "run-list" }, ...state.runs.slice(0, RUNS_LISTED).map((run) => runRow(run, moved))),
  );
  runsDrawn.clear();
  for (const run of state.runs) runsDrawn.set(runKey(run), run.status);
  routineSaved = null;
  matchColorScheme();
}

/** The clock's words in place, and the now line, every second; a new day draws the week again. */
function tick() {
  const now = Date.now();
  if (drawnDay !== null && startOfDay(now) !== drawnDay) return draw();
  for (const [kind, words] of LIVE_TEXT) {
    for (const node of page.querySelectorAll(`[data-${kind}]`)) {
      const text = words(Number(node.dataset[kind]), now);
      if (node.textContent !== text) node.textContent = text;
    }
  }
  if (!week.hidden) week.style.setProperty("--now", String(weekAround(now).at(now)));
  matchColorScheme();
}

/** Native controls, such as the time picker, follow Mirador's light or dark, which reaches the page only as colours. */
function matchColorScheme() {
  const background = getComputedStyle(document.documentElement).getPropertyValue("--mirador-bg").match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/);
  if (!background) return;
  const dark = (Number(background[1]) + Number(background[2]) + Number(background[3])) / 3 < 128;
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

window.mirador.onState((shown) => {
  state = shown ?? { routines: [], runs: [], profiles: [] };
  draw();
  drawnBefore = true;
});
setInterval(tick, 1000);

const style = document.createElement("style");
style.textContent = `
:root {
  --bg: var(--mirador-bg, #fff); --panel: var(--mirador-panel, #fff); --panel-2: var(--mirador-panel-2, #f6f6f8);
  --border: var(--mirador-border, #e7e7eb); --text: var(--mirador-text, #1a1b20); --muted: var(--mirador-muted, #62656e);
  --faint: var(--mirador-faint, #9a9ca4); --accent: var(--mirador-accent, #5b5bd6); --accent-text: var(--mirador-accent-text, #fff);
  --accent-soft: var(--mirador-accent-soft, #efeffc); --ok: var(--mirador-ok, #2e9e6b); --danger: var(--mirador-danger, #d93d42);
  font-size: calc(13px * var(--mirador-font-scale, 1));
}
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; background: var(--panel); color: var(--text); font: 1rem/1.45 var(--mirador-font, system-ui, sans-serif); -webkit-font-smoothing: antialiased; }
button, input, select, textarea { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
svg { width: .85em; height: .85em; flex: none; }

.routines { padding: 1.1rem 1.25rem 2.4rem; }
header { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
h1 { font-size: 1.35rem; margin: 0 auto 0 0; letter-spacing: -.015em; }
.pills { display: flex; gap: .4rem; flex-wrap: wrap; }
.pill { display: inline-flex; align-items: center; gap: .45rem; border-radius: 99px; padding: .2rem .75rem .2rem .6rem; font-size: .92rem; background: var(--accent-soft); color: var(--accent); white-space: nowrap; }
.pill b { font-weight: 600; }
.pill.working { background: color-mix(in srgb, var(--ok) 13%, var(--panel)); color: var(--ok); }
.countdown { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--accent); }
.live { width: .5rem; height: .5rem; border-radius: 50%; background: currentColor; animation: ping 1.8s ease-out infinite; }
@keyframes ping { from { box-shadow: 0 0 0 0 color-mix(in srgb, currentColor 55%, transparent); } to { box-shadow: 0 0 0 .5rem transparent; } }
.notice { min-height: 1.2em; margin: .25rem 0 0; font-size: .9rem; color: var(--muted); }
.notice.failed { color: var(--danger); }

.week { --label: clamp(10.5rem, 16%, 15rem); position: relative; margin: .7rem 0 .45rem; border: 1px solid var(--border); border-radius: 12px; background: var(--bg); overflow: hidden; }
.week[hidden], .legend[hidden] { display: none; }
.lane { display: grid; grid-template-columns: var(--label) 1fr; min-height: 2.35rem; }
.lane + .lane { border-top: 1px solid var(--border); }
.lane-name { align-self: center; min-width: 0; padding: 0 .8rem; border: 0; background: none; text-align: left; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
button.lane-name:hover { color: var(--accent); }
.lane.off .lane-name { color: var(--faint); }
.off-note { position: absolute; inset: 0; display: grid; place-items: center; font-size: .8rem; color: var(--faint); letter-spacing: .02em; background: repeating-linear-gradient(-45deg, transparent 0 6px, color-mix(in srgb, var(--border) 45%, transparent) 6px 7px); }
.lane.broken .lane-name { color: var(--danger); }
.lane.days { min-height: 1.95rem; }
.lane-name.span { font-size: .8rem; font-weight: 500; color: var(--faint); cursor: default; }
.track {
  position: relative;
  background:
    linear-gradient(to right, transparent calc(var(--today) / 7 * 100%), var(--accent-soft) calc(var(--today) / 7 * 100%) calc((var(--today) + 1) / 7 * 100%), transparent calc((var(--today) + 1) / 7 * 100%)),
    repeating-linear-gradient(to right, var(--border) 0 1px, transparent 1px calc(100% / 7));
}
.days .track { display: grid; grid-template-columns: repeat(7, 1fr); align-items: center; }
.day-label { text-align: center; font-size: .8rem; color: var(--muted); white-space: nowrap; overflow: hidden; }
.day-label.today { color: var(--accent); font-weight: 650; }
.now { position: absolute; top: calc(1.95rem + 1px); bottom: 0; left: calc(var(--label) + (100% - var(--label)) * var(--now)); width: 2px; margin-left: -1px; background: var(--accent); box-shadow: 0 0 10px color-mix(in srgb, var(--accent) 55%, transparent); pointer-events: none; transition: left 1s linear; }
.now::before { content: ""; position: absolute; top: 0; left: -3px; width: 8px; height: 8px; border-radius: 0 0 50% 50%; background: var(--accent); }

.dot { position: absolute; top: 50%; left: calc(var(--x) * 100%); width: .72rem; height: .72rem; margin: -.36rem 0 0 -.36rem; padding: 0; border: 0; border-radius: 50%; background: var(--faint); color: var(--faint); transition: transform .15s; }
button.dot { cursor: pointer; }
button.dot:hover { transform: scale(1.4); z-index: 1; }
.dot.finished { background: var(--ok); color: var(--ok); }
.dot.failed { background: var(--danger); color: var(--danger); }
.dot.running { background: var(--accent); color: var(--accent); animation: ping 1.8s ease-out infinite; }
.dot.slot { background: var(--bg); border: 1.5px solid var(--accent); }
.dot.slot.next { background: var(--accent-soft); border-width: 3px; color: var(--accent); animation: ping 1.8s ease-out infinite; }
.dot.slot.skipped { background: none; border: 1.5px dashed var(--faint); }
.dot.slot.skipped::after { content: ""; position: absolute; left: -20%; right: -20%; top: 50%; height: 1.5px; margin-top: -.75px; background: var(--faint); transform: rotate(-45deg); }
.lane.dense .dot { width: .38rem; height: .38rem; margin: -.19rem 0 0 -.19rem; }
.lane.dense .dot.slot { border-width: 1px; }
.week.entering .dot:not(.running):not(.next) { animation: pop .5s cubic-bezier(.2, .9, .3, 1.5) backwards; animation-delay: calc(var(--x) * 700ms); }
.dot.fresh { animation: pop .55s cubic-bezier(.2, .9, .3, 1.6) backwards; }
.dot.running.fresh { animation: pop .55s cubic-bezier(.2, .9, .3, 1.6) backwards, ping 1.8s ease-out .55s infinite; }
@keyframes pop { from { transform: scale(0); opacity: 0; } }

.legend { display: flex; gap: 1rem; flex-wrap: wrap; font-size: .8rem; color: var(--muted); margin: 0 0 1rem .15rem; }
.legend i { display: inline-block; width: .55rem; height: .55rem; border-radius: 50%; margin-right: .35rem; vertical-align: -.03rem; }
.legend .finished { background: var(--ok); } .legend .failed { background: var(--danger); } .legend .running { background: var(--accent); }
.legend .slot { border: 1.5px solid var(--accent); }
.legend .slot.skipped { border: 1.5px dashed var(--faint); }

.routine-list { list-style: none; margin: 0; padding: 0; display: grid; gap: .55rem; }
.routine-list > li { border: 1px solid var(--border); border-radius: 12px; background: var(--bg); transition: border-color .2s, box-shadow .2s; }
.routine-list > li:hover { border-color: color-mix(in srgb, var(--accent) 30%, var(--border)); }
.routine-list > li.flash { animation: flash 1.6s ease-out; }
@keyframes flash { from { border-color: var(--accent); box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 30%, transparent); } }
.card { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: .85rem; align-items: start; padding: .8rem .9rem; }
.off .about { opacity: .55; }
.title-line { display: flex; align-items: baseline; gap: .5rem; flex-wrap: wrap; }
.about h3 { margin: 0; font-size: 1.07rem; font-weight: 600; letter-spacing: -.01em; }
.chip { font-size: .78rem; color: var(--muted); background: var(--panel-2); border: 1px solid var(--border); border-radius: 99px; padding: 0 .5rem; }
.when-words { margin: .15rem 0 0; }
.when-words.failed { color: var(--danger); }
.paused { color: var(--faint); }
.skipped-note { color: var(--muted); }
.skipped-note s { color: var(--faint); }
.what { margin: .2rem 0 0; color: var(--muted); font-size: .92rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.history { display: flex; gap: .3rem; margin-top: .5rem; align-items: center; }
.history .dot { position: static; margin: 0; width: .6rem; height: .6rem; }

.switch { position: relative; flex: none; width: 2.3rem; height: 1.35rem; margin-top: .1rem; padding: 0; border: 0; border-radius: 99px; background: color-mix(in srgb, var(--muted) 40%, transparent); cursor: pointer; transition: background .2s; }
.switch::after { content: ""; position: absolute; top: .175rem; left: .175rem; width: 1rem; height: 1rem; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgb(0 0 0 / .3); transition: transform .25s cubic-bezier(.3, .7, .4, 1.4); }
.switch[aria-checked="true"] { background: var(--accent); }
.switch[aria-checked="true"]::after { transform: translateX(.95rem); }

.btn { display: inline-flex; align-items: center; gap: .4rem; padding: .3rem .75rem; border: 1px solid var(--border); border-radius: 8px; background: var(--panel-2); white-space: nowrap; cursor: pointer; transition: background .15s, border-color .15s, color .15s, opacity .15s; }
.btn:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); background: var(--accent-soft); }
.btn:active { transform: translateY(1px); }
.btn:disabled { opacity: .6; cursor: progress; }
.btn.primary { background: var(--accent); color: var(--accent-text); border-color: transparent; box-shadow: 0 2px 10px color-mix(in srgb, var(--accent) 35%, transparent); }
.btn.primary:hover { background: color-mix(in srgb, var(--accent) 85%, white); }
.btn.go { color: var(--accent); background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 30%, var(--border)); }
.btn.go:hover { color: var(--accent-text); background: var(--accent); }
.btn.danger:hover, .btn.danger.confirming { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 50%, var(--border)); background: color-mix(in srgb, var(--danger) 10%, var(--panel)); }
.row-buttons { display: flex; gap: .35rem; }
.row-buttons .btn:not(.go):not(.skipping) { opacity: .55; }
li:hover .row-buttons .btn, .row-buttons .btn:focus-visible, .row-buttons .btn.confirming { opacity: 1; }
.adding { margin-top: .7rem; }

.editing { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)) !important; box-shadow: 0 8px 28px color-mix(in srgb, var(--accent) 14%, transparent); animation: open .3s cubic-bezier(.2, .8, .3, 1); }
@keyframes open { from { opacity: 0; transform: translateY(-6px) scale(.99); } }
.editor { display: grid; gap: .8rem; padding: 1rem; }
.pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: .8rem; }
.field { display: grid; gap: .3rem; align-content: start; }
.field > span { font-size: .76rem; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--faint); }
input, select, textarea { padding: .42rem .6rem; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); transition: border-color .15s, box-shadow .15s; }
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); }
textarea { resize: vertical; }
.presets { display: inline-flex; flex-wrap: wrap; justify-self: start; border: 1px solid var(--border); border-radius: 9px; background: var(--panel); overflow: hidden; }
.choice, .day { position: relative; }
.choice input, .day input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }
.choice span { display: block; padding: .32rem .8rem; border-left: 1px solid var(--border); color: var(--muted); transition: background .15s, color .15s; }
.choice:first-child span { border-left: 0; }
.choice:hover span { color: var(--text); }
.choice input:checked + span { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.choice input:focus-visible + span, .day input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: -2px; }
.detail { display: flex; gap: .45rem; align-items: center; flex-wrap: wrap; margin-top: .45rem; color: var(--muted); }
.detail input[type="number"] { width: 4.5rem; }
.detail .cron { font-family: var(--mirador-mono, ui-monospace, monospace); width: 12rem; }
.detail .hint { font-size: .82rem; color: var(--faint); }
.day-chips { display: flex; gap: .3rem; flex-wrap: wrap; }
.day span { display: grid; place-items: center; min-width: 2.7rem; height: 2rem; padding: 0 .5rem; border: 1px solid var(--border); border-radius: 99px; color: var(--muted); font-size: .9rem; transition: background .15s, color .15s, border-color .15s, transform .2s cubic-bezier(.3, .7, .4, 1.6); }
.day:hover span { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
.day input:checked + span { background: var(--accent); border-color: var(--accent); color: var(--accent-text); font-weight: 600; transform: scale(1.05); }
.choices-note { margin: -.45rem 0 0; font-size: .82rem; color: var(--faint); }
.choices-note:empty { display: none; }
.choices-note.asking { animation: breathe 1.1s ease-in-out infinite alternate; }
@keyframes breathe { from { opacity: .45; } }
.field[hidden] { display: none; }
.preview { margin: 0; min-height: 1.4em; font-size: .92rem; color: var(--muted); }
.preview b { color: var(--accent); font-weight: 600; }
.preview.failed { color: var(--danger); }
.buttons { display: flex; gap: .5rem; align-items: center; }
.keys { margin-left: auto; font-size: .8rem; color: var(--faint); }

.empty-state { display: flex; gap: 1rem; align-items: center; margin: .4rem 0 .8rem; }
.empty { margin: 0; color: var(--muted); font-size: .95rem; }
.orbit { position: relative; flex: none; width: 3.4rem; height: 3.4rem; border-radius: 50%; border: 2px solid var(--accent-soft); background: radial-gradient(circle, var(--accent-soft) 0 40%, transparent 41%); }
.orbit .hand { position: absolute; left: 50%; bottom: 50%; width: 2px; height: 42%; margin-left: -1px; border-radius: 2px; background: var(--accent); transform-origin: bottom; animation: sweep 6s linear infinite; }
.orbit .pin { position: absolute; left: 50%; top: 50%; width: .45rem; height: .45rem; margin: -.225rem; border-radius: 50%; background: var(--accent); }
@keyframes sweep { to { transform: rotate(360deg); } }
.templates { display: grid; grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr)); gap: .55rem; margin-bottom: .8rem; }
.template { display: grid; gap: .1rem; align-content: start; padding: .75rem .85rem; border: 1px dashed color-mix(in srgb, var(--accent) 40%, var(--border)); border-radius: 12px; background: var(--bg); text-align: left; cursor: pointer; transition: border-color .15s, background .15s, transform .15s; animation: rise .45s cubic-bezier(.2, .8, .3, 1) backwards; animation-delay: calc(var(--i) * 80ms); }
.template:hover { border-style: solid; border-color: var(--accent); background: var(--accent-soft); transform: translateY(-2px); }
.template small { color: var(--accent); font-size: .85rem; }
.template span { color: var(--muted); font-size: .88rem; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
@keyframes rise { from { opacity: 0; transform: translateY(6px); } }

h2 { margin: 1.7rem 0 .4rem; font-size: .76rem; font-weight: 600; text-transform: uppercase; letter-spacing: .07em; color: var(--faint); }
.run-list { list-style: none; margin: 0; padding: 0; }
.run-list li + li { border-top: 1px solid var(--border); }
.run-open { display: grid; grid-template-columns: auto 4.6rem minmax(0, 1fr) auto 1rem; gap: .6rem; align-items: center; width: 100%; padding: .48rem .55rem; border: 0; border-radius: 8px; background: none; text-align: left; }
button.run-open { cursor: pointer; }
button.run-open:hover { background: var(--accent-soft); }
button.run-open:hover .run-title { color: var(--accent); }
.go-to { color: var(--accent); opacity: 0; transform: translateX(-4px); transition: opacity .15s, transform .15s; }
button.run-open:hover .go-to, button.run-open:focus-visible .go-to { opacity: 1; transform: none; }
.status-dot { width: .55rem; height: .55rem; border-radius: 50%; background: var(--faint); color: var(--faint); }
.status-dot.finished { background: var(--ok); color: var(--ok); }
.status-dot.failed { background: var(--danger); color: var(--danger); }
.status-dot.running { background: var(--accent); color: var(--accent); animation: ping 1.8s ease-out infinite; }
.status { font-size: .76rem; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
.status.running { color: var(--accent); } .status.finished { color: var(--ok); } .status.failed { color: var(--danger); }
.run-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: color .15s; }
.run-when { color: var(--faint); font-size: .88rem; font-variant-numeric: tabular-nums; white-space: nowrap; }
.run-list li.fresh { animation: slide-in .6s cubic-bezier(.2, .8, .3, 1); }
@keyframes slide-in { from { opacity: 0; transform: translateY(-.6rem); background: var(--accent-soft); } }
.run-list li.changed .status-dot { animation: burst .9s ease-out; }
@keyframes burst { from { box-shadow: 0 0 0 0 currentColor; } to { box-shadow: 0 0 0 .8rem transparent; } }

@media (min-width: 1100px) {
  .columns { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(22rem, 1fr); gap: 1.6rem; align-items: start; }
  .runs-column h2 { margin-top: .15rem; }
}
@media (max-width: 520px) {
  .week { --label: 7.5rem; }
  .card { grid-template-columns: auto minmax(0, 1fr); }
  .row-buttons { grid-column: 2; }
  .day-label { font-size: .72rem; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
}
`;
document.head.append(style);
