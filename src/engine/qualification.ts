/**
 * Phase 2 + 3 — Qualification engine.
 *
 * Consumes a TranscriptEvent stream, maintains MEDDPICC slot state via a
 * periodic LLM classifier, and (Phase 3) surfaces at-most-one bridging question
 * at natural pauses when a slot is overdue. Emits a GuidanceEvent stream.
 *
 * ZERO Electron / UI imports. Deterministic given the same events + LlmClient:
 * "now" is derived from transcript timestamps, never the wall clock. The only
 * wall-clock use is measuring real LLM latency for the drop rule (Phase 3),
 * injectable via `monotonicNow` for tests.
 */

import { EventEmitter } from "node:events";
import { defaultConfig, type EngineConfig, type SlotDef } from "./config.js";
import { extractJson, type LlmClient } from "./llm.js";
import { nullLogger, type JsonlLogger } from "./logger.js";
import {
  buildClassifierPrompt,
  type ClassifierOutput,
  type ClassifierUpdate,
} from "./prompts/classifier.js";
import { buildQuestionPrompt, type QuestionOutput } from "./prompts/question-gen.js";
import type { GuidanceEvent, SlotId, SlotState, SlotStates, TranscriptEvent } from "./types.js";

const RANK: Record<SlotState["status"], number> = { empty: 0, partial: 1, covered: 2 };
const MAX_EVIDENCE = 5;

/** Optional prompt customization (custom system prompts, product context, persona). */
export interface PromptCustomization {
  classifierSystem?: string;
  questionSystem?: string;
  /** product/battlecard context injected into question generation */
  contextBlock?: string;
  /** persona hint, e.g. "CFO — cares about ROI and risk" */
  persona?: string;
}

export interface EngineDeps {
  llm: LlmClient;
  config?: EngineConfig;
  logger?: JsonlLogger;
  /** monotonic clock in ms for latency measurement; defaults to Date.now. */
  monotonicNow?: () => number;
  /** custom prompts / injected context / persona */
  prompts?: PromptCustomization;
}

export interface QualificationEngineEvents {
  guidance: (e: GuidanceEvent) => void;
}

export declare interface QualificationEngine {
  on<E extends keyof QualificationEngineEvents>(
    event: E,
    listener: QualificationEngineEvents[E],
  ): this;
  off<E extends keyof QualificationEngineEvents>(
    event: E,
    listener: QualificationEngineEvents[E],
  ): this;
  emit<E extends keyof QualificationEngineEvents>(
    event: E,
    ...args: Parameters<QualificationEngineEvents[E]>
  ): boolean;
}

export class QualificationEngine extends EventEmitter {
  readonly #cfg: EngineConfig;
  readonly #llm: LlmClient;
  readonly #log: JsonlLogger;
  readonly #monotonic: () => number;
  readonly #slots: SlotDef[];
  readonly #prompts: PromptCustomization;

  #states: SlotStates;
  #buffer: TranscriptEvent[] = []; // final content events (non-marker)
  #latestTs = 0;
  #lastFinalSpeaker: "rep" | "prospect" | null = null;

  // classifier cadence
  #finalsSinceClassify = 0;
  #lastClassifyAtMs = 0;
  #classifyInFlight = false;

  // suggestion state
  #lastSuggestionAtMs = Number.NEGATIVE_INFINITY;
  #suggestionInFlight = false;
  #snoozedUntilMs: Partial<Record<SlotId, number>> = {};

  // speculative pre-generation (instant nudges)
  #specCache: { slotId: SlotId; question: string; stale: boolean } | null = null;
  #specInFlight = false;
  #lastPrewarmAtMs = Number.NEGATIVE_INFINITY;

  #pending = new Set<Promise<void>>();

  constructor(deps: EngineDeps) {
    super();
    this.#cfg = deps.config ?? defaultConfig;
    this.#llm = deps.llm;
    this.#log = deps.logger ?? nullLogger;
    this.#monotonic = deps.monotonicNow ?? (() => Date.now());
    this.#slots = this.#cfg.slots;
    this.#prompts = deps.prompts ?? {};
    this.#states = initStates(this.#slots.map((s) => s.id));
  }

