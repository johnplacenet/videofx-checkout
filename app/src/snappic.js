import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { isOverlayRemoveControl } from "./safety.js";
import { logLine, setMessage, state } from "./status.js";
import { matchTemplateNames, namesMatch, searchPhrases } from "./templates.js";
import { EVENTS_URL, currentEventId, eventIdFromUrl, rememberEventId, templateUrl } from "./event-link.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PROFILE_DIR = path.join(root, ".chrome-profile");
export const LOGIN_URL = "https://app.snappic.com/login";
const LOGIN_WAIT_MS = 10 * 60 * 1000;
const IGNORE_HOST = /google|gstatic|cookiebot|intercom|facebook|segment|doubleclick|firstpromoter|sentry|googletagmanager/i;

let session = null;
let dialogMode = "dismiss";
let lastDialogMessage = "";

export function setDialogMode(mode) {
  dialogMode = mode;
}

export async function getPage() {
  if (session?.page && !session.page.isClosed()) return session.page;
  if (session) {
    await session.context.close().catch(() => {});
    session = null;
  }
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  logLine("Opening a dedicated Chrome window for the template list.");
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const context = await chromium.launchPersistentContext(PROFILE_DIR, {
        channel: "chrome",
        headless: false,
        viewport: null,
        acceptDownloads: false,
        args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
      });
      const page = context.pages()[0] || (await context.newPage());
      page.setDefaultTimeout(20000);
      page.setDefaultNavigationTimeout(60000);
      page.on("dialog", async (dialog) => {
        const message = dialog.message();
        lastDialogMessage = message;
        logLine(`Browser dialog: ${message}`);
        const overlayConfirm = dialogMode === "accept-overlay" && /overlay|file|video|image/i.test(message) && !/template/i.test(message);
        if (overlayConfirm) {
          await dialog.accept();
          return;
        }
        await dialog.dismiss().catch(() => {});
      });
      session = { context, page };
      return page;
    } catch (error) {
      lastError = error;
      if (attempt === 0 && /existing browser session|profile is already in use/i.test(error.message || "")) {
        logLine("The updater Chrome was already open. Closing that window and opening it again.");
        await quitProfileChrome();
        continue;
      }
      break;
    }
  }
  const detail = String(lastError?.message || lastError || "unknown error").split("\n")[0];
  throw new Error(`The updater Chrome window could not open. ${detail}`);
}

function profileChromePids() {
  if (process.platform === "win32") return windowsProfileChromePids();
  return new Promise((resolve) => {
    execFile("ps", ["-ax", "-o", "pid=,command="], { maxBuffer: 8_000_000 }, (error, stdout) => {
      if (error) return resolve([]);
      const pids = [];
      for (const line of String(stdout).split("\n")) {
        if (!line.includes(PROFILE_DIR) || !line.includes("Google Chrome") || line.includes("Helper")) continue;
        const pid = Number(line.trim().split(/\s+/)[0]);
        if (pid > 0 && pid !== process.pid) pids.push(pid);
      }
      resolve(pids);
    });
  });
}

function windowsProfileChromePids() {
  const script = "Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-Command", script], { maxBuffer: 8_000_000, windowsHide: true }, (error, stdout) => {
      if (error) return resolve([]);
      let rows = [];
      try {
        const parsed = JSON.parse(String(stdout || "").trim() || "[]");
        rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
      } catch {
        return resolve([]);
      }
      const needle = PROFILE_DIR.toLowerCase().replaceAll("/", "\\");
      const pids = [];
      for (const row of rows) {
        const command = String(row.CommandLine || "").toLowerCase().replaceAll("/", "\\");
        if (!command.includes(needle)) continue;
        const pid = Number(row.ProcessId);
        if (pid > 0 && pid !== process.pid) pids.push(pid);
      }
      resolve(pids);
    });
  });
}

async function quitProfileChrome() {
  const pids = await profileChromePids();
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      if (process.platform !== "win32") execFile("/bin/kill", ["-TERM", String(pid)], () => {});
    }
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if ((await profileChromePids()).length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  for (const pid of await profileChromePids()) {
    if (process.platform === "win32") {
      try {
        process.kill(pid);
      } catch {
        // The updater Chrome already closed.
      }
      continue;
    }
    await new Promise((resolve) => execFile("/bin/kill", ["-9", String(pid)], () => resolve()));
  }
  await new Promise((resolve) => setTimeout(resolve, 400));
}

export async function openLoginPage() {
  const page = await getPage();
  if (!page.url().startsWith(LOGIN_URL)) {
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  }
  await focusProfileChrome();
  logLine("Opened the login page in the updater Chrome window.");
  return page.url();
}

async function focusProfileChrome() {
  const [pid] = await profileChromePids();
  if (!pid) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      execFile("powershell.exe", ["-NoProfile", "-Command", `(New-Object -ComObject WScript.Shell).AppActivate(${pid})`], () => resolve());
    });
    return;
  }
  await new Promise((resolve) => {
    execFile("osascript", ["-e", `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`], () => resolve());
  });
}

export function openPageUrl() {
  if (!session?.page || session.page.isClosed()) return "";
  return session.page.url() || "";
}

export async function closeBrowser() {
  if (!session) return;
  await session.context.close().catch(() => {});
  session = null;
}

function onTemplateList(url) {
  return /\/event\/video\/template/i.test(url || "");
}

async function openAccountPage(page, knownId) {
  const url = page.url() || "";
  if (/\/login/i.test(url)) return "stay";
  const openId = eventIdFromUrl(url);
  if (onTemplateList(url) && (!knownId || openId === knownId)) return "stay";
  if (!knownId && /\/view\/events/i.test(url)) return "stay";
  const destination = knownId ? templateUrl(knownId) : EVENTS_URL;
  setMessage(knownId
    ? "Opening your template page."
    : "Opening the events list. Select your event, scroll to Templates, and click Video Templates.");
  await page.goto(destination, { waitUntil: "domcontentloaded" }).catch((error) => {
    logLine(`Could not open the account page yet: ${error.message}`);
  });
  return "moved";
}

export async function waitForTemplateList(page, { timeoutMs = LOGIN_WAIT_MS, eventId = currentEventId() } = {}) {
  let knownId = eventId || "";
  await openAccountPage(page, knownId);

  const deadline = Date.now() + timeoutMs;
  let triedTemplates = onTemplateList(page.url());
  let triedEvents = /\/view\/events/i.test(page.url() || "");
  let scrolled = false;
  let lastSignature = "";
  let stableReads = 0;
  let lastUrl = "";
  let loggedSample = false;

  while (Date.now() < deadline) {
    if (state.cancelRequested) throw new Error("Stopped before reading the template list. Nothing was changed.");
    await dismissCookieBanner(page);
    if (page.url() !== lastUrl) {
      lastUrl = page.url();
      logLine(`Chrome is at ${lastUrl}`);
      const seen = eventIdFromUrl(page.url());
      if (seen && seen !== knownId) {
        knownId = rememberEventId(seen);
        logLine(`Saved event ${knownId} from the open page.`);
      }
    }
    const login = await isLoginPage(page);
    if (login) {
      setMessage("The Snappic sign-in page is open. Sign in there, then click Check templates.", { awaitingLogin: true });
      await page.waitForTimeout(1500);
      continue;
    }

    if (!onTemplateList(page.url())) {
      if (knownId && !triedTemplates) {
        triedTemplates = true;
        setMessage("Opening your template page.");
        await page.goto(templateUrl(knownId), { waitUntil: "domcontentloaded" }).catch((error) => {
          logLine(`Template page did not open: ${error.message}`);
        });
        continue;
      }
      if (!knownId && !triedEvents) {
        triedEvents = true;
        setMessage("Opening the events list. Select your event, scroll to Templates, and click Video Templates.");
        await page.goto(EVENTS_URL, { waitUntil: "domcontentloaded" }).catch((error) => {
          logLine(`Events list did not open: ${error.message}`);
        });
        continue;
      }
    }

    setMessage(onTemplateList(page.url()) ? "Looking for the 18 templates." : "Select your event. Scroll to Templates and click Video Templates. Leave that list on screen.", { awaitingLogin: false });
    let found = await scanTemplateNames(page);
    if (found.length > 0 && found.length < 18 && !scrolled) {
      scrolled = true;
      await scrollPage(page);
      found = await scanTemplateNames(page);
    }
    if (found.length === 0 && !loggedSample) {
      loggedSample = true;
      const sample = (await visibleText(page)).replace(/\s+/g, " ").slice(0, 700);
      logLine(`No template names were readable yet. Page sample: ${sample}`);
    }
    if (found.length === 18) return found;

    const signature = found.map((item) => item.name).join("|");
    if (found.length > 0 && signature === lastSignature) {
      stableReads += 1;
      if (stableReads >= 2) return found;
    } else {
      stableReads = 0;
      lastSignature = signature;
    }

    if (!knownId) {
      setMessage("Select your event on the events list. Scroll to Templates and click Video Templates. Or enter the event ID in the app.");
    } else if (!onTemplateList(page.url())) {
      setMessage("Leave your template list on screen.");
    }
    await page.waitForTimeout(1500);
  }

  throw new Error("Timed out before the template list was on screen. Select your event, open Video Templates, and click Check templates again.");
}

