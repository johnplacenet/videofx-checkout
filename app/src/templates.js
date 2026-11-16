export const GROUPS = [
  { key: "paparazzi", label: "Paparazzi" },
  { key: "slo-mo-only", label: "Slo Mo Only" },
];

export const SECONDS = [10, 9, 8, 7, 6, 5, 4, 3, 2];

export const FIRST_TEMPLATE = "10 Second (Paparazzi)";

export function templateName(seconds, groupLabel) {
  return `${seconds} Second (${groupLabel})`;
}

export function allTemplates() {
  return templatesFor(GROUPS.map((group) => group.label));
}

export function templatesFor(groups) {
  const wanted = Array.isArray(groups) ? new Set(groups) : new Set(GROUPS.map((group) => group.label));
  const templates = [];
  for (const group of GROUPS) {
    if (!wanted.has(group.label)) continue;
    for (const seconds of SECONDS) {
      templates.push({
        id: `${seconds}-${group.key}`,
        seconds,
        group: group.label,
        name: templateName(seconds, group.label),
      });
    }
  }
  return templates;
}

export function normalizeName(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const NAME_RE = /^(\d+)\s+seconds?\s+(?:\(\s*)?(paparazzi|slo[-\s]?mo(?:\s+only)?)(?:\s*\))?$/i;
const NAME_SCAN_RE = /(?:^|[^\d])(\d+)\s+seconds?\s+(?:\(\s*)?(paparazzi|slo[-\s]?mo(?:\s+only)?)(?:\s*\))?/gi;

export function groupLabel(raw) {
  return /paparazzi/i.test(raw) ? "Paparazzi" : "Slo Mo Only";
}

export function parseTemplateName(value) {
  const match = normalizeName(value).match(NAME_RE);
  if (!match) return null;
  const group = groupLabel(match[2]);
  return {
    seconds: Number(match[1]),
    group,
    name: templateName(Number(match[1]), group),
  };
}

export function matchTemplateNames(text) {
  const found = new Map();
  for (const match of String(text || "").matchAll(NAME_SCAN_RE)) {
    const seconds = Number(match[1]);
    const group = groupLabel(match[2]);
    const name = templateName(seconds, group);
    const raw = match[0].replace(/^[^\d]+/, "").replace(/\s+/g, " ").trim();
    if (!found.has(name)) found.set(name, { seconds, group, name, raw });
  }
  return [...found.values()];
}

export function searchPhrases(template) {
  const styled = template.group === "Paparazzi" ? "PAPARAZZI" : "SLO-MO ONLY";
  const labels = template.group === "Paparazzi"
    ? ["Paparazzi"]
    : ["Slo Mo Only", "Slo-Mo Only", "SLO-MO ONLY"];
  return [...new Set([
    template.raw,
    template.name,
    `${template.seconds} SECOND ${styled}`,
    ...labels.map((label) => `${template.seconds} Second (${label})`),
  ].filter(Boolean).map((value) => normalizeName(value).toLowerCase()))];
}

export function namesMatch(actual, expected) {
  const parsedActual = parseTemplateName(actual);
  const parsedExpected = parseTemplateName(expected);
  if (!parsedActual || !parsedExpected) {
    return normalizeName(actual).toLowerCase() === normalizeName(expected).toLowerCase();
  }
  return parsedActual.seconds === parsedExpected.seconds && parsedActual.group === parsedExpected.group;
}

export function findTemplate(name) {
  const parsed = parseTemplateName(name);
  if (!parsed) return null;
  return allTemplates().find((template) => template.name === parsed.name) || null;
}
