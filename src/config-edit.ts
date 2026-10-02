// Edits to slopbot.config.yaml and bot YAML files that keep the user's comments and layout.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { CONFIG_FILE } from "./config.js";

function editYaml(file: string, fn: (doc: YAML.Document) => void) {
  const doc = YAML.parseDocument(fs.readFileSync(file, "utf8"));
  fn(doc);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, doc.toString());
  fs.renameSync(tmp, file);
}

/** Make sure slopbot.config.yaml exists (copied from the example if possible). */
export function ensureConfigFile(rootDir: string): string {
  const file = path.join(rootDir, CONFIG_FILE);
  if (!fs.existsSync(file)) {
    const example = path.join(rootDir, "slopbot.config.example.yaml");
    fs.writeFileSync(file, fs.existsSync(example) ? fs.readFileSync(example, "utf8") : "providers: {}\n");
  }
  return file;
}

export function setDefaultModel(rootDir: string, modelRef: string) {
  editYaml(ensureConfigFile(rootDir), (doc) => doc.set("defaultModel", modelRef));
}

/** Add the Ollama provider if no provider points at it yet. Returns the provider name. */
export function ensureOllamaProvider(rootDir: string, baseUrl = "http://localhost:11434/v1"): string {
  const file = ensureConfigFile(rootDir);
  let name = "ollama";
  editYaml(file, (doc) => {
    const providers = doc.get("providers") as YAML.YAMLMap | undefined;
    const existing = providers?.items.find((it: any) => {
      const v = it.value?.toJSON?.() ?? {};
      return String(it.key) === "ollama" || /:11434\b/.test(v.baseUrl ?? "");
    });
    if (existing) {
      name = String((existing as any).key);
      return;
    }
    if (!providers) doc.set("providers", doc.createNode({}));
    doc.setIn(["providers", "ollama"], doc.createNode({ type: "openai", baseUrl }));
  });
  return name;
}

/** Set (or with null, remove) a bot's `model:` in its YAML file. */
export function setBotModel(botFile: string, modelRef: string | null) {
  editYaml(botFile, (doc) => {
    if (modelRef) doc.set("model", modelRef);
    else doc.delete("model");
  });
}
