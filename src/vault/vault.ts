// Credential vault: an AES-256-GCM encrypted file whose key lives in the OS secret store
// (macOS Keychain). Copying the file to another machine is useless without this machine's key.
//
// Bots can USE entries but never READ them: the model sees names, kinds, domains and usernames;
// secrets are injected into requests by the runtime, only for the entry's own domains, and are
// scrubbed from anything that flows back to the model.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SecretStore } from "../secrets.js";

export type VaultKind = "api_key" | "login";
/** How an api_key is attached to requests. Logins use HTTP Basic. */
export type SendAs = "bearer" | "header" | "query";

export interface VaultEntry {
  id: string;
  name: string;
  kind: VaultKind;
  /** Sites this credential may be sent to (subdomains included). */
  domains: string[];
  username?: string;
  sendAs?: SendAs;
  /** Header name (sendAs "header") or query parameter name (sendAs "query"). */
  field?: string;
  /** Which bots may use it; ["*"] = all. */
  bots: string[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  secret: string;
}

/** What the UI and the model get: everything except the secret. */
export type VaultEntryInfo = Omit<VaultEntry, "secret"> & { hasSecret: boolean };

const AAD = Buffer.from("slopbot-vault-v1");

export class VaultLockedError extends Error {}

/** "https://www.GitHub.com/login" → "github.com"; "*.example.com" → "example.com". */
export function normalizeDomain(d: string): string {
  let s = d.trim().toLowerCase();
  if (!s) return "";
  try {
    if (/^[a-z]+:\/\//.test(s)) s = new URL(s).hostname;
  } catch {}
  return s.replace(/^\*\./, "").replace(/^www\./, "").replace(/[/:].*$/, "");
}

export function domainAllowed(url: string, domains: string[]): boolean {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && !/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) return false; // never send secrets in clear text
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some((d) => d && (host === d || host.endsWith(`.${d}`) || host === `www.${d}`));
}

export class Vault {
  private cachedKey?: Buffer;
  /** Random per-vault id (stored in the clear in the file); its key is `vault.key.<id>` in the secret store. */
  private vaultId?: string;

  constructor(
    readonly file: string,
    private secrets: SecretStore,
  ) {}

  /** The key's name in the secret store. Each vault has its own, so vaults never share or clobber keys. */
  get keyName() {
    return `vault.key.${this.vaultId}`;
  }

  private key(create: boolean): Buffer {
    if (this.cachedKey) return this.cachedKey;
    if (!this.vaultId) {
      if (!create) throw new VaultLockedError("Vault has no id");
      this.vaultId = crypto.randomBytes(8).toString("hex");
    }
    const stored = this.secrets.get(this.keyName);
    if (stored) return (this.cachedKey = Buffer.from(stored, "base64"));
    if (!create) {
      throw new VaultLockedError(
        "The vault's key isn't in this computer's Keychain, so it can't be opened here. (Vaults only open on the machine that created them.)",
      );
    }
    const k = crypto.randomBytes(32);
    this.secrets.set(this.keyName, k.toString("base64"));
    return (this.cachedKey = k);
  }

  private load(): VaultEntry[] {
    if (!fs.existsSync(this.file)) return [];
    const box = JSON.parse(fs.readFileSync(this.file, "utf8"));
    if (box.v !== 1 || box.alg !== "aes-256-gcm" || !/^[0-9a-f]{16}$/.test(box.id ?? "")) throw new Error("Unknown vault format");
    this.vaultId = box.id;
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key(false), Buffer.from(box.iv, "base64"));
    decipher.setAAD(AAD);
    decipher.setAuthTag(Buffer.from(box.tag, "base64"));
    try {
      const plain = Buffer.concat([decipher.update(Buffer.from(box.data, "base64")), decipher.final()]);
      return JSON.parse(plain.toString("utf8"));
    } catch {
      throw new VaultLockedError("The vault couldn't be decrypted: it was modified, or it belongs to another computer.");
    }
  }

  private save(entries: VaultEntry[]) {
    if (!this.vaultId && fs.existsSync(this.file)) this.load(); // adopt the existing vault's id
    const key = this.key(true);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(AAD);
    const data = Buffer.concat([cipher.update(JSON.stringify(entries), "utf8"), cipher.final()]);
    const box = { v: 1, id: this.vaultId, alg: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(box), { mode: 0o600 });
    fs.renameSync(`${this.file}.tmp`, this.file);
  }

