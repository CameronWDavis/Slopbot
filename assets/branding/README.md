# SlopBot branding — approved assets

The user selected the **fun green app icon** and the **original cream-and-lime SlopBot logo**. These two files are the approved branding masters. The cyan/magenta cyberpunk icon was explicitly rejected; do not substitute it or recolor these assets to match the desktop UI's neon theme.

For the full desktop restyle, read the [UI design brief](UI-DESIGN-BRIEF.md). It covers the proposed palette, typography, components, mascot lighting, source files and acceptance checks.

## Approved files

| File | Actual dimensions | Background | Use |
| --- | --- | --- | --- |
| [`slopbot-logo.png`](slopbot-logo.png) | 2172 × 724, 3:1 | Transparent RGBA | README, website header, desktop branding, banners |
| [`slopbot-app-icon.png`](slopbot-app-icon.png) | 1254 × 1254, square | Opaque lime green, RGB | Desktop app icon, launcher, favicon source, store artwork source |

![Approved SlopBot logo](slopbot-logo.png)

<img src="slopbot-app-icon.png" alt="Approved SlopBot app icon: Bag Buddy on lime green" width="256" height="256">

These are PNG artwork, not SVGs or native `.icns`/`.ico` files. The app icon is **1254 px**, not 1024 px; generate the exact sizes needed by the target rather than renaming files or assuming dimensions. Platform icon files and application wiring are not included in this handoff yet.

## Design rules

- Keep Bag Buddy's charcoal garbage-bag body, cream dot face, floppy knot, tiny feet and lime slime droplet.
- Preserve the approved green background for the app icon and the transparent background for the wordmark.
- Use the square icon at small sizes. The wide logo contains text and should not be squeezed into a square or cropped into a favicon.
- Preserve aspect ratios, full character silhouette and space around the knot/feet. Use `object-fit: contain` for UI images; avoid stretching, clipping, color filters and extra neon overlays.
- Keep these masters unchanged. Put resized PNGs and native icon derivatives in a `generated/` subfolder, recording how they were produced. Resize from the masters, not from an already reduced copy.
- Keep assets local so the packaged app works offline. Do not link to the original generation cache on the author's machine.

## Integration instructions

Read the current files before editing; the desktop implementation may continue changing. These entry points were inspected when this handoff was prepared:

| Location | Branding update |
| --- | --- |
| Root `README.md` | Place the wide logo near the title. Use descriptive alt text and a relative repository path. A sample is below. |
| `desktop/renderer/index.html` | The header currently uses `.brand-mark` text inside `.brand`. Integrate the wide logo there or use the square mark next to the app name if header space is tight. Preserve the existing controls and layout. Add a local favicon if appropriate. |
| `desktop/renderer/styles.css` | Size the chosen artwork responsively and check it against the existing dark UI. Preserve the artwork's approved colors. |
| `desktop/build.mjs` | Extend its existing asset-copy step to include the runtime branding files under `dist-desktop/renderer/assets/branding/`. The build recreates `dist-desktop`, so editing only generated output will not persist. |
| `desktop/main.ts` | `createWindow()` constructs `BrowserWindow`; connect the appropriate runtime icon there. Resolve it from the bundled renderer/assets directory in both development and packaged builds. For a macOS development Dock icon, use the supported Electron Dock API after app readiness; a window icon alone is not the packaged application icon. |
| `package.json` → `build` | Configure electron-builder's platform icon settings using derived macOS, Windows and Linux icon assets. The existing package includes `dist-desktop/**/*`; distinguish runtime copied assets from build-time icon inputs. Check the installed electron-builder/Electron versions for the required formats. |

Example root README placement:

```html
<p align="center">
  <img src="assets/branding/slopbot-logo.png" alt="SlopBot — Bag Buddy mascot and wordmark" width="600">
</p>
```

For the renderer, use paths relative to the built renderer, such as `assets/branding/slopbot-logo.png`. Do not use filesystem paths in renderer image URLs. Generate platform derivatives from `slopbot-app-icon.png`; preserve the square master and apply any platform-specific padding/masking only in derivatives. Store submission sizes and requirements need checking for the actual target store; this artwork alone is not a submitted or validated store package.

The live 3D mascot remains in `../bag-buddy/`. The square icon and wordmark are static branding and do not replace the GLB or its animation state system.

## Verification after integration

1. Run `npm run desktop:build` and confirm runtime brand files are copied into the output.
2. Run `npm run typecheck` if TypeScript changes were made.
3. Inspect the README and desktop header at their real display sizes. Check the full wordmark, face, knot and feet remain visible.
4. Launch the desktop app and verify runtime icon paths work without network access. Inspect small icon derivatives at 16, 32, 64 and 128 px for legibility.
5. For each platform being released, build and inspect the packaged icon in its launcher/taskbar/Dock. A successful development preview does not verify the packaged app icon.

This handoff adds artwork and instructions only. Application code, package configuration and release artifacts have not been changed by it.
