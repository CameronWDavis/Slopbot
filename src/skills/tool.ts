// skills.read: loads a skill's instructions (or one of its files) when the bot needs it.
import { obj, type Tool } from "../tools/types.js";
import { readSkillFile, skillFiles, skillsForBot } from "./skills.js";

export const skillsReadTool: Tool = {
  name: "skills.read",
  description:
    "Load one of your skills: its step-by-step instructions, or a file it refers to (templates, references, scripts). Read the skill before doing a task it covers, then follow it.",
  risk: "read",
  parameters: obj(
    {
      name: { type: "string", description: "Skill name, from the Skills list in your instructions" },
      file: { type: "string", description: "Optional: a file inside the skill folder, e.g. reference/style.md" },
    },
    ["name"],
  ),
  async run({ name, file }, ctx) {
    const skill = skillsForBot(ctx.config, ctx.bot).find((s) => s.name === String(name));
    if (!skill) {
      const mine = skillsForBot(ctx.config, ctx.bot).map((s) => s.name);
      throw new Error(`You don't have a skill named "${name}". Your skills: ${mine.join(", ") || "(none)"}`);
    }
    if (file && String(file) !== "SKILL.md") return readSkillFile(skill.dir, String(file));
    const others = skillFiles(skill.dir).filter((f) => f !== "SKILL.md");
    return [
      `# Skill: ${skill.name}`,
      `Folder: ${skill.dir}`,
      others.length ? `Files: ${others.join(", ")} (read one with skills.read { name, file })` : "",
      "",
      readSkillFile(skill.dir, "SKILL.md"),
    ]
      .filter((l, i) => l || i > 2)
      .join("\n");
  },
};
