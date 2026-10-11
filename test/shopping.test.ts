// Deal watching and buying. Fake stores, synthetic credentials and a scripted model only:
// nothing here can place a real order.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Config } from "../src/config.js";
import { defaultDataDir } from "../src/paths.js";
import { FileSecrets } from "../src/secrets.js";
import { makeBrowserTools, summarizeForModel, type PageSnapshot, type ShopBrowser } from "../src/shopping/browser-tools.js";
import { analyzePage, PurchaseExecution, readOrderTotal } from "../src/shopping/execution.js";
import { matchesKeywords, parseFeed, parseProductPage, priceFromText } from "../src/shopping/extract.js";
import { formatMoney, parseMoney, tryMoney, withAllowance } from "../src/shopping/money.js";
import { redactPII, sanitizeUrl } from "../src/shopping/pii.js";
import { ShoppingService } from "../src/shopping/service.js";
import { dealKey, siteOf } from "../src/shopping/site.js";
import { assertPublicTarget, renderWithService, xQueryFor } from "../src/shopping/sources.js";
import { ShoppingState } from "../src/shopping/state.js";
import { Store } from "../src/store/store.js";
import { registerTools } from "../src/tools/registry.js";

const usd = (minor: number) => ({ minor, currency: "USD" });

// ── money ────────────────────────────────────────────
test("money: exact minor units, international formats, ambiguity refused", () => {
  assert.deepEqual(parseMoney("€1.234,56"), { minor: 123456, currency: "EUR" }, "€1.234,56 is 1234.56 euros, not 1.23");
  assert.deepEqual(parseMoney("$1,299.99", "USD"), usd(129999));
  assert.deepEqual(parseMoney("1 299,00 €", "EUR"), { minor: 129900, currency: "EUR" });
  assert.deepEqual(parseMoney("¥12,800", "JPY"), { minor: 12800, currency: "JPY" });
  assert.deepEqual(parseMoney("1.234.567,89 €", "EUR"), { minor: 123456789, currency: "EUR" });
  assert.deepEqual(parseMoney("$1,234", "USD"), usd(123400));
  assert.deepEqual(parseMoney("€1.234", "EUR"), { minor: 123400, currency: "EUR" });
  for (const [t, c] of [["$1.234", "USD"], ["€1,234", "EUR"], ["12,99", "USD"], ["$49.999", "USD"], ["€5 or $6", "EUR"], ["$0.00", "USD"]])
    assert.equal(tryMoney(t, c), undefined, `${t} must be refused`);
  assert.throws(() => parseMoney("€10,00", "USD"), /in EUR, not USD/, "currency mismatch");
  assert.deepEqual(withAllowance(usd(49999), 15), usd(57499), "allowance in integer math, rounded up");
  assert.equal(formatMoney(usd(54124)), "$541.24");
});

// ── parsing ──────────────────────────────────────────
const productHtml = (o: { price?: string; currency?: string; availability?: string; seller?: string; name?: string } = {}) => `<html><head><title>Shop</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"${o.name ?? "MSI RTX 4070 SUPER Ventus 2X 12G"}","offers":{"@type":"Offer","price":"${o.price ?? "499.99"}","priceCurrency":"${o.currency ?? "USD"}","availability":"${o.availability ?? "https://schema.org/InStock"}"${o.seller ? `,"seller":{"@type":"Organization","name":"${o.seller}"}` : ""}}}</script>
</head><body>buy me</body></html>`;

test("product pages: exact price, seller, currency mismatch reported", () => {
  const p = parseProductPage(productHtml({ seller: "Newegg" }), "USD");
  assert.deepEqual([p.price, p.seller, p.inStock, p.source], [usd(49999), "Newegg", true, "json-ld"]);
  assert.match(parseProductPage(productHtml({ currency: "EUR" }), "USD").priceProblem!, /lists this in EUR, not USD/);
  const text = `<meta property="product:price:amount" content="1299.00"><p>Ships from and sold by Amazon.com.</p>`;
  assert.deepEqual([parseProductPage(text, "USD").price, parseProductPage(text, "USD").seller], [usd(129900), "Amazon.com"]);
  assert.deepEqual(priceFromText("[GPU] RTX 4070 Super - $549.99 ($599 - $50 MIR)", "USD"), usd(54999));
  assert.deepEqual(priceFromText("Angebot: RTX 4070 für 1.234,56 €", "EUR"), { minor: 123456, currency: "EUR" });
});

