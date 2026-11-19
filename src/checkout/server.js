import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";
import { buildDownloads, downloadZipPath } from "../../scripts/build-downloads.js";
import { sendPurchaseNotice } from "./mail.js";
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
    .indie { max-width: ${width}; margin: -28px auto 36px; padding: 0 8px; color: #5c6b7a; font-size: 13px; }
    h2.download-title { margin: 0 0 8px; font-size: 22px; }
    .downloads { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 0 0 18px; }
    .downloads a { display: block; text-align: center; text-decoration: none; background: #10233f; color: #fff; font-weight: 700; padding: 14px 12px; }
    .machine { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin: 0 0 16px; }
    .machine img { width: 100%; height: 230px; object-fit: contain; background: #f7f8fa; border: 1px solid #e1e6ee; }
    .only { margin: 0 0 16px; padding: 12px 14px; background: #f7f5f0; border-left: 4px solid #b0893e; }
    .only strong { display: block; }
    .app-shot { margin: 0 0 18px; }
    .app-shot img { width: 100%; height: auto; display: block; border: 1px solid #e1e6ee; }
    .app-shot p { margin: 8px 0 0; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid #e7ebf0; vertical-align: top; }
    th { font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: #5c6b7a; }
    @media (max-width: 680px) {
      .letterhead-inner { align-items: flex-start; flex-direction: column; }
      main { margin-left: 12px; margin-right: 12px; padding: 24px 18px 20px; }
      .key { font-size: 18px; }
      .downloads, .machine { grid-template-columns: 1fr; }
      .machine img { height: auto; }
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
  <p class="indie">VideoFX automator is an independent project. It is not affiliated with GetGlamBot or Snappic. Questions, suggestions, or bugs: <a href="mailto:johnplacenet@gmail.com">johnplacenet@gmail.com</a></p>
</body>
</html>`;
}

function homePage(canceled, test) {
  const price = test ? "$1" : "$69";
  const endpoint = test ? "/api/checkout?test=1" : "/api/checkout";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>VideoFX automator Platform</title>
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="The Creative Place LLC">
  <meta property="og:url" content="https://videofx.thecre8iveplace.com/">
  <meta property="og:title" content="VideoFX automator — Update all 18 templates at once">
  <meta property="og:description" content="Upload the overlay, soundtrack, or start and end video once. It changes all 18 GetGlamBot templates. $69. One computer.">
  <meta property="og:image" content="https://videofx.thecre8iveplace.com/photos/videofx-share.jpg">
  <meta property="og:image:secure_url" content="https://videofx.thecre8iveplace.com/photos/videofx-share.jpg">
  <meta property="og:image:type" content="image/jpeg">
  <meta property="og:image:width" content="1024">
  <meta property="og:image:height" content="535">
  <meta property="og:image:alt" content="VideoFX automator. Update all 18 templates at once. $69.">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="VideoFX automator — Update all 18 templates at once">
  <meta name="twitter:description" content="Upload the overlay, soundtrack, or start and end video once. It changes all 18 GetGlamBot templates. $69. One computer.">
  <meta name="twitter:image" content="https://videofx.thecre8iveplace.com/photos/videofx-share.jpg">
  <style>
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body { margin: 0; font: 16px/1.55 "Avenir Next", "Segoe UI", "Helvetica Neue", Arial, sans-serif; color: #142033; background: #f7f4ee; }
    a { color: inherit; }
    img { max-width: 100%; }
    .wrap { width: min(1120px, calc(100% - 40px)); margin: 0 auto; }
    .top { position: sticky; top: 0; z-index: 5; background: #0e1c33; color: #fff; }
    .top-inner { display: flex; align-items: center; gap: 22px; min-height: 74px; }
    .brand { text-decoration: none; font-size: 11px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; }
    .brand span { display: block; margin-top: 3px; font-size: 15px; font-weight: 600; letter-spacing: 0; text-transform: none; color: #f4efe4; }
    nav { display: flex; gap: 18px; margin-left: auto; font-size: 14px; }
    nav a { color: #f4efe4; text-decoration: none; }
    .buy { text-decoration: none; background: #c6a15b; color: #142033; font-weight: 700; padding: 10px 16px; border-radius: 999px; }
    .hero { background: linear-gradient(180deg, #0e1c33 0%, #16304f 100%); color: #fff; padding: 54px 0 64px; }
    .hero-grid { display: grid; grid-template-columns: 1.05fr 0.95fr; gap: 36px; align-items: center; }
    h1 { margin: 0 0 14px; font-size: 46px; line-height: 1.08; letter-spacing: -0.03em; }
    .hero p { margin: 0 0 22px; color: #e7e1d4; font-size: 18px; }
    .hero a { color: #e8d7b0; }
    .hero-actions { display: flex; flex-wrap: wrap; gap: 12px; }
    button.pay, a.ghost { display: inline-flex; align-items: center; justify-content: center; min-height: 48px; padding: 12px 18px; border-radius: 8px; font: 700 16px "Avenir Next", "Segoe UI", sans-serif; text-decoration: none; cursor: pointer; }
    button.pay { border: 0; background: #c6a15b; color: #142033; }
    button.pay.wide { width: 100%; }
    button.pay:disabled { opacity: 0.65; cursor: wait; }
    a.ghost { border: 1px solid #d9c79a; color: #fff; }
    .photos { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .photos img { width: 100%; height: 280px; object-fit: contain; background: #fff; border-radius: 8px; }
    section { padding: 64px 0; scroll-margin-top: 86px; }
    h2 { margin: 0 0 8px; font-size: 34px; letter-spacing: -0.02em; text-align: center; }
    .rule { width: 72px; height: 3px; margin: 0 auto 28px; background: #c6a15b; }
    .reasons, .cards, .worth { display: grid; gap: 14px; }
    .reasons { grid-template-columns: repeat(5, 1fr); }
    .cards { grid-template-columns: repeat(3, 1fr); }
    .worth { grid-template-columns: repeat(3, 1fr); }
    .card, .worth article, .price-card, details { background: #fff; border: 1px solid #e7e1d6; border-radius: 12px; }
    .card, .worth article { padding: 18px 16px 16px; }
    .card h3, .worth h3 { margin: 10px 0 6px; font-size: 17px; }
    .card p, .worth p, .step p { margin: 0; color: #4d5b6a; font-size: 14px; }
    .mark { width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; background: #f8f1e3; color: #9a7433; font-weight: 700; }
    .band { background: #fff; }
    .fine { margin: 18px 0 0; color: #5c6b7a; text-align: center; }
    .split { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; }
    .split h2, .purchase h2 { text-align: left; }
    .split .rule, .purchase .rule { margin-left: 0; }
    .only { padding: 16px 18px; background: #f8f1e3; border-left: 4px solid #c6a15b; border-radius: 8px; }
    .only strong { display: block; }
    .final { margin: 0 0 18px; padding: 14px 16px; background: #fbf6ee; border: 1px solid #e4d3a8; border-left: 4px solid #9a7433; color: #3d3424; font-size: 15px; }
    .final strong { display: block; color: #142033; }
    .steps { display: grid; gap: 16px; }
    .step { display: grid; grid-template-columns: 42px 1fr; gap: 12px; align-items: start; }
    .step .mark { background: #0e1c33; color: #f4efe4; }
    .app-shot { margin: 0; }
    .app-shot img { width: 100%; height: auto; display: block; border: 1px solid #e7e1d6; border-radius: 12px; background: #fff; }
    .app-shot figcaption { margin-top: 10px; color: #5c6b7a; text-align: center; }
    .purchase-grid { display: grid; grid-template-columns: 0.8fr 1.2fr; gap: 22px; align-items: start; }
    .price-card { padding: 22px; }
    .price { margin: 8px 0; font-size: 56px; font-weight: 700; letter-spacing: -0.04em; }
    .price-card p { margin: 0 0 14px; color: #4d5b6a; }
    details { padding: 0 16px; margin: 0 0 10px; }
    summary { cursor: pointer; padding: 14px 0; font-weight: 700; }
    details p { margin: 0 0 14px; color: #4d5b6a; }
    .error { color: #9b2c2c; }
    .foot { background: #0e1c33; color: #fff; padding: 28px 0; }
    .foot-inner { display: flex; justify-content: space-between; align-items: center; gap: 18px; }
    .foot p { margin: 0; }
    .foot strong { color: #e8d7b0; }
    .foot .indie { margin: 16px auto 0; color: #d7deea; font-size: 14px; }
    .foot .indie a { color: #e8d7b0; }
    @media (max-width: 980px) {
      h1 { font-size: 36px; }
      .reasons { grid-template-columns: 1fr 1fr; }
      .cards { grid-template-columns: 1fr 1fr; }
    }
    @media (max-width: 760px) {
      h1 { font-size: 32px; }
      nav { display: none; }
      .buy { margin-left: auto; }
      .hero-grid, .split, .purchase-grid, .reasons, .cards, .worth { grid-template-columns: 1fr; }
      .photos img { height: auto; }
      .foot-inner { align-items: flex-start; flex-direction: column; }
      h2, .split h2 { font-size: 28px; }
    }
  </style>
</head>
<body>
  <header class="top">
    <div class="wrap top-inner">
      <a class="brand" href="/">The Creative Place LLC<span>VideoFX automator Platform</span></a>
      <nav>
        <a href="#why">Why</a>
        <a href="#features">What it does</a>
        <a href="#how">How it works</a>
        <a href="#faq">FAQ</a>
        <a href="#purchase">Purchase</a>
      </nav>
      <a class="buy" href="#purchase">Buy now</a>
    </div>
  </header>
  <section class="hero">
    <div class="wrap hero-grid">
      <div>
        <h1>One small change means opening all 18 templates by hand.</h1>
        <p>A revised overlay. New music. A new start video. A new end video. Each time, you go into Paparazzi and Slo Mo Only, from 10 seconds down to 2, and make that same change again. Upload each file once. The app goes into every template and changes it for you.</p>
        <p>This is only for someone who already owns a GlamBot from <a href="https://getglambot.com">getglambot.com</a> and already has the Snappic templates designed for GetGlamBot.</p>
        <div class="hero-actions">
          <button class="pay" type="button">Get access for ${price}</button>
          <a class="ghost" href="#how">See how it works</a>
        </div>
      </div>
      <div class="photos">
        <img src="/photos/glambot-machine.png" alt="The GlamBot camera arm from GetGlamBot">
        <img src="/photos/glambot-in-use.png" alt="A person operating a GlamBot camera arm">
      </div>
    </div>
  </section>
  <section id="why">
    <div class="wrap">
      <h2>The tedious part</h2>
      <div class="rule"></div>
      <div class="reasons">
        <article class="card"><div class="mark">1</div><h3>One revision, 18 times</h3><p>Change the overlay and you still open every template. Same for a new soundtrack, a new start video, or a new end video.</p></article>
        <article class="card"><div class="mark">2</div><h3>The same clicks, again</h3><p>Paparazzi and Slo Mo Only, 10 seconds down to 2. A minor change is a long pass through all of them.</p></article>
        <article class="card"><div class="mark">3</div><h3>Upload each file once</h3><p>Choose the overlay, the music, the start video, and the end video. You do not open the templates yourself.</p></article>
        <article class="card"><div class="mark">4</div><h3>Every template is changed</h3><p>The app goes in and puts those files on each template you leave checked.</p></article>
        <article class="card"><div class="mark">5</div><h3>Only the things you changed</h3><p>Leave a box unchecked and that part stays as it is. A new song does not have to touch the overlay.</p></article>
      </div>
    </div>
  </section>
  <section id="features" class="band">
    <div class="wrap">
      <h2>What it updates</h2>
      <div class="rule"></div>
      <div class="cards">
        <article class="card"><div class="mark">1</div><h3>Each template opens for you</h3><p>It walks Paparazzi and Slo Mo Only, from 10 seconds through 2 seconds.</p></article>
        <article class="card"><div class="mark">2</div><h3>Overlay</h3><p>Your PNG, APNG, or MP4, under 30 MB, replaces the overlay on each checked template.</p></article>
        <article class="card"><div class="mark">3</div><h3>Overlay mask</h3><p>Turn this on only when you have a mask file. Otherwise that setting stays as it is.</p></article>
        <article class="card"><div class="mark">4</div><h3>Soundtrack and preview</h3><p>Add an MP3 or M4A soundtrack, or a short preview video, when you want those changed.</p></article>
        <article class="card"><div class="mark">5</div><h3>Resolution</h3><p>Square, landscape, or portrait, only if you check Resolution and pick a size. Leave it off and the size stays.</p></article>
        <article class="card"><div class="mark">6</div><h3>Timeline start and end</h3><p>If a template already has an uploaded video at the beginning, the end, or both, your file goes in that spot. Recorded clips stay. It does not create a new clip.</p></article>
      </div>
      <p class="fine">Anything you leave unchecked is left alone. This updates the video templates. Event details, options, sharing, effects, and the app experience stay in Snappic, where you set them.</p>
    </div>
  </section>
  <section id="how">
    <div class="wrap split">
      <div>
        <h2>Who it is for</h2>
        <div class="rule"></div>
        <p class="only"><strong>Only for a GetGlamBot owner.</strong> This is only for someone who owns a GlamBot from <a href="https://getglambot.com">getglambot.com</a> and already has the Snappic templates designed for GetGlamBot. The photos above are that machine.</p>
        <p>You sign in to Snappic yourself. The app never types your password. It then works on the event you point it at.</p>
      </div>
      <div>
        <h2>How it works</h2>
        <div class="rule"></div>
        <div class="steps">
          <div class="step"><div class="mark">1</div><p><strong>Open your event.</strong> Log in to Snappic, then use the event that is already open or type its ID.</p></div>
          <div class="step"><div class="mark">2</div><p><strong>Upload the files once.</strong> The revised overlay, the new soundtrack, the new start video, the new end video. One file for each thing that changed.</p></div>
          <div class="step"><div class="mark">3</div><p><strong>It changes every template.</strong> The app opens each one you left checked and makes those changes. When “Save changes” is on, it saves the list so the work stays on the event.</p></div>
        </div>
      </div>
    </div>
  </section>
  <section class="band">
    <div class="wrap">
      <h2>This is the app</h2>
      <div class="rule"></div>
      <figure class="app-shot">
        <img src="/photos/app.png" alt="The VideoFX automator, showing the template list, overlay, soundtrack, and timeline">
        <figcaption>You run this on the Mac or Windows computer at the booth. Google Chrome has to be on that computer. After you pay, the download is on the same page as your code.</figcaption>
      </figure>
    </div>
  </section>
  <section>
    <div class="wrap">
      <h2>Why it is worth ${price}</h2>
      <div class="rule"></div>
      <div class="worth">
        <article><div class="mark">1</div><h3>A small change stays small</h3><p>You upload the new file. You do not repeat that change across all 18 templates.</p></article>
        <article><div class="mark">2</div><h3>The same file everywhere</h3><p>The overlay, soundtrack, start video, or end video you uploaded is what goes on every checked template.</p></article>
        <article><div class="mark">3</div><h3>You can see a miss</h3><p>A failed template names the problem. You continue from a later number without starting over.</p></article>
      </div>
    </div>
  </section>
  <section id="purchase" class="band">
    <div class="wrap">
    <p class="final"><strong>All sales are final.</strong> This is digital media. Once you pay and receive your activation key, there are no refunds. Before you pay, make sure you have the correct GlamBot and the Snappic templates already supplied for GetGlamBot. If you do not have those, you will not get a refund.</p>
    <div class="purchase-grid">
      <div class="price-card">
        <h2>Get the VideoFX automator Platform</h2>
        <p class="price">${price}</p>
        <p>One computer. One-time purchase from The Creative Place LLC. The activation key cannot be shared. You can free it when you move to another computer.</p>
        <p>${test ? "Test charge. The real price stays $69." : "Pay with card. The next page shows your code. Take a photo or a screenshot so you can save it."}</p>
        ${canceled ? `<p class="error">Payment was canceled. Nothing was charged.</p>` : ""}
        <p class="error" id="error" hidden></p>
        <button class="pay wide" type="button">Pay ${price}</button>
      </div>
      <div id="faq">
        <h2>FAQ</h2>
        <div class="rule"></div>
        <details open>
          <summary>Are there refunds?</summary>
          <p>No. All sales are final. This is digital media. Once you pay and your activation key is shown, there are no refunds. Make sure you have the correct GlamBot and the templates already supplied for it before you pay. If you do not have those, you will not get a refund.</p>
        </details>
        <details>
          <summary>Do I need a GetGlamBot and the Snappic templates?</summary>
          <p>Yes. This is only for a GlamBot from getglambot.com, and only if you already have the Snappic templates designed for GetGlamBot. Without those, the app has nothing to update, and the sale is still final.</p>
        </details>
        <details>
          <summary>Is this a subscription?</summary>
          <p>No. It is a one-time ${test ? "$1 test charge. The real price stays $69." : "$69 purchase"}.</p>
        </details>
        <details>
          <summary>Can I use my own files?</summary>
          <p>Yes. Upload the overlay, the soundtrack, the start video, or the end video from your computer. The app puts each one on every template you leave checked.</p>
        </details>
        <details>
          <summary>Can I share the activation key?</summary>
          <p>No. One computer only. Free the code before you activate a different computer.</p>
        </details>
        <details>
          <summary>Does it run on Mac and Windows?</summary>
          <p>Yes. The Mac and Windows downloads are on the page with your code. That computer needs Google Chrome.</p>
        </details>
        <details>
          <summary>Is this part of GetGlamBot or Snappic?</summary>
          <p>No. VideoFX automator is an independent project. It is not affiliated with GetGlamBot or Snappic. Questions, suggestions, or bugs: <a href="mailto:johnplacenet@gmail.com">johnplacenet@gmail.com</a></p>
        </details>
        <details>
          <summary>Does it change the rest of the Snappic event?</summary>
          <p>No. It updates the video templates. Event details, options, sharing, effects, and the app experience stay as you set them.</p>
        </details>
      </div>
    </div>
    </div>
  </section>
  <footer class="foot">
    <div class="wrap foot-inner">
      <p><strong>Stop opening all 18 templates for one small change.</strong><br>Upload the files once. The app changes every template.</p>
      <button class="pay" type="button">Get access for ${price}</button>
    </div>
    <p class="indie wrap">VideoFX automator is an independent project. It is not affiliated with GetGlamBot or Snappic. Questions, suggestions, or bugs: <a href="mailto:johnplacenet@gmail.com">johnplacenet@gmail.com</a></p>
  </footer>
  <script>
    document.querySelectorAll(".pay").forEach((button) => {
      button.addEventListener("click", async () => {
        const buttons = document.querySelectorAll(".pay");
        const error = document.querySelector("#error");
        buttons.forEach((item) => { item.disabled = true; });
        error.hidden = true;
        const response = await fetch(${JSON.stringify(endpoint)}, { method: "POST" });
        const body = await response.json();
        if (!body.url) {
          error.textContent = body.error || "The payment page could not be opened.";
          error.hidden = false;
          buttons.forEach((item) => { item.disabled = false; });
          document.querySelector("#purchase").scrollIntoView();
          return;
        }
        location.href = body.url;
      });
    });
  </script>
</body>
</html>`;
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
        unit_amount: test ? 100 : 6900,
        product_data: {
          name: "VideoFX automator Platform",
          description: test
            ? "Test purchase from The Creative Place LLC. One computer."
            : "Upload the overlay, soundtrack, or start and end video once. It changes all 18 GetGlamBot templates. One computer. All sales are final. No refunds.",
        },
      },
    }],
    billing_address_collection: "required",
    phone_number_collection: { enabled: true },
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

async function withPaymentMethod(session) {
  const paymentIntentId = typeof session?.payment_intent === "string" ? session.payment_intent : session?.payment_intent?.id;
  const stripe = stripeClient();
  if (!paymentIntentId || !stripe || session?.payment_method?.type) return session;
  try {
    const intent = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["payment_method"] });
    if (!intent.payment_method || typeof intent.payment_method === "string") return session;
    return { ...session, payment_method: intent.payment_method };
  } catch (error) {
    console.error(`Purchase email could not load the payment method (${publicError(error)}).`);
    return session;
  }
}

async function fulfillSession(session) {
  if (!session || (session.payment_status !== "paid" && session.payment_status !== "no_payment_required")) return null;
  if (session.metadata?.product !== "videofx_automator") return null;
  const record = await store.issueLicense({ sessionId: session.id, email: buyerEmail(session) });
  if (record && await store.claimNotify(session.id)) {
    const result = await sendPurchaseNotice(await withPaymentMethod(session), record);
    if (!result.sent) {
      await store.releaseNotify(session.id);
      console.error(`Purchase email was not sent (${result.reason}).`);
    }
  }
  return record;
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
    const photo = {
      "/photos/glambot-machine.png": ["glambot-machine.png", "image/png"],
      "/photos/glambot-in-use.png": ["glambot-in-use.png", "image/png"],
      "/photos/app.png": ["app.png", "image/png"],
      "/photos/videofx-share.jpg": ["videofx-share.jpg", "image/jpeg"],
    }[url.pathname];
    if (photo && request.method === "GET") {
      const file = path.join(root, "public", "photos", photo[0]);
      if (!fs.existsSync(file)) return sendJson(response, 404, { error: "Not found" });
      response.writeHead(200, { "content-type": photo[1], "cache-control": "public, max-age=86400" });
      fs.createReadStream(file).pipe(response);
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
