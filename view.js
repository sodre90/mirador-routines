/**
 * Routines, drawn in a workspace's tab: the routines with when they next run, an editor for one, and the runs the user
 * comes back to. Mirador posts the workspace's state; every change goes back to the plugin's host code with `mirador.send`.
 */

const page = document.createElement("main");
page.className = "routines";
document.body.append(page);

const PRESETS = [
  { kind: "weekdays", label: "Weekdays" },
  { kind: "daily", label: "Every day" },
  { kind: "days", label: "On chosen days" },
  { kind: "hours", label: "Every few hours" },
  { kind: "cron", label: "Cron" },
];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const STATUS_WORDS = { running: "working", finished: "done", failed: "failed", stopped: "stopped" };

let state = { routines: [], runs: [], profiles: [] };
let editing = null;

const el = (tag, attributes = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === "class") node.className = value;
    else if (name.startsWith("on")) node.addEventListener(name.slice(2), value);
    else if (name === "text") node.textContent = value;
    else node.setAttribute(name, value === true ? "" : value);
  }
  for (const child of children.flat()) if (child) node.append(child);
  return node;
};

const send = (action) => window.mirador.send(action).catch((error) => say(error.message, true));

const say = (text, failed = false) => {
  const line = page.querySelector(".notice");
  line.textContent = text;
  line.classList.toggle("failed", failed);
};

/** The schedule the editor holds, from whichever controls its preset shows. */
function scheduleFrom(form) {
  const kind = form.querySelector('[name="preset"]').value;
  if (kind === "cron") return { kind, cron: form.querySelector('[name="cron"]').value };
  if (kind === "hours") return { kind, every: Number(form.querySelector('[name="every"]').value) };
  const time = form.querySelector('[name="time"]').value;
  if (kind === "days") return { kind, days: [...form.querySelectorAll('[name="day"]:checked')].map((box) => Number(box.value)), time };
  return { kind, time };
}

let previewTimer;

function preview(form) {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const shown = await window.mirador.send({ kind: "describe", schedule: scheduleFrom(form) });
    const line = form.querySelector(".preview");
    if (!shown) return;
    line.textContent = shown.problem ? shown.problem : `${shown.words} · next ${shown.nextRun ?? "never"}`;
    line.classList.toggle("failed", Boolean(shown.problem));
  }, 200);
}

function editorForm(routine) {
  const preset = PRESETS.find((each) => each.kind === routine.schedule.kind) ?? PRESETS[0];
  const form = el("div", { class: "editor" });
  const name = el("input", { name: "name", value: routine.name, placeholder: "Check the e2e results", "aria-label": "Name" });
  const profile = el(
    "select",
    { name: "profile", "aria-label": "Profile" },
    ...state.profiles.map((each) => el("option", { value: each.name, selected: each.name === routine.profile }, `${each.name} · ${each.agent}`)),
  );
  const what = el("textarea", { name: "what", placeholder: "What the agent should do", rows: 3 });
  what.value = routine.what;
  const outcome = el("textarea", { name: "outcome", placeholder: "What you want to see when it ends", rows: 2 });
  outcome.value = routine.outcome;

  const choosePreset = el(
    "select",
    { name: "preset", "aria-label": "How often" },
    ...PRESETS.map((each) => el("option", { value: each.kind, selected: each.kind === preset.kind }, each.label)),
  );
  const time = el("input", { type: "time", name: "time", value: routine.schedule.time ?? "09:00", "aria-label": "At" });
  const every = el("input", { type: "number", name: "every", min: 1, max: 24, value: routine.schedule.every ?? 6, "aria-label": "Every how many hours" });
  const cron = el("input", { type: "text", name: "cron", value: routine.schedule.cron ?? "30 7 * * 1-5", spellcheck: false, "aria-label": "Cron line" });
  const dayBoxes = DAYS.map(
    (label, day) =>
      el("label", { class: "day" }, el("input", { type: "checkbox", name: "day", value: day, checked: (routine.schedule.days ?? []).includes(day) }), label),
  );

  const fields = el("div", { class: "when" }, choosePreset, el("div", { class: "detail" }));
  const detail = fields.querySelector(".detail");
  const showDetail = () => {
    const kind = choosePreset.value;
    detail.replaceChildren(
      ...(kind === "cron" ? [cron] : kind === "hours" ? [el("span", { text: "every" }), every, el("span", { text: "hours" })] : kind === "days" ? [...dayBoxes, time] : [time]),
    );
    preview(form);
  };
  choosePreset.addEventListener("change", showDetail);
  for (const input of [time, every, cron, ...dayBoxes]) input.addEventListener("input", () => preview(form));
  showDetail();

  const previewLine = el("p", { class: "preview" });
  const done = el(
    "button",
    { class: "primary", onclick: () => send({ kind: "save", routine: { ...routine, name: name.value.trim(), profile: profile.value, what: what.value.trim(), outcome: outcome.value.trim(), schedule: scheduleFrom(form) } }).then(() => (editing = null) && draw()) },
    "Save routine",
  );
  const cancel = el("button", { onclick: () => ((editing = null), draw()) }, "Cancel");
  form.append(el("label", { class: "field" }, el("span", { text: "Name" }), name), el("label", { class: "field" }, el("span", { text: "Runs on" }), profile), el("label", { class: "field" }, el("span", { text: "What to do" }), what), el("label", { class: "field" }, el("span", { text: "End result" }), outcome), el("div", { class: "field" }, el("span", { text: "When" }), fields), previewLine, el("div", { class: "buttons" }, done, cancel));
  return form;
}

