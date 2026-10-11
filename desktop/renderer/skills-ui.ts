// Skills tab: SKILL.md instructions bots load when a task matches. Add from a folder, write one
// here, and choose which bots use each.
import type { SkillInfo, SlopbotApi } from "../api.js";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const cleanError = (e: any) => String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

export function createSkills(api: SlopbotApi, getBots: () => string[]) {
  let skills: SkillInfo[] = [];
  let editing: string | undefined;

  function showError(msg: string) {
    $("skills-error").textContent = msg;
    $("skills-error").hidden = !msg;
  }

  async function load() {
    try {
      skills = await api.skillsList();
      showError("");
    } catch (e) {
      showError(cleanError(e));
      skills = [];
    }
    render();
  }

  function botChips(s: SkillInfo) {
    const wrap = el("div", "chips");
    const all = s.bots.includes("*");
    const set = async (bots: string[], enabled = s.enabled) => {
      await api.skillsAssign(s.name, bots, enabled);
      load();
    };
    const allChip = el("button", `chip${all ? " on" : ""}`, "All bots");
    allChip.addEventListener("click", () => set(all ? [] : ["*"]));
    wrap.append(el("span", "chips-label", "Used by"), allChip);
    for (const b of getBots()) {
      const fromYaml = s.yamlBots.includes(b);
      const on = all || fromYaml || s.bots.includes(b);
      const chip = el("button", `chip${on ? " on" : ""}`, b);
      chip.disabled = all || fromYaml;
      if (fromYaml) chip.title = `Listed under skills: in ${b}.yaml`;
      chip.addEventListener("click", () => set(on ? s.bots.filter((x) => x !== b) : [...s.bots.filter((x) => x !== "*"), b]));
      wrap.append(chip);
    }
    return wrap;
  }

  function render() {
    const box = $("skills-list");
    if (!skills.length) {
      const empty = el("div", "card skills-empty");
      empty.append(
        el("p", "", "No skills yet."),
        el(
          "p",
          "muted small-text",
          "A skill is a SKILL.md file: a name, a one-line description of when to use it, and step-by-step instructions. It can come with templates, reference docs or scripts. Write one here, or add a skill folder from Claude, Codex or anywhere else that uses the SKILL.md format.",
        ),
      );
      box.replaceChildren(empty);
      return;
    }
    box.replaceChildren(
      ...skills.map((s) => {
        const card = el("div", `card skill-card${s.enabled ? "" : " off"}`);
        const head = el("div", "card-head");
        const sw = el("label", "switch");
        const cb = el("input");
        cb.type = "checkbox";
        cb.checked = s.enabled;
        cb.disabled = !!s.error;
        cb.addEventListener("change", async () => {
          await api.skillsAssign(s.name, s.bots, cb.checked);
          load();
        });
        sw.append(cb, el("span", "slider"));
        sw.title = cb.checked ? "On" : "Off";
        head.append(el("span", "skill-icon", "📘"), el("span", "connector-name", s.name));
        if (s.files > 1) head.append(el("span", "tag", `${s.files} files`));
        if (s.license) head.append(el("span", "tag", s.license));
        if (s.bundled) head.append(el("span", "tag", "built-in"));
        head.append(sw);
        card.append(head);
        if (s.error) card.append(el("div", "connector-error", `This skill can't be used: ${s.error}`));
        else card.append(el("p", "skill-desc", s.description));
        if (!s.error) {
          card.append(botChips(s));
          if (!s.bots.length && !s.yamlBots.length) card.append(el("div", "muted small-text", "Not used by any bot yet. Pick the bots that should have it."));
        }
        const actions = el("div", "card-actions");
        const edit = el("button", "ghost small", "Edit");
        edit.disabled = !!s.error;
        edit.addEventListener("click", () => openForm(s.name));
        const reveal = el("button", "ghost small", "Show files");
        reveal.addEventListener("click", () => api.skillsReveal(s.name));
        const del = el("button", "danger small", "Delete");
        del.addEventListener("click", async () => {
          if (!confirm(`Delete the skill "${s.name}" and its files? Bots will stop using it.`)) return;
          await api.skillsRemove(s.name);
          load();
        });
        edit.title = s.bundled ? "Editing saves your own private copy of this built-in skill" : "";
        actions.append(edit, reveal);
        if (!s.bundled) actions.append(del);
        card.append(actions);
        return card;
      }),
    );
  }

  function formBots(selected: string[]) {
    const box = $("skill-bots");
    box.replaceChildren();
    const allLabel = el("label", "check");
    const allCb = el("input");
    allCb.type = "checkbox";
    allCb.value = "*";
    allCb.checked = selected.includes("*");
    allLabel.append(allCb, document.createTextNode("All bots"));
    box.append(allLabel);
    const boxes: HTMLInputElement[] = [];
    for (const b of getBots()) {
      const l = el("label", "check");
      const cb = el("input");
      cb.type = "checkbox";
      cb.value = b;
      cb.checked = allCb.checked || selected.includes(b);
      cb.disabled = allCb.checked;
      boxes.push(cb);
      l.append(cb, document.createTextNode(b));
      box.append(l);
    }
    allCb.addEventListener("change", () => boxes.forEach((cb) => ((cb.disabled = allCb.checked), (cb.checked = allCb.checked || cb.checked))));
  }

  const selectedBots = (id: string) => {
    const bots = [...$(id).querySelectorAll<HTMLInputElement>("input:checked")].map((i) => i.value);
    return bots.includes("*") ? ["*"] : bots;
  };

  async function openForm(name?: string) {
    editing = name;
    $("skill-form-error").hidden = true;
    $("skill-form-title").textContent = name ? `Edit ${name}` : "New skill";
    const files = $("skill-files");
    files.hidden = true;
    let draft = { name: "", description: "", instructions: "" };
    if (name) {
      try {
        const s = await api.skillsGet(name);
        draft = s;
        const extra = s.files.filter((f) => f !== "SKILL.md");
        if (extra.length) {
          files.textContent = `Also in this skill: ${extra.join(", ")}. Edit those in the folder (Show files).`;
          files.hidden = false;
        }
      } catch (e) {
        showError(cleanError(e));
        return;
      }
    }
    $<HTMLInputElement>("skill-name").value = draft.name;
    $<HTMLTextAreaElement>("skill-description").value = draft.description;
    $<HTMLTextAreaElement>("skill-instructions").value = draft.instructions;
    formBots(name ? (skills.find((s) => s.name === name)?.bots ?? []) : ["*"]);
    $("skill-form").hidden = false;
    $<HTMLInputElement>("skill-name").focus();
  }

  async function save() {
    try {
      await api.skillsSave({
        name: $<HTMLInputElement>("skill-name").value.trim(),
        description: $<HTMLTextAreaElement>("skill-description").value.trim(),
        instructions: $<HTMLTextAreaElement>("skill-instructions").value,
        bots: selectedBots("skill-bots"),
        previousName: editing,
      });
      $("skill-form").hidden = true;
      load();
    } catch (e) {
      $("skill-form-error").textContent = cleanError(e);
      $("skill-form-error").hidden = false;
    }
  }

  async function importSkill() {
    try {
      const name = await api.skillsImport(["*"]);
      if (name) await load();
    } catch (e) {
      showError(cleanError(e));
    }
  }

  // Typing a name: keep it in the lowercase-and-hyphens form skills use.
  $("skill-name").addEventListener("input", () => {
    const i = $<HTMLInputElement>("skill-name");
    const v = i.value.toLowerCase().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "");
    if (v !== i.value) i.value = v;
  });
  $("skills-new").addEventListener("click", () => openForm());
  $("skills-import").addEventListener("click", importSkill);
  $("skills-folder").addEventListener("click", () => api.skillsReveal());
  $("skill-save").addEventListener("click", save);
  $("skill-cancel").addEventListener("click", () => ($("skill-form").hidden = true));
  window.addEventListener("keydown", (e) => e.key === "Escape" && !$("skill-form").hidden && ($("skill-form").hidden = true));

  return { load };
}
