import type { SlotStates } from "../engine/types.js";

export interface SlotDefWire {
  id: string;
  label: string;
  escalateBy: number | null;
}

export interface TranscriptLine {
  speaker: "rep" | "prospect";
  text: string;
  tsStart: number;
  tsEnd: number;
}

export interface SuggestionRecord {
  ts: number;
  slotId: string;
  question: string;
  reason: string;
  latencyMs: number;
}

export interface SessionRecord {
  id: string;
  startedAt: string;
  endedAt: string;
  mode: "demo" | "live";
  fixture?: string;
  persona?: string;
  framework?: string;
  durationMs: number;
  slotDefs: SlotDefWire[];
  slots: SlotStates;
  transcript: TranscriptLine[];
  suggestions: SuggestionRecord[];
  notes?: string;
  talk: { repMs: number; prospectMs: number };
  coaching?: {
    questionsAsked: number;
    repWpm: number;
    longestMonologueMs: number;
    talkRatioRepPct: number;
  };
  objections?: Array<{ ts: number; type: string; label: string; doc?: string }>;
  perf?: {
    avgClassifierMs: number;
    avgNudgeMs: number;
    speculativeHits: number;
    echoesSuppressed: number;
  };
}

/** Lightweight header for the history list. */
export interface SessionSummary {
  id: string;
  startedAt: string;
  mode: "demo" | "live";
  durationMs: number;
  covered: number;
  total: number;
  suggestions: number;
}

/** Aggregate stats across all saved sessions, for the dashboard. */
export interface Analytics {
  totalCalls: number;
  liveCalls: number;
  avgCoveragePct: number;
  totalSuggestions: number;
  totalTalkMs: { repMs: number; prospectMs: number };
  /** per-slot: how often it ended covered */
  slotCoverage: Array<{ id: string; label: string; coveredPct: number }>;
  /** recent calls oldest→newest for a trend line */
  trend: Array<{ id: string; startedAt: string; coveragePct: number }>;
}
