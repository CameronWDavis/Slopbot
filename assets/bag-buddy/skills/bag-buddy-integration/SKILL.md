---
name: bag-buddy-integration
description: Integrate or update the Bag Buddy animated 3D mascot in SlopBot's web UI using the supplied GLB and behavior manifest. Use for mascot rendering, animation transitions, and idle antics.
---

Read `../../manifest.json` for the actual exported animation names and `../../README.md` for coordinates, playback and rebuild details. Resolve paths relative to this skill folder. The model is `../../bag-buddy.glb`.

Preserve the approved identity: charcoal garbage bag, cream dot face, tiny feet, floppy tie and lime droplet. Use the shipped mesh and clips instead of replacing the mascot with emoji, CSS shapes, generated placeholders or a different robot.

Hook the asset into the web UI's existing renderer, state and lifecycle. Do not introduce a second render loop when one exists. The pack supplies visual capabilities and declarative behavior hints; it does not implement agent tools or autonomous behavior. Derive busy/success/error states from real application events.

Select clips by name and respect each manifest loop flag. Crossfade briefly, stop completed fades, and protect transitions against stale completion handlers. The paddle, ball, elastic, eye and mouth nodes are keyed in every clip; keep them in the hierarchy. A foreground event must interrupt ambient paddle play or sleep immediately.

Use one inactivity clock reset by real user/agent activity. Allow at most one bounded paddle-ball episode in an inactivity period, then sleeping at the longer threshold. Do not let idle animation reset its own clock or trigger a new boredom episode on every return to idle. Suppress ambient states during agent/tool work. On reduced motion, use a static idle pose. Pause on hidden tabs and clamp/reset elapsed time on resume.

Verify the integrated result with idle → thinking → success → idle, idle → paddle_ball → interrupted thinking, laughing → idle, one-shot completion after a newer event, reduced motion and hidden-tab resume. Check hands/ball stay in frame and props disappear after leaving paddle play. Load failure should leave a usable UI and optionally display `../../previews/idle.png`.

Keep mascot scope separate from unrelated architecture work. Refer to `../../source/` only when the asset itself needs rebuilding or inspection. This portable skill is stored with the asset; it is not installed globally.
