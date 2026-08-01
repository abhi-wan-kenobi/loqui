import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { SessionState } from "@loqui/protocol";
import { Orb } from "../../Orb";

/**
 * Dev-only harness (see orb-dev.html) — renders the orb in isolation with
 * state / level / skin driven by URL query params, for screenshotting and
 * eyeballing against the design refs. Never imported by the app.
 */
const STATES: SessionState[] = ["idle", "listening", "thinking", "speaking"];

function readParams() {
  const q = new URLSearchParams(location.search);
  const skin = q.get("skin") === "stardust" ? "stardust" : "mesh";
  const state = (STATES.includes(q.get("state") as SessionState) ? q.get("state") : "idle") as SessionState;
  const level = Math.max(0, Math.min(1, Number(q.get("level") ?? "0")));
  const anim = q.get("anim") === "1";
  return { skin, state, level, anim };
}

function Harness() {
  const { skin, state, level, anim } = readParams();
  const [lvl, setLvl] = useState(level);

  // Optional animated level so listening/speaking pulse is visible live.
  useEffect(() => {
    if (!anim) return;
    let raf = 0;
    const t0 = performance.now();
    const loop = () => {
      const t = (performance.now() - t0) / 1000;
      setLvl(0.5 + 0.45 * Math.sin(t * 4));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [anim]);

  return (
    <div
      className="app-shell"
      data-orb-skin={skin}
      style={{ display: "grid", placeItems: "center", height: "100dvh" }}
    >
      <Orb state={state} level={anim ? lvl : level} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