export async function scanTemplateNames(page) {
  const text = await visibleText(page);
  const found = new Map();
  for (const match of matchTemplateNames(text)) found.set(match.name, match);
  return [...found.values()];
}

export async function updateTemplateOverlay(page, template, overlayPath, changes = {}) {
  stopIfCancelled();
  const master = changes.master || [];
  const timeline = changes.timeline?.on ? changes.timeline : null;
  const slug = template.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  try {
    await openTemplate(page, template);
    stopIfCancelled();
    if (master.length) {
    await ensureMasterSettings(page);
    const before = await snapshotProtectedSettings(page);
    await screenshot(page, `${slug}-before.png`);
    if (master.includes("resolution")) {
      stopIfCancelled();
      await setResolution(page, changes.resolution);
    }
    if (master.includes("overlay")) {
      stopIfCancelled();
      await removeExistingOverlay(page);
      stopIfCancelled();
      await uploadOverlay(page, overlayPath);
    }
    if (master.includes("preview")) {
      stopIfCancelled();
      await replaceMedia(page, {
        root: "#preview_upload_container",
        accept: ".mp4",
        filePath: changes.files?.preview,
        label: "Preview",
      });
    }
    if (master.includes("soundtrack")) {
      stopIfCancelled();
      await replaceMedia(page, {
        root: "#audio_upload_container",
        accept: ".mp3,.m4a",
        filePath: changes.files?.soundtrack,
        label: "Soundtrack",
      });
    }
    if (master.includes("overlayMask")) {
      stopIfCancelled();
      await replaceMedia(page, {
        root: "#overlay_mask_dropzone_container",
        accept: ".png,.apng,.jpeg,.jpg,.mp4",
        filePath: changes.files?.overlayMask,
        label: "Overlay Mask",
      });
    }
    const after = await snapshotProtectedSettings(page);
    const allowed = [];
    if (master.includes("resolution")) allowed.push("resolution");
    if (master.includes("preview")) allowed.push("preview");
    if (master.includes("soundtrack")) allowed.push("soundtrack");
    assertSettingsUnchanged(before, after, template.name, allowed);
    }
    if (timeline) {
      stopIfCancelled();
      await replaceTimelineVideo(page, timeline.position === "start" ? "start" : "end", changes.files?.timelineVideo);
    }
    await screenshot(page, `${slug}-uploaded.png`);
    stopIfCancelled();
    await saveBuilder(page, template.name);
    await screenshot(page, `${slug}-saved.png`);
  } catch (error) {
    await screenshot(page, `${slug}-error.png`).catch(() => {});
    if (await isBuilderOpen(page)) {
      await closeBuilderWithoutSaving(page).catch((closeError) => {
        error.message += ` The builder is still open. Click Cancel, not Save. ${closeError.message}`;
      });
    }
    throw error;
  }
}

export async function openTemplate(page, template) {
  if (await isBuilderOpen(page)) {
    logLine("The template editor was still open. Closing it with Cancel before the next template.");
    await closeBuilderWithoutSaving(page);
  }
  const phrases = searchPhrases(template);
  const frame = await frameContaining(page, phrases);
  if (!frame) throw new Error(`Could not find ${template.name} on the template list.`);
  await clearStaleModalCover(page);
  await pauseBeforeClick(page, `clicking ${template.name}`);
  const point = await (async () => {
    const poster = await frame.evaluate(({ phrases: wanted }) => {
      const norm = (value) => String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
      const item = [...document.querySelectorAll(".video-template-item")].find((element) => {
        const label = norm(element.querySelector(".video-label")?.innerText || "");
        return wanted.some((phrase) => label === phrase);
      });
      const image = item?.querySelector("img.library-template-poster-image");
      if (!image) return null;
      image.scrollIntoView({ block: "center", inline: "nearest" });
      const rect = image.getBoundingClientRect();
      const point = { x: rect.x + rect.width * 0.42, y: rect.y + rect.height * 0.42 };
      const hit = document.elementFromPoint(point.x, point.y);
      if (!hit || hit.closest("svg") || !item.contains(hit)) return null;
      return point;
    }, { phrases });
    const fallback = poster ? null : await frame.evaluate(({ phrases: wanted }) => {
    const norm = (value) => String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const haystack = norm(node.textContent);
      const matched = wanted.find((name) => haystack.includes(name));
      if (matched) {
        const source = node.textContent.toLowerCase();
        const start = source.indexOf(matched);
        const previous = start > 0 ? source[start - 1] : "";
        if (start >= 0 && !/[0-9]/.test(previous)) {
          const range = document.createRange();
          range.setStart(node, start);
          range.setEnd(node, start + matched.length);
          node.parentElement?.scrollIntoView({ block: "center", inline: "nearest" });
          const rect = range.getBoundingClientRect();
          if (rect.width > 4 && rect.height > 4) {
            const x = rect.x + Math.min(rect.width / 2, 36);
            const y = rect.y + rect.height / 2;
            if (x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight) {
              const hit = document.elementFromPoint(x, y);
              if (hit?.closest(".modal-backdrop, .blockUI, .blockOverlay")) return null;
              const control = hit?.closest("button, a");
              const controlText = `${control?.innerText || ""} ${control?.getAttribute("aria-label") || ""} ${control?.className || ""}`.toLowerCase();
              const dangerous = control && /×|✕|remove template|delete|template-remove|fa-times|fa-trash|fa-close/.test(controlText);
              if (!dangerous) return { x, y };
            }
          }
        }
      }
      node = walker.nextNode();
    }
    let best = null;
    for (const element of document.querySelectorAll("body *")) {
      const text = norm(element.innerText || element.getAttribute?.("alt") || element.getAttribute?.("aria-label") || "");
      if (!wanted.some((phrase) => text === phrase || text.includes(phrase))) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < 48 || rect.height < 48) continue;
      const exact = wanted.some((phrase) => text === phrase);
      const area = rect.width * rect.height;
      if (!best || (exact && !best.exact) || (exact === best.exact && area < best.area)) best = { element, area, exact };
    }
    if (!best) return null;
    best.element.scrollIntoView({ block: "center", inline: "nearest" });
    const rect = best.element.getBoundingClientRect();
    const candidates = [
      { x: rect.x + rect.width * 0.38, y: rect.y + rect.height * 0.58 },
      { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
    ];
    for (const point of candidates) {
      if (point.x < 0 || point.y < 0 || point.x > window.innerWidth || point.y > window.innerHeight) continue;
      if (point.x > rect.right - 34 && point.y < rect.top + 34) continue;
      const hit = document.elementFromPoint(point.x, point.y);
      if (hit?.closest(".modal-backdrop, .blockUI, .blockOverlay, svg")) continue;
      const control = hit?.closest("button, a");
      const controlText = `${control?.innerText || ""} ${control?.getAttribute?.("aria-label") || ""} ${control?.className || ""}`.toLowerCase();
      const dangerous = control && /×|✕|remove template|delete|template-remove|fa-times|fa-trash|fa-close/.test(controlText);
      if (!dangerous) return point;
    }
    return null;
    }, { phrases });
    return poster || fallback || null;
  })();
  if (!point) throw new Error(`Could not find a safe place to click ${template.name}. The red X on the template list was not clicked.`);
  const offset = await frameOffset(frame);
  const step = `Opening ${template.name}.`;
  logLine(step);
  setMessage(step);
  await page.mouse.click(offset.x + point.x, offset.y + point.y);
  const opened = await waitFor(async () => isBuilderOpen(page), 15000);
  if (!opened) throw new Error(`Clicking ${template.name} did not open the template editor.`);
  setMessage(`Waiting for the ${template.name} name.`);
  const shown = await waitFor(async () => readBuilderTemplateName(page), 15000);
  if (!shown || !namesMatch(shown, template.name)) {
    await closeBuilderWithoutSaving(page);
    throw new Error(`Stopped on ${template.name}. The template editor showed "${shown || "no template name"}". Closed it without saving.`);
  }
  return shown;
}

