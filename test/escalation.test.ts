import { describe, it, expect } from "vitest";
import { QualificationEngine } from "../src/engine/qualification.js";
import { loadConfig, type ConfigOverride } from "../src/engine/config.js";
import type { GuidanceEvent, SlotId, TranscriptEvent } from "../src/engine/types.js";
import { FakeClock, FakeLlmClient } from "./support/fake-llm.js";
import { loadCallFixture } from "./support/fixtures.js";
import badCall from "../src/fixtures/bad-call.json" with { type: "json" };

function ev(speaker: "rep" | "prospect", text: string, start: number, end: number): TranscriptEvent {
  return { speaker, text, tsStart: start * 1000, tsEnd: end * 1000, isFinal: true, utteranceEnd: false };
}
function marker(speaker: "rep" | "prospect", at: number): TranscriptEvent {
  return { speaker, text: "", tsStart: at * 1000, tsEnd: at * 1000, isFinal: true, utteranceEnd: true };
}

interface Harness {
  engine: QualificationEngine;
  suggestions: Extract<GuidanceEvent, { type: "suggestion" }>[];
  dropped: Extract<GuidanceEvent, { type: "suggestion-dropped" }>[];
}
function makeEngine(override: ConfigOverride, opts?: { clock?: FakeClock; latencyMs?: number }): Harness {
  const clock = opts?.clock;
  const engine = new QualificationEngine({
    llm: new FakeLlmClient({ clock, questionLatencyMs: opts?.latencyMs }),
    config: loadConfig(override),
    monotonicNow: clock ? clock.now : undefined,
  });
  const suggestions: Harness["suggestions"] = [];
  const dropped: Harness["dropped"] = [];
  engine.on("guidance", (e) => {
    if (e.type === "suggestion") suggestions.push(e);
    if (e.type === "suggestion-dropped") dropped.push(e);
  });
  return { engine, suggestions, dropped };
}
async function feed(engine: QualificationEngine, events: TranscriptEvent[]): Promise<void> {
  for (const e of events) {
    engine.ingest(e);
    await engine.idle();
  }
}

describe("QualificationEngine — Phase 3 escalation + suggestion", () => {
  it("fires a suggestion at a prospect pause when a slot is overdue, targeting the MOST overdue", async () => {
    const h = makeEngine({ budgets: { metrics: { escalateBy: 5 }, identifyPain: { escalateBy: 8 } } });
    await feed(h.engine, [
      ev("prospect", "we are still just figuring things out to be honest", 16, 20),
      marker("prospect", 20.5),
    ]);
    expect(h.suggestions.length).toBe(1);
    expect(h.suggestions[0]?.slotId).toBe("metrics"); // overBy 15 > pain's 12
    expect(h.suggestions[0]?.question.length).toBeGreaterThan(0);
  });

  it("does NOT fire on a REP pause, even when overdue", async () => {
    const h = makeEngine({ budgets: { identifyPain: { escalateBy: 5 } } });
    await feed(h.engine, [
      ev("prospect", "yeah things are kind of busy", 0, 3),
      ev("rep", "so what is the main issue you are hoping to fix", 6, 9),
      marker("rep", 9.5),
    ]);
    expect(h.suggestions.length).toBe(0);
  });

  it("never fires mid-utterance — only on an UtteranceEnd marker", async () => {
    const h = makeEngine({ budgets: { identifyPain: { escalateBy: 5 } } });
    // Interim + final content while overdue, but no pause marker yet.
    h.engine.ingest({ speaker: "prospect", text: "so anyway", tsStart: 10000, tsEnd: 11000, isFinal: false, utteranceEnd: false });
    h.engine.ingest(ev("prospect", "so anyway we have a lot going on right now", 10, 14));
    await h.engine.idle();
    expect(h.suggestions.length).toBe(0); // no marker => no suggestion
    // Now the prospect actually pauses.
    h.engine.ingest(marker("prospect", 14.5));
    await h.engine.idle();
    expect(h.suggestions.length).toBe(1);
  });

  it("respects the hard cooldown (default 90s): only one suggestion across the bad call", async () => {
    const h = makeEngine({ budgets: { identifyPain: { escalateBy: 8 } } });
    await feed(h.engine, loadCallFixture(badCall));
    expect(h.suggestions.length).toBe(1);
  });

  it("fires again once the cooldown elapses", async () => {
    const h = makeEngine({
      budgets: { identifyPain: { escalateBy: 8 } },
      suggestion: { cooldownSeconds: 15 },
    });
    await feed(h.engine, loadCallFixture(badCall));
    expect(h.suggestions.length).toBeGreaterThanOrEqual(2);
    // Spacing between consecutive suggestions must respect the cooldown.
    for (let i = 1; i < h.suggestions.length; i++) {
      const gap = (h.suggestions[i]!.ts - h.suggestions[i - 1]!.ts) / 1000;
      expect(gap).toBeGreaterThanOrEqual(15);
    }
  });

  it("drops a suggestion whose generation exceeds the latency budget", async () => {
    const clock = new FakeClock();
    const h = makeEngine(
      { budgets: { identifyPain: { escalateBy: 5 } } },
      { clock, latencyMs: 3000 }, // > dropIfExceedsMs (2500)
    );
    await feed(h.engine, [
      ev("prospect", "we are still figuring things out honestly", 16, 20),
      marker("prospect", 20.5),
    ]);
    expect(h.suggestions.length).toBe(0);
    expect(h.dropped.length).toBe(1);
    expect(h.dropped[0]?.reason).toBe("latency-exceeded");
  });

  it("delivers a suggestion that is within the latency budget", async () => {
    const clock = new FakeClock();
    const h = makeEngine(
      { budgets: { identifyPain: { escalateBy: 5 } } },
      { clock, latencyMs: 900 },
    );
    await feed(h.engine, [
      ev("prospect", "we are still figuring things out honestly", 16, 20),
      marker("prospect", 20.5),
    ]);
    expect(h.suggestions.length).toBe(1);
    expect(h.suggestions[0]?.latencyMs).toBe(900);
  });

  it("skips a snoozed slot and targets the next most-overdue instead", async () => {
    const h = makeEngine({ budgets: { metrics: { escalateBy: 5 }, identifyPain: { escalateBy: 8 } } });
    h.engine.snoozeSlot("metrics" as SlotId); // snooze the would-be target
    await feed(h.engine, [
      ev("prospect", "we are still figuring things out honestly", 16, 20),
      marker("prospect", 20.5),
    ]);
    expect(h.suggestions.length).toBe(1);
    expect(h.suggestions[0]?.slotId).toBe("identifyPain"); // metrics snoozed
  });
});
