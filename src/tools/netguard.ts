// Network guard for bot-initiated HTTP requests.
//  - Private destinations (loopback, LAN, link-local/cloud metadata, …) are blocked unless the user
//    lists them in config `network.allowPrivate`. The check runs on the *resolved* IP at connect
//    time, so a public-looking name that resolves to a private address (DNS rebinding) is caught.
//  - Which public sites a bot may contact without asking is decided by `network.allow` lists
//    (see policy in http.ts); everything else goes through approval.
import dns from "node:dns";
import net from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
}
const V4_PRIVATE: [string, number][] = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (incl. cloud metadata 169.254.169.254)
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];

/** "::ffff:127.0.0.1" → eight 16-bit groups. Null if malformed. */
function expandIpv6(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0];
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const n = ipv4ToInt(v4[1]);
    s = s.slice(0, -v4[1].length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const a = head ? head.split(":") : [];
  const b = tail !== undefined ? (tail ? tail.split(":") : []) : null;
  const groups = b === null ? a : [...a, ...Array(8 - a.length - b.length).fill("0"), ...b];
  if (groups.length !== 8) return null;
  const nums = groups.map((x) => parseInt(x || "0", 16));
  return nums.some((x) => Number.isNaN(x) || x > 0xffff) ? null : nums;
}

/** True for any address that isn't a normal public internet host. */
export function isPrivateIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const n = ipv4ToInt(ip);
    return V4_PRIVATE.some(([base, bits]) => (n >>> (32 - bits)) === (ipv4ToInt(base) >>> (32 - bits)));
  }
  if (v === 6) {
    const g = expandIpv6(ip.replace(/^\[|\]$/g, ""));
    if (!g) return true;
    // IPv4-mapped (::ffff:a.b.c.d, also written ::ffff:7f00:1) and IPv4-compatible (::a.b.c.d)
    if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
      if (g[5] === 0 && g[6] === 0 && g[7] <= 1) return true; // :: and ::1
      return isPrivateIp(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
    }
    if (g[0] === 0x64 && g[1] === 0xff9b) return isPrivateIp(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`); // NAT64
    if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((g[0] & 0xff00) === 0xff00) return true; // multicast
    return false;
  }
  return true; // not an IP at all: treat as unsafe
}

/** Does `host` match an allow-list entry? "example.com" also covers subdomains; "*.example.com" too. */
export function hostMatches(host: string, entries: readonly string[] = []): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return entries.some((raw) => {
    const e = raw.trim().toLowerCase().replace(/^\*\./, "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    return !!e && (h === e || h.endsWith(`.${e}`));
  });
}

/** `network.allowPrivate` entries are "host" or "host:port" (e.g. "127.0.0.1:5299", "nas.local"). */
export function privateAllowed(url: URL, entries: readonly string[] = []): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return entries.some((raw) => {
    const e = raw.trim().toLowerCase();
    const m = e.match(/^\[?([^\]]+?)\]?(?::(\d+))?$/);
    if (!m) return false;
    return m[1] === host && (!m[2] || m[2] === port);
  });
}

export class BlockedDestinationError extends Error {}

/**
 * fetch() that refuses private destinations unless allowed. Returns the response and a close()
 * to release the connection pool.
 */
export function guardedFetcher(url: URL, allowPrivate: readonly string[]) {
  const allowed = privateAllowed(url, allowPrivate);
  const check = (address: string, host: string) => {
    if (!allowed && isPrivateIp(address)) {
      throw new BlockedDestinationError(
        `Blocked: ${host} is on a private or local network (${address}). Bots can't reach local services unless you add "${host}" to network.allowPrivate in slopbot.config.yaml.`,
      );
    }
  };
  const agent = new Agent({
    connect: {
      // Validate the address actually being connected to (defeats DNS rebinding).
      lookup(hostname: string, options: any, callback: any) {
        dns.lookup(hostname, { ...options, all: true }, (err, addrs: dns.LookupAddress[]) => {
          if (err) return callback(err);
          try {
            for (const a of addrs) check(a.address, hostname);
          } catch (e) {
            return callback(e);
          }
          if (options?.all) callback(null, addrs);
          else callback(null, addrs[0].address, addrs[0].family);
        });
      },
    },
  });
  const fetchOne = async (target: URL, init: RequestInit) => {
    const literal = target.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(literal)) check(literal, literal); // IP literals skip DNS, so check them here
    else if (!allowed && /^(localhost|.*\.localhost)$/i.test(literal)) check("127.0.0.1", literal);
    try {
      return (await undiciFetch(target, { ...(init as any), dispatcher: agent })) as unknown as Response;
    } catch (e: any) {
      // undici wraps connect-time errors as "fetch failed"; surface our block reason instead.
      for (let c = e; c; c = c.cause) if (c instanceof BlockedDestinationError) throw c;
      throw e;
    }
  };
  return { fetch: fetchOne, close: () => agent.close().catch(() => {}) };
}