function stopIfCancelled() {
  if (state.cancelRequested) {
    throw new Error("Stopped before the next change. Nothing further was saved.");
  }
}

async function pauseBeforeClick(page, what) {
  if (!/snappic\.com/i.test(page.url())) return;
  const text = `Waiting 3 seconds before ${what}.`;
  logLine(text);
  setMessage(text);
  await page.waitForTimeout(3000);
}

async function frameOffset(frame) {
  try {
    const element = await frame.frameElement();
    if (!element) return { x: 0, y: 0 };
    const box = await element.boundingBox();
    return box || { x: 0, y: 0 };
  } catch {
    return { x: 0, y: 0 };
  }
}

async function replaceTimelineVideo(page, position, filePath) {
  if (!filePath) throw new Error("Choose the Timeline video before updating. Nothing was saved.");
  const where = position === "start" ? "start" : "end";
  logLine(`Replacing the Uploaded Video at the ${where} of the timeline.`);
  setMessage(`Replacing the Uploaded Video at the ${where} of the timeline.`);
  await openTimelineTab(page);
  await revealTimelineClips(page, where);
  await pauseBeforeClick(page, `clicking the Uploaded Video at the ${where}`);
  const clicked = await clickUploadedVideoClip(page, where);
  if (!clicked) {
    throw new Error(`The timeline has no Uploaded Video at the ${where}. Stopped before changing the timeline.`);
  }
  const card = await waitUntilLoaded(page, async () => timelineVideoCard(page), "the Uploaded Video panel");
  if (!card) throw new Error("The Uploaded Video panel did not open. Stopped before uploading.");
  const state = await readCardState(card);
  if (state.hasPreview) {
    logLine("Uploaded Video has a file. Removing it with the X inside that panel.");
    await removeCardFile(page, card, "the uploaded video");
    if (/snappic\.com/i.test(page.url())) {
      const text = "Waiting 2 seconds before choosing the timeline video.";
      logLine(text);
      setMessage(text);
      await page.waitForTimeout(2000);
    }
  } else if (!state.hasDropHint && !state.hasFileInput) {
    throw new Error("The Uploaded Video panel is neither empty nor showing a video. Stopped before uploading.");
  } else {
    logLine("Uploaded Video panel is empty. Continuing to the upload.");
  }
  await uploadTimelineVideo(page, filePath);
}

async function openTimelineTab(page) {
  const frame = await builderFrame(page);
  await pauseBeforeClick(page, "clicking Timeline");
  const clicked = await frame.evaluate(() => {
    const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const candidates = [...document.querySelectorAll("button, a, [role='tab'], div, span, li")].filter((element) => {
      const rect = element.getBoundingClientRect();
      return norm(element.innerText) === "Timeline" && rect.width > 20 && rect.height > 10 && rect.height < 80;
    });
    candidates.sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width);
    const target = candidates[0];
    if (!target) return false;
    target.click();
    return true;
  });
  if (!clicked) throw new Error("Could not open the Timeline tab. Stopped before changing the timeline.");
  const ready = await waitFor(async () => frame.evaluate(() => /video timeline|preview timeline|uploaded video/i.test(document.body.innerText)), 8000);
  if (!ready) throw new Error("The Timeline tab opened, but the timeline is not on screen. Stopped before changing it.");
}

async function revealTimelineClips(page, position) {
  const frame = await builderFrame(page);
  for (let pass = 0; pass < 6; pass += 1) {
    await frame.evaluate((toEnd) => {
      for (const element of document.querySelectorAll("*")) {
        if (element.scrollWidth > element.clientWidth + 24) {
          element.scrollLeft = toEnd ? element.scrollWidth : 0;
        }
      }
    }, position === "end");
    const point = await frame.evaluate(() => {
      const label = [...document.querySelectorAll("div, span, h2, h3, p")].find((element) => {
        const rect = element.getBoundingClientRect();
        return /video timeline/i.test(element.innerText || "") && rect.width > 40 && rect.height > 8 && rect.height < 80;
      });
      if (!label) return null;
      const rect = label.getBoundingClientRect();
      return { x: rect.x + Math.min(rect.width / 2, 180), y: rect.bottom + 36 };
    });
    if (point && position === "end") {
      const offset = await frameOffset(frame);
      await page.mouse.move(offset.x + point.x, offset.y + Math.max(point.y, 80));
      await page.mouse.wheel(900, 0);
    }
    await page.waitForTimeout(250);
  }
  logLine(position === "end"
    ? "Scrolled the timeline to the end."
    : "Scrolled the timeline to the start.");
}

async function clickUploadedVideoClip(page, position) {
  const frame = await builderFrame(page);
  const point = await frame.evaluate((where) => {
    const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const clips = [];
    for (const element of document.querySelectorAll("div, li, button, a")) {
      const text = norm(element.innerText);
      if (!/\buploaded video\b/i.test(text)) continue;
      if (/play back a single video/i.test(text)) continue;
      if (text.length > 80) continue;
      const rect = element.getBoundingClientRect();
      if (rect.width < 36 || rect.height < 20 || rect.width > 320 || rect.height > 160) continue;
      clips.push({ element, x: rect.x, area: rect.width * rect.height });
    }
    clips.sort((a, b) => a.area - b.area);
    const unique = [];
    for (const clip of clips) {
      if (unique.some((item) => Math.abs(item.x - clip.x) < 24)) continue;
      unique.push(clip);
    }
    unique.sort((a, b) => a.x - b.x);
    const chosen = where === "start" ? unique[0] : unique[unique.length - 1];
    if (!chosen) return null;
    chosen.element.scrollIntoView({ block: "center", inline: "center" });
    const rect = chosen.element.getBoundingClientRect();
    return { x: rect.x + rect.width * 0.4, y: rect.y + rect.height * 0.65 };
  }, position);
  if (!point) return false;
  const offset = await frameOffset(frame);
  await page.mouse.click(offset.x + point.x, offset.y + point.y);
  return true;
}

async function timelineVideoCard(page) {
  const frame = await builderFrame(page).catch(() => null);
  if (!frame) return null;
  const found = await frame.evaluate(() => {
    const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const previous = document.querySelector("[data-glambot-target='timeline-card']");
    if (previous) previous.removeAttribute("data-glambot-target");
    const candidates = [];
    for (const element of document.querySelectorAll("div, section, article, form")) {
      const rect = element.getBoundingClientRect();
      if (rect.width < 180 || rect.height < 80 || rect.width > window.innerWidth * 0.95) continue;
      const text = norm(element.innerText);
      if (!/^uploaded video\b/i.test(text)) continue;
      if (!/play back a single video/i.test(text)) continue;
      candidates.push({ element, area: rect.width * rect.height });
    }
    candidates.sort((a, b) => a.area - b.area);
    if (!candidates[0]) return false;
    candidates[0].element.setAttribute("data-glambot-target", "timeline-card");
    return true;
  });
  if (!found) return null;
  return frame.locator("[data-glambot-target='timeline-card']").first();
}

