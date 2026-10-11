// Reading prices and deals out of web pages and feeds, without AI.
import { moneyFromDecimal, tryMoney, type Money } from "./money.js";
//  - Product pages: most stores embed schema.org Product data (JSON-LD) for search engines, with
//    price, currency and availability. Fallbacks: product/og meta tags, then itemprop microdata.
//  - Deal feeds: RSS/Atom (r/buildapcsales, Slickdeals, store blogs, RSS mirrors of social accounts).

export interface ProductInfo {
  title?: string;
  /** Exact price in the page's currency (minor units). */
  price?: Money;
  /** Why no usable price was read (ambiguous format, different currency, …). */
  priceProblem?: string;
  /** true = in stock, false = sold out, undefined = page doesn't say. */
  inStock?: boolean;
  availability?: string;
  /** "Sold by …" when the page says. */
  seller?: string;
  /** Where the numbers came from (for the activity log / debugging a watch). */
  source: "json-ld" | "meta" | "microdata" | "page" | "service" | "none";
}

export interface FeedItem {
  id: string;
  title: string;
  link: string;
  /** First link inside the post that points somewhere other than the feed's own site (the store). */
  dealUrl?: string;
  published?: string;
  price?: Money;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** The first price in a sentence (deal titles: "[GPU] RTX 4070 - $499 (Newegg)") in `currency`. */
export function priceFromText(text: string, currency = "USD"): Money | undefined {
  const re = /(?:US\$|CA\$|C\$|A\$|AU\$|NZ\$|HK\$|S\$|R\$|\$|€|£|¥|₹|₩|\b(?:USD|EUR|GBP|CAD|AUD|JPY|INR|CHF|SEK|NOK|DKK|PLN|MXN)\b)\s?\d[\d.,'\u00a0]*\d?|\d[\d.,'\u00a0]*\s?(?:€|£|kr|zł|\b(?:USD|EUR|GBP|CAD|AUD|CHF|SEK|NOK|DKK|PLN)\b)/gi;
  for (const m of String(text).matchAll(re)) {
    const v = tryMoney(m[0].replace(/[.,]+$/, ""), currency);
    if (v) return v;
  }
  return undefined;
}

/** "Sold by Newegg", "Ships from and sold by Amazon.com", "Seller: XYZ Store". */
export function sellerFromText(text: string): string | undefined {
  const m = String(text).match(/(?:ships from and sold by|sold by|seller|sold and shipped by)\s*:?\s*([^\n|•·,]{2,60}?)(?:\s*(?:\.(?=\s|$)|\n|\||•|·|,|and fulfilled|fulfilled by|ships from|$))/i);
  return m ? m[1].trim().replace(/\s+/g, " ") : undefined;
}

const IN_STOCK = /instock|in_stock|limitedavailability|onlineonly|instoreonly|presale/i;
const OUT_OF_STOCK = /outofstock|out_of_stock|soldout|discontinued|backorder|preorder|madetoorder/i;
function stockFrom(av: unknown): boolean | undefined {
  const s = String(av ?? "");
  if (OUT_OF_STOCK.test(s.replace(/[\s-]/g, ""))) return false;
  if (IN_STOCK.test(s.replace(/[\s-]/g, ""))) return true;
  return undefined;
}

function* walkJson(node: any): Generator<any> {
  if (Array.isArray(node)) for (const n of node) yield* walkJson(n);
  else if (node && typeof node === "object") {
    yield node;
    for (const v of Object.values(node)) if (v && typeof v === "object") yield* walkJson(v);
  }
}
const isType = (n: any, t: string) => [].concat(n?.["@type"] ?? []).some((x: string) => String(x).toLowerCase() === t);

function fromJsonLd(html: string, currency: string): ProductInfo | undefined {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  for (const raw of blocks) {
    let data: any;
    try {
      data = JSON.parse(decodeEntities(raw.trim()).replace(/^<!--|-->$/g, ""));
    } catch {
      try {
        data = JSON.parse(raw.trim());
      } catch {
        continue;
      }
    }
    for (const node of walkJson(data)) {
      if (!isType(node, "product") && !isType(node, "productgroup")) continue;
      const offers = [].concat(node.offers ?? node.hasVariant?.flatMap?.((v: any) => [].concat(v.offers ?? [])) ?? []);
      const flat = offers.flatMap((o: any) => (isType(o, "aggregateoffer") && o.offers ? [].concat(o.offers) : [o]));
      if (!flat.length) continue;
      let problem: string | undefined;
      const parsed = flat
        .map((o: any) => {
          const cur = String(o.priceCurrency ?? o.priceSpecification?.priceCurrency ?? "").toUpperCase();
          const value = o.price ?? o.lowPrice ?? o.priceSpecification?.price;
          if (cur && cur !== currency.toUpperCase()) {
            problem = `the store lists this in ${cur}, not ${currency.toUpperCase()}`;
            return undefined;
          }
          // Structured data uses "." decimals; strings with symbols go through the strict parser.
          const price = moneyFromDecimal(value, currency) ?? (typeof value === "string" ? tryMoney(value, currency) : undefined);
          if (!price) return undefined;
          return {
            price,
            inStock: stockFrom(o.availability),
            availability: o.availability ? String(o.availability).replace(/^https?:\/\/schema\.org\//, "") : undefined,
            seller: o.seller?.name ? decodeEntities(String(o.seller.name)) : undefined,
          };
        })
        .filter((o): o is NonNullable<typeof o> => !!o);
      if (!parsed.length) {
        if (problem) return { title: node.name ? decodeEntities(String(node.name)) : undefined, priceProblem: problem, source: "json-ld" };
        continue;
      }
      // Prefer an offer that's in stock; within those, the lowest price.
      parsed.sort((a, b) => Number(b.inStock === true) - Number(a.inStock === true) || a.price.minor - b.price.minor);
      return { title: node.name ? decodeEntities(String(node.name)) : undefined, ...parsed[0], source: "json-ld" };
    }
  }
  return undefined;
}

function metaContent(html: string, names: string[]): string | undefined {
  for (const name of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${name.replace(/[.:]/g, "\\$&")}["'][^>]*>`, "i");
    const tag = html.match(re)?.[0];
    const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
    if (content) return decodeEntities(content);
  }
  return undefined;
}

function fromMeta(html: string, currency: string): ProductInfo | undefined {
  const amount = metaContent(html, ["product:price:amount", "og:price:amount"]);
  if (!amount) return undefined;
  const cur = (metaContent(html, ["product:price:currency", "og:price:currency"]) ?? currency).toUpperCase();
  const title = metaContent(html, ["og:title", "twitter:title"]);
  if (cur !== currency.toUpperCase()) return { title, priceProblem: `the store lists this in ${cur}, not ${currency.toUpperCase()}`, source: "meta" };
  const price = moneyFromDecimal(amount.replace(/,(?=\d{3}\b)/g, ""), currency) ?? tryMoney(amount, currency);
  if (!price) return { title, priceProblem: `couldn't read the price "${amount}"`, source: "meta" };
  const av = metaContent(html, ["product:availability", "og:availability"]);
  return {
    title,
    price,
    inStock: av ? (stockFrom(av.replace(/\s/g, "")) ?? (/^(instock|in stock|available)$/i.test(av) ? true : undefined)) : undefined,
    availability: av,
    source: "meta",
  };
}

function fromMicrodata(html: string, currency: string): ProductInfo | undefined {
  const tag = html.match(/<[^>]+itemprop=["']price["'][^>]*>/i)?.[0];
  if (!tag) return undefined;
  const cur = (html.match(/<[^>]+itemprop=["']priceCurrency["'][^>]*content=["']([^"']+)["']/i)?.[1] ?? currency).toUpperCase();
  if (cur !== currency.toUpperCase()) return { priceProblem: `the store lists this in ${cur}, not ${currency.toUpperCase()}`, source: "microdata" };
  const content = tag.match(/content=["']([^"']+)["']/i)?.[1];
  const price = content ? moneyFromDecimal(content, currency) : tryMoney(html.slice(html.indexOf(tag) + tag.length, html.indexOf(tag) + tag.length + 40).replace(/<[^>]+>/g, "").trim(), currency);
  if (!price) return undefined;
  const avTag = html.match(/<[^>]+itemprop=["']availability["'][^>]*>/i)?.[0];
  const av = avTag?.match(/(?:content|href)=["']([^"']+)["']/i)?.[1];
  return { price, inStock: stockFrom(av), availability: av?.replace(/^https?:\/\/schema\.org\//, ""), source: "microdata" };
}

/** Read a product page. `currency` is the currency the watch is in (prices in others are refused). */
export function parseProductPage(html: string, currency = "USD"): ProductInfo {
  const titleTag = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "") || undefined;
  const info = fromJsonLd(html, currency) ?? fromMeta(html, currency) ?? fromMicrodata(html, currency) ?? { source: "none" as const };
  info.title ??= titleTag;
  if (info.price && !info.seller) {
    const text = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, "\n").replace(/\n\s*\n+/g, "\n");
    info.seller = sellerFromText(decodeEntities(text));
  }
  return info;
}

// ── feeds ──────────────────────────────────────────────
const cdata = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
const tagText = (xml: string, tag: string) => {
  const m = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? decodeEntities(cdata(m[1])).trim() : undefined;
};

/** Parse RSS 2.0 or Atom into items, newest first as the feed lists them. */
const siteHost = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^(www|old|new)\./, "");
  } catch {
    return "";
  }
};

export function parseFeed(xml: string, feedUrl: string, currency = "USD"): FeedItem[] {
  const feedHost = siteHost(feedUrl);
  const chunks = [...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].map((m) => m[2]);
  return chunks.map((c) => {
    const title = (tagText(c, "title") ?? "").replace(/<[^>]+>/g, "").trim();
    const atomLink = c.match(/<link[^>]+href=["']([^"']+)["'][^>]*\/?>/i)?.[1];
    const link = decodeEntities(atomLink ?? tagText(c, "link") ?? "");
    const id = tagText(c, "guid") ?? tagText(c, "id") ?? link ?? title;
    const body = decodeEntities(cdata(c.match(/<(content|description|summary)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/i)?.[2] ?? ""));
    // Skip links back to the feed's own site or the post's site (author profiles, comments, images).
    const own = [feedHost, siteHost(link)].filter(Boolean);
    const dealUrl = [...body.matchAll(/href=["']([^"']+)["']/gi)]
      .map((m) => decodeEntities(m[1]))
      .find((u) => {
        try {
          const h = siteHost(u);
          return /^https?:$/.test(new URL(u).protocol) && !own.some((o) => h === o || h.endsWith(`.${o}`)) && !/(redd\.it|redditmedia\.com|redditstatic\.com|imgur\.com)$/.test(h);
        } catch {
          return false;
        }
      });
    return { id, title, link, dealUrl, published: tagText(c, "pubDate") ?? tagText(c, "updated") ?? tagText(c, "published"), price: priceFromText(title, currency) };
  });
}

/** Does a feed item match the watch's words? All of `keywords` (any spelling of case), none of `exclude`. */
export function matchesKeywords(title: string, keywords: string[] = [], exclude: string[] = []): boolean {
  const t = title.toLowerCase();
  const norm = (k: string) => k.trim().toLowerCase();
  return keywords.filter(Boolean).every((k) => t.includes(norm(k))) && !exclude.filter(Boolean).some((k) => t.includes(norm(k)));
}
