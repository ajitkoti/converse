import type { TranscriptEvent } from "../../src/engine/types.js";

/** Compact fixture item: 's' = final speech, 'u' = UtteranceEnd marker. */
type CompactEvent =
  | { s: "rep" | "prospect"; t: string; start: number; end: number }
  | { u: "rep" | "prospect"; at: number };

interface CompactFixture {
  events: CompactEvent[];
}

/** Convert a compact call fixture (seconds) into normalized TranscriptEvents (ms). */
export function loadCallFixture(fixture: unknown): TranscriptEvent[] {
  const { events } = fixture as CompactFixture;
  return events.map((e): TranscriptEvent => {
    if ("u" in e) {
      const ts = Math.round(e.at * 1000);
      return { speaker: e.u, text: "", tsStart: ts, tsEnd: ts, isFinal: true, utteranceEnd: true };
    }
    return {
      speaker: e.s,
      text: e.t,
      tsStart: Math.round(e.start * 1000),
      tsEnd: Math.round(e.end * 1000),
      isFinal: true,
      utteranceEnd: false,
    };
  });
}
