// Renders Bag Buddy with three.js and plays the clips the Director picks.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Director, type Manifest, type Player, type PlayRequest } from "./director.js";

const FRAME_HEIGHT = 3.8; // world units of vertical space, per the asset README
const FRAME_WIDTH = 3.1; // fits flippers and the paddle swing in a narrow side panel
const LOOK_AT = new THREE.Vector3(0.15, 1.15, 0);
const GROUND = new THREE.Vector3(0.15, 0, 0);

class MixerPlayer implements Player {
  private current: { action: THREE.AnimationAction; token: number; loop: boolean } | null = null;
  private fading: THREE.AnimationAction | null = null;
  private fadeEndsAt = 0;
  onFinished: (token: number) => void = () => {};

  constructor(
    private mixer: THREE.AnimationMixer,
    private actions: Map<string, THREE.AnimationAction>,
    private fade: number,
    private defaultClip: string,
  ) {
    mixer.addEventListener("finished", (e: any) => {
      if (this.current && e.action === this.current.action) this.onFinished(this.current.token);
    });
  }

  play({ clip, loop, repetitions, token }: PlayRequest) {
    const action = this.actions.get(clip);
    if (!action) return;
    const prev = this.current;

    // Same endless loop requested again: keep playing, just adopt the new token.
    if (prev && prev.action === action && loop && repetitions === Infinity && prev.loop) {
      prev.token = token;
      return;
    }

    // Only the current action and its fading predecessor may be active.
    if (this.fading && this.fading !== prev?.action) this.fading.stop();
    this.fading = null;

    action.reset();
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? repetitions : 1);
    action.clampWhenFinished = !loop || repetitions !== Infinity;
    action.setEffectiveWeight(1);
    action.setEffectiveTimeScale(1);

    if (prev && prev.action !== action) {
      action.crossFadeFrom(prev.action, this.fade, false);
      this.fading = prev.action;
      this.fadeEndsAt = this.mixer.time + this.fade;
    }
    action.play();
    this.current = { action, token, loop };
  }

  showStaticPose() {
    this.mixer.stopAllAction();
    this.fading = null;
    const idle = this.actions.get(this.defaultClip);
    if (!idle) return;
    idle.reset().play();
    idle.time = 0;
    this.mixer.update(0);
    this.current = null;
  }

  update(dt: number) {
    this.mixer.update(dt);
    if (this.fading && this.mixer.time >= this.fadeEndsAt) {
      this.fading.stop();
      this.fading = null;
    }
  }
}

export interface Mascot {
  director: Director | null;
  label: (state: string) => string;
}

/**
 * Mount Bag Buddy into `container`. Resolves with the Director, or null if the model failed to load
 * (the stage then shows the static poster and the rest of the UI keeps working).
 */
export async function mountMascot(container: HTMLElement, base = "assets/bag-buddy"): Promise<Director | null> {
  let manifest: Manifest;
  let gltf: Awaited<ReturnType<GLTFLoader["loadAsync"]>>;
  try {
    manifest = await (await fetch(`${base}/manifest.json`)).json();
    gltf = await new GLTFLoader().loadAsync(`${base}/bag-buddy.glb`);
  } catch (e) {
    console.error("Bag Buddy failed to load", e);
    const img = document.createElement("img");
    img.src = `${base}/idle.png`;
    img.alt = "Bag Buddy";
    img.className = "mascot-fallback";
    container.append(img);
    return null;
  }

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.add(gltf.scene);

  // Soft neutral fill + key, then the cyberpunk part: hot-pink and violet rim lights.
  scene.add(new THREE.HemisphereLight(0xffe6fb, 0x1a0b2e, 1.1));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(3, 5, 6);
  const rimPink = new THREE.DirectionalLight(0xff2bd6, 4.5);
  rimPink.position.set(-5, 2.5, -3);
  const rimViolet = new THREE.DirectionalLight(0x8a5cff, 4);
  rimViolet.position.set(5, 3, -4);
  const under = new THREE.PointLight(0xff2bd6, 3, 6);
  under.position.set(0, 0.2, 2);
  scene.add(key, rimPink, rimViolet, under);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  camera.position.set(3, 2.5, 8);
  camera.lookAt(LOOK_AT);

  const resize = () => {
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    // Fit both the vertical range and the horizontal reach, whichever is tighter.
    const halfH = Math.max(FRAME_HEIGHT / 2, (FRAME_WIDTH / 2) * (h / w));
    const halfW = halfH * (w / h);
    Object.assign(camera, { left: -halfW, right: halfW, top: halfH, bottom: -halfH });
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    // Let the CSS neon floor ring sit exactly where the feet touch the ground.
    const g = GROUND.clone().project(camera);
    container.style.setProperty("--floor-y", `${((1 - g.y) / 2) * h}px`);
    container.style.setProperty("--floor-w", `${(2.4 / (halfW * 2)) * w}px`);
    renderer.render(scene, camera);
  };
  new ResizeObserver(resize).observe(container);

  const mixer = new THREE.AnimationMixer(gltf.scene);
  const actions = new Map(gltf.animations.map((clip) => [clip.name, mixer.clipAction(clip)]));
  const player = new MixerPlayer(mixer, actions, manifest.transitionSeconds ?? 0.22, manifest.defaultClip);

  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const director = new Director(manifest, player, undefined, motionQuery.matches);
  player.onFinished = (token) => director.clipFinished(token);

  // The one render loop.
  const clock = new THREE.Clock();
  let raf = 0;
  const frame = () => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.1);
    director.tick();
    if (!director.reducedMotion) player.update(dt);
    renderer.render(scene, camera);
  };
  const start = () => {
    if (raf) return;
    clock.getDelta(); // discard time spent paused
    raf = requestAnimationFrame(frame);
  };
  const stop = () => {
    cancelAnimationFrame(raf);
    raf = 0;
  };

  motionQuery.addEventListener("change", () => {
    director.setReducedMotion(motionQuery.matches);
    renderer.render(scene, camera);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stop();
      director.pause();
    } else {
      director.resume();
      start();
    }
  });

  resize();
  start();
  return director;
}
