import type { ClientMessage, ServerMessage } from "@loqui/protocol";
import { TTS_SEGMENT_HEADER_BYTES } from "@loqui/protocol";

export type WsHandlers = {
  onOpen?: () => void;
  onClose?: () => void;
  onMessage: (msg: ServerMessage) => void;
  /** Binary TTS frame, already split into its segment id + raw PCM payload. */
  onAudio: (segmentId: number, pcm: ArrayBuffer) => void;
};

const INITIAL_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 10_000;

/**
 * Thin wrapper around a single WS connection to `wss://${location.host}/ws`.
 * Auto-reconnects with exponential backoff (capped) whenever the socket
 * closes unexpectedly. JSON text frames are parsed as ServerMessage; binary
 * frames are TTS audio, prefixed with a 4-byte little-endian uint32 segment
 * id (see TTS_SEGMENT_HEADER_BYTES in @loqui/protocol).
 */
export class LoquiSocket {
  private ws: WebSocket | null = null;
  private reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  private reconnectTimer: number | undefined;
  private closedByUser = false;

  constructor(
    private readonly url: string,
    private readonly handlers: WsHandlers,
  ) {}

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  private open(): void {
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      this.handlers.onOpen?.();
    };

    ws.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string") {
        this.handleText(event.data);
      } else if (event.data instanceof ArrayBuffer) {
        this.handleBinary(event.data);
      }
    };

    ws.onclose = () => {
      this.handlers.onClose?.();
      if (!this.closedByUser) this.scheduleReconnect();
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  private handleText(raw: string): void {
    try {
      const msg = JSON.parse(raw) as ServerMessage;
      this.handlers.onMessage(msg);
    } catch (err) {
      console.error("[ws] failed to parse JSON frame", err);
    }
  }

  private handleBinary(buf: ArrayBuffer): void {
    if (buf.byteLength < TTS_SEGMENT_HEADER_BYTES) {
      console.warn("[ws] binary frame shorter than the segment-id header, dropping");
      return;
    }
    const id = new DataView(buf).getUint32(0, true);
    const pcm = buf.slice(TTS_SEGMENT_HEADER_BYTES);
    this.handlers.onAudio(id, pcm);
  }

  private scheduleReconnect(): void {
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => this.open(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  /** Send a raw mic PCM frame (16 kHz mono int16) as a binary WS frame. */
  sendAudio(frame: ArrayBuffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(frame);
    }
  }

  close(): void {
    this.closedByUser = true;
    window.clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}

/** Builds the same-origin WS URL the client always connects to. */
export function loquiWsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws`;
}
