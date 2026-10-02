import { newId } from "../store/store.js";
import { obj, type Tool } from "./types.js";

export const memoryTools: Tool[] = [
  {
    name: "memory.remember",
    description:
      "Save a durable fact about the user, their preferences, goals, or standards so you remember it in future sessions. Don't save transient details.",
    risk: "write",
    parameters: obj(
      { text: { type: "string" }, tags: { type: "array", items: { type: "string" } } },
      ["text"],
    ),
    async run({ text, tags = [] }, ctx) {
      const notes = ctx.store.readMemory(ctx.bot.name);
      const note = { id: newId("m_"), text, tags, createdAt: new Date().toISOString() };
      notes.push(note);
      ctx.store.writeMemory(ctx.bot.name, notes);
      return `Remembered (${note.id}).`;
    },
  },
  {
    name: "memory.recall",
    description: "Search your long-term memory by keywords.",
    risk: "read",
    parameters: obj({ query: { type: "string" } }, ["query"]),
    async run({ query }, ctx) {
      const words = String(query).toLowerCase().split(/\W+/).filter(Boolean);
      const scored = ctx.store
        .readMemory(ctx.bot.name)
        .map((n) => {
          const hay = (n.text + " " + n.tags.join(" ")).toLowerCase();
          return { n, score: words.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0) };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 20);
      return scored.map(({ n }) => `[${n.id}] ${n.text}`).join("\n") || "Nothing relevant in memory.";
    },
  },
  {
    name: "memory.forget",
    description: "Delete a memory note by id (e.g. when it is outdated or wrong).",
    risk: "write",
    parameters: obj({ id: { type: "string" } }, ["id"]),
    async run({ id }, ctx) {
      const notes = ctx.store.readMemory(ctx.bot.name);
      const next = notes.filter((n) => n.id !== id);
      if (next.length === notes.length) return `No note ${id}.`;
      ctx.store.writeMemory(ctx.bot.name, next);
      return `Forgot ${id}.`;
    },
  },
];