  /** Ingest one normalized transcript event. Non-blocking; LLM work is async. */
  ingest(event: TranscriptEvent): void {
    if (event.tsEnd > this.#latestTs) this.#latestTs = event.tsEnd;

    if (event.utteranceEnd) {
      if (event.speaker === "prospect") {
        // Adaptive cadence: score right after the prospect finishes a thought,
        // so coverage updates in near-real-time instead of waiting for the tick.
        this.#maybeClassifyAdaptive();
        this.#maybeSuggest();
      } else if (this.#cfg.suggestion.proactive) {
        // Proactive mode: also offer a hint on the rep's pauses.
        this.#maybeSuggest();
      }
      return;
    }

    if (!event.text || !event.isFinal) return; // interims don't drive state

    this.#buffer.push(event);
    this.#lastFinalSpeaker = event.speaker;
    this.#finalsSinceClassify++;
    // Prospect speech changed the context → any pre-generated question is stale.
    if (event.speaker === "prospect" && this.#specCache) this.#specCache.stale = true;
    this.#maybeClassify();
    this.#maybePrewarm();
  }

  /** Current slot states (deep copy — callers must not mutate engine state). */
  getSlots(): SlotStates {
    return structuredClone(this.#states);
  }

  get callTimeMs(): number {
    return this.#latestTs;
  }

  /** UI hotkey: mute suggestions for one slot for `snoozeSeconds`. */
  snoozeSlot(slot: SlotId): void {
    this.#snoozedUntilMs[slot] = this.#latestTs + this.#cfg.suggestion.snoozeSeconds * 1000;
    this.#log.log({ event: "snooze", ts: this.#latestTs, slot });
  }

  /**
   * Force a classifier pass now, regardless of cadence. Call this on call end so
   * the final utterances are scored (the periodic cadence may not have fired for
   * the tail of the call). Non-blocking; await idle() after.
   */
  flush(): void {
    if (this.#classifyInFlight) return;
    if (this.#buffer.length === 0) return;
    this.#track(this.#runClassify());
  }

  /** Await all in-flight LLM work. Used by replay/tests for determinism. */
  async idle(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.all([...this.#pending]);
    }
  }

  // ---- classifier loop (Phase 2) --------------------------------------------

  #maybeClassify(): void {
    if (this.#classifyInFlight) return;
    const dueByTime = this.#latestTs - this.#lastClassifyAtMs >= this.#cfg.classifier.everySeconds * 1000;
    const dueByCount = this.#finalsSinceClassify >= this.#cfg.classifier.everyFinalUtterances;
    if (!dueByTime && !dueByCount) return;
    this.#track(this.#runClassify());
  }

  /** Re-classify right after a prospect pause, throttled so we don't spam. */
  #maybeClassifyAdaptive(): void {
    if (this.#classifyInFlight || this.#finalsSinceClassify === 0) return;
    if (this.#latestTs - this.#lastClassifyAtMs < this.#cfg.classifier.adaptiveMinGapSeconds * 1000) return;
    this.#track(this.#runClassify());
  }

  /** Transcript window for the classifier: incremental (only new lines + a small overlap). */
  #classifierWindow(): TranscriptEvent[] {
    const c = this.#cfg.classifier;
    if (!c.incremental) return this.#recentWindow(c.windowSeconds);
    const sinceMs = Math.max(this.#lastClassifyAtMs - c.incrementalOverlapSeconds * 1000, this.#latestTs - c.windowSeconds * 1000);
    return this.#buffer.filter((e) => e.tsEnd >= sinceMs);
  }

  async #runClassify(): Promise<void> {
    this.#classifyInFlight = true;
    const atMs = this.#latestTs;
    this.#lastClassifyAtMs = atMs;
    this.#finalsSinceClassify = 0;

    const windowEvents = this.#classifierWindow();
    const windowText = renderWindow(windowEvents);
    const { system, user, prefill } = buildClassifierPrompt(
      this.#slots,
      this.#states,
      windowText,
      this.#prompts.classifierSystem,
    );

    const started = this.#monotonic();
    let raw = "";
    try {
      raw = await this.#llm.complete({
        system,
        user,
        model: this.#cfg.models.classifier,
        maxTokens: this.#cfg.classifier.maxOutputTokens,
        prefill,
        cacheSystem: this.#cfg.classifier.cacheSystemPrompt,
      });
    } catch (err) {
      this.#log.log({ event: "classify-error", ts: atMs, error: String(err) });
      this.#classifyInFlight = false;
      return;
    }
    const classifierMs = this.#monotonic() - started;
    this.emit("guidance", { type: "metrics", ts: atMs, kind: "classify", ms: classifierMs });

    const parsed = extractJson<ClassifierOutput>(raw, prefill);
    const updates = Array.isArray(parsed?.updates) ? parsed!.updates : [];
    const decisions = this.#merge(updates, windowEvents, atMs);

    this.#log.log({
      event: "classify",
      ts: atMs,
      classifierMs,
      windowLines: windowEvents.length,
      raw,
      updates,
      decisions,
    });

    if (decisions.some((d) => d.applied)) {
      this.emit("guidance", { type: "slots", ts: atMs, slots: this.getSlots() });
    }
    this.#classifyInFlight = false;
  }

  #merge(
    updates: ClassifierUpdate[],
    windowEvents: TranscriptEvent[],
    atMs: number,
  ): Array<{ slot: string; applied: boolean; reason: string }> {
    const prospectText = normalize(
      windowEvents
        .filter((e) => e.speaker === "prospect")
        .map((e) => e.text)
        .join(" "),
    );
    const decisions: Array<{ slot: string; applied: boolean; reason: string }> = [];

    for (const u of updates) {
      const cur = this.#states[u.slot as SlotId];
      if (!cur) {
        decisions.push({ slot: String(u.slot), applied: false, reason: "unknown-slot" });
        continue;
      }
      // Rule 1 + 2: evidence must be a verbatim PROSPECT quote.
      const quote = (u.quote ?? "").trim();
      if (!quote || !prospectText.includes(normalize(quote))) {
        decisions.push({ slot: u.slot, applied: false, reason: "unverified-quote" });
        continue;
      }
      const candRank = RANK[u.status] ?? 0;
      const curRank = RANK[cur.status];
      // Rule 3: never downgrade.
      if (candRank < curRank) {
        decisions.push({ slot: u.slot, applied: false, reason: "no-downgrade" });
        continue;
      }
      const conf = clamp01(u.confidence);
      if (candRank === curRank) {
        if (conf > cur.confidence) {
          cur.confidence = conf;
          this.#addEvidence(cur, quote);
          cur.lastUpdatedTs = atMs;
          decisions.push({ slot: u.slot, applied: true, reason: "confidence-bump" });
        } else {
          decisions.push({ slot: u.slot, applied: false, reason: "no-op" });
        }
        continue;
      }
      // Upgrade (partial/covered). Quote already verified above.
      cur.status = u.status;
      cur.confidence = conf;
      this.#addEvidence(cur, quote);
      cur.lastUpdatedTs = atMs;
      decisions.push({ slot: u.slot, applied: true, reason: `upgrade->${u.status}` });
    }
    return decisions;
  }

  #addEvidence(state: SlotState, quote: string): void {
    if (!state.evidence.includes(quote)) {
      state.evidence.push(quote);
      if (state.evidence.length > MAX_EVIDENCE) state.evidence.shift();
    }
  }

