/**
 * A copilot session for one connected browser. Owns a TranscriptBus + a
 * QualificationEngine and drives them from either:
 *   - LIVE mode: two Deepgram connections (rep = mic, prospect = shared tab audio)
 *   - DEMO mode: a scripted fixture replayed in real time, offline (no API keys)
 * and streams transcript + guidance events back to the client.
 */

import { TranscriptBus } from "../engine/transcript-bus.js";
import { QualificationEngine } from "../engine/qualification.js";
import { loadConfig, type ConfigOverride, type EngineConfig } from "../engine/config.js";
import { AnthropicLlmClient } from "../engine/anthropic-client.js";
import type { LlmClient } from "../engine/llm.js";
import type { JsonlLogger } from "../engine/logger.js";
import type { GuidanceEvent, SlotId, Speaker, TranscriptEvent } from "../engine/types.js";
import { loadCallFixture } from "../fixtures/load.js";
import { DeepgramLive } from "./deepgram.js";
import { OfflineLlmClient } from "./offline-llm.js";
import goodCall from "../fixtures/good-call.json" with { type: "json" };
import badCall from "../fixtures/bad-call.json" with { type: "json" };

export interface SlotDefWire {
  id: string;
  label: string;
  escalateBy: number | null;
}

export type ServerToClient =
  | { type: "ready"; slots: ReturnType<QualificationEngine["getSlots"]>; slotDefs: SlotDefWire[]; mode: "demo" | "live" }
  | { type: "status"; text: string; level: "info" | "warn" | "error" }
  | { type: "transcript"; event: TranscriptEvent }
  | { type: "guidance"; event: GuidanceEvent }
  | { type: "ended" };

export interface SessionEnv {
  deepgramApiKey?: string;
  anthropicApiKey?: string;
  deepgramModel?: string;
  logger?: JsonlLogger;
}

/** DEMO tuning: short budgets so escalation/suggestions are visible in a ~1-2 min fixture. */
const DEMO_OVERRIDE: ConfigOverride = {
  suggestion: { cooldownSeconds: 30 },
  budgets: {
    identifyPain: { expectPartialBy: 15, escalateBy: 25 },
    metrics: { expectPartialBy: 20, escalateBy: 35 },
    decisionCriteria: { escalateBy: 45 },
    decisionProcess: { escalateBy: 45 },
    competition: { escalateBy: 45 },
    economicBuyer: { escalateBy: 50 },
    champion: { escalateBy: 55 },
    paperProcess: { escalateBy: 60 },
  },
};

export class Session {
  #send: (msg: ServerToClient) => void;
  #env: SessionEnv;
  #bus = new TranscriptBus();
  #engine: QualificationEngine | null = null;
  #config: EngineConfig = loadConfig();
  #dgRep: DeepgramLive | null = null;
  #dgProspect: DeepgramLive | null = null;
  #demoTimer: ReturnType<typeof setTimeout> | null = null;
  #stopped = false;

  constructor(send: (msg: ServerToClient) => void, env: SessionEnv) {
    this.#send = send;
    this.#env = env;
  }

  start(opts: { mode: "demo" | "live"; fixture?: string; speed?: number }): void {
    if (opts.mode === "live") this.#startLive();
    else this.#startDemo(opts.fixture ?? "good-call", opts.speed ?? 6);
  }

  #buildEngine(llm: LlmClient, config: EngineConfig, mode: "demo" | "live"): void {
    this.#config = config;
    this.#engine = new QualificationEngine({ llm, config, logger: this.#env.logger });
    this.#bus.on("transcript", (e) => {
      this.#engine!.ingest(e);
      this.#send({ type: "transcript", event: e });
    });
    this.#engine.on("guidance", (e) => this.#send({ type: "guidance", event: e }));
    this.#send({
      type: "ready",
      slots: this.#engine.getSlots(),
      mode,
      slotDefs: config.slots.map((s) => ({
        id: s.id,
        label: s.label,
        escalateBy: config.budgets[s.id]?.escalateBy ?? null,
      })),
    });
  }

  // ---- DEMO --------------------------------------------------------------
  #startDemo(fixtureName: string, speed: number): void {
    const fixture = fixtureName === "bad-call" ? badCall : goodCall;
    this.#buildEngine(new OfflineLlmClient(), loadConfig(DEMO_OVERRIDE), "demo");
    const events = loadCallFixture(fixture);
    this.#send({
      type: "status",
      text: `Demo: ${fixtureName === "bad-call" ? "a rough, vague call" : "a strong discovery call"} (${speed}× speed)`,
      level: "info",
    });

    let i = 0;
    let prevTs = 0;
    const step = () => {
      if (this.#stopped || i >= events.length) {
        if (!this.#stopped) this.#end();
        return;
      }
      const event = events[i]!;
      this.#bus.push(event);
      prevTs = event.tsEnd;
      i++;
      const next = events[i];
      const gapMs = next ? Math.max(0, next.tsEnd - prevTs) : 400;
      this.#demoTimer = setTimeout(step, Math.max(60, gapMs / speed));
    };
    step();
  }

  // ---- LIVE --------------------------------------------------------------
  #startLive(): void {
    if (!this.#env.deepgramApiKey) {
      this.#send({ type: "status", text: "Missing DEEPGRAM_API_KEY — add it to .env for live mode.", level: "error" });
      return;
    }
    const llm: LlmClient = this.#env.anthropicApiKey
      ? new AnthropicLlmClient({ apiKey: this.#env.anthropicApiKey })
      : new OfflineLlmClient();
    if (!this.#env.anthropicApiKey) {
      this.#send({
        type: "status",
        text: "No ANTHROPIC_API_KEY — running live transcription with the offline suggestion engine.",
        level: "warn",
      });
    }
    this.#buildEngine(llm, loadConfig(), "live");

    this.#dgRep = this.#makeDeepgram("rep");
    this.#dgProspect = this.#makeDeepgram("prospect");
    this.#send({ type: "status", text: "Listening — share your meeting tab (with audio) and start talking.", level: "info" });
  }

  #makeDeepgram(speaker: Speaker): DeepgramLive {
    const dg = new DeepgramLive({
      apiKey: this.#env.deepgramApiKey!,
      model: this.#env.deepgramModel,
      utteranceEndMs: this.#config.deepgram.utterance_end_ms,
    });
    dg.on("message", (msg) => this.#bus.ingestDeepgram(msg, speaker));
    dg.on("error", (err) =>
      this.#send({ type: "status", text: `Deepgram (${speaker}) error: ${err.message}`, level: "error" }),
    );
    return dg;
  }

  /** Route a browser audio frame: first byte 0=mic(rep), 1=system(prospect). */
  onAudio(frame: Buffer): void {
    if (frame.length < 2) return;
    const channel = frame[0];
    const pcm = frame.subarray(1);
    if (channel === 0) this.#dgRep?.send(pcm);
    else this.#dgProspect?.send(pcm);
  }

  snooze(slot: SlotId): void {
    this.#engine?.snoozeSlot(slot);
  }

  #end(): void {
    this.#engine?.flush();
    this.#send({ type: "ended" });
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#demoTimer) clearTimeout(this.#demoTimer);
    this.#dgRep?.finish();
    this.#dgProspect?.finish();
    this.#engine?.flush();
  }
}
