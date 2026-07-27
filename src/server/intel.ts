/**
 * In-call intelligence: proactively surface the right sales asset the moment it
 * would help — a competitor battlecard when a rival is named, or a case study /
 * proof point when the prospect asks for evidence.
 *
 * Detection is deterministic (keyword cues on PROSPECT speech). The asset itself
 * comes from the Context library (your battlecards / case studies as Markdown),
 * so what gets surfaced is grounded in YOUR playbook. Competitor names are the
 * union of a small default set, any names you list in Settings, and names
 * inferred from your context doc filenames (e.g. "battlecard-vs-workday" →
 * "workday"), so simply adding a battlecard teaches the scout a new competitor.
 */

import type { ContextLibrary } from "./context.js";

export type IntelKind = "competitor" | "proof-point";

export interface IntelHit {
  kind: IntelKind;
  /** short headline for the card, e.g. `Competitor: Workday` */
  label: string;
  /** the phrase that triggered it (verbatim) */
  cue: string;
  /** the matched context doc, if any */
  doc?: string;
  /** a short snippet from that doc */
  snippet?: string;
}

/** Common HR/CRM/sales tools we recognize out of the box. */
const DEFAULT_COMPETITORS = [
  "workday", "salesforce", "hubspot", "gong", "outreach", "salesloft", "clari",
  "zoominfo", "apollo", "chorus", "people.ai", "sap", "oracle", "netsuite",
];

/** Cues where the prospect is asking for evidence / social proof / ROI. */
const PROOF_RULES: Array<{ label: string; rx: RegExp }> = [
  { label: "Asked for proof", rx: /\b(prove it|show me proof|any proof|case study|case studies|reference|references|referenceable)\b/i },
  { label: "Wants similar customers", rx: /\b(customers like (us|me)|companies like (us|ours)|someone in our (space|industry|vertical)|similar (company|companies|customer))\b/i },
  { label: "Asked about results/ROI", rx: /\b(what (kind of )?results|roi|return on investment|payback|how much (did|do) (they|customers) save|success stories|track record)\b/i },
  { label: "Skeptical it works", rx: /\b(does it really work|will it actually work|too good to be true|sounds too|not convinced|hard to believe)\b/i },
];

const PROOF_QUERY = "case study proof results roi customer success reference outcome savings";

/** Escape a competitor name for use inside a RegExp. */
function escapeRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class IntelScout {
  #context: ContextLibrary;
  #competitors: string[];

  constructor(context: ContextLibrary, extraCompetitors: string[] = []) {
    this.#context = context;
    this.#competitors = dedupe([
      ...DEFAULT_COMPETITORS,
      ...extraCompetitors.map((c) => c.toLowerCase().trim()).filter(Boolean),
      ...inferCompetitorsFromDocs(context),
    ]);
  }

  /** The competitor names the scout will recognize (for docs / UI). */
  get competitors(): string[] {
    return [...this.#competitors];
  }

  /**
   * Inspect one prospect utterance. Returns the first competitor mention, else
   * the first proof-request cue, else null. Competitor wins because naming a
   * rival is the more time-sensitive moment.
   */
  detect(prospectText: string): IntelHit | null {
    const comp = this.#matchCompetitor(prospectText);
    if (comp) return comp;
    return this.#matchProof(prospectText);
  }

  #matchCompetitor(text: string): IntelHit | null {
    for (const name of this.#competitors) {
      const rx = new RegExp(`\\b${escapeRx(name)}\\b`, "i");
      const m = rx.exec(text);
      if (m) {
        const match = this.#context.bestMatch(`${name} battlecard competitor ${text}`);
        return {
          kind: "competitor",
          label: `Competitor: ${titleCase(name)}`,
          cue: m[0],
          doc: match?.name,
          snippet: match?.snippet,
        };
      }
    }
    return null;
  }

  #matchProof(text: string): IntelHit | null {
    for (const r of PROOF_RULES) {
      const m = r.rx.exec(text);
      if (m) {
        const match = this.#context.bestMatch(`${PROOF_QUERY} ${text}`);
        return {
          kind: "proof-point",
          label: r.label,
          cue: m[0],
          doc: match?.name,
          snippet: match?.snippet,
        };
      }
    }
    return null;
  }
}

/** Pull competitor names out of context filenames like "battlecard-vs-workday". */
function inferCompetitorsFromDocs(context: ContextLibrary): string[] {
  const out: string[] = [];
  for (const { name } of context.list()) {
    const lower = name.toLowerCase();
    if (!/(battlecard|competitor|vs)/.test(lower)) continue;
    const m = /(?:vs|versus)[-_ ]+([a-z0-9][a-z0-9 ._-]*)/.exec(lower);
    if (m && m[1]) out.push(m[1].replace(/[-_]+/g, " ").trim());
  }
  return out;
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs.filter(Boolean))];
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
