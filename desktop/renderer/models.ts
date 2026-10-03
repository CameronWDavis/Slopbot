// Models view: run open-source models locally with Ollama. Start/stop it, pull models with
// progress, and make one the default or give it to a specific bot, all in one click.
import type { OllamaModel, OllamaStatus, PullProgress, SlopbotApi } from "../api.js";

interface CatalogEntry {
  name: string;
  gb: number; // download size (from the Ollama registry)
  blurb: string;
  pick?: boolean;
}

// Sizes are the real download sizes from registry.ollama.ai.
const CATALOG: CatalogEntry[] = [
  { name: "qwen3:8b", gb: 5.23, blurb: "Our pick: the best all-round model for bots at this size", pick: true },
  { name: "qwen3:4b", gb: 2.5, blurb: "Small and quick, good on 8–16 GB laptops" },
  { name: "llama3.2:3b", gb: 2.02, blurb: "Meta's smallest tool-calling model; the fastest option" },
  { name: "llama3.1:8b", gb: 4.92, blurb: "Meta's popular general-purpose model" },
  { name: "granite3.3:8b", gb: 4.94, blurb: "IBM's model aimed at business tasks and tool use" },
  { name: "qwen2.5-coder:7b", gb: 4.68, blurb: "Coding specialist, a good fit for the coder bot" },
  { name: "deepseek-r1:8b", gb: 5.23, blurb: "Reasons step by step before answering (slower)" },
  { name: "mistral-nemo:12b", gb: 7.07, blurb: "Mistral's 12B model with a long context window" },
  { name: "qwen3:14b", gb: 9.28, blurb: "Noticeably smarter than 8B if you have the memory" },
  { name: "gpt-oss:20b", gb: 13.79, blurb: "OpenAI's open-weight model" },
  { name: "qwen3-coder:30b", gb: 18.56, blurb: "Strong coding model for high-memory Macs" },
];

const GB = 1e9;
const fmtGB = (bytes: number) => `${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1)} GB`;

/** Rough memory fit: weights plus context/runtime overhead vs. total RAM. */
export function fit(sizeBytes: number, ramBytes: number): "good" | "tight" | "too-big" {
  const need = sizeBytes * 1.25 + 1.5 * GB;
  if (need <= ramBytes * 0.6) return "good";
  if (need <= ramBytes * 0.85) return "tight";
  return "too-big";
}
const FIT_LABEL = { good: "fits your Mac", tight: "tight fit", "too-big": "too big for this Mac" };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const cleanError = (e: any) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

export interface ModelsHooks {
  onConfigChanged: () => void; // default/bot model changed → refresh chat model picker etc.
  onWork: (state: "start" | "done" | "fail") => void; // drive the mascot during downloads
}

