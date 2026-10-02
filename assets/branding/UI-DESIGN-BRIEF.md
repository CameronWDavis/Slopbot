# SlopBot desktop UI redesign — design brief

## Goal and scope

Restyle the existing SlopBot desktop UI to feel like it belongs to **Bag Buddy and the approved cream-and-lime logo**. The user wants a cute, playful, slightly trashy visual identity and explicitly dislikes the current cyberpunk direction.

Build a comfortable workspace with warm paper surfaces, charcoal accents, soft chunky controls and occasional slime-green details. Let the character supply the silliness. Make everyday tasks easy to read and operate.

This document is a design handoff, not an implementation. The assets are user-approved; the layout, colors and measurements below are the proposed implementation direction. Apply them to the existing desktop app while preserving its working features, event wiring, permissions and agent behavior. Check the current source before editing because development is ongoing.

## Approved visual references

![Approved SlopBot wordmark](slopbot-logo.png)

<img src="slopbot-app-icon.png" alt="Approved Bag Buddy app icon on lime green" width="220" height="220">

- [Branding guide](README.md): approved files, native app icon packaging and logo integration.
- [SlopBot wordmark](slopbot-logo.png): cream and lime type, charcoal depth, soft shapes.
- [Green app icon](slopbot-app-icon.png): the approved compact brand mark.
- [Bag Buddy asset guide](../bag-buddy/README.md): the existing animated 3D character and clip contract.

The neon cyan/magenta icon was rejected. Do not reuse it, derive a palette from it, or apply a neon filter to the approved artwork. The UI can retain a charcoal sidebar without retaining cyberpunk styling.

## Art direction: a cheerful little junk drawer

Use these motifs sparingly:

- **Garbage-bag softness:** pill buttons, generous rounded corners, a little visual weight and soft shadows.
- **Paper and labels:** cream cards, simple sticker-like status chips, an occasional small tape tab on an empty-state illustration.
- **Slime:** lime selection fills, the primary action, progress fills and one small decorative droplet near the mascot or logo.
- **Reused materials:** a muted olive or cardboard accent in a small illustration. Keep the main reading surfaces clean.

“Trashy” means charmingly scrappy. Avoid grime behind text, literal garbage piles, flies, brown stains, dripping controls or irregularly rotated navigation. Do not turn every card into a trash can. Reserve playful decoration for the brand, welcome/empty states and Bag Buddy's corner; ordinary forms and data remain calm.

The result should feel tactile and friendly at a glance. A screen recolored green but still covered in glowing borders, grids and futuristic typography does not meet this brief.

## Visual system

### Palette and surface roles

Use a **warm light workspace with a charcoal sidebar and brand bar** as the first implementation. This is one coherent theme; a second dark theme is outside this pass. Keep most of the canvas neutral, with lime concentrated on purposeful emphasis.

These hex values are proposed UI tokens, not claimed samples from the raster artwork:

| Suggested token | Value | Role |
| --- | --- | --- |
| `--canvas` | `#F5F1E8` | Main workspace background |
| `--surface` | `#FFFCF5` | Messages, cards, inputs and dialogs |
| `--surface-muted` | `#E8E2D6` | Inset areas, secondary panels, inactive tracks |
| `--ink` | `#262822` | Main text and charcoal shell |
| `--ink-muted` | `#64665B` | Secondary text on light surfaces |
| `--on-charcoal` | `#F5F1E8` | Main text on the sidebar/titlebar |
| `--on-charcoal-muted` | `#C5C8B9` | Secondary text on charcoal |
| `--lime` | `#D7F75B` | Primary button and selected fills, with charcoal text |
| `--lime-soft` | `#EEF4D5` | Gentle selection and user-message tint |
| `--olive-ink` | `#52651D` | Links and green text on light backgrounds |
| `--line` | `#C8C5B8` | Decorative dividers and card edges |
| `--control-line` | `#77796B` | Input outlines and essential control boundaries |
| `--success-ink` | `#557137` | Success labels; pair with pale olive fill |
| `--warning-ink` | `#865A14` | Waiting/warnings; pair with pale amber fill |
| `--danger-ink` | `#A33429` | Errors/destructive actions; pair with pale coral fill |

