import { describe, it, expect } from "vitest";
import { analyzeCallHeuristic, analyzeCallLLM } from "../src/server/analysis.js";
import { buildSummaryMarkdown } from "../src/server/summary.js";
import type { LlmClient, LlmRequest } from "../src/engine/llm.js";
import type { SessionRecord } from "../src/server/types.js";

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "sess-test",
    startedAt: "2026-07-27T10:00:00.000Z",
    endedAt: "2026-07-27T10:03:00.000Z",
    mode: "demo",
    fixture: "good-call",
    framework: "meddpicc",
    durationMs: 120000,
    slotDefs: [
      { id: "identifyPain", label: "Pain", escalateBy: 25 },
      { id: "metrics", label: "Metrics", escalateBy: 35 },
      { id: "economicBuyer", label: "Economic buyer", escalateBy: 50 },
    ],
    slots: {
      identifyPain: { status: "covered", confidence: 0.9, evidence: ["losing ten hours a week"], lastUpdatedTs: 14000 },
      metrics: { status: "empty", confidence: 0, evidence: [], lastUpdatedTs: 0 },
      economicBuyer: { status: "empty", confidence: 0, evidence: [], lastUpdatedTs: 0 },
    } as unknown as SessionRecord["slots"],
    transcript: [
      { speaker: "rep", text: "Tell me about your current process.", tsStart: 0, tsEnd: 4000 },
      { speaker: "prospect", text: "We're losing ten hours a week on manual entry.", tsStart: 5000, tsEnd: 12000 },
    ],
    suggestions: [],
    talk: { repMs: 40000, prospectMs: 20000 },
    coaching: { questionsAsked: 3, repWpm: 150, longestMonologueMs: 20000, talkRatioRepPct: 66 },
    objections: [{ ts: 30000, type: "price", label: "Too expensive", doc: "pricing.md" }],
    ...overrides,
  };
}

describe("analyzeCallHeuristic", () => {
  it("derives went-well from covered slots and flags open ones", () => {
    const a = analyzeCallHeuristic(record());
    expect(a.wentWell.some((s) => s.includes("Pain"))).toBe(true);
    expect(a.didntGoWell.some((s) => s.includes("Metrics"))).toBe(true);
    expect(a.improvements.length).toBeGreaterThan(0);
    // a rep who talked 66% should get a listen-more nudge
    expect(a.improvements.some((s) => /listen|%/.test(s))).toBe(true);
    expect(a.followUpEmail).toContain("Hi there");
  });

  it("surfaces objections as red flags", () => {
    const a = analyzeCallHeuristic(record());
    expect(a.redFlags.some((s) => s.includes("Too expensive"))).toBe(true);
  });

  it("reports negative sentiment on very low coverage", () => {
    const r = record({
      slots: {
        identifyPain: { status: "empty", confidence: 0, evidence: [], lastUpdatedTs: 0 },
        metrics: { status: "empty", confidence: 0, evidence: [], lastUpdatedTs: 0 },
        economicBuyer: { status: "empty", confidence: 0, evidence: [], lastUpdatedTs: 0 },
      } as unknown as SessionRecord["slots"],
    });
    expect(analyzeCallHeuristic(r).sentiment.overall).toBe("negative");
  });

  it("always returns non-empty lists (offline demos still produce something)", () => {
    const a = analyzeCallHeuristic(record());
    expect(a.wentWell.length).toBeGreaterThan(0);
    expect(a.redFlags.length).toBeGreaterThan(0);
    expect(a.keyDecisions.length).toBeGreaterThan(0);
    expect(["positive", "neutral", "negative"]).toContain(a.sentiment.overall);
  });
});

describe("analyzeCallLLM", () => {
  it("parses model JSON and normalizes it", async () => {
    const seen: LlmRequest[] = [];
    const llm: LlmClient = {
      complete: async (r) => {
        seen.push(r);
        return JSON.stringify({
          wentWell: ["Built rapport"],
          didntGoWell: ["Left budget vague"],
          improvements: ["Ask about the buyer"],
          followUpEmail: "Hi — thanks for the chat.",
          missedOpportunities: ["Could have asked about timeline"],
          redFlags: ["No economic buyer identified"],
          budget: "Roughly $50k allocated.",
          keyDecisions: ["Board sign-off needed"],
          sentiment: { overall: "positive", rationale: "engaged prospect" },
        });
      },
    };
    const a = await analyzeCallLLM(llm, record(), "claude-sonnet-4");
    expect(a.wentWell).toEqual(["Built rapport"]);
    expect(a.budget).toContain("$50k");
    expect(a.sentiment.overall).toBe("positive");
    // it should have fed both coverage and transcript to the model
    expect(seen[0]!.user).toContain("Pain");
    expect(seen[0]!.user).toContain("losing ten hours a week");
  });

  it("coerces a bad sentiment value to neutral", async () => {
    const llm: LlmClient = {
      complete: async () => JSON.stringify({ wentWell: ["x"], sentiment: { overall: "ecstatic" } }),
    };
    const a = await analyzeCallLLM(llm, record(), "m");
    expect(a.sentiment.overall).toBe("neutral");
    expect(a.budget).toBe("Not established.");
  });

  it("throws on unparseable output so callers can fall back", async () => {
    const llm: LlmClient = { complete: async () => "not json at all" };
    await expect(analyzeCallLLM(llm, record(), "m")).rejects.toThrow();
  });
});

describe("summary markdown with analysis", () => {
  it("renders the AI debrief section when analysis is present", () => {
    const r = record({ analysis: analyzeCallHeuristic(record()) });
    const md = buildSummaryMarkdown(r);
    expect(md).toContain("AI deal debrief");
    expect(md).toContain("What went well");
    expect(md).toContain("Suggested follow-up email");
    expect(md).toContain("Sentiment");
  });

  it("omits the debrief section when analysis is absent", () => {
    expect(buildSummaryMarkdown(record())).not.toContain("AI deal debrief");
  });
});
