/**
 * User settings, persisted to converse.config.json at the repo root. Everything
 * here is optional and overrides the engine defaults / built-in prompts. The UI
 * Settings panel reads and writes this file; nothing here is required to run.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ConfigOverride } from "../engine/config.js";
import type { PromptCustomization } from "../engine/qualification.js";

export interface UserSettings {
  /** engine config overrides (models, budgets, cooldown, cadence, windows) */
  config?: ConfigOverride;
  /** custom system prompts (empty/undefined = use built-ins) */
  classifierPrompt?: string;
  questionPrompt?: string;
  /** default prospect persona applied to question generation */
  persona?: string;
  /** demo replay speed */
  demoSpeed?: number;
  /** whether to inject context/*.md into question generation */
  useContext?: boolean;
  /** Google Drive folder id to upload session artifacts into */
  driveFolderId?: string;
  /** auto-save every finished session locally (default true) */
  autoSave?: boolean;
  /** API keys entered in-app (used in packaged builds so no file editing is needed) */
  deepgramApiKey?: string;
  anthropicApiKey?: string;
}

export class Settings {
  #file: string;
  #data: UserSettings = {};

  constructor(file: string) {
    this.#file = file;
    this.reload();
  }

  reload(): void {
    if (fs.existsSync(this.#file)) {
      try {
        this.#data = JSON.parse(fs.readFileSync(this.#file, "utf8")) as UserSettings;
      } catch {
        this.#data = {};
      }
    }
  }

  get(): UserSettings {
    return this.#data;
  }

  /** Merge a partial update, persist, return the new settings. */
  update(patch: Partial<UserSettings>): UserSettings {
    this.#data = { ...this.#data, ...patch };
    // normalize empty strings to undefined so built-ins are used
    for (const k of ["classifierPrompt", "questionPrompt", "persona"] as const) {
      if (typeof this.#data[k] === "string" && this.#data[k]!.trim() === "") delete this.#data[k];
    }
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    fs.writeFileSync(this.#file, JSON.stringify(this.#data, null, 2));
    return this.#data;
  }

  /** Prompt customization derived from settings, merged with an optional context block. */
  prompts(contextBlock?: string): PromptCustomization {
    return {
      classifierSystem: this.#data.classifierPrompt,
      questionSystem: this.#data.questionPrompt,
      persona: this.#data.persona,
      contextBlock: this.#data.useContext === false ? undefined : contextBlock,
    };
  }

  configOverride(): ConfigOverride | undefined {
    return this.#data.config;
  }
}
