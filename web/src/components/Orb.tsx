import { useEffect, useRef } from "react";
import type { SessionState } from "@loqui/protocol";
import type { OrbSkin } from "../lib/settings";
import { OrbEngine, type Skin } from "./orb/OrbEngine";
import { MeshSkin } from "./orb/skins/MeshSkin";
import { StardustSkin } from "./orb/skins/StardustSkin";
import "./Orb.css";

export type OrbProps = {
  state: SessionState;
  /** 0..1, mic level while listening / playback level while speaking. */
  level: number;
  onTap?: () => void;
};

const readSkin = (el: Element | null): OrbSkin => {
  const v = el?.closest(".app-shell")?.getAttribute("data-orb-skin");
  return v === "stardust" ? "stardust" : "mesh";
};

const makeSkin = (skin: OrbSkin, pixelRatio: number): Skin =>
  skin === "stardust" ? new StardustSkin(pixelRatio) : new MeshSkin(pixelRatio);

/**
 * WebGL orb — a thin React shell around {@link OrbEngine}. The engine owns the
 * single renderer/scene/camera + RAF loop; this component just wires the canvas,
 * feeds `{state, level}` in every prop change, and hot-swaps the active skin
 * when the `data-orb-skin` attribute on `.app-shell` changes (no context loss).
 */
export function Orb({ state, level, onTap }: OrbProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<OrbEngine | null>(null);
  const skinNameRef = useRef<OrbSkin>("mesh");

  // Feed live props to the engine (no React re-render inside the loop).
  useEffect(() => {
    engineRef.current?.setInput(state, level);
  }, [state, level]);

  // Engine lifecycle: create on mount, dispose on unmount.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const engine = new OrbEngine(canvas);
    engineRef.current = engine;

    const skinName = readSkin(wrap);
    skinNameRef.current = skinName;
    engine.setSkin(makeSkin(skinName, pixelRatio));
    engine.setInput(state, level);

    const applySize = () => {
      const r = wrap.getBoundingClientRect();
      engine.setSize(r.width, r.height);
    };
    applySize();
    engine.start();

    const ro = new ResizeObserver(applySize);
    ro.observe(wrap);

    // React to skin changes via the data-orb-skin attribute on .app-shell.
    const shell = wrap.closest(".app-shell");
    let mo: MutationObserver | null = null;
    if (shell) {
      mo = new MutationObserver(() => {
        const next = readSkin(wrap);
        if (next === skinNameRef.current) return;
        skinNameRef.current = next;
        engine.setSkin(makeSkin(next, pixelRatio));
      });
      mo.observe(shell, { attributes: true, attributeFilter: ["data-orb-skin"] });
    }

    return () => {
      ro.disconnect();
      mo?.disconnect();
      engine.dispose();
      engineRef.current = null;
    };
    // Mount-only; live props flow through the effect above + setInput.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={wrapRef}
      className={`orb-wrap state-${state}`}
      onClick={onTap}
      role="button"
      aria-label={`Assistant is ${state}`}
      tabIndex={0}
    >
      <canvas ref={canvasRef} className="orb-canvas" />
    </div>
  );
}
