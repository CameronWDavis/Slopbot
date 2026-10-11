// One purchase you approved, and the single place that authorizes anything that could submit an
// order. Button labels and URL patterns are NOT the boundary: outside an approved execution no
// click, typing or form submission happens at all, and inside one every action is checked against
// what code reads from the page (store, order total, currency, cart contents), fail-closed.
import { newId } from "../store/store.js";
import { siteOf } from "./site.js";
import { formatMoney, parseMoney, type Money } from "./money.js";
import { shortUrl } from "./pii.js";

export interface PageElement {
  n: number;
  role: string;
  text: string;
  type?: string;
  name?: string;
  disabled?: boolean;
}

export interface PageSnapshot {
  url: string;
  title: string;
  text: string;
  elements: PageElement[];
  /** Hints the browser gathered (e.g. a CAPTCHA frame, a one-time-code field). */
  signals?: string[];
}

export interface PageFacts {
  url: string;
  site: string;
  /** Looks like a cart, checkout or order review (fail-closed: any sign counts). */
  checkout: boolean;
  total?: Money;
  totalProblem?: string;
  /** Quantities shown on the page. */
  quantities: number[];
  /** "(2 items)" style counts. */
  itemCount?: number;
  /** The approved item's identifying phrases appear on the page. */
  itemMentioned: boolean;
  confirmation?: { orderId?: string };
  /** Something only the user can do: sign in, CAPTCHA, verification code, payment details. */
  humanStep?: string;
}

const CHECKOUT_SIGNS = /\b(order total|order summary|estimated total|est\. total|grand total|sub-?total|total due|amount due|estimated tax|sales tax|tax:|shipping & handling|shipping:|delivery:|payment method|pay with|place (your )?order|review (your )?order|checkout|check out|billing)\b/i;
const CHECKOUT_URL = /cart|basket|checkout|payment|order|purchase|buy/i;
const TOTAL_LINE = /^(?:.*\b)?(order total|grand total|estimated total|est\. total|total due|total to pay|amount due|total \(\d+ items?\)|you pay|total)\b/i;
const NOT_TOTAL = /sub-?total|savings|you save|before tax|items? total|total savings|total price per/i;
const MONEY_TOKEN = /(?:US\$|CA\$|C\$|A\$|AU\$|NZ\$|HK\$|S\$|R\$|\$|€|£|¥|₹|₩)\s?\d[\d.,' ]*|\d[\d.,' ]*\s?(?:€|£|kr|zł)|\b(?:USD|EUR|GBP|CAD|AUD|JPY|CHF|SEK|NOK|DKK|PLN|MXN)\s?\d[\d.,' ]*/i;

/** The order total on the page, or why it can't be trusted. */
export function readOrderTotal(text: string, currency: string): { total?: Money; problem?: string } {
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  let best: { total: Money; rank: number } | undefined;
  let problem: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const label = lines[i].match(TOTAL_LINE);
    if (!label || NOT_TOTAL.test(lines[i])) continue;
    const rank = /^total$/i.test(label[1]) ? 1 : 2; // "Order total" beats a bare "Total"
    const tok = (lines[i].slice(label.index! + label[0].length).match(MONEY_TOKEN) ?? (lines[i + 1] ?? "").match(MONEY_TOKEN))?.[0];
    if (!tok) continue;
    try {
      const total = parseMoney(tok.replace(/[.,]+$/, ""), currency);
      if (!best || rank > best.rank || (rank === best.rank && total.minor !== best.total.minor)) {
        if (best && rank === best.rank && total.minor !== best.total.minor) problem = "the page shows more than one different total";
        best = { total, rank };
      }
    } catch (e: any) {
      problem = `the total "${tok}" can't be read safely (${e.message})`;
    }
  }
  if (problem) return { problem };
  if (best) return { total: best.total };
  // Carts often show only a subtotal. It bounds the cart (the order page's real total is checked
  // again before anything is placed); two different subtotals are refused like two totals.
  let sub: Money | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (!/\bsub-?total\b/i.test(lines[i])) continue;
    const tok = (lines[i].match(MONEY_TOKEN) ?? (lines[i + 1] ?? "").match(MONEY_TOKEN))?.[0];
    if (!tok) continue;
    try {
      const v = parseMoney(tok.replace(/[.,]+$/, ""), currency);
      if (sub && sub.minor !== v.minor) return { problem: "the page shows more than one different subtotal" };
      sub = v;
    } catch (e: any) {
      return { problem: `the subtotal "${tok}" can't be read safely (${e.message})` };
    }
  }
  return sub ? { total: sub } : {};
}

