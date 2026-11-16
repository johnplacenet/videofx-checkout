import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const licenseFile = path.join(root, "uploads", "license.json");
const checkout = (process.env.LICENSE_API || "https://videofx.thecre8iveplace.com").replace(/\/$/, "");

function hardwareId() {
  try {
    if (process.platform === "darwin") {
      const out = execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8" });
      const match = out.match(/"IOPlatformUUID" = "([^"]+)"/);
      if (match) return match[1];
    }
    if (process.platform === "win32") {
      const out = execFileSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], { encoding: "utf8" });
      const match = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/i);
      if (match) return match[1];
    }
  } catch {
    // Fall through to a weaker id if the platform command is unavailable.
  }
  const cpu = os.cpus()[0]?.model || "";
  return `${os.hostname()}|${os.platform()}|${os.arch()}|${cpu}`;
}

export function machineIdHash() {
  return crypto.createHash("sha256").update(hardwareId()).digest("hex").slice(0, 32);
}

function readStored() {
  try {
    const parsed = JSON.parse(fs.readFileSync(licenseFile, "utf8"));
    if (parsed && typeof parsed.key === "string" && parsed.machineIdHash) return parsed;
  } catch {
    // No saved key yet.
  }
  return null;
}

export function licenseStatus() {
  const stored = readStored();
  const owner = process.env.VIDEOFX_LICENSE_OWNER === "1";
  const matches = Boolean(stored && stored.machineIdHash === machineIdHash());
  if (owner || matches) {
    return {
      active: true,
      owner: owner || Boolean(stored?.admin),
      key: stored?.key || "",
      message: "This computer is activated.",
    };
  }
  if (!stored) return { active: false, owner: false, key: "", message: "Paste the key from the checkout page. It works on this computer only." };
  return { active: false, owner: false, key: "", message: "This key was activated on a different computer." };
}

export async function activateLicense(key) {
  const licenseKey = String(key || "").trim();
  if (!licenseKey) {
    const error = new Error("Paste the activation key.");
    error.statusCode = 400;
    throw error;
  }
  const machine = machineIdHash();
  const response = await fetch(`${checkout}/api/v1/licenses/activate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      licenseKey,
      machineIdHash: machine,
      deviceLabel: `${os.hostname()} (${os.platform()})`.slice(0, 120),
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    const error = new Error(body.error || "That key could not be activated.");
    error.statusCode = response.status || 400;
    throw error;
  }
  fs.mkdirSync(path.dirname(licenseFile), { recursive: true });
  fs.writeFileSync(licenseFile, JSON.stringify({ key: licenseKey, machineIdHash: machine, activatedAt: new Date().toISOString() }, null, 2));
  return { ok: true, active: true, message: "This computer is activated." };
}

export async function releaseLicense() {
  const stored = readStored();
  if (!stored) return { ok: true, message: "This computer was not activated." };
  const response = await fetch(`${checkout}/api/v1/licenses/release`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ licenseKey: stored.key }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    const error = new Error(body.error || "This code could not be freed.");
    error.statusCode = response.status || 400;
    throw error;
  }
  if (fs.existsSync(licenseFile)) fs.unlinkSync(licenseFile);
  return { ok: true, active: false, message: "This code can be used on another computer." };
}

export async function licenseStillHeld() {
  if (process.env.VIDEOFX_LICENSE_OWNER === "1") return true;
  const stored = readStored();
  if (!stored) return false;
  const response = await fetch(`${checkout}/api/v1/licenses/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ licenseKey: stored.key, machineIdHash: machineIdHash() }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) return true;
  if (body.active) return true;
  if (body.ok === true && fs.existsSync(licenseFile)) fs.unlinkSync(licenseFile);
  return body.ok === true ? false : true;
}
