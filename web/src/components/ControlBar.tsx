import { useState, type CSSProperties, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import "./ControlBar.css";

export type ControlBarProps = {
  /** Push-to-talk fallback: mic button is hold-to-talk instead of tap. */
  pttMode: boolean;
  /** Open-mic conversation is running (mic button glows, tap ends it). */
  sessionActive: boolean;
  /** Visual "hot" state: PTT held, or open-mic session active. */
  micActive: boolean;
  micLevel: number;
  /** Open-mic: tap to start/stop the session (or interrupt while speaking). */
  onMicTap: () => void;
  /** Push-to-talk hold handlers. */
  onMicDown: () => void;
  onMicUp: () => void;
  onStop: () => void;
  onOpenSettings: () => void;
  onSubmitText: (text: string) => void;
};

function KeyboardIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <rect x="3" y="6" width="18" height="12" rx="2.5" />
      <path d="M7 10h.01M11 10h.01M15 10h.01M17 10h.01M7 14h10" strokeLinecap="round" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.5v2.2M12 19.3v2.2M4.2 7l1.9 1.1M17.9 15.9l1.9 1.1M4.2 17l1.9-1.1M17.9 8.1l1.9-1.1" strokeLinecap="round" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M3 11.5 21 3l-6.5 18-3.5-7-8-2.5Z" />
    </svg>
  );
}

export function ControlBar({
  pttMode,
  sessionActive,
  micActive,
  micLevel,
  onMicTap,
  onMicDown,
  onMicUp,
  onStop,
  onOpenSettings,
  onSubmitText,
}: ControlBarProps) {
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [text, setText] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    onSubmitText(trimmed);
    setText("");
  };

  const micRingStyle = { "--mic-level": micLevel } as CSSProperties;

  // In open-mic mode the mic button is a tap toggle; in PTT it's hold-to-talk.
  const micHandlers = pttMode
    ? {
        onPointerDown: (e: ReactPointerEvent) => {
          e.preventDefault();
          onMicDown();
        },
        onPointerUp: onMicUp,
        onPointerCancel: onMicUp,
        onPointerLeave: () => micActive && onMicUp(),
      }
    : { onClick: onMicTap };

  const micLabel = pttMode
    ? "Push and hold to talk"
    : sessionActive
      ? "Tap to end the conversation"
      : "Tap to start talking";

  return (
    <div>
      {keyboardOpen && (
        <form className="text-input-bar" onSubmit={submit}>
          <input
            autoFocus
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type instead of talking…"
            enterKeyHint="send"
          />
          <button type="submit" disabled={text.trim().length === 0} aria-label="Send">
            <SendIcon />
          </button>
        </form>
      )}

      <div className="control-bar">
        <button
          type="button"
          className={`control-btn${keyboardOpen ? " control-btn--active" : ""}`}
          onClick={() => setKeyboardOpen((v) => !v)}
          aria-label="Toggle text input"
          aria-pressed={keyboardOpen}
        >
          <KeyboardIcon />
        </button>

        <button type="button" className="control-btn" onClick={onOpenSettings} aria-label="Open settings">
          <GearIcon />
        </button>

        <div className="mic-btn-wrap" style={micRingStyle}>
          <div className="mic-btn-ring" />
          <button
            type="button"
            className={`mic-btn${micActive ? " mic-btn--held" : ""}`}
            aria-label={micLabel}
            aria-pressed={!pttMode ? sessionActive : undefined}
            {...micHandlers}
          >
            <MicIcon />
          </button>
        </div>

        <button type="button" className="control-btn control-btn--stop" onClick={onStop} aria-label="Stop session">
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}
