// Keep personal details out of model calls, logs, saved conversations and Telegram messages.
// Checkout pages show your name, address, phone, email and card summary; the bot needs none of it.

const STREET = /\b\d{1,6}\s+(?:[A-Z0-9][\w'.-]*\s+){0,4}(?:st|street|ave|avenue|rd|road|blvd|boulevard|ln|lane|dr|drive|ct|court|way|pl|place|ter|terrace|pkwy|parkway|hwy|highway|cir|circle|sq|square|trl|trail)\b\.?(?:\s*(?:apt|unit|suite|ste|#)\s*[\w-]+)?/gi;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)\s?|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b/g;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;
const CARD_TAIL = /((?:ending|ends)\s+(?:in|with)\s*|[•*xX]{2,}\s*)\d{2,4}\b/gi;
const POSTAL = /\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b|\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b|\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/g;
const GREETING = /\b([Hh]ello|[Hh]i|[Hh]ey|[Ww]elcome(?: back)?|[Ss]igned in as|[Aa]ccount for|[Dd]eliver to|[Ss]hip to)[ \t]*,?[ \t]+([A-Z][a-z'-]+(?:[ \t]+[A-Z][a-z'-]+)?)/g;
const ADDRESS_HEADING = /^(ship(ping)? to|shipping address|deliver(y)? (to|address)|billing address|bill to|sold to|recipient|contact (info|information)|your (name|address))\b/i;

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

/** Replace personal details in free text. Prices, product names and order numbers are kept. */
export function redactPII(text: string): string {
  const lines = String(text ?? "").split("\n");
  const out: string[] = [];
  let skip = 0;
  for (const line of lines) {
    // The lines right after "Ship to" / "Billing address" are a name and an address.
    if (skip > 0 && line.trim() && !/[$€£¥]\s?\d|\d\s?[$€£¥]|total|subtotal|tax|shipping|qty|quantity/i.test(line)) {
      skip--;
      out.push("[personal details removed]");
      continue;
    }
    if (ADDRESS_HEADING.test(line.trim())) skip = 4;
    out.push(line);
  }
  return out
    .join("\n")
    .replace(EMAIL, "[email]")
    .replace(CARD, (m) => (luhn(m.replace(/\D/g, "")) ? "[card number]" : m))
    .replace(CARD_TAIL, "$1••••")
    .replace(PHONE, "[phone]")
    .replace(STREET, "[address]")
    .replace(POSTAL, "[postal code]")
    .replace(GREETING, (_m, g) => `${g} [name]`)
    .replace(/(\[personal details removed\]\n?){2,}/g, "[personal details removed]\n");
}

const SENSITIVE_PARAM = /^(utm_.*|ref|ref_|tag|token|access_token|auth|session|sessionid|sid|key|api_?key|sig|signature|email|e|uid|user|userid|customer|cid|clickid|gclid|fbclid|mc_eid|_hsenc|_hsmi)$/i;

/** A URL safe to show, log or send: no credentials, session ids, tracking or email parameters. */
export function sanitizeUrl(u: string): string {
  try {
    const url = new URL(u);
    url.username = "";
    url.password = "";
    for (const k of [...url.searchParams.keys()]) if (SENSITIVE_PARAM.test(k)) url.searchParams.delete(k);
    url.hash = "";
    return url.toString();
  } catch {
    return "";
  }
}

/** Origin + path only (for model context: query strings on checkout pages can carry session data). */
export function shortUrl(u: string): string {
  try {
    const url = new URL(u);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}
