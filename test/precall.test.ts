import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore, makeSessionId } from "../src/server/store.js";
import { Settings } from "../src/server/settings.js";
import { buildPreCallBrief, enhancePreCallBriefLLM } from "../src/server/precall.js";
import type { LlmClient } from "../src/engine/llm.js";
import type { SessionRecord } from "../src/server/types.js";

let tmp: string;
let store: SessionStore;
let settings: Settings;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "converse-precall-"));
  store = new SessionStore(tmp);
  settings = new Settings(path.join(tmp, "c.json"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function rec(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: makeSessionId(new Date("2026-07-20T10:00:00Z"), Math.random().toString(36).slice(2, 6)),
    startedAt: "2026-07-20T10:00:00.000Z",
    endedAt: "2026-07-20T10:05:00.000Z",
    mode: "live",
    persona: "CFO at Northwind",
    framework: "meddpicc",
    durationMs: 300000,
    slotDefs: [
      { id: "identifyPain", label: "Pain", escalateBy: 25 },
      { id: "metrics", label: "Metrics", escalateBy: 35 },
      { id: "economicBuyer", label: "Economic buyer", escalateBy: 50 },
    ],
    slots: {
      identifyPain: { status: "covered", confidence: 0.9, evidence: ["losing 10 hours a week"], lastUpdatedTs: 1 },
      metrics: { status: "empty", confidence: 0, evidence: [], lastUpdatedTs: 0 },
      economicBuyer: { status: "empty", confidence: 0, evidence: [], lastUpdatedTs: 0 },
    } as unknown as SessionRecord["slots"],
    transcript: [],
    suggestions: [],
    talk: { repMs: 1, prospectMs: 1 },
    objections: [{ ts: 1000, type: "price", label: "Price", doc: "battlecard" }],
    intel: [{ ts: 2000, kind: "competitor", label: "Competitor: Workday" }],
    ...over,
  };
}

describe("buildPreCallBrief (heuristic)", () => {
  it("returns a first-meeting brief when there is no history", () => {
    const b = buildPreCallBrief(store, settings, { persona: "VP Sales" });
    expect(b.lastCall).toBeNull();
    expect(b.generatedBy).toBe("heuristic");
    expect(b.agenda.length).toBeGreaterThan(0);
    expect(b.openingLine).toContain("VP Sales");
    // no history → default likely objections
    expect(b.likelyObjections.map((o) => o.label)).toContain("Price");
  });

  it("recaps the last call and puts open gaps first in the agenda", () => {
    store.save(rec());
    const b = buildPreCallBrief(store, settings, {});
    expect(b.lastCall).not.toBeNull();
    expect(b.lastCall!.coveredPct).toBe(33); // 1 of 3
    expect(b.lastCall!.open).toContain("Metrics");
    expect(b.lastCall!.competitors).toContain("Workday");
    // first agenda item after the recap should target an open gap
    expect(b.agenda.some((a) => a.includes("Metrics"))).toBe(true);
    // last-call objection should surface as a likely objection
    expect(b.likelyObjections.some((o) => o.label === "Price")).toBe(true);
  });

  it("biases last-call selection toward a matching persona", () => {
    store.save(rec({ persona: "CFO at Northwind", notes: "northwind deal" }));
    store.save(rec({ id: makeSessionId(new Date("2026-07-25T10:00:00Z"), "zzzz"), startedAt: "2026-07-25T10:00:00.000Z", persona: "VP Eng at Acme", notes: "acme" }));
    const b = buildPreCallBrief(store, settings, { persona: "Northwind" });
    // even though the Acme call is newer, the Northwind match should win
    expect(b.lastCall!.notes).toContain("northwind");
  });
});

describe("enhancePreCallBriefLLM", () => {
  it("overlays the model's agenda/opener and marks it llm-generated", async () => {
    store.save(rec());
    const base = buildPreCallBrief(store, settings, {});
    const llm: LlmClient = {
      complete: async () => JSON.stringify({
        agenda: ["Reconnect on the 10 hrs/wk pain", "Nail down the economic buyer"],
        likelyObjections: [{ label: "Price", why: "CFO will push on cost" }],
        openingLine: "Great to reconnect — last time we scoped the reconciliation pain.",
      }),
    };
    const out = await enhancePreCallBriefLLM(llm, base, "m");
    expect(out.generatedBy).toBe("llm");
    expect(out.agenda[0]).toContain("Reconnect");
    expect(out.openingLine).toContain("reconnect");
  });

  it("throws on unparseable output so the caller can fall back", async () => {
    const base = buildPreCallBrief(store, settings, {});
    const llm: LlmClient = { complete: async () => "sorry, no json" };
    await expect(enhancePreCallBriefLLM(llm, base, "m")).rejects.toThrow();
  });
});
