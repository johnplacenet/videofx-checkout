import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const REQUESTED_OVERLAY_PATH =
  "/Volumes/T9/!!!!GLAMBOT MIAMI STUFF/snap pic template set up/overlay.MP4";

export const FOUND_OVERLAY_PATH =
  "/Volumes/T9/!!!!GLAMBOT MIAMI STUFF/SNAPPIC TEMPLATE SETUP/OVERLAY.mp4";

const MAX_BYTES = 20 * 1024 * 1024;

let cacheKey = "";
let cacheValue = null;

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function candidates(explicit) {
  return [explicit, process.env.OVERLAY_PATH, REQUESTED_OVERLAY_PATH, FOUND_OVERLAY_PATH].filter(Boolean);
}

export function resolveOverlayPath(explicit) {
  const seen = new Set();
  for (const candidate of candidates(explicit)) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Keep looking. A missing volume throws on some stat calls.
    }
  }
  return explicit || REQUESTED_OVERLAY_PATH;
}

export function inspectOverlayFile(explicit, { force = false } = {}) {
  const filePath = resolveOverlayPath(explicit);
  let stat = null;
  try {
    if (fs.existsSync(filePath)) stat = fs.statSync(filePath);
  } catch {
    stat = null;
  }

  const key = stat ? `${filePath}:${stat.size}:${stat.mtimeMs}` : `missing:${filePath}`;
  if (!force && cacheValue && cacheKey === key) return cacheValue;

  const requestedExists = safeExists(REQUESTED_OVERLAY_PATH);
  if (!stat || !stat.isFile()) {
    cacheKey = key;
    cacheValue = {
      path: filePath,
      requestedPath: REQUESTED_OVERLAY_PATH,
      exists: false,
      ok: false,
      usedFallback: false,
      size: 0,
      sizeLabel: "",
      mtime: null,
      sha256: "",
      error: `Overlay file not found. The requested path is missing, and ${FOUND_OVERLAY_PATH} was not available either.`,
    };
    return cacheValue;
  }

  const problems = [];
  const extension = path.extname(filePath).toLowerCase();
  if (stat.size <= 0) problems.push("The overlay file is empty.");
  if (stat.size > MAX_BYTES) {
    problems.push(`The overlay is ${formatBytes(stat.size)}. Overlay videos need to be under 20 MB.`);
  }
  if (extension !== ".mp4") problems.push(`The overlay must be an .mp4 file. This file is ${extension || "missing an extension"}.`);

  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  cacheKey = key;
  cacheValue = {
    path: filePath,
    requestedPath: REQUESTED_OVERLAY_PATH,
    exists: true,
    ok: problems.length === 0,
    usedFallback: !requestedExists && path.resolve(filePath) !== path.resolve(REQUESTED_OVERLAY_PATH),
    size: stat.size,
    sizeLabel: formatBytes(stat.size),
    mtime: stat.mtime.toISOString(),
    sha256,
    error: problems.join(" "),
  };
  return cacheValue;
}

function safeExists(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}
