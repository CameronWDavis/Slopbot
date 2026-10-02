// A small local ledger: import bank CSVs, categorize, and summarize. Data stays in <workspace>/ledger.json.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { obj, safePath, type Tool, type ToolContext } from "./types.js";

export interface Txn {
  id: string;
  date: string; // YYYY-MM-DD
  description: string;
  amount: number; // negative = money out
  category: string;
  account?: string;
  source?: string;
}

interface Rule {
  match: string; // case-insensitive substring of description
  category: string;
}

interface Ledger {
  transactions: Txn[];
  rules: Rule[];
}

// Starter rules; user rules (added via finance.categorize) take precedence.
const DEFAULT_RULES: Rule[] = [
  ...["payroll", "direct dep", "salary"].map((m) => ({ match: m, category: "Income" })),
  ...["whole foods", "trader joe", "safeway", "kroger", "aldi", "costco", "grocery", "heb", "publix"].map((m) => ({ match: m, category: "Groceries" })),
  ...["doordash", "uber eats", "grubhub", "restaurant", "cafe", "coffee", "starbucks", "chipotle", "mcdonald"].map((m) => ({ match: m, category: "Dining" })),
  ...["uber", "lyft", "shell", "chevron", "exxon", "gas", "parking", "transit", "metro"].map((m) => ({ match: m, category: "Transport" })),
  ...["netflix", "spotify", "hulu", "disney+", "youtube premium", "apple.com/bill", "icloud", "openai", "anthropic", "github"].map((m) => ({ match: m, category: "Subscriptions" })),
  ...["rent", "mortgage"].map((m) => ({ match: m, category: "Housing" })),
  ...["electric", "water", "comcast", "xfinity", "verizon", "at&t", "t-mobile", "internet"].map((m) => ({ match: m, category: "Utilities" })),
  ...["amazon", "target", "walmart", "best buy"].map((m) => ({ match: m, category: "Shopping" })),
  ...["transfer", "zelle", "venmo"].map((m) => ({ match: m, category: "Transfers" })),
];

function ledgerPath(ctx: ToolContext) {
  return path.join(ctx.roots[0], "ledger.json");
}

export function readLedger(ctx: ToolContext): Ledger {
  try {
    return JSON.parse(fs.readFileSync(ledgerPath(ctx), "utf8"));
  } catch {
    return { transactions: [], rules: [] };
  }
}

function writeLedger(ctx: ToolContext, ledger: Ledger) {
  fs.mkdirSync(ctx.roots[0], { recursive: true });
  ledger.transactions.sort((a, b) => a.date.localeCompare(b.date));
  fs.writeFileSync(ledgerPath(ctx), JSON.stringify(ledger, null, 2));
}

export function categorize(description: string, rules: Rule[]): string {
  const d = description.toLowerCase();
  return rules.find((r) => d.includes(r.match.toLowerCase()))?.category ?? "Uncategorized";
}

