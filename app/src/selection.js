export const MASTER_FIELDS = [
  { id: "overlay", label: "Overlay", file: true },
  { id: "preview", label: "Preview", file: true },
  { id: "soundtrack", label: "Soundtrack", file: true },
  { id: "overlayMask", label: "Overlay Mask (Optional)", file: true },
  { id: "resolution", label: "Resolution", file: false },
];

export const RESOLUTIONS = {
  square: ["1280x1280", "1080x1080", "720x720"],
  landscape: ["1920x1080", "1280x960", "1280x720", "1080x608"],
  portrait: ["1080x1920", "1080x1350", "960x1280", "720x1280"],
};

const MASTER_IDS = new Set(MASTER_FIELDS.map((field) => field.id));

export function normalizeSelection(input) {
  const requested = Array.isArray(input?.master) ? input.master : ["overlay"];
  const master = [];
  for (const id of requested) {
    if (MASTER_IDS.has(id) && !master.includes(id)) master.push(id);
  }
  return { master, timeline: timelineChoice(input) };
}

function timelineChoice(input) {
  const timeline = input?.timeline || {};
  if (typeof timeline.start === "boolean" || typeof timeline.end === "boolean") {
    return { start: Boolean(timeline.start), end: Boolean(timeline.end) };
  }
  if (timeline.on) {
    return timeline.position === "start" ? { start: true, end: false } : { start: false, end: true };
  }
  return { start: false, end: false };
}

function timelineFile(input, chosen, position) {
  const specific = position === "start" ? input.files?.timelineStart : input.files?.timelineEnd;
  if (specific) return specific;
  const onlyOne = chosen.start !== chosen.end;
  return onlyOne ? input.files?.timelineVideo || "" : "";
}

export function selectionPlan(input = {}) {
  const chosen = normalizeSelection(input);
  const labels = new Map(MASTER_FIELDS.map((field) => [field.id, field.label]));
  if (!chosen.master.length && !chosen.timeline.start && !chosen.timeline.end) {
    return { ok: false, error: "Choose Overlay, Soundtrack, or the Timeline uploaded video. No templates were changed." };
  }
  const missing = [];
  for (const field of MASTER_FIELDS) {
    if (!field.file || !chosen.master.includes(field.id)) continue;
    if (!input.files?.[field.id]) missing.push(field.label);
  }
  const resolution = input.resolution || null;
  if (chosen.master.includes("resolution")) {
    const sizes = RESOLUTIONS[resolution?.aspect] || [];
    if (!sizes.includes(resolution?.size)) missing.push("a Square, Landscape, or Portrait size");
  }
  if (chosen.timeline.start && !timelineFile(input, chosen.timeline, "start")) missing.push("the Start video");
  if (chosen.timeline.end && !timelineFile(input, chosen.timeline, "end")) missing.push("the End video");
  if (missing.length) {
    return {
      ok: false,
      error: `Choose ${missing.join(" and ")} before updating. No templates were changed.`,
    };
  }
  const changing = chosen.master.map((id) => {
    if (id === "resolution" && resolution?.aspect && resolution?.size) return `Resolution ${resolution.aspect} ${resolution.size}`;
    return labels.get(id);
  }).join(", ");
  const staying = MASTER_FIELDS.filter((field) => !chosen.master.includes(field.id)).map((field) => field.label);
  const left = staying.length ? staying.join(", ") : "the other Master Settings cards";
  const masterSummary = chosen.master.length
    ? `Master Settings: ${changing}. Leaving ${left}.`
    : "Master Settings stay as they are.";
  const places = [chosen.timeline.start ? "start" : "", chosen.timeline.end ? "end" : ""].filter(Boolean);
  const timelineSummary = places.length
    ? `Timeline: replace the Uploaded Video at the ${places.join(" and the ")}.`
    : "The Timeline tab stays unchanged.";
  return {
    ok: true,
    master: chosen.master,
    timeline: chosen.timeline,
    summary: `${masterSummary} ${timelineSummary}`,
  };
}