async function removeCardFile(page, card, label) {
  setDialogMode("accept-overlay");
  const marked = await card.evaluate((element) => {
    const direct = element.querySelector(".dz-remove, [data-dz-remove]");
    if (direct && direct.getBoundingClientRect().width > 0) {
      direct.setAttribute("data-glambot-target", "timeline-remove");
      return true;
    }
    const media = [...element.querySelectorAll("video, img, canvas, .dz-preview")].find((item) => {
      const style = getComputedStyle(item);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = item.getBoundingClientRect();
      return rect.width > 40 && rect.height > 30;
    });
    const mediaRect = media?.getBoundingClientRect();
    const anchor = mediaRect ? { x: mediaRect.right, y: mediaRect.top } : null;
    const ranked = [];
    for (const control of element.querySelectorAll("button, a, [role='button'], i, span, svg")) {
      const rect = control.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8 || rect.width > 72 || rect.height > 72) continue;
      const text = `${control.innerText || ""} ${control.getAttribute("aria-label") || ""} ${control.getAttribute("title") || ""}`.toLowerCase();
      if (/remove template|delete template/.test(text)) continue;
      const looksClose = text.trim() === "×" || text.trim() === "✕" || text.trim() === "x" || /close|remove|times/.test(text);
      const distance = anchor ? Math.hypot(rect.x + rect.width / 2 - anchor.x, rect.y + rect.height / 2 - anchor.y) : 9999;
      if (anchor && distance > 64 && !looksClose) continue;
      if (!anchor && !looksClose) continue;
      ranked.push({ control, distance, looksClose });
    }
    ranked.sort((a, b) => Number(b.looksClose) - Number(a.looksClose) || a.distance - b.distance);
    if (!ranked[0]) return false;
    ranked[0].control.setAttribute("data-glambot-target", "timeline-remove");
    return true;
  });
  if (!marked) {
    setDialogMode("dismiss");
    throw new Error(`The ${label} file is showing, but its X was not found. Stopped before uploading.`);
  }
  await pauseBeforeClick(page, `clicking the X on ${label}`);
  await card.locator("[data-glambot-target='timeline-remove']").first().evaluate((element) => {
    const target = element.closest("a, button, .dz-remove, [data-dz-remove]") || element;
    if (typeof target.click === "function") target.click();
    else target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  });
  await dismissOverlayModal(page);
  setDialogMode("dismiss");
}

async function uploadTimelineVideo(page, filePath) {
  const card = await timelineVideoCard(page);
  if (!card) throw new Error("The Uploaded Video panel disappeared before the upload.");
  const uploads = trackWrites(page, (request) => isUploadRequest(request));
  const input = card.locator("input[type='file']");
  if (await input.count() === 1) {
    await input.setInputFiles(filePath);
  } else {
    const marked = await card.evaluate((element) => {
      const zone = element.matches(".dropzone") ? element : element.querySelector(".dropzone");
      const hidden = zone?.dropzone?.hiddenFileInput;
      if (!hidden) return "missing";
      const accept = (hidden.getAttribute("accept") || "").replace(/\s/g, "");
      if (accept && !accept.includes(".mp4")) return `wrong-accept:${accept}`;
      hidden.setAttribute("data-glambot-target", "timeline-file");
      return "ok";
    });
    if (marked !== "ok") {
      uploads.stop();
      throw new Error(marked.startsWith("wrong-accept:")
        ? "The timeline file input was not an mp4 dropzone. Stopped before uploading."
        : "The Uploaded Video panel has no file input. Stopped before uploading.");
    }
    await page.locator("[data-glambot-target='timeline-file']").setInputFiles(filePath);
  }
  const baseName = path.basename(filePath).toLowerCase();
  const uploaded = await waitFor(async () => {
    const current = await timelineVideoCard(page);
    if (!current) return false;
    const ui = await readCardState(current);
    if (ui.error) return `error:${ui.error}`;
    if (ui.uploading || uploads.successes < 1) return false;
    return (ui.hasPreview || ui.text.toLowerCase().includes(baseName)) && !ui.hasDropHint;
  }, 180000);
  const network = uploads.stop();
  logLine(`Timeline upload network: ${JSON.stringify(network)}`);
  if (typeof uploaded === "string" && uploaded.startsWith("error:")) {
    throw new Error(`Timeline video upload failed. ${uploaded.slice(6)} Nothing was saved.`);
  }
  if (!uploaded || !network.successes || network.failures.length) {
    throw new Error("The timeline video upload did not finish with a verified preview. Nothing was saved.");
  }
  logLine(`Timeline video verified for ${path.basename(filePath)}.`);
}

async function ensureMasterSettings(page) {
  if (await overlayCard(page)) return;
  const frame = await builderFrame(page);
  const clicked = await frame.evaluate(() => {
    const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const candidates = [...document.querySelectorAll("button, a, [role='tab'], div, span, li")].filter((element) => {
      return norm(element.innerText) === "Master Settings" && element.getBoundingClientRect().width > 0;
    });
    candidates.sort((a, b) => a.getBoundingClientRect().width - b.getBoundingClientRect().width);
    const target = candidates[0];
    if (!target) return false;
    target.click();
    return true;
  });
  if (!clicked) throw new Error("Could not open Master Settings. Stopped before changing the template.");
  const ready = await waitFor(async () => overlayCard(page), 8000);
  if (!ready) throw new Error("Master Settings is open, but the Overlay panel is not there. Stopped before changing the template.");
}

