import type { SessionState } from "@loqui/protocol";
import type { ToolActivity } from "../lib/session";
import "./StatusPill.css";

export type StatusPillProps = {
  state: SessionState;
  toolActivity: ToolActivity | null;
};

function pillText(state: SessionState, toolActivity: ToolActivity | null): string | null {
  switch (state) {
    case "listening":
      return "Go ahead, I'm listening…";
    case "thinking":
      if (toolActivity) {
        return toolActivity.detail ? `Using ${toolActivity.tool} — ${toolActivity.detail}` : `Using ${toolActivity.tool}…`;
      }
      return "Thinking…";
    case "speaking":
      return "Speaking — tap to interrupt";
    case "idle":
    default:
      return null;
  }
}

export function StatusPill({ state, toolActivity }: StatusPillProps) {
  const text = pillText(state, toolActivity);
  if (!text) return <div className="status-pill status-pill--spacer" aria-hidden="true" />;
  return (
    <div className="status-pill" role="status">
      {text}
    </div>
  );
}
