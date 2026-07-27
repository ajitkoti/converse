/**
 * Public API of the qualification engine. The Electron/app layer imports ONLY
 * from here. Nothing under this path imports Electron or UI code.
 */

export type {
  Speaker,
  TranscriptEvent,
  SlotId,
  SlotStatus,
  SlotState,
  SlotStates,
  GuidanceEvent,
} from "./types.js";

export { TranscriptBus } from "./transcript-bus.js";
export type {
  DeepgramMessage,
  DeepgramResultsMessage,
  DeepgramUtteranceEndMessage,
} from "./transcript-bus.js";

export { QualificationEngine } from "./qualification.js";
export type { EngineDeps } from "./qualification.js";

export { loadConfig, defaultConfig } from "./config.js";
export type { EngineConfig, SlotDef, SlotBudget, ConfigOverride } from "./config.js";

export type { LlmClient, LlmRequest } from "./llm.js";
export { extractJson } from "./llm.js";
export { AnthropicLlmClient } from "./anthropic-client.js";

export { nullLogger, MemoryLogger, FileLogger } from "./logger.js";
export type { JsonlLogger, LogRecord } from "./logger.js";