async function removeExistingOverlay(page) {
  const panel = await waitUntilLoaded(page, async () => {
    const card = await overlayCard(page);
    if (!card) return false;
    const state = await readCardState(card);
    if (state.uploading) return false;
    if (state.hasPreview || state.hasDropHint) return state;
    return false;
  }, "the Overlay panel");
  const card = await overlayCard(page);
  if (!card) throw new Error("The Overlay panel is not visible. Stopped before changing the template.");
  if (panel.hasPreview) {
    logLine("Overlay panel has a file. Removing it with the X inside that panel.");
  } else if (panel.hasDropHint) {
    logLine("Overlay panel is empty. Continuing to the upload.");
    return;
  } else {
    throw new Error("The Overlay panel is neither empty nor showing a preview. Stopped before uploading.");
  }

  setDialogMode("accept-overlay");
  const marked = await card.evaluate((element) => {
    const direct = element.querySelector(".dz-remove, [data-dz-remove]");
    if (direct && direct.getBoundingClientRect().width > 0) {
      direct.setAttribute("data-glambot-target", "overlay-remove");
      direct.setAttribute("data-glambot-distance", "0");
      return true;
    }
    const media = [...element.querySelectorAll("video, img, canvas, .dz-preview")].find((item) => {
      if (item.hidden || item.closest("[hidden]")) return false;
      const style = getComputedStyle(item);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = item.getBoundingClientRect();
      return rect.width > 40 && rect.height > 30;
    });
    const mediaRect = media?.getBoundingClientRect();
    const anchor = mediaRect ? { x: mediaRect.right, y: mediaRect.top } : null;
    const controls = [...element.querySelectorAll("button, a, [role='button'], i, span, svg")];
    const ranked = [];
    for (const control of controls) {
      const rect = control.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8 || rect.width > 72 || rect.height > 72) continue;
      const info = {
        text: (control.innerText || control.textContent || "").trim(),
        aria: control.getAttribute("aria-label") || "",
        title: control.getAttribute("title") || "",
        className: String(control.className?.baseVal || control.className || ""),
      };
      const text = `${info.text} ${info.aria} ${info.title}`.toLowerCase();
      if (/remove template|delete template/.test(text)) continue;
      const looksClose = info.text === "×" || info.text === "✕" || info.text === "x" || info.text === "X" || /close|remove|times/.test(text);
      let distance = 9999;
      if (anchor) {
        distance = Math.hypot(rect.x + rect.width / 2 - anchor.x, rect.y + rect.height / 2 - anchor.y);
      }
      if (anchor && distance > 64 && !looksClose) continue;
      if (!anchor && !looksClose) continue;
      ranked.push({ control, distance, looksClose });
    }
    ranked.sort((a, b) => Number(b.looksClose) - Number(a.looksClose) || a.distance - b.distance);
    const chosen = ranked[0];
    if (!chosen || (chosen.distance > 64 && !chosen.looksClose)) return false;
    chosen.control.setAttribute("data-glambot-target", "overlay-remove");
    chosen.control.setAttribute("data-glambot-distance", String(Math.round(chosen.distance)));
    return true;
  });

  if (!marked) {
    setDialogMode("dismiss");
    throw new Error("The Overlay panel has a file, but its red X was not found. Stopped before uploading.");
  }

  const button = card.locator("[data-glambot-target='overlay-remove']").first();
  const info = await button.evaluate((element) => ({
    text: element.innerText || element.textContent || "",
    aria: element.getAttribute("aria-label") || "",
    title: element.getAttribute("title") || "",
    className: String(element.className?.baseVal || element.className || ""),
  }));
  const description = `${info.text} ${info.aria} ${info.title} ${info.className}`;
  if (/remove template|delete template/i.test(description)) {
    throw new Error("Refusing to click a template delete control.");
  }
  const distance = Number(await button.getAttribute("data-glambot-distance"));
  if (!isOverlayRemoveControl(info) && !(Number.isFinite(distance) && distance <= 64)) {
    throw new Error("Refusing to click a control in the Overlay panel that is not the overlay X.");
  }

  await pauseBeforeClick(page, "clicking the overlay X");
  await button.evaluate((element) => {
    const target = element.closest("a, button, .dz-remove, [data-dz-remove]") || element;
    const rect = target.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, view: window, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 };
    if (typeof target.click === "function") {
      target.click();
      return;
    }
    target.dispatchEvent(new MouseEvent("mousedown", init));
    target.dispatchEvent(new MouseEvent("mouseup", init));
    target.dispatchEvent(new MouseEvent("click", init));
  });
  await dismissOverlayModal(page);
  setDialogMode("dismiss");
  if (/snappic\.com/i.test(page.url())) {
    const text = "Waiting 2 seconds before choosing the overlay file.";
    logLine(text);
    setMessage(text);
    await page.waitForTimeout(2000);
  }
  logLine("Existing overlay removed from the Overlay panel.");
}

async function uploadOverlay(page, overlayPath) {
  await waitFor(async () => {
    const state = await readOverlayState(page);
    if (!state || state.uploading) return false;
    return Boolean((state.hasDropHint && !state.hasPreview) || state.hasFileInput);
  }, 1500);
  const card = await overlayCard(page);
  if (!card) throw new Error("The Overlay panel disappeared before the upload.");
  const scope = await card.evaluate((element) => element.innerText || "");
  if (/\b(soundtrack|preview video|resolution)\b/i.test(scope)) {
    throw new Error("The Overlay panel scope also contains other Master Settings. Stopped before uploading.");
  }

  const uploads = trackWrites(page, (request) => isUploadRequest(request));
  const inputCount = await card.locator('input[type="file"]').count();
  if (inputCount > 1) {
    uploads.stop();
    throw new Error("The Overlay panel has more than one file input. Stopped before uploading.");
  }
  if (inputCount === 1) {
    await card.locator('input[type="file"]').setInputFiles(overlayPath);
  } else {
    const marked = await card.evaluate((element) => {
      const zone = element.matches(".dropzone") ? element : element.querySelector(".dropzone");
      const input = zone?.dropzone?.hiddenFileInput;
      if (!input) return "missing";
      const accept = (input.getAttribute("accept") || "").replace(/\s/g, "");
      if (accept !== ".png,.apng,.mp4") return `wrong-accept:${accept}`;
      input.setAttribute("data-glambot-target", "overlay-file");
      return "ok";
    });
    if (marked === "ok") {
      await page.locator("[data-glambot-target='overlay-file']").setInputFiles(overlayPath);
    } else if (String(marked).startsWith("wrong-accept:")) {
      uploads.stop();
      throw new Error("The overlay file input was not the png/apng/mp4 dropzone. Stopped before uploading.");
    } else {
      const chooserPromise = page.waitForEvent("filechooser", { timeout: 5000 });
      const drop = card.locator(".dz-message, :text('Drop file or click here to upload')").first();
      if (!(await drop.isVisible().catch(() => false))) {
        uploads.stop();
        throw new Error("The Overlay panel has no file input. Stopped before uploading.");
      }
      await drop.click();
      const chooser = await chooserPromise.catch(() => null);
      if (!chooser) {
        uploads.stop();
        throw new Error("The overlay file dialog did not open. Stopped before uploading.");
      }
      await chooser.setFiles(overlayPath);
    }
  }

  const baseName = path.basename(overlayPath).toLowerCase();
  const uploaded = await waitFor(async () => {
    const current = await overlayCard(page);
    if (!current) return false;
    const ui = await readCardState(current);
    if (ui.error) return `error:${ui.error}`;
    if (ui.uploading || uploads.successes < 1) return false;
    const named = ui.text.toLowerCase().includes(baseName);
    return (ui.hasPreview || named) && !ui.hasDropHint;
  }, 180000);
  const network = uploads.stop();
  logLine(`Upload network: ${JSON.stringify(network)}`);

  if (typeof uploaded === "string" && uploaded.startsWith("error:")) {
    throw new Error(`Overlay upload failed. ${uploaded.slice(6)} Nothing was saved.`);
  }
  if (!uploaded) {
    throw new Error("The overlay upload did not finish with a verified preview. Nothing was saved.");
  }
  if (network.failures.length) {
    throw new Error(`Overlay upload request failed (${network.failures.join(", ")}). Nothing was saved.`);
  }
  if (!network.successes) {
    throw new Error("The Overlay panel changed, but no completed upload request was observed. Nothing was saved.");
  }
  logLine(`Upload verified for ${path.basename(overlayPath)}.`);
}

async function saveBuilder(page, templateName) {
  if (await isBuilderOpen(page) === false) {
    throw new Error(`The template editor closed before Save was clicked for ${templateName}.`);
  }
  const frame = await builderFrame(page);
  await frame.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  lastDialogMessage = "";
  await pauseBeforeClick(page, "clicking Save");
  const writes = trackWrites(page, (request) => isAppWrite(request, page.url()));
  const clicked = await frame.evaluate(() => {
    const button = document.querySelector("#save_video_template")
      || [...document.querySelectorAll("button")].find((element) => {
        const text = (element.innerText || "").replace(/\s+/g, " ").trim();
        const rect = element.getBoundingClientRect();
        return text === "Save" && rect.width > 0 && rect.top < 360;
      });
    if (!button) return "";
    button.click();
    return button.id || "save";
  });
  if (!clicked) {
    writes.stop();
    throw new Error("Could not find the upper-right Save button. Nothing else was changed.");
  }
  const closed = await waitFor(async () => !(await isBuilderOpen(page)), 25000);
  const network = writes.stop();
  logLine(`Save network for ${templateName}: ${JSON.stringify(network)}`);
  if (lastDialogMessage) {
    throw new Error(`Save did not complete for ${templateName}: ${lastDialogMessage}`);
  }
  const errorText = await visibleError(page);
  if (errorText) throw new Error(`Save failed for ${templateName}: ${errorText}`);
  if (network.failures.length) throw new Error(`Save request failed for ${templateName} (${network.failures.join(", ")}).`);
  if (!closed) throw new Error(`Save was clicked for ${templateName}, but the template editor is still open.`);
  if (await page.locator(".video-template-item").count()) {
    await waitUntilLoaded(page, async () => {
      if (await isBuilderOpen(page)) return false;
      return page.locator(".video-template-item").first().isVisible().catch(() => false);
    }, "the template list");
  }
  await clearStaleModalCover(page);
  logLine(`Clicked Save for ${templateName}. Back on the template list.`);
}

