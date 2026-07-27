/**
 * Phase 1 — Transcript event bus.
 *
 * Normalizes raw Deepgram messages from raven's TWO connections (mic → rep,
 * system → prospect) into a single TranscriptEvent stream, maintains a rolling
 * transcript buffer, and exposes a recentWindow() accessor. Emits events via a
 * plain EventEmitter. NO UI CODE, NO ELECTRON.
 *
 * raven wiring (see ARCHITECTURE.md): raven opens two `ws` sockets in
 * transcriptionService.ts and already sets interim_results + utterance_end_ms.
 * It currently drops UtteranceEnd / speech_final / word timings, so the engine
 * is fed by a PASSIVE tap on the socket's raw `onmessage` — the audio pipeline
 * itself is untouched:
 *
 *   ws.addEventListener('message', (e) =>
 *     bus.ingestDeepgram(JSON.parse(e.data), source === 'mic' ? 'rep' : 'prospect'));
 */

import { EventEmitter } from "node:events";
import type { Speaker, TranscriptEvent } from "./types.js";

/** Subset of Deepgram live-streaming messages we care about. */
export interface DeepgramResultsMessage {
  type?: "Results";
  /** seconds since stream start */
  start?: number;
  /** seconds */
  duration?: number;
  is_final?: boolean;
  speech_final?: boolean;
  channel?: {
    alternatives?: Array<{
      transcript?: string;
      words?: Array<{ word?: string; start?: number; end?: number; speaker?: number }>;
    }>;
  };
}

export interface DeepgramUtteranceEndMessage {
  type: "UtteranceEnd";
  /** seconds since stream start of the last word before the gap */
  last_word_end?: number;
}

export type DeepgramMessage =
  | DeepgramResultsMessage
  | DeepgramUtteranceEndMessage
  | { type?: string; [k: string]: unknown };

export interface TranscriptBusEvents {
  transcript: (e: TranscriptEvent) => void;
}

export declare interface TranscriptBus {
  on<E extends keyof TranscriptBusEvents>(event: E, listener: TranscriptBusEvents[E]): this;
  off<E extends keyof TranscriptBusEvents>(event: E, listener: TranscriptBusEvents[E]): this;
  emit<E extends keyof TranscriptBusEvents>(
    event: E,
    ...args: Parameters<TranscriptBusEvents[E]>
  ): boolean;
}

export class TranscriptBus extends EventEmitter {
  /** All FINAL content events, in arrival order. Interims are not buffered. */
  #buffer: TranscriptEvent[] = [];
  /** Latest observed call-time in ms (max tsEnd across everything seen). */
  #latestTs = 0;

  /**
   * Ingest one raw Deepgram message tagged with the speaker of its connection.
   * @param msg  parsed Deepgram JSON
   * @param speaker  "rep" for the mic connection, "prospect" for system audio
   */
  ingestDeepgram(msg: DeepgramMessage, speaker: Speaker): void {
    const type = (msg as { type?: string }).type;

    if (type === "UtteranceEnd") {
      const m = msg as DeepgramUtteranceEndMessage;
      const ts = secToMs(m.last_word_end);
      this.#advanceClock(ts);
      // Marker event: empty text, signals the speaker paused.
      this.#emit({
        speaker,
        text: "",
        tsStart: ts,
        tsEnd: ts,
        isFinal: true,
        utteranceEnd: true,
      });
      return;
    }

    // Treat anything with a transcript as a Results message. raven's socket also
    // receives Metadata / SpeechStarted messages; those have no transcript and
    // are ignored here (they don't belong in the transcript stream).
    const m = msg as DeepgramResultsMessage;
    const alt = m.channel?.alternatives?.[0];
    const text = alt?.transcript?.trim();
    if (!text) return;

    const tsStart = secToMs(m.start);
    const tsEnd = secToMs(m.start, m.duration);
    this.#advanceClock(tsEnd);

    const event: TranscriptEvent = {
      speaker,
      text,
      tsStart,
      tsEnd,
      isFinal: !!m.is_final,
      utteranceEnd: false,
    };
    if (event.isFinal) this.#buffer.push(event);
    this.#emit(event);
  }

  /** Directly emit a pre-normalized event (used by fixtures/tests). */
  push(event: TranscriptEvent): void {
    this.#advanceClock(event.tsEnd);
    if (event.isFinal && !event.utteranceEnd && event.text) this.#buffer.push(event);
    this.#emit(event);
  }

  #emit(event: TranscriptEvent): void {
    this.emit("transcript", event);
  }

  #advanceClock(ts: number): void {
    if (ts > this.#latestTs) this.#latestTs = ts;
  }

  /** Current call time in ms (latest event seen). */
  get callTimeMs(): number {
    return this.#latestTs;
  }

  /** All final content events for the whole call. */
  fullTranscript(): readonly TranscriptEvent[] {
    return this.#buffer;
  }

  /**
   * Final content events within the last `seconds` of call time.
   * Anchored to the latest event's tsEnd, not wall-clock.
   */
  recentWindow(seconds: number): TranscriptEvent[] {
    const cutoff = this.#latestTs - seconds * 1000;
    return this.#buffer.filter((e) => e.tsEnd >= cutoff);
  }

  /** Render a window of events as speaker-labelled lines for an LLM prompt. */
  renderWindow(seconds: number): string {
    return TranscriptBus.render(this.recentWindow(seconds));
  }

  static render(events: readonly TranscriptEvent[]): string {
    return events
      .filter((e) => e.text)
      .map((e) => `${e.speaker === "rep" ? "REP" : "PROSPECT"}: ${e.text}`)
      .join("\n");
  }
}

/** Deepgram timestamps are seconds; convert to ms since call start. */
function secToMs(start?: number, duration?: number): number {
  const s = (start ?? 0) + (duration ?? 0);
  return Math.round(s * 1000);
}
