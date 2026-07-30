import "./Transcript.css";

export type TranscriptProps = {
  /** In-progress user utterance (space-joined stt.segment text). */
  liveUser: string;
  /** In-progress assistant reply (concatenated assistant.delta text). */
  liveAssistant: string;
};

/**
 * The current utterance's words render bright, with the trailing (earlier)
 * words fading toward the left — same idea as Gemini/Maia live captions.
 * The assistant's streaming reply renders below in a distinct muted style.
 */
export function Transcript({ liveUser, liveAssistant }: TranscriptProps) {
  const words = liveUser.trim().length > 0 ? liveUser.trim().split(/\s+/) : [];

  if (words.length === 0 && liveAssistant.length === 0) return null;

  return (
    <div className="transcript">
      {words.length > 0 && (
        <p className="transcript__user">
          {words.map((word, i) => {
            const distanceFromNewest = words.length - 1 - i;
            const opacity = Math.max(0.3, 1 - distanceFromNewest * 0.08);
            return (
              <span key={i} style={{ opacity }}>
                {word}
                {i < words.length - 1 ? " " : ""}
              </span>
            );
          })}
        </p>
      )}
      {liveAssistant.length > 0 && <p className="transcript__assistant">{liveAssistant}</p>}
    </div>
  );
}
