import type { LlmClient, LlmRequest } from "../../src/engine/llm.js";

/**
 * A controllable monotonic clock for latency-drop tests. The engine measures
 * LLM latency as monotonicNow()after - before; advancing this clock inside the
 * fake's question handler simulates a slow generation.
 */
export class FakeClock {
  #t = 0;
  now = (): number => this.#t;
  advance(ms: number): void {
    this.#t += ms;
  }
}

export interface FakeLlmOptions {
  /** ms to advance `clock` during each question-gen call (simulated latency). */
  questionLatencyMs?: number;
  clock?: FakeClock;
  /** override the generated question text (default derives from window). */
  questionText?: (windowText: string) => string;
}

/**
 * Offline stand-in for the LLM. Dispatches by prefill:
 *  - classifier ({"updates":…}) → deterministic keyword classifier over the window
 *  - question   ({"question":"…}) → a short question referencing the window
 * Records every request for assertions.
 */
export class FakeLlmClient implements LlmClient {
  readonly calls: LlmRequest[] = [];
  #opts: FakeLlmOptions;
  constructor(opts: FakeLlmOptions = {}) {
    this.#opts = opts;
  }

  get classifierCalls(): LlmRequest[] {
    return this.calls.filter((c) => c.prefill?.startsWith('{"updates"'));
  }
  get questionCalls(): LlmRequest[] {
    return this.calls.filter((c) => c.prefill?.startsWith('{"question"'));
  }

  async complete(req: LlmRequest): Promise<string> {
    this.calls.push(req);
    if (req.prefill?.startsWith('{"question"')) {
      if (this.#opts.questionLatencyMs && this.#opts.clock) {
        this.#opts.clock.advance(this.#opts.questionLatencyMs);
      }
      const q = this.#opts.questionText
        ? this.#opts.questionText(req.user)
        : deriveQuestion(req.user);
      return JSON.stringify({ question: q });
    }
    // classifier
    return JSON.stringify({ updates: keywordClassify(req.user) });
  }
}

interface Update {
  slot: string;
  status: "partial" | "covered";
  confidence: number;
  quote: string;
}

const VAGUE =
  /\b(depends|probably|someone|not sure|not really sure|hard to say|varies|have to see|could not tell|exploring|kind of)\b/i;
const WORDNUM =
  /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million)\b/i;
const UNIT = /\b(hours?|hrs?|dollars?|bucks|percent|%|weeks?|months?|quarters?|fte|ftes|headcount)\b/i;

/**
 * A deterministic, keyword-based stand-in for the real classifier. It emits the
 * EXACT prospect line as the supporting quote, so the engine's verbatim/prospect
 * verification passes. It is intentionally simple — its job is to exercise the
 * engine's merge/cadence/escalation mechanics offline, not to be smart. Real
 * judgement comes from claude-haiku-4-5 in production.
 */
export function keywordClassify(userPrompt: string): Update[] {
  const prospectLines = userPrompt
    .split("\n")
    .filter((l) => l.startsWith("PROSPECT:"))
    .map((l) => l.slice("PROSPECT:".length).trim());

  const updates: Update[] = [];
  const seen = new Set<string>();
  const add = (slot: string, status: "partial" | "covered", quote: string) => {
    const key = `${slot}:${quote}`;
    if (seen.has(key)) return;
    seen.add(key);
    updates.push({ slot, status, confidence: status === "covered" ? 0.85 : 0.5, quote });
  };

  for (const line of prospectLines) {
    const vague = VAGUE.test(line);
    const hasQuantity = (/\d/.test(line) || WORDNUM.test(line)) && UNIT.test(line);

    if (/(losing|struggl|burn|manual|waste|wasting|painful|problem|reconciliation)/i.test(line)) {
      add("identifyPain", vague ? "partial" : "covered", line);
    }
    if (hasQuantity) {
      add("metrics", "covered", line); // quantified impact counts even if hedged
    }
    if (/(cfo|ceo|vp of|signs? off|sign off|owns the budget|budget owner)/i.test(line)) {
      add("economicBuyer", vague ? "partial" : "covered", line);
    } else if (/\b(finance|approve|budget)\b/i.test(line)) {
      add("economicBuyer", "partial", line); // generic/vague authority signal
    }
    if (/(integrate|requirement|has to|must |soc two|soc 2|criteria|compliance)/i.test(line)) {
      add("decisionCriteria", vague ? "partial" : "covered", line);
    }
    if (/(pilot|exec team|q three|q3|final approval|sign-off timeline)/i.test(line)) {
      add("decisionProcess", vague ? "partial" : "covered", line);
    }
    if (/(workday|salesforce|competitor|looked at|other option|alternativ)/i.test(line)) {
      add("competition", vague ? "partial" : "covered", line);
    }
    if (/(push hard|championing|i would push|advocate|feeling the pain)/i.test(line)) {
      add("champion", vague ? "partial" : "covered", line);
    }
    if (/(legal review|security review|procurement|contract)/i.test(line)) {
      add("paperProcess", vague ? "partial" : "covered", line);
    }
  }
  return updates;
}

function deriveQuestion(userPrompt: string): string {
  const lastProspect = userPrompt
    .split("\n")
    .filter((l) => l.startsWith("PROSPECT:"))
    .pop();
  const hook = lastProspect ? lastProspect.slice("PROSPECT:".length).trim().slice(0, 24) : "that";
  return `You mentioned ${hook} — who ultimately signs off on the budget for it?`;
}
