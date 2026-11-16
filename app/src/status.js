import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectOverlayFile } from "./overlay-file.js";
import { allTemplates } from "./templates.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const logDir = path.join(root, "logs");

export const busListeners = new Set();

export const state = {
  running: false,
  mode: null,
  startedAt: null,
  finishedAt: null,
  message: "Idle",
  awaitingLogin: false,
  awaitingApproval: false,
  cancelRequested: false,
  eventSave: "idle",
  error: null,
  progress: { completed: 0, total: 18, current: "" },
  templates: freshTemplates(),
  log: [],
  file: null,
  lastResult: null,
};

function freshTemplates() {
  return allTemplates().map((template) => ({
    ...template,
    status: "pending",
    detail: "",
  }));
}

export function resetTemplates() {
  state.templates = freshTemplates();
  updateProgress();
}

export function refreshFile(explicit) {
  state.file = inspectOverlayFile(explicit);
  emit();
  return state.file;
}

export function updateProgress() {
  const active = state.templates.filter((template) => template.status !== "skipped");
  const completed = active.filter((template) => template.status === "saved" || template.status === "found").length;
  state.progress = {
    completed,
    total: active.length || state.templates.length || 18,
    current: state.progress.current || "",
  };
}

export function setTemplate(name, status, detail = "") {
  const template = state.templates.find((item) => item.name === name);
  if (template) {
    template.status = status;
    template.detail = detail;
  }
  updateProgress();
  emit();
}

export function setMessage(message, extra = {}) {
  state.message = message;
  Object.assign(state, extra);
  emit();
}

export function logLine(line) {
  const entry = { at: new Date().toISOString(), line };
  state.log.push(entry);
  if (state.log.length > 300) state.log.shift();
  fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(path.join(logDir, "run.log"), `${JSON.stringify(entry)}\n`);
  emit();
}

export function recordCompleted(entry) {
  fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(path.join(logDir, "completed.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

export function emit() {
  for (const listener of busListeners) listener();
}

refreshFile();
