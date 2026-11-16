import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const eventFile = path.join(root, "uploads", "event.json");

export const EVENTS_URL = "https://app.snappic.com/view/events";

let eventId = readEventId();

export function currentEventId() {
  return eventId;
}

export function normalizeEventId(value) {
  const next = String(value ?? "").trim();
  if (!next) return "";
  if (!/^\d{4,12}$/.test(next)) {
    const error = new Error("Enter the event ID as numbers only. It is the number at the end of your template link.");
    error.statusCode = 400;
    throw error;
  }
  return next;
}

export function templateUrl(value) {
  const id = normalizeEventId(value);
  if (!id) return "";
  return `https://app.snappic.com/event/video/template?edit=true&event_id=${id}`;
}

export function eventIdFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)snappic\.com$/i.test(parsed.hostname)) return "";
    const query = parsed.searchParams.get("event_id") || "";
    if (/^\d{4,12}$/.test(query)) return query;
    const match = parsed.pathname.match(/\/(?:view\/)?event\/(\d{4,12})(?:\/|$)/i);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

export function rememberEventId(value) {
  const next = normalizeEventId(value);
  eventId = next;
  fs.mkdirSync(path.dirname(eventFile), { recursive: true });
  fs.writeFileSync(eventFile, JSON.stringify({ eventId: next }));
  return next;
}

function readEventId() {
  try {
    const saved = JSON.parse(fs.readFileSync(eventFile, "utf8"));
    return normalizeEventId(saved.eventId);
  } catch {
    return "";
  }
}