async function setResolution(page, resolution) {
  const aspect = resolution?.aspect;
  const size = String(resolution?.size || "").replace(/\s+/g, "");
  if (!/^(square|landscape|portrait)$/.test(aspect || "") || !/^\d+x\d+$/.test(size)) {
    throw new Error("Choose a Square, Landscape, or Portrait size. Stopped before saving.");
  }
  logLine(`Setting resolution to ${aspect} ${size}.`);
  const frame = await builderFrame(page);
  await waitFor(async () => frame.evaluate(() => {
    const blocked = [...document.querySelectorAll(".blockUI, .blockOverlay, .blockMsg")].some((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 40 && rect.height > 40;
    });
    return !blocked && Boolean(document.querySelector(".item-title.portrait, .item-title.square, .item-title.landscape"));
  }), 15000);

  const read = () => frame.evaluate((wanted) => {
    const chosen = document.querySelector(`#s2id_${wanted}_resolution_select .select2-chosen`);
    return {
      size: (chosen?.textContent || "").replace(/\s+/g, ""),
      active: Boolean(document.querySelector(`.item-row-background.${wanted}.active`)),
      title: Boolean(document.querySelector(`.item-title.${wanted}`)),
    };
  }, aspect);

  let shown = await read();
  if (!shown.title) throw new Error(`Could not find the ${aspect} resolution row. Stopped before saving.`);
  if (!(shown.active && shown.size === size)) {
    const point = await frame.evaluate((wanted) => {
      const title = document.querySelector(`.item-title.${wanted}`);
      if (!title) return null;
      title.scrollIntoView({ block: "center", inline: "nearest" });
      const rect = title.getBoundingClientRect();
      return { x: rect.x + Math.min(rect.width / 2, 36), y: rect.y + rect.height / 2 };
    }, aspect);
    if (!point) throw new Error(`Could not find the ${aspect} resolution row. Stopped before saving.`);
    const offset = await frameOffset(frame);
    await page.mouse.click(offset.x + point.x, offset.y + point.y);
    await waitFor(async () => (await read()).active, 4000);
    shown = await read();
    if (shown.size !== size) {
      const opened = await frame.evaluate((wanted) => {
        const choice = document.querySelector(`#s2id_${wanted}_resolution_select .select2-choice`);
        if (!choice) return null;
        choice.scrollIntoView({ block: "center", inline: "nearest" });
        const rect = choice.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      }, aspect);
      if (!opened) throw new Error(`Could not open the ${size} choice. Stopped before saving.`);
      const menuOffset = await frameOffset(frame);
      await page.mouse.click(menuOffset.x + opened.x, menuOffset.y + opened.y);
      const option = page.locator(".select2-results li").filter({ hasText: new RegExp(`^\\s*${size}\\s*$`) }).last();
      const visible = await waitFor(async () => option.isVisible().catch(() => false), 5000);
      if (!visible) throw new Error(`Could not open the ${size} choice. Stopped before saving.`);
      const box = await option.boundingBox();
      if (!box) throw new Error(`Could not open the ${size} choice. Stopped before saving.`);
      await page.mouse.click(box.x + Math.min(box.width / 2, 48), box.y + box.height / 2);
      const changed = await waitFor(async () => (await read()).size === size, 5000);
      if (!changed) {
        shown = await read();
        throw new Error(`Resolution is ${shown.size || "unchanged"} instead of ${aspect} ${size}. Stopped before saving.`);
      }
      shown = await read();
    }
  }
  if (!shown.active || shown.size !== size) {
    throw new Error(`Resolution is ${shown.size || "unchanged"} instead of ${aspect} ${size}. Stopped before saving.`);
  }
  logLine(`Selected ${aspect} ${size}.`);
}

async function replaceMedia(page, { root, accept, filePath, label }) {
  if (!filePath) throw new Error(`Choose the ${label} file before updating. Nothing was saved.`);
  const frame = await builderFrame(page);
  const prepared = await frame.evaluate(({ root, accept }) => {
    const zone = document.querySelector(root);
    if (!zone) return "missing";
    const drop = zone.matches(".dropzone") ? zone : zone.querySelector(".dropzone");
    if (!drop) return "missing";
    zone.setAttribute("data-glambot-target", "media-card");
    const input = drop.dropzone?.hiddenFileInput;
    if (!input) return "no-input";
    const actual = (input.getAttribute("accept") || "").replace(/\s/g, "");
    if (actual !== accept) return `wrong-accept:${actual}`;
    input.setAttribute("data-glambot-target", "media-file");
    return "ok";
  }, { root, accept });
  if (prepared === "missing") throw new Error(`The ${label} panel is not on Master Settings. Stopped before saving.`);
  if (String(prepared).startsWith("wrong-accept:")) {
    throw new Error(`The ${label} upload slot did not match the expected file type. Stopped before saving.`);
  }
  const card = frame.locator("[data-glambot-target='media-card']").first();
  const existing = card.locator(".dz-preview").first();
  if (await existing.isVisible().catch(() => false)) {
    const remove = card.locator(".dz-remove, [data-dz-remove]").first();
    if (!(await remove.isVisible().catch(() => false))) {
      throw new Error(`The ${label} panel has a file, but its X was not found. Stopped before uploading.`);
    }
    await remove.click();
    logLine(`Removed the existing ${label} file.`);
  }
  const uploads = trackWrites(page, (request) => isUploadRequest(request));
  if (prepared === "ok") {
    await page.locator("[data-glambot-target='media-file']").setInputFiles(filePath);
  } else {
    const chooserPromise = page.waitForEvent("filechooser", { timeout: 5000 });
    await card.locator(".dz-message").first().click();
    const chooser = await chooserPromise.catch(() => null);
    if (!chooser) {
      uploads.stop();
      throw new Error(`The ${label} file dialog did not open. Stopped before uploading.`);
    }
    await chooser.setFiles(filePath);
  }
  const uploaded = await waitFor(async () => uploads.successes > 0, 180000);
  const network = uploads.stop();
  logLine(`${label} network: ${JSON.stringify(network)}`);
  if (!uploaded || network.failures.length || !network.successes) {
    throw new Error(`The ${label} upload did not finish. Nothing was saved.`);
  }
  logLine(`Upload verified for ${label}.`);
}

export async function saveEventChanges(page) {
  if (await isBuilderOpen(page)) {
    throw new Error("The template editor is still open. The template-list Save changes button was not clicked.");
  }
  const byId = page.locator("#snappic_video_save, #save-changes").last();
  const button = await byId.isVisible().catch(() => false)
    ? byId
    : page.locator("button, a, [role='button']").filter({ hasText: /^Save changes$/i });
  const visible = [];
  const count = await button.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = button.nth(index);
    if (await candidate.isVisible().catch(() => false)) visible.push(candidate);
  }
  if (!visible.length) {
    logLine("No Save changes button is on the template list.");
    return { clicked: false };
  }
  const target = visible[visible.length - 1];
  if (await target.isDisabled().catch(() => false)) {
    logLine("Save changes is on the template list, but it is disabled.");
    return { clicked: false };
  }
  const writes = trackWrites(page, (request) => isAppWrite(request, page.url()));
  await target.click();
  await page.waitForTimeout(1000);
  const settled = await waitFor(async () => {
    const network = writes.snapshot();
    return network.successes > 0 || network.failures.length > 0;
  }, 20000);
  const network = writes.stop();
  logLine(`Save changes network: ${JSON.stringify(network)}`);
  const errorText = await visibleError(page);
  if (errorText) throw new Error(`Save changes failed: ${errorText}`);
  if (network.failures.length) throw new Error(`Save changes request failed (${network.failures.join(", ")}).`);
  if (!settled || !network.successes) {
    throw new Error("Save changes was clicked, but no successful save request was observed.");
  }
  logLine("Template-list Save changes verified.");
  return { clicked: true };
}

