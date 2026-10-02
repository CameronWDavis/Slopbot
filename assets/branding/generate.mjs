// Regenerate every branding derivative from the two approved masters (never from a resized copy).
//   node assets/branding/generate.mjs
// Needs: sharp (devDependency). macOS .icns additionally needs Apple's `iconutil` (macOS only).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const here = path.dirname(new URL(import.meta.url).pathname);
const out = path.join(here, "generated");
const ICON = path.join(here, "slopbot-app-icon.png"); // 1254×1254, opaque lime
const LOGO = path.join(here, "slopbot-logo.png"); // 2172×724, transparent
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

/** Rounded-rectangle mask as SVG. */
const roundedMask = (size, inset, radius) =>
  Buffer.from(`<svg width="${size}" height="${size}"><rect x="${inset}" y="${inset}" width="${size - 2 * inset}" height="${size - 2 * inset}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`);

/**
 * App-icon tile at `size`. macOS follows Apple's grid (art inset to ~80% with a ~22% corner radius);
 * Windows/Linux use the full square with gently rounded corners.
 */
async function tile(size, style) {
  const inset = style === "mac" ? Math.round(size * 0.1) : 0;
  const inner = size - 2 * inset;
  const radius = Math.round(inner * (style === "mac" ? 0.2237 : 0.18));
  const art = await sharp(ICON).resize(inner, inner, { kernel: "lanczos3" }).png().toBuffer();
  const canvas = sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: art, left: inset, top: inset }])
    .png();
  const placed = await canvas.toBuffer();
  return sharp(placed)
    .composite([{ input: roundedMask(size, inset, radius), blend: "dest-in" }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

const written = [];
const save = (name, buf) => {
  fs.writeFileSync(path.join(out, name), buf);
  written.push(name);
};

// ── PNG sizes (Windows/Linux style tiles; also used by the UI and Linux packages) ──
for (const s of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) save(`icon-${s}.png`, await tile(s, "square"));

// ── Windows .ico: PNG-compressed entries (supported since Windows Vista) ──
{
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const imgs = await Promise.all(sizes.map((s) => tile(s, "square")));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(sizes.length, 4);
  const dir = Buffer.alloc(16 * sizes.length);
  let offset = 6 + dir.length;
  sizes.forEach((s, i) => {
    const e = i * 16;
    dir.writeUInt8(s >= 256 ? 0 : s, e); // 0 means 256
    dir.writeUInt8(s >= 256 ? 0 : s, e + 1);
    dir.writeUInt8(0, e + 2); // palette
    dir.writeUInt8(0, e + 3);
    dir.writeUInt16LE(1, e + 4); // planes
    dir.writeUInt16LE(32, e + 6); // bpp
    dir.writeUInt32LE(imgs[i].length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += imgs[i].length;
  });
  save("icon.ico", Buffer.concat([header, dir, ...imgs]));
}

// ── macOS .icns via iconutil ──
if (process.platform === "darwin") {
  const set = path.join(out, "icon.iconset");
  fs.mkdirSync(set);
  for (const s of [16, 32, 128, 256, 512]) {
    fs.writeFileSync(path.join(set, `icon_${s}x${s}.png`), await tile(s, "mac"));
    fs.writeFileSync(path.join(set, `icon_${s}x${s}@2x.png`), await tile(s * 2, "mac"));
  }
  execFileSync("iconutil", ["-c", "icns", set, "-o", path.join(out, "icon.icns")]);
  fs.rmSync(set, { recursive: true });
  written.push("icon.icns");
  save("icon-mac-1024.png", await tile(1024, "mac")); // dev Dock icon
} else {
  console.warn("Skipping icon.icns (needs macOS iconutil). Run this script on a Mac to regenerate it.");
}

// ── Wordmark for the app header (shown ~160 px wide → 3× for sharp HiDPI) ──
save("logo-480.png", await sharp(LOGO).resize({ width: 480, kernel: "lanczos3" }).png({ compressionLevel: 9 }).toBuffer());

fs.writeFileSync(
  path.join(out, "README.md"),
  `# Generated branding derivatives

Do not edit these by hand. Regenerate from the approved masters with:

\`\`\`bash
node assets/branding/generate.mjs
\`\`\`

- Source: \`../slopbot-app-icon.png\` (1254 px square) and \`../slopbot-logo.png\` (2172×724), resized with sharp (lanczos3), never from each other.
- \`icon-*.png\`, \`icon.ico\`: full square art with ~18% rounded corners (Windows, Linux, UI).
- \`icon.icns\`, \`icon-mac-1024.png\`: macOS grid, with the art inset 10% per side and a ~22% corner radius, built with Apple \`iconutil\`.
- \`logo-480.png\`: header wordmark (displayed at ~160 px wide).

Files: ${written.map((f) => `\`${f}\``).join(", ")}.
`,
);
console.log(`wrote ${written.length} files to ${path.relative(process.cwd(), out)}/`);
