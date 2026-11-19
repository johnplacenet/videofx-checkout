const NOTIFY_TO = "johnplacenet@gmail.com";
const DEFAULT_FROM = "VideoFX automator <onboarding@resend.dev>";

function money(session) {
  const cents = Number(session?.amount_total);
  if (!Number.isFinite(cents)) return "";
  const currency = String(session?.currency || "usd").toUpperCase();
  return `${currency} ${(cents / 100).toFixed(2)}`;
}

function buyerEmail(session, record) {
  return String(record?.email || session?.customer_details?.email || session?.customer_email || "").trim();
}

function buyerName(session) {
  return String(session?.customer_details?.name || session?.customer_details?.business_name || "").trim();
}

function formatAddress(address) {
  if (!address) return "";
  const cityState = [address.city, address.state].filter(Boolean).join(", ");
  const locality = [cityState, address.postal_code].filter(Boolean).join(" ");
  return [address.line1, address.line2, locality, address.country].filter(Boolean).join(", ");
}

function paymentLabel(session) {
  const method = session?.payment_method;
  if (!method || typeof method !== "object") return "";
  const card = method.card || method.payment_method_details?.card;
  if (method.type === "card" || card?.last4 || card?.brand) {
    const brand = card?.brand ? `${card.brand.charAt(0).toUpperCase()}${card.brand.slice(1)}` : "Card";
    return card?.last4 ? `${brand} ending ${card.last4}` : brand;
  }
  if (method.type === "link") return "Link";
  if (method.type) return method.type.replaceAll("_", " ");
  return "";
}

function paidAt(session) {
  const created = Number(session?.created);
  if (!Number.isFinite(created) || created <= 0) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(created * 1000));
}

export function purchaseNotice(session, record) {
  const email = buyerEmail(session, record) || "No email";
  const name = buyerName(session);
  const phone = String(session?.customer_details?.phone || "").trim();
  const address = formatAddress(session?.customer_details?.address);
  const paid = paymentLabel(session);
  const when = paidAt(session);
  const amount = money(session);
  const test = session?.metadata?.test === "1";
  const who = name || email;
  const lines = [
    "Someone purchased VideoFX automator.",
    "",
    name ? `Name: ${name}` : "",
    `Email: ${email}`,
    phone ? `Phone: ${phone}` : "",
    address ? `Address: ${address}` : "",
    paid ? `Paid with: ${paid}` : "",
    when ? `When: ${when} ET` : "",
    amount ? `Amount: ${amount}` : "",
    record?.key ? `Activation key: ${record.key}` : "",
    "",
    "Every code is on the admin page:",
    "https://videofx.thecre8iveplace.com/admin",
  ].filter((line) => line !== "");
  return {
    to: String(process.env.ORDER_NOTIFY_EMAIL || NOTIFY_TO).trim() || NOTIFY_TO,
    subject: `${test ? "TEST " : ""}VideoFX purchase: ${who}`,
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
