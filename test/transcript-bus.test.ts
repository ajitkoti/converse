import { describe, it, expect } from "vitest";
import { TranscriptBus, type DeepgramMessage } from "../src/engine/transcript-bus.js";
import type { Speaker, TranscriptEvent } from "../src/engine/types.js";
import fixture from "../src/fixtures/deepgram-phase1.json" with { type: "json" };

type FixtureItem = { speaker: Speaker; msg: DeepgramMessage };

function replay(): { bus: TranscriptBus; emitted: TranscriptEvent[] } {
  const bus = new TranscriptBus();
  const emitted: TranscriptEvent[] = [];
  bus.on("transcript", (e) => emitted.push(e));
  for (const item of (fixture as { messages: FixtureItem[] }).messages) {
    bus.ingestDeepgram(item.msg, item.speaker);
  }
  return { bus, emitted };
}

describe("TranscriptBus — Phase 1", () => {
  it("tags speakers correctly from the connection source", () => {
    const { emitted } = replay();
    const content = emitted.filter((e) => e.text && e.isFinal);
    // First rep line, then prospect line, then a rep line.
    expect(content[0]?.speaker).toBe("rep");
    expect(content[0]?.text).toContain("thanks for making the time");
    expect(content[1]?.speaker).toBe("prospect");
    expect(content[1]?.text).toContain("struggling with this");
    expect(content[2]?.speaker).toBe("rep");
  });

  it("emits interim and final events, but only buffers finals", () => {
    const { bus, emitted } = replay();
    const interim = emitted.find((e) => e.text && !e.isFinal);
    expect(interim?.isFinal).toBe(false);
    // Buffer holds only final content lines (3 non-empty finals in the fixture).
    const finals = bus.fullTranscript();
    expect(finals.length).toBe(3);
    expect(finals.every((e) => e.isFinal && e.text.length > 0)).toBe(true);
  });

  it("emits UtteranceEnd markers with empty text and correct speaker", () => {
    const { emitted } = replay();
    const markers = emitted.filter((e) => e.utteranceEnd);
    expect(markers.length).toBe(3);
    expect(markers[0]?.speaker).toBe("rep");
    expect(markers[0]?.text).toBe("");
    expect(markers[0]?.tsStart).toBe(2600); // 2.6s -> ms
    expect(markers[1]?.speaker).toBe("prospect");
    expect(markers[1]?.tsEnd).toBe(6400);
  });

  it("ignores non-transcript noise (SpeechStarted, Metadata, empty transcript)", () => {
    const { emitted } = replay();
    // No event should carry a non-string / SpeechStarted artifact; empty finals dropped.
    expect(emitted.every((e) => e.utteranceEnd || e.text.length > 0)).toBe(true);
  });

  it("computes tsStart/tsEnd from Deepgram start + duration", () => {
    const { emitted } = replay();
    const prospectLine = emitted.find((e) => e.speaker === "prospect" && e.isFinal && e.text);
    expect(prospectLine?.tsStart).toBe(3000); // 3.0s
    expect(prospectLine?.tsEnd).toBe(6200); // 3.0 + 3.2
  });

  it("recentWindow anchors to latest call time, not wall clock", () => {
    const { bus } = replay();
    // latest tsEnd is the last UtteranceEnd at 9.1s. Window of 4s -> from 5.1s.
    expect(bus.callTimeMs).toBe(9100);
    const recent = bus.recentWindow(4);
    // Only the rep line at 7.0-9.0 qualifies (prospect final ends at 6.2 < 5.1? no, 6.2>5.1).
    const texts = recent.map((e) => e.text);
    expect(texts.some((t) => t.includes("costing you"))).toBe(true);
  });

  it("renders a window as speaker-labelled lines", () => {
    const { bus } = replay();
    const rendered = TranscriptBus.render(bus.fullTranscript());
    expect(rendered).toContain("REP:");
    expect(rendered).toContain("PROSPECT:");
  });

  it("suppresses prospect lines that echo a recent rep line (echo guard)", () => {
    const bus = new TranscriptBus();
    const emitted: TranscriptEvent[] = [];
    bus.on("transcript", (e) => emitted.push(e));
    const rep = { speaker: "rep" as const, text: "what is your budget for this project", tsStart: 1000, tsEnd: 4000, isFinal: true, utteranceEnd: false };
    const echo = { speaker: "prospect" as const, text: "what is your budget for this project", tsStart: 4200, tsEnd: 6000, isFinal: true, utteranceEnd: false };
    const real = { speaker: "prospect" as const, text: "we spend about forty thousand a quarter", tsStart: 7000, tsEnd: 10000, isFinal: true, utteranceEnd: false };
    bus.push(rep);
    bus.push(echo); // rep's words bleeding into the prospect channel
    bus.push(real);
    expect(bus.suppressedEchoes).toBe(1);
    const prospectFinals = bus.fullTranscript().filter((e) => e.speaker === "prospect");
    expect(prospectFinals.map((e) => e.text)).toEqual(["we spend about forty thousand a quarter"]);
  });

  it("does not suppress when echo guard is disabled", () => {
    const bus = new TranscriptBus({ echoGuard: false });
    bus.push({ speaker: "rep", text: "what is your budget for this project", tsStart: 1000, tsEnd: 4000, isFinal: true, utteranceEnd: false });
    bus.push({ speaker: "prospect", text: "what is your budget for this project", tsStart: 4200, tsEnd: 6000, isFinal: true, utteranceEnd: false });
    expect(bus.suppressedEchoes).toBe(0);
    expect(bus.fullTranscript().filter((e) => e.speaker === "prospect").length).toBe(1);
  });
});
