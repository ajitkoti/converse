/**
 * Google Drive as the system of record for calls, organized BY TYPE:
 *
 *   Converse Sessions/
 *     Recordings/   <id>.webm
 *     Transcripts/  <id>.transcript.md
 *     Summaries/    <id>.summary.md
 *     Analyses/     <id>.analysis.json
 *     Sessions/     <id>.json          (the full SessionRecord — the source row)
 *
 * One file per call in each type folder, keyed by the call id. Writes overwrite
 * in place, so refreshing an analysis updates the same file. This layer only
 * knows about a small `DriveClient` interface, so it's fully unit-testable with
 * an in-memory fake and carries no LLM dependency (the analyze step is injected).
 */

import type { DriveClient } from "./gdrive.js";
import { buildSummaryMarkdown, buildTranscriptMarkdown } from "./summary.js";
import type { CallAnalysis, SessionRecord } from "./types.js";

const TYPE_FOLDERS = {
  recordings: "Recordings",
  transcripts: "Transcripts",
  summaries: "Summaries",
  analyses: "Analyses",
  sessions: "Sessions",
} as const;
type TypeKey = keyof typeof TYPE_FOLDERS;

export interface DriveCallEntry {
  id: string;
  modifiedTime?: string;
  hasRecording: boolean;
  hasAnalysis: boolean;
  hasTranscript: boolean;
}

export class DriveDb {
  #client: DriveClient;
  #rootName: string;
  #parentId?: string;
  #ids: Partial<Record<TypeKey | "root", string>> = {};

  constructor(client: DriveClient, opts: { rootName?: string; parentId?: string } = {}) {
    this.#client = client;
    this.#rootName = opts.rootName || "Converse Sessions";
    this.#parentId = opts.parentId;
  }

  connected(): boolean {
    return this.#client.status().connected;
  }

  /** Lazily create the root + type folders (idempotent). */
  async #tree(): Promise<Record<TypeKey, string>> {
    if (!this.#ids.root) {
      this.#ids.root = await this.#client.ensureFolder(this.#rootName, this.#parentId);
    }
    for (const key of Object.keys(TYPE_FOLDERS) as TypeKey[]) {
      if (!this.#ids[key]) this.#ids[key] = await this.#client.ensureFolder(TYPE_FOLDERS[key], this.#ids.root);
    }
    return {
      recordings: this.#ids.recordings!,
      transcripts: this.#ids.transcripts!,
      summaries: this.#ids.summaries!,
      analyses: this.#ids.analyses!,
      sessions: this.#ids.sessions!,
    };
  }

  /** Persist a full call: transcript, summary, raw record, and analysis (if present). */
  async storeCall(record: SessionRecord): Promise<{ id: string; links: Record<string, string> }> {
    const t = await this.#tree();
    const links: Record<string, string> = {};
    links.transcript = (await this.#client.putFile({ name: `${record.id}.transcript.md`, mimeType: "text/markdown", content: buildTranscriptMarkdown(record) }, t.transcripts)).link;
    links.summary = (await this.#client.putFile({ name: `${record.id}.summary.md`, mimeType: "text/markdown", content: buildSummaryMarkdown(record) }, t.summaries)).link;
    links.session = (await this.#client.putFile({ name: `${record.id}.json`, mimeType: "application/json", content: JSON.stringify(record, null, 2) }, t.sessions)).link;
    if (record.analysis) {
      links.analysis = (await this.#client.putFile({ name: `${record.id}.analysis.json`, mimeType: "application/json", content: JSON.stringify(record.analysis, null, 2) }, t.analyses)).link;
    }
    return { id: record.id, links };
  }

  /** Upload/replace a call's audio recording. */
  async putRecording(id: string, content: string | Buffer, mimeType = "audio/webm"): Promise<{ id: string; link: string }> {
    const t = await this.#tree();
    return this.#client.putFile({ name: `${id}.webm`, mimeType, content }, t.recordings);
  }

  /** List every call the Sessions folder knows about, with which artifacts exist. */
  async listCalls(): Promise<DriveCallEntry[]> {
    const t = await this.#tree();
    const [sessions, analyses, recordings, transcripts] = await Promise.all([
      this.#client.listFolder(t.sessions),
      this.#client.listFolder(t.analyses),
      this.#client.listFolder(t.recordings),
      this.#client.listFolder(t.transcripts),
    ]);
    const idsWith = (entries: { name: string }[], suffix: string) =>
      new Set(entries.filter((e) => e.name.endsWith(suffix)).map((e) => e.name.slice(0, -suffix.length)));
    const hasAnalysis = idsWith(analyses, ".analysis.json");
    const hasRecording = idsWith(recordings, ".webm");
    const hasTranscript = idsWith(transcripts, ".transcript.md");
    return sessions
      .filter((e) => e.name.endsWith(".json"))
      .map((e) => {
        const id = e.name.slice(0, -".json".length);
        return {
          id,
          modifiedTime: e.modifiedTime,
          hasAnalysis: hasAnalysis.has(id),
          hasRecording: hasRecording.has(id),
          hasTranscript: hasTranscript.has(id),
        };
      });
  }

  async #readJson<T>(folder: string, name: string): Promise<T | null> {
    const hit = await this.#client.findFile(name, folder);
    if (!hit) return null;
    try {
      return JSON.parse(await this.#client.readFile(hit.id)) as T;
    } catch {
      return null;
    }
  }

  /** The full stored record for a call (the source row), or null. */
  async getRecord(id: string): Promise<SessionRecord | null> {
    const t = await this.#tree();
    return this.#readJson<SessionRecord>(t.sessions, `${id}.json`);
  }

  /** The previously-stored analysis for a call, or null if none saved yet. */
  async getAnalysis(id: string): Promise<CallAnalysis | null> {
    const t = await this.#tree();
    return this.#readJson<CallAnalysis>(t.analyses, `${id}.analysis.json`);
  }

  /** The stored transcript markdown for a call, or null. */
  async getTranscript(id: string): Promise<string | null> {
    const t = await this.#tree();
    const hit = await this.#client.findFile(`${id}.transcript.md`, t.transcripts);
    return hit ? this.#client.readFile(hit.id) : null;
  }

  /**
   * Re-run the analysis for a stored call and overwrite it in Drive. `analyze`
   * is injected (heuristic or LLM) so this module stays free of LLM deps.
   * Returns the fresh analysis, or null if the call isn't in Drive.
   */
  async refreshAnalysis(id: string, analyze: (r: SessionRecord) => Promise<CallAnalysis> | CallAnalysis): Promise<CallAnalysis | null> {
    const record = await this.getRecord(id);
    if (!record) return null;
    const analysis = await analyze(record);
    record.analysis = analysis;
    await this.storeCall(record); // rewrites analysis.json + re-renders summary.md
    return analysis;
  }
}