  // ---- escalation + question generation (Phase 3) ---------------------------

  #maybeSuggest(): void {
    // By default only nudge into a real PROSPECT pause (sparse mode). In proactive
    // mode we also fire on the rep's pauses, so the copilot keeps offering
    // question hints as the call flows even when the prospect channel is quiet.
    if (!this.#cfg.suggestion.proactive && this.#lastFinalSpeaker !== "prospect") return;
    if (this.#suggestionInFlight) return;

    const nowSec = this.#latestTs / 1000;
    // Rule 3: hard cooldown.
    if (nowSec - this.#lastSuggestionAtMs / 1000 < this.#cfg.suggestion.cooldownSeconds) return;

    // Rules 1 + 4: pick the single most-overdue uncovered, un-snoozed slot.
    const target = this.#mostOverdue(nowSec);
    if (!target) return;

    // Commit: consume the cooldown now so a drop can't be retried every pause.
    this.#lastSuggestionAtMs = this.#latestTs;

    // Proactive multi-card: generate a real question for each of the top-N overdue
    // slots at once, so the overlay shows 2-3 cards. Sparse mode keeps the single
    // speculative path below.
    if (this.#cfg.suggestion.proactive && this.#cfg.suggestion.maxCards > 1) {
      const top = this.#rankedOverdue(nowSec).slice(0, this.#cfg.suggestion.maxCards);
      this.#track(this.#runMultiGen(top, this.#latestTs));
      return;
    }

    // Instant path: if we pre-generated a fresh question for this slot during the
    // prospect's turn, show it immediately (zero perceived latency).
    const cached = this.#specCache;
    if (cached && cached.slotId === target.id && !cached.stale && cached.question) {
      this.#specCache = null;
      this.#emitSuggestion(target, cached.question, 0, this.#latestTs, false, true);
      return;
    }
    this.#track(this.#runQuestionGen(target, this.#latestTs));
  }

  /** Pre-generate the overdue slot's question during the prospect's turn. */
  #maybePrewarm(): void {
    if (!this.#cfg.suggestion.speculative) return;
    if (this.#specInFlight || this.#suggestionInFlight) return;
    const nowSec = this.#latestTs / 1000;
    if (nowSec - this.#lastSuggestionAtMs / 1000 < this.#cfg.suggestion.cooldownSeconds) return;
    if (this.#latestTs - this.#lastPrewarmAtMs < this.#cfg.suggestion.prewarmMinGapSeconds * 1000) return;
    const target = this.#mostOverdue(nowSec);
    if (!target) return;
    const c = this.#specCache;
    if (c && c.slotId === target.id && !c.stale) return; // fresh cache already
    this.#lastPrewarmAtMs = this.#latestTs;
    this.#track(this.#prewarm(target));
  }

  async #prewarm(slot: SlotDef): Promise<void> {
    this.#specInFlight = true;
    const { question } = await this.#genQuestion(slot);
    if (question) this.#specCache = { slotId: slot.id, question, stale: false };
    this.#specInFlight = false;
  }

  #mostOverdue(nowSec: number): SlotDef | null {
    return this.#rankedOverdue(nowSec)[0] ?? null;
  }

  /** Overdue, uncovered, un-snoozed slots, most-overdue first. */
  #rankedOverdue(nowSec: number): SlotDef[] {
    const scored: Array<{ slot: SlotDef; overBy: number }> = [];
    for (const slot of this.#slots) {
      const budget = this.#cfg.budgets[slot.id];
      if (!budget) continue;
      const state = this.#states[slot.id];
      if (state?.status === "covered") continue;
      const snoozedUntil = this.#snoozedUntilMs[slot.id];
      if (snoozedUntil !== undefined && this.#latestTs < snoozedUntil) continue;
      const overBy = nowSec - budget.escalateBy;
      if (overBy > 0) scored.push({ slot, overBy });
    }
    return scored.sort((a, b) => b.overBy - a.overBy).map((s) => s.slot);
  }

  /**
   * Generate a bridging question for a chosen slot immediately (UI "Ask now").
   * Single-flight; ignores overdue/cooldown gating on purpose.
   */
  askNow(slotId: SlotId): void {
    if (this.#suggestionInFlight) return;
    const slot = this.#slots.find((s) => s.id === slotId);
    if (!slot) return;
    this.#track(this.#runQuestionGen(slot, this.#latestTs, true));
  }

  /** Pure question generation — no drop rules, no emit. Returns text + latency. */
  async #genQuestion(slot: SlotDef): Promise<{ question: string; latencyMs: number; error?: string }> {
    const windowText = renderWindow(this.#recentWindow(this.#cfg.suggestion.windowSeconds));
    const { system, user, prefill } = buildQuestionPrompt(
      slot,
      windowText,
      this.#cfg.suggestion.maxWords,
      {
        system: this.#prompts.questionSystem,
        contextBlock: this.#prompts.contextBlock,
        persona: this.#prompts.persona,
      },
    );
    const started = this.#monotonic();
    let raw = "";
    try {
      raw = await this.#llm.complete({
        system,
        user,
        model: this.#cfg.models.questionGen,
        maxTokens: this.#cfg.suggestion.maxOutputTokens,
        prefill,
      });
    } catch (err) {
      return { question: "", latencyMs: this.#monotonic() - started, error: String(err) };
    }
    const latencyMs = this.#monotonic() - started;
    const parsed = extractJson<QuestionOutput>(raw, prefill);
    let question = (parsed?.question ?? "").trim();
    if (!question) question = fallbackQuestion(raw);
    question = clampWords(question, this.#cfg.suggestion.maxWords);
    return { question, latencyMs };
  }

  async #runQuestionGen(slot: SlotDef, firedAtMs: number, manual = false): Promise<void> {
    this.#suggestionInFlight = true;
    const { question, latencyMs, error } = await this.#genQuestion(slot);

    // Phase 3 latency rule: a late suggestion is worse than none.
    if (error) {
      this.#log.log({ event: "suggest-error", ts: firedAtMs, slot: slot.id, error });
      this.#emitDropped(slot.id, "generation-error", latencyMs, firedAtMs);
    } else if (latencyMs > this.#cfg.suggestion.dropIfExceedsMs) {
      this.#log.log({ event: "suggest-drop", ts: firedAtMs, slot: slot.id, latencyMs, reason: "latency-exceeded" });
      this.#emitDropped(slot.id, "latency-exceeded", latencyMs, firedAtMs);
    } else if (!question) {
      this.#emitDropped(slot.id, "empty-generation", latencyMs, firedAtMs);
    } else {
      this.#emitSuggestion(slot, question, latencyMs, firedAtMs, manual, false);
    }
    this.#suggestionInFlight = false;
  }

  /** Proactive: generate a question for each of the top-N overdue slots in one
   *  parallel batch and emit them as a primary + ranked "cover next" cards. */
  async #runMultiGen(slots: SlotDef[], firedAtMs: number): Promise<void> {
    this.#suggestionInFlight = true;
    const results = (
      await Promise.all(slots.map((s) => this.#genQuestion(s).then((r) => ({ slot: s, ...r }))))
    ).filter((r) => !r.error && r.question);
    const latencyMs = results.length ? Math.max(...results.map((r) => r.latencyMs)) : 0;
    if (!results.length) {
      this.#emitDropped(slots[0]?.id ?? ("" as SlotId), "empty-generation", latencyMs, firedAtMs);
    } else if (latencyMs > this.#cfg.suggestion.dropIfExceedsMs) {
      this.#emitDropped(results[0]!.slot.id, "latency-exceeded", latencyMs, firedAtMs);
    } else {
      const [primary, ...alts] = results;
      this.#log.log({ event: "suggest", ts: firedAtMs, slot: primary!.slot.id, question: primary!.question, latencyMs, speculative: false });
      this.emit("guidance", {
        type: "suggestion",
        ts: firedAtMs,
        slotId: primary!.slot.id,
        question: primary!.question,
        reason: `${primary!.slot.label} overdue — proactive`,
        latencyMs,
        ...(alts.length ? { alternatives: alts.map((a) => ({ slotId: a.slot.id, label: a.slot.label, question: a.question })) } : {}),
      });
      this.emit("guidance", { type: "metrics", ts: firedAtMs, kind: "suggestion", ms: latencyMs, speculative: false });
    }
    this.#suggestionInFlight = false;
  }

  #emitSuggestion(
    slot: SlotDef,
    question: string,
    latencyMs: number,
    ts: number,
    manual: boolean,
    speculative: boolean,
  ): void {
    const reason = manual
      ? `manual — asked for ${slot.label}`
      : `${slot.label} overdue (>${this.#cfg.budgets[slot.id]?.escalateBy}s), prospect paused`;
    // The next most-overdue slots after the primary, ranked — shown as secondary
    // "cover next" cards. Deterministic (no extra LLM call); the overlay can turn
    // one into a full question on demand via "ask".
    const alternatives = manual
      ? []
      : this.#rankedOverdue(ts / 1000)
          .filter((s) => s.id !== slot.id)
          .slice(0, this.#cfg.suggestion.maxCards - 1)
          .map((s) => ({ slotId: s.id, label: s.label }));
    this.#log.log({ event: "suggest", ts, slot: slot.id, question, latencyMs, speculative });
    this.emit("guidance", {
      type: "suggestion",
      ts,
      slotId: slot.id,
      question,
      reason,
      latencyMs,
      ...(alternatives.length ? { alternatives } : {}),
    });
    this.emit("guidance", { type: "metrics", ts, kind: "suggestion", ms: latencyMs, speculative });
  }

  #emitDropped(
    slotId: SlotId,
    reason: "latency-exceeded" | "empty-generation" | "generation-error",
    latencyMs: number,
    ts: number,
  ): void {
    this.emit("guidance", { type: "suggestion-dropped", ts, slotId, reason, latencyMs });
  }

  // ---- helpers --------------------------------------------------------------

  #recentWindow(seconds: number): TranscriptEvent[] {
    const cutoff = this.#latestTs - seconds * 1000;
    return this.#buffer.filter((e) => e.tsEnd >= cutoff);
  }

  #track(p: Promise<void>): void {
    this.#pending.add(p);
    void p.finally(() => this.#pending.delete(p));
  }
}

function initStates(ids: SlotId[]): SlotStates {
  const out = {} as SlotStates;
  for (const id of ids) {
    out[id] = { status: "empty", confidence: 0, evidence: [], lastUpdatedTs: 0 };
  }
  return out;
}

function renderWindow(events: TranscriptEvent[]): string {
  return events
    .filter((e) => e.text)
    .map((e) => `${e.speaker === "rep" ? "REP" : "PROSPECT"}: ${e.text}`)
    .join("\n");
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function clampWords(s: string, maxWords: number): string {
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return s.trim();
  return words.slice(0, maxWords).join(" ");
}

/** If the model ignored JSON, salvage the first sentence-ish line. */
function fallbackQuestion(raw: string): string {
  const line = raw.replace(/^[\s"{]*question["\s:]*/i, "").split("\n")[0] ?? "";
  return line.replace(/["}]+$/g, "").trim();
}