Scope text tokens to their surface. A global light-theme text replacement must not make sidebar labels charcoal-on-charcoal. Status colors above are for **light surfaces**; in the dark shell put the status in a light chip or use a separately checked light foreground. Bright lime is an accent fill, not small body text on cream.

Calculated solid-color contrast examples: charcoal on canvas is about **13.2:1**, muted text on canvas **5.2:1**, charcoal on lime **12.3:1**, and cream on charcoal **13.2:1**. These checks cover those pairs only; verify actual rendered states, transparency and overlays too. Target at least 4.5:1 for ordinary text and 3:1 for essential control boundaries. Decorative dividers may be quieter when they are not the sole indication of a control.

### Typography

Replace Chakra Petch as the main UI face. Use a readable system sans-serif for body text and a rounded system sans-serif for headings and friendly labels. A suitable heading stack is `ui-rounded, "SF Pro Rounded", system-ui, sans-serif`; use `system-ui, -apple-system, "Segoe UI", sans-serif` for body copy. This works offline without requiring a new font service.

Keep JetBrains Mono for code, model identifiers, paths, commands and technical values. Do not use monospace for all navigation, helper text or status captions.

- Body: 15–16 px, around 1.5 line height.
- View headings: 22–26 px, semibold/bold, sentence case.
- Buttons/navigation: 14–15 px, semibold, normal letter spacing.
- Metadata: 12–13 px; keep secondary information readable.
- Avoid all-caps labels, wide tracking, glitch duplicates and gradient text. Preserve actual capitalization in identifiers and code.

### Shape, spacing and depth

Use a 4 px spacing rhythm: 8/12 px within controls, 16/24 px inside cards, and 24/32 px between major sections. Use 12 px corner radii for inputs/buttons, 18 px for cards and messages, 24 px for dialogs and the mascot nook, and full pills for compact chips.

Controls should generally be 40–44 px tall. Compact secondary actions can be smaller when labels remain legible and targets are easy to hit. Use thin matte borders and subtle downward shadows. A lime primary button can have a shallow darker bottom edge and move down 1 px on press. Avoid bloom, neon shadows, chamfered corners and floating holographic effects.

## Layout and components

Keep the familiar organization: titlebar across the top, bot/navigation sidebar left, task content in the center, Bag Buddy right. Reuse current DOM IDs, `data-view` attributes and event targets. This restyle does not need a new router or state architecture.

At a typical 1360 × 860 window, start around a 64 px titlebar, a 224–240 px sidebar and a 280–320 px mascot column, leaving the central workspace flexible. Account for the larger corner radii and padding when evaluating the supported minimum window size of 980 × 640. At narrow widths, reduce or collapse the mascot column before compressing conversation and forms; keep status accessible if the mascot is hidden. Do not remove navigation or shrink body text to make it fit.

