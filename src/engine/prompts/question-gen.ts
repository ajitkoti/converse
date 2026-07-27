/**
 * PROMPT FILE — bridging-question generation. Prose edited more than code.
 * The engine only calls buildQuestionPrompt().
 *
 * Constraint: ONE question, <= maxWords words, conversational, MUST reference
 * something the prospect actually said. Generic questions are a failure.
 */

import type { SlotDef } from "../config.js";

export const QUESTION_SYSTEM = `You are a real-time sales copilot whispering the NEXT question into a rep's ear during a live discovery call. A qualification area is under-covered and the prospect just paused — this is the moment to bridge to it naturally.

Write ONE question the rep can ask right now. Requirements:
- It MUST reference something the PROSPECT actually said in the transcript below — hook onto their words, their situation, their last point. This is the whole job.
- Conversational and specific, the way a sharp rep talks. Not a survey question.
- Hard limit: {{MAX_WORDS}} words. Shorter is better.
- It must move toward the target area WITHOUT sounding like an interrogation.

FAILURE (never do this): generic textbook questions with no connection to what was said. "Who is the economic buyer?" / "What are your decision criteria?" / "What is your budget?" are automatic failures.

Return ONLY JSON, no prose: {"question":"<the question>"}`;

const SLOT_GUIDANCE: Record<string, string> = {
  metrics: "Get them to quantify the impact — hours, dollars, %, headcount, time.",
  economicBuyer: "Surface who actually signs off / owns the budget, without asking bluntly.",
  decisionCriteria: "Draw out what they'll actually judge a solution on.",
  decisionProcess: "Map the steps/timeline from here to a decision.",
  paperProcess: "Uncover procurement / legal / security / contracting hurdles.",
  identifyPain: "Deepen the pain — the concrete consequence of the status quo.",
  champion: "Find/strengthen an internal advocate who'll push this forward.",
  competition: "Learn what else they're weighing, including doing nothing.",
};

export function buildQuestionPrompt(
  slot: SlotDef,
  windowText: string,
  maxWords: number,
): { system: string; user: string; prefill: string } {
  const system = QUESTION_SYSTEM.replace("{{MAX_WORDS}}", String(maxWords));
  const guidance = SLOT_GUIDANCE[slot.id] ?? `Advance coverage of ${slot.label}.`;
  const user = `TARGET AREA: ${slot.label} (${slot.id})
GOAL: ${guidance}

RECENT TRANSCRIPT (hook your question onto what the PROSPECT said):
${windowText || "(no recent speech)"}

Return the JSON now.`;
  return { system, user, prefill: '{"question":"' };
}

export interface QuestionOutput {
  question: string;
}
