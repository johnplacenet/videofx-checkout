const NOTIFY_TO = "johnplacenet@gmail.com";
const DEFAULT_FROM = "VideoFX automator <onboarding@resend.dev>";

function money(session) {
  const cents = Number(session?.amount_total);
  if (!Number.isFinite(cents)) return "";
  const currency = String(session?.currency || "usd").toUpperCase();
  return `${currency} ${(cents / 100).toFixed(2)}`;
}

export function purchaseNotice(session, record) {
  const buyer = String(record?.email || session?.customer_details?.email || session?.customer_email || "No email").trim() || "No email";
  const amount = money(session);
  const test = session?.metadata?.test === "1";
  const lines = [
    "Someone purchased VideoFX automator.",
    "",
    `Buyer: ${buyer}`,
    amount ? `Amount: ${amount}` : "",
    record?.key ? `Activation key: ${record.key}` : "",
    "",
    "Every code is on the admin page:",
    "https://videofx.thecre8iveplace.com/admin",
  ].filter((line) => line !== "");
  return {
    to: String(process.env.ORDER_NOTIFY_EMAIL || NOTIFY_TO).trim() || NOTIFY_TO,
    subject: `${test ? "TEST " : ""}VideoFX purchase: ${buyer}`,
    text: `${lines.join("\n")}\n`,
  };
}

export async function sendPurchaseNotice(session, record, fetchImpl = fetch) {
  const notice = purchaseNotice(session, record);
  const key = String(process.env.RESEND_API_KEY || "").trim();
  if (!key || !notice.to.includes("@")) return { sent: false, reason: "not_configured" };
  const from = String(process.env.RESEND_FROM_EMAIL || "").trim() || DEFAULT_FROM;
  const response = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "user-agent": "videofx-checkout",
    },
    body: JSON.stringify({
      from,
      to: [notice.to],
      subject: notice.subject,
      text: notice.text,
    }),
  });
  if (!response.ok) return { sent: false, reason: "rejected" };
  return { sent: true };
}
