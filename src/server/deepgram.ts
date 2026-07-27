/**
 * Deepgram live-streaming connection (server-side, raw WebSocket — same approach
 * as raven's transcriptionService). One instance per audio channel (rep/prospect).
 * Emits parsed Deepgram JSON messages; the TranscriptBus normalizes them.
 */

import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { DeepgramMessage } from "../engine/transcript-bus.js";

export interface DeepgramOptions {
  apiKey: string;
  model?: string;
  language?: string;
  /** Deepgram utterance_end_ms — the pause length that fires UtteranceEnd. */
  utteranceEndMs?: number;
  sampleRate?: number;
}

const KEEPALIVE_MS = 8000;

export declare interface DeepgramLive {
  on(event: "message", listener: (msg: DeepgramMessage) => void): this;
  on(event: "open", listener: () => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  emit(event: "message", msg: DeepgramMessage): boolean;
  emit(event: "open" | "close"): boolean;
  emit(event: "error", err: Error): boolean;
}

export class DeepgramLive extends EventEmitter {
  #ws: WebSocket;
  #keepAlive: ReturnType<typeof setInterval> | null = null;
  #open = false;

  constructor(opts: DeepgramOptions) {
    super();
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
    const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
    this.#ws = new WebSocket(url, { headers: { Authorization: `Token ${opts.apiKey}` } });

    this.#ws.on("open", () => {
      this.#open = true;
      this.#keepAlive = setInterval(() => {
        if (this.#ws.readyState === WebSocket.OPEN) {
          this.#ws.send(JSON.stringify({ type: "KeepAlive" }));
        }
      }, KEEPALIVE_MS);
      this.emit("open");
    });
    this.#ws.on("message", (data: WebSocket.RawData) => {
      try {
        this.emit("message", JSON.parse(data.toString()) as DeepgramMessage);
      } catch {
        /* ignore non-JSON frames */
      }
    });
    this.#ws.on("error", (err) => this.emit("error", err as Error));
    this.#ws.on("close", () => {
      this.#open = false;
      if (this.#keepAlive) clearInterval(this.#keepAlive);
      this.emit("close");
    });
  }

  /** Forward a chunk of linear16 PCM audio. */
  send(pcm: Buffer): void {
    if (this.#open && this.#ws.readyState === WebSocket.OPEN) this.#ws.send(pcm);
  }

  /** Flush + close the stream. */
  finish(): void {
    try {
      if (this.#ws.readyState === WebSocket.OPEN) {
        this.#ws.send(JSON.stringify({ type: "CloseStream" }));
      }
      this.#ws.close();
    } catch {
      /* already closing */
    }
    if (this.#keepAlive) clearInterval(this.#keepAlive);
  }
}