const atom = (posts: { id: string; title: string; store: string }[]) => `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
${posts.map((p) => `<entry><id>t3_${p.id}</id><title>${p.title}</title><link href="https://www.reddit.com/r/buildapcsales/comments/${p.id}/x/" /><content type="html">&lt;a href=&quot;https://www.reddit.com/user/someone&quot;&gt;u/someone&lt;/a&gt; &lt;a href=&quot;${p.store}&quot;&gt;[link]&lt;/a&gt;</content></entry>`).join("\n")}</feed>`;

test("feeds and dedup keys", () => {
  const [i] = parseFeed(atom([{ id: "a", title: "[GPU] RTX 4070 Super - $499 (Newegg)", store: "https://www.newegg.com/p/123" }]), "https://www.reddit.com/r/buildapcsales/new/.rss");
  assert.deepEqual([i.dealUrl, i.price], ["https://www.newegg.com/p/123", usd(49900)]);
  assert.ok(matchesKeywords("[GPU] RTX 4070 SUPER", ["4070", "super"]) && !matchesKeywords("4070 refurb", ["4070"], ["refurb"]));
  assert.equal(dealKey("https://www.amazon.com/Some-Name/dp/B0B7CMZ3QH/ref=sr_1?tag=x"), dealKey("https://amazon.com/gp/product/B0B7CMZ3QH"));
  assert.equal(dealKey("https://www.newegg.com/p/123?utm_source=reddit"), dealKey("https://secure.newegg.com/p/123/"));
  assert.equal(siteOf("www.amazon.co.uk"), "amazon.co.uk");
});

// ── personal data ────────────────────────────────────
const checkoutText = `Hello, Cameron
Ship to
Jane Q. Doe
1234 Maple Street Apt 5B
Springfield, IL 62704
(217) 555-0142
jane.doe@example.com
Payment: Visa ending in 4242
MSI RTX 4070 SUPER Ventus 2X 12G   Qty: 1   $499.99
Shipping: FREE
Estimated tax: $41.25
Order total: $541.24`;

