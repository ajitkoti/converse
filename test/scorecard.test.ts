import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore, makeSessionId } from "../src/server/store.js";
import { buildScorecard } from "../src/server/scorecard.js";
import type { SessionRecord } from "../src/server/types.js";

let tmp: string;
let store: SessionStore;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "converse-sc-"));
  store = new SessionStore(tmp);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function rec(over: Partial<SessionRecord> = {}): SessionRecord {
  n++;
  return {
    id: makeSessionId(new Date(2026, 6, n, 10), `r${n}`),
    startedAt: new Date(2026, 6, n, 10).toISOString(),
    endedAt: new Date(2026, 6, n, 10, 5).toISOString(),
    mode: "live",
    rep: "You",
    framework: "meddpicc",
    durationMs: 300000,
    slotDefs: [
      { id: "a", label: "A", escalateBy: null },
      { id: "b", label: "B", escalateBy: null },
    ],
    slots: {
      a: { status: "covered", confidence: 1, evidence: [], lastUpdatedTs: 1 },
      b: { status: "covered", confidence: 1, evidence: [], lastUpdatedTs: 1 },
    } as unknown as SessionRecord["slots"],
    transcript: [],
    suggestions: [],
    talk: { repMs: 45, prospectMs: 55 },
    coaching: { questionsAsked: 8, repWpm: 150, longestMonologueMs: 1000, talkRatioRepPct: 45 },
    ...over,
  };
}

describe("buildScorecard", () => {
  it("returns empty reps with no history", () => {
    const report = buildScorecard(store);
    expect(report.reps).toEqual([]);
    expect(report.team).toBeNull();
  });

  it("scores a strong call near the top and grades it A", () => {
    store.save(rec()); // full coverage, 45% talk, 8 questions, no objections
    const report = buildScorecard(store);
    expect(report.reps.length).toBe(1);
    const me = report.reps[0]!;
    expect(me.rep).toBe("You");
    expect(me.calls).toBe(1);
    const discovery = me.skills.find((s) => s.key === "discovery")!;
    expect(discovery.score).toBe(100);
    const listening = me.skills.find((s) => s.key === "listening")!;
    expect(listening.score).toBe(100); // 45% is the ideal
    expect(me.overall).toBeGreaterThanOrEqual(70);
    expect(["A", "B"]).toContain(me.grade);
    expect(me.recent.length).toBe(1);
    expect(me.trend.length).toBe(1);
  });

  it("penalizes a lopsided, low-coverage call", () => {
    store.save(rec({
      slots: { a: { status: "empty", confidence: 0, evidence: [], lastUpdatedTs: 0 }, b: { status: "empty", confidence: 0, evidence: [], lastUpdatedTs: 0 } } as unknown as SessionRecord["slots"],
      coaching: { questionsAsked: 0, repWpm: 200, longestMonologueMs: 90000, talkRatioRepPct: 90 },
      talk: { repMs: 90, prospectMs: 10 },
    }));
    const me = buildScorecard(store).reps[0]!;
    expect(me.skills.find((s) => s.key === "discovery")!.score).toBe(0);
    expect(me.skills.find((s) => s.key === "listening")!.score).toBeLessThan(30);
    expect(me.overall).toBeLessThan(40);
    expect(me.grade).toBe("F");
  });

  it("scores objection handling by battlecard coverage", () => {
    store.save(rec({ objections: [{ ts: 1, type: "price", label: "Price", doc: "bc" }, { ts: 2, type: "timing", label: "Timing" }] }));
    const me = buildScorecard(store).reps[0]!;
    expect(me.skills.find((s) => s.key === "objection")!.score).toBe(50); // 1 of 2 had a doc
  });

  it("groups by rep and builds a team roll-up", () => {
    store.save(rec({ rep: "Alice" }));
    store.save(rec({ rep: "Bob" }));
    store.save(rec({ rep: "Bob" }));
    const report = buildScorecard(store);
    expect(report.reps.map((r) => r.rep).sort()).toEqual(["Alice", "Bob"]);
    expect(report.reps.find((r) => r.rep === "Bob")!.calls).toBe(2);
    expect(report.team).not.toBeNull();
    expect(report.team!.reps).toBe(2);
    expect(report.team!.calls).toBe(3);
  });

  it("defaults a missing rep to \"You\" and reports no team for a single rep", () => {
    store.save(rec({ rep: undefined }));
    const report = buildScorecard(store);
    expect(report.reps[0]!.rep).toBe("You");
    expect(report.team).toBeNull();
  });
});
