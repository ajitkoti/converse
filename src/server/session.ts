/**
 * A copilot session for one connected browser. Owns a TranscriptBus + a
 * QualificationEngine and drives them from either:
 *   - LIVE mode: two Deepgram connections (rep = mic, prospect = shared tab audio)
 *   - DEMO mode: a scripted fixture replayed in real time, offline (no API keys)
 * It records the whole session, persists a summary on end, and can export to
 * Google Drive. Prompts are customized from user Settings + the context library.
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
import type { Settings } from "./settings.js";
import type { ContextLibrary } from "./context.js";
import type { SessionStore } from "./store.js";
import { makeSessionId } from "./store.js";
import type { DriveExporter } from "./gdrive.js";
import { buildSummaryMarkdown, buildTranscriptMarkdown } from "./summary.js";
import type { SessionRecord, SlotDefWire, SuggestionRecord, TranscriptLine } from "./types.js";
import goodCall from "../fixtures/good-call.json" with { type: "json" };
import badCall from "../fixtures/bad-call.json" with { type: "json" };

export type { SlotDefWire } from "./types.js";

export type ServerToClient =
  | { type: "ready"; slots: ReturnType<QualificationEngine["getSlots"]>; slotDefs: SlotDefWire[]; mode: "demo" | "live" }
  | { type: "status"; text: string; level: "info" | "warn" | "error" }
  | { type: "transcript"; event: TranscriptEvent }
  | { type: "guidance"; event: GuidanceEvent }
  | { type: "summary"; record: SessionRecord; saved: boolean }
  | { type: "drive"; ok: boolean; files?: Array<{ name: string; link: string }>; error?: string }
  | { type: "ended" };

export interface SessionEnv {
  deepgramApiKey?: string;
  anthropicApiKey?: string;
  deepgramModel?: string;
  logger?: JsonlLogger;
  settings: Settings;
  context: ContextLibrary;
  store: SessionStore;
  drive: DriveExporter;
  driveRootFolderId?: string;
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

  // recording
  #id = "";
  #startedAt = new Date(0);
  #mode: "demo" | "live" = "demo";
  #fixture?: string;
  #slotDefs: SlotDefWire[] = [];
  #transcript: TranscriptLine[] = [];
  #suggestions: SuggestionRecord[] = [];
  #lastRecord: SessionRecord | null = null;

  constructor(send: (msg: ServerToClient) => void, env: SessionEnv) {
    this.#send = send;
    this.#env = env;
  }

  start(opts: { mode: "demo" | "live"; fixture?: string; speed?: number }): void {
    this.#startedAt = new Date();
    this.#id = makeSessionId(this.#startedAt, Math.floor(Math.random() * 1e4).toString(36));
    this.#mode = opts.mode;
    this.#fixture = opts.fixture;
    const speed = opts.speed ?? this.#env.settings.get().demoSpeed ?? 6;
    if (opts.mode === "live") this.#startLive();
    else this.#startDemo(opts.fixture ?? "good-call", speed);
  }

  #buildEngine(llm: LlmClient, config: EngineConfig, mode: "demo" | "live"): void {
    this.#config = config;
    const contextBlock = this.#env.context.contextBlock("");
    this.#engine = new QualificationEngine({
      llm,
      config,
      logger: this.#env.logger,
      prompts: this.#env.settings.prompts(contextBlock),
    });
    this.#slotDefs = config.slots.map((s) => ({
      id: s.id,
      label: s.label,
      escalateBy: config.budgets[s.id]?.escalateBy ?? null,
    }));
    this.#bus.on("transcript", (e) => {
      this.#engine!.ingest(e);
      if (e.isFinal && !e.utteranceEnd && e.text) {
        this.#transcript.push({ speaker: e.speaker, text: e.text, tsStart: e.tsStart, tsEnd: e.tsEnd });
      }
      this.#send({ type: "transcript", event: e });
    });
    this.#engine.on("guidance", (e) => {
      if (e.type === "suggestion") {
        this.#suggestions.push({ ts: e.ts, slotId: e.slotId, question: e.question, reason: e.reason, latencyMs: e.latencyMs });
      }
      this.#send({ type: "guidance", event: e });
    });
    this.#send({ type: "ready", slots: this.#engine.getSlots(), mode, slotDefs: this.#slotDefs });
  }

  // ---- DEMO --------------------------------------------------------------
  #startDemo(fixtureName: string, speed: number): void {
    const fixture = fixtureName === "bad-call" ? badCall : goodCall;
    const config = loadConfig(mergeOverride(DEMO_OVERRIDE, this.#env.settings.configOverride()));
    this.#buildEngine(new OfflineLlmClient(), config, "demo");
    const events = loadCallFixture(fixture);
    this.#send({
      type: "status",
      text: `Demo: ${fixtureName === "bad-call" ? "a rough, vague call" : "a strong discovery call"} (${speed}× speed)`,
      level: "info",
    });

    let i = 0;
    const step = () => {
      if (this.#stopped || i >= events.length) {
        if (!this.#stopped) this.#end();
        return;
      }
      const event = events[i]!;
      this.#bus.push(event);
      i++;
      const next = events[i];
      const gapMs = next ? Math.max(0, next.tsEnd - event.tsEnd) : 400;
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
    this.#buildEngine(llm, loadConfig(this.#env.settings.configOverride()), "live");

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

  #buildRecord(): SessionRecord {
    return {
      id: this.#id,
      startedAt: this.#startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      mode: this.#mode,
      fixture: this.#fixture,
      persona: this.#env.settings.get().persona,
      durationMs: this.#engine?.callTimeMs ?? 0,
      slotDefs: this.#slotDefs,
      slots: this.#engine?.getSlots() ?? ({} as SessionRecord["slots"]),
      transcript: this.#transcript,
      suggestions: this.#suggestions,
    };
  }

  #end(): void {
    this.#engine?.flush();
    // allow the flush classify to land before snapshotting
    setTimeout(() => {
      const record = this.#buildRecord();
      this.#lastRecord = record;
      let saved = false;
      if (this.#env.settings.get().autoSave !== false) {
        try {
          this.#env.store.save(record);
          saved = true;
        } catch (err) {
          this.#send({ type: "status", text: `Could not save session: ${String(err)}`, level: "error" });
        }
      }
      this.#send({ type: "summary", record, saved });
      this.#send({ type: "ended" });
    }, 400);
  }

  /** Export the last finished session to Google Drive. */
  async exportDrive(): Promise<void> {
    const record = this.#lastRecord;
    if (!record) {
      this.#send({ type: "drive", ok: false, error: "No finished session to export yet." });
      return;
    }
    const st = this.#env.drive.status();
    if (!st.connected) {
      this.#send({ type: "drive", ok: false, error: st.reason ?? "Google Drive is not connected." });
      return;
    }
    try {
      const folderId =
        this.#env.settings.get().driveFolderId ??
        this.#env.driveRootFolderId ??
        (await this.#env.drive.ensureFolder("Converse Sessions"));
      const files = await this.#env.drive.upload(
        [
          { name: `${record.id}.summary.md`, mimeType: "text/markdown", content: buildSummaryMarkdown(record) },
          { name: `${record.id}.transcript.md`, mimeType: "text/markdown", content: buildTranscriptMarkdown(record) },
          { name: `${record.id}.json`, mimeType: "application/json", content: JSON.stringify(record, null, 2) },
        ],
        folderId,
      );
      this.#send({ type: "drive", ok: true, files: files.map((f) => ({ name: f.name, link: f.link })) });
    } catch (err) {
      this.#send({ type: "drive", ok: false, error: String(err) });
    }
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

/** Shallow-merge two ConfigOverrides (user override wins), with nested budgets/suggestion merged. */
function mergeOverride(base: ConfigOverride, extra?: ConfigOverride): ConfigOverride {
  if (!extra) return base;
  return {
    ...base,
    ...extra,
    suggestion: { ...base.suggestion, ...extra.suggestion },
    budgets: { ...base.budgets, ...extra.budgets },
  };
}
