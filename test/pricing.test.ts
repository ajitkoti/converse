import { describe, it, expect } from "vitest";
import { estimateTokens, estimateCostUsd } from "../src/server/pricing.js";

describe("pricing estimates", () => {
  it("estimates tokens ~4 chars each", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("prices Deepgram minutes + LLM tokens for a known model", () => {
    const c = estimateCostUsd({
      deepgramSeconds: 600, // 10 min
      llmInputTokens: 1_000_000,
      llmOutputTokens: 1_000_000,
      model: "gpt-4o",
    });
    expect(c.deepgramUsd).toBeCloseTo((10 * 0.0043), 4); // $0.043
    expect(c.llmUsd).toBeCloseTo(2.5 + 10, 4); // $12.50 in + out
    expect(c.totalUsd).toBeCloseTo(0.043 + 12.5, 3);
    expect(c.llmModelUnknown).toBe(false);
  });

  it("omits LLM cost (flags unknown) when the model has no known rate", () => {
    const c = estimateCostUsd({ deepgramSeconds: 60, llmInputTokens: 500, llmOutputTokens: 500, model: "mystery-model" });
    expect(c.llmUsd).toBe(0);
    expect(c.llmModelUnknown).toBe(true);
    expect(c.deepgramUsd).toBeGreaterThan(0);
  });

  it("is zero for an offline/demo call (no audio, no tokens)", () => {
    const c = estimateCostUsd({ deepgramSeconds: 0, llmInputTokens: 0, llmOutputTokens: 0 });
    expect(c.totalUsd).toBe(0);
    expect(c.llmModelUnknown).toBe(false);
  });
});