export async function closeBuilderWithoutSaving(page) {
  const frame = await builderFrame(page);
  const clicked = await frame.evaluate(() => {
    const modal = document.querySelector(".video-lg-modal.in, .modal.show");
    const root = modal || document;
    const button = [...root.querySelectorAll("button, a, [role='button']")].find((element) => {
      return (element.innerText || "").replace(/\s+/g, " ").trim() === "Cancel";
    });
    if (!button) return false;
    button.click();
    return true;
  });
  if (!clicked) throw new Error("Could not find Cancel in the template editor.");
  await dismissDiscardModal(page);
  const closed = await waitFor(async () => !(await isBuilderOpen(page)), 8000);
  if (!closed) throw new Error("Cancel did not close the template editor.");
}

export async function screenshot(page, name) {
  if (/^http:\/\/127\.0\.0\.1[:/]/.test(page.url())) return "";
  const directory = path.join(root, "logs", "screenshots");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  await page.screenshot({ path: file, fullPage: true }).catch((error) => {
    logLine(`Screenshot failed: ${error.message}`);
  });
  return file;
}

async function overlayCard(page) {
  const frame = await builderFrame(page).catch(() => null);
  if (!frame) return null;
  const found = await frame.evaluate(() => {
    const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const previous = document.querySelector("[data-glambot-target='overlay-card']");
    if (previous) previous.removeAttribute("data-glambot-target");
    const dropzone = document.querySelector("#overlay_dropzone_container");
    if (dropzone && dropzone.getBoundingClientRect().width > 80) {
      dropzone.setAttribute("data-glambot-target", "overlay-card");
      return true;
    }
    const candidates = [];
    for (const element of document.querySelectorAll("div, section, article, li, form")) {
      const rect = element.getBoundingClientRect();
      if (rect.width < 140 || rect.height < 80 || rect.width > window.innerWidth * 0.95) continue;
      const text = norm(element.innerText);
      if (!/^overlay\b/i.test(text)) continue;
      if (!/upload an overlay/i.test(text)) continue;
      if (/\b(soundtrack|preview video|resolution|recordings|timeline)\b/i.test(text)) continue;
      candidates.push({ element, area: rect.width * rect.height });
    }
    candidates.sort((a, b) => a.area - b.area);
    if (!candidates[0]) return false;
    candidates[0].element.setAttribute("data-glambot-target", "overlay-card");
    return true;
  });
  if (!found) return null;
  return frame.locator("[data-glambot-target='overlay-card']").first();
}

async function readCardState(card) {
  return card.evaluate((element, source) => {
    const readState = eval(`(${source})`);
    return readState(element);
  }, overlayState.toString());
}

async function readOverlayState(page) {
  const frame = await builderFrame(page).catch(() => null);
  if (!frame) return null;
  return frame.evaluate((source) => {
    const readState = eval(`(${source})`);
    const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const dropzone = document.querySelector("#overlay_dropzone_container");
    let element = dropzone && dropzone.getBoundingClientRect().width > 80 ? dropzone : null;
    if (!element) {
      const candidates = [];
      for (const node of document.querySelectorAll("div, section, article, li, form")) {
        const rect = node.getBoundingClientRect();
        if (rect.width < 140 || rect.height < 80 || rect.width > window.innerWidth * 0.95) continue;
        const text = norm(node.innerText);
        if (!/^overlay\b/i.test(text)) continue;
        if (!/upload an overlay/i.test(text)) continue;
        if (/\b(soundtrack|preview video|resolution|recordings|timeline)\b/i.test(text)) continue;
        candidates.push({ node, area: rect.width * rect.height });
      }
      candidates.sort((a, b) => a.area - b.area);
      element = candidates[0]?.node || null;
    }
    return element ? readState(element) : null;
  }, overlayState.toString()).catch(() => null);
}

async function snapshotProtectedSettings(page) {
  const frame = await builderFrame(page);
  return frame.evaluate(() => {
    const norm = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const cardText = (title) => {
      const cards = [...document.querySelectorAll("div, section, article")].filter((element) => {
        const text = norm(element.innerText);
        const rect = element.getBoundingClientRect();
        return text.startsWith(title) && rect.width > 80 && rect.width < window.innerWidth * 0.75;
      });
      cards.sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height);
      return cards[0] ? norm(cards[0].innerText) : "";
    };
    const library = [...document.querySelectorAll("label, div, span")].find((element) => /save to library/i.test(norm(element.innerText)) && element.querySelector("input[type='checkbox']"));
    const checkbox = library?.querySelector("input[type='checkbox']") || null;
    return {
      resolution: cardText("Resolution"),
      preview: cardText("Preview Video"),
      soundtrack: cardText("Soundtrack"),
      saveToLibrary: Boolean(checkbox?.checked),
    };
  });
}

function assertSettingsUnchanged(before, after, templateName, allowed = []) {
  const changed = [];
  for (const key of ["resolution", "preview", "soundtrack", "saveToLibrary"]) {
    if (allowed.includes(key)) continue;
    if (before[key] !== after[key]) changed.push(key);
  }
  if (changed.length) {
    throw new Error(`Stopped on ${templateName}. Protected settings changed (${changed.join(", ")}). The template was not saved.`);
  }
}

async function readBuilderTemplateName(page) {
  const frame = await builderFrame(page);
  const text = await frame.evaluate(() => {
    const modal = document.querySelector(".video-lg-modal.in, .modal.show");
    const root = modal || document.body;
    const lines = [];
    const named = root.querySelector("#template_name");
    if (named?.value) lines.push(named.value);
    lines.push(...(root.innerText || "").split("\n"));
    return lines.map((line) => line.trim()).filter((line) => line && line.length < 80).join("\n");
  });
  return matchTemplateNames(text)[0]?.raw || null;
}

async function clearStaleModalCover(page) {
  if (await isBuilderOpen(page) || await pageIsBusy(page)) return;
  const removed = await page.evaluate(() => {
    const covers = [...document.querySelectorAll(".modal-backdrop")].filter((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 40 && rect.height > 40;
    });
    for (const cover of covers) cover.remove();
    if (covers.length) {
      document.body.classList.remove("modal-open");
      document.body.style.removeProperty("overflow");
      document.body.style.removeProperty("padding-right");
    }
    return covers.length;
  }).catch(() => 0);
  if (removed) logLine("Removed a leftover cover over the template list.");
}

async function isBuilderOpen(page) {
  for (const frame of page.frames()) {
    const open = await frame.evaluate(() => {
      const text = document.body?.innerText || "";
      if (/video\s*fx\s*builder/i.test(text)) return true;
      const modal = document.querySelector(".video-lg-modal.in, .modal.show");
      if (!modal) return false;
      const modalText = modal.innerText || "";
      return /master settings/i.test(modalText) && /timeline/i.test(modalText);
    }).catch(() => false);
    if (open) return true;
  }
  return false;
}

async function builderFrame(page) {
  for (const frame of page.frames()) {
    const open = await frame.evaluate(() => {
      const text = document.body?.innerText || "";
      if (/video\s*fx\s*builder/i.test(text)) return true;
      const modal = document.querySelector(".video-lg-modal.in, .modal.show");
      if (!modal) return false;
      const modalText = modal.innerText || "";
      return /master settings/i.test(modalText) && /timeline/i.test(modalText);
    }).catch(() => false);
    if (open) return frame;
  }
  throw new Error("The template editor is not open.");
}

async function frameContaining(page, phrases) {
  const needles = (Array.isArray(phrases) ? phrases : [phrases]).map((phrase) => phrase.toLowerCase());
  for (const frame of page.frames()) {
    const body = await collectFrameText(frame);
    const flat = body.replace(/\s+/g, " ").toLowerCase();
    if (needles.some((needle) => flat.includes(needle))) return frame;
  }
  return null;
}

