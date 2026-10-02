# Bag Buddy — SlopBot mascot

A real, editable 3D interpretation of the approved garbage-bag concept: charcoal satin plastic, cream dot eyes, tiny pebble feet, a floppy tied top, and a lime slime droplet. The mesh is intentionally simpler than the concept illustration so it works as a small web companion.

## Files

- `bag-buddy.glb` — self-contained web asset with geometry, materials, props and nine named animation clips. No texture downloads or third-party runtime extensions are needed.
- `bag-buddy.blend` — editable Blender 5.1 source, animation tracks and a preview lighting setup. Opens with `idle` active.
- `manifest.json` — exact clip names, durations, loop flags and proposed behavior mappings.
- `previews/` — renders and animated previews of the exported model.
- `reference/approved-concept.png` — the approved image-generation design reference, not a render of this mesh.
- `skills/bag-buddy-integration/SKILL.md` — portable integration instructions for whoever wires the mascot into an app. Read explicitly; it is not installed globally.
- `source/` — reproducible asset-authoring and verification scripts; not application code.

## Animation vocabulary

| Clip | Seconds | Playback | Intended use |
| --- | ---: | --- | --- |
| `idle` | 4.0 | Loop | Soft breathing, blink, knot sway |
| `thinking` | 3.2 | Loop | Hand near cheek, pondering lean |
| `laughing` | 2.4 | Loop, usually 1–2 cycles | Squash, shaking shoulders, closed eyes, open mouth |
| `waving` | 2.0 | Once | Hello or user interaction |
| `celebrating` | 2.4 | Once | Little hops and raised flippers |
| `sleeping` | 4.0 | Loop | Squashed sleepy breathing |
| `curious` | 2.4 | Once | Head/body tilt and surprised mouth |
| `oops` | 2.4 | Once | Comical wobble and recovery |
| `paddle_ball` | 4.8 | Loop | Four paddle taps with a tethered bouncing ball |

These are visual skills. They do not execute agent tools, run timers, produce sound, or infer task status. The future web UI should drive them from real activity events. The proposed mappings in `manifest.json` are a contract, not an implemented state machine.

## Integration contract

Load the GLB with the UI's glTF loader and look up clips by **name**, not array order. In Three.js, `GLTFLoader` returns `scene` and `animations`; bind an `AnimationMixer` to that scene. Run its update with seconds, using the renderer's existing frame loop. The [Three.js animation guide](https://threejs.org/manual/pages/animation-system.html) describes this API.

Crossfade for about 0.22 seconds. All clips key the same transform controls, including expression and prop resets. Keep only the current action and its fading predecessor active. Stop a predecessor when its fade ends. Use repeat playback for looping clips and one-shot playback for the rest; return one-shot clips to `idle` after completion unless a higher-priority task state has arrived. Do not let a stale animation completion overwrite a newer state.

The model uses a hierarchy of animated transforms, not a humanoid skeleton. Squash/stretch, eye changes and the paddle are already baked into the clips; no physics or inverse-kinematics runtime is required. Standard PBR lighting is required; a hemisphere/ambient fill and soft key work well. Keep the ground plane and studio lights out of the shipped model.

glTF coordinates: Y up, face toward +Z, feet at Y=0. Start with an orthographic camera near `(3, 2.5, 8)` looking at `(0.15, 1.15, 0)`. Frame the full animated range, including raised hands and paddle ball; roughly 3.8 units of vertical space works. The primary face, slime and paddle are geometry, so they stay sharp as the view rotates. Props become tiny when unused; do not remove these nodes.

Suggested behavior:

- Any user input or active agent/tool work immediately interrupts ambient antics.
- Active work selects `thinking`; a real successful completion may select `celebrating`.
- After 25 seconds of genuine inactivity, play `paddle_ball` for up to three loops, then idle. Do this at most once per inactivity period, not every idle tick.
- After 120 seconds of inactivity, use `sleeping`. Ambient animation itself does not reset the inactivity clock.
- Treat `oops` as a playful gag. Actual errors and approval requests need clear UI text and should interrupt ambient play.
- Reduced motion: show the static `idle` pose at time zero. Pause animation and ambient timers in hidden tabs; resume without fast-forwarding the accumulated delta.
- Laughter is silent. Add audio only as a separate intentional product choice.

## Editing and rebuilding

In Blender's NLA editor, each animated object has tracks with the same nine clip names. Enable only the chosen track on each control to preview it. Changing only one object's active track will produce a mixed pose. The glTF exporter merges matching track names; see [Blender's glTF documentation](https://docs.blender.org/manual/en/5.1/addons/import_export/scene_gltf2.html).

To recreate the asset with Blender 5.1:

```sh
blender --background --factory-startup --python assets/bag-buddy/source/build_bag_buddy.py
python3 assets/bag-buddy/source/validate_asset.py
```

The builder overwrites the generated GLB, `.blend`, manifest and still previews in this folder. Preserve hand-edited `.blend` work before rebuilding. The source intentionally contains all modeling and animation decisions rather than requiring extra downloaded add-ons.

To verify appearance after export, render the actual GLB in a fresh scene, then encode the preview loops (the encoder needs Pillow):

```sh
blender --background --factory-startup --python assets/bag-buddy/source/render_previews.py -- --frames /tmp/bag-buddy-frames
python3 assets/bag-buddy/source/encode_previews.py /tmp/bag-buddy-frames
```

`validation.json` records structural and animation checks on the shipped GLB. The animation previews are rendered after reimporting that GLB into Blender. Browser playback and event-driven transitions still need verification in the eventual web UI; they cannot be tested against a UI that does not exist yet.

No web UI, application dependency, backend tool, or application architecture is included in this asset pack. Its integration can follow whatever framework the app uses.
