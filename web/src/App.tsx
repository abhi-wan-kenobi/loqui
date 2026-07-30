import { useEffect, useRef, useState } from "react";
import type { ServerMessage } from "@loqui/protocol";
import { LoquiSocket, loquiWsUrl } from "./lib/ws";
import { MicCapture } from "./lib/mic";
import { Player } from "./lib/player";
import { useSession } from "./lib/session";
import { Orb } from "./components/Orb";
import { StatusPill } from "./components/StatusPill";
import { Transcript } from "./components/Transcript";
import { ControlBar } from "./components/ControlBar";
import { HistoryDrawer } from "./components/HistoryDrawer";
import "./App.css";

function greetingWord(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Morning";
  if (hour < 17) return "Afternoon";
  return "Evening";
}

function assertNever(value: never): never {
  throw new Error(`Unhandled ServerMessage type: ${JSON.stringify(value)}`);
}

export function App() {
  const state = useSession((s) => s.state);
  const micLevel = useSession((s) => s.micLevel);
  const playbackLevel = useSession((s) => s.playbackLevel);
  const liveUser = useSession((s) => s.liveUser);
  const liveAssistant = useSession((s) => s.liveAssistant);
  const toolActivity = useSession((s) => s.toolActivity);
  const history = useSession((s) => s.history);
  const errorMessage = useSession((s) => s.errorMessage);

  const [historyOpen, setHistoryOpen] = useState(false);
  const [micHeld, setMicHeld] = useState(false);

  const wsRef = useRef<LoquiSocket | null>(null);
  const micRef = useRef<MicCapture | null>(null);
  const playerRef = useRef<Player | null>(null);

  // Wire up the WS connection, mic capture, and TTS player once.
  useEffect(() => {
    const player = new Player();
    playerRef.current = player;

    const mic = new MicCapture({
      onFrame: (pcm) => wsRef.current?.sendAudio(pcm),
      onLevel: (level) => useSession.getState().setMicLevel(level),
    });
    micRef.current = mic;

    function handleMessage(msg: ServerMessage) {
      const store = useSession.getState();
      switch (msg.type) {
        case "state":
          store.setState(msg.value);
          break;
        case "stt.segment":
          store.appendSttSegment(msg.text);
          break;
        case "assistant.delta":
          store.appendAssistantDelta(msg.text);
          break;
        case "assistant.done":
          store.finalizeAssistant(msg.text);
          break;
        case "tool.activity":
          store.setToolActivity({ tool: msg.tool, detail: msg.detail });
          break;
        case "tts.segment":
          playerRef.current?.onSegmentStart(msg.id);
          break;
        case "tts.flush":
          playerRef.current?.flush();
          break;
        case "config":
          store.setConfig({
            model: msg.model,
            models: msg.models,
            voice: msg.voice,
            voices: msg.voices ?? [],
            speed: msg.speed,
          });
          break;
        case "error":
          console.error("[loqui] server error:", msg.message);
          store.setError(msg.message);
          break;
        default:
          assertNever(msg);
      }
    }

    const ws = new LoquiSocket(loquiWsUrl(), {
      onOpen: () => {
        useSession.getState().setConnected(true);
        useSession.getState().setError(null);
        ws.send({ type: "session.start" });
      },
      onClose: () => useSession.getState().setConnected(false),
      onMessage: handleMessage,
      onAudio: (segmentId, pcm) => {
        void playerRef.current?.pushAudio(segmentId, pcm);
      },
    });
    wsRef.current = ws;
    ws.connect();

    return () => {
      ws.close();
      if (mic.isActive) mic.stop();
    };
  }, []);

  // Drive the orb's playback pulse from the Player's live analyser level.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const current = useSession.getState().state;
      const level = current === "speaking" ? (playerRef.current?.getLevel() ?? 0) : 0;
      useSession.getState().setPlaybackLevel(level);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const handleBargeIn = () => {
    wsRef.current?.send({ type: "barge_in" });
    playerRef.current?.flush();
  };

  const handleMicDown = async () => {
    await playerRef.current?.resume();
    if (useSession.getState().state === "speaking") handleBargeIn();
    try {
      await micRef.current?.start();
      setMicHeld(true);
    } catch (err) {
      console.error("[loqui] microphone start failed", err);
      useSession.getState().setError("Couldn't access the microphone.");
    }
  };

  const handleMicUp = () => {
    if (!micRef.current?.isActive) return;
    micRef.current.stop();
    setMicHeld(false);
    wsRef.current?.send({ type: "utterance.end" });
  };

  const handleOrbTap = () => {
    if (useSession.getState().state === "speaking") handleBargeIn();
  };

  const handleStop = () => {
    if (micRef.current?.isActive) {
      micRef.current.stop();
      setMicHeld(false);
    }
    wsRef.current?.send({ type: "session.stop" });
  };

  const handleSubmitText = (text: string) => {
    useSession.getState().addUserText(text);
    wsRef.current?.send({ type: "text.prompt", text });
  };

  const isIdleGreeting = state === "idle" && liveUser.length === 0 && liveAssistant.length === 0;
  const orbLevel = state === "listening" ? micLevel : state === "speaking" ? playbackLevel : 0;
  const userName = import.meta.env.VITE_USER_NAME || "there";

  return (
    <div className="app-shell">
      <HistoryDrawer open={historyOpen} onOpenChange={setHistoryOpen} entries={history} />

      <div className="app-main">
        <div className="app-top">
          {isIdleGreeting ? (
            <div className="greeting">
              <p className="greeting__headline">
                {greetingWord()}, {userName}.
              </p>
              <p className="greeting__subtitle">Tap and hold to talk</p>
            </div>
          ) : (
            <StatusPill state={state} toolActivity={toolActivity} />
          )}
        </div>

        <Orb state={state} level={orbLevel} onTap={handleOrbTap} />

        <div className="app-transcript-slot">
          <Transcript liveUser={liveUser} liveAssistant={liveAssistant} />
        </div>
      </div>

      <div className="app-controls">
        {errorMessage && <div className="error-banner">{errorMessage}</div>}
        <ControlBar
          micActive={micHeld}
          micLevel={micLevel}
          onMicDown={handleMicDown}
          onMicUp={handleMicUp}
          onStop={handleStop}
          onSubmitText={handleSubmitText}
        />
      </div>
    </div>
  );
}
