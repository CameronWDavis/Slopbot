// The shopping browser: a real Chromium window inside SlopBot with its own saved sign-ins
// (partition "persist:shopping", in the per-user app data folder). You sign in to stores here
// yourself; the shopper bot drives it through the browser.* tools. It never has SlopBot's
// preload/IPC, so pages can't reach the app.
//  - Every request's host is resolved and refused if it's local/private/metadata (redirects too).
//  - During a purchase, top-level navigation is locked to the approved store; anything else pauses.
//  - Price reads for watches use their own short-lived hidden windows, so they never mix.
import { BrowserWindow, session as electronSession, type Session } from "electron";
import dns from "node:dns/promises";
import net from "node:net";
import type { PageSnapshot, ShopBrowser } from "../src/shopping/browser-tools.js";
import type { PurchaseExecution } from "../src/shopping/execution.js";
import { parseProductPage, priceFromText, sellerFromText, type ProductInfo } from "../src/shopping/extract.js";
import { isPrivateIp } from "../src/tools/netguard.js";

const PARTITION = "persist:shopping";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Runs in the page: number the visible interactive elements and return text + list. Field values are
// never read (they can hold personal data); only labels.
const SNAPSHOT_JS = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0"; };
  document.querySelectorAll("[data-slopbot-n]").forEach((e) => e.removeAttribute("data-slopbot-n"));
  const sel = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [onclick]';
  const out = []; let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (!vis(el) || n >= 200) continue;
    n++; el.setAttribute("data-slopbot-n", String(n));
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    const label = el.labels && el.labels[0] ? el.labels[0].innerText : "";
    let text = (el.innerText || "").trim();
    if (!text && tag === "input" && /^(submit|button)$/.test(type)) text = el.value || "";
    if (!text && tag === "select") text = (el.options[el.selectedIndex] || {}).text || "";
    if (!text) text = el.getAttribute("aria-label") || el.getAttribute("title") || label || el.getAttribute("placeholder") || el.getAttribute("alt") || "";
    out.push({ n, role: el.getAttribute("role") || (tag === "a" ? "link" : tag), type: type || undefined,
      text: String(text).replace(/\\s+/g, " ").slice(0, 120),
      name: [el.getAttribute("name"), el.id, el.getAttribute("autocomplete"), el.getAttribute("aria-label")].filter(Boolean).join(" ").slice(0, 120) || undefined,
      disabled: !!el.disabled || el.getAttribute("aria-disabled") === "true" || undefined });
  }
  const signals = [];
  for (const f of document.querySelectorAll("iframe")) { const s = (f.src || "") + " " + (f.title || ""); if (/captcha|recaptcha|hcaptcha|turnstile|challenge/i.test(s)) signals.push("captcha"); }
  if (document.querySelector("input[autocomplete='one-time-code']")) signals.push("one-time-code");
  const text = (document.body ? document.body.innerText : "").replace(/\\n{3,}/g, "\\n\\n").slice(0, 20000);
  return { url: location.href, title: document.title, text, elements: out, signals };
})()`;

// Runs in the page when the store doesn't publish structured price data: known stores' price
// elements first, then the most prominent price near the top. Stock from the store's availability
// text or an enabled "Add to cart"; seller from "Sold by".
const PRODUCT_JS = `(() => {
  const q = (s) => { const el = document.querySelector(s); return el ? (el.getAttribute("content") || el.textContent || "").trim() : ""; };
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 1 && r.height > 1 && s.visibility !== "hidden" && s.display !== "none"; };
  let price = q("#corePrice_feature_div .a-offscreen") || q("#corePriceDisplay_desktop_feature_div .a-offscreen") || q("#apex_desktop .a-price .a-offscreen")
    || q("[class*='price-current_']") || q(".product-buy-box .price-current") || q(".product-pane .price-current")
    || q("[data-testid='customer-price'] span") || q(".priceView-customer-price span")
    || q("[itemprop='price'][data-seo-id='hero-price']") || q("span[itemprop='price']") || "";
  if (!price) {
    let best = null;
    for (const el of document.querySelectorAll("body span, body div, body strong, body p, body b")) {
      if (el.children.length > 4) continue;
      const t = (el.innerText || "").replace(/\\s+/g, " ").trim();
      if (t.length > 20 || !/^((US|CA|AU|NZ|HK|S|R)?[$€£¥₹]\\s?\\d[\\d.,']*|\\d[\\d.,']*\\s?(€|£|kr|zł))$/.test(t) || !vis(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.top + window.scrollY > 1400) continue;
      const fs = parseFloat(getComputedStyle(el).fontSize) || 0;
      if (!best || fs > best.fs) best = { fs, t };
    }
    price = best ? best.t : "";
  }
  const avail = (q("#availability") || q(".product-inventory") || q("[data-testid='fulfillment-summary']") || "").replace(/\\s+/g, " ");
  let inStock;
  if (/out of stock|sold out|currently unavailable|unavailable|not available|coming soon/i.test(avail)) inStock = false;
  else if (/in stock|available|ships|get it/i.test(avail)) inStock = true;
  else {
    const buy = [...document.querySelectorAll("button, input[type=submit], [role=button]")].find((b) => vis(b) && /add to cart|add to basket|buy now/i.test(b.innerText || b.value || b.getAttribute("aria-label") || ""));
    if (buy && !buy.disabled && buy.getAttribute("aria-disabled") !== "true") inStock = true;
    else if (/\\b(sold out|out of stock|currently unavailable)\\b/i.test((document.body.innerText || "").slice(0, 6000))) inStock = false;
  }
  const seller = q("#sellerProfileTriggerId") || q("#merchant-info") || q(".product-seller") || q("[data-testid='seller-name']") || "";
  const title = q("#productTitle") || q("h1") || document.title;
  return { price, inStock, availability: avail.split("{")[0].trim().slice(0, 80) || undefined, seller, body: (document.body.innerText || "").slice(0, 8000), title: title.slice(0, 200),
    robotCheck: /just a moment|verify you are human|are you a robot|attention required|access denied|captcha/i.test(document.title + " " + (document.body.innerText || "").slice(0, 600)) };
})()`;

/** Refuse local, private and metadata addresses for every request, using the resolved IPs. */
function guardSession(ses: Session) {
  const cache = new Map<string, { ok: boolean; at: number }>();
  const hostOk = async (host: string): Promise<boolean> => {
    const h = host.replace(/^\[|\]$/g, "").toLowerCase();
    if (/^(localhost|.*\.localhost)$/.test(h)) return false;
    if (net.isIP(h)) return !isPrivateIp(h);
    const hit = cache.get(h);
    if (hit && Date.now() - hit.at < 60_000) return hit.ok;
    let addrs: string[] = [];
    try {
      // Same resolver Chromium connects with, so the answer matches the connection.
      const r = await ses.resolveHost(h);
      addrs = r.endpoints.map((e) => e.address);
    } catch {
      try {
        addrs = (await dns.lookup(h, { all: true })).map((a) => a.address);
      } catch {}
    }
    const ok = addrs.length > 0 && !addrs.some(isPrivateIp);
    cache.set(h, { ok, at: Date.now() });
    return ok;
  };
  // onBeforeRequest also fires for each redirect hop.
  ses.webRequest.onBeforeRequest((details, cb) => {
    let u: URL;
    try {
      u = new URL(details.url);
    } catch {
      return cb({ cancel: true });
    }
    if (/^(data|blob|about|devtools):$/.test(u.protocol)) return cb({});
    if (!/^(https?|wss?):$/.test(u.protocol)) return cb({ cancel: true });
    hostOk(u.hostname).then(
      (ok) => cb({ cancel: !ok }),
      () => cb({ cancel: true }),
    );
  });
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false)); // no camera, location, notifications…
  ses.setPermissionCheckHandler(() => false);
}

/** At most `n` hidden reader windows at once. */
class Gate {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(private n: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.active >= this.n) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

let quitting = false;

export class ElectronShopBrowser implements ShopBrowser {
  private win?: BrowserWindow;
  private execution?: PurchaseExecution;
  private readers = new Gate(2);

  constructor(private icon?: string) {
    guardSession(electronSession.fromPartition(PARTITION));
  }

  private window(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const w = new BrowserWindow({
      width: 1200,
      height: 860,
      show: false,
      title: "SlopBot · Shopping browser",
      icon: this.icon,
      webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    w.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url) && (!this.execution || this.execution.allowsUrl(url))) void w.loadURL(url); // keep popups in this window
      return { action: "deny" };
    });
    // During a purchase the page may only go to the approved store. Leaving it pauses the purchase.
    const lock = (e: Electron.Event, url: string, isMainFrame = true) => {
      const x = this.execution;
      if (!x || !isMainFrame || x.allowsUrl(url)) return;
      e.preventDefault();
      let host = url;
      try {
        host = new URL(url).hostname;
      } catch {}
      x.pause(`finishing checkout on ${host}`);
    };
    w.webContents.on("will-navigate", (e, url) => lock(e, url));
    w.webContents.on("will-redirect", (e, url, _inPlace, isMainFrame) => lock(e, url, isMainFrame));
    w.on("close", (e) => {
      // Closing just hides it, so sign-ins and a running checkout aren't lost.
      if (!quitting) {
        e.preventDefault();
        w.hide();
      }
    });
    this.win = w;
    return w;
  }

  /** Lock navigation to this purchase's store (or unlock with undefined). */
  setExecution(x?: PurchaseExecution) {
    this.execution = x;
  }

  /** Show the window so you can sign in to stores, finish a paused step, or watch a checkout. */
  show(url?: string) {
    const w = this.window();
    if (url) void w.loadURL(url);
    else if (!w.webContents.getURL()) void w.loadURL("about:blank");
    w.show();
    w.focus();
  }

  private async settle(w: BrowserWindow, timeout = 30_000) {
    const start = Date.now();
    while (w.webContents.isLoading() && Date.now() - start < timeout) await sleep(200);
    await sleep(1200); // let scripts render prices and buttons
  }

  async snapshot(): Promise<PageSnapshot> {
    const w = this.window();
    if (!w.webContents.getURL()) throw new Error("Nothing is open yet. Use browser.open first.");
    return (await w.webContents.executeJavaScript(SNAPSHOT_JS, true)) as PageSnapshot;
  }

  async open(url: string): Promise<PageSnapshot> {
    const w = this.window();
    await w.loadURL(url).catch(() => {}); // pages that redirect or keep loading still count
    await this.settle(w);
    return this.snapshot();
  }

  async click(n: number): Promise<PageSnapshot> {
    const w = this.window();
    const ok = await w.webContents.executeJavaScript(
      `(() => { const el = document.querySelector('[data-slopbot-n="${Number(n)}"]'); if (!el) return false; el.scrollIntoView({block: "center"}); el.click(); return true; })()`,
      true,
    );
    if (!ok) throw new Error(`Element [${n}] is gone. Call browser.read for fresh numbers.`);
    await sleep(600);
    await this.settle(w, 20_000);
    return this.snapshot();
  }

  async type(n: number, text: string, submit = false): Promise<PageSnapshot> {
    const w = this.window();
    const ok = await w.webContents.executeJavaScript(
      `(() => { const el = document.querySelector('[data-slopbot-n="${Number(n)}"]'); if (!el) return false;
        el.focus(); const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set; setter ? setter.call(el, ${JSON.stringify(text)}) : (el.value = ${JSON.stringify(text)});
        el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
        if (${submit}) { el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })); if (el.form) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit(); }
        return true; })()`,
      true,
    );
    if (!ok) throw new Error(`Field [${n}] is gone. Call browser.read for fresh numbers.`);
    await sleep(submit ? 800 : 200);
    await this.settle(w, 20_000);
    return this.snapshot();
  }

  async back(): Promise<PageSnapshot> {
    const w = this.window();
    if (w.webContents.navigationHistory.canGoBack()) w.webContents.navigationHistory.goBack();
    await this.settle(w);
    return this.snapshot();
  }

  /** Read a product's price, stock and seller in a fresh hidden window (same sign-ins as the shopping browser). */
  readProduct(url: string, currency: string): Promise<ProductInfo> {
    return this.readers.run(async () => {
      const r = new BrowserWindow({ show: false, webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true } });
      r.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      r.webContents.setAudioMuted(true);
      try {
        await r.loadURL(url).catch(() => {});
        await this.settle(r, 25_000);
        const structured = parseProductPage((await r.webContents.executeJavaScript("document.documentElement.outerHTML", true)) as string, currency);
        if (structured.price || structured.priceProblem) return structured;
        const p = (await r.webContents.executeJavaScript(PRODUCT_JS, true)) as { price: string; inStock?: boolean; availability?: string; seller: string; body: string; title: string; robotCheck: boolean };
        const price = priceFromText(p.price, currency);
        if (!price && p.robotCheck) {
          throw new Error(`${new URL(url).hostname} showed an "are you human?" check. SlopBot doesn't get past those; open the page in the shopping browser and complete it yourself, or use a page-rendering service or a deal feed.`);
        }
        const seller = (p.seller || sellerFromText(p.body) || "").replace(/^(sold by|ships from and sold by)\s*:?\s*/i, "").trim() || undefined;
        return { title: p.title || structured.title, price, inStock: p.inStock, availability: p.availability, seller, source: price ? "page" : "none" } as ProductInfo;
      } finally {
        r.destroy();
      }
    });
  }

  /** Remove every saved store sign-in, cookie and cache from the shopping browser. */
  async clearSignIns() {
    const ses = electronSession.fromPartition(PARTITION);
    await ses.clearStorageData();
    await ses.clearCache();
    await ses.clearAuthCache();
    if (this.win && !this.win.isDestroyed()) await this.win.loadURL("about:blank").catch(() => {});
  }

  close() {
    quitting = true;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
  }
}
