/**
 * Rough usage-cost ESTIMATES from token/minute counts. These are public list
 * prices (USD) and drift over time / vary by plan — the UI always labels the
 * result as an estimate. Token counts are themselves estimated (~4 chars/token),
 * so treat totals as ballpark, not billing.
 */

/** Approx tokens in a string (~4 chars/token). Cheap, provider-agnostic. */
export function estimateTokens(text: string): number {
  return Math.ceil((text?.length ?? 0) / 4);
}

/** Deepgram Nova streaming, pay-as-you-go, per minute of audio. */
const DEEPGRAM_PER_MINUTE = 0.0043;

/** Per-1M-token [input, output] list prices, matched by substring of the model id. */
const LLM_RATES: Array<{ match: RegExp; in: number; out: number }> = [
  { match: /gpt-4o-mini/i, in: 0.15, out: 0.6 },
  { match: /gpt-4o/i, in: 2.5, out: 10 },
  { match: /gpt-4\.1-mini/i, in: 0.4, out: 1.6 },
  { match: /gpt-4\.1/i, in: 2, out: 8 },
  { match: /haiku/i, in: 1, out: 5 },
  { match: /sonnet/i, in: 3, out: 15 },
  { match: /opus/i, in: 15, out: 75 },
];

export interface UsageCounts {
  deepgramSeconds: number;
  llmInputTokens: number;
  llmOutputTokens: number;
  /** the model these tokens ran against (for the right rate) */
  model?: string;
}

export interface CostEstimate {
  deepgramUsd: number;
  llmUsd: number;
  totalUsd: number;
  /** true when the model didn't match a known rate (LLM cost omitted) */
  llmModelUnknown: boolean;
}

export function estimateCostUsd(u: UsageCounts): CostEstimate {
  const deepgramUsd = (u.deepgramSeconds / 60) * DEEPGRAM_PER_MINUTE;
  const rate = LLM_RATES.find((r) => u.model && r.match.test(u.model));
  const llmUsd = rate
    ? (u.llmInputTokens / 1e6) * rate.in + (u.llmOutputTokens / 1e6) * rate.out
    : 0;
  return {
    deepgramUsd: round(deepgramUsd),
    llmUsd: round(llmUsd),
    totalUsd: round(deepgramUsd + llmUsd),
    llmModelUnknown: !rate && u.llmInputTokens > 0,
  };
}

function round(n: number): number {
  return Math.round(n * 1e4) / 1e4; // 4 dp — cents-and-below matter here
}
