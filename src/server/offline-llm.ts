/**
 * Offline LlmClient — a deterministic, keyword-based stand-in for the real
 * models. Powers DEMO MODE (zero API keys) and the test suite. It is intentionally
 * simple: its job is to drive the engine's mechanics convincingly, not to be
 * smart. Live mode uses claude-haiku-4-5 instead.
 */

import type { LlmClient, LlmRequest } from "../engine/llm.js";

export interface OfflineLlmOptions {
  /** artificial latency (ms) for question generation, to exercise the drop rule */
  questionLatencyMs?: number;
  onDelay?: (ms: number) => void | Promise<void>;
}

export class OfflineLlmClient implements LlmClient {
  #opts: OfflineLlmOptions;
  constructor(opts: OfflineLlmOptions = {}) {
    this.#opts = opts;
  }
  async complete(req: LlmRequest): Promise<string> {
    if (req.prefill?.startsWith('{"question"')) {
      if (this.#opts.questionLatencyMs && this.#opts.onDelay) {
        await this.#opts.onDelay(this.#opts.questionLatencyMs);
      }
      return JSON.stringify({ question: deriveQuestion(req.user) });
    }
    return JSON.stringify({ updates: keywordClassify(req.user) });
  }
}

export interface OfflineUpdate {
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

export function keywordClassify(userPrompt: string): OfflineUpdate[] {
  const prospectLines = userPrompt
    .split("\n")
    .filter((l) => l.startsWith("PROSPECT:"))
    .map((l) => l.slice("PROSPECT:".length).trim());

  const updates: OfflineUpdate[] = [];
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
    if (hasQuantity) add("metrics", "covered", line);
    if (/(cfo|ceo|vp of|signs? off|sign off|owns the budget|budget owner)/i.test(line)) {
      add("economicBuyer", vague ? "partial" : "covered", line);
    } else if (/\b(finance|approve|budget)\b/i.test(line)) {
      add("economicBuyer", "partial", line);
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

export function deriveQuestion(userPrompt: string): string {
  const lines = userPrompt.split("\n").filter((l) => l.startsWith("PROSPECT:"));
  const lastProspect = lines[lines.length - 1];
  const hook = lastProspect ? lastProspect.slice("PROSPECT:".length).trim() : "";
  const target = /TARGET AREA:\s*(.+?)\s*\(/.exec(userPrompt)?.[1] ?? "that";

  const shortHook = hook.split(/\s+/).slice(-6).join(" ");
  const templates: Record<string, string> = {
    Pain: `You mentioned ${shortHook} — what's that costing the team each week?`,
    Metrics: `On ${shortHook} — can you put a rough number on the impact?`,
    "Econ Buyer": `When you say ${shortHook}, who signs off on the budget for it?`,
    Criteria: `Given ${shortHook}, what would a solution absolutely have to do?`,
    Process: `After ${shortHook}, how does a decision like this actually get made?`,
    Champion: `You clearly feel ${shortHook} — would you push for this internally?`,
    Competition: `Besides ${shortHook}, what else are you weighing, including doing nothing?`,
    Paper: `Before ${shortHook} goes live, what does procurement or legal need?`,
  };
  return templates[target] ?? `You said ${shortHook} — tell me more about ${target.toLowerCase()}?`;
}
