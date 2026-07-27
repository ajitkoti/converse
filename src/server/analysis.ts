/**
 * Post-call deal analysis. One LLM pass over the transcript + qualification state
 * produces a structured debrief: what went well / didn't, how to improve, a
 * follow-up email, missed opportunities, red flags, budget + key decision points,
 * and sentiment. Falls back to a deterministic heuristic when no LLM key is set
 * (so demos still produce something).
 */

import { extractJson, type LlmClient } from "../engine/llm.js";
import type { CallAnalysis, SessionRecord } from "./types.js";

export type { CallAnalysis };

const SYSTEM = `You are a sales manager reviewing a rep's discovery call. From the transcript and the qualification coverage, produce a concise, honest debrief. Be specific and reference what was actually said. Do not invent facts.

Return ONLY JSON with exactly these keys:
{
 "wentWell": ["..."],
 "didntGoWell": ["..."],
 "improvements": ["..."],
 "followUpEmail": "a short, ready-to-send follow-up email to the prospect (plain text, ~120 words)",
 "missedOpportunities": ["moments the rep could have dug deeper but didn't"],
 "redFlags": ["risks to the deal"],
 "budget": "one sentence on what was learned about budget/economics (or 'Not established')",
 "keyDecisions": ["decision criteria, process, timeline, or people that matter"],
 "sentiment": {"overall": "positive|neutral|negative", "rationale": "one sentence"}
}
Keep each bullet to one sentence. 2-5 bullets per list.`;

function transcriptText(r: SessionRecord): string {
  return r.transcript
    .map((t) => `${t.speaker === "rep" ? "REP" : "PROSPECT"}: ${t.text}`)
    .join("\n")
    .slice(0, 12000);
}

function coverageText(r: SessionRecord): string {
  return r.slotDefs
    .map((d) => {
      const st = r.slots[d.id];
      const ev = st?.evidence?.[st.evidence.length - 1];
      return `- ${d.label}: ${st?.status ?? "empty"}${ev ? ` — "${ev}"` : ""}`;
    })
    .join("\n");
}

/** Run the LLM analysis. Throws on model error; callers can fall back. */
export async function analyzeCallLLM(llm: LlmClient, r: SessionRecord, model: string): Promise<CallAnalysis> {
  const user = `FRAMEWORK: ${r.framework ?? "meddpicc"}
COVERAGE:
${coverageText(r)}

TRANSCRIPT:
${transcriptText(r)}

Return the JSON now.`;
  const raw = await llm.complete({ system: SYSTEM, user, model, maxTokens: 1400, prefill: "{" });
  const parsed = extractJson<Partial<CallAnalysis>>(raw, "{");
  if (!parsed) throw new Error("analysis: could not parse model output");
  return normalize(parsed);
}

/** Deterministic fallback from the recorded state — used offline / on error. */
export function analyzeCallHeuristic(r: SessionRecord): CallAnalysis {
  const covered = r.slotDefs.filter((s) => r.slots[s.id]?.status === "covered");
  const open = r.slotDefs.filter((s) => r.slots[s.id]?.status !== "covered");
  const ev = (id: string) => {
    const st = r.slots[id];
    return st?.evidence?.[st.evidence.length - 1];
  };
  const coveragePct = r.slotDefs.length ? covered.length / r.slotDefs.length : 0;
  const objections = r.objections ?? [];
  const repPct = r.coaching?.talkRatioRepPct ?? 50;

  const wentWell = covered.map((s) => `Established ${s.label}${ev(s.id) ? `: "${ev(s.id)}"` : ""}`).slice(0, 5);
  if (!wentWell.length) wentWell.push("Kept the conversation going and gathered context.");

  const didntGoWell = open.map((s) => `${s.label} was left uncovered`).slice(0, 5);
  const improvements = open.length
    ? [`Next call, dig into: ${open.map((s) => s.label).join(", ")}.`]
    : ["Strong coverage — focus on advancing to next steps."];
  if (repPct > 65) improvements.push(`You spoke ${repPct}% of the time — ask more and listen.`);

  const redFlags: string[] = [];
  if (coveragePct < 0.4) redFlags.push("Low qualification coverage — deal is under-qualified.");
  for (const o of objections) redFlags.push(`${o.label} objection raised${o.doc ? ` (see ${o.doc})` : ""}.`);

  const budget = ev("metrics") || ev("economicBuyer") || ev("budget")
    ? `Signals: ${[ev("metrics"), ev("economicBuyer"), ev("budget")].filter(Boolean).join("; ")}`
    : "Not established.";

  const keyDecisions = ["decisionProcess", "decisionCriteria", "economicBuyer", "timeline", "authority", "decision"]
    .map((id) => ev(id) && `${id}: "${ev(id)}"`)
    .filter(Boolean) as string[];

  const overall = coveragePct > 0.6 && objections.length === 0 ? "positive" : coveragePct < 0.3 ? "negative" : "neutral";

  const nextSteps = open.length ? `cover ${open.slice(0, 3).map((s) => s.label).join(", ")}` : "align on next steps and timeline";
  const followUpEmail = `Hi there,\n\nThanks for the conversation today — really helpful to understand your situation${ev("identifyPain") || ev("pain") ? ` around ${(ev("identifyPain") || ev("pain"))!.slice(0, 60)}` : ""}. \n\nAs a next step, I'd love to ${nextSteps}. Are you open to a short follow-up this week?\n\nBest regards`;

  return {
    wentWell,
    didntGoWell: didntGoWell.length ? didntGoWell : ["Nothing major — good discovery."],
    improvements,
    followUpEmail,
    missedOpportunities: open.slice(0, 3).map((s) => `Could have asked about ${s.label}.`),
    redFlags: redFlags.length ? redFlags : ["None obvious."],
    budget,
    keyDecisions: keyDecisions.length ? keyDecisions : ["Not clearly established."],
    sentiment: { overall, rationale: `Coverage ${Math.round(coveragePct * 100)}%, ${objections.length} objection(s).` },
  };
}

function arr(x: unknown): string[] {
  return Array.isArray(x) ? x.map(String).filter(Boolean) : [];
}
function normalize(p: Partial<CallAnalysis>): CallAnalysis {
  const s = (p.sentiment ?? {}) as CallAnalysis["sentiment"];
  const overall = s.overall === "positive" || s.overall === "negative" ? s.overall : "neutral";
  return {
    wentWell: arr(p.wentWell),
    didntGoWell: arr(p.didntGoWell),
    improvements: arr(p.improvements),
    followUpEmail: typeof p.followUpEmail === "string" ? p.followUpEmail : "",
    missedOpportunities: arr(p.missedOpportunities),
    redFlags: arr(p.redFlags),
    budget: typeof p.budget === "string" ? p.budget : "Not established.",
    keyDecisions: arr(p.keyDecisions),
    sentiment: { overall, rationale: typeof s.rationale === "string" ? s.rationale : "" },
  };
}
