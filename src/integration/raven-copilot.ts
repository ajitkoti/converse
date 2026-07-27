/**
 * Reference integration glue for project-raven. This is APP-LAYER wiring, not
 * engine code — but it still imports ZERO Electron: raven's main process passes
 * in the two things the engine can't know about (an LlmClient and a broadcast
 * function). This keeps the boundary clean and this file unit-testable.
 *
 * How raven wires it up (see ARCHITECTURE.md for the full walkthrough):
 *
 *   // 1. Build the LlmClient from raven's existing AI provider abstraction.
 *   const provider = getProFastProvider();            // src/main/services/ai
 *   const llm: LlmClient = { complete: (r) => provider.generateShort(r.system, r.user) };
 *
 *   // 2. Construct the copilot, broadcasting guidance to the overlay renderer.
 *   const copilot = new RavenCopilot({
 *     llm,
 *     broadcast: (payload) => overlayWindow.webContents.send('guidance:update', payload),
 *     logger: new FileLogger(logPath, fs),
 *   });
 *
 *   // 3. PASSIVE tap on each Deepgram socket — the audio pipeline is untouched.
 *   //    (raven already enables interim_results + utterance_end_ms.)
 *   ws.addEventListener('message', (e) =>
 *     copilot.onDeepgramMessage(source, JSON.parse(String(e.data))));
 *
 *   // 4. Hotkeys from the overlay:
 *   ipcMain.on('guidance:snooze', (_e, slot) => copilot.snooze(slot));
 */

import { TranscriptBus, type DeepgramMessage } from "../engine/transcript-bus.js";
import { QualificationEngine } from "../engine/qualification.js";
import { loadConfig, type ConfigOverride, type EngineConfig } from "../engine/config.js";
import type { LlmClient } from "../engine/llm.js";
import type { JsonlLogger } from "../engine/logger.js";
import type { GuidanceEvent, SlotId, SlotStates } from "../engine/types.js";

/** raven's audio source → our speaker tag. mic = the rep, system = the prospect. */
export type RavenAudioSource = "mic" | "system";

export interface RavenCopilotHost {
  llm: LlmClient;
  /** Push a guidance event to the overlay renderer (webContents.send). */
  broadcast: (payload: GuidanceEvent) => void;
  logger?: JsonlLogger;
  config?: EngineConfig;
  configOverride?: ConfigOverride;
}

export class RavenCopilot {
  readonly bus: TranscriptBus;
  readonly engine: QualificationEngine;
  #broadcast: (payload: GuidanceEvent) => void;

  constructor(host: RavenCopilotHost) {
    this.#broadcast = host.broadcast;
    this.bus = new TranscriptBus();
    this.engine = new QualificationEngine({
      llm: host.llm,
      logger: host.logger,
      config: host.config ?? loadConfig(host.configOverride),
    });

    // Wire the stream: Deepgram → bus → engine → overlay.
    this.bus.on("transcript", (e) => this.engine.ingest(e));
    this.engine.on("guidance", (e) => this.#broadcast(e));
  }

  /** Call from the tapped Deepgram socket's onmessage handler. */
  onDeepgramMessage(source: RavenAudioSource, msg: DeepgramMessage): void {
    this.bus.ingestDeepgram(msg, source === "mic" ? "rep" : "prospect");
  }

  /** Overlay hotkey: snooze a slot's suggestions for the configured window. */
  snooze(slot: SlotId): void {
    this.engine.snoozeSlot(slot);
  }

  /** Current slot states (e.g. to render the rail on overlay (re)mount). */
  slots(): SlotStates {
    return this.engine.getSlots();
  }

  /** Call on call end to score the tail of the transcript. */
  endCall(): void {
    this.engine.flush();
  }
}
