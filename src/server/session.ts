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
import type { LlmClient } from "../engine/llm.js";
import { chooseLlm } from "./llm-factory.js";
import type { JsonlLogger } from "../engine/logger.js";
import type { GuidanceEvent, SlotId, Speaker, TranscriptEvent } from "../engine/types.js";
import { loadCallFixture } from "../fixtures/load.js";
import { DeepgramLive } from "./deepgram.js";
import { OfflineLlmClient } from "./offline-llm.js";
import { frameworkOverride } from "./frameworks.js";
import { Coach, type CoachingSignal, type CoachingMetrics } from "./coaching.js";
import { detectObjection, type ObjectionType } from "./objections.js";
import { objectionTree, type ObjectionStep } from "./objection-tree.js";
import { IntelScout, type IntelKind } from "./intel.js";
import { analyzeCallLLM, analyzeCallHeuristic } from "./analysis.js";
import type { LlmRequest } from "../engine/llm.js";
import type { CallAnalysis } from "./types.js";
import type { Settings } from "./settings.js";
import type { ContextLibrary } from "./context.js";
import type { SessionStore } from "./store.js";
import { makeSessionId } from "./store.js";
import type { DriveExporter } from "./gdrive.js";
import type { DriveDb } from "./drive-db.js";
import { buildSummaryMarkdown, buildTranscriptMarkdown } from "./summary.js";
import type { SessionRecord, SlotDefWire, SuggestionRecord, TranscriptLine } from "./types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const readFixture = (name: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(fixturesDir, name), "utf8"));
const goodCall = readFixture("good-call.json");
const badCall = readFixture("bad-call.json");

export type { SlotDefWire } from "./types.js";

export type ServerToClient =
  | { type: "ready"; id: string; slots: ReturnType<QualificationEngine["getSlots"]>; slotDefs: SlotDefWire[]; mode: "demo" | "live" }
  | { type: "status"; text: string; level: "info" | "warn" | "error" }
  | { type: "transcript"; event: TranscriptEvent }
  | { type: "guidance"; event: GuidanceEvent }
  | { type: "summary"; record: SessionRecord; saved: boolean }
  | { type: "drive"; ok: boolean; files?: Array<{ name: string; link: string }>; error?: string }
  | { type: "coaching"; signal: CoachingSignal }
  | { type: "analysis"; id: string; analysis: CallAnalysis }
  | {
      type: "objection";
      objType: ObjectionType;
      label: string;
      cue: string;
      doc?: string;
      snippet?: string;
      steps: ObjectionStep[];
    }
  | { type: "intel"; kind: IntelKind; label: string; cue: string; doc?: string; snippet?: string }
  | { type: "export"; target: "slack"; ok: boolean; error?: string }
  | { type: "ended" };

export interface SessionEnv {
  deepgramApiKey?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  aiProvider?: string;
  deepgramModel?: string;
  logger?: JsonlLogger;
  settings: Settings;
  context: ContextLibrary;
  store: SessionStore;
  drive: DriveExporter;
  driveDb?: DriveDb;
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
  #ended = false;

