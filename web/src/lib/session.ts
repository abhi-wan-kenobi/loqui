import { create } from "zustand";
import type { SessionState } from "@loqui/protocol";

export type TranscriptEntry = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

export type ConfigInfo = {
  model: string;
  models: string[];
  voice: string;
  voices: string[];
  speed: number;
};

export type ToolActivity = {
  tool: string;
  detail?: string;
};

export type Timings = { sttMs?: number; ttfbMs?: number; firstAudioMs?: number };

let idCounter = 0;
const nextId = (): string => `t${Date.now()}-${idCounter++}`;

type SessionStore = {
  connected: boolean;
  state: SessionState;
  micLevel: number;
  playbackLevel: number;

  /** In-progress user utterance being built up from stt.segment frames. */
  liveUser: string;
  /** In-progress assistant reply being streamed via assistant.delta. */
  liveAssistant: string;

  toolActivity: ToolActivity | null;
  config: ConfigInfo | null;
  history: TranscriptEntry[];
  errorMessage: string | null;
  /** Latency breakdown from the last assistant.done, for the debug row. */
  lastTimings: Timings | null;

  setConnected: (v: boolean) => void;
  setState: (s: SessionState) => void;
  setMicLevel: (v: number) => void;
  setPlaybackLevel: (v: number) => void;
  appendSttSegment: (text: string) => void;
  appendAssistantDelta: (text: string) => void;
  finalizeAssistant: (text: string, timings?: Timings) => void;
  addUserText: (text: string) => void;
  setToolActivity: (activity: ToolActivity | null) => void;
  setConfig: (config: ConfigInfo) => void;
  setError: (message: string | null) => void;
  reset: () => void;
};

export const useSession = create<SessionStore>((set) => ({
  connected: false,
  state: "idle",
  micLevel: 0,
  playbackLevel: 0,
  liveUser: "",
  liveAssistant: "",
  toolActivity: null,
  config: null,
  history: [],
  errorMessage: null,
  lastTimings: null,

  setConnected: (v) => set({ connected: v }),

  // Committing the live utterance into history happens on the
  // listening -> (anything else) transition, since the server never sends
  // an explicit "utterance complete" message of its own.
  setState: (next) =>
    set((s) => {
      if (s.state === "listening" && next !== "listening" && s.liveUser.trim()) {
        return {
          state: next,
          liveUser: "",
          toolActivity: next === "thinking" ? s.toolActivity : null,
          history: [...s.history, { id: nextId(), role: "user", text: s.liveUser.trim() }],
        };
      }
      return { state: next, toolActivity: next === "thinking" ? s.toolActivity : null };
    }),

  setMicLevel: (v) => set({ micLevel: v }),
  setPlaybackLevel: (v) => set({ playbackLevel: v }),

  appendSttSegment: (text) =>
    set((s) => ({ liveUser: s.liveUser ? `${s.liveUser} ${text}` : text })),

  appendAssistantDelta: (text) => set((s) => ({ liveAssistant: s.liveAssistant + text })),

  finalizeAssistant: (text, timings) =>
    set((s) => ({
      liveAssistant: "",
      lastTimings: timings ?? s.lastTimings,
      history: [...s.history, { id: nextId(), role: "assistant", text }],
    })),

  addUserText: (text) =>
    set((s) => ({ history: [...s.history, { id: nextId(), role: "user", text }] })),

  setToolActivity: (activity) => set({ toolActivity: activity }),
  setConfig: (config) => set({ config }),
  setError: (message) => set({ errorMessage: message }),

  // connected/config deliberately survive a reset: they reflect the live
  // transport, not the session's content.
  reset: () =>
    set({
      liveUser: "",
      liveAssistant: "",
      toolActivity: null,
      history: [],
      state: "idle",
      errorMessage: null,
      micLevel: 0,
      playbackLevel: 0,
      lastTimings: null,
    }),
}));
