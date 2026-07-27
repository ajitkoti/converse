/**
 * Pre-call brief — a one-screen briefing to read before you dial: who you're
 * talking to, a recap of your last call with them, a suggested agenda (open
 * qualification gaps first), the objections you're most likely to hit, and an
 * opening line.
 *
 * The heuristic version is built entirely from saved history + the active
 * framework, so it works offline. When an LLM key is set, one pass tightens the
 * agenda / opener / likely objections using the recap as grounding.
 */

import { loadConfig } from "../engine/config.js";
import { extractJson, type LlmClient } from "../engine/llm.js";
import { frameworkOverride } from "./frameworks.js";
import type { SessionStore } from "./store.js";
import type { Settings } from "./settings.js";
import type { SessionRecord } from "./types.js";

export interface LastCallRecap {
  id: string;
  startedAt: string;
  coveredPct: number;
  open: string[];
  objections: string[];
  competitors: string[];
  notes?: string;
  sentiment?: string;
}

export interface PreCallBrief {
  persona?: string;
  account?: string;
  framework: string;
  lastCall: LastCallRecap | null;
  agenda: string[];
  likelyObjections: Array<{ label: string; why: string }>;
  openingLine: string;
  generatedBy: "llm" | "heuristic";
}

export interface BriefOptions {
  persona?: string;
  account?: string;
}

/** Active framework's slot labels (used for the agenda when there's no history). */
function frameworkSlots(settings: Settings): { framework: string; labels: string[] } {
  const framework = settings.get().framework || "meddpicc";
  const cfg = loadConfig(frameworkOverride(framework) ?? undefined);
  return { framework, labels: cfg.slots.map((s) => s.label) };
}

/** Most recent saved record, optionally biased to ones matching the persona/account text. */
function pickLastCall(store: SessionStore, opts: BriefOptions): SessionRecord | null {
  const all = store.allRecords(); // oldest → newest
  if (!all.length) return null;
  const needle = `${opts.persona ?? ""} ${opts.account ?? ""}`.toLowerCase().trim();
  if (needle) {
    const matches = all.filter((r) => {
      const hay = `${r.persona ?? ""} ${r.notes ?? ""}`.toLowerCase();
      return needle.split(/\s+/).some((w) => w.length > 2 && hay.includes(w));
    });
    if (matches.length) return matches[matches.length - 1]!;
  }
  return all[all.length - 1]!;
}

function recapOf(r: SessionRecord): LastCallRecap {
  const covered = r.slotDefs.filter((s) => r.slots[s.id as keyof typeof r.slots]?.status === "covered").length;
  const open = r.slotDefs.filter((s) => r.slots[s.id as keyof typeof r.slots]?.status !== "covered").map((s) => s.label);
  return {
    id: r.id,
    startedAt: r.startedAt,
    coveredPct: r.slotDefs.length ? Math.round((covered / r.slotDefs.length) * 100) : 0,
    open,
    objections: [...new Set((r.objections ?? []).map((o) => o.label))],
    competitors: [...new Set((r.intel ?? []).filter((i) => i.kind === "competitor").map((i) => i.label.replace(/^Competitor:\s*/, "")))],
    notes: r.notes,
    sentiment: r.analysis?.sentiment.overall,
  };
}

