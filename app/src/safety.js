export function controlInfo(input = {}) {
  return {
    text: normalize(input.text),
    aria: normalize(input.aria),
    title: normalize(input.title),
    className: normalize(input.className),
  };
}

function normalize(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function blob(info) {
  return `${info.text} ${info.aria} ${info.title} ${info.className}`.toLowerCase();
}

export function isTemplateDeleteControl(input) {
  const info = controlInfo(input);
  const text = blob(info);
  if (/remove template|delete template|delete this template/.test(text)) return true;
  if (info.text === "×" || info.text === "✕" || info.text === "x" || info.text === "X") return true;
  if (/fa-times|fa-close|fa-trash|fa-remove|icon-close|icon-trash|template-remove|remove-template|btn-danger/.test(text)) {
    return true;
  }
  return false;
}

export function isOverlayRemoveControl(input) {
  const info = controlInfo(input);
  const text = blob(info);
  if (/remove template|delete template|delete this template/.test(text)) return false;
  if (info.text === "×" || info.text === "✕" || info.text === "x" || info.text === "X") return true;
  if (/remove overlay|clear overlay|remove file|close/.test(text)) return true;
  if (/fa-times|fa-close|icon-close/.test(text) && !/template/.test(text)) return true;
  return false;
}

export async function runSequentially(items, worker) {
  const completed = [];
  for (const item of items) {
    await worker(item);
    completed.push(item);
  }
  return completed;
}