| Area | Required treatment |
| --- | --- |
| Titlebar | Approved wide logo, roughly 150–180 px wide with its 3:1 ratio preserved. Leave space for native window controls. Use a charcoal surface and a quiet model chip. Remove the glitch wordmark and `//` decoration. Preserve drag/no-drag regions. |
| Sidebar | Matte charcoal, cream labels, generous rounded rows. Current selection gets a lime pill with charcoal text; hover uses a restrained lighter charcoal fill. Retain Bots, Chat, Approvals, Activity, Memory, Models, Vault, Channels and Connectors. |
| Chat | Warm canvas; assistant messages on cream cards and user messages on pale lime cards, with charcoal text. Keep long prose comfortable to scan. Code blocks can use a separate charcoal surface with cream text. Links use underlined olive text on light surfaces. |
| Composer | A generous rounded cream tray with a clearly bounded text field, readable placeholder and one lime Send button. Preserve model selection, keyboard behavior, multiline input and busy/disabled states. |
| Buttons | Lime/charcoal for the main action; outlined neutral secondary buttons; clear coral/red treatment for destructive actions. Normal capitalization. Remove gradient fills, clipped corners and glows. |
| Inputs/selects | Cream surface, clear label, visible border and keyboard focus. Keep placeholder text distinct from labels. Ensure native dropdowns and autofill are legible in the chosen light theme. |
| Tool results | Compact expandable cards with a readable summary and a text status. Put technical details inside the expansion. Keep existing disclosure behavior. |
| Model cards | Rounded cream cards, neutral tags, pale green selected state. Use matte progress tracks and lime fills, with charcoal or olive numeric labels. Preserve all download, cancel and model selection actions. |
| Approvals/dialogs | Clean elevated cream panel, dim neutral backdrop, straightforward explanation and explicit action labels. Keep `Allow`, `Deny`, and session permission wording unambiguous. No jokes or slime decorations around consent. |
| Activity/Memory | Calm lists with clear separators and readable timestamps. Keep logs and stored facts accurate; use the scrappy theme only in surrounding chrome. |
| Vault/Connectors/Channels | Apply the same card, field, chip and status system to every setup flow. Preserve secret masking, credential controls, connection tests, pairing codes and error explanations. |
| Empty states | One small approved mascot image or a simple existing motif, one helpful sentence and a useful next action. A small tape tab or lime sticker is welcome here. |

All component variants need normal, hover, keyboard focus, pressed/selected, disabled, loading and error treatments. Use a clear outline for focus: olive on light surfaces, lime on charcoal. Selection and status must also have a shape, label or icon, not color alone.

## Bag Buddy's corner

Replace the holographic stage with a cozy cream or pale-olive nook. Ground the character with a soft oval shadow; an optional small paper-label caption can sit underneath. Leave space for his knot, raised flippers and the paddle-ball animation. Do not crop him to make the panel seem fuller.

This requires updating **both CSS and 3D lighting**:

- Remove `.stage-grid` and its moving perspective grid, the neon ring on `.stage-floor`, and the pink/violet halo in `.mascot::before`. The existing floor-position variables can still position a plain contact shadow.
- In `desktop/renderer/mascot.ts`, replace the saturated pink/violet rim and under-lights with restrained neutral/warm studio lighting. Use the existing environment and front lights as the starting point; tune against the approved art. The bag should read as charcoal plastic with cream eyes, not as a glowing recolored robot.
- Remove the pink glow on `.mascot-fallback` and verify the existing fallback image looks intentional on the new backdrop.
- Keep the GLB, named clips, camera fitting, animation mixer and event-driven Director behavior intact. Do not modify the mascot model as part of this UI reskin.
- Retain thinking during work, success reactions, idle paddle play and sleep. Real work or user interaction still interrupts ambient animation.
- Keep meaningful status text visible. A cute pose must not become the only indication of work, failure or an approval request.

## Motion and voice

Use short 120–180 ms transitions for hover/press and 180–240 ms for panels. Let Bag Buddy be the main source of ambient motion. Remove CRT scanlines, glitch effects, scrolling grids, neon pulses and endless decorative shimmer. Under reduced motion, use the existing static mascot behavior and remove decorative transforms and smooth scrolling.

Copy can be friendly in low-stakes places: “What are we tackling?”, “A little help with the messy stuff,” or “Nothing waiting on you” for an empty approvals list. These are examples, not required new features. Keep navigation labels conventional and errors actionable. Avoid renaming Models to “Scraps,” credentials to “Trash,” or deletion to a joke that hides its consequence.

## Source map and implementation order

The current implementation contains these specific cyberpunk treatments. Refactor their definitions rather than appending a large override block beneath them.

