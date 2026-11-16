import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeBrowser, getPage, openLoginPage, openPageUrl } from "./snappic.js";
import { finishEventSave, publicError, startJob } from "./runner.js";
import { refreshFile, setMessage, state } from "./status.js";
import { currentEventId, eventIdFromUrl, rememberEventId } from "./event-link.js";
import { activateLicense, licenseStatus, licenseStillHeld, releaseLicense } from "./license.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const uploadsDir = path.join(root, "uploads");
const chosenRecord = path.join(uploadsDir, "chosen.json");
const port = Number(process.env.PORT || 4177);
const chosenFiles = {};
const choosePrompts = {
  overlay: "Choose the Overlay file",
  preview: "Choose the Preview video",
  soundtrack: "Choose the Soundtrack",
  overlayMask: "Choose the Overlay Mask",
  timelineVideo: "Choose the Timeline uploaded video",
};
function rememberChosen() {
  fs.mkdirSync(uploadsDir, { recursive: true });
  const data = {};
  for (const [kind, item] of Object.entries(chosenFiles)) {
    data[kind] = { path: item.path, name: item.name, size: item.size };
  }
  fs.writeFileSync(chosenRecord, JSON.stringify(data));
}
function restoreChosenFiles() {
  if (fs.existsSync(chosenRecord)) {
    try {
      const data = JSON.parse(fs.readFileSync(chosenRecord, "utf8"));
      for (const [kind, item] of Object.entries(data)) {
        if (!fileKinds[kind] || !item?.path || !fs.existsSync(item.path)) continue;
        const stat = fs.statSync(item.path);
        const extension = path.extname(item.path).toLowerCase();
        if (!stat.isFile() || stat.size <= 0 || !fileKinds[kind].includes(extension)) continue;
        chosenFiles[kind] = { path: item.path, name: item.name || path.basename(item.path), size: stat.size };
      }
    } catch {
      // A bad record should not block the file copies below.
    }
  }
  if (!fs.existsSync(uploadsDir)) return;
  for (const [kind, extensions] of Object.entries(fileKinds)) {
    if (chosenFiles[kind]) continue;
    const matches = extensions
      .map((extension) => path.join(uploadsDir, `${kind}${extension}`))
      .filter((file) => fs.existsSync(file) && fs.statSync(file).isFile() && fs.statSync(file).size > 0)
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (!matches[0]) continue;
    const stat = fs.statSync(matches[0]);
    chosenFiles[kind] = { path: matches[0], name: path.basename(matches[0]), size: stat.size };
  }
}
function publicChosen() {
  return Object.fromEntries(Object.entries(chosenFiles).map(([kind, item]) => [kind, { name: item.name, path: item.path }]));
}
const fileKinds = {
  overlay: [".mp4", ".png", ".apng"],
  preview: [".mp4"],
  soundtrack: [".mp3", ".m4a"],
  overlayMask: [".png", ".apng", ".jpg", ".jpeg", ".mp4"],
  timelineVideo: [".mp4"],
};
const fileLimits = {
  overlay: 30 * 1024 * 1024,
  preview: 5 * 1024 * 1024,
  soundtrack: 5 * 1024 * 1024,
  overlayMask: 10 * 1024 * 1024,
  timelineVideo: 30 * 1024 * 1024,
};
function fileTooLarge(kind, size) {
  const limit = fileLimits[kind];
  if (!limit || size < limit) return "";
  const amount = kind === "timelineVideo" ? "30MiB" : `${limit / (1024 * 1024)} MB`;
  return `That file needs to be less than ${amount}.`;
}
restoreChosenFiles();

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  if (url.pathname === "/api/status") {
    refreshFile();
    return sendJson(response, { ...state, chosenFiles: publicChosen(), eventId: currentEventId(), license: licenseStatus() });
  }
  if (url.pathname === "/api/stop" && request.method === "POST") {
    state.cancelRequested = true;
    return sendJson(response, { ok: true });
  }
  if (url.pathname === "/api/open-login" && request.method === "POST") {
    if (state.running && !state.awaitingLogin) {
      return sendJson(response, { ok: false, error: "A template update is in progress. The login window can open again when it stops." }, 409);
    }
    try {
      const opened = await openLoginPage();
      if (!state.running) setMessage("The Snappic sign-in page is open. Sign in there, then click Check templates.");
      return sendJson(response, { ok: true, url: opened });
    } catch (error) {
      const message = publicError(error);
      return sendJson(response, { ok: false, error: message }, 500);
    }
  }
  if (url.pathname === "/api/chosen-file" && request.method === "POST") {
    try {
      const kind = url.searchParams.get("kind") || "";
      const original = url.searchParams.get("name") || "file";
      const extensions = fileKinds[kind];
      const extension = path.extname(original).toLowerCase();
      if (!extensions || !extensions.includes(extension)) {
        return sendJson(response, { ok: false, error: "Choose a file of the right type for that item." }, 400);
      }
      const bytes = await readRaw(request, 30 * 1024 * 1024);
      if (!bytes.length) return sendJson(response, { ok: false, error: "That file is empty." }, 400);
      const tooLarge = fileTooLarge(kind, bytes.length);
      if (tooLarge) return sendJson(response, { ok: false, error: tooLarge }, 400);
      fs.mkdirSync(uploadsDir, { recursive: true });
      const safe = `${kind}${extension}`;
      const dest = path.join(uploadsDir, safe);
      fs.writeFileSync(dest, bytes);
      chosenFiles[kind] = { path: dest, name: path.basename(original), size: bytes.length };
      rememberChosen();
      return sendJson(response, { ok: true, kind, name: chosenFiles[kind].name, path: dest, size: bytes.length });
    } catch (error) {
      return sendJson(response, { ok: false, error: error.message }, 400);
    }
  }
  if (url.pathname === "/api/choose-file" && request.method === "POST") {
    const kind = url.searchParams.get("kind") || "";
    const extensions = fileKinds[kind];
    const prompt = choosePrompts[kind];
    if (!extensions || !prompt) return sendJson(response, { ok: false, error: "Choose a file for Overlay, Preview, Soundtrack, or Overlay Mask." }, 400);
    if (state.running) return sendJson(response, { ok: false, error: "Wait until the current run finishes, then choose the file." }, 409);
    try {
      const picked = process.platform === "win32"
        ? await chooseWindowsFile(prompt, extensions)
        : await chooseMacFile(prompt);
      const extension = path.extname(picked).toLowerCase();
      if (!extensions.includes(extension)) {
        return sendJson(response, { ok: false, error: `That file needs to be ${extensions.join(", ")}.` }, 400);
      }
      const stat = fs.statSync(picked);
      if (!stat.isFile() || stat.size <= 0) return sendJson(response, { ok: false, error: "That file is empty." }, 400);
      const tooLarge = fileTooLarge(kind, stat.size);
      if (tooLarge) return sendJson(response, { ok: false, error: tooLarge }, 400);
      chosenFiles[kind] = { path: picked, name: path.basename(picked), size: stat.size };
      rememberChosen();
      return sendJson(response, { ok: true, kind, name: chosenFiles[kind].name, path: picked });
    } catch (error) {
      const message = String(error?.stderr || error?.message || "");
      if (/user canceled|user cancelled|\(-128\)/i.test(message)) return sendJson(response, { ok: false, cancelled: true });
      return sendJson(response, { ok: false, error: "The file window did not open. Try Choose file again." }, 500);
    }
  }
  if (url.pathname === "/api/save-event" && request.method === "POST") {
    if (state.running) {
      return sendJson(response, { ok: false, error: "Wait until the template update finishes, then press Save changes." }, 409);
    }
    state.running = true;
    state.eventSave = "saving";
    setMessage("Clicking Save changes on the template list.");
    try {
      const page = await getPage();
      const saved = await finishEventSave(page);
      return sendJson(response, { ok: saved, eventSave: state.eventSave, message: state.message });
    } catch (error) {
      state.eventSave = "failed";
      const message = publicError(error);
      setMessage(message);
      return sendJson(response, { ok: false, error: message }, 500);
    } finally {
      state.running = false;
    }
  }
  if (url.pathname === "/api/event-from-page" && request.method === "POST") {
    const current = openPageUrl();
    if (!current || current === "about:blank") {
      return sendJson(response, { ok: false, error: "Open your event in the Snappic window, then click Get my event ID." }, 400);
    }
    const eventId = eventIdFromUrl(current);
    if (!eventId) {
      return sendJson(response, { ok: false, error: "This page is not an event yet. Open your event, then click Get my event ID." }, 400);
    }
    rememberEventId(eventId);
    return sendJson(response, { ok: true, eventId });
  }
  if (url.pathname === "/api/event" && request.method === "POST") {
    try {
      const body = JSON.parse((await readBody(request)) || "{}");
      const eventId = rememberEventId(body.eventId);
      return sendJson(response, { ok: true, eventId });
    } catch (error) {
      return sendJson(response, { ok: false, error: error.message }, error.statusCode || 400);
    }
  }
  if (url.pathname === "/api/license" && request.method === "POST") {
    try {
      const body = JSON.parse((await readBody(request)) || "{}");
      const result = body.release ? await releaseLicense() : await activateLicense(body.key);
      return sendJson(response, result);
    } catch (error) {
      return sendJson(response, { ok: false, error: error.message }, error.statusCode || 400);
    }
  }
  if (url.pathname === "/api/jobs" && request.method === "POST") {
    try {
      const body = JSON.parse((await readBody(request)) || "{}");
      if (body.mode !== "dry-run" && !(licenseStatus().active && await licenseStillHeld())) {
        return sendJson(response, { ok: false, error: "Activate this computer before updating templates." }, 402);
      }
      body.eventId = rememberEventId(body.eventId);
      body.files = Object.fromEntries(Object.entries(chosenFiles).map(([kind, item]) => [kind, item.path]));
      startJob(body);
      return sendJson(response, { ok: true });
    } catch (error) {
      return sendJson(response, { ok: false, error: error.message }, error.statusCode || 400);
    }
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return sendJson(response, { error: "Not found" }, 404);
  }
  const relative = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
  const filePath = path.resolve(publicDir, relative);
  if (!filePath.startsWith(`${publicDir}${path.sep}`) && filePath !== publicDir) {
    return sendJson(response, { error: "Not found" }, 404);
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return sendJson(response, { error: "Not found" }, 404);
  }
  response.writeHead(200, {
    "content-type": types[path.extname(filePath)] || "application/octet-stream",
    "cache-control": "no-store",
  });
  if (request.method === "HEAD") return response.end();
  fs.createReadStream(filePath).pipe(response);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`GlamBot overlay updater: http://127.0.0.1:${port}`);
});

function chooseMacFile(prompt) {
  const script = `POSIX path of (choose file with prompt ${JSON.stringify(prompt)})`;
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      const picked = String(stdout || "").trim();
      if (!picked) {
        reject(new Error("The file window did not return a file."));
        return;
      }
      resolve(picked);
    });
  });
}

function chooseWindowsFile(prompt, extensions) {
  const patterns = extensions.map((extension) => `*${extension}`).join(";");
  const filter = `Supported (${patterns})|${patterns}`;
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const script = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = ${quote(prompt)}
$dialog.Filter = ${quote(filter)}
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.WriteLine($dialog.FileName) }
`;
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-STA", "-Command", script], { windowsHide: false }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      const picked = String(stdout || "").trim();
      if (!picked) {
        reject(new Error("user canceled"));
        return;
      }
      resolve(picked);
    });
  });
}

function sendJson(response, payload, status = 200) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function readRaw(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("That file is larger than 30 MB."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await closeBrowser();
    server.close(() => process.exit(0));
  });
}
