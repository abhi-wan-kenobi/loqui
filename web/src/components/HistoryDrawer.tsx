import { useEffect, useState } from "react";
import type { ConversationDay, ConversationTurn } from "@loqui/protocol";
import type { TranscriptEntry } from "../lib/session";
import "./HistoryDrawer.css";

export type HistoryDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: TranscriptEntry[];
  /** HTTP(S) origin of the Loqui server (for /api/conversations); null until known. */
  apiBase: string | null;
};

type Tab = "session" | "past";

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

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

function PastConversations({ apiBase }: { apiBase: string | null }) {
  const [days, setDays] = useState<ConversationDay[] | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [turns, setTurns] = useState<ConversationTurn[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!apiBase) return;
    let live = true;
    setError(null);
    getJson<ConversationDay[]>(`${apiBase}/api/conversations`)
      .then((d) => live && setDays(d))
      .catch((e) => live && setError(`Couldn't load conversations (${String(e)})`));
    return () => {
      live = false;
    };
  }, [apiBase]);

  useEffect(() => {
    if (!apiBase || !date) return;
    let live = true;
    setTurns(null);
    setError(null);
    getJson<ConversationTurn[]>(`${apiBase}/api/conversations/${date}`)
      .then((t) => live && setTurns(t))
      .catch((e) => live && setError(`Couldn't load ${date} (${String(e)})`));
    return () => {
      live = false;
    };
  }, [apiBase, date]);

  if (error) return <p className="history-drawer__empty">{error}</p>;
  if (!apiBase) return <p className="history-drawer__empty">No server configured.</p>;

  if (date) {
    return (
      <>
        <button type="button" className="history-drawer__back" onClick={() => setDate(null)}>
          ← {date}
        </button>
        {turns === null && <p className="history-drawer__empty">Loading…</p>}
        {turns?.length === 0 && <p className="history-drawer__empty">No turns in this log.</p>}
        {turns?.map((t, i) => (
          <div key={i} className="history-drawer__turn">
            <span className="history-drawer__time">{t.time}</span>
            <div className="bubble bubble--user">{t.user}</div>
            <div className="bubble bubble--assistant">{t.assistant}</div>
          </div>
        ))}
      </>
    );
  }

  if (days === null) return <p className="history-drawer__empty">Loading…</p>;
  if (days.length === 0) return <p className="history-drawer__empty">No saved conversations yet.</p>;
  return (
    <>
      {days.map((d) => (
        <button key={d.date} type="button" className="history-drawer__day" onClick={() => setDate(d.date)}>
          <span>{d.date}</span>
          <span className="history-drawer__count">
            {d.turns} {d.turns === 1 ? "turn" : "turns"}
          </span>
        </button>
      ))}
    </>
  );
}

export function HistoryDrawer({ open, onOpenChange, entries, apiBase }: HistoryDrawerProps) {
  const [tab, setTab] = useState<Tab>("session");

  return (
    <>
      <button
        type="button"
        className="history-toggle"
        onClick={() => onOpenChange(true)}
        aria-label="Open history"
      >
        <HistoryIcon />
      </button>

      {open && (
        <>
          <div className="history-drawer-overlay" onClick={() => onOpenChange(false)} />
          <aside className="history-drawer" role="dialog" aria-label="History">
            <div className="history-drawer__header">
              <div className="history-drawer__tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "session"}
                  className="history-drawer__tab"
                  onClick={() => setTab("session")}
                >
                  This session
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "past"}
                  className="history-drawer__tab"
                  onClick={() => setTab("past")}
                >
                  Past
                </button>
              </div>
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
              {tab === "past" ? (
                <PastConversations apiBase={apiBase} />
              ) : (
                <>
                  {entries.length === 0 && <p className="history-drawer__empty">Nothing said yet.</p>}
                  {entries.map((entry) => (
                    <div key={entry.id} className={`bubble bubble--${entry.role}`}>
                      {entry.text}
                    </div>
                  ))}
                </>
              )}
            </div>
          </aside>
        </>
      )}
    </>
  );
}
