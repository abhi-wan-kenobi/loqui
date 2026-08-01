import {
  WebGLRenderer,
  Scene,
  PerspectiveCamera,
  Object3D,
  Color,
  Vector2,
} from "three";
import type { SessionState } from "@loqui/protocol";

/**
 * Per-frame motion drivers handed to the active skin. All values are already
 * smoothed / tweened by the engine so a skin can read them raw without any
 * strobing — UI-level `level` jitter and hard state switches never reach here.
 */
export type FrameDrivers = {
  /** Seconds since engine start (monotonic, pauses while hidden). */
  time: number;
  /** Delta seconds for this frame (clamped). */
  dt: number;
  /** Smoothed input level 0..1 (fast attack ~50ms, slow release ~300ms). */
  level: number;
  /** Tweened one-hot-ish weights per state, sum ≈ 1. */
  weights: Record<SessionState, number>;
  /** Overall brightness multiplier 0..1. */
  brightness: number;
  /** Noise displacement amplitude. */
  amp: number;
  /** Breathing / pulse scale multiplier (~1.0). */
  scale: number;
  /** Accumulated rotation angle (radians). */
  rotation: number;
  /** Warm hue push 0..1 (magenta on mesh, orange on stardust). */
  warmBias: number;
  /** Cool hue push 0..1 (listening). */
  coolBias: number;
  /** Thinking shimmer strength 0..1. */
  shimmer: number;
  /** Thinking shimmer sweep angle (radians, ~1.2s period). */
  shimmerPhase: number;
  /** Rim-glow intensity 0..1 (speaking follows level). */
  rimBoost: number;
  /**
   * Perspective point-size factor: `gl_PointSize = worldSize * pointScale /
   * -mvPos.z` yields a dot `worldSize` units across at the sphere. Accounts for
   * viewport height, DPR and fov, so points stay correctly sized on any device.
   */
  pointScale: number;
  /** prefers-reduced-motion active. */
  reducedMotion: boolean;
};

/** A swappable visual layer owned by the engine. */
export interface Skin {
  /** Root object added to the scene. */
  readonly root: Object3D;
  /** Advance the skin one frame. */
  update(d: FrameDrivers): void;
  /**
   * Governor hook. `q` is 0 (full) .. 2 (lowest): halve point count / drop
   * subdivision one notch per step. Rebuilds geometry as needed.
   */
  setQuality(q: number): void;
  /** Free all GPU resources. */
  dispose(): void;
}

type StateParams = {
  bright: number;
  amp: number;
  pulse: number;
  rot: number;
  warm: number;
  cool: number;
  rim: number;
};

// Per-state target parameters; the engine blends these by the tweened weights,
// so state transitions are automatically smooth (no per-field tweening).
const PARAMS: Record<SessionState, StateParams> = {
  idle: { bright: 0.6, amp: 0.34, pulse: 0.0, rot: 0.06, warm: 0.0, cool: 0.0, rim: 0.35 },
  listening: { bright: 1.0, amp: 0.5, pulse: 0.06, rot: 0.11, warm: 0.0, cool: 0.55, rim: 0.5 },
  thinking: { bright: 0.8, amp: 0.2, pulse: 0.02, rot: 0.16, warm: 0.0, cool: 0.15, rim: 0.4 },
  speaking: { bright: 0.95, amp: 0.44, pulse: 0.05, rot: 0.1, warm: 0.65, cool: 0.0, rim: 0.6 },
};

const STATES: SessionState[] = ["idle", "listening", "thinking", "speaking"];

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
// Frame-rate independent exponential smoothing toward `target`.
const damp = (cur: number, target: number, tau: number, dt: number) =>
  cur + (target - cur) * (1 - Math.exp(-dt / Math.max(tau, 1e-4)));

/** DPR cap for a given governor quality step. */
const dprForQuality = (q: number) => (q <= 0 ? 2 : q === 1 ? 1.5 : 1);
/** Skin-internal quality (particle count / subdivision) for a governor step. */
const skinQualityForStep = (q: number) => Math.max(0, q - 2);

export class OrbEngine {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;

  private skin: Skin | null = null;
  private raf = 0;
  private running = false;
  private lastT = 0;
  private clock = 0;
  private shimmerPhase = 0;
  private sizeTmp = new Vector2();

  // Motion state.
  private level = 0;
  private targetState: SessionState = "idle";
  private weights: Record<SessionState, number> = { idle: 1, listening: 0, thinking: 0, speaking: 0 };
  private rotation = 0;
  private reducedMotion = false;

  // Governor.
  private quality = 0; // 0 = full .. up
  private readonly maxQuality = 4;
  private fpsAccum = 0;
  private fpsFrames = 0;
  private slowWindows = 0;
  private hostDpr: number;

  private readonly onVisibility = () => {
    if (document.hidden) this.pause();
    else this.start();
  };

