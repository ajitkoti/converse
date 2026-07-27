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
  durationMs: number;
  slotDefs: SlotDefWire[];
  slots: SlotStates;
  transcript: TranscriptLine[];
  suggestions: SuggestionRecord[];
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
