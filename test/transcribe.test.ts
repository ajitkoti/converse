import { describe, it, expect } from "vitest";
import { parsePrerecorded, deepgramPrerecorded, recordFromTranscript } from "../src/server/transcribe.js";

const DG_RESPONSE = {
  results: {
    utterances: [
      { speaker: 0, transcript: "Hi, thanks for making time today.", start: 0, end: 3.2 },
      { speaker: 1, transcript: "Sure. We're losing about ten hours a week to manual work.", start: 3.5, end: 9.1 },
      { speaker: 1, transcript: "", start: 9.2, end: 9.3 },
    ],
    channels: [{ alternatives: [{ transcript: "Hi, thanks... Sure. We're losing..." }] }],
  },
};

describe("parsePrerecorded", () => {
  it("maps utterances to lines with speaker 0 = rep", () => {
    const { lines, text } = parsePrerecorded(DG_RESPONSE);
    expect(lines.length).toBe(2); // empty utterance dropped
    expect(lines[0]).toMatchObject({ speaker: "rep", tsStart: 0, tsEnd: 3200 });
    expect(lines[1]).toMatchObject({ speaker: "prospect", tsStart: 3500, tsEnd: 9100 });
    expect(text).toContain("ten hours a week");
  });

  it("falls back to the flat channel transcript when there are no utterances", () => {
    const { lines, text } = parsePrerecorded({ results: { channels: [{ alternatives: [{ transcript: "just one blob" }] }] } });
    expect(lines.length).toBe(1);
    expect(lines[0]!.speaker).toBe("prospect");
    expect(text).toBe("just one blob");
  });

  it("returns empty on junk", () => {
    expect(parsePrerecorded(null).lines).toEqual([]);
    expect(parsePrerecorded({}).text).toBe("");
  });
});

describe("deepgramPrerecorded", () => {
  it("posts audio and parses the response", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const fetchImpl = async (url: string, init: any) => {
      seenUrl = url;
      seenAuth = init.headers.Authorization;
      return { ok: true, status: 200, json: async () => DG_RESPONSE };
    };
    const out = await deepgramPrerecorded("dg-key", Buffer.from("audio"), { fetchImpl });
    expect(seenUrl).toContain("api.deepgram.com/v1/listen");
    expect(seenUrl).toContain("diarize=true");
    expect(seenAuth).toBe("Token dg-key");
    expect(out.lines.length).toBe(2);
  });

  it("throws on a non-ok response", async () => {
    const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
    await expect(deepgramPrerecorded("bad", Buffer.from("x"), { fetchImpl })).rejects.toThrow(/401/);
  });
});

describe("recordFromTranscript", () => {
  it("builds a minimal record with talk time split by speaker", () => {
    const { lines } = parsePrerecorded(DG_RESPONSE);
    const rec = recordFromTranscript("sess-x", lines, "2026-07-27T10:00:00.000Z");
    expect(rec.id).toBe("sess-x");
    expect(rec.transcript.length).toBe(2);
    expect(rec.talk.repMs).toBe(3200);
    expect(rec.talk.prospectMs).toBe(5600);
    expect(rec.durationMs).toBe(9100);
    expect(rec.slotDefs).toEqual([]);
  });
});