/** RFC-4180-ish CSV parser (quotes, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") row.push(field), (field = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field), rows.push(row), (row = []), (field = "");
    } else field += c;
  }
  if (field || row.length) row.push(field), rows.push(row);
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

export function normalizeDate(s: string): string {
  s = s.trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/); // US M/D/Y
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  throw new Error(`Unrecognized date "${s}"`);
}

const parseAmount = (s: string) => {
  if (!s || !s.trim()) return 0;
  const neg = /^\(.*\)$/.test(s.trim()) || s.includes("-");
  const n = parseFloat(s.replace(/[^0-9.]/g, ""));
  return isNaN(n) ? 0 : neg ? -n : n;
};

const findCol = (headers: string[], names: string[]) =>
  headers.findIndex((h) => names.some((n) => h.toLowerCase().trim() === n));

const money = (n: number) => (n < 0 ? "-" : "") + "$" + Math.abs(n).toFixed(2);

export const financeTools: Tool[] = [
  {
    name: "finance.import_csv",
    description:
      "Import transactions from a bank or credit-card CSV export into the ledger. Auto-detects Date/Description/Amount (or Debit/Credit) columns. Skips duplicates. Set invert=true for card exports where purchases are positive.",
    risk: "write",
    parameters: obj(
      {
        path: { type: "string", description: "CSV file path" },
        account: { type: "string", description: "Account label, e.g. 'Chase Checking'" },
        invert: { type: "boolean", description: "Flip signs (purchases positive in source)" },
      },
      ["path"],
    ),
    async run({ path: p, account, invert = false }, ctx) {
      const rows = parseCsv(fs.readFileSync(safePath(ctx, p), "utf8"));
      if (rows.length < 2) throw new Error("CSV has no data rows");
      const headers = rows[0];
      const di = findCol(headers, ["date", "transaction date", "posted date", "posting date", "trans. date"]);
      const desc = findCol(headers, ["description", "name", "payee", "memo", "merchant", "details"]);
      const ai = findCol(headers, ["amount", "transaction amount"]);
      const debit = findCol(headers, ["debit", "withdrawal", "withdrawals"]);
      const credit = findCol(headers, ["credit", "deposit", "deposits"]);
      const cat = findCol(headers, ["category"]);
      if (di < 0 || desc < 0 || (ai < 0 && debit < 0)) {
        throw new Error(`Couldn't detect columns. Headers: ${headers.join(" | ")}`);
      }

      const ledger = readLedger(ctx);
      const rules = [...ledger.rules, ...DEFAULT_RULES];
      const existing = new Set(ledger.transactions.map((t) => t.id));
      const seen = new Map<string, number>();
      let added = 0;
      let dupes = 0;
      const errors: string[] = [];

      for (const r of rows.slice(1)) {
        try {
          const date = normalizeDate(r[di]);
          const description = r[desc].trim();
          let amount = ai >= 0 ? parseAmount(r[ai]) : parseAmount(r[credit] ?? "") - Math.abs(parseAmount(r[debit] ?? ""));
          if (invert) amount = -amount;
          // Same date/desc/amount twice in one file is legitimate (two coffees); number them.
          const key = `${account ?? ""}|${date}|${description}|${amount}`;
          const n = (seen.get(key) ?? 0) + 1;
          seen.set(key, n);
          const id = crypto.createHash("sha1").update(`${key}|${n}`).digest("hex").slice(0, 12);
          if (existing.has(id)) {
            dupes++;
            continue;
          }
          ledger.transactions.push({
            id,
            date,
            description,
            amount: Math.round(amount * 100) / 100,
            category: (cat >= 0 && r[cat]?.trim()) || categorize(description, rules),
            account,
            source: path.basename(p),
          });
          existing.add(id);
          added++;
        } catch (e: any) {
          if (errors.length < 5) errors.push(e.message);
        }
      }
      writeLedger(ctx, ledger);
      return `Imported ${added} transactions (${dupes} duplicates skipped). Ledger now has ${ledger.transactions.length}.${
        errors.length ? `\nRow errors: ${errors.join("; ")}` : ""
      }`;
    },
  },
  {
    name: "finance.add",
    description: "Add a single transaction manually (negative amount = spending).",
    risk: "write",
    parameters: obj(
      {
        date: { type: "string", description: "YYYY-MM-DD" },
        description: { type: "string" },
        amount: { type: "number" },
        category: { type: "string" },
        account: { type: "string" },
      },
      ["date", "description", "amount"],
    ),
    async run({ date, description, amount, category, account }, ctx) {
      const ledger = readLedger(ctx);
      const t: Txn = {
        id: crypto.randomBytes(6).toString("hex"),
        date: normalizeDate(date),
        description,
        amount,
        category: category ?? categorize(description, [...ledger.rules, ...DEFAULT_RULES]),
        account,
        source: "manual",
      };
      ledger.transactions.push(t);
      writeLedger(ctx, ledger);
      return `Added ${t.date} ${t.description} ${money(t.amount)} [${t.category}]`;
    },
  },
  {
    name: "finance.query",
    description: "List transactions filtered by date range, category, and/or description text.",
    risk: "read",
    parameters: obj({
      from: { type: "string", description: "YYYY-MM-DD inclusive" },
      to: { type: "string", description: "YYYY-MM-DD inclusive" },
      category: { type: "string" },
      text: { type: "string", description: "Substring of description" },
      limit: { type: "integer", description: "Default 100" },
    }),
    async run({ from, to, category, text, limit = 100 }, ctx) {
      const txns = readLedger(ctx).transactions.filter(
        (t) =>
          (!from || t.date >= from) &&
          (!to || t.date <= to) &&
          (!category || t.category.toLowerCase() === String(category).toLowerCase()) &&
          (!text || t.description.toLowerCase().includes(String(text).toLowerCase())),
      );
      const total = txns.reduce((s, t) => s + t.amount, 0);
      const lines = txns.slice(-limit).map((t) => `${t.date}  ${money(t.amount).padStart(11)}  ${t.category.padEnd(14)} ${t.description}`);
      return `${txns.length} transactions, net ${money(total)}${txns.length > limit ? ` (showing last ${limit})` : ""}\n${lines.join("\n")}`;
    },
  },
  {
    name: "finance.summary",
    description: "Summarize income and spending, grouped by category or by month, over an optional date range.",
    risk: "read",
    parameters: obj({
      from: { type: "string" },
      to: { type: "string" },
      group_by: { type: "string", enum: ["category", "month"], description: "Default category" },
    }),
    async run({ from, to, group_by = "category" }, ctx) {
      const txns = readLedger(ctx).transactions.filter((t) => (!from || t.date >= from) && (!to || t.date <= to));
      if (!txns.length) return "No transactions in range. Import a CSV with finance.import_csv first.";
      const isTransfer = (t: Txn) => t.category === "Transfers";
      const income = txns.filter((t) => t.amount > 0 && !isTransfer(t)).reduce((s, t) => s + t.amount, 0);
      const spend = txns.filter((t) => t.amount < 0 && !isTransfer(t)).reduce((s, t) => s + t.amount, 0);
      const groups = new Map<string, { total: number; count: number }>();
      for (const t of txns) {
        const k = group_by === "month" ? t.date.slice(0, 7) : t.category;
        const g = groups.get(k) ?? { total: 0, count: 0 };
        g.total += t.amount;
        g.count++;
        groups.set(k, g);
      }
      const sorted = [...groups.entries()].sort((a, b) =>
        group_by === "month" ? a[0].localeCompare(b[0]) : a[1].total - b[1].total,
      );
      const range = `${txns[0].date} → ${txns[txns.length - 1].date}`;
      return [
        `Range: ${range} (${txns.length} transactions)`,
        `Income: ${money(income)}   Spending: ${money(spend)}   Net: ${money(income + spend)} (transfers excluded)`,
        "",
        ...sorted.map(([k, g]) => `${k.padEnd(16)} ${money(g.total).padStart(12)}  (${g.count})`),
      ].join("\n");
    },
  },
  {
    name: "finance.categorize",
    description:
      "Add a categorization rule (description contains `match` → `category`) and re-apply it to existing matching transactions.",
    risk: "write",
    parameters: obj({ match: { type: "string" }, category: { type: "string" } }, ["match", "category"]),
    async run({ match, category }, ctx) {
      const ledger = readLedger(ctx);
      ledger.rules = [{ match, category }, ...ledger.rules.filter((r) => r.match.toLowerCase() !== match.toLowerCase())];
      let n = 0;
      for (const t of ledger.transactions) {
        if (t.description.toLowerCase().includes(match.toLowerCase()) && t.category !== category) {
          t.category = category;
          n++;
        }
      }
      writeLedger(ctx, ledger);
      return `Rule saved. Recategorized ${n} transactions as ${category}.`;
    },
  },
];
