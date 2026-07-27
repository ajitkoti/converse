/**
 * Standalone Anthropic LlmClient — for server-side use, the replay harness, and
 * anywhere raven's AIProvider isn't present. This is the ONLY engine file that
 * imports an SDK, and it is not imported by the engine core (qualification.ts /
 * transcript-bus.ts). Keeps the portability contract intact.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { LlmClient, LlmRequest } from "./llm.js";

export interface AnthropicClientOptions {
  apiKey?: string;
  /** override the SDK instance (tests) */
  client?: Anthropic;
}

export class AnthropicLlmClient implements LlmClient {
  #client: Anthropic;
  constructor(opts: AnthropicClientOptions = {}) {
    this.#client =
      opts.client ?? new Anthropic({ apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY });
  }

  async complete(req: LlmRequest): Promise<string> {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: req.user }];
    // Prefill via an assistant turn forces the reply shape (e.g. JSON).
    if (req.prefill) messages.push({ role: "assistant", content: req.prefill });

    // Cache the static system prompt to cut latency + cost on repeated calls.
    const system: Anthropic.MessageCreateParams["system"] = req.cacheSystem
      ? [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }]
      : req.system;

    const res = await this.#client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens,
      system,
      messages,
    });
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  }
}
