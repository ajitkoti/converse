/**
 * Qualification framework presets. The engine is fully config-driven (slots +
 * budgets + descriptions), so switching frameworks is just swapping this data.
 * MEDDPICC is the default (defined in config.json); BANT and SPICED are here.
 * Budgets are seconds of call time.
 */

import type { ConfigOverride } from "../engine/config.js";

export interface FrameworkPreset {
  id: string;
  name: string;
  slots: Array<{ id: string; label: string; framework: string; description: string }>;
  budgets: Record<string, { expectPartialBy?: number; escalateBy: number }>;
}

export const FRAMEWORKS: Record<string, FrameworkPreset> = {
  bant: {
    id: "bant",
    name: "BANT",
    slots: [
      { id: "need", label: "Need", framework: "BANT", description: "the concrete problem/need the prospect wants solved." },
      { id: "budget", label: "Budget", framework: "BANT", description: "budget range or the money available for this." },
      { id: "authority", label: "Authority", framework: "BANT", description: "who has authority to approve the purchase." },
      { id: "timeline", label: "Timeline", framework: "BANT", description: "when they need a solution in place / decision timing." },
    ],
    budgets: {
      need: { expectPartialBy: 300, escalateBy: 600 },
      budget: { escalateBy: 1200 },
      authority: { escalateBy: 1500 },
      timeline: { escalateBy: 1500 },
    },
  },
  spiced: {
    id: "spiced",
    name: "SPICED",
    slots: [
      { id: "situation", label: "Situation", framework: "SPICED", description: "the prospect's current situation / how things work today." },
      { id: "pain", label: "Pain", framework: "SPICED", description: "the pain and its consequences." },
      { id: "impact", label: "Impact", framework: "SPICED", description: "the quantified impact of solving (or not solving) the pain." },
      { id: "criticalEvent", label: "Critical Event", framework: "SPICED", description: "a deadline or event forcing a decision by a date." },
      { id: "decision", label: "Decision", framework: "SPICED", description: "who decides and the process/criteria to decide." },
    ],
    budgets: {
      situation: { expectPartialBy: 240, escalateBy: 480 },
      pain: { expectPartialBy: 480, escalateBy: 900 },
      impact: { escalateBy: 1200 },
      criticalEvent: { escalateBy: 1500 },
      decision: { escalateBy: 1800 },
    },
  },
};

/** Build a ConfigOverride that swaps the engine to the named framework. */
export function frameworkOverride(id?: string): ConfigOverride | undefined {
  if (!id || id === "meddpicc") return undefined; // default lives in config.json
  const preset = FRAMEWORKS[id];
  if (!preset) return undefined;
  return { slots: preset.slots, budgets: preset.budgets };
}

export function frameworkList(): Array<{ id: string; name: string }> {
  return [{ id: "meddpicc", name: "MEDDPICC" }, ...Object.values(FRAMEWORKS).map((f) => ({ id: f.id, name: f.name }))];
}