test("personal details never reach the model, logs or alerts", () => {
  const red = redactPII(checkoutText + "\nCard 4111 1111 1111 1111");
  for (const leak of ["Cameron", "Jane", "Maple", "62704", "555-0142", "jane.doe@", "4242", "4111"]) assert.ok(!red.includes(leak), `leaked ${leak}`);
  assert.match(red, /Order total: \$541\.24/);
  const page: PageSnapshot = { url: "https://secure.newegg.com/checkout?session=abc123", title: "Checkout", text: checkoutText, elements: [{ n: 1, role: "button", text: "Place Order" }, { n: 2, role: "input", text: "Card number", name: "cc-number" }] };
  const facts = analyzePage(page, { currency: "USD", phrases: ["4070"] });
  const seen = summarizeForModel(page, facts, ["4070"]);
  for (const leak of ["Cameron", "Jane", "Maple", "Springfield", "555", "jane.doe", "4242", "session=abc123"]) assert.ok(!seen.includes(leak), `model would see ${leak}`);
  assert.match(seen, /order total \$541\.24/);
  assert.match(seen, /\[2\] input \(a sign-in or payment field/);
  assert.equal(sanitizeUrl("https://www.newegg.com/p/1?Item=1&utm_source=x&tag=a-20&sessionid=s&email=a@b.c#r"), "https://www.newegg.com/p/1?Item=1");
});

// ── purchase authorization ───────────────────────────
/** A fake store: product → cart → checkout (with a total) → receipt. Pages are configurable per test. */
class FakeStore implements ShopBrowser {
  page = "product";
  log: string[] = [];
  total = "$541.24";
  cartQty = 1;
  receipt = "Thank you! Your order #284019331 has been placed.";
  checkoutExtra: Partial<PageSnapshot> = {};
  pages = (): Record<string, PageSnapshot> => ({
    product: { url: "https://www.newegg.com/p/123", title: "MSI RTX 4070 SUPER", text: "MSI RTX 4070 SUPER Ventus 2X 12G\n$499.99\nIn stock", elements: [{ n: 1, role: "button", text: "Add to cart" }, { n: 2, role: "button", text: "Pay" }] },
    cart: { url: "https://secure.newegg.com/shop/cart", title: "Cart", text: `MSI RTX 4070 SUPER Ventus 2X 12G  Qty: ${this.cartQty}  $499.99\nSubtotal $${(499.99 * this.cartQty).toFixed(2)}`, elements: [{ n: 1, role: "button", text: "Secure Checkout" }] },
    checkout: {
      url: "https://secure.newegg.com/shop/checkout",
      title: "Checkout",
      text: checkoutText.replace("Order total: $541.24", `Order total: ${this.total}`),
      elements: [{ n: 1, role: "button", text: "Pay" }, { n: 2, role: "input", text: "Promo code", name: "promo" }],
      ...this.checkoutExtra,
    },
    done: { url: "https://secure.newegg.com/shop/thankyou", title: "Thank you", text: this.receipt, elements: [] },
    elsewhere: { url: "https://evil.example/pay", title: "Pay", text: "Order total: $1.00\nMSI RTX 4070", elements: [{ n: 1, role: "button", text: "Pay" }] },
  });
  async open(url: string) {
    this.log.push(`open ${url}`);
    this.page = url.includes("evil") ? "elsewhere" : url.includes("cart") ? "cart" : "product";
    return this.snapshot();
  }
  async snapshot() {
    return this.pages()[this.page];
  }
  async click(n: number) {
    this.log.push(`click ${this.page}:${n}`);
    const next: Record<string, string> = { "product:1": "cart", "product:2": "done", "cart:1": "checkout", "checkout:1": "done", "elsewhere:1": "done" };
    this.page = next[`${this.page}:${n}`] ?? this.page;
    return this.snapshot();
  }
  async type(n: number, text: string, submit?: boolean) {
    this.log.push(`type ${this.page}:${n}=${text}${submit ? "⏎" : ""}`);
    if (submit && this.page === "checkout") this.page = "done"; // Enter submits the order form
    return this.snapshot();
  }
  async back() {
    return this.snapshot();
  }
}

const exec = (cap = 57500, phrases = ["4070"]) => new PurchaseExecution({ dealId: "d", listingUrl: "https://www.newegg.com/p/123", cap: usd(cap), phrases });
const toolsFor = (shop: ShopBrowser, getX: () => PurchaseExecution | undefined) => Object.fromEntries(makeBrowserTools(() => shop, getX).map((t) => [t.name, t]));

test("no approved purchase → no clicks or typing at all (an unrecognized 'Pay' button included)", async () => {
  const shop = new FakeStore();
  const t = toolsFor(shop, () => undefined);
  await t["browser.open"].run({ url: "https://www.newegg.com/p/123" }, {} as any);
  await assert.rejects(t["browser.click"].run({ n: 2 }, {} as any), /only happen during a purchase the user approved/, "'Pay' on a product page");
  await assert.rejects(t["browser.click"].run({ n: 1 }, {} as any), /only happen during a purchase/, "even harmless clicks");
  shop.page = "checkout";
  await assert.rejects(t["browser.type"].run({ n: 2, text: "x", submit: true }, {} as any), /only happen during a purchase/, "Enter / form submit");
  assert.deepEqual(shop.log, ["open https://www.newegg.com/p/123"], "nothing was clicked or typed");
});

test("during a purchase: wrong store, unknown or ambiguous total, over cap, extra items, wrong item → refused", async () => {
  const cases: [string, (s: FakeStore) => void, RegExp][] = [
    ["other store", (s) => (s.page = "elsewhere"), /isn't on newegg\.com/],
    ["unknown total", (s) => ((s.page = "checkout"), (s.checkoutExtra = { text: "Review your order\nShipping: FREE\nMSI RTX 4070 SUPER" })), /can't read the order total/],
    ["ambiguous total", (s) => ((s.page = "checkout"), (s.total = "$541.2.4")), /can't be read safely/],
    ["two totals", (s) => ((s.page = "checkout"), (s.checkoutExtra = { text: "MSI RTX 4070 SUPER\nOrder total: $541.24\nOrder total: $1,041.24" })), /more than one different total/],
    ["other currency", (s) => ((s.page = "checkout"), (s.total = "€541,24")), /in EUR, not USD/],
    ["over cap", (s) => ((s.page = "checkout"), (s.total = "$899.00")), /over the approved maximum of \$575\.00/],
    ["two in cart", (s) => ((s.page = "cart"), (s.cartQty = 2)), /over the approved maximum|more than one item/],
    ["qty 2 under cap", (s) => ((s.page = "checkout"), (s.checkoutExtra = { text: "MSI RTX 4070 SUPER  Qty: 2  $249.99\nOrder total: $499.98" })), /more than one item or a quantity above 1/],
    ["wrong item", (s) => ((s.page = "checkout"), (s.checkoutExtra = { text: "Some Other GPU  Qty: 1\nOrder total: $541.24" })), /can't find the approved item/],
  ];
  for (const [name, setup, err] of cases) {
    const shop = new FakeStore();
    setup(shop);
    const x = exec();
    const t = toolsFor(shop, () => x);
    await assert.rejects(t["browser.click"].run({ n: 1 }, {} as any), err, name);
    assert.ok(!shop.log.some((l) => l.startsWith("click")), `${name}: nothing clicked`);
  }
  const x = exec();
  await assert.rejects(toolsFor(new FakeStore(), () => x)["browser.open"].run({ url: "https://evil.example/pay" }, {} as any), /only newegg\.com pages/, "can't navigate away");
});

test("during a purchase: one submission only, Enter goes through the same check, human steps pause", async () => {
  let shop = new FakeStore();
  shop.page = "checkout";
  let x = exec();
  let t = toolsFor(shop, () => x);
  shop.checkoutExtra = { elements: [{ n: 1, role: "button", text: "Pay" }, { n: 2, role: "input", text: "Qty", name: "quantity" }] };
  const out = await t["browser.type"].run({ n: 2, text: "1", submit: true }, {} as any);
  assert.match(out, /Order confirmation shown \(order 284019331\)/);
  assert.equal(x.state, "confirmed");
  await assert.rejects(t["browser.click"].run({ n: 1 }, {} as any), /may already have been placed/, "no second order");
  await assert.rejects(t["browser.back"].run({}, {} as any), /no longer active/);

  // The same click twice on an unchanged checkout page would be a duplicate submission.
  shop = new FakeStore();
  shop.page = "checkout";
  shop.checkoutExtra = { elements: [{ n: 1, role: "button", text: "Continue" }] };
  x = exec();
  t = toolsFor(shop, () => x);
  shop.click = async (n: number) => (shop.log.push(`click ${n}`), shop.snapshot()); // page doesn't change
  await t["browser.click"].run({ n: 1 }, {} as any);
  await assert.rejects(t["browser.click"].run({ n: 1 }, {} as any), /repeat an action already taken/);
  assert.equal(shop.log.filter((l) => l.startsWith("click")).length, 1);

  // A sign-in, CAPTCHA or code on the page pauses the purchase; passwords are never typed.
  for (const [extra, why] of [
    [{ elements: [{ n: 1, role: "button", text: "Pay" }, { n: 2, role: "input", text: "Password", type: "password" }] }, /signing in/],
    [{ signals: ["captcha"] }, /CAPTCHA/],
    [{ text: `${checkoutText}\nEnter the verification code we sent to your phone` }, /verification code/],
  ] as [Partial<PageSnapshot>, RegExp][]) {
    shop = new FakeStore();
    shop.page = "checkout";
    shop.checkoutExtra = extra;
    x = exec();
    await assert.rejects(toolsFor(shop, () => x)["browser.click"].run({ n: 1 }, {} as any), why);
    assert.equal(x.state, "paused");
  }
  shop = new FakeStore();
  shop.page = "checkout";
  shop.checkoutExtra = { elements: [{ n: 2, role: "input", text: "Password", type: "password" }] };
  await assert.rejects(toolsFor(shop, () => exec())["browser.type"].run({ n: 2, text: "hunter2" }, {} as any), /never types passwords/);
});

test("order totals are read from labels, not from button text", () => {
  assert.deepEqual(readOrderTotal("Items: $499.99\nEstimated tax: $41.25\nOrder total: $541.24", "USD"), { total: usd(54124) });
  assert.deepEqual(readOrderTotal("Total\n$541.24", "USD"), { total: usd(54124) });
  assert.deepEqual(readOrderTotal("Subtotal (1 item): $499.99", "USD"), { total: usd(49999) }, "a cart's subtotal bounds the cart");
  assert.deepEqual(readOrderTotal("Total: 541,24 €", "EUR"), { total: { minor: 54124, currency: "EUR" } });
  assert.match(readOrderTotal("Order total: €541,24", "USD").problem!, /in EUR, not USD/);
});

// ── watching and buying end to end ───────────────────
let server: http.Server;
let base = "";
const product = { price: "499.99", seller: "Newegg", currency: "USD" };
let feedPosts: { id: string; title: string; store: string }[] = [];
let script: Array<{ tools?: Array<[string, object]>; text?: string }> = [];
let xPosts: any[] = [];
let xStatus = 200;
const xAuth: string[] = [];

before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url!, "http://x");
    if (u.pathname === "/product") return res.end(productHtml(product));
    if (u.pathname === "/product-eur") return res.end(productHtml({ ...product, currency: "EUR", price: "1234.56" }));
    if (u.pathname === "/feed.rss") return res.end(atom(feedPosts));
    if (u.pathname === "/2/tweets/search/recent" || u.pathname === "/2/users/by/username/X") {
      xAuth.push(String(req.headers.authorization));
      res.statusCode = xStatus;
      if (xStatus === 429) res.setHeader("x-rate-limit-reset", String(Math.floor(Date.now() / 1000) + 600));
      res.setHeader("x-rate-limit-remaining", "42");
      return res.end(JSON.stringify(u.pathname.includes("users") ? { data: { id: "1" } } : { data: xPosts }));
    }
    if (u.pathname === "/api/v1/") return res.end(u.searchParams.get("api_key") === "bee-test-key" ? `<html>Example Domain ${u.searchParams.get("url")}</html>` : "");
    if (u.pathname === "/v1/chat/completions") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const next = script.shift() ?? { text: "done" };
        const message: any = { role: "assistant", content: next.text ?? null };
        if (next.tools) message.tool_calls = next.tools.map(([name, args], i) => ({ id: `c${i}${Math.random()}`, type: "function", function: { name: name.replace(/\./g, "__"), arguments: JSON.stringify(args) } }));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ choices: [{ message, finish_reason: next.tools ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, r)); // IPv4 + IPv6, so "localhost" works as a second site
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.SLOPBOT_X_API = base;
});
after(() => {
  server.close();
  delete process.env.SLOPBOT_X_API;
});

function setup(browser?: ShopBrowser) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "slopbot-shop-"));
  fs.mkdirSync(path.join(dir, "bots"));
  fs.copyFileSync(path.join(import.meta.dirname, "../bots/shopper.yaml"), path.join(dir, "bots/shopper.yaml"));
  const config = {
    rootDir: dir,
    dataDir: path.join(dir, "data"),
    botsDir: path.join(dir, "bots"),
    defaultModel: "mock/m",
    providers: { mock: { type: "openai", baseUrl: `${base}/v1` } },
    policy: { rules: [] },
    maxToolOutputChars: 12000,
    network: { allow: [], allowPrivate: ["127.0.0.1", "localhost"] },
  } as unknown as Config;
  const store = new Store(config.dataDir);
  const secrets = new FileSecrets(path.join(config.dataDir, "secrets"));
  const events = { deals: [] as string[], updates: [] as string[] };
  const svc = new ShoppingService(config, store, {
    secrets,
    getBrowser: () => browser,
    onDeal: (d, _w, o) => events.deals.push(`${o.reconfirm ? "reconfirm" : "deal"}:${d.listing.title}`),
    onUpdate: (d) => events.updates.push(d.status),
  });
  if (browser) registerTools(makeBrowserTools(() => browser, () => svc.execution));
  return { svc, events, config, secrets };
}

