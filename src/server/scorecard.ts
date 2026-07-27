/**
 * Team scorecard & skill index. Rolls up saved calls into a per-rep skill
 * profile (discovery, listening, questioning, objection handling), an overall
 * grade, a per-call review list, and a trend — plus a team roll-up when more
 * than one rep is present.
 *
 * Everything is deterministic and derived from what we already record, so it
 * works offline. "Rep" comes from `record.rep` (stamped from Settings → Rep
 * name, default "You"); tag calls with different names to get a light team view.
 */

import type { SessionStore } from "./store.js";
import type { SessionRecord } from "./types.js";

export interface Skill {
  key: string;
  label: string;
  score: number; // 0..100
  hint: string;
}

export interface CallReview {
  id: string;
  startedAt: string;
  coveragePct: number;
  score: number;
  grade: string;
}

export interface RepScorecard {
  rep: string;
  calls: number;
  skills: Skill[];
  overall: number;
  grade: string;
  recent: CallReview[];
  trend: number[];
}

export interface ScorecardReport {
  reps: RepScorecard[];
  team: { reps: number; calls: number; avgCoverage: number; avgOverall: number } | null;
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

function coveragePct(r: SessionRecord): number {
  const covered = r.slotDefs.filter((s) => r.slots[s.id as keyof typeof r.slots]?.status === "covered").length;
  return r.slotDefs.length ? (covered / r.slotDefs.length) * 100 : 0;
}

function repTalkPct(r: SessionRecord): number {
  if (typeof r.coaching?.talkRatioRepPct === "number") return r.coaching.talkRatioRepPct;
  const total = (r.talk?.repMs ?? 0) + (r.talk?.prospectMs ?? 0);
  return total ? (r.talk!.repMs / total) * 100 : 50;
}

// --- per-call skill sub-scores (also reused for the per-call review grade) ---
const discoveryScore = (r: SessionRecord) => coveragePct(r);
/** Best around a ~45% rep talk-share; penalize deviation both ways. */
const listeningScore = (r: SessionRecord) => clamp(100 - Math.abs(repTalkPct(r) - 45) * 2);
/** 8+ good questions ≈ full marks. */
const questioningScore = (r: SessionRecord) => clamp(((r.coaching?.questionsAsked ?? 0) / 8) * 100);
/** Share of raised objections that had a battlecard to answer with; neutral if none. */
function objectionScore(r: SessionRecord): number {
  const objs = r.objections ?? [];
  if (!objs.length) return 70;
  return clamp((objs.filter((o) => o.doc).length / objs.length) * 100);
}

function callScore(r: SessionRecord): number {
  return Math.round((discoveryScore(r) + listeningScore(r) + questioningScore(r) + objectionScore(r)) / 4);
}

function grade(score: number): string {
  return score >= 85 ? "A" : score >= 70 ? "B" : score >= 55 ? "C" : score >= 40 ? "D" : "F";
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function repScorecard(rep: string, records: SessionRecord[]): RepScorecard {
  const discovery = clamp(mean(records.map(discoveryScore)));
  const listening = clamp(mean(records.map(listeningScore)));
  const questioning = clamp(mean(records.map(questioningScore)));
  const objection = clamp(mean(records.map(objectionScore)));
  const skills: Skill[] = [
    { key: "discovery", label: "Discovery & coverage", score: discovery, hint: "How much of the framework you qualify per call." },
    { key: "listening", label: "Listening", score: listening, hint: "Talk ratio — best around a 45% rep share." },
    { key: "questioning", label: "Questioning", score: questioning, hint: "How many good questions you ask (8+ is strong)." },
    { key: "objection", label: "Objection handling", score: objection, hint: "Share of objections you had a battlecard ready for." },
  ];
  const overall = clamp(mean(skills.map((s) => s.score)));
  const recent: CallReview[] = records
    .slice(-8)
    .reverse()
    .map((r) => {
      const score = callScore(r);
      return { id: r.id, startedAt: r.startedAt, coveragePct: Math.round(coveragePct(r)), score, grade: grade(score) };
    });
  const trend = records.slice(-12).map(callScore);
  return { rep, calls: records.length, skills, overall, grade: grade(overall), recent, trend };
}

export function buildScorecard(store: SessionStore): ScorecardReport {
  const all = store.allRecords(); // oldest → newest
  const byRep = new Map<string, SessionRecord[]>();
  for (const r of all) {
    const rep = (r.rep && r.rep.trim()) || "You";
    const list = byRep.get(rep) ?? [];
    list.push(r);
    byRep.set(rep, list);
  }
  const reps = [...byRep.entries()]
    .map(([rep, records]) => repScorecard(rep, records))
    .sort((a, b) => b.overall - a.overall || b.calls - a.calls);

  const team = reps.length > 1
    ? {
        reps: reps.length,
        calls: all.length,
        avgCoverage: clamp(mean(all.map(coveragePct))),
        avgOverall: clamp(mean(reps.map((r) => r.overall))),
      }
    : null;

  return { reps, team };
}
