import assert from "node:assert/strict";
import test from "node:test";
import { purchaseNotice, sendPurchaseNotice } from "./mail.js";

test("purchase notice names the buyer, the amount, and the key", () => {
  const notice = purchaseNotice(
    { amount_total: 6900, currency: "usd", metadata: { test: "0" } },
    { email: "buyer@example.com", key: "VFX-TEST-0000-0000-0000" },
  );
  assert.equal(notice.to, "johnplacenet@gmail.com");
  assert.equal(notice.subject, "VideoFX purchase: buyer@example.com");
  assert.match(notice.text, /Buyer: buyer@example.com/);
  assert.match(notice.text, /USD 69\.00/);
  assert.match(notice.text, /VFX-TEST-0000-0000-0000/);
  assert.match(notice.text, /https:\/\/videofx\.thecre8iveplace\.com\/admin/);
});

test("a test charge is labeled TEST", () => {
  const notice = purchaseNotice(
    { amount_total: 100, currency: "usd", metadata: { test: "1" } },
    { email: "buyer@example.com", key: "VFX-TEST-0000-0000-0000" },
  );
  assert.equal(notice.subject, "TEST VideoFX purchase: buyer@example.com");
});

test("send skips when mail is not configured", async () => {
  const previous = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  const result = await sendPurchaseNotice({ amount_total: 6900, currency: "usd" }, { email: "buyer@example.com", key: "VFX-TEST-0000-0000-0000" }, async () => {
    throw new Error("should not send");
  });
  if (previous == null) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = previous;
  assert.deepEqual(result, { sent: false, reason: "not_configured" });
});