  constructor(canvas: HTMLCanvasElement) {
    this.hostDpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer = new WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      powerPreference: "high-performance",
    });
    this.renderer.setClearColor(new Color(0x000000), 0); // transparent — app bg shows
    this.renderer.setPixelRatio(this.hostDpr);

    this.scene = new Scene();
    this.camera = new PerspectiveCamera(36, 1, 0.1, 100);
    this.camera.position.set(0, 0, 4.8);

    this.reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    document.addEventListener("visibilitychange", this.onVisibility);
  }

  setSkin(skin: Skin | null): void {
    if (this.skin) {
      this.scene.remove(this.skin.root);
      this.skin.dispose();
    }
    this.skin = skin;
    if (skin) {
      skin.setQuality(skinQualityForStep(this.quality));
      this.scene.add(skin.root);
    }
  }

  /** Size the drawing buffer to the CSS box (call on mount + resize). */
  setSize(w: number, h: number): void {
    if (w <= 0 || h <= 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  /** Push the latest UI-level state + level (called from React on prop change). */
  setInput(state: SessionState, level: number): void {
    this.targetState = state;
    this.pendingLevel = clamp(level, 0, 1);
  }
  private pendingLevel = 0;

  start(): void {
    if (this.running || document.hidden) return;
    this.running = true;
    this.lastT = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  pause(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private readonly tick = (now: number) => {
    if (!this.running) return;
    const dt = clamp((now - this.lastT) / 1000, 0, 0.05);
    this.lastT = now;
    this.clock += dt;

    this.governor(now, dt);
    this.step(dt);

    if (this.skin) this.skin.update(this.buildDrivers(dt));
    this.renderer.render(this.scene, this.camera);
    this.raf = requestAnimationFrame(this.tick);
  };

  private step(dt: number): void {
    // Level: fast attack, slow release.
    const target = this.pendingLevel;
    const tau = target > this.level ? 0.05 : 0.3;
    this.level = damp(this.level, target, tau, dt);

    // State weights tween toward a one-hot of the target state (~250ms).
    for (const s of STATES) {
      const goal = s === this.targetState ? 1 : 0;
      this.weights[s] = damp(this.weights[s], goal, 0.18, dt);
    }

    // Rotation accumulates at the blended speed.
    let rot = 0;
    for (const s of STATES) rot += this.weights[s] * PARAMS[s].rot;
    if (this.reducedMotion) rot *= 0.25;
    this.rotation += rot * dt;

    // Thinking shimmer sweep (~1.2s period).
    this.shimmerPhase = (this.shimmerPhase + (dt / 1.2) * Math.PI * 2) % (Math.PI * 2);
  }

  private buildDrivers(dt: number): FrameDrivers {
    const w = this.weights;
    let bright = 0, amp = 0, pulse = 0, warm = 0, cool = 0, rim = 0, wsum = 0;
    for (const s of STATES) {
      const p = PARAMS[s];
      const k = w[s];
      wsum += k;
      bright += k * p.bright;
      amp += k * p.amp;
      pulse += k * p.pulse;
      warm += k * p.warm;
      cool += k * p.cool;
      rim += k * p.rim;
    }
    const inv = wsum > 1e-3 ? 1 / wsum : 1;
    bright *= inv; amp *= inv; pulse *= inv; warm *= inv; cool *= inv; rim *= inv;

    // Level drives amplitude & pulse mostly while listening / speaking.
    const lvlGate = w.listening * 0.6 + w.speaking * 0.7;
    amp += this.level * lvlGate;
    const idleBreath = this.reducedMotion ? 0 : w.idle * 0.03 * Math.sin((this.clock / 4) * Math.PI * 2);
    const scale = 1 + pulse + idleBreath + this.level * (w.listening * 0.14 + w.speaking * 0.1);
    rim += this.level * w.speaking * 0.6;

    // Perspective point size: device-pixel viewport height / (2 tan(fov/2)).
    this.renderer.getSize(this.sizeTmp);
    const deviceH = this.sizeTmp.y * this.renderer.getPixelRatio();
    const pointScale = deviceH / (2 * Math.tan((this.camera.fov * Math.PI) / 360));

    return {
      time: this.clock,
      dt,
      level: this.level,
      weights: { ...w },
      brightness: bright,
      amp,
      scale,
      rotation: this.rotation,
      warmBias: warm,
      coolBias: cool,
      shimmer: w.thinking,
      shimmerPhase: this.shimmerPhase,
      rimBoost: clamp(rim, 0, 1.4),
      pointScale,
      reducedMotion: this.reducedMotion,
    };
  }

  private governor(_now: number, dt: number): void {
    if (dt <= 0) return;
    this.fpsAccum += dt;
    this.fpsFrames++;
    if (this.fpsAccum < 1) return;
    const fps = this.fpsFrames / this.fpsAccum;
    this.fpsAccum = 0;
    this.fpsFrames = 0;
    if (fps < 45 && this.quality < this.maxQuality) {
      this.slowWindows++;
      if (this.slowWindows >= 2) {
        this.slowWindows = 0;
        this.quality++;
        this.applyQuality();
      }
    } else {
      this.slowWindows = 0;
    }
  }

  private applyQuality(): void {
    const dpr = Math.min(this.hostDpr, dprForQuality(this.quality));
    this.renderer.setPixelRatio(dpr);
    // Re-apply size so the pixel-ratio change takes effect.
    const w = this.renderer.domElement.clientWidth;
    const h = this.renderer.domElement.clientHeight;
    if (w && h) this.renderer.setSize(w, h, false);
    this.skin?.setQuality(skinQualityForStep(this.quality));
  }

  dispose(): void {
    this.pause();
    document.removeEventListener("visibilitychange", this.onVisibility);
    if (this.skin) {
      this.scene.remove(this.skin.root);
      this.skin.dispose();
      this.skin = null;
    }
    this.renderer.dispose();
  }

  /** Current governor step (for diagnostics/tests). */
  get qualityStep(): number {
    return this.quality;
  }
}