  // recording
  #id = "";
  #startedAt = new Date(0);
  #mode: "demo" | "live" = "demo";
  #fixture?: string;
  #slotDefs: SlotDefWire[] = [];
  #transcript: TranscriptLine[] = [];
  #suggestions: SuggestionRecord[] = [];
  #notes = "";
  #talk = { repMs: 0, prospectMs: 0 };
  #coach = new Coach();
  #objections: Array<{ ts: number; type: string; label: string; doc?: string }> = [];
  #lastObjectionAt: Partial<Record<string, number>> = {};
  #intel: Array<{ ts: number; kind: IntelKind; label: string; doc?: string }> = [];
  #scout: IntelScout | null = null;
  #lastIntelAt: Partial<Record<string, number>> = {};
  #clfMs: number[] = [];
  #nudgeMs: number[] = [];
  #specHits = 0;
  #llmCalls = 0;
  #llm: LlmClient = new OfflineLlmClient();
  #llmIsOffline = true;
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
    this.#llmIsOffline = llm instanceof OfflineLlmClient;
    // Count real LLM calls (classifier, question, analysis) for usage telemetry.
    // Offline/demo calls don't hit an API, so they don't count toward usage.
    this.#llm = {
      complete: (r: LlmRequest) => {
        if (!this.#llmIsOffline) this.#llmCalls++;
        return llm.complete(r);
      },
    };
    const contextBlock = this.#env.context.contextBlock("");
    this.#engine = new QualificationEngine({
      llm: this.#llm,
      config,
      logger: this.#env.logger,
      prompts: this.#env.settings.prompts(contextBlock),
    });
    this.#slotDefs = config.slots.map((s) => ({
      id: s.id,
      label: s.label,
      escalateBy: config.budgets[s.id]?.escalateBy ?? null,
    }));
    this.#scout = new IntelScout(this.#env.context, this.#env.settings.get().competitors ?? []);
    this.#bus.on("transcript", (e) => {
      this.#engine!.ingest(e);
      if (e.isFinal && !e.utteranceEnd && e.text) {
        this.#transcript.push({ speaker: e.speaker, text: e.text, tsStart: e.tsStart, tsEnd: e.tsEnd });
        const dur = Math.max(0, e.tsEnd - e.tsStart);
        if (e.speaker === "rep") this.#talk.repMs += dur;
        else this.#talk.prospectMs += dur;

        const sig = this.#coach.ingest(e);
        if (sig) this.#send({ type: "coaching", signal: sig });

        if (e.speaker === "prospect") {
          this.#checkObjection(e.text, e.tsEnd);
          this.#checkIntel(e.text, e.tsEnd);
        }
      }
      this.#send({ type: "transcript", event: e });
    });
    this.#engine.on("guidance", (e) => {
      if (e.type === "suggestion") {
        this.#suggestions.push({ ts: e.ts, slotId: e.slotId, question: e.question, reason: e.reason, latencyMs: e.latencyMs });
      } else if (e.type === "metrics") {
        if (e.kind === "classify") this.#clfMs.push(e.ms);
        else if (e.kind === "suggestion") { this.#nudgeMs.push(e.ms); if (e.speculative) this.#specHits++; }
      }
      this.#send({ type: "guidance", event: e });
    });
    this.#send({ type: "ready", id: this.#id, slots: this.#engine.getSlots(), mode, slotDefs: this.#slotDefs });
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
    const llm = this.#chooseLlm();
    if (llm instanceof OfflineLlmClient) {
      this.#send({
        type: "status",
        text: "No Anthropic/OpenAI key — live transcription with the offline suggestion engine.",
        level: "warn",
      });
    }
    const fw = frameworkOverride(this.#env.settings.get().framework);
    const liveCfg = loadConfig(mergeOverride(fw ?? {}, this.#env.settings.configOverride()));
    this.#buildEngine(llm, liveCfg, "live");

    this.#dgRep = this.#makeDeepgram("rep");
    this.#dgProspect = this.#makeDeepgram("prospect");
    this.#send({ type: "status", text: "Listening — share your meeting tab (with audio) and start talking.", level: "info" });
  }

  /** Pick the LLM client for live suggestions based on provider + available keys. */
  #chooseLlm(): LlmClient {
    return chooseLlm({
      anthropicApiKey: this.#env.anthropicApiKey,
      openaiApiKey: this.#env.openaiApiKey,
      aiProvider: this.#env.aiProvider,
    });
  }

  #makeDeepgram(speaker: Speaker): DeepgramLive {
    const dg = new DeepgramLive({
      apiKey: this.#env.deepgramApiKey!,
      model: this.#env.deepgramModel,
      utteranceEndMs: this.#config.deepgram.utterance_end_ms,
    });
    const who = speaker === "rep" ? "your mic" : "the prospect audio";
    dg.on("message", (msg) => this.#bus.ingestDeepgram(msg, speaker));
    dg.on("error", (err) =>
      this.#send({ type: "status", text: `Deepgram (${speaker}) error: ${err.message}`, level: "error" }),
    );
    dg.on("reconnecting", () =>
      this.#send({ type: "status", text: `Reconnecting transcription for ${who}…`, level: "warn" }),
    );
    dg.on("reconnected", () =>
      this.#send({ type: "status", text: `Reconnected — ${who} transcription is back.`, level: "info" }),
    );
    dg.on("failed", () =>
      this.#send({ type: "status", text: `Lost transcription for ${who} — check your network.`, level: "error" }),
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

  ask(slot: SlotId): void {
    this.#engine?.askNow(slot);
  }

  setNotes(text: string): void {
    this.#notes = String(text ?? "").slice(0, 20000);
  }

  #checkObjection(text: string, ts: number): void {
    const hit = detectObjection(text);
    if (!hit) return;
    const last = this.#lastObjectionAt[hit.type];
    if (last !== undefined && ts - last < 45_000) return; // per-type cooldown
    this.#lastObjectionAt[hit.type] = ts;
    const match = this.#env.context.bestMatch(`${text} ${hit.label}`);
    this.#objections.push({ ts, type: hit.type, label: hit.label, doc: match?.name });
    this.#send({
      type: "objection",
      objType: hit.type,
      label: hit.label,
      cue: hit.cue,
      doc: match?.name,
      snippet: match?.snippet,
      steps: objectionTree(hit.type),
    });
  }

  #checkIntel(text: string, ts: number): void {
    const hit = this.#scout?.detect(text);
    if (!hit) return;
    const key = `${hit.kind}:${hit.label}`;
    const last = this.#lastIntelAt[key];
    if (last !== undefined && ts - last < 60_000) return; // per-cue cooldown
    this.#lastIntelAt[key] = ts;
    this.#intel.push({ ts, kind: hit.kind, label: hit.label, doc: hit.doc });
    this.#send({
      type: "intel",
      kind: hit.kind,
      label: hit.label,
      cue: hit.cue,
      doc: hit.doc,
      snippet: hit.snippet,
    });
  }

  /** Post the last finished session's summary to a Slack incoming webhook. */
  async exportSlack(): Promise<void> {
    const record = this.#lastRecord;
    const url = this.#env.settings.get().slackWebhookUrl;
    if (!record) return void this.#send({ type: "export", target: "slack", ok: false, error: "No finished session yet." });
    if (!url) return void this.#send({ type: "export", target: "slack", ok: false, error: "No Slack webhook URL set (Settings)." });
    try {
      const covered = record.slotDefs.filter((s) => record.slots[s.id]?.status === "covered").length;
      const gaps = record.slotDefs.filter((s) => record.slots[s.id]?.status !== "covered").map((s) => s.label);
      const text = [
        `*Discovery call summary* — ${new Date(record.startedAt).toLocaleString()}`,
        `Coverage: *${covered}/${record.slotDefs.length}*` + (gaps.length ? `  ·  Open: ${gaps.join(", ")}` : "  ·  full coverage"),
        record.notes ? `Notes: ${record.notes}` : "",
      ].filter(Boolean).join("\n");
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`Slack responded ${res.status}`);
      this.#send({ type: "export", target: "slack", ok: true });
    } catch (err) {
      this.#send({ type: "export", target: "slack", ok: false, error: String(err) });
    }
  }

  #buildRecord(): SessionRecord {
    return {
      id: this.#id,
      startedAt: this.#startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      mode: this.#mode,
      fixture: this.#fixture,
      persona: this.#env.settings.get().persona,
      rep: this.#env.settings.get().repName?.trim() || "You",
      framework: this.#mode === "live" ? this.#env.settings.get().framework || "meddpicc" : "meddpicc",
      durationMs: this.#engine?.callTimeMs ?? 0,
      slotDefs: this.#slotDefs,
      slots: this.#engine?.getSlots() ?? ({} as SessionRecord["slots"]),
      transcript: this.#transcript,
      suggestions: this.#suggestions,
      notes: this.#notes || undefined,
      talk: this.#talk,
      coaching: this.#coach.metrics(),
      objections: this.#objections,
      intel: this.#intel,
      perf: {
        avgClassifierMs: avg(this.#clfMs),
        avgNudgeMs: avg(this.#nudgeMs),
        speculativeHits: this.#specHits,
        echoesSuppressed: this.#bus.suppressedEchoes,
        llmCalls: this.#llmCalls,
      },
    };
  }

  /** Generate the post-call analysis, persist it, and push it to the client. */
  async #runAnalysis(record: SessionRecord): Promise<void> {
    let analysis: CallAnalysis;
    try {
      analysis = this.#llmIsOffline
        ? analyzeCallHeuristic(record)
        : await analyzeCallLLM(this.#llm, record, this.#config.models.questionGen);
    } catch {
      analysis = analyzeCallHeuristic(record); // fall back on any model error
    }
    record.analysis = analysis;
    if (record.perf) record.perf.llmCalls = this.#llmCalls; // include the analysis call
    this.#lastRecord = record;
    if (this.#mode === "live" && this.#env.settings.get().autoSave !== false) {
      try {
        this.#env.store.save(record);
      } catch {
        /* best effort */
      }
    }
    this.#send({ type: "analysis", id: record.id, analysis });
    // Mirror the finished call (with analysis) into Drive when it's the DB — live only.
    if (this.#mode === "live" && this.#env.settings.get().driveSync !== false && this.#env.driveDb?.connected()) {
      this.#env.driveDb
        .storeCall(record)
        .then((res) => this.#send({ type: "drive", ok: true, files: Object.entries(res.links).map(([name, link]) => ({ name, link })) }))
        .catch((err) => this.#send({ type: "drive", ok: false, error: `Drive sync: ${String(err)}` }));
    }
  }

  #end(): void {
    if (this.#ended) return; // runs once, whether reached via demo completion or stop()/ws close
    this.#ended = true;
    this.#engine?.flush();
    // allow the flush classify to land before snapshotting
    setTimeout(() => {
      const record = this.#buildRecord();
      this.#lastRecord = record;
      let saved = false;
      // Demos are ephemeral try-outs: never persisted, never counted as real data,
      // never synced to Drive. Only real (live) calls become part of the record.
      if (this.#mode === "live" && this.#env.settings.get().autoSave !== false) {
        try {
          this.#env.store.save(record);
          saved = true;
        } catch (err) {
          this.#send({ type: "status", text: `Could not save session: ${String(err)}`, level: "error" });
        }
      }
      this.#send({ type: "summary", record, saved });
      // Post-call AI debrief runs after the summary lands so the UI can show a
      // "generating…" state; it re-saves the record with the analysis attached.
      void this.#runAnalysis(record);
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
    // For a live call, stop() (client "stop" / ws close) is the end of the call:
    // persist the record, run the post-call debrief, and sync to Drive. #end()
    // flushes the engine and is guarded so a completed demo can't run it twice.
    this.#end();
  }
}

function avg(xs: number[]): number {
  return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
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
