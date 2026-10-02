// Bag Buddy behavior director: turns real app events into animation clips, following the
// behavior contract in assets/bag-buddy/manifest.json. Pure logic (no three.js, no DOM) so it
// can be unit-tested; mascot.ts supplies the Player that actually animates.

export interface ClipInfo {
  name: string;
  durationSeconds: number;
  loop: boolean;
}

export interface Behavior {
  clip: string;
  priority: number;
  maxLoops?: number;
  then?: string;
  idleAfterSeconds?: number;
  interruptsBoredom?: boolean;
}

export interface Manifest {
  defaultClip: string;
  transitionSeconds: number;
  clips: ClipInfo[];
  behavior: Record<string, Behavior>;
}

export interface PlayRequest {
  clip: string;
  loop: boolean;
  /** How many times to play; Infinity for endless loops. Ignored when loop is false. */
  repetitions: number;
  /** Echo this back in clipFinished(); stale tokens are ignored. */
  token: number;
}

export interface Player {
  play(req: PlayRequest): void;
  /** Reduced motion: hold the default clip at t=0 and stop animating. */
  showStaticPose(): void;
}

/** States the mascot can't wander out of on its own: ambient antics. */
const AMBIENT = new Set(["bored", "sleepy"]);

export class Director {
  state = "idle";
  busy = false;
  private token = 0;
  private lastActivity: number;
  private boredUsed = false;
  private pausedAt: number | null = null;
  private clips: Map<string, ClipInfo>;

  constructor(
    private manifest: Manifest,
    private player: Player,
    private now: () => number = () => performance.now() / 1000,
    public reducedMotion = false,
  ) {
    this.clips = new Map(manifest.clips.map((c) => [c.name, c]));
    this.lastActivity = now();
    if (reducedMotion) player.showStaticPose();
    else this.enter("idle");
  }

  // ── real app events ───────────────────────────────────

  /** Keypress, click, scroll, typing: resets the clock and interrupts ambient antics. */
  userActivity() {
    this.touch();
    if (AMBIENT.has(this.state)) this.enter(this.busy ? "working" : "idle");
  }

  greet() {
    this.touch();
    this.enter("greeting");
  }

  workStarted() {
    this.touch();
    this.busy = true;
    if (this.state !== "working") this.enter("working");
  }

  workFinished(ok: boolean) {
    this.touch();
    this.busy = false;
    this.enter(ok ? "success" : "playful_mishap");
  }

  /** The agent paused to ask for approval: a short surprised beat, then back to work. */
  approvalRequested() {
    this.touch();
    this.enter("surprised");
  }

  amused() {
    this.touch();
    this.enter("amused");
  }

  // ── clock ─────────────────────────────────────────────

  /** Call regularly (each frame is fine). Drives boredom and sleep from the inactivity clock. */
  tick() {
    if (this.reducedMotion || this.busy || this.pausedAt !== null) return;
    const idleFor = this.now() - this.lastActivity;
    const sleepy = this.manifest.behavior.sleepy;
    const bored = this.manifest.behavior.bored;
    if (sleepy && idleFor >= (sleepy.idleAfterSeconds ?? 120) && this.state !== "sleepy" && (this.state === "idle" || this.state === "bored")) {
      this.enter("sleepy");
    } else if (bored && !this.boredUsed && this.state === "idle" && idleFor >= (bored.idleAfterSeconds ?? 25)) {
      this.boredUsed = true; // one paddle-ball episode per inactivity period
      this.enter("bored");
    }
  }

  /** Window hidden: freeze the inactivity clock. */
  pause() {
    if (this.pausedAt === null) this.pausedAt = this.now();
  }

  /** Window visible again: resume without catching up on time spent hidden. */
  resume() {
    if (this.pausedAt === null) return;
    this.lastActivity += this.now() - this.pausedAt;
    this.pausedAt = null;
  }

  setReducedMotion(on: boolean) {
    this.reducedMotion = on;
    if (on) {
      this.token++;
      this.state = "idle";
      this.player.showStaticPose();
    } else {
      this.enter(this.busy ? "working" : "idle");
    }
  }

  // ── player callback ───────────────────────────────────

  /** A one-shot clip (or a bounded loop) finished. */
  clipFinished(token: number) {
    if (token !== this.token) return; // a newer state already took over
    const next = this.manifest.behavior[this.state]?.then ?? "idle";
    this.enter(this.busy ? "working" : next);
  }

  // ── internals ─────────────────────────────────────────

  private touch() {
    this.lastActivity = this.now();
    this.boredUsed = false;
  }

  /** Called whenever the behavior state changes (for status labels). */
  onState: (state: string) => void = () => {};

  private enter(state: string) {
    const b = this.manifest.behavior[state];
    if (!b || !this.clips.has(b.clip)) return;
    this.state = state;
    this.onState(state);
    if (this.reducedMotion) return;
    const clip = this.clips.get(b.clip)!;
    this.player.play({
      clip: clip.name,
      loop: clip.loop,
      repetitions: clip.loop ? (b.maxLoops ?? Infinity) : 1,
      token: ++this.token,
    });
  }
}
