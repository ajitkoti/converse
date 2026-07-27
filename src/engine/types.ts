/**
 * Shared types for the qualification engine.
 *
 * PORTABILITY CONTRACT: this module (and everything under src/engine) must have
 * ZERO Electron imports and ZERO UI knowledge. It consumes a TranscriptEvent
 * stream and emits a GuidanceEvent stream. Nothing else. See ARCHITECTURE.md.
 */

export type Speaker = "rep" | "prospect";

/**
 * Normalized transcript event — the single currency between raven's audio
 * pipeline and this engine. Produced by TranscriptBus from raw Deepgram
 * messages on either the mic (rep) or system-audio (prospect) connection.
 */
export interface TranscriptEvent {
  speaker: Speaker;
  text: string;
  /** ms since call start */
  tsStart: number;
  tsEnd: number;
  /** Deepgram is_final: this hypothesis will not change. */
  isFinal: boolean;
  /**
   * True only for a synthesized marker derived from Deepgram's UtteranceEnd
   * event. Marker events carry empty text; they signal "this speaker paused".
   */
  utteranceEnd: boolean;
}

/** The default MEDDPICC slot ids. */
export type MeddpiccSlotId =
  | "metrics"
  | "economicBuyer"
  | "decisionCriteria"
  | "decisionProcess"
  | "paperProcess"
  | "identifyPain"
  | "champion"
  | "competition";

/**
 * A slot id. The MEDDPICC ids get autocomplete; `(string & {})` keeps the type
 * open so other frameworks (BANT, SPICED, custom) can define their own ids.
 */
export type SlotId = MeddpiccSlotId | (string & {});

export type SlotStatus = "empty" | "partial" | "covered";

export interface SlotState {
  status: SlotStatus;
  /** 0-1 */
  confidence: number;
  /** verbatim prospect quotes supporting the status */
  evidence: string[];
  /** ms since call start of last change; 0 if never touched */
  lastUpdatedTs: number;
}

export type SlotStates = Record<string, SlotState>;

/**
 * Output stream. The Electron/overlay layer subscribes to these and renders
 * them. It must never need to reach back into engine internals.
 */
export type GuidanceEvent =
  | { type: "slots"; ts: number; slots: SlotStates }
  | {
      type: "suggestion";
      ts: number;
      slotId: SlotId;
      question: string;
      /** why this slot, now (for logs / tooltips) */
      reason: string;
      /** ms the LLM generation took */
      latencyMs: number;
    }
  | {
      type: "suggestion-dropped";
      ts: number;
      slotId: SlotId;
      reason: "latency-exceeded" | "empty-generation" | "generation-error";
      latencyMs: number;
    };
