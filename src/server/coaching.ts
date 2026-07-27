/**
 * Live coaching signals — deterministic, no LLM. Watches the transcript for
 * rep-behaviour patterns (long monologues, lopsided talk ratio, too few
 * questions, fast pace) and emits nudges. Separate from qualification: this
 * coaches HOW the rep runs the call, not WHAT got covered.
 */

import type { TranscriptEvent } from "../engine/types.js";

export type CoachingKind = "monologue" | "talk-skew" | "low-questions";

export interface CoachingSignal {
  kind: CoachingKind;
  ts: number;
  message: string;
}

export interface CoachingMetrics {
  questionsAsked: number;
  repWpm: number;
  longestMonologueMs: number;
  talkRatioRepPct: number;
}

const MONOLOGUE_MS = 75_000;
const SKEW_AFTER_MS = 180_000;
const SKEW_PCT = 0.7;
const LOW_Q_AFTER_MS = 300_000;
const COOLDOWN_MS = 60_000;

const QUESTION_LEAD = /^(what|how|who|when|where|why|which|can|could|would|do|does|did|is|are|tell me|walk me)\b/i;

export class Coach {
  #repWords = 0;
  #repMs = 0;
  #prospectMs = 0;
  #questions = 0;
  #latestTs = 0;

  #streakSpeaker: "rep" | "prospect" | null = null;
  #streakStart = 0;
  #longestMonologueMs = 0;

  #lastAlert: Record<CoachingKind, number> = { monologue: -Infinity, "talk-skew": -Infinity, "low-questions": -Infinity };
  readonly signals: CoachingSignal[] = [];

  /** Feed a final content event. Returns a signal if one just fired. */
  ingest(e: TranscriptEvent): CoachingSignal | null {
    if (!e.isFinal || e.utteranceEnd || !e.text) return null;
    this.#latestTs = Math.max(this.#latestTs, e.tsEnd);
    const dur = Math.max(0, e.tsEnd - e.tsStart);

    if (e.speaker === "rep") {
      this.#repMs += dur;
      this.#repWords += wordCount(e.text);
      if (e.text.includes("?") || QUESTION_LEAD.test(e.text.trim())) this.#questions++;
      if (this.#streakSpeaker !== "rep") {
        this.#streakSpeaker = "rep";
        this.#streakStart = e.tsStart;
      }
      const streak = e.tsEnd - this.#streakStart;
      if (streak > this.#longestMonologueMs) this.#longestMonologueMs = streak;
      if (streak >= MONOLOGUE_MS) {
        const sig = this.#maybe("monologue", e.tsEnd, `You've been talking ${Math.round(streak / 1000)}s — pause and ask a question.`);
        if (sig) return sig;
      }
    } else {
      this.#prospectMs += dur;
      this.#streakSpeaker = "prospect";
      this.#streakStart = e.tsStart;
    }

    const total = this.#repMs + this.#prospectMs;
    if (total >= SKEW_AFTER_MS && this.#repMs / total >= SKEW_PCT) {
      const sig = this.#maybe("talk-skew", e.tsEnd, `You're talking ${Math.round((this.#repMs / total) * 100)}% of the time — let them talk more.`);
      if (sig) return sig;
    }
    if (this.#latestTs >= LOW_Q_AFTER_MS && this.#questions <= 1) {
      const sig = this.#maybe("low-questions", e.tsEnd, `Only ${this.#questions} question so far — get them talking with an open question.`);
      if (sig) return sig;
    }
    return null;
  }

  #maybe(kind: CoachingKind, ts: number, message: string): CoachingSignal | null {
    if (ts - this.#lastAlert[kind] < COOLDOWN_MS) return null;
    this.#lastAlert[kind] = ts;
    const sig = { kind, ts, message };
    this.signals.push(sig);
    return sig;
  }

  metrics(): CoachingMetrics {
    const total = this.#repMs + this.#prospectMs;
    const minutes = this.#repMs / 60_000;
    return {
      questionsAsked: this.#questions,
      repWpm: minutes > 0 ? Math.round(this.#repWords / minutes) : 0,
      longestMonologueMs: this.#longestMonologueMs,
      talkRatioRepPct: total > 0 ? Math.round((this.#repMs / total) * 100) : 0,
    };
  }
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}
