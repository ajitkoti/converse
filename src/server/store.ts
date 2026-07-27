/** Local persistence for session records: JSON + a Markdown summary + transcript. */

import * as fs from "node:fs";
import * as path from "node:path";
import type { SessionRecord, SessionSummary } from "./types.js";
import { buildSummaryMarkdown, buildTranscriptMarkdown } from "./summary.js";

export class SessionStore {
  #dir: string;
  constructor(dataDir: string) {
    this.#dir = path.join(dataDir, "sessions");
    fs.mkdirSync(this.#dir, { recursive: true });
  }

  /** Persist a record and its rendered artifacts. Returns the file paths. */
  save(record: SessionRecord): { json: string; summary: string; transcript: string } {
    const base = path.join(this.#dir, record.id);
    const json = `${base}.json`;
    const summary = `${base}.summary.md`;
    const transcript = `${base}.transcript.md`;
    fs.writeFileSync(json, JSON.stringify(record, null, 2));
    fs.writeFileSync(summary, buildSummaryMarkdown(record));
    fs.writeFileSync(transcript, buildTranscriptMarkdown(record));
    return { json, summary, transcript };
  }

  list(): SessionSummary[] {
    const files = fs.existsSync(this.#dir)
      ? fs.readdirSync(this.#dir).filter((f) => f.endsWith(".json"))
      : [];
    const out: SessionSummary[] = [];
    for (const f of files) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(this.#dir, f), "utf8")) as SessionRecord;
        const covered = r.slotDefs.filter(
          (s) => r.slots[s.id as keyof typeof r.slots]?.status === "covered",
        ).length;
        out.push({
          id: r.id,
          startedAt: r.startedAt,
          mode: r.mode,
          durationMs: r.durationMs,
          covered,
          total: r.slotDefs.length,
          suggestions: r.suggestions.length,
        });
      } catch {
        /* skip corrupt */
      }
    }
    return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  read(id: string): SessionRecord | null {
    const p = path.join(this.#dir, `${sanitize(id)}.json`);
    if (!p.startsWith(this.#dir) || !fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, "utf8")) as SessionRecord;
    } catch {
      return null;
    }
  }

  summaryMarkdown(id: string): string | null {
    const r = this.read(id);
    return r ? buildSummaryMarkdown(r) : null;
  }
}

export function makeSessionId(startedAt: Date, rand: string): string {
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  return `sess-${stamp}-${rand}`;
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "");
}
