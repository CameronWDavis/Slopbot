import fs from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";
import type { Config } from "../config.js";
import { obj, type Tool } from "./types.js";

export async function sendMail(config: Config, msg: { to?: string; subject: string; body: string; html?: boolean }) {
  const smtp = config.smtp;
  if (!smtp) throw new Error("SMTP is not configured (add an `smtp:` section to slopbot.config.yaml)");
  const to = msg.to || smtp.to;
  if (!to) throw new Error("No recipient: pass `to` or set smtp.to in config");
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port ?? 587,
    secure: smtp.secure ?? smtp.port === 465,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
  });
  const info = await transport.sendMail({
    from: smtp.from,
    to,
    subject: msg.subject,
    [msg.html ? "html" : "text"]: msg.body,
  });
  return `Sent to ${to} (message id ${info.messageId})`;
}

export const emailTools: Tool[] = [
  {
    name: "email.send",
    description:
      "Send an email via the user's SMTP account. If `to` is omitted it goes to the user themself. Requires approval by default.",
    risk: "external",
    parameters: obj(
      {
        to: { type: "string", description: "Recipient address (default: the user)" },
        subject: { type: "string" },
        body: { type: "string", description: "Plain text, or HTML if html=true" },
        html: { type: "boolean" },
      },
      ["subject", "body"],
    ),
    async run(args, ctx) {
      return sendMail(ctx.config, args);
    },
  },
  {
    name: "email.draft",
    description: "Save an email draft to the outbox folder in your workspace without sending it.",
    risk: "write",
    parameters: obj(
      { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
      ["subject", "body"],
    ),
    async run({ to = "", subject, body }, ctx) {
      const dir = path.join(ctx.roots[0], "outbox");
      fs.mkdirSync(dir, { recursive: true });
      const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
      const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}-${slug}.eml.txt`);
      fs.writeFileSync(file, `To: ${to}\nSubject: ${subject}\n\n${body}\n`);
      return `Draft saved to ${file}`;
    },
  },
];