function routineRow(routine) {
  const when = el("p", { class: routine.problem ? "when-words failed" : "when-words" }, routine.problem ? `${routine.words} — ${routine.problem}` : `${routine.words} · next ${routine.nextRun ?? "never"}`);
  return el(
    "li",
    { class: routine.on ? "" : "off" },
    el("button", { class: "switch", onclick: () => send({ kind: "toggle", id: routine.id }), "aria-label": routine.on ? "Switch off" : "Switch on", title: routine.on ? "Switch off" : "Switch on" }, routine.on ? "on" : "off"),
    el("div", { class: "about" }, el("h3", { text: routine.name || "Untitled routine" }), when, el("p", { class: "profile", text: `${routine.profile} · ${routine.what.split("\n")[0]}` })),
    el(
      "div",
      { class: "row-buttons" },
      el("button", { onclick: () => send({ kind: "runNow", id: routine.id }), title: "Start a conversation on it now" }, "Run now"),
      el("button", { onclick: () => ((editing = { ...routine }), draw()) }, "Edit"),
      el("button", { class: "danger", onclick: () => send({ kind: "delete", id: routine.id }) }, "Delete"),
    ),
  );
}

function runRow(run) {
  const status = el("span", { class: `status ${run.status}` }, STATUS_WORDS[run.status] ?? run.status);
  return el("li", {}, status, el("span", { class: "run-title", text: run.title }), el("time", { class: "run-time", datetime: new Date(run.startedAt).toISOString(), text: new Date(run.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }));
}

function draw() {
  page.replaceChildren();
  const routines = state.routines;
  const list = el("ul", { class: "routine-list" }, ...routines.map(routineRow));
  const add = el("button", { class: "primary add", onclick: () => send({ kind: "new" }).then((blank) => ((editing = blank), draw())) }, "New routine");
  const runs = el("ul", { class: "run-list" }, ...state.runs.map(runRow));
  page.append(
    el("header", {}, el("h1", { text: "Routines" }), el("p", { class: "notice" })),
    routines.length === 0 ? el("p", { class: "empty" }, "Nothing runs here yet. A routine is a prompt, what should come of it, a profile to run on and a time to run at.") : list,
    add,
    editing ? editorForm(editing) : null,
    el("h2", { text: "Recent runs" }),
    state.runs.length === 0 ? el("p", { class: "empty", text: "No runs yet." }) : runs,
  );
}

window.mirador.onState((shown) => {
  state = shown ?? { routines: [], runs: [], profiles: [] };
  if (editing) editing = state.routines.find((each) => each.id === editing.id) ?? editing;
  draw();
});

const style = document.createElement("style");
style.textContent = `
body { margin: 0; background: var(--mirador-background, transparent); color: var(--mirador-foreground, inherit); font: 14px/1.45 var(--mirador-font, system-ui, sans-serif); }
.routines { padding: 14px 16px 28px; max-width: 720px; }
header h1 { font-size: 17px; margin: 0; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .05em; opacity: .65; margin: 22px 0 6px; }
.notice { min-height: 18px; font-size: 13px; color: var(--mirador-muted-foreground, #666); margin: 4px 0 10px; }
.notice.failed, .when-words.failed, .preview.failed { color: var(--mirador-destructive, #c0392b); }
.routine-list, .run-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.routine-list li { display: grid; grid-template-columns: auto 1fr auto; gap: 10px; align-items: start; border: 1px solid var(--mirador-border, #ddd); border-radius: 8px; padding: 9px 11px; background: var(--mirador-card, #fafafa); }
.routine-list li.off { opacity: .55; }
.about h3 { margin: 0 0 2px; font-size: 14px; }
.when-words { margin: 0; font-size: 13px; }
.profile { margin: 2px 0 0; font-size: 12px; opacity: .7; }
.row-buttons { display: flex; gap: 6px; }
button, input, select, textarea { font: inherit; color: inherit; background: var(--mirador-background, #fff); border: 1px solid var(--mirador-border, #ccc); border-radius: 6px; padding: 4px 8px; }
button { cursor: pointer; }
button:hover { background: var(--mirador-accent, #f0f0f5); }
button.switch { width: 42px; }
button.primary { background: var(--mirador-primary, #3b6ef6); color: var(--mirador-primary-foreground, #fff); border-color: transparent; }
button.danger:hover { background: var(--mirador-destructive, #c0392b); color: #fff; }
.add { margin-top: 10px; }
.empty { font-size: 13px; opacity: .7; }
.editor { margin-top: 16px; border: 1px solid var(--mirador-border, #ddd); border-radius: 8px; padding: 12px; display: grid; gap: 8px; background: var(--mirador-card, #fafafa); }
.field { display: grid; gap: 3px; }
.field > span { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; opacity: .6; }
textarea { resize: vertical; }
.when { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.detail { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.day { display: inline-flex; gap: 3px; align-items: center; font-size: 13px; }
.preview { margin: 0; font-size: 13px; min-height: 18px; opacity: .8; }
.buttons { display: flex; gap: 8px; }
.run-list li { display: grid; grid-template-columns: 74px 1fr auto; gap: 8px; align-items: baseline; font-size: 13px; }
.status { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; opacity: .8; }
.status.running { color: var(--mirador-primary, #3b6ef6); }
.status.failed { color: var(--mirador-destructive, #c0392b); }
.run-time { opacity: .6; }
`;
document.head.append(style);

draw();
