const updateAll = document.querySelector("#update-all");
const dryRun = document.querySelector("#dry-run");
const openLogin = document.querySelector("#open-login");
const stop = document.querySelector("#stop");
const saveEvent = document.querySelector("#save-event");
const templates = document.querySelector("#templates");
const instructions = document.querySelector("#instructions");
const instructionsDialog = document.querySelector("#instructions-dialog");
instructions.addEventListener("click", () => instructionsDialog.showModal());

updateAll.addEventListener("click", () => start("update-all"));
dryRun.addEventListener("click", () => start("dry-run"));
openLogin.addEventListener("click", async () => {
  openLogin.disabled = true;
  const response = await fetch("/api/open-login", { method: "POST" });
  const body = await response.json();
  if (!body.ok) document.querySelector("#message").textContent = body.error;
  openLogin.disabled = stateRunning && !stateAwaitingLogin;
});

let stateRunning = false;
let stateAwaitingLogin = false;
stop.addEventListener("click", async () => {
  stop.disabled = true;
  await fetch("/api/stop", { method: "POST" });
});

saveEvent.addEventListener("click", async () => {
  saveEvent.disabled = true;
  const response = await fetch("/api/save-event", { method: "POST" });
  const body = await response.json();
  if (!body.ok && body.error) document.querySelector("#activity-text").textContent = body.error;
  refresh();
});

const chosen = {};
const groupsOn = { Paparazzi: true, "Slo Mo Only": true };

function selectedGroups() {
  return Object.entries(groupsOn).filter(([, on]) => on).map(([name]) => name);
}

function selectedMaster() {
  return [...document.querySelectorAll("[data-page='master']:checked")].map((input) => input.value);
}

function selectedResolution() {
  const picked = document.querySelector("input[name='resolution']:checked");
  if (!picked) return null;
  const [aspect, size] = picked.value.split("|");
  return { aspect, size };
}

function timelineSelection() {
  return {
    start: Boolean(document.querySelector("[data-page='timeline'][value='start']")?.checked),
    end: Boolean(document.querySelector("[data-page='timeline'][value='end']")?.checked),
  };
}

function readyToUpdate() {
  const master = selectedMaster();
  const timeline = timelineSelection();
  if (!selectedGroups().length || (!master.length && !timeline.start && !timeline.end)) return false;
  for (const id of ["overlay", "preview", "soundtrack", "overlayMask"]) {
    if (master.includes(id) && !chosen[id]) return false;
  }
  if (timeline.start && !chosen.timelineStart) return false;
  if (timeline.end && !chosen.timelineEnd) return false;
  if (master.includes("resolution") && !selectedResolution()) return false;
  return true;
}

function syncChoices() {
  for (const block of document.querySelectorAll(".choice-block")) {
    const box = block.querySelector("input[type='checkbox']");
    block.classList.toggle("checked", box.checked);
  }
}

for (const input of document.querySelectorAll("[data-page='master'], [data-page='timeline']")) {
  input.addEventListener("change", () => {
    syncChoices();
    refresh();
  });
}

for (const input of document.querySelectorAll("input[name='resolution']")) {
  input.addEventListener("change", () => refresh());
}

for (const button of document.querySelectorAll("[data-choose]")) {
  button.addEventListener("click", async () => {
    const kind = button.dataset.choose;
    const block = button.closest(".choice-block");
    const box = block?.querySelector("input[type='checkbox']");
    const wasChecked = Boolean(box?.checked);
    if (box && !wasChecked) {
      box.checked = true;
      syncChoices();
    }
    button.disabled = true;
    const response = await fetch(`/api/choose-file?kind=${encodeURIComponent(kind)}`, { method: "POST" });
    const body = await response.json();
    button.disabled = false;
    const slot = document.querySelector(`[data-chosen='${kind}']`);
    if (body.cancelled) {
      if (box && !wasChecked) {
        box.checked = false;
        syncChoices();
      }
      return;
    }
    if (!body.ok) {
      delete chosen[kind];
      delete slot.dataset.shown;
      slot.replaceChildren(document.createTextNode(body.error || "That file was not accepted."));
      return;
    }
    refresh();
  });
}

