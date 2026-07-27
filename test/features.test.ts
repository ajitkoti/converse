import { describe, it, expect } from "vitest";
import { Coach } from "../src/server/coaching.js";
import { detectObjection } from "../src/server/objections.js";
import { frameworkOverride, frameworkList, FRAMEWORKS } from "../src/server/frameworks.js";
import { loadConfig } from "../src/engine/config.js";
import type { TranscriptEvent } from "../src/engine/types.js";

function ev(speaker: "rep" | "prospect", text: string, start: number, end: number): TranscriptEvent {
  return { speaker, text, tsStart: start * 1000, tsEnd: end * 1000, isFinal: true, utteranceEnd: false };
}

describe("Coach — live coaching signals", () => {
  it("fires a monologue signal when the rep talks too long", () => {
    const c = new Coach();
    let sig = null;
    // one continuous rep stretch of 80s
    for (let t = 0; t < 80; t += 10) {
      const s = c.ingest(ev("rep", "so basically the way it works is a lot of detail here", t, t + 10));
      if (s) sig = s;
    }
    expect(sig?.kind).toBe("monologue");
    expect(c.metrics().longestMonologueMs).toBeGreaterThanOrEqual(75000);
  });

  it("counts questions and computes talk ratio", () => {
    const c = new Coach();
    c.ingest(ev("rep", "what is costing you the most right now?", 0, 4));
    c.ingest(ev("prospect", "we lose a lot of time honestly", 5, 15));
    const m = c.metrics();
    expect(m.questionsAsked).toBe(1);
    expect(m.talkRatioRepPct).toBeLessThan(50); // prospect talked longer
  });

  it("flags a lopsided talk ratio after a few minutes", () => {
    const c = new Coach();
    let sig = null;
    // rep dominates (18s) with brief prospect turns (2s) so no single monologue,
    // but the overall ratio stays ~90% rep.
    for (let i = 0; i < 12; i++) {
      const base = i * 20;
      c.ingest(ev("rep", "me talking a fair bit here about things", base, base + 18));
      const s = c.ingest(ev("prospect", "mm ok", base + 18, base + 20));
      if (s && s.kind === "talk-skew") sig = s;
    }
    expect(sig?.kind).toBe("talk-skew");
    expect(c.metrics().talkRatioRepPct).toBeGreaterThan(70);
  });
});

describe("Objection detection", () => {
  it("detects common objection types", () => {
    expect(detectObjection("honestly that sounds too expensive for us")?.type).toBe("price");
    expect(detectObjection("this is bad timing, maybe next quarter")?.type).toBe("timing");
    expect(detectObjection("we already use salesforce for this")?.type).toBe("competitor");
    expect(detectObjection("that's not my call, I need to check with my boss")?.type).toBe("authority");
    expect(detectObjection("we are happy with what we have")?.type).toBe("status-quo");
  });
  it("returns null when there's no objection", () => {
    expect(detectObjection("yeah that makes a lot of sense, tell me more")).toBeNull();
  });
});

describe("Framework presets", () => {
  it("lists MEDDPICC + BANT + SPICED", () => {
    const ids = frameworkList().map((f) => f.id);
    expect(ids).toContain("meddpicc");
    expect(ids).toContain("bant");
    expect(ids).toContain("spiced");
  });
  it("meddpicc uses the default config (no override)", () => {
    expect(frameworkOverride("meddpicc")).toBeUndefined();
  });
  it("swaps the engine config to BANT slots", () => {
    const cfg = loadConfig(frameworkOverride("bant"));
    expect(cfg.slots.map((s) => s.id).sort()).toEqual(["authority", "budget", "need", "timeline"]);
    expect(cfg.budgets.need?.escalateBy).toBe(FRAMEWORKS.bant!.budgets.need!.escalateBy);
    // every slot carries a description for the classifier prompt
    expect(cfg.slots.every((s) => (s.description ?? "").length > 0)).toBe(true);
  });
});