export function createModels(api: SlopbotApi, hooks: ModelsHooks) {
  let st: OllamaStatus | null = null;
  let busyMsg = "";
  const progress = new Map<string, PullProgress & { rate?: number; lastAt?: number; lastBytes?: number }>();

  api.onPullProgress((p) => {
    const prev = progress.get(p.model);
    const now = performance.now();
    let rate = prev?.rate;
    if (prev?.lastAt && p.completed > (prev.lastBytes ?? 0)) {
      const inst = ((p.completed - prev.lastBytes!) / (now - prev.lastAt)) * 1000;
      rate = rate ? rate * 0.8 + inst * 0.2 : inst;
    }
    progress.set(p.model, { ...p, rate, lastAt: now, lastBytes: p.completed });
    if (p.done || p.error) {
      setTimeout(() => {
        progress.delete(p.model);
        load();
      }, p.done ? 600 : 2500);
    }
    if (!$("view-models").hidden) renderPullBars();
  });

  async function load() {
    try {
      st = await api.ollamaStatus();
    } catch (e) {
      st = null;
    }
    render();
  }

  const ollamaRef = (m: string) => `${st?.provider ?? "ollama"}/${m}`;

  async function act(label: string, fn: () => Promise<unknown>, reloadConfig = false) {
    busyMsg = label;
    render();
    try {
      await fn();
      if (reloadConfig) hooks.onConfigChanged();
    } catch (e) {
      alertBox(cleanError(e));
    } finally {
      busyMsg = "";
      await load();
    }
  }

  function alertBox(msg: string) {
    const box = $("ollama-alert");
    box.textContent = msg;
    box.hidden = false;
    setTimeout(() => (box.hidden = true), 8000);
  }

  async function pull(model: string) {
    model = model.trim();
    if (!model) return;
    progress.set(model, { model, status: "starting", completed: 0, total: 0 });
    render();
    hooks.onWork("start");
    try {
      await api.ollamaPull(model);
      hooks.onWork("done");
      // If the default model isn't a local model you actually have, make this one the default
      // so bots work right away (a fresh install defaults to qwen3:8b, which may not be downloaded).
      const fresh = await api.ollamaStatus();
      const prefix = `${fresh.provider}/`;
      const current = fresh.defaultModel.startsWith(prefix) ? fresh.defaultModel.slice(prefix.length) : "";
      if (!current || !fresh.models.some((m) => m.name === current)) {
        await api.ollamaSetDefault(model);
        hooks.onConfigChanged();
      }
    } catch (e) {
      hooks.onWork("fail");
      const p = progress.get(model);
      if (p && !p.error) progress.set(model, { ...p, error: cleanError(e) });
      renderPullBars();
    }
  }

  // ── rendering ─────────────────────────────────────
  function statusCard(): HTMLElement {
    const card = el("div", "card ollama-status");
    const left = el("div", "ollama-status-text");
    const actions = el("div", "card-actions inline");
    if (!st) {
      left.append(el("strong", "", "Couldn't check Ollama."));
    } else if (st.running) {
      const line = el("div", "status-line");
      line.append(el("span", "dot"), el("strong", "", `Ollama ${st.version ?? ""} is running`), el("span", "muted", ` · ${fmtGB(st.ramBytes)} memory · ${st.baseUrl}`));
      left.append(line, el("div", "muted small-text", "Models run on this Mac. Nothing you type leaves it."));
      const stop = el("button", "ghost small", "Stop Ollama");
      stop.addEventListener("click", () => act("Stopping Ollama…", () => api.ollamaStop()));
      actions.append(stop);
    } else if (st.installed) {
      const line = el("div", "status-line");
      line.append(el("span", "dot off"), el("strong", "", "Ollama is stopped"));
      left.append(line, el("div", "muted small-text", "Start it to use and download local models."));
      const start = el("button", "primary small", "Start Ollama");
      start.addEventListener("click", () => act("Starting Ollama…", () => api.ollamaStart()));
      actions.append(start);
    } else {
      const line = el("div", "status-line");
      line.append(el("span", "dot alert"), el("strong", "", "Ollama isn't installed"));
      left.append(line, el("div", "muted small-text", "Ollama runs open-source models on your own computer: free, private, and offline. Install it, then come back."));
      const get = el("button", "primary small", "Get Ollama ↗");
      get.addEventListener("click", () => api.ollamaDownload());
      const again = el("button", "ghost small", "I installed it");
      again.addEventListener("click", () => act("Looking for Ollama…", () => api.ollamaStart()));
      actions.append(again, get);
    }
    if (busyMsg) left.append(el("div", "muted small-text", busyMsg));
    card.append(left, actions);
    return card;
  }

  function botSelect(model: string): HTMLSelectElement {
    const sel = el("select", "bot-select");
    sel.title = "Give this model to one bot";
    sel.append(Object.assign(el("option", "", "Use for bot…"), { value: "" }));
    for (const b of st?.bots ?? []) {
      const using = b.model === ollamaRef(model);
      sel.append(Object.assign(el("option", "", using ? `✓ ${b.name}` : b.name), { value: b.name }));
    }
    sel.addEventListener("change", () => {
      const bot = sel.value;
      if (!bot) return;
      const using = st?.bots.find((b) => b.name === bot)?.model === ollamaRef(model);
      act(using ? `${bot} back to the default model…` : `Giving ${model} to ${bot}…`, () => api.ollamaUseForBot(bot, using ? null : model), true);
    });
    return sel;
  }

  function installedCard(m: OllamaModel): HTMLElement {
    const card = el("div", "card model-card");
    const isDefault = st?.defaultModel === ollamaRef(m.name);
    const head = el("div", "card-head");
    head.append(el("span", "model-name", m.name));
    if (isDefault) head.append(el("span", "tag default-tag", "default"));
    const tools = m.capabilities?.includes("tools");
    if (m.capabilities) {
      const b = el("span", `tag ${tools ? "ok-tag" : "warn-tag"}`, tools ? "tools ✓" : "chat only");
      b.title = tools ? "Supports tool calling, so bots can use it fully" : "This model can't call tools; bots will only be able to chat with it";
      head.append(b);
    }
    if (m.capabilities?.includes("thinking")) head.append(el("span", "tag", "thinking"));
    if (m.capabilities?.includes("vision")) head.append(el("span", "tag", "vision"));
    if (m.loaded) head.append(el("span", "tag mem-tag", "in memory"));
    card.append(head);

    const meta = [m.parameterSize, m.quantization, fmtGB(m.size)].filter(Boolean).join(" · ");
    card.append(el("div", "muted small-text", meta));
    const users = (st?.bots ?? []).filter((b) => b.model === ollamaRef(m.name)).map((b) => b.name);
    const usedBy = isDefault ? ["every bot without its own model", ...users] : users;
    if (usedBy.length) card.append(el("div", "muted small-text", `Used by: ${usedBy.join(", ")}`));

    const actions = el("div", "card-actions");
    if (!isDefault) {
      const def = el("button", "primary small", "Set as default");
      def.addEventListener("click", () => act(`Making ${m.name} the default…`, () => api.ollamaSetDefault(m.name), true));
      actions.append(def);
    }
    actions.append(botSelect(m.name));
    if (m.loaded) {
      const un = el("button", "ghost small", "Unload");
      un.title = "Free the memory it's using now";
      un.addEventListener("click", () => act(`Unloading ${m.name}…`, () => api.ollamaUnload(m.name)));
      actions.append(un);
    }
    const del = el("button", "danger small", "Delete");
    del.addEventListener("click", () => {
      if (!confirm(`Delete ${m.name} (${fmtGB(m.size)}) from this Mac? You can download it again later.`)) return;
      act(`Deleting ${m.name}…`, () => api.ollamaDelete(m.name));
    });
    actions.append(del);
    card.append(actions);
    return card;
  }

  function pullBar(model: string): HTMLElement | null {
    const p = progress.get(model);
    if (!p) return null;
    const wrap = el("div", "pull");
    wrap.dataset.model = model;
    const pct = p.total ? Math.min(100, (p.completed / p.total) * 100) : 0;
    const bar = el("div", "pull-bar");
    const fill = el("div", `pull-fill${p.error ? " err" : p.done ? " done" : ""}`);
    fill.style.width = `${p.done ? 100 : pct}%`;
    bar.append(fill);
    const line = el("div", "pull-line");
    const text = p.error
      ? p.error
      : p.done
        ? "Downloaded ✓"
        : p.total
          ? `${fmtGB(p.completed)} / ${fmtGB(p.total)} · ${pct.toFixed(0)}%${p.rate ? ` · ${(p.rate / 1e6).toFixed(0)} MB/s` : ""}`
          : p.status;
    line.append(el("span", p.error ? "pull-err" : "", text));
    if (!p.done && !p.error) {
      const cancel = el("button", "ghost small", "Cancel");
      cancel.addEventListener("click", () => api.ollamaCancel(model));
      line.append(cancel);
    }
    wrap.append(bar, line);
    return wrap;
  }

  /** Cheap update while downloading: only swap the progress bars. */
  function renderPullBars() {
    document.querySelectorAll<HTMLElement>(".pull[data-model]").forEach((n) => {
      const fresh = pullBar(n.dataset.model!);
      if (fresh) n.replaceWith(fresh);
    });
    for (const model of progress.keys()) {
      if (!document.querySelector(`.pull[data-model="${CSS.escape(model)}"]`)) return render();
    }
  }

  function catalogCard(c: CatalogEntry): HTMLElement {
    const card = el("div", `card model-card catalog${c.pick ? " pick" : ""}`);
    const head = el("div", "card-head");
    head.append(el("span", "model-name", c.name));
    if (c.pick) head.append(el("span", "tag default-tag", "our pick"));
    const f = st ? fit(c.gb * GB, st.ramBytes) : "good";
    head.append(el("span", `tag fit-${f}`, FIT_LABEL[f]));
    card.append(head, el("div", "muted small-text", `${c.blurb} · ${c.gb} GB download`));
    const installed = st?.models.some((m) => m.name === c.name);
    const bar = pullBar(c.name);
    if (bar) card.append(bar);
    else {
      const actions = el("div", "card-actions");
      if (installed) actions.append(el("span", "muted small-text", "Installed ✓"));
      else {
        const b = el("button", f === "too-big" ? "ghost small" : "primary small", "Download");
        b.disabled = !st?.running;
        b.title = st?.running ? "" : "Start Ollama first";
        b.addEventListener("click", () => {
          if (f === "too-big" && !confirm(`${c.name} probably needs more memory than this Mac has. It may be very slow or fail. Download anyway?`)) return;
          pull(c.name);
        });
        actions.append(b);
      }
      card.append(actions);
    }
    return card;
  }

  function render() {
    const box = $("models");
    const parts: HTMLElement[] = [statusCard()];

    if (st?.running) {
      parts.push(el("div", "section-label", "On this Mac"));
      if (!st.models.length) parts.push(el("p", "muted", "No models yet. Download one below. Our pick is a good start."));
      else {
        const grid = el("div", "model-grid");
        grid.append(...st.models.map(installedCard));
        parts.push(grid);
      }
      if (st.defaultModel && !st.defaultModel.startsWith(`${st.provider}/`)) {
        parts.push(el("p", "muted small-text", `Your default model is ${st.defaultModel} (not local). Set a local model as default to run bots offline.`));
      }

      parts.push(el("div", "section-label", "Get more models"));
      const grid = el("div", "model-grid");
      grid.append(...CATALOG.map(catalogCard));
      parts.push(grid);

      // Custom models (and any in-flight pulls of non-catalog models).
      const custom = el("div", "card custom-pull");
      const row = el("div", "custom-row");
      const input = el("input");
      input.placeholder = "Any model from ollama.com/library, e.g. phi4-mini or llama3.1:70b";
      input.spellcheck = false;
      const go = el("button", "primary small", "Download");
      const submit = () => {
        pull(input.value);
        input.value = "";
      };
      go.addEventListener("click", submit);
      input.addEventListener("keydown", (e) => e.key === "Enter" && submit());
      row.append(input, go);
      custom.append(row);
      for (const model of progress.keys()) {
        if (CATALOG.some((c) => c.name === model)) continue;
        const bar = pullBar(model);
        if (bar) custom.append(el("div", "model-name small", model), bar);
      }
      parts.push(custom);
    }
    box.replaceChildren(...parts);
  }

  return { load };
}
