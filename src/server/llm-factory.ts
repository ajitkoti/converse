/**
 * Pick an LlmClient from the available provider keys. Shared by the live session
 * (suggestions) and the HTTP API (pre-call brief, etc.) so provider selection
 * lives in exactly one place. Falls back to the offline client when no key is set.
 */

import { AnthropicLlmClient } from "../engine/anthropic-client.js";
import { OpenAiLlmClient } from "../engine/openai-client.js";
import type { LlmClient } from "../engine/llm.js";
import { OfflineLlmClient } from "./offline-llm.js";

export interface LlmKeys {
  anthropicApiKey?: string;
  openaiApiKey?: string;
  /** "anthropic" | "openai" | anything else = auto */
  aiProvider?: string;
}

export function chooseLlm(keys: LlmKeys): LlmClient {
  const { anthropicApiKey: anthropic, openaiApiKey: openai } = keys;
  const provider = keys.aiProvider || (anthropic ? "anthropic" : openai ? "openai" : "none");
  if (provider === "openai" && openai) return new OpenAiLlmClient({ apiKey: openai });
  if (provider === "anthropic" && anthropic) return new AnthropicLlmClient({ apiKey: anthropic });
  if (anthropic) return new AnthropicLlmClient({ apiKey: anthropic });
  if (openai) return new OpenAiLlmClient({ apiKey: openai });
  return new OfflineLlmClient();
}