/** Phrases that identify the approved item on cart/checkout pages. */
export function itemPhrases(title: string, variants: string[]): string[] {
  if (variants.length) return variants;
  // Model numbers and sizes: tokens with digits ("4070", "MZ-V9P2T0B", "2TB").
  const tokens = [...new Set(title.match(/\b[A-Za-z0-9][A-Za-z0-9-]*\d[A-Za-z0-9-]*\b/g) ?? [])].filter((t) => t.length >= 3).slice(0, 3);
  return tokens.length ? tokens : title.split(/\s+/).filter((w) => w.length > 3).slice(0, 2);
}

const norm = (s: string) => s.toLowerCase().replace(/[\s ]+/g, " ");

export function analyzePage(p: PageSnapshot, expect: { currency: string; phrases: string[]; allPhrases?: boolean }): PageFacts {
  const text = p.text ?? "";
  const lower = norm(text);
  let site = "";
  try {
    site = siteOf(new URL(p.url).hostname);
  } catch {}
  const checkout = CHECKOUT_SIGNS.test(text) || CHECKOUT_URL.test(p.url);
  const { total, problem } = readOrderTotal(text, expect.currency);
  const quantities = [...text.matchAll(/\b(?:qty|quantity)\s*[:.x]?\s*(\d{1,3})\b/gi)].map((m) => Number(m[1]));
  for (const el of p.elements) if (/^(qty|quantity)/i.test(el.name ?? "") && /^\d{1,3}$/.test(el.text)) quantities.push(Number(el.text));
  const counts = [...text.matchAll(/\(\s*(\d{1,3})\s+items?\s*\)|\b(\d{1,3})\s+items?\s+in\s+(?:your\s+)?(?:cart|bag|basket)\b/gi)].map((m) => Number(m[1] ?? m[2]));
  const found = expect.phrases.map((ph) => lower.includes(norm(ph)));
  const itemMentioned = expect.phrases.length ? (expect.allPhrases ? found.every(Boolean) : found.some(Boolean)) : false;
  const facts: PageFacts = { url: p.url, site, checkout, total, totalProblem: problem, quantities, itemCount: counts.length ? Math.max(...counts) : undefined, itemMentioned };

  const confirm = /(thank you|thanks)[^\n]{0,60}\b(order|purchase)\b|\border (has been |was )?(placed|confirmed|received|complete)|order confirmation|your order number|order number:/i.test(text);
  if (confirm) {
    const id = text.match(/\border\s*(?:number|no\.?|#|id)\s*(?:is\s*)?[:#]?\s*([A-Z0-9][A-Z0-9-]{4,})/i)?.[1] ?? text.match(/#\s?(\d[\d-]{5,})\b/)?.[1];
    facts.confirmation = { orderId: id };
  }

  const sig = (p.signals ?? []).join(" ");
  const visiblePassword = p.elements.some((e) => e.type === "password");
  if (/captcha|recaptcha|hcaptcha|turnstile|challenge/i.test(sig) || /verify (that )?you('re| are) (a )?human|are you a robot|press (and|&) hold|complete the security check|captcha/i.test(text.slice(0, 4000)))
    facts.humanStep = "a CAPTCHA / human check";
  else if (/one-time-code/i.test(sig) || /\b(verification|security|one-time|2-step|two-step|authentication) code\b|enter the code (we|that we) sent/i.test(text.slice(0, 4000))) facts.humanStep = "a verification code";
  else if (visiblePassword) facts.humanStep = "signing in";
  else if (p.elements.some((e) => /cc-number|card.?number|cardnumber|cvv|cvc|security code/i.test(`${e.name ?? ""} ${e.text}`) && !e.disabled))
    facts.humanStep = "entering payment details";
  return facts;
}

export type ExecutionState = "active" | "submitted" | "confirmed" | "paused" | "stopped";

export interface ExecutionInit {
  dealId: string;
  /** The verified store listing; its site is the only store this purchase may use. */
  listingUrl: string;
  /** Highest order total this approval covers (tax and shipping included). */
  cap: Money;
  phrases: string[];
  allPhrases?: boolean;
  minutes?: number;
}

export type ActionKind = "click" | "type" | "submit" | "navigate";

export class PurchaseExecution {
  readonly id = newId("x_");
  readonly site: string;
  readonly expiresAt: number;
  state: ExecutionState = "active";
  submitted?: { at: string; total?: Money; url: string };
  orderId?: string;
  pausedFor?: string;
  /** The last order total checked on a checkout page. */
  lastTotal?: Money;
  /** Called the moment an order may have been submitted (persist it before anything else happens). */
  onSubmitted?: () => void;
  /** Actions taken on cart/checkout pages. */
  checkoutActions = 0;
  private done = new Set<string>();

  constructor(readonly init: ExecutionInit) {
    this.site = siteOf(new URL(init.listingUrl).hostname);
    this.expiresAt = Date.now() + (init.minutes ?? 15) * 60_000;
  }

  get currency() {
    return this.init.cap.currency;
  }

  analyze(p: PageSnapshot) {
    return analyzePage(p, { currency: this.currency, phrases: this.init.phrases, allPhrases: this.init.allPhrases });
  }

  /** Only https pages on the approved store's site. */
  allowsUrl(u: string): boolean {
    try {
      const url = new URL(u);
      return url.protocol === "https:" && siteOf(url.hostname) === this.site;
    } catch {
      return false;
    }
  }

  pause(reason: string) {
    if (this.state === "active") {
      this.state = "paused";
      this.pausedFor = reason;
    }
  }

  stop() {
    if (this.state === "active") this.state = "stopped";
  }

  /**
   * The single authorization point. Every click, typing, Enter/form submit and navigation during
   * checkout comes here first, with facts read from the page by code. Throws with the reason.
   */
  authorize(kind: ActionKind, target: string, before: PageFacts) {
    this.ensureActive();
    this.check(kind, target, before);
  }

  /** Throws unless this purchase can still act (not submitted, paused, stopped or expired). */
  ensureActive() {
    if (this.state === "submitted" || this.state === "confirmed") throw new Error("An order may already have been placed. Nothing else will be clicked; read the page and report back.");
    if (this.state === "paused") throw new Error(`PAUSED: this needs the user (${this.pausedFor}). Stop and tell them.`);
    if (this.state !== "active") throw new Error("This purchase was stopped.");
    if (Date.now() > this.expiresAt) {
      this.stop();
      throw new Error("This purchase took too long and was stopped. Nothing more will be clicked.");
    }
  }

  private check(kind: ActionKind, target: string, before: PageFacts) {
    if (kind === "navigate") {
      if (!this.allowsUrl(target)) throw new Error(`During this purchase only ${this.site} pages can be opened.`);
      return;
    }
    if (!this.allowsUrl(before.url)) throw new Error(`This page isn't on ${this.site}, the approved store. Nothing on it will be clicked.`);
    if (before.humanStep) {
      this.pause(before.humanStep);
      throw new Error(`PAUSED: the store needs ${before.humanStep}, which only the user can do. Stop and tell them.`);
    }
    if (!before.checkout) return; // product pages: choosing options, adding to cart
    if (before.totalProblem) throw new Error(`Not continuing: ${before.totalProblem}. Report what you see.`);
    if (!before.total) throw new Error("Not continuing: this looks like a cart/checkout page but SlopBot can't read the order total. Report what you see.");
    if (before.total.currency !== this.currency) throw new Error(`Not continuing: the total is in ${before.total.currency}, the approval is in ${this.currency}.`);
    if (before.total.minor > this.init.cap.minor)
      throw new Error(`Not continuing: the order total ${formatMoney(before.total)} is over the approved maximum of ${formatMoney(this.init.cap)}. Report back; don't change anything.`);
    if (before.quantities.some((q) => q > 1) || (before.itemCount ?? 1) > 1) throw new Error("Not continuing: the cart has more than one item or a quantity above 1. Report back; don't remove the user's items.");
    if (!before.itemMentioned) throw new Error("Not continuing: SlopBot can't find the approved item on this page. Report what you see.");
    const signature = `${kind}|${target}|${shortUrl(before.url)}|${before.total.minor}`;
    if (this.done.has(signature)) throw new Error("Blocked: that would repeat an action already taken on this page (it could submit the order twice).");
    if (++this.checkoutActions > 8) throw new Error("Blocked: too many checkout steps. Stop and report back.");
    this.done.add(signature);
    this.lastTotal = before.total;
  }

  /** Record what happened after an authorized action, from the page that followed. */
  after(before: PageFacts, after: PageFacts) {
    if (after.confirmation) {
      const first = !this.submitted;
      this.submitted ??= { at: new Date().toISOString(), total: this.lastTotal, url: after.url };
      if (after.confirmation.orderId) {
        this.orderId = after.confirmation.orderId;
        this.state = "confirmed";
      } else this.state = "submitted";
      if (first) this.onSubmitted?.();
      return;
    }
    if (before.checkout && before.total && !after.checkout) {
      // Acted on an order page and left checkout without a receipt: an order may have been placed.
      this.submitted = { at: new Date().toISOString(), total: before.total, url: after.url };
      this.state = "submitted";
      this.onSubmitted?.();
      return;
    }
    if (!this.allowsUrl(after.url)) this.pause(`finishing checkout on ${after.site || "another site"}`);
    else if (after.humanStep) this.pause(after.humanStep);
  }
}