async function collectFrameText(frame) {
  return frame.evaluate(() => {
    const bits = [document.body?.innerText || ""];
    for (const element of document.querySelectorAll("[alt], [title], [aria-label]")) {
      bits.push(element.getAttribute("alt") || "", element.getAttribute("title") || "", element.getAttribute("aria-label") || "");
    }
    return bits.join("\n");
  }).catch(() => "");
}

async function visibleText(page) {
  const parts = [];
  for (const frame of page.frames()) {
    const text = await collectFrameText(frame);
    if (text) parts.push(text);
  }
  return parts.join("\n");
}

async function isLoginPage(page) {
  const text = await visibleText(page);
  if (matchTemplateNames(text).length > 0) return false;
  if (/\/login\b/i.test(page.url())) return true;
  const password = page.locator("input[type='password']").first();
  const visible = await password.isVisible().catch(() => false);
  if (!visible) return false;
  return true;
}

async function dismissCookieBanner(page) {
  const decline = page.locator("#CybotCookiebotDialogBodyButtonDecline").first();
  if (await decline.isVisible().catch(() => false)) {
    await decline.click().catch(() => {});
  }
}

async function dismissOverlayModal(page) {
  const confirm = page.getByRole("button", { name: /^(remove|delete|yes|ok|confirm)$/i }).first();
  if (await confirm.isVisible().catch(() => false)) await confirm.click({ timeout: 2000 }).catch(() => {});
}

async function dismissDiscardModal(page) {
  const discard = page.getByRole("button", { name: /^(discard|don't save|dont save|close without saving)$/i }).first();
  if (await discard.isVisible().catch(() => false)) await discard.click();
}

async function visibleError(page) {
  for (const frame of page.frames()) {
    const alert = frame.locator("[role='alert'], .alert-danger, .toast-error").filter({ hasText: /error|failed|unable|could not/i }).first();
    if (await alert.isVisible().catch(() => false)) {
      return (await alert.innerText()).replace(/\s+/g, " ").trim();
    }
  }
  return "";
}

async function scrollPage(page) {
  await page.evaluate(async () => {
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const height = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    for (let y = 0; y < height; y += 700) {
      window.scrollTo(0, y);
      await delay(40);
    }
    window.scrollTo(0, 0);
  }).catch(() => {});
}

function trackWrites(page, predicate) {
  const records = [];
  let successes = 0;
  const failures = [];
  const onFinished = (request, status) => {
    let interesting = false;
    try {
      interesting = predicate(request);
    } catch {
      interesting = false;
    }
    if (!interesting) return;
    const record = { method: request.method(), status, path: safePath(request.url()) };
    records.push(record);
    if (status >= 400 || status === 0) failures.push(`${record.method} ${record.path} ${status}`);
    else successes += 1;
  };
  const onResponse = (response) => onFinished(response.request(), response.status());
  const onFailed = (request) => onFinished(request, 0);
  page.on("response", onResponse);
  page.on("requestfailed", onFailed);
  return {
    get successes() {
      return successes;
    },
    snapshot: () => ({ successes, failures: [...failures], records: [...records] }),
    stop: () => {
      page.off("response", onResponse);
      page.off("requestfailed", onFailed);
      return { successes, failures: [...failures], records: [...records] };
    },
  };
}

function isUploadRequest(request) {
  if (IGNORE_HOST.test(request.url())) return false;
  if (!["POST", "PUT", "PATCH"].includes(request.method())) return false;
  const type = request.headers()["content-type"] || "";
  if (/multipart\/form-data/i.test(type)) return true;
  const length = Number(request.headers()["content-length"] || 0);
  if (length > 50000) return true;
  return /upload|overlay|media|video|file|asset/i.test(request.url());
}

function isAppWrite(request, pageUrl) {
  if (!["POST", "PUT", "PATCH"].includes(request.method())) return false;
  if (IGNORE_HOST.test(request.url())) return false;
  try {
    return new URL(request.url()).host === new URL(pageUrl).host;
  } catch {
    return false;
  }
}

function safePath(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return "invalid-url";
  }
}

async function pageIsBusy(page) {
  for (const frame of page.frames()) {
    const reason = await frame.evaluate(() => {
      const shown = (element) => {
        if (!element || element.hidden || element.closest("[hidden]")) return false;
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) < 0.05) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 12 && rect.height > 12;
      };
      const label = (element) => `${element.tagName}.${element.id} ${element.getAttribute("class") || ""}`.replace(/\s+/g, " ").trim().slice(0, 120);
      for (const element of document.querySelectorAll(".blockUI, .blockOverlay, .blockMsg, .pace, .pace-activity")) {
        if (shown(element)) return label(element);
      }
      for (const element of document.querySelectorAll("div, span, svg, img, i")) {
        if (!shown(element)) continue;
        if (element.closest(".video-template-item, button, a, .select2-container, .dz-preview, .dz-message, #overlay_dropzone_container, #preview_upload_container, #audio_upload_container, #overlay_mask_dropzone_container")) continue;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const name = `${element.id} ${element.getAttribute("class") || ""}`;
        const spinner = /(^|[^a-z])(spinner|loader|loading|page-loader)([^a-z]|$)/i.test(name);
        const floating = style.position === "fixed" || style.position === "absolute";
        const animated = Boolean(style.animationName && style.animationName !== "none");
        const nearCenter = Math.abs(rect.x + rect.width / 2 - window.innerWidth / 2) < 140
          && Math.abs(rect.y + rect.height / 2 - window.innerHeight / 2) < 180;
        if (spinner && floating && rect.width < 320 && rect.height < 320) return label(element);
        if (animated && floating && nearCenter && rect.width < 280 && rect.height < 280 && !element.closest(".video-lg-modal, .modal")) return label(element);
      }
      return "";
    }).catch(() => "");
    if (reason) return reason;
  }
  return "";
}

async function builderContentReady(page) {
  if (!(await isBuilderOpen(page)) || await pageIsBusy(page)) return false;
  if (await readBuilderTemplateName(page)) return true;
  const frame = await builderFrame(page);
  const waitingOnEmptyField = await frame.evaluate(() => {
    const input = document.querySelector("#template_name");
    return Boolean(input) && !(input.value || "").trim();
  }).catch(() => false);
  return !waitingOnEmptyField;
}

async function waitUntilLoaded(page, check, label) {
  let announced = false;
  const result = await waitFor(async () => {
    if (!announced) {
      announced = true;
      const text = `Waiting until ${label} is ready.`;
      logLine(text);
      setMessage(text);
    }
    return check();
  }, 60000);
  if (!result) throw new Error(`${label} did not finish loading. Stopped before the next click.`);
  return result;
}

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function overlayState(element) {
  const text = (element.innerText || "").replace(/\s+/g, " ").trim();
  const shown = (item) => {
    if (!item || item.hidden || item.closest("[hidden]")) return false;
    for (let node = item; node && node !== element.parentElement; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) < 0.15) return false;
    }
    const rect = item.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 30) return false;
    if (item.tagName === "IMG" && (rect.width < 80 || rect.height < 60)) return false;
    return true;
  };
  const message = element.querySelector?.(".dz-message");
  const messageBox = message?.getBoundingClientRect();
  const messageVisible = Boolean(messageBox && messageBox.width > 20 && messageBox.height > 10 && getComputedStyle(message).display !== "none");
  const hasDropHint = messageVisible || /drop file or click here to upload/i.test(text);
  const errorMatch = text.match(/upload failed|error uploading|too large|unsupported file/i);
  const previewBox = element.querySelector?.(".dz-preview");
  const previewVisible = Boolean(previewBox && shown(previewBox));
  const zone = element.classList?.contains("dropzone") ? element : element.querySelector(".dropzone");
  const fileInput = element.querySelector('input[type="file"]') || zone?.dropzone?.hiddenFileInput || null;
  return {
    text,
    hasDropHint,
    hasFileInput: Boolean(fileInput),
    hasPreview: previewVisible || [...element.querySelectorAll("video, img, canvas")].some(shown),
    uploading: /\b(uploading|processing|please wait)\b/i.test(text),
    error: errorMatch ? text.slice(0, 180) : "",
  };
}
