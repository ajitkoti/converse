import { describe, it, expect } from "vitest";
import { AnthropicLlmClient } from "../src/engine/anthropic-client.js";

/** Minimal fake of the Anthropic SDK client that captures create() params. */
function fakeAnthropic(capture: { params?: any }) {
  return {
    messages: {
      create: async (params: any) => {
        capture.params = params;
        return { content: [{ type: "text", text: '{"updates":[]}' }] };
      },
    },
  } as any;
}

describe("AnthropicLlmClient", () => {
  it("sends the system prompt as a cacheable block when cacheSystem is set", async () => {
    const cap: { params?: any } = {};
    const client = new AnthropicLlmClient({ client: fakeAnthropic(cap) });
    await client.complete({ system: "SYS", user: "u", model: "claude-haiku-4-5", maxTokens: 100, cacheSystem: true });
    expect(Array.isArray(cap.params.system)).toBe(true);
    expect(cap.params.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(cap.params.system[0].text).toBe("SYS");
  });

  it("sends a plain system string when cacheSystem is off", async () => {
    const cap: { params?: any } = {};
    const client = new AnthropicLlmClient({ client: fakeAnthropic(cap) });
    await client.complete({ system: "SYS", user: "u", model: "claude-haiku-4-5", maxTokens: 100 });
    expect(cap.params.system).toBe("SYS");
  });
});
