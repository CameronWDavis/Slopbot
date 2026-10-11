/** The registrable site for a host: shop.example.com → example.com, www.amazon.co.uk → amazon.co.uk. */
export function siteOf(host: string): string {
  if (/^[\d.]+$|:/.test(host)) return host.toLowerCase(); // an IP address is its own site
  const parts = host.toLowerCase().replace(/\.$/, "").split(".");
  if (parts.length <= 2) return parts.join(".");
  const [sld, tld] = parts.slice(-2);
  const keep = tld.length === 2 && /^(co|com|net|org|gov|ac|edu|ne|or|go)$/.test(sld) ? 3 : 2;
  return parts.slice(-keep).join(".");
}

/**
 * One key per product, whatever source pointed at it: site + path, without tracking parameters.
 * Amazon listings collapse to their ASIN.
 */
export function dealKey(u: string): string {
  try {
    const url = new URL(u);
    const site = siteOf(url.hostname);
    const asin = url.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1];
    if (site.startsWith("amazon.") && asin) return `${site}/dp/${asin.toUpperCase()}`;
    const keep = [...url.searchParams].filter(([k]) => /^(sku|skuid|item|itemid|id|pid|product|productid|p|v|variant)$/i.test(k)).sort();
    const q = keep.length ? `?${keep.map(([k, v]) => `${k.toLowerCase()}=${v}`).join("&")}` : "";
    return `${site}${url.pathname.replace(/\/+$/, "").toLowerCase()}${q}`;
  } catch {
    return u;
  }
}