function paintChosen(state) {
  for (const kind of ["overlay", "preview", "soundtrack", "overlayMask", "timelineStart", "timelineEnd"]) {
    const slot = document.querySelector(`[data-chosen='${kind}']`);
    const item = state.chosenFiles?.[kind];
    if (!slot) continue;
    if (!item?.name || !item?.path) {
      if (slot.dataset.shown) {
        delete chosen[kind];
        delete slot.dataset.shown;
        slot.replaceChildren();
      }
      continue;
    }
    chosen[kind] = item.name;
    if (slot.dataset.shown === item.path) continue;
    slot.dataset.shown = item.path;
    const name = document.createElement("strong");
    name.textContent = item.name;
    const where = document.createElement("span");
    where.className = "picked-path";
    where.textContent = item.path;
    slot.replaceChildren(name, where);
  }
}

async function start(mode, resumeFrom = "") {
  const response = await fetch("/api/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      mode,
      resumeFrom,
      groups: selectedGroups(),
      selection: {
        master: selectedMaster(),
        resolution: selectedResolution(),
        timeline: timelineSelection(),
      },
      autoSave: document.querySelector("#auto-save").checked,
      eventId: document.querySelector("#event-id").value.trim(),
    }),
  });
  const body = await response.json();
  if (!body.ok) document.querySelector("#message").textContent = body.error;
}

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const clock = `${minutes}:${String(seconds).padStart(2, "0")}`;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}` : clock;
}

function paintElapsed(state) {
  const elapsed = document.querySelector("#elapsed");
  if (!state.startedAt) {
    elapsed.hidden = true;
    return;
  }
  const end = state.running ? Date.now() : state.finishedAt || Date.now();
  elapsed.hidden = false;
  elapsed.textContent = `Elapsed ${formatElapsed(end - state.startedAt)}`;
}

async function refresh() {
  const response = await fetch("/api/status");
  const state = await response.json();
  render(state);
}

const eventInput = document.querySelector("#event-id");
const eventLink = document.querySelector("#event-link");
let eventTimer = 0;

document.querySelector("#release").addEventListener("click", async () => {
  const button = document.querySelector("#release");
  button.disabled = true;
  const response = await fetch("/api/license", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ release: true }),
  });
  const body = await response.json();
  button.disabled = false;
  document.querySelector("#license-key").value = "";
  if (!body.ok) document.querySelector("#license-status").textContent = body.error || "This code could not be freed.";
  refresh();
});

document.querySelector("#activate").addEventListener("click", async () => {
  const button = document.querySelector("#activate");
  button.disabled = true;
  const response = await fetch("/api/license", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: document.querySelector("#license-key").value }),
  });
  const body = await response.json();
  button.disabled = false;
  if (!body.ok) document.querySelector("#license-status").textContent = body.error || "That key could not be activated.";
  refresh();
});

document.querySelector("#read-event").addEventListener("click", async () => {
  const button = document.querySelector("#read-event");
  button.disabled = true;
  const response = await fetch("/api/event-from-page", { method: "POST" });
  const body = await response.json();
  button.disabled = false;
  if (!body.ok) {
    eventLink.textContent = body.error || "The event ID was not on that page.";
    return;
  }
  eventInput.value = body.eventId;
  delete eventInput.dataset.dirty;
  showEventLink(body.eventId);
});

eventInput.addEventListener("input", () => {
  eventInput.dataset.dirty = "1";
  showEventLink(eventInput.value);
  clearTimeout(eventTimer);
  eventTimer = setTimeout(saveEventId, 400);
});

function showEventLink(value) {
  const id = String(value || "").trim();
  if (!id) {
    eventLink.textContent = "No event ID yet. Check templates opens the events list.";
    return;
  }
  if (!/^\d{4,12}$/.test(id)) {
    eventLink.textContent = "The event ID is the number in your template link.";
    return;
  }
  eventLink.textContent = `Next open: https://app.snappic.com/event/video/template?edit=true&event_id=${id}`;
}

async function saveEventId() {
  const eventId = eventInput.value.trim();
  if (eventId && !/^\d{4,12}$/.test(eventId)) return;
  const response = await fetch("/api/event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ eventId }),
  });
  const body = await response.json();
  if (!body.ok) {
    eventLink.textContent = body.error || "That event ID was not saved.";
    return;
  }
  delete eventInput.dataset.dirty;
  showEventLink(body.eventId);
}

