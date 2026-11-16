import path from "node:path";
import { fileURLToPath } from "node:url";
import { selectionPlan } from "./selection.js";
import { allTemplates, findTemplate, FIRST_TEMPLATE, namesMatch, templatesFor } from "./templates.js";
import { logLine, recordCompleted, refreshFile, resetTemplates, setMessage, setTemplate, state } from "./status.js";
import { getPage, saveEventChanges, scanTemplateNames, screenshot, updateTemplateOverlay, waitForTemplateList } from "./snappic.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function publicError(error) {
  const raw = String(error?.message || error || "The run stopped.");
  if (/existing browser session|profile is already in use/i.test(raw)) {
    return "Check templates could not open a second updater window because one was already open. Click Check templates again.";
  }
  if (/has been closed|Target closed/i.test(raw)) {
    return "The updater Chrome window closed. Click Check templates to open it again.";
  }
  const line = raw.split("\n")[0].trim();
  return line.length > 220 ? `${line.slice(0, 220)}…` : line;
}

export function startJob(options = {}) {
  if (state.running) {
    const error = new Error("A job is already running.");
    error.statusCode = 409;
    throw error;
  }
  state.running = true;
  state.error = null;
  state.cancelRequested = false;
  state.awaitingApproval = false;
  if (options.mode === "update-all") {
    state.startedAt = Date.now();
    state.finishedAt = null;
  }
  setMessage("Starting.");
  const promise = runJob(options)
    .catch((error) => {
      const message = publicError(error);
      state.error = message;
      setMessage(message);
      logLine(`Stopped: ${message}`);
      return { ok: false, error: message };
    })
    .finally(() => {
      if (state.startedAt && state.finishedAt == null) state.finishedAt = Date.now();
      state.running = false;
      state.awaitingLogin = false;
      state.cancelRequested = false;
    });
  return promise;
}

export async function runJob(options = {}) {
  const mode = options.mode;
  if (!["dry-run", "update-one", "update-all"].includes(mode)) {
    throw new Error("Choose Check templates or Update All.");
  }

  const file = refreshFile(options.overlayPath);
  const files = { ...(options.files || {}) };
  if (options.overlayPath) files.overlay = options.overlayPath;
  const resolution = options.resolution || options.selection?.resolution || null;
  const plan = selectionPlan({ ...(options.selection || {}), files, resolution });
  resetTemplates();
  state.mode = mode;
  state.lastResult = null;
  if (mode !== "dry-run") state.eventSave = "idle";
  state.progress.current = "";
  logLine(`Job started: ${mode}. ${plan.ok ? plan.summary : "No changes yet."}`);

  if (mode !== "dry-run") {
    if (!plan.ok) throw new Error(plan.error);
  }

  const page = options.page || (await getPage());
  if (!options.fixture) {
    await waitForTemplateList(page, { eventId: options.eventId || "" });
  }

  const selected = templatesFor(options.groups);
  if (!selected.length) {
    throw new Error("Choose Paparazzi, Slo Mo Only, or both. No templates were changed.");
  }
  const selectedNames = new Set(selected.map((template) => template.name));
  const found = await scanTemplateNames(page);
  const missing = [];
  for (const template of allTemplates()) {
    if (!selectedNames.has(template.name)) {
      setTemplate(template.name, "skipped", "Not selected for this run");
      continue;
    }
    const match = found.find((item) => namesMatch(item.name, template.name));
    if (!match) {
      missing.push(template.name);
      setTemplate(template.name, "missing", "Not on the template list");
      continue;
    }
    if (mode === "dry-run") setTemplate(template.name, "found", `On screen as "${match.raw}"`);
  }

  if (!options.fixture) {
    const shot = await screenshot(page, "template-list.png");
    logLine(`Template list screenshot: ${path.relative(root, shot)}`);
  }

  if (missing.length) {
    throw new Error(`Missing ${missing.length} of ${selected.length} templates: ${missing.join(", ")}. No templates were changed.`);
  }

  if (mode === "dry-run") {
    const result = { ok: true, mode, identified: selected.length, changed: false };
    state.lastResult = result;
    setMessage(`Identified ${selected.length} / ${selected.length} templates. No templates were changed.`);
    logLine(state.message);
    return result;
  }

  const queue = mode === "update-all" ? selected : [requiredSingleTemplate(options.template)];
  for (const [index, template] of queue.entries()) {
    if (state.cancelRequested) {
      markEventSaveNeeded();
      throw new Error(`Stopped before ${template.name}. Press Save changes on the template list or the templates already updated go back to how they were.`);
    }
    const match = found.find((item) => namesMatch(item.name, template.name));
    state.progress.current = template.name;
    setMessage(`Updating ${index + 1} / ${queue.length} — ${template.name}`);
    setTemplate(template.name, "running", "Opening the template");
    try {
      await updateTemplateOverlay(page, { ...template, raw: match.raw }, files.overlay, {
        master: plan.master,
        files,
        resolution,
        timeline: plan.timeline,
      });
      setTemplate(template.name, "saved", "Save clicked. Back on the template list.");
      recordCompleted({
        template: template.name,
        group: template.group,
        seconds: template.seconds,
        overlay: files.overlay || "",
        sha256: file.sha256,
        verified: true,
      });
      logLine(`Completed ${state.progress.completed} / 18 — ${template.name}`);
    } catch (error) {
      setTemplate(template.name, "failed", error.message);
      markEventSaveNeeded();
      throw new Error(`${template.name} failed. The remaining templates were not changed. ${error.message}`);
    }
  }

  if (options.autoSave !== false) {
    await finishEventSave(page);
  } else {
    state.eventSave = "needed";
    setMessage("The templates were updated. Press Save changes on the template list. If you leave without it, they go back to how they were.");
    logLine(state.message);
  }

  const result = {
    ok: true,
    mode,
    changed: queue.map((template) => template.name),
    eventSaved: state.eventSave === "saved",
  };
  state.lastResult = result;
  if (mode === "update-one") state.awaitingApproval = true;
  return result;
}

export async function finishEventSave(page) {
  setMessage("Clicking Save changes on the template list. That is the save that keeps these updates in the event.");
  logLine(state.message);
  try {
    const saved = await saveEventChanges(page);
    if (saved?.clicked) {
      state.eventSave = "saved";
      setMessage("Saved to the event. Save changes was clicked on the template list.");
    } else {
      state.eventSave = "needed";
      setMessage("Press Save changes on the template list. The Save button inside each template does not keep these updates. If you leave without Save changes, they go back to how they were.");
    }
  } catch (error) {
    state.eventSave = "failed";
    setMessage(`Save changes did not finish. Press Save changes on the template list or these updates will revert. ${publicError(error)}`);
  }
  logLine(state.message);
  return state.eventSave === "saved";
}

function markEventSaveNeeded() {
  if (state.eventSave === "saved") return;
  if (!state.templates.some((template) => template.status === "saved")) return;
  state.eventSave = "needed";
}

function requiredSingleTemplate(name) {
  const template = findTemplate(name || FIRST_TEMPLATE);
  if (!template || template.name !== FIRST_TEMPLATE) {
    throw new Error("The single-template check only updates 10 Second (Paparazzi).");
  }
  return template;
}
