import type { CSSProperties } from "react";
import type { SessionState } from "@loqui/protocol";
import "./Orb.css";

export type OrbProps = {
  state: SessionState;
  /** 0..1, mic level while listening / playback level while speaking. */
  level: number;
  onTap?: () => void;
};

/**
 * v0.1 placeholder orb: layered CSS radial gradients + a slow organic
 * wobble, four visual states driven by the server's `state` message. Kept
 * to a clean {state, level} prop surface — v0.3 swaps the internals for a
 * particle system without touching callers.
 */
export function Orb({ state, level, onTap }: OrbProps) {
  const style = { "--level": level } as CSSProperties;

  return (
    <div
      className={`orb-wrap state-${state}`}
      style={style}
      onClick={onTap}
      role="button"
      aria-label={`Assistant is ${state}`}
      tabIndex={0}
    >
      <div className="orb-halo" />
      <div className="orb-core" />
      <div className="orb-shimmer" />
    </div>
  );
}
