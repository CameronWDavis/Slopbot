// Money as an ISO 4217 currency and an integer amount of minor units (cents), never a float.
// Parsing follows the currency's own conventions (€1.234,56 / $1,234.56) and refuses anything
// ambiguous rather than guessing: a wrong guess here could mean buying at 1000× the price.

export interface Money {
  /** Integer minor units: cents for USD/EUR, yen for JPY. */
  minor: number;
  /** ISO 4217 code, e.g. "USD". */
  currency: string;
}

const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "HUF", "TWD"]);
export const decimalsOf = (currency: string) => (ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2);

/** Which character each currency normally uses as its decimal separator. */
const COMMA_DECIMAL = new Set(["EUR", "BRL", "ARS", "COP", "DKK", "NOK", "SEK", "PLN", "CZK", "TRY", "IDR", "RUB", "UAH", "RON", "HUF", "CLP", "VND", "ZAR"]);
const decimalSepOf = (currency: string) => (COMMA_DECIMAL.has(currency.toUpperCase()) ? "," : ".");

const SYMBOLS: [RegExp, string | "$"][] = [
  [/US\$|USD/i, "USD"],
  [/C\$|CA\$|CAD/i, "CAD"],
  [/A\$|AU\$|AUD/i, "AUD"],
  [/NZ\$|NZD/i, "NZD"],
  [/HK\$|HKD/i, "HKD"],
  [/S\$|SGD/i, "SGD"],
  [/R\$|BRL/i, "BRL"],
  [/€|EUR/i, "EUR"],
  [/£|GBP/i, "GBP"],
  [/₹|INR/i, "INR"],
  [/₩|KRW/i, "KRW"],
  [/CHF/i, "CHF"],
  [/JPY|円/i, "JPY"],
  [/CNY|RMB/i, "CNY"],
  [/SEK/i, "SEK"],
  [/NOK/i, "NOK"],
  [/DKK/i, "DKK"],
  [/PLN|zł/i, "PLN"],
  [/MXN/i, "MXN"],
  [/\$/, "$"], // a bare $ means the watch's dollar currency (USD by default)
  [/¥/, "¥"],
];
const DOLLARS = new Set(["USD", "CAD", "AUD", "NZD", "HKD", "SGD", "MXN"]);

export class MoneyError extends Error {}

/**
 * Parse an amount like "€1.234,56", "$1,299.99", "1 299,00 €", "¥12,800" or "549.99" (with a known
 * currency). `expected` is the currency the caller is working in: a bare "$"/"¥" resolves to it,
 * a number with no symbol uses it, and a price in a different currency is an error.
 */
export function parseMoney(text: string, expected?: string): Money {
  const raw = String(text ?? "").trim();
  if (!raw) throw new MoneyError("no amount");
  let currency: string | undefined;
  for (const [re, code] of SYMBOLS) {
    if (!re.test(raw)) continue;
    if (code === "$") currency = expected && DOLLARS.has(expected.toUpperCase()) ? expected.toUpperCase() : "USD";
    else if (code === "¥") currency = expected && ["JPY", "CNY"].includes(expected.toUpperCase()) ? expected.toUpperCase() : "JPY";
    else currency = code;
    break;
  }
  currency ??= expected?.toUpperCase();
  if (!currency) throw new MoneyError(`"${raw}" has no currency`);
  if (expected && currency !== expected.toUpperCase()) throw new MoneyError(`price is in ${currency}, not ${expected.toUpperCase()}`);

  const nums = raw.match(/\d[\d.,'\s  ]*\d|\d/g);
  if (!nums || nums.length !== 1) throw new MoneyError(`"${raw}" isn't a single amount`);
  // Spaces and apostrophes are only ever thousands separators.
  let n = nums[0].replace(/[\s  ']/g, "");
  const decimals = decimalsOf(currency);
  const lastDot = n.lastIndexOf(".");
  const lastComma = n.lastIndexOf(",");
  let intPart = n;
  let frac = "";
  const groupsOk = (s: string, sep: string) => s.split(sep).every((g, i) => (i === 0 ? /^\d{1,3}$/.test(g) : /^\d{3}$/.test(g)));
  if (lastDot >= 0 && lastComma >= 0) {
    // Both used: whichever comes last is the decimal separator.
    const dec = lastDot > lastComma ? "." : ",";
    const thou = dec === "." ? "," : ".";
    intPart = n.slice(0, n.lastIndexOf(dec));
    frac = n.slice(n.lastIndexOf(dec) + 1);
    if (!groupsOk(intPart, thou) || intPart.includes(dec)) throw new MoneyError(`"${raw}" has mixed separators`);
    intPart = intPart.split(thou).join("");
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? "." : ",";
    const parts = n.split(sep);
    const tail = parts[parts.length - 1];
    if (parts.length > 2) {
      if (!groupsOk(n, sep)) throw new MoneyError(`"${raw}" isn't a valid amount`);
      intPart = parts.join("");
    } else if (tail.length === 3 && sep !== decimalSepOf(currency)) {
      // "1,234" in USD or "1.234" in EUR: that currency's thousands separator.
      if (!groupsOk(n, sep)) throw new MoneyError(`"${raw}" isn't a valid amount`);
      intPart = parts.join("");
    } else if (sep === decimalSepOf(currency) && tail.length >= 1 && tail.length <= decimals) {
      intPart = parts[0];
      frac = tail;
    } else {
      throw new MoneyError(`"${raw}" is ambiguous for ${currency}`);
    }
  }
  if (!/^\d+$/.test(intPart) || (frac && !/^\d+$/.test(frac))) throw new MoneyError(`"${raw}" isn't a valid amount`);
  if (frac.length > decimals) throw new MoneyError(`"${raw}" has more decimals than ${currency} uses`);
  const minor = Number(intPart) * 10 ** decimals + Number(frac.padEnd(decimals, "0") || 0);
  if (!Number.isSafeInteger(minor) || minor <= 0) throw new MoneyError(`"${raw}" isn't a usable price`); // $0 is never a real price
  return { minor, currency };
}

/** parseMoney that returns undefined instead of throwing. */
export function tryMoney(text: string, expected?: string): Money | undefined {
  try {
    return parseMoney(text, expected);
  } catch {
    return undefined;
  }
}

/** A machine value like schema.org's price "1299.99" (always "." decimal) in a known currency. */
export function moneyFromDecimal(value: unknown, currency: string): Money | undefined {
  const s = typeof value === "number" ? String(value) : String(value ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return undefined;
  const d = decimalsOf(currency);
  const [i, f = ""] = s.split(".");
  if (f.replace(/0+$/, "").length > d) return undefined;
  const minor = Number(i) * 10 ** d + Number(f.padEnd(d, "0").slice(0, d) || 0);
  return minor > 0 && Number.isSafeInteger(minor) ? { minor, currency: currency.toUpperCase() } : undefined;
}

export function fromMajor(amount: number, currency: string): Money {
  return { minor: Math.round(amount * 10 ** decimalsOf(currency)), currency: currency.toUpperCase() };
}

export function formatMoney(m?: Money): string {
  if (!m) return "—";
  const d = decimalsOf(m.currency);
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: m.currency, minimumFractionDigits: d, maximumFractionDigits: d }).format(m.minor / 10 ** d);
  } catch {
    return `${m.currency} ${(m.minor / 10 ** d).toFixed(d)}`;
  }
}

/** Apply a percentage allowance (tax + shipping) in integer math, rounding up to the next minor unit. */
export function withAllowance(m: Money, percent: number): Money {
  return { minor: Math.ceil((m.minor * (100 + percent)) / 100), currency: m.currency };
}
