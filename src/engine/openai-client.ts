/**
 * OpenAI LlmClient — an alternative to AnthropicLlmClient. Uses the Chat
 * Completions REST API directly (no SDK, so the engine stays dependency-light).
 * Selected when the user picks OpenAI as their provider in Settings.
 *
 * If the configured model looks like a Claude id (the shared default), we fall
 * back to this client's own default OpenAI model, so switching provider works
 * without also editing the model names.
 */

import type { LlmClient, LlmRequest } from "./llm.js";

export interface OpenAiClientOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** injectable for tests */
  fetchImpl?: typeof fetch;
}

const OPENAI_MODEL_RE = /^(gpt-|o1|o3|o4|chatgpt)/i;

export class OpenAiLlmClient implements LlmClient {
  #key: string;
  #model: string;
  #base: string;
  #fetch: typeof fetch;

  constructor(opts: OpenAiClientOptions = {}) {
    this.#key = opts.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    this.#model = opts.model ?? "gpt-4o-mini";
    this.#base = opts.baseUrl ?? "https://api.openai.com/v1";
    this.#fetch = opts.fetchImpl ?? fetch;
  }

  async complete(req: LlmRequest): Promise<string> {
    const model = OPENAI_MODEL_RE.test(req.model) ? req.model : this.#model;
    const wantsJson = !!req.prefill && req.prefill.trim().startsWith("{");
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      max_tokens: req.maxTokens,
    };
    // response_format json_object requires the prompt to mention JSON — ours do.
    if (wantsJson) body.response_format = { type: "json_object" };

    const res = await this.#fetch(`${this.#base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.#key}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`OpenAI ${res.status}: ${detail.slice(0, 200)}`);
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? "";
  }
}
