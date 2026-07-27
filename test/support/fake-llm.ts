import type { LlmClient, LlmRequest } from "../../src/engine/llm.js";
import { keywordClassify, deriveQuestion } from "../../src/server/offline-llm.js";

export { keywordClassify };

/**
 * A controllable monotonic clock for latency-drop tests. The engine measures
 * LLM latency as monotonicNow()after - before; advancing this clock inside the
 * fake's question handler simulates a slow generation.
 */
export class FakeClock {
  #t = 0;
  now = (): number => this.#t;
  advance(ms: number): void {
    this.#t += ms;
  }
}

export interface FakeLlmOptions {
  /** ms to advance `clock` during each question-gen call (simulated latency). */
  questionLatencyMs?: number;
  clock?: FakeClock;
  /** override the generated question text (default derives from window). */
  questionText?: (windowText: string) => string;
}

/** Offline stand-in for the LLM. Records every request for assertions. */
export class FakeLlmClient implements LlmClient {
  readonly calls: LlmRequest[] = [];
  #opts: FakeLlmOptions;
  constructor(opts: FakeLlmOptions = {}) {
    this.#opts = opts;
  }

  get classifierCalls(): LlmRequest[] {
    return this.calls.filter((c) => c.prefill?.startsWith('{"updates"'));
  }
  get questionCalls(): LlmRequest[] {
    return this.calls.filter((c) => c.prefill?.startsWith('{"question"'));
  }

  async complete(req: LlmRequest): Promise<string> {
    this.calls.push(req);
    if (req.prefill?.startsWith('{"question"')) {
      if (this.#opts.questionLatencyMs && this.#opts.clock) {
        this.#opts.clock.advance(this.#opts.questionLatencyMs);
      }
      const q = this.#opts.questionText
        ? this.#opts.questionText(req.user)
        : deriveQuestion(req.user);
      return JSON.stringify({ question: q });
    }
    return JSON.stringify({ updates: keywordClassify(req.user) });
  }
}
