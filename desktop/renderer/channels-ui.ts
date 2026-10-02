// Channels tab: connect a Telegram bot and lock it to your own account.
import type { SlopbotApi, TelegramStatus } from "../api.js";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const cleanError = (e: any) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

export function createChannels(api: SlopbotApi, getBots: () => string[]) {
  let st: TelegramStatus | null = null;
  let err = "";
  let countdown: number | undefined;

  api.onTelegramStatus((s) => {
    st = s;
    if (!$("view-channels").hidden) render();
  });

  async function load() {
    st = await api.telegramStatus();
    render();
  }

  async function act(fn: () => Promise<unknown>) {
    err = "";
    try {
      await fn();
    } catch (e) {
      err = cleanError(e);
    }
    await load();
  }

  function step(n: number, title: string, done: boolean, body: HTMLElement[]) {
    const s = el("div", `tg-step${done ? " done" : ""}`);
    const head = el("div", "tg-step-head");
    head.append(el("span", "tg-num", done ? "✓" : String(n)), el("span", "tg-title", title));
    s.append(head, ...body);
    return s;
  }

  function render() {
    if (!st) return;
    const s = st;
    clearInterval(countdown);
    const card = el("div", "card telegram-card");
    const head = el("div", "card-head");
    head.append(
      el("span", `dot ${s.running ? "" : s.configured ? "alert" : "off"}`),
      el("span", "connector-name", "Telegram"),
      el("span", "connector-where", s.running ? `running as @${s.botUsername}` : s.configured ? "stopped" : "not set up"),
    );
    if (s.configured) {
      const sw = el("label", "switch");
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = s.enabled;
      cb.addEventListener("change", () => act(() => api.telegramSetEnabled(cb.checked)));
      sw.append(cb, el("span", "slider"));
      sw.title = "Turn the Telegram channel on or off";
      head.append(sw);
    }
    card.append(head);
    if (err || s.error) card.append(el("div", "connector-error", err || s.error!));

    // 1. Bot token
    const s1: HTMLElement[] = [];
    if (s.configured) {
      const row = el("div", "tg-row");
      row.append(el("span", "", `Connected to `), Object.assign(el("strong", "", `@${s.botUsername}`)));
      const remove = el("button", "ghost small", "Remove bot");
      remove.addEventListener("click", () => confirm("Disconnect this Telegram bot from SlopBot? You'll need to link again.") && act(() => api.telegramRemoveToken()));
      row.append(remove);
      s1.push(row);
    } else {
      const how = el("ol", "tg-how");
      const li1 = el("li");
      const bf = el("a", "", "@BotFather");
      bf.href = "https://t.me/BotFather";
      bf.target = "_blank";
      li1.append(document.createTextNode("In Telegram, open "), bf, document.createTextNode(" and send /newbot"));
      how.append(li1, el("li", "", "Pick a name and a username for your bot"), el("li", "", "Copy the token it gives you and paste it here"));
      const row = el("div", "tg-row");
      const input = el("input");
      input.type = "password";
      input.placeholder = "123456789:AAH…";
      input.spellcheck = false;
      const go = el("button", "primary small", "Connect");
      const submit = () => input.value.trim() && act(() => api.telegramSetToken(input.value));
      go.addEventListener("click", submit);
      input.addEventListener("keydown", (e) => e.key === "Enter" && submit());
      row.append(input, go);
      s1.push(how, row, el("div", "muted small-text", "The token is stored in your Keychain."));
    }
    card.append(step(1, "Create your bot", s.configured, s1));

    // 2. Link your account
    const s2: HTMLElement[] = [];
    if (!s.configured) s2.push(el("div", "muted small-text", "Connect a bot first."));
    else if (s.linked) {
      const row = el("div", "tg-row");
      row.append(el("span", "", `Only `), el("strong", "", s.ownerName ?? "your account"), el("span", "", " can talk to it."));
      const unlink = el("button", "ghost small", "Unlink");
      unlink.addEventListener("click", () => confirm("Unlink your Telegram account? The bot will ignore everyone until you link again.") && act(async () => api.telegramUnlink()));
      row.append(unlink);
      s2.push(row);
    } else if (s.pairing) {
      const code = el("div", "tg-code", `${s.pairing.code.slice(0, 3)} ${s.pairing.code.slice(3)}`);
      const row = el("div", "tg-row");
      if (s.pairing.link) {
        const open = el("a", "primary small tg-open", `Open @${s.botUsername} in Telegram ↗`);
        open.href = s.pairing.link;
        open.target = "_blank";
        row.append(open);
      }
      row.append(el("span", "muted small-text", `or send /link ${s.pairing.code} to @${s.botUsername}`));
      const timer = el("div", "muted small-text");
      const tick = () => {
        const left = Math.max(0, Math.round((s.pairing!.expiresAt - Date.now()) / 1000));
        timer.textContent = left ? `Waiting for you… code expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "Code expired.";
        if (!left) clearInterval(countdown);
      };
      tick();
      countdown = window.setInterval(tick, 1000);
      s2.push(code, row, timer);
    } else {
      const pair = el("button", "primary small", "Link my Telegram account");
      pair.addEventListener("click", () => act(() => api.telegramPair()));
      s2.push(el("div", "muted small-text", "You'll get a one-time code. The first account to send it becomes the only one the bot answers."), pair);
    }
    card.append(step(2, "Link your account", s.linked, s2));

    // 3. Settings
    const s3: HTMLElement[] = [];
    const row = el("div", "tg-row");
    const sel = el("select", "bot-select");
    for (const b of getBots()) sel.append(Object.assign(el("option", "", b), { value: b, selected: b === s.defaultBot }));
    if (!s.defaultBot) sel.selectedIndex = 0;
    sel.addEventListener("change", () => act(() => api.telegramSetDefaultBot(sel.value)));
    row.append(el("span", "", "Messages go to"), sel, el("span", "muted small-text", "(switch anytime with /bot name)"));
    s3.push(row);
    s3.push(
      el(
        "div",
        "muted small-text",
        `Approvals come to your phone as Approve / Deny buttons. Schedules with "notify: telegram" send their reports here.${s.rejected ? ` Ignored ${s.rejected} message${s.rejected === 1 ? "" : "s"} from other accounts since start.` : ""}`,
      ),
    );
    card.append(step(3, "Use it", s.linked, s3));

    const note = el("div", "tg-note");
    note.append(
      el("strong", "", "Locked down: "),
      document.createTextNode(
        "the bot only answers the linked account in its private chat, and ignores everyone else without replying, including group chats. Wrong codes burn the code after 5 tries. Telegram bot chats aren't end-to-end encrypted, so don't paste passwords there. Your vault secrets are never sent.",
      ),
    );
    card.append(note);
    $("channels").replaceChildren(card);
  }

  return { load };
}
