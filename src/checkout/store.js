import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function createKey() {
  const bytes = crypto.randomBytes(16);
  let raw = "";
  for (const byte of bytes) raw += ALPHABET[byte % ALPHABET.length];
  return `VFX-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}

function normalizeKey(key) {
  return String(key || "").trim().toUpperCase();
}

export function openStore(dir) {
  const file = path.join(dir, "licenses.json");

  function read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function write(licenses) {
    fs.mkdirSync(dir, { recursive: true });
    const next = `${file}.tmp`;
    fs.writeFileSync(next, JSON.stringify(licenses, null, 2));
    fs.renameSync(next, file);
  }

  return {
    issueLicense({ sessionId, email }) {
      const id = String(sessionId || "").trim();
      if (!id) throw new Error("The payment session is missing.");
      const licenses = read();
      const existing = licenses.find((item) => item.sessionId === id);
      if (existing) return existing;
      const record = {
        key: createKey(),
        sessionId: id,
        email: String(email || "").trim().toLowerCase(),
        machineIdHash: "",
        deviceLabel: "",
        createdAt: new Date().toISOString(),
      };
      licenses.push(record);
      write(licenses);
      return record;
    },

    list() {
      return read().map((record) => ({
        email: record.email || "",
        key: record.key,
        deviceLabel: record.deviceLabel || "",
        active: Boolean(record.machineIdHash),
        createdAt: record.createdAt,
      }));
    },

    release({ key }) {
      const wanted = normalizeKey(key);
      if (!wanted) return { ok: false, status: 400, error: "Paste the code." };
      const licenses = read();
      const record = licenses.find((item) => item.key === wanted);
      if (!record) return { ok: false, status: 404, error: "That code was not found." };
      record.machineIdHash = "";
      record.deviceLabel = "";
      write(licenses);
      return { ok: true, message: "This code can be used on another computer." };
    },

    holds({ key, machineIdHash }) {
      const wanted = normalizeKey(key);
      const machine = String(machineIdHash || "").trim();
      const record = read().find((item) => item.key === wanted);
      if (!record || !record.machineIdHash || record.machineIdHash !== machine) {
        return { ok: true, active: false };
      }
      return { ok: true, active: true };
    },

    activate({ key, machineIdHash, deviceLabel }) {
      const wanted = normalizeKey(key);
      const machine = String(machineIdHash || "").trim();
      if (!wanted) return { ok: false, status: 400, error: "Paste the activation key." };
      if (!machine) return { ok: false, status: 400, error: "This computer could not be identified." };
      const licenses = read();
      const record = licenses.find((item) => item.key === wanted);
      if (!record) return { ok: false, status: 404, error: "That key was not found." };
      if (record.machineIdHash && record.machineIdHash !== machine) {
        const where = record.deviceLabel || "another computer";
        return {
          ok: false,
          status: 409,
          error: `This key is already active on ${where}. It works on one computer only.`,
        };
      }
      record.machineIdHash = machine;
      if (deviceLabel) record.deviceLabel = String(deviceLabel).slice(0, 120);
      write(licenses);
      return { ok: true, active: true, message: "This computer is activated." };
    },
  };
}

function rowToRecord(row) {
  return {
    key: row.key,
    sessionId: row.session_id,
    email: row.email || "",
    machineIdHash: row.machine_id_hash || "",
    deviceLabel: row.device_label || "",
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at || ""),
  };
}

export async function openDatabase(connectionString) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString, max: 5 });
  await pool.query(`CREATE TABLE IF NOT EXISTS licenses (
    key text PRIMARY KEY,
    session_id text UNIQUE NOT NULL,
    email text NOT NULL DEFAULT '',
    machine_id_hash text NOT NULL DEFAULT '',
    device_label text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
  )`);

  return {
    async issueLicense({ sessionId, email }) {
      const id = String(sessionId || "").trim();
      if (!id) throw new Error("The payment session is missing.");
      const key = createKey();
      const inserted = await pool.query(
        `INSERT INTO licenses (key, session_id, email)
         VALUES ($1, $2, $3)
         ON CONFLICT (session_id) DO NOTHING
         RETURNING key, session_id, email, machine_id_hash, device_label, created_at`,
        [key, id, String(email || "").trim().toLowerCase()],
      );
      if (inserted.rows[0]) return rowToRecord(inserted.rows[0]);
      const existing = await pool.query(
        `SELECT key, session_id, email, machine_id_hash, device_label, created_at FROM licenses WHERE session_id = $1`,
        [id],
      );
      return rowToRecord(existing.rows[0]);
    },

    async list() {
      const result = await pool.query(
        `SELECT email, key, device_label, machine_id_hash, created_at FROM licenses ORDER BY created_at DESC`,
      );
      return result.rows.map((row) => ({
        email: row.email || "",
        key: row.key,
        deviceLabel: row.device_label || "",
        active: Boolean(row.machine_id_hash),
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at || ""),
      }));
    },

    async release({ key }) {
      const wanted = normalizeKey(key);
      if (!wanted) return { ok: false, status: 400, error: "Paste the code." };
      const result = await pool.query(
        `UPDATE licenses SET machine_id_hash = '', device_label = '' WHERE key = $1`,
        [wanted],
      );
      if (result.rowCount === 0) return { ok: false, status: 404, error: "That code was not found." };
      return { ok: true, message: "This code can be used on another computer." };
    },

    async holds({ key, machineIdHash }) {
      const wanted = normalizeKey(key);
      const machine = String(machineIdHash || "").trim();
      const result = await pool.query(
        `SELECT machine_id_hash FROM licenses WHERE key = $1`,
        [wanted],
      );
      const row = result.rows[0];
      return { ok: true, active: Boolean(row && row.machine_id_hash && row.machine_id_hash === machine) };
    },

    async activate({ key, machineIdHash, deviceLabel }) {
      const wanted = normalizeKey(key);
      const machine = String(machineIdHash || "").trim();
      if (!wanted) return { ok: false, status: 400, error: "Paste the activation key." };
      if (!machine) return { ok: false, status: 400, error: "This computer could not be identified." };
      const label = deviceLabel ? String(deviceLabel).slice(0, 120) : "";
      const updated = await pool.query(
        `UPDATE licenses
         SET machine_id_hash = $2, device_label = CASE WHEN $3 = '' THEN device_label ELSE $3 END
         WHERE key = $1 AND (machine_id_hash = '' OR machine_id_hash = $2)
         RETURNING key`,
        [wanted, machine, label],
      );
      if (updated.rowCount > 0) return { ok: true, active: true, message: "This computer is activated." };
      const existing = await pool.query(`SELECT device_label FROM licenses WHERE key = $1`, [wanted]);
      if (!existing.rows[0]) return { ok: false, status: 404, error: "That key was not found." };
      const where = existing.rows[0].device_label || "another computer";
      return { ok: false, status: 409, error: `This key is already active on ${where}. It works on one computer only.` };
    },
  };
}