  /** Entries without secrets. With `bot`, only the ones that bot may use. */
  list(bot?: string): VaultEntryInfo[] {
    return this.load()
      .filter((e) => !bot || e.bots.includes("*") || e.bots.includes(bot))
      .map(({ secret, ...info }) => ({ ...info, hasSecret: !!secret }));
  }

  /**
   * Create or update an entry. Omit `secret` (or pass "") when editing to keep the stored one.
   */
  upsert(input: Partial<VaultEntry> & { name: string; kind: VaultKind }): VaultEntryInfo {
    const entries = this.load();
    const now = new Date().toISOString();
    const name = input.name.trim();
    if (!/^[\w .@-]{1,60}$/.test(name)) throw new Error("Name: letters, numbers, spaces, . @ - _ (max 60)");
    const domains = [...new Set((input.domains ?? []).map(normalizeDomain).filter(Boolean))];
    if (!domains.length) throw new Error("Add at least one website (domain) this credential is for");
    const existing = input.id ? entries.find((e) => e.id === input.id) : undefined;
    if (entries.some((e) => e.name.toLowerCase() === name.toLowerCase() && e.id !== existing?.id)) throw new Error(`There's already an entry named "${name}"`);
    const secret = input.secret || existing?.secret || "";
    if (!secret) throw new Error(input.kind === "login" ? "Enter the password" : "Enter the key");
    const entry: VaultEntry = {
      id: existing?.id ?? crypto.randomBytes(6).toString("hex"),
      name,
      kind: input.kind,
      domains,
      username: input.kind === "login" ? input.username?.trim() || undefined : undefined,
      sendAs: input.kind === "api_key" ? (input.sendAs ?? "bearer") : undefined,
      field: input.kind === "api_key" && input.sendAs && input.sendAs !== "bearer" ? input.field?.trim() || undefined : undefined,
      bots: input.bots?.length ? input.bots : ["*"],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastUsedAt: existing?.lastUsedAt,
      secret,
    };
    if (entry.kind === "api_key" && entry.sendAs !== "bearer" && !entry.field) throw new Error(`Enter the ${entry.sendAs === "query" ? "query parameter" : "header"} name`);
    this.save(existing ? entries.map((e) => (e.id === existing.id ? entry : e)) : [...entries, entry]);
    const { secret: _, ...info } = entry;
    return { ...info, hasSecret: true };
  }

  remove(id: string) {
    const entries = this.load();
    this.save(entries.filter((e) => e.id !== id));
  }

  /**
   * Resolve a credential for one request. Enforces bot access and domain binding, and returns
   * what to attach plus the strings to scrub from the response.
   */
  credentialFor(ref: string, url: string, bot: string): { entry: VaultEntryInfo; headers: Record<string, string>; url: string; redact: string[] } {
    const entries = this.load();
    const e = entries.find((x) => x.id === ref) ?? entries.find((x) => x.name.toLowerCase() === ref.toLowerCase());
    if (!e) throw new Error(`No vault entry "${ref}". Use vault.list to see what's available.`);
    if (!e.bots.includes("*") && !e.bots.includes(bot)) throw new Error(`The vault entry "${e.name}" isn't shared with this bot.`);
    if (!domainAllowed(url, e.domains)) {
      throw new Error(`"${e.name}" may only be sent to ${e.domains.join(", ")} over https, not to ${safeHost(url)}. Not sent.`);
    }
    const headers: Record<string, string> = {};
    let finalUrl = url;
    const redact = [e.secret];
    if (e.kind === "login") {
      const basic = Buffer.from(`${e.username ?? ""}:${e.secret}`).toString("base64");
      headers.authorization = `Basic ${basic}`;
      redact.push(basic);
    } else if (e.sendAs === "header") headers[e.field!.toLowerCase()] = e.secret;
    else if (e.sendAs === "query") {
      const u = new URL(url);
      u.searchParams.set(e.field!, e.secret);
      finalUrl = u.toString();
      redact.push(encodeURIComponent(e.secret));
    } else headers.authorization = `Bearer ${e.secret}`;

    e.lastUsedAt = new Date().toISOString();
    this.save(entries);
    const { secret, ...info } = e;
    return { entry: { ...info, hasSecret: true }, headers, url: finalUrl, redact: redact.filter((r) => r.length >= 4) };
  }
}

function safeHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return "an invalid URL";
  }
}

/** Replace every occurrence of the given secrets in `text`. */
export function scrub(text: string, secrets: string[], label: string): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join(`[vault:${label}]`);
  return out;
}