test("product watch: verified listing (variant, seller) → one alert with an expiring, bound Buy; deduped across sources", async () => {
  const { svc, events } = setup();
  const w = svc.state.saveWatch({ kind: "product", url: `${base}/product`, targetPrice: "500", variants: ["4070 SUPER"], sellers: ["Newegg"] });
  assert.match((await svc.check(w.id)).summary, /\$499\.99, in stock, sold by Newegg → deal!/);
  const [deal] = svc.state.deals();
  assert.deepEqual([deal.status, deal.quantity, deal.listing.seller, deal.cap], ["pending", 1, "Newegg", usd(57499)]);
  assert.ok(deal.approval && Date.parse(deal.approval.expiresAt) > Date.now());
  await svc.check(w.id);
  assert.equal(events.deals.length, 1, "not announced again at the same price");

  feedPosts = [{ id: "old", title: "[GPU] something older", store: "https://example.com/" }];
  const f = svc.state.saveWatch({ kind: "feed", url: `${base.replace("127.0.0.1", "localhost")}/feed.rss`, keywords: ["4070"] }); // the feed is another site
  await svc.check(f.id);
  feedPosts = [{ id: "n1", title: "[GPU] RTX 4070 Super $499", store: `${base}/product?utm_source=reddit` }, ...feedPosts];
  const fr = await svc.check(f.id);
  assert.equal(svc.state.deals().length, 1, "the same product from a feed doesn't make a second deal");
  assert.match(fr.summary, /1 new post, 1 matched/, fr.summary);
  assert.equal(svc.state.deals()[0].sources.length, 2, `${fr.summary} | ${JSON.stringify(svc.state.deals()[0].sources)}`);

  const s2 = setup().svc;
  const w2 = s2.state.saveWatch({ kind: "product", url: `${base}/product`, targetPrice: "500", sellers: ["Amazon.com"] });
  assert.match((await s2.check(w2.id)).summary, /sold by Newegg, not Amazon\.com/);
  const w3 = s2.state.saveWatch({ kind: "product", url: `${base}/product`, targetPrice: "500", variants: ["16GB"] });
  assert.match((await s2.check(w3.id)).summary, /doesn't say "16GB"/);
  const w4 = s2.state.saveWatch({ kind: "product", url: `${base}/product-eur`, targetPrice: "500" });
  const r4 = await s2.check(w4.id);
  assert.match(r4.summary, /lists this in EUR, not USD/);
  assert.match(r4.hint!, /currency/);
  assert.equal(s2.state.deals().length, 0);
});

/** A deal on the fake store's site, as if a watch had verified it. */
function fakeDeal(env: ReturnType<typeof setup>) {
  // The fake store isn't reachable over the network; its listing is read like this instead.
  env.svc.readListing = async () => ({ ...parseProductPage(productHtml(product), "USD"), url: "https://www.newegg.com/p/123" });
  const w = env.svc.state.saveWatch({ kind: "product", url: "https://www.newegg.com/p/123", targetPrice: "500" });
  return env.svc.state.addDeal(
    { watchId: w.id, watchName: "4070", key: "newegg.com/p/123", sources: ["product page"], listing: { url: "https://www.newegg.com/p/123", title: "MSI RTX 4070 SUPER Ventus 2X 12G", price: usd(49999), seller: "Newegg", inStock: true, checkedAt: new Date().toISOString() }, cap: usd(57499) },
    30,
  );
}

test("Buy is bound to the deal's quote and expires; a changed listing needs a new Buy", async () => {
  const env = setup(new FakeStore());
  const deal = fakeDeal(env);
  const { svc, events } = env;
  await assert.rejects(svc.approve(deal.id, "not-the-nonce"), /out of date/);
  svc.state.patchDeal(deal.id, { approval: { ...deal.approval!, expiresAt: new Date(Date.now() - 1000).toISOString() } });
  await assert.rejects(svc.approve(deal.id, deal.approval!.nonce), /expired/);
  assert.equal(svc.state.deal(deal.id)!.status, "expired");
  await svc.recheck(deal.id);
  const fresh = svc.state.deal(deal.id)!;
  assert.notEqual(fresh.approval!.nonce, deal.approval!.nonce);
  product.price = "519.99";
  const after = await svc.approve(deal.id, fresh.approval!.nonce);
  product.price = "499.99";
  assert.equal(after.status, "pending");
  assert.match(after.note!, /price went up from \$499\.99 to \$519\.99/);
  assert.ok(events.deals.includes("reconfirm:MSI RTX 4070 SUPER Ventus 2X 12G"));
  await assert.rejects(svc.approve(deal.id, fresh.approval!.nonce), /out of date/, "the old Buy no longer works");
  // Stale approvals expire on the timer too.
  svc.state.patchDeal(deal.id, { approval: { ...svc.state.deal(deal.id)!.approval!, expiresAt: new Date(Date.now() - 1).toISOString() } });
  await svc.tick();
  assert.equal(svc.state.deal(deal.id)!.status, "expired");
});

const steps = (): typeof script => [
  { tools: [["browser.read", {}]] },
  { tools: [["browser.click", { n: 1 }]] }, // add to cart
  { tools: [["browser.click", { n: 1 }]] }, // checkout
  { tools: [["browser.click", { n: 1 }]] }, // "Pay" (the label doesn't matter)
  { text: "Done." },
];

async function buyOnce(shop: FakeStore) {
  const env = setup(shop);
  const d = fakeDeal(env);
  return { env, deal: await env.svc.approve(d.id, d.approval!.nonce) };
}

test("checkout: confirmed only with a receipt; no receipt → uncertain and never retried", async () => {
  let shop = new FakeStore();
  script = steps();
  let { env, deal } = await buyOnce(shop);
  assert.equal(deal.status, "confirmed", `${deal.note} | ${shop.log.join(" ; ")}`);
  assert.equal(deal.execution?.orderId, "284019331");
  assert.deepEqual(deal.execution?.total, usd(54124));
  assert.deepEqual(env.events.updates, ["confirmed"]);

  shop = new FakeStore();
  shop.receipt = "Thanks for shopping with us!";
  script = steps();
  ({ env, deal } = await buyOnce(shop));
  assert.equal(deal.status, "uncertain");
  assert.match(deal.note!, /Check your newegg\.com account/);
  await assert.rejects(env.svc.approve(deal.id, "x"), /uncertain, not waiting for Buy/);
  await assert.rejects(env.svc.recheck(deal.id), /Can't re-check a deal that is uncertain/);
  env.svc.resolveUncertain(deal.id, false);
  assert.equal(env.svc.state.deal(deal.id)!.status, "failed");

  shop = new FakeStore();
  shop.total = "$899.00";
  script = [...steps().slice(0, 4), { text: "Total too high, stopped." }];
  ({ deal } = await buyOnce(shop));
  assert.equal(deal.status, "failed");
  assert.ok(!shop.log.includes("click checkout:1"), "Pay never clicked");

  shop = new FakeStore();
  shop.checkoutExtra = { elements: [{ n: 1, role: "button", text: "Pay" }, { n: 2, role: "input", text: "Password", type: "password" }] };
  script = [...steps().slice(0, 4), { text: "It wants a password." }];
  ({ env, deal } = await buyOnce(shop));
  assert.equal(deal.status, "paused");
  assert.match(deal.note!, /Needs you: signing in/);
  // Resume after the user signs in: same approval, new checkout run.
  shop.checkoutExtra = {};
  script = steps(); // resuming reopens the product page and checks out again under the same approval
  env.svc.readListing = async () => ({ ...parseProductPage(productHtml(product), "USD"), url: "https://www.newegg.com/p/123" });
  const resumed = await env.svc.resume(deal.id);
  assert.equal(resumed.status, "confirmed", resumed.note);
});

test("restarts never duplicate a purchase", () => {
  const { svc, config } = setup();
  const mk = () => svc.state.addDeal({ watchId: "w", watchName: "w", key: Math.random().toString(), sources: ["x"], listing: { url: "https://www.newegg.com/p/1", title: "t", price: usd(100), checkedAt: "" }, cap: usd(115) }, 30);
  const a = mk(),
    b = mk(),
    c = mk();
  svc.state.transition(a.id, "queued");
  svc.state.transition(b.id, "reviewing", { execution: { id: "x1", startedAt: "", submittedAt: new Date().toISOString() } });
  svc.state.transition(c.id, "submitted");
  const again = new ShoppingService(config, new Store(config.dataDir), { secrets: new FileSecrets(path.join(config.dataDir, "secrets")) });
  assert.deepEqual([a, b, c].map((d) => again.state.deal(d.id)!.status), ["failed", "uncertain", "uncertain"]);
});

test("budget reservations use the maximum authorized total and count held funds", () => {
  const st = new ShoppingState(fs.mkdtempSync(path.join(os.tmpdir(), "slopbot-budget-")));
  const limit = usd(100000); // $1,000/day
  const capA = withAllowance(usd(49999), 15); // $574.99, not the $499.99 deal price
  st.reserve("x1", "d1", capA, limit);
  assert.throws(() => st.reserve("x2", "d2", capA, limit), /Over today's limit: \$574\.99 of \$1,000\.00 already used or held/, "a held reservation counts");
  st.settleReservation("x1", "released");
  st.reserve("x2", "d2", capA, limit);
  st.settleReservation("x2", "spent", usd(54124));
  assert.throws(() => st.reserve("x3", "d3", usd(50000), limit), /Over today's limit/);
  assert.throws(() => st.reserve("x4", "d4", { minor: 100, currency: "EUR" }, limit), /in USD/);
});

// ── deal sources ─────────────────────────────────────
test("X: your own token, account watch, usage limit, errors explained", async () => {
  const { svc, secrets } = setup();
  const w = svc.state.saveWatch({ kind: "x_account", xQuery: "@BAPCSalesBot", keywords: ["4070"], targetPrice: "500" });
  assert.match((await svc.check(w.id)).summary, /No X API token/);
  svc.credentials.set("x", "synthetic-x-token-0001");
  assert.equal(secrets.get("deals.x.bearer"), "synthetic-x-token-0001", "kept in the credential store");
  svc.state.patchWatch(w.id, { nextCheckAt: undefined });
  xPosts = [{ id: "100", text: "old post", entities: {} }];
  assert.match((await svc.check(w.id)).summary, /Connected/);
  xPosts = [{ id: "101", text: "[GPU] RTX 4070 Super $499 at Newegg https://t.co/x", entities: { urls: [{ expanded_url: `${base}/product` }] } }];
  assert.match((await svc.check(w.id)).summary, /1 new post, 1 matched → deal!/);
  assert.deepEqual(svc.state.deals()[0].sources, ["X @BAPCSalesBot"]);
  assert.equal(xAuth.at(-1), "Bearer synthetic-x-token-0001");
  assert.equal(svc.state.settings().xUsage.posts, 2);
  assert.ok(!fs.readFileSync(svc.state.file, "utf8").includes("synthetic-x-token"), "never in the state file");
  assert.equal(xQueryFor("x_account", "https://x.com/BAPCSalesBot"), "from:BAPCSalesBot -is:retweet");

  xStatus = 403;
  assert.match((await svc.check(w.id)).summary, /doesn't allow reading posts/);
  assert.ok(Date.parse(svc.state.watches().find((x) => x.id === w.id)!.nextCheckAt!) > Date.now() + 10 * 60_000, "backs off");
  xStatus = 429;
  assert.match((await svc.check(w.id)).summary, /rate limit/);
  xStatus = 200;
  assert.match((await svc.testSource("x")).message, /Connected to X · 42 requests left/);
  svc.state.saveSettings({ xMonthlyLimit: 5 });
  assert.match((await svc.check(w.id)).summary, /read limit is used up/);
  svc.credentials.remove("x");
  assert.equal(secrets.get("deals.x.bearer"), undefined);
});

test("rendering service: your key, never sent a private address", async () => {
  await assert.rejects(assertPublicTarget("http://127.0.0.1:8080/admin"), /private or local/);
  await assert.rejects(assertPublicTarget("http://localhost/"), /private or local/);
  await assert.rejects(assertPublicTarget("http://169.254.169.254/latest/meta-data/"), /private or local/);
  const html = await renderWithService("scrapingbee", "bee-test-key", "http://127.0.0.1/shop", { base, allowPrivate: ["127.0.0.1"] });
  assert.match(html, /Example Domain/);
});

test("failing watches back off; data lives outside the source checkout", async () => {
  const { svc } = setup();
  const w = svc.state.saveWatch({ kind: "product", url: `${base}/missing` });
  assert.match((await svc.check(w.id)).summary, /answered 404/);
  const n1 = Date.parse(svc.state.watches()[0].nextCheckAt!) - Date.now();
  await svc.check(w.id);
  const n2 = Date.parse(svc.state.watches()[0].nextCheckAt!) - Date.now();
  assert.ok(n2 > n1, "the second failure waits longer");
  assert.equal(svc.state.watches()[0].failures, 2);

  const repo = path.join(import.meta.dirname, "..");
  assert.equal(defaultDataDir(repo), process.env.SLOPBOT_DEV_DATA, "a source checkout keeps its data in the private app folder");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "slopbot-home-"));
  assert.equal(defaultDataDir(home), path.join(home, "data"), "an installed app's home already is private");
});

test("saved feeds: add, remove, bad ones refused", () => {
  const { svc } = setup();
  const mine = { label: "r/GameDeals", url: "https://www.reddit.com/r/GameDeals/new/.rss" };
  svc.state.saveSettings({ savedFeeds: [mine, mine] });
  assert.deepEqual(svc.state.settings().savedFeeds, [mine]);
  assert.throws(() => svc.state.saveSettings({ savedFeeds: [{ label: "x", url: "file:///etc/passwd" }] }), /http\(s\)/);
});

test("a page can't get the bot to change your saved details or the quantity", async () => {
  const shop = new FakeStore();
  shop.page = "checkout";
  shop.checkoutExtra = {
    elements: [
      { n: 1, role: "button", text: "Pay" },
      { n: 2, role: "input", text: "Street address", name: "shipping-address1" },
      { n: 3, role: "input", text: "Email", type: "email" },
      { n: 4, role: "input", text: "Promo code", name: "promo" },
      { n: 5, role: "input", text: "Qty", name: "quantity" },
    ],
  };
  const x = exec();
  const t = toolsFor(shop, () => x);
  await assert.rejects(t["browser.type"].run({ n: 2, text: "1 Attacker Way" }, {} as any), /doesn't change names, addresses/);
  await assert.rejects(t["browser.type"].run({ n: 3, text: "a@evil.example" }, {} as any), /doesn't change names, addresses/);
  await assert.rejects(t["browser.type"].run({ n: 4, text: "FREE" }, {} as any), /only sets the quantity to 1/);
  await assert.rejects(t["browser.type"].run({ n: 5, text: "5" }, {} as any), /only sets the quantity to 1|must be 1/);
  assert.ok(!shop.log.some((l) => l.startsWith("type")), "nothing typed");
  await t["browser.type"].run({ n: 5, text: "1" }, {} as any);
  assert.ok(shop.log.includes("type checkout:5=1"));
});