/** Tally objection labels across all history, most frequent first. */
function frequentObjections(store: SessionStore): Array<{ label: string; count: number }> {
  const tally = new Map<string, number>();
  for (const r of store.allRecords()) {
    for (const label of new Set((r.objections ?? []).map((o) => o.label))) {
      tally.set(label, (tally.get(label) ?? 0) + 1);
    }
  }
  return [...tally.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
}

/** Deterministic brief from history + framework. Always returns something. */
export function buildPreCallBrief(store: SessionStore, settings: Settings, opts: BriefOptions = {}): PreCallBrief {
  const { framework, labels } = frameworkSlots(settings);
  const record = pickLastCall(store, opts);
  const lastCall = record ? recapOf(record) : null;

  // Agenda: open gaps from last call first, then the rest of the framework.
  const openFirst = lastCall
    ? [...lastCall.open, ...labels.filter((l) => !lastCall.open.includes(l))]
    : labels;
  const agenda: string[] = [];
  if (lastCall) agenda.push(`Recap where you left off (last call: ${lastCall.coveredPct}% covered).`);
  for (const l of openFirst.slice(0, 5)) agenda.push(`Cover ${l}.`);
  agenda.push("Agree a concrete next step + timeline.");

  // Likely objections: last-call ones + most frequent across history.
  const seen = new Set<string>();
  const likelyObjections: Array<{ label: string; why: string }> = [];
  for (const label of lastCall?.objections ?? []) {
    if (seen.has(label)) continue;
    seen.add(label);
    likelyObjections.push({ label, why: "raised on your last call — be ready for it again" });
  }
  for (const { label, count } of frequentObjections(store)) {
    if (seen.has(label)) continue;
    seen.add(label);
    likelyObjections.push({ label, why: `came up on ${count} prior call${count > 1 ? "s" : ""}` });
    if (likelyObjections.length >= 4) break;
  }
  if (!likelyObjections.length) {
    for (const label of ["Price", "Timing", "Status quo"]) likelyObjections.push({ label, why: "common at this stage" });
  }

  const who = opts.persona || record?.persona;
  let openingLine: string;
  if (record && lastCall) {
    const coveredLabels = record.slotDefs
      .filter((s) => record.slots[s.id as keyof typeof record.slots]?.status === "covered")
      .map((s) => s.label);
    const dug = coveredLabels.slice(0, 2).join(" and ") || "your situation";
    const close = lastCall.open.slice(0, 2).join(" and ") || "next steps";
    openingLine = `Last time we dug into ${dug}. Today I'd love to close the loop on ${close} — does that work?`;
  } else {
    openingLine = `Thanks for the time${who ? `, ${who}` : ""}. To make this useful, I'd like to understand your current process and what "great" would look like — mind if I ask a few questions?`;
  }

  return {
    persona: opts.persona,
    account: opts.account,
    framework,
    lastCall,
    agenda,
    likelyObjections,
    openingLine,
    generatedBy: "heuristic",
  };
}

const SYSTEM = `You are a sales manager prepping a rep for a discovery/follow-up call. Given who they're meeting, a recap of the last call, and the qualification framework, produce a tight, specific pre-call brief. Do not invent facts not implied by the recap.

Return ONLY JSON:
{
 "agenda": ["3-5 short, ordered talking points; open gaps first"],
 "likelyObjections": [{"label":"short name","why":"one clause"}],
 "openingLine": "one natural opening sentence the rep can say"
}`;

/** Tighten a heuristic brief with one LLM pass. Throws on model error (caller falls back). */
export async function enhancePreCallBriefLLM(llm: LlmClient, brief: PreCallBrief, model: string): Promise<PreCallBrief> {
  const recap = brief.lastCall
    ? `Last call ${new Date(brief.lastCall.startedAt).toLocaleDateString()}: ${brief.lastCall.coveredPct}% covered. Open gaps: ${brief.lastCall.open.join(", ") || "none"}. Objections: ${brief.lastCall.objections.join(", ") || "none"}. Competitors named: ${brief.lastCall.competitors.join(", ") || "none"}. Sentiment: ${brief.lastCall.sentiment ?? "n/a"}. Notes: ${brief.lastCall.notes ?? "none"}.`
    : "No prior call on record.";
  const user = `WHO: ${brief.persona || "unknown persona"}${brief.account ? ` at ${brief.account}` : ""}
FRAMEWORK: ${brief.framework}
${recap}
Draft agenda: ${brief.agenda.join(" | ")}

Return the JSON now.`;
  const raw = await llm.complete({ system: SYSTEM, user, model, maxTokens: 700, prefill: "{" });
  const parsed = extractJson<{ agenda?: unknown; likelyObjections?: unknown; openingLine?: unknown }>(raw, "{");
  if (!parsed) throw new Error("precall: could not parse model output");
  const agenda = Array.isArray(parsed.agenda) ? parsed.agenda.map(String).filter(Boolean) : [];
  const objs = Array.isArray(parsed.likelyObjections)
    ? parsed.likelyObjections
        .map((o) => (o && typeof o === "object" ? { label: String((o as Record<string, unknown>).label ?? ""), why: String((o as Record<string, unknown>).why ?? "") } : null))
        .filter((o): o is { label: string; why: string } => Boolean(o && o.label))
    : [];
  return {
    ...brief,
    agenda: agenda.length ? agenda : brief.agenda,
    likelyObjections: objs.length ? objs : brief.likelyObjections,
    openingLine: typeof parsed.openingLine === "string" && parsed.openingLine.trim() ? parsed.openingLine.trim() : brief.openingLine,
    generatedBy: "llm",
  };
}
