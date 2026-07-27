/**
 * Objection trees — a multi-step response flow for each objection type, instead
 * of a single battlecard hit. The classic sequence is
 * acknowledge → reframe → evidence → advance: don't argue, validate the concern,
 * reframe to value, back it with proof, then propose a concrete next step.
 *
 * These are deterministic, offline defaults grounded in the MEDDPICC mindset.
 * They pair with the battlecard the objection detector already surfaces (the
 * "evidence" step points the rep at it), so the rep gets both a doc AND a play.
 */

import type { ObjectionType } from "./objections.js";

export interface ObjectionStep {
  /** stage label, e.g. "Acknowledge" */
  label: string;
  /** a ready-to-say line the rep can adapt */
  say: string;
}

const TREES: Record<ObjectionType, ObjectionStep[]> = {
  price: [
    { label: "Acknowledge", say: "Totally fair to pressure-test the investment — let's make sure it pays for itself." },
    { label: "Reframe to value", say: "What's the cost of the status quo today — the hours, the errors, the missed deals?" },
    { label: "Evidence", say: "Share the ROI / payback proof point (see the surfaced battlecard or case study)." },
    { label: "Advance", say: "If we can show payback inside 90 days, is price still the blocker — or is it a yes?" },
  ],
  timing: [
    { label: "Acknowledge", say: "Makes sense — timing has to be right for this to land." },
    { label: "Reframe to cost of delay", say: "What does waiting a quarter cost you in [their metric]? Does the problem get cheaper or more expensive?" },
    { label: "Evidence", say: "Reference a customer who moved fast and the payback they saw." },
    { label: "Advance", say: "What if we scoped a small pilot now so you're ready when budget opens — no big commit?" },
  ],
  competitor: [
    { label: "Acknowledge", say: "Good — [competitor] is a solid choice, so you clearly take this seriously." },
    { label: "Differentiate", say: "Where teams switch to us is [your #1 differentiator] — is that something you're feeling today?" },
    { label: "Evidence", say: "Open the head-to-head battlecard and cite the switch-story proof point." },
    { label: "Advance", say: "Worth a side-by-side on [the one axis they care about] so you can compare directly?" },
  ],
  authority: [
    { label: "Acknowledge", say: "Of course — a decision like this should involve the right people." },
    { label: "Map the process", say: "Who else weighs in, and what does each of them need to see to say yes?" },
    { label: "Arm the champion", say: "I'll give you a one-pager tailored to [economic buyer] so it's easy to socialize." },
    { label: "Advance", say: "Can we get 20 minutes with them together next week so nothing gets lost in translation?" },
  ],
  trust: [
    { label: "Acknowledge", say: "Healthy skepticism — you should make us prove it." },
    { label: "Reduce risk", say: "Which specific outcome do you need to believe before this is real for you?" },
    { label: "Evidence", say: "Share the closest case study / reference (see the surfaced proof point)." },
    { label: "Advance", say: "Want a success-criteria pilot so the proof is your own data, not our slides?" },
  ],
  "status-quo": [
    { label: "Acknowledge", say: "If it's working, changing it has to be clearly worth it — agreed." },
    { label: "Surface the gap", say: "If nothing changed for 12 months, what does that cost you — and is that acceptable?" },
    { label: "Evidence", say: "Cite a peer who thought they were fine and what they gained by moving." },
    { label: "Advance", say: "Worth a quick benchmark against similar teams so you can decide with data?" },
  ],
};

/** The response flow for an objection type. Always returns at least a stub. */
export function objectionTree(type: ObjectionType): ObjectionStep[] {
  return TREES[type] ?? [
    { label: "Acknowledge", say: "Hear the concern and validate it before responding." },
    { label: "Reframe", say: "Reframe to the value / cost of not solving it." },
    { label: "Evidence", say: "Back it with a proof point or reference." },
    { label: "Advance", say: "Propose a concrete, low-risk next step." },
  ];
}
