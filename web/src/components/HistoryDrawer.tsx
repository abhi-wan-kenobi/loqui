import { useEffect, useState, type ReactNode } from "react";
import type { ConversationDay, ConversationHit, ConversationTurn } from "@loqui/protocol";
import type { TranscriptEntry } from "../lib/session";
import { useDialog } from "../lib/dialog";
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

const SEARCH_MIN_CHARS = 2;
const SEARCH_DEBOUNCE_MS = 250;

/** Wrap case-insensitive occurrences of `query` in <mark>; plain text when there is none. */
function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.trim().toLowerCase();
  if (needle.length < SEARCH_MIN_CHARS) return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, from)) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(<mark key={at}>{text.slice(at, at + needle.length)}</mark>);
    from = at + needle.length;
  }
  parts.push(text.slice(from));
  return <>{parts}</>;
}

function PastConversations({ apiBase }: { apiBase: string | null }) {
  const [days, setDays] = useState<ConversationDay[] | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [focusTime, setFocusTime] = useState<string | null>(null);
  const [turns, setTurns] = useState<ConversationTurn[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ConversationHit[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  const searching = query.trim().length >= SEARCH_MIN_CHARS;

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

  // Debounced search; a stale response never replaces a newer query's results.
  useEffect(() => {
    setSearchError(null);
    if (!apiBase || !searching) {
      setHits(null);
      return;
    }
    let live = true;
    const timer = window.setTimeout(() => {
      getJson<ConversationHit[]>(`${apiBase}/api/conversations/search?q=${encodeURIComponent(query.trim())}`)
        .then((h) => live && setHits(h))
        .catch((e) => live && setSearchError(`Search failed (${String(e)})`));
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [apiBase, query, searching]);

  // Arriving from a search hit: bring that turn into view once the day has loaded.
  useEffect(() => {
    if (!turns || !focusTime) return;
    document.querySelector(`[data-turn-time="${focusTime}"]`)?.scrollIntoView({ block: "center" });
  }, [turns, focusTime]);

  if (error) return <p className="history-drawer__empty">{error}</p>;
  if (!apiBase) return <p className="history-drawer__empty">No server configured.</p>;

  if (date) {
    return (
      <>
        <button
          type="button"
          className="history-drawer__back"
          onClick={() => {
            setDate(null);
            setFocusTime(null);
          }}
        >
          ← {date}
        </button>
        {turns === null && <p className="history-drawer__empty">Loading…</p>}
        {turns?.length === 0 && <p className="history-drawer__empty">No turns in this log.</p>}
        {turns?.map((t, i) => (
          <div key={i} className="history-drawer__turn" data-turn-time={t.time}>
            <span className="history-drawer__time">{t.time}</span>
            <div className="bubble bubble--user">
              <Highlight text={t.user} query={query} />
            </div>
            <div className="bubble bubble--assistant">
              <Highlight text={t.assistant} query={query} />
            </div>
          </div>
        ))}
      </>
    );
  }

  const searchBox = (
    <input
      type="search"
      className="history-drawer__search"
      placeholder="Search conversations"
      aria-label="Search conversations"
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      maxLength={200}
      value={query}
      onChange={(e) => setQuery(e.target.value)}
    />
  );

  if (searching) {
    return (
      <>
        {searchBox}
        {searchError && <p className="history-drawer__empty">{searchError}</p>}
        {!searchError && hits === null && <p className="history-drawer__empty">Searching…</p>}
        {!searchError && hits?.length === 0 && <p className="history-drawer__empty">No matches.</p>}
        {hits?.map((h) => (
          <button
            key={`${h.date}-${h.time}`}
            type="button"
            className="history-drawer__hit"
            onClick={() => {
              setFocusTime(h.time);
              setDate(h.date);
            }}
          >
            <span className="history-drawer__count">
              {h.date} · {h.time}
            </span>
            <span className="history-drawer__snippet">
              <Highlight text={h.user} query={query} />
            </span>
            <span className="history-drawer__snippet history-drawer__snippet--dim">
              <Highlight text={h.assistant} query={query} />
            </span>
          </button>
        ))}
      </>
    );
  }

  if (days === null) return <p className="history-drawer__empty">Loading…</p>;
  if (days.length === 0) return <p className="history-drawer__empty">No saved conversations yet.</p>;
  return (
    <>
      {searchBox}
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
  const dialogRef = useDialog<HTMLElement>(open, () => onOpenChange(false));

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
          <aside ref={dialogRef} tabIndex={-1} className="history-drawer" role="dialog" aria-label="History">
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
