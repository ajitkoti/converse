/**
 * LLM abstraction. The engine depends ONLY on this small interface — it never
 * imports an SDK directly. This keeps the engine portable and, crucially, makes
 * replay tests deterministic: tests inject a scripted LlmClient instead of
 * hitting the network.
 *
 * raven adapter: raven's own AIProvider (src/main/services/ai/) already exposes
 * `generateShort(system, prompt): Promise<string>`, so the raven binding is a
 * one-liner:
 *
 *   const llm: LlmClient = { complete: (r) => provider.generateShort(r.system, r.user) };
 *
 * A standalone Anthropic implementation lives in anthropic-client.ts (lazy SDK
 * import) for server-side / test-harness use.
 */

export interface LlmRequest {
  system: string;
  user: string;
  model: string;
  maxTokens: number;
  /**
   * Optional assistant-turn prefill to force the shape of the reply (e.g. "{"
   * to force JSON). Adapters that can't prefill may ignore it.
   */
  prefill?: string;
  /**
   * Hint that the (large, static) system prompt should be cached by the provider
   * to cut latency + cost. Anthropic uses cache_control; OpenAI caches
   * automatically, so its adapter can ignore this.
   */
  cacheSystem?: boolean;
}

export interface LlmClient {
  complete(req: LlmRequest): Promise<string>;
}

/**
 * Extract the first balanced JSON object from a model reply. Models sometimes
 * wrap JSON in prose or code fences even when told not to; this is defensive.
 *
 * `prefill` handles assistant-turn prefills: with the Anthropic SDK the reply is
 * only the CONTINUATION (prefill stripped), so `raw` alone is not valid JSON;
 * with providers that ignore prefill (e.g. raven's generateShort) `raw` already
 * contains the whole object. We try `raw` first, then `prefill + raw`, so both
 * cases parse. Returns null if neither yields a parseable object.
 */
export function extractJson<T = unknown>(raw: string, prefill = ""): T | null {
  const direct = scanJson<T>(raw);
  if (direct !== null) return direct;
  if (prefill) return scanJson<T>(prefill + raw);
  return null;
}

function scanJson<T>(input: string): T | null {
  const text = input.trim();
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          return JSON.parse(candidate) as T;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
