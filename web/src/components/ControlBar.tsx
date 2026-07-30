import { useState, type CSSProperties, type FormEvent } from "react";
import "./ControlBar.css";

export type ControlBarProps = {
  micActive: boolean;
  micLevel: number;
  onMicDown: () => void;
  onMicUp: () => void;
  onStop: () => void;
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

export function ControlBar({ micActive, micLevel, onMicDown, onMicUp, onStop, onSubmitText }: ControlBarProps) {
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

        <div className="mic-btn-wrap" style={micRingStyle}>
          <div className="mic-btn-ring" />
          <button
            type="button"
            className={`mic-btn${micActive ? " mic-btn--held" : ""}`}
            aria-label="Push and hold to talk"
            onPointerDown={(e) => {
              e.preventDefault();
              onMicDown();
            }}
            onPointerUp={onMicUp}
            onPointerCancel={onMicUp}
            onPointerLeave={() => micActive && onMicUp()}
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
