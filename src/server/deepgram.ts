/**
 * Deepgram live-streaming connection (server-side, raw WebSocket — same approach
 * as raven's transcriptionService). One instance per audio channel (rep/prospect).
 *
 * Resilient by design: auto-reconnects on an unexpected drop (exponential
 * backoff) so a network blip never kills a live call, and applies backpressure
 * (drops audio) if the socket's send buffer grows — so a slow uplink can't blow
 * up memory. Emits status events (reconnecting / reconnected / failed) for the UI.
 */

import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { DeepgramMessage } from "../engine/transcript-bus.js";

export interface DeepgramOptions {
  apiKey: string;
  model?: string;
  language?: string;
  utteranceEndMs?: number;
  sampleRate?: number;
  /** injectable socket factory (tests) */
  socketFactory?: DeepgramSocketFactory;
}

/** Minimal shape of a `ws` socket — lets tests inject a fake. */
export interface DeepgramSocket {
  send(data: Buffer | string): void;
  close(): void;
  readonly readyState: number;
  readonly bufferedAmount: number;
  on(event: "open" | "message" | "error" | "close", cb: (...args: unknown[]) => void): void;
  removeAllListeners(): void;
}
export type DeepgramSocketFactory = (url: string, headers: Record<string, string>) => DeepgramSocket;

const KEEPALIVE_MS = 8000;
const MAX_RECONNECTS = 8;
const MAX_BUFFERED_BYTES = 512 * 1024; // drop audio if the send buffer exceeds this
const OPEN = 1;

export declare interface DeepgramLive {
  on(event: "message", listener: (msg: DeepgramMessage) => void): this;
  on(event: "open" | "close" | "reconnecting" | "reconnected" | "failed", listener: () => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  emit(event: "message", msg: DeepgramMessage): boolean;
  emit(event: "open" | "close" | "reconnecting" | "reconnected" | "failed"): boolean;
  emit(event: "error", err: Error): boolean;
}

export class DeepgramLive extends EventEmitter {
  #opts: DeepgramOptions;
  #url: string;
  #factory: DeepgramSocketFactory;
  #ws: DeepgramSocket | null = null;
  #keepAlive: ReturnType<typeof setInterval> | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #open = false;
  #hasOpened = false;
  #closedByUs = false;
  #attempts = 0;
  #droppedBackpressure = 0;
  #droppedWhileDown = 0;

  constructor(opts: DeepgramOptions) {
    super();
    this.#opts = opts;
    this.#url = buildUrl(opts);
    this.#factory =
      opts.socketFactory ??
      ((url, headers) => new WebSocket(url, { headers }) as unknown as DeepgramSocket);
    this.#connect();
  }

  #connect(): void {
    const ws = this.#factory(this.#url, { Authorization: `Token ${this.#opts.apiKey}` });
    this.#ws = ws;

    ws.on("open", () => {
      this.#open = true;
      this.#attempts = 0;
      this.#keepAlive = setInterval(() => {
        if (this.#ws && this.#ws.readyState === OPEN) this.#ws.send(JSON.stringify({ type: "KeepAlive" }));
      }, KEEPALIVE_MS);
      if (this.#hasOpened) this.emit("reconnected");
      else {
        this.#hasOpened = true;
        this.emit("open");
      }
    });
    ws.on("message", (data: unknown) => {
      try {
        this.emit("message", JSON.parse(String(data)) as DeepgramMessage);
      } catch {
        /* non-JSON frame */
      }
    });
    ws.on("error", (err: unknown) => this.emit("error", err instanceof Error ? err : new Error(String(err))));
    ws.on("close", () => {
      this.#open = false;
      if (this.#keepAlive) clearInterval(this.#keepAlive);
      this.#keepAlive = null;
      if (this.#closedByUs) {
        this.emit("close");
        return;
      }
      this.#scheduleReconnect();
    });
  }

  #scheduleReconnect(): void {
    if (this.#attempts >= MAX_RECONNECTS) {
      this.emit("failed");
      this.emit("close");
      return;
    }
    this.#attempts++;
    const delay = Math.min(1000 * 2 ** (this.#attempts - 1), 15000);
    this.emit("reconnecting");
    this.#reconnectTimer = setTimeout(() => this.#connect(), delay);
  }

  /** Forward a chunk of linear16 PCM audio (dropped under backpressure / while down). */
  send(pcm: Buffer): void {
    if (!this.#ws || !this.#open || this.#ws.readyState !== OPEN) {
      this.#droppedWhileDown++;
      return;
    }
    if (this.#ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.#droppedBackpressure++;
      return;
    }
    this.#ws.send(pcm);
  }

  /** Flush + close the stream for good (no reconnect). */
  finish(): void {
    this.#closedByUs = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    if (this.#keepAlive) clearInterval(this.#keepAlive);
    try {
      if (this.#ws && this.#ws.readyState === OPEN) this.#ws.send(JSON.stringify({ type: "CloseStream" }));
      this.#ws?.close();
    } catch {
      /* already closing */
    }
  }

  get stats(): { droppedBackpressure: number; droppedWhileDown: number; reconnects: number } {
    return {
      droppedBackpressure: this.#droppedBackpressure,
      droppedWhileDown: this.#droppedWhileDown,
      reconnects: this.#attempts,
    };
  }
}

function buildUrl(opts: DeepgramOptions): string {
  const params = new URLSearchParams({
    model: opts.model ?? "nova-3",
    language: opts.language ?? "en",
    smart_format: "true",
    interim_results: "true",
    punctuate: "true",
    encoding: "linear16",
    sample_rate: String(opts.sampleRate ?? 16000),
    channels: "1",
    endpointing: "300",
    utterance_end_ms: String(opts.utteranceEndMs ?? 1000),
  });
  return `wss://api.deepgram.com/v1/listen?${params.toString()}`;
}