function paintEvent(state) {
  if (document.activeElement === eventInput || eventInput.dataset.dirty) {
    showEventLink(eventInput.value);
    return;
  }
  if (eventInput.value !== (state.eventId || "")) eventInput.value = state.eventId || "";
  showEventLink(state.eventId);
}

function render(state) {
  syncChoices();
  paintChosen(state);
  paintEvent(state);
  const fileStatus = document.querySelector("#file-status");
  const dot = document.querySelector("#file-dot");
  const ready = readyToUpdate();
  dot.className = `dot ${ready ? "ready" : "missing"}`;
  fileStatus.textContent = ready ? "Ready" : "Choose a file for each checked item";

  const chosenCount = selectedGroups().length * 9;
  const pendingOnly = (state.templates || []).every((template) => !template.status || template.status === "pending");
  const completed = pendingOnly ? 0 : (state.progress?.completed || 0);
  const total = pendingOnly ? chosenCount : (state.progress?.total || chosenCount);
  document.querySelector("#progress-count").textContent = `${completed} / ${total}`;
  const track = document.querySelector("#progress-track");
  document.querySelector("#progress-bar").style.width = total ? `${Math.min(100, (completed / total) * 100)}%` : "0%";
  track.classList.toggle("working", Boolean(state.running));
  const pulse = document.querySelector("#pulse");
  pulse.hidden = !state.running;
  pulse.classList.toggle("on", Boolean(state.running));
  document.querySelector("#activity-text").textContent = state.message || "Idle";
  paintElapsed(state);
  document.title = `${completed}/${total} overlays`;
  const notice = document.querySelector("#save-notice");
  const eventSave = state.eventSave || "idle";
  notice.hidden = eventSave === "idle" || eventSave === "saving";
  notice.classList.toggle("saved", eventSave === "saved");
  const noticeTitle = document.querySelector("#save-notice-title");
  const noticeText = document.querySelector("#save-notice-text");
  const noticeLabel = document.querySelector("#save-notice-label");
  if (eventSave === "saved") {
    noticeLabel.textContent = "Saved to the event";
    noticeTitle.textContent = "Save changes was clicked";
    noticeText.textContent = "These updates stay with the event.";
    saveEvent.hidden = true;
  } else if (eventSave === "needed" || eventSave === "failed") {
    noticeLabel.textContent = "Not saved to the event";
    noticeTitle.textContent = "Press Save changes";
    noticeText.textContent = "Saving inside a template is not enough. Press Save changes on the template list, or the updates revert.";
    saveEvent.hidden = false;
    saveEvent.disabled = Boolean(state.running);
  }

  stateRunning = Boolean(state.running);
  stateAwaitingLogin = Boolean(state.awaitingLogin);
  const master = selectedMaster();
  const note = document.querySelector("#choice-note");
  const labels = { overlay: "Overlay", preview: "Preview", soundtrack: "Soundtrack", overlayMask: "Overlay Mask", resolution: "Resolution" };
  const timeline = timelineSelection();
  const timelinePlaces = [timeline.start ? "Start" : "", timeline.end ? "End" : ""].filter(Boolean);
  const timelineText = timelinePlaces.length ? `Timeline ${timelinePlaces.join(" and ")}` : "";
  if (!selectedGroups().length) {
    note.textContent = "Check Paparazzi, Slo Mo Only, or both.";
  } else if (!master.length && !timelinePlaces.length) {
    note.textContent = "Check Overlay, Soundtrack, or the Timeline uploaded video.";
  } else if (!ready) {
    note.textContent = "Choose the file for each checked item. Recorded timeline clips stay as they are.";
  } else {
    const changing = [...master.map((id) => labels[id]), timelineText].filter(Boolean).join(", ");
    const groupText = selectedGroups().join(" and ");
    note.textContent = `Changes ${changing} on ${groupText}. Poster order does not matter.`;
  }
  updateAll.textContent = chosenCount === 18 ? "Update All 18 Overlays" : chosenCount ? `Update ${chosenCount} templates` : "Update templates";
  const templateNote = document.querySelector("#template-note");
  const hasProgress = (state.templates || []).some((template) => template.status === "saved" || template.status === "failed");
  const hasRemaining = (state.templates || []).some((template) => (template.status === "failed" || template.status === "pending") && groupsOn[template.group] !== false);
  templateNote.textContent = hasProgress && hasRemaining
    ? "Click a template that is not done to continue from there. Done templates stay as they are."
    : "Uncheck a group to leave it alone.";
  const failNotice = document.querySelector("#fail-notice");
  const failed = (state.templates || []).filter((template) => template.status === "failed" || template.status === "missing");
  failNotice.hidden = failed.length === 0;
  failNotice.textContent = failed.map((template) => `${template.name} failed. ${failureReason(template)}`).join(" ");
  const licensed = Boolean(state.license?.active);
  const keyInput = document.querySelector("#license-key");
  document.querySelector("#license-status").textContent = state.license?.message || "Paste the key from the checkout page. It works on this computer only.";
  if (state.license?.key && document.activeElement !== keyInput) keyInput.value = state.license.key;
  keyInput.disabled = state.running;
  document.querySelector("#activate").disabled = licensed || state.running;
  document.querySelector("#release").disabled = !licensed || state.running;
  updateAll.disabled = state.running || !ready || !licensed;
  dryRun.disabled = state.running;
  openLogin.disabled = state.running && !state.awaitingLogin;
  stop.hidden = !state.running;
  stop.disabled = state.cancelRequested;

  const groups = new Map();
  for (const template of state.templates || []) {
    if (!groups.has(template.group)) groups.set(template.group, []);
    groups.get(template.group).push(template);
  }
  templates.replaceChildren();
  for (const [group, items] of groups) {
    const section = document.createElement("section");
    section.className = "group";
    const title = document.createElement("div");
    title.className = "group-title";
    const label = document.createElement("label");
    label.className = "group-check";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = groupsOn[group] !== false;
    box.disabled = Boolean(state.running);
    box.addEventListener("change", () => {
      groupsOn[group] = box.checked;
      refresh();
    });
    label.append(box, document.createTextNode(group));
    title.append(label);
    section.classList.toggle("off", groupsOn[group] === false);
    section.append(title);
    const pills = document.createElement("div");
    pills.className = "pills";
    for (const item of items) {
      const status = item.status || "pending";
      const slot = document.createElement("span");
      slot.className = `pill-slot ${status}`;
      const word = document.createElement("span");
      word.className = "pill-word";
      word.textContent = pillWord(status);
      const resume = canResume(state, item, status);
      const pill = document.createElement(resume ? "button" : "span");
      pill.className = `pill ${status}${resume ? " resume" : ""}`;
      pill.textContent = String(item.seconds);
      const failedReason = status === "failed" || status === "missing" ? failureReason(item) : "";
      pill.title = failedReason
        ? `${item.name} failed. ${failedReason}`
        : resume
          ? `Continue from ${item.name}. Done templates stay as they are.`
          : `${item.name}: ${word.textContent || "waiting"}`;
      if (resume) {
        pill.type = "button";
        pill.addEventListener("click", () => start("update-all", item.name));
      }
      slot.append(word, pill);
      pills.append(slot);
    }
    section.append(pills);
    templates.append(section);
  }

  const log = document.querySelector("#log");
  const lines = [...(state.log || [])].reverse().slice(0, 40);
  log.replaceChildren();
  for (const entry of lines) {
    const item = document.createElement("li");
    const time = document.createElement("time");
    time.textContent = new Date(entry.at).toLocaleTimeString();
    item.append(time, document.createTextNode(entry.line));
    log.append(item);
  }
}

function failureReason(template) {
  const detail = String(template.detail || "").replace(/\s+/g, " ").trim();
  return detail || "The template did not finish.";
}

function canResume(state, item, status) {
  if (state.running || !state.license?.active || !readyToUpdate()) return false;
  if (groupsOn[item.group] === false) return false;
  if (status !== "failed" && status !== "pending") return false;
  return (state.templates || []).some((template) => template.status === "saved" || template.status === "failed");
}

function pillWord(status) {
  if (status === "saved" || status === "found") return "done";
  if (status === "running") return "working";
  if (status === "failed" || status === "missing") return "failed";
  return "";
}

refresh();
setInterval(refresh, 1000);
