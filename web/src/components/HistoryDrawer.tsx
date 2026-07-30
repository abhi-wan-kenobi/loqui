import type { TranscriptEntry } from "../lib/session";
import "./HistoryDrawer.css";

export type HistoryDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: TranscriptEntry[];
};

function HistoryIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M3 12a9 9 0 1 0 3-6.7" strokeLinecap="round" />
      <path d="M3 4v5h5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 8v5l3 2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
    </svg>
  );
}

export function HistoryDrawer({ open, onOpenChange, entries }: HistoryDrawerProps) {
  return (
    <>
      <button
        type="button"
        className="history-toggle"
        onClick={() => onOpenChange(true)}
        aria-label="Open session history"
      >
        <HistoryIcon />
      </button>

      {open && (
        <>
          <div className="history-drawer-overlay" onClick={() => onOpenChange(false)} />
          <aside className="history-drawer" role="dialog" aria-label="Session history">
            <div className="history-drawer__header">
              <span className="history-drawer__title">This session</span>
              <button
                type="button"
                className="history-drawer__close"
                onClick={() => onOpenChange(false)}
                aria-label="Close history"
              >
                <CloseIcon />
              </button>
            </div>
            <div className="history-drawer__list">
              {entries.length === 0 && <p className="history-drawer__empty">Nothing said yet.</p>}
              {entries.map((entry) => (
                <div key={entry.id} className={`bubble bubble--${entry.role}`}>
                  {entry.text}
                </div>
              ))}
            </div>
          </aside>
        </>
      )}
    </>
  );
}
