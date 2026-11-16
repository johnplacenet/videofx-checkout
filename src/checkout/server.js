import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";
import { buildDownloads, downloadZipPath } from "../../scripts/build-downloads.js";
import { openDatabase, openStore } from "./store.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const store = process.env.DATABASE_URL
  ? await openDatabase(process.env.DATABASE_URL)
  : openStore(path.join(root, "checkout-data"));
const port = Number(process.env.PORT || 4178);
const host = process.env.PORT ? "0.0.0.0" : "127.0.0.1";
const INTEGRATION = "videofx-checkout-mqkrtwzn";

function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  return new Stripe(key, { apiVersion: "2026-09-30.endive" });
}

function stripeForm(data, prefix = "") {
  const args = [];
  for (const [key, value] of Object.entries(data || {})) {
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, index) => args.push(...stripeForm(item, `${name}[${index}]`)));
    } else if (value && typeof value === "object") {
      args.push(...stripeForm(value, name));
    } else if (value != null) {
      args.push("-d", `${name}=${value}`);
    }
  }
  return args;
}

function stripeCli(method, apiPath, data) {
  const args = [method, apiPath, "--live", "--color", "off", ...stripeForm(data)];
  return new Promise((resolve, reject) => {
    execFile("stripe", args, { maxBuffer: 5_000_000 }, (error, stdout, stderr) => {
      const combined = `${stdout || ""}\n${stderr || ""}`;
      if (error) {
        const line = combined.split("\n").map((item) => item.trim()).find((item) => item && !item.startsWith("▸") && !item.startsWith("time="));
        const wrapped = new Error(publicError({ message: line || "The payment page could not be opened." }));
        wrapped.statusCode = 502;
        reject(wrapped);
        return;
      }
      const start = stdout.indexOf("{");
      if (start < 0) {
        const wrapped = new Error("The payment page could not be opened.");
        wrapped.statusCode = 502;
        reject(wrapped);
        return;
      }
      resolve(JSON.parse(stdout.slice(start)));
    });
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function publicError(error) {
  return String(error?.message || "The payment page could not be opened.").replace(/[sr]k_(?:live|test)_[A-Za-z0-9]+/g, "[key]");
}

function page({ title, body, wide = false, document = "License" }) {
  const width = wide ? "860px" : "640px";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; font: 16px/1.55 "Avenir Next", "Segoe UI", "Helvetica Neue", Arial, sans-serif; background: #f3f5f8; color: #142033; }
    .letterhead { background: #10233f; color: #fff; padding: 22px 24px 40px; }
    .letterhead-inner { max-width: ${width}; margin: 0 auto; display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; }
    .brand { margin: 0; font-size: 12px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; }
    .brand span { display: block; margin-top: 6px; font-size: 18px; font-weight: 600; letter-spacing: 0; text-transform: none; color: #f4efe4; }
    .doc { margin: 0; font-size: 12px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #d4bc86; }
    main { max-width: ${width}; margin: -22px auto 48px; padding: 32px 36px 28px; background: #fff; border: 1px solid #e1e6ee; border-top: 4px solid #b0893e; box-shadow: 0 16px 40px rgba(16, 35, 63, 0.08); }
    p { margin: 0 0 14px; }
    h1 { margin: 0 0 8px; font-size: 32px; line-height: 1.15; letter-spacing: -0.02em; }
    .status { margin: 0 0 8px; color: #1d6b45; font-size: 13px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
    .lead { color: #3d4c5f; }
    .price { margin: 8px 0 18px; font-size: 42px; font-weight: 700; letter-spacing: -0.03em; }
    .code-card { margin: 22px 0; padding: 18px 16px 16px; text-align: center; background: #f7f5f0; border: 1px solid #e4dcc8; }
    .code-label { margin: 0 0 6px; color: #6d6248; font-size: 12px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; }
    .key { margin: 0; font: 700 26px/1.3 ui-monospace, "SFMono-Regular", Menlo, monospace; letter-spacing: 0.06em; word-break: break-word; }
    .steps { margin: 0 0 18px; padding: 0; list-style: none; }
    .steps li { display: grid; grid-template-columns: 28px 1fr; gap: 12px; margin: 0; padding: 12px 0; border-top: 1px solid #e7ebf0; }
    .steps li span { width: 28px; height: 28px; border-radius: 50%; background: #10233f; color: #fff; font-size: 13px; font-weight: 700; line-height: 28px; text-align: center; }
    button { width: 100%; border: 0; background: #10233f; color: #fff; font: 700 16px "Avenir Next", "Segoe UI", sans-serif; padding: 14px 16px; cursor: pointer; }
    button.small { width: auto; padding: 7px 10px; font-size: 13px; }
    button.quiet { background: #fff; color: #10233f; border: 1px solid #c5d0dc; }
    form.inline { display: inline; }
    .create-row { display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: end; margin: 0 0 18px; }
    .create-row input { margin: 0; }
    button:disabled { opacity: 0.6; cursor: wait; }
    label { display: block; margin: 0 0 6px; font-size: 12px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #5c6b7a; }
    input { width: 100%; margin: 0 0 16px; padding: 12px; border: 1px solid #d5dde6; font: 700 18px ui-monospace, Menlo, monospace; }
    .note { color: #5c6b7a; font-size: 14px; }
    .error { color: #9b2c2c; }
    .save { margin: 0 0 14px; padding: 12px 14px; background: #f4f8f5; color: #1d6b45; font-weight: 650; }
    a { color: #10233f; }
    h2.download-title { margin: 0 0 8px; font-size: 22px; }
    .downloads { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 0 0 18px; }
    .downloads a { display: block; text-align: center; text-decoration: none; background: #10233f; color: #fff; font-weight: 700; padding: 14px 12px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid #e7ebf0; vertical-align: top; }
    th { font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: #5c6b7a; }
    @media (max-width: 680px) {
      .letterhead-inner { align-items: flex-start; flex-direction: column; }
      main { margin-left: 12px; margin-right: 12px; padding: 24px 18px 20px; }
      .key { font-size: 18px; }
      .downloads { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header class="letterhead">
    <div class="letterhead-inner">
      <p class="brand">The Creative Place LLC<span>VideoFX automator Platform</span></p>
      <p class="doc">${escapeHtml(document)}</p>
    </div>
  </header>
  <main>${body}</main>
</body>
</html>`;
}

function homePage(canceled, test) {
  const price = test ? "$1" : "$50";
  const endpoint = test ? "/api/checkout?test=1" : "/api/checkout";
  return page({
    title: "VideoFX automator Platform",
    document: "Purchase",
    body: `
      <h1>VideoFX automator Platform</h1>
      <p class="price">${price}</p>
      <p>One computer. The activation key cannot be shared.</p>
      <p class="note">${test ? "Test charge. The real price stays $50." : "Pay with card. The next page shows your code. Take a photo or a screenshot so you can save it."}</p>
      ${canceled ? `<p class="error">Payment was canceled. Nothing was charged.</p>` : ""}
      <p class="error" id="error" hidden></p>
      <button id="pay" type="button">Pay ${price}</button>
      <script>
        document.querySelector("#pay").addEventListener("click", async () => {
          const button = document.querySelector("#pay");
          const error = document.querySelector("#error");
          button.disabled = true;
          error.hidden = true;
          const response = await fetch(${JSON.stringify(endpoint)}, { method: "POST" });
          const body = await response.json();
          if (!body.url) {
            error.textContent = body.error || "The payment page could not be opened.";
            error.hidden = false;
            button.disabled = false;
            return;
          }
          location.href = body.url;
        });
      </script>`,
  });
}

function successPage(record, preview) {
  return page({
    title: "Your activation code — The Creative Place LLC",
    document: preview ? "Sample license" : "License",
    body: `
      <p class="status">${preview ? "Sample document" : "Payment confirmed"}</p>
      <h1>Your activation code</h1>
      <p class="lead">Issued by The Creative Place LLC for VideoFX automator Platform. Keep this page with your records.</p>
      <div class="code-card">
        <p class="code-label">Activation code</p>
        <p class="key">${escapeHtml(record.key)}</p>
      </div>
      <h2 class="download-title">Download the app</h2>
      <p>Install it on the Mac or Windows computer that will use this code. Google Chrome needs to be on that computer. The first time you open the app, leave its window open while it finishes setup.</p>
      <div class="downloads">
        <a href="/download/mac">Download for Mac</a>
        <a href="/download/windows">Download for Windows</a>
      </div>
      <ol class="steps">
        <li><span>1</span><div><strong>Save this code.</strong> Take a photo or a screenshot before you leave this page.</div></li>
        <li><span>2</span><div><strong>Open the app on one computer.</strong> On a Mac, unzip and open Start VideoFX. If macOS blocks it, right-click that file and choose Open. On Windows, unzip and open Start VideoFX. Then paste this code into Activation.</div></li>
        <li><span>3</span><div><strong>Moving computers.</strong> Free the code first at <a href="/move">Move to another computer</a>, then activate the next one.</div></li>
      </ol>
      ${preview ? `<p class="note">This sample code does not activate a computer.</p>` : ""}`,
  });
}

function movePage(notice) {
  return page({
    title: "Move to another computer",
    document: "Transfer",
    body: `
      <h1>Move to another computer</h1>
      <p>Paste the code from the computer you are leaving. That frees it for the next computer.</p>
      ${notice ? `<p class="save">${escapeHtml(notice)}</p>` : ""}
      <p class="error" id="error" hidden></p>
      <label for="code">Code</label>
      <input id="code" autocomplete="off" spellcheck="false">
      <button id="free" type="button">Free this code</button>
      <script>
        document.querySelector("#free").addEventListener("click", async () => {
          const button = document.querySelector("#free");
          const error = document.querySelector("#error");
          button.disabled = true;
          error.hidden = true;
          const response = await fetch("/api/v1/licenses/release", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ key: document.querySelector("#code").value }),
          });
          const body = await response.json();
          button.disabled = false;
          if (!body.ok) {
            error.textContent = body.error || "This code could not be freed.";
            error.hidden = false;
            return;
          }
          location.href = "/move?freed=1";
        });
      </script>`,
  });
}

function adminActions(item) {
  const key = escapeHtml(item.key);
  const free = item.active
    ? `<form class="inline" method="post" action="/admin/release"><input type="hidden" name="key" value="${key}"><button class="small quiet" type="submit">Free computer</button></form>`
    : "";
  const power = item.disabled
    ? `<form class="inline" method="post" action="/admin/on"><input type="hidden" name="key" value="${key}"><button class="small" type="submit">Turn on</button></form>`
    : `<form class="inline" method="post" action="/admin/off"><input type="hidden" name="key" value="${key}"><button class="small quiet" type="submit">Turn off</button></form>`;
  return `${free} ${power}`;
}

function adminPage(licenses, notice) {
  const rows = licenses.length
    ? licenses.map((item) => `<tr>
        <td>${escapeHtml(item.email || "No email")}</td>
        <td style="font:700 14px ui-monospace,Menlo,monospace;">${escapeHtml(item.key)}</td>
        <td>${item.disabled ? "Off" : item.active ? escapeHtml(item.deviceLabel || "In use") : "Available"}</td>
        <td>${escapeHtml(String(item.createdAt || "").slice(0, 10))}</td>
        <td>${adminActions(item)}</td>
      </tr>`).join("")
    : `<tr><td colspan="5">No buyers yet.</td></tr>`;
  return page({
    title: "Buyers",
    wide: true,
    document: "Buyers",
    body: `
      <h1>Buyers</h1>
      <p class="note">Create a code, free it for another computer, or turn it off.</p>
      ${notice ? `<p class="save">${escapeHtml(notice)}</p>` : ""}
      <form class="create-row" method="post" action="/admin/create">
        <div>
          <label for="email">Email</label>
          <input id="email" name="email" type="email" autocomplete="off" placeholder="buyer@email.com">
        </div>
        <button class="small" type="submit">Create code</button>
      </form>
      <table>
        <thead><tr><th>Email</th><th>Code</th><th>Computer</th><th>Bought</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`,
  });
}

function adminSign() {
  const password = process.env.ADMIN_PASSWORD || "";
  if (!password) return "";
  return crypto.createHmac("sha256", password).update("videofx-admin").digest("hex");
}

function adminAuthed(request) {
  const password = process.env.ADMIN_PASSWORD || "";
  const host = String(request.headers.host || "");
  const local = host.startsWith("127.0.0.1") || host.startsWith("localhost") || host.startsWith("[::1]");
  if (!password) return local;
  const cookie = String(request.headers.cookie || "");
  const match = cookie.match(/(?:^|;\s*)videofx_admin=([^;]+)/);
  if (!match) return false;
  const given = Buffer.from(decodeURIComponent(match[1]));
  const expected = Buffer.from(adminSign());
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

function loginPage(failed) {
  return page({
    title: "Buyers — The Creative Place LLC",
    document: "Buyers",
    body: `
      <h1>Buyers</h1>
      <p class="lead">Sign in to see activation codes.</p>
      ${failed ? `<p class="error">That password is wrong.</p>` : ""}
      <form method="post" action="/admin/login">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="current-password">
        <button type="submit">Sign in</button>
      </form>`,
  });
}

function messagePage(title, text) {
  return page({ title, body: `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p><p><a href="/">Back</a></p>` });
}

function sendHtml(response, status, html, headers = {}) {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(html);
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function readRaw(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function requestOrigin(request) {
  const hostHeader = String(request.headers["x-forwarded-host"] || request.headers.host || `127.0.0.1:${port}`);
  const proto = String(request.headers["x-forwarded-proto"] || "http");
  return `${proto}://${hostHeader.split(",")[0].trim()}`;
}

function buyerEmail(session) {
  return String(session.customer_details?.email || session.customer_email || session.metadata?.email || "").trim().toLowerCase();
}

async function createCheckout(request) {
  const origin = requestOrigin(request);
  const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
  const test = requestUrl.searchParams.get("test") === "1";
  const params = {
    mode: "payment",
    customer_creation: "always",
    integration_identifier: INTEGRATION,
    metadata: { product: "videofx_automator", test: test ? "1" : "0" },
    line_items: [{
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: test ? 100 : 5000,
        product_data: {
          name: "VideoFX automator Platform",
          description: test
            ? "Test purchase from The Creative Place LLC. One computer."
            : "Sold by The Creative Place LLC. One computer. The activation code cannot be shared.",
        },
      },
    }],
    success_url: `${origin}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}${test ? "/test" : "/"}?canceled=1`,
    payment_intent_data: { statement_descriptor_suffix: "VIDEO FX" },
  };
  const stripe = stripeClient();
  const create = (body) => stripe
    ? stripe.checkout.sessions.create(body)
    : stripeCli("post", "/v1/checkout/sessions", body);
  try {
    return await create(params);
  } catch (error) {
    if (!/statement descriptor|integration_identifier/i.test(publicError(error))) throw error;
    delete params.payment_intent_data;
    delete params.integration_identifier;
    return create(params);
  }
}

async function loadSession(sessionId) {
  const stripe = stripeClient();
  if (stripe) return stripe.checkout.sessions.retrieve(sessionId);
  return stripeCli("get", `/v1/checkout/sessions/${sessionId}`);
}

async function fulfillSession(session) {
  if (!session || (session.payment_status !== "paid" && session.payment_status !== "no_payment_required")) return null;
  return store.issueLicense({ sessionId: session.id, email: buyerEmail(session) });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  try {
    if (url.pathname === "/" && request.method === "GET") {
      return sendHtml(response, 200, homePage(url.searchParams.get("canceled") === "1", false));
    }
    if (url.pathname === "/test" && request.method === "GET") {
      if (process.env.CHECKOUT_PUBLIC === "1") return sendHtml(response, 404, messagePage("Not available", "The test price is turned off on this site."));
      return sendHtml(response, 200, homePage(url.searchParams.get("canceled") === "1", true));
    }
    if (url.pathname === "/preview" && request.method === "GET") {
      return sendHtml(response, 200, successPage({ key: "VFX-TEST-0000-0000-0000" }, true));
    }
    if (url.pathname === "/move" && request.method === "GET") {
      const notice = url.searchParams.get("freed") === "1" ? "This code can be used on another computer." : "";
      return sendHtml(response, 200, movePage(notice));
    }
    if (url.pathname === "/admin" && request.method === "GET") {
      if (!adminAuthed(request)) return sendHtml(response, 200, loginPage(false));
      return sendHtml(response, 200, adminPage(await store.list(), url.searchParams.get("notice") || ""));
    }
    if (request.method === "POST" && ["/admin/create", "/admin/release", "/admin/off", "/admin/on"].includes(url.pathname)) {
      if (!adminAuthed(request)) return sendHtml(response, 401, loginPage(true));
      const body = new URLSearchParams((await readRaw(request)).toString("utf8"));
      let result;
      if (url.pathname === "/admin/create") {
        const record = await store.createCode({ email: body.get("email") || "" });
        result = { message: `Created ${record.key}` };
      } else if (url.pathname === "/admin/release") {
        result = await store.release({ key: body.get("key") });
      } else {
        result = await store.setDisabled({ key: body.get("key"), disabled: url.pathname === "/admin/off" });
      }
      const notice = result.message || result.error || "Saved.";
      return sendHtml(response, 303, "", { location: `/admin?notice=${encodeURIComponent(notice)}` });
    }
    if (url.pathname === "/admin/login" && request.method === "POST") {
      const body = new URLSearchParams((await readRaw(request)).toString("utf8"));
      const password = process.env.ADMIN_PASSWORD || "";
      const given = body.get("password") || "";
      const same = password && given.length === password.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(password));
      if (!same) return sendHtml(response, 401, loginPage(true));
      const secure = String(request.headers["x-forwarded-proto"] || "").includes("https") ? "; Secure" : "";
      return sendHtml(response, 303, "", {
        location: "/admin",
        "set-cookie": `videofx_admin=${adminSign()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=1209600${secure}`,
      });
    }
    if (url.pathname === "/success" && request.method === "GET") {
      const sessionId = url.searchParams.get("session_id") || "";
      if (!sessionId.startsWith("cs_")) return sendHtml(response, 400, messagePage("No payment", "That payment could not be opened."));
      const session = await loadSession(sessionId);
      const record = await fulfillSession(session);
      if (!record) return sendHtml(response, 402, messagePage("Payment not finished", "The card has not cleared yet. Come back to this page when it does."));
      return sendHtml(response, 200, successPage(record));
    }
    if (url.pathname === "/api/checkout" && request.method === "POST") {
      const checkout = await createCheckout(request);
      return sendJson(response, 200, { url: checkout.url });
    }
    if (url.pathname === "/api/webhooks/stripe" && request.method === "POST") {
      const stripe = stripeClient();
      const secret = process.env.STRIPE_WEBHOOK_SECRET;
      if (!stripe || !secret) return sendJson(response, 503, { error: "Card payments are not connected yet." });
      let event;
      try {
        event = stripe.webhooks.constructEvent(await readRaw(request), request.headers["stripe-signature"], secret);
      } catch {
        return sendJson(response, 400, { error: "The payment notice could not be verified." });
      }
      if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
        await fulfillSession(event.data.object);
      }
      return sendJson(response, 200, { received: true });
    }
    if (url.pathname === "/api/v1/licenses/release" && request.method === "POST") {
      const body = JSON.parse((await readRaw(request)).toString("utf8") || "{}");
      const result = await store.release({ key: body.licenseKey || body.key });
      return sendJson(response, result.ok ? 200 : result.status, result);
    }
    if (url.pathname === "/api/v1/licenses/status" && request.method === "POST") {
      const body = JSON.parse((await readRaw(request)).toString("utf8") || "{}");
      return sendJson(response, 200, await store.holds({ key: body.licenseKey || body.key, machineIdHash: body.machineIdHash }));
    }
    if (url.pathname === "/api/v1/licenses/activate" && request.method === "POST") {
      const body = JSON.parse((await readRaw(request)).toString("utf8") || "{}");
      const result = await store.activate({
        key: body.licenseKey || body.key,
        machineIdHash: body.machineIdHash,
        deviceLabel: body.deviceLabel,
      });
      return sendJson(response, result.ok ? 200 : result.status, result);
    }
    if (url.pathname === "/download/mac" || url.pathname === "/download/windows") {
      const fileName = url.pathname.endsWith("/mac") ? "VideoFX-Mac.zip" : "VideoFX-Windows.zip";
      if (!fs.existsSync(downloadZipPath)) buildDownloads();
      if (!fs.existsSync(downloadZipPath)) return sendHtml(response, 404, messagePage("Download unavailable", "The app download is not ready yet."));
      response.writeHead(200, {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${fileName}"`,
        "cache-control": "no-store",
      });
      fs.createReadStream(downloadZipPath).pipe(response);
      return;
    }
    if (url.pathname === "/health") return sendJson(response, 200, { ok: true });
    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    sendJson(response, error.statusCode || 500, { error: publicError(error) });
  }
});

buildDownloads();

server.listen(port, host, () => {
  console.log(`VideoFX automator checkout: http://${host}:${port}`);
});