| File | Work to perform |
| --- | --- |
| `desktop/renderer/styles.css` | Replace the purple/pink palette and global dark text assumptions with semantic surface tokens. Remove `body::after` scanlines, `.brand-mark` glitch pseudo-elements and animation, `.primary` polygon clipping, gradient headings, glowing active states, `.stage-grid`, neon floor/halo rules and glow-based progress fills. Update forms, tags, message markdown, Telegram/channel setup, tool cards, tips, toggles, search and modals as well as the first screen. Check hard-coded colors and late stylesheet sections, not just `:root`. |
| `desktop/renderer/index.html` | Integrate approved branding, remove obsolete decorative grid markup, update the stage shell and adjust presentation copy where useful. Preserve IDs, view names, form semantics and ARIA relationships. |
| `desktop/renderer/mascot.ts` | Neutralize the actual 3D lights, preserve framing and lifecycle, and retain floor-position calculations if used by the new shadow. |
| `desktop/renderer/app.ts`, `models.ts`, `connectors.ts`, `vault-ui.ts` | Inspect dynamically generated markup and inline styling so populated, empty and error states inherit the new component design. Locate any additional modules added since this brief. Keep business logic intact. |
| `desktop/renderer/director.ts` | Preserve the existing state/animation behavior. Treat this as a regression-check target, not a redesign target. |
| `desktop/build.mjs` | Copy the approved runtime brand assets. If Chakra Petch is fully retired, remove its unused font-copy entries; retain any font assets that remain in use. Preserve offline operation. |
| `desktop/main.ts` | Coordinate the initial window background with the new shell to avoid a purple startup flash; preserve window controls, bounds and behavior. Follow the branding guide separately for app icons. |
| Root `README.md` | After implementing the redesign, update the “cyberpunk-themed” description and any outdated screenshots. Do not claim the new UI is implemented before it is. |

Recommended sequence:

1. Establish surface-scoped tokens, typography, spacing and shared controls; verify readable light content and dark navigation.
2. Restyle titlebar/sidebar/chat/composer and integrate the approved logo.
3. Restyle the mascot stage and neutralize the 3D lights together.
4. Apply the system across every view, populated state, form, modal and status variant.
5. Verify accessibility, resizing, live interactions and the packaged asset paths. Remove unused cyberpunk rules and update documentation.

Do not rebuild the backend, replace the 3D renderer, add a second animation loop or change approval policy to accomplish a visual restyle. Preserve unrelated work in progress.

## Acceptance checklist

- [ ] The app visibly matches the approved green icon and cream/lime/charcoal wordmark.
- [ ] Main content uses warm, readable surfaces; the sidebar is charcoal; lime highlights important actions without covering every panel.
- [ ] No CRT overlay, glitch text, neon grid, clipped futuristic buttons, magenta/violet bloom or saturated cyberpunk mascot lights remain.
- [ ] The live mascot and static fallback both look at home in the new nook; paddle, feet, knot and wave stay inside the visible area.
- [ ] Chat, Approvals, Activity, Memory, Models, Vault, Channels, Connectors, setup dialogs and errors share the same visual system.
- [ ] Text and controls have appropriate contrast on their actual backgrounds. Keyboard focus is visible; disabled states are understandable; color is not the sole state indicator.
- [ ] At 1360 × 860 and 980 × 640, navigation and primary actions remain reachable, panels scroll correctly and the composer is usable. Check enlarged text/zoom as well.
- [ ] Chat streaming, model selection/downloads, approval decisions, credential masking, connector setup and channel setup still work.
- [ ] Reduced motion, hidden-tab resume and missing-model fallback keep their existing behavior.
- [ ] `npm run desktop:build` and `npm run typecheck` pass. Run relevant existing tests if behavior code changes.
- [ ] Inspect the running desktop UI, including native window controls and keyboard navigation. Capture representative Chat, Models, and approval-dialog screenshots for review; passing a build alone does not verify appearance.
- [ ] Only locally packaged logo/font/model assets are required, and documentation accurately describes the completed UI.

## Ready-to-use task

> Restyle the current SlopBot desktop UI using `assets/branding/UI-DESIGN-BRIEF.md` and the approved assets in `assets/branding/README.md`. Implement the warm cream workspace, charcoal navigation, lime accents, soft controls and playful Bag Buddy theme. Remove cyberpunk CSS effects and the mascot's neon 3D lighting. Preserve the current functionality and animation behavior, cover every view and dialog, and verify the result in the running app. Report the changed files, checks performed and any remaining visual or functional issues.
