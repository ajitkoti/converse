/**
 * Objection detection — deterministic keyword cues on PROSPECT speech. When an
 * objection is detected we look up the most relevant context doc (battlecard)
 * and surface it, so the rep gets a grounded answer in the moment.
 */

export type ObjectionType = "price" | "timing" | "competitor" | "authority" | "trust" | "status-quo";

export interface ObjectionHit {
  type: ObjectionType;
  label: string;
  cue: string;
}

const RULES: Array<{ type: ObjectionType; label: string; rx: RegExp }> = [
  { type: "price", label: "Price", rx: /\b(too expensive|expensive|too much|out of (our )?budget|can'?t afford|pricey|the price|cost too|costs too)\b/i },
  { type: "timing", label: "Timing", rx: /\b(not (right )?now|too early|bad timing|next quarter|next year|revisit (this )?later|circle back|not a priority right now)\b/i },
  { type: "competitor", label: "Competitor", rx: /\b(already (use|using|have|on)|we use|current (tool|vendor|provider)|workday|salesforce|hubspot|competitor|incumbent)\b/i },
  { type: "authority", label: "Authority", rx: /\b(not my (call|decision)|need to (check|ask|run it by)|someone else (decides|owns)|above my pay|loop in)\b/i },
  { type: "trust", label: "Skepticism", rx: /\b(not sure (it|this) (will|would) work|skeptical|risky|prove it|too good to be true|does it really)\b/i },
  { type: "status-quo", label: "Status quo", rx: /\b(happy with (what|our)|fine as (it )?is|no plans to change|not looking to|good enough)\b/i },
];

export function detectObjection(prospectText: string): ObjectionHit | null {
  for (const r of RULES) {
    const m = r.rx.exec(prospectText);
    if (m) return { type: r.type, label: r.label, cue: m[0] };
  }
  return null;
}
