import assert from "node:assert/strict";
import test from "node:test";
import { purchaseNotice, sendPurchaseNotice } from "./mail.js";

test("purchase notice names the buyer, the amount, and the key", () => {
  const notice = purchaseNotice(
    {
      amount_total: 6900,
      currency: "usd",
      created: 1795044870,
      metadata: { test: "0" },
      customer_details: {
        name: "Francesco Spagnoletti",
        email: "buyer@example.com",
        phone: "+1 555 0100",
        address: { line1: "1 Main St", city: "East Hanover", state: "NJ", postal_code: "07936", country: "US" },
      },
      payment_method: { type: "card", card: { brand: "visa", last4: "4242" } },
    },
    { email: "buyer@example.com", key: "VFX-TEST-0000-0000-0000" },
  );
  assert.equal(notice.to, "johnplacenet@gmail.com");
  assert.equal(notice.subject, "VideoFX purchase: Francesco Spagnoletti");
  assert.match(notice.text, /Name: Francesco Spagnoletti/);
  assert.match(notice.text, /Email: buyer@example.com/);
  assert.match(notice.text, /Phone: \+1 555 0100/);
  assert.match(notice.text, /Address: 1 Main St, East Hanover, NJ 07936, US/);
  assert.match(notice.text, /Paid with: Visa ending 4242/);
  assert.match(notice.text, /When: .+ ET/);
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
