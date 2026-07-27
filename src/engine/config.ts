/**
 * Config loader. All tunables live in config.json (the single source of truth).
 * This module validates the shape and exposes it as a typed, immutable object.
 * Callers may pass a partial override object (used by tests to shrink cadence /
 * cooldowns so replays exercise timing logic quickly).
 */

import rawConfig from "./config.json" with { type: "json" };
import type { SlotId } from "./types.js";

export interface SlotDef {
  id: SlotId;
  label: string;
  framework: string;
}

export interface SlotBudget {
  /** seconds of call time by which the slot should be at least "partial" */
  expectPartialBy?: number;
  /** seconds of call time after which an uncovered slot is overdue */
  escalateBy: number;
}

export interface EngineConfig {
  models: { classifier: string; questionGen: string };
  deepgram: { utterance_end_ms: number; interim_results: boolean };
  classifier: {
    everySeconds: number;
    everyFinalUtterances: number;
    windowSeconds: number;
    maxOutputTokens: number;
  };
  suggestion: {
    windowSeconds: number;
    cooldownSeconds: number;
    latencyBudgetMs: number;
    dropIfExceedsMs: number;
    maxWords: number;
    maxOutputTokens: number;
    snoozeSeconds: number;
  };
  slots: SlotDef[];
  budgets: Record<SlotId, SlotBudget>;
}

/** Deep-merge helper limited to plain objects (no arrays merge — arrays replace). */
function merge<T>(base: T, override: unknown): T {
  if (override === undefined || override === null) return base;
  if (
    typeof base !== "object" ||
    base === null ||
    Array.isArray(base) ||
    typeof override !== "object" ||
    Array.isArray(override)
  ) {
    return override as T;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    out[k] = merge((base as Record<string, unknown>)[k], v);
  }
  return out as T;
}

export type ConfigOverride = {
  [K in keyof EngineConfig]?: Partial<EngineConfig[K]>;
};

function stripComments(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(stripComments);
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "$comment") continue;
      out[k] = stripComments(v);
    }
    return out;
  }
  return obj;
}

function validate(cfg: EngineConfig): void {
  const slotIds = new Set(cfg.slots.map((s) => s.id));
  if (slotIds.size !== cfg.slots.length) {
    throw new Error("config: duplicate slot ids");
  }
  for (const id of Object.keys(cfg.budgets)) {
    if (!slotIds.has(id as SlotId)) {
      throw new Error(`config: budget references unknown slot "${id}"`);
    }
  }
  if (cfg.suggestion.dropIfExceedsMs < cfg.suggestion.latencyBudgetMs) {
    throw new Error("config: dropIfExceedsMs must be >= latencyBudgetMs");
  }
}

export function loadConfig(override?: ConfigOverride): EngineConfig {
  const base = stripComments(rawConfig) as EngineConfig;
  const cfg = override ? merge(base, override) : base;
  validate(cfg);
  return cfg;
}

/** The default, unmodified config (production defaults). */
export const defaultConfig: EngineConfig = loadConfig();
