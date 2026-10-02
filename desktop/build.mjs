// Bundles the Electron app into dist-desktop/: main + preload (Node/CJS) and the renderer (browser IIFE),
// then copies the Bag Buddy assets and fonts so the app works fully offline.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const out = path.join(root, "dist-desktop");
const watch = process.argv.includes("--watch");
fs.rmSync(out, { recursive: true, force: true });

const common = { bundle: true, sourcemap: true, logLevel: "info", target: "es2022" };

await Promise.all([
  build({ ...common, entryPoints: [path.join(root, "desktop/main.ts")], outfile: path.join(out, "main.cjs"), platform: "node", format: "cjs", external: ["electron"] }),
  build({ ...common, entryPoints: [path.join(root, "desktop/preload.ts")], outfile: path.join(out, "preload.cjs"), platform: "node", format: "cjs", external: ["electron"] }),
  build({ ...common, entryPoints: [path.join(root, "desktop/renderer/app.ts")], outfile: path.join(out, "renderer/app.js"), platform: "browser", format: "iife" }),
]);

const copy = (from, to) => {
  fs.mkdirSync(path.dirname(path.join(out, to)), { recursive: true });
  fs.cpSync(path.join(root, from), path.join(out, to), { recursive: true });
};
copy("desktop/renderer/index.html", "renderer/index.html");
copy("desktop/renderer/styles.css", "renderer/styles.css");
copy("assets/bag-buddy/bag-buddy.glb", "renderer/assets/bag-buddy/bag-buddy.glb");
copy("assets/bag-buddy/manifest.json", "renderer/assets/bag-buddy/manifest.json");
copy("assets/bag-buddy/previews/idle.png", "renderer/assets/bag-buddy/idle.png");
for (const f of ["chakra-petch-latin-400-normal", "chakra-petch-latin-600-normal", "chakra-petch-latin-700-normal"]) {
  copy(`node_modules/@fontsource/chakra-petch/files/${f}.woff2`, `renderer/fonts/${f}.woff2`);
}
for (const f of ["jetbrains-mono-latin-400-normal", "jetbrains-mono-latin-600-normal"]) {
  copy(`node_modules/@fontsource/jetbrains-mono/files/${f}.woff2`, `renderer/fonts/${f}.woff2`);
}
console.log(`desktop build → ${path.relative(root, out)}/`);
