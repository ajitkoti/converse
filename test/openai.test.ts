import { describe, it, expect } from "vitest";
import { OpenAiLlmClient } from "../src/engine/openai-client.js";

/** Capture the request body/headers with a fake fetch. */
function fakeFetch(capture: { body?: unknown; auth?: string }, reply: unknown) {
  return (async (_url: string, init: RequestInit) => {
    capture.body = JSON.parse(String(init.body));
    capture.auth = (init.headers as Record<string, string>)["Authorization"];
    return { ok: true, json: async () => reply } as Response;
  }) as unknown as typeof fetch;
}

describe("OpenAiLlmClient", () => {
  it("calls chat completions and returns the message content", async () => {
    const cap: { body?: any; auth?: string } = {};
    const client = new OpenAiLlmClient({
      apiKey: "sk-test",
      fetchImpl: fakeFetch(cap, { choices: [{ message: { content: '{"updates":[]}' } }] }),
    });
    const out = await client.complete({ system: "sys", user: "hi", model: "claude-haiku-4-5", maxTokens: 100 });
    expect(out).toBe('{"updates":[]}');
    expect(cap.auth).toBe("Bearer sk-test");
    // Claude model id → falls back to the OpenAI default model
    expect(cap.body.model).toBe("gpt-4o-mini");
    expect(cap.body.messages[0].role).toBe("system");
  });

  it("requests JSON mode when a JSON prefill is given, and keeps explicit OpenAI models", async () => {
    const cap: { body?: any } = {};
    const client = new OpenAiLlmClient({
      apiKey: "k",
      model: "gpt-4o-mini",
      fetchImpl: fakeFetch(cap, { choices: [{ message: { content: "{}" } }] }),
    });
    await client.complete({ system: "s", user: "u", model: "gpt-4o", maxTokens: 50, prefill: '{"updates":' });
    expect(cap.body.model).toBe("gpt-4o");
    expect(cap.body.response_format).toEqual({ type: "json_object" });
  });

  it("throws with detail on a non-2xx response", async () => {
    const client = new OpenAiLlmClient({
      apiKey: "k",
      fetchImpl: (async () => ({ ok: false, status: 401, text: async () => "bad key" }) as Response) as unknown as typeof fetch,
    });
    await expect(client.complete({ system: "s", user: "u", model: "gpt-4o", maxTokens: 10 })).rejects.toThrow(/401/);
  });
});
