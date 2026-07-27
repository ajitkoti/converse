import { describe, it, expect } from "vitest";
import { QualificationEngine } from "../src/engine/qualification.js";
import { loadConfig } from "../src/engine/config.js";
import { MemoryLogger } from "../src/engine/logger.js";
import type { LlmClient } from "../src/engine/llm.js";
import type { SlotStates, TranscriptEvent } from "../src/engine/types.js";
import { FakeLlmClient } from "./support/fake-llm.js";
import { loadCallFixture } from "./support/fixtures.js";
import goodCall from "../src/fixtures/good-call.json" with { type: "json" };
import badCall from "../src/fixtures/bad-call.json" with { type: "json" };

async function feed(engine: QualificationEngine, events: TranscriptEvent[]): Promise<void> {
  for (const e of events) {
    engine.ingest(e);
    await engine.idle();
  }
  engine.flush(); // end-of-call: score the tail
  await engine.idle();
}

/** Returns fixed classifier/question responses from a queue. */
function scripted(responses: string[]): LlmClient {
  let i = 0;
  return {
    async complete() {
      return responses[i++] ?? '{"updates":[]}';
    },
  };
}

describe("QualificationEngine — Phase 2 state engine", () => {
  it("reaches sensible slot states on a GOOD discovery call", async () => {
    const engine = new QualificationEngine({ llm: new FakeLlmClient() });
    await feed(engine, loadCallFixture(goodCall));
    const s = engine.getSlots();

    expect(s.identifyPain.status).toBe("covered");
    expect(s.metrics.status).toBe("covered");
    expect(s.economicBuyer.status).toBe("covered");
    expect(s.decisionCriteria.status).toBe("covered");
    expect(s.decisionProcess.status).toBe("covered");
    expect(s.competition.status).toBe("covered");
    expect(s.champion.status).toBe("covered");
    expect(s.paperProcess.status).toBe("covered");

    // Evidence must be a verbatim PROSPECT quote.
    expect(s.economicBuyer.evidence[0]).toContain("cfo dana signs off");
  });

  it("leaves slots empty / partial on a BAD (vague) discovery call", async () => {
    const engine = new QualificationEngine({ llm: new FakeLlmClient() });
    await feed(engine, loadCallFixture(badCall));
    const s = engine.getSlots();

    expect(s.identifyPain.status).toBe("empty");
    expect(s.metrics.status).toBe("empty");
    expect(s.decisionCriteria.status).toBe("empty");
    expect(s.decisionProcess.status).toBe("empty");
    expect(s.competition.status).toBe("empty");
    // Vague authority answer must NOT be "covered".
    expect(s.economicBuyer.status).not.toBe("covered");
    expect(s.economicBuyer.status).toBe("partial");
  });

  it("rejects evidence that comes from the REP, not the prospect", async () => {
    // Classifier (wrongly) claims metrics covered, but the quote only appears in
    // a REP line. Engine must reject it: rep asking about budget != budget covered.
    const repQuote = "what is your budget for something like this";
    const log = new MemoryLogger();
    const engine = new QualificationEngine({
      llm: scripted([
        JSON.stringify({
          updates: [{ slot: "metrics", status: "covered", confidence: 0.9, quote: repQuote }],
        }),
      ]),
      logger: log,
      config: loadConfig({ classifier: { everyFinalUtterances: 1 } }),
    });

    engine.ingest(ev("rep", repQuote, 0, 4));
    engine.ingest(ev("prospect", "hmm i am not sure honestly", 5, 8));
    await engine.idle();

    expect(engine.getSlots().metrics.status).toBe("empty");
    const decisions = log.ofEvent("classify").flatMap((r) => r.decisions as { reason: string }[]);
    expect(decisions.some((d) => d.reason === "unverified-quote")).toBe(true);
  });

  it("never downgrades a covered slot", async () => {
    const quote = "we are bleeding twenty hours a week on this";
    const engine = new QualificationEngine({
      llm: scripted([
        JSON.stringify({
          updates: [{ slot: "identifyPain", status: "covered", confidence: 0.9, quote }],
        }),
        JSON.stringify({
          updates: [{ slot: "identifyPain", status: "partial", confidence: 0.4, quote }],
        }),
      ]),
      config: loadConfig({ classifier: { everyFinalUtterances: 1 } }),
    });

    engine.ingest(ev("prospect", quote, 0, 4));
    await engine.idle();
    expect(engine.getSlots().identifyPain.status).toBe("covered");

    engine.ingest(ev("prospect", quote, 5, 9));
    await engine.idle();
    // Second classify tried to downgrade to partial — must remain covered.
    expect(engine.getSlots().identifyPain.status).toBe("covered");
  });

  it("emits a slots GuidanceEvent when state changes", async () => {
    const quote = "our cfo maria has to approve anything over ten thousand dollars";
    const events: SlotStates[] = [];
    const engine = new QualificationEngine({
      llm: scripted([
        JSON.stringify({
          updates: [{ slot: "economicBuyer", status: "covered", confidence: 0.9, quote }],
        }),
      ]),
      config: loadConfig({ classifier: { everyFinalUtterances: 1 } }),
    });
    engine.on("guidance", (e) => {
      if (e.type === "slots") events.push(e.slots);
    });
    engine.ingest(ev("prospect", quote, 0, 5));
    await engine.idle();
    expect(events.length).toBe(1);
    expect(events[0]?.economicBuyer.status).toBe("covered");
  });
});

function ev(
  speaker: "rep" | "prospect",
  text: string,
  start: number,
  end: number,
): TranscriptEvent {
  return {
    speaker,
    text,
    tsStart: start * 1000,
    tsEnd: end * 1000,
    isFinal: true,
    utteranceEnd: false,
  };
}
