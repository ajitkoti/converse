/** Local persistence for session records: JSON + a Markdown summary + transcript. */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Analytics, SessionRecord, SessionSummary } from "./types.js";
import { buildSummaryMarkdown, buildTranscriptMarkdown } from "./summary.js";

function coveredCount(r: SessionRecord): number {
  return r.slotDefs.filter((s) => r.slots[s.id as keyof typeof r.slots]?.status === "covered").length;
}

export class SessionStore {
  #dir: string;
  #recDir: string;
  constructor(dataDir: string) {
    this.#dir = path.join(dataDir, "sessions");
    this.#recDir = path.join(dataDir, "recordings");
    fs.mkdirSync(this.#dir, { recursive: true });
    fs.mkdirSync(this.#recDir, { recursive: true });
  }

  /** Persist a call's audio recording locally. Returns its path. */
  saveRecording(id: string, data: Buffer): string {
    const p = path.join(this.#recDir, `${sanitize(id)}.webm`);
    if (!p.startsWith(this.#recDir)) throw new Error("bad id");
    fs.writeFileSync(p, data);
    return p;
  }

  /** Local path to a call's recording, or null if none saved. */
  recordingPath(id: string): string | null {
    const p = path.join(this.#recDir, `${sanitize(id)}.webm`);
    return p.startsWith(this.#recDir) && fs.existsSync(p) ? p : null;
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
        if (r.mode === "demo") continue; // demos are try-outs, never real history
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

  delete(id: string): boolean {
    let removed = false;
    for (const ext of [".json", ".summary.md", ".transcript.md"]) {
      const p = path.join(this.#dir, `${sanitize(id)}${ext}`);
      if (p.startsWith(this.#dir) && fs.existsSync(p)) {
        fs.unlinkSync(p);
        removed = true;
      }
    }
    const rec = path.join(this.#recDir, `${sanitize(id)}.webm`);
    if (rec.startsWith(this.#recDir) && fs.existsSync(rec)) {
      fs.unlinkSync(rec);
      removed = true;
    }
    return removed;
  }

  /** All saved records (for a full backup export). */
  allRecords(): SessionRecord[] {
    return this.#readAll();
  }

  /** Delete every saved session's files. Returns how many sessions were removed. */
  purgeAll(): number {
    if (!fs.existsSync(this.#dir)) return 0;
    const ids = fs
      .readdirSync(this.#dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length));
    let n = 0;
    for (const id of ids) if (this.delete(id)) n++;
    return n;
  }

  #readAll(): SessionRecord[] {
    const files = fs.existsSync(this.#dir)
      ? fs.readdirSync(this.#dir).filter((f) => f.endsWith(".json"))
      : [];
    const out: SessionRecord[] = [];
    for (const f of files) {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(this.#dir, f), "utf8")) as SessionRecord;
        if (r.mode === "demo") continue; // demos never count as real data (briefs, scorecard, analytics)
        out.push(r);
      } catch {
        /* skip */
      }
    }
    return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  analytics(): Analytics {
    const all = this.#readAll();
    const n = all.length;
    const slotAgg = new Map<string, { label: string; covered: number }>();
    let coverageSum = 0;
    let repMs = 0;
    let prospectMs = 0;
    let suggestions = 0;
    let llmCalls = 0;
    let live = 0;
    for (const r of all) {
      const total = r.slotDefs.length || 1;
      coverageSum += coveredCount(r) / total;
      suggestions += r.suggestions.length;
      llmCalls += r.perf?.llmCalls ?? 0;
      if (r.mode === "live") live++;
      repMs += r.talk?.repMs ?? 0;
      prospectMs += r.talk?.prospectMs ?? 0;
      for (const def of r.slotDefs) {
        const agg = slotAgg.get(def.id) ?? { label: def.label, covered: 0 };
        if (r.slots[def.id as keyof typeof r.slots]?.status === "covered") agg.covered++;
        slotAgg.set(def.id, agg);
      }
    }
    return {
      totalCalls: n,
      liveCalls: live,
      avgCoveragePct: n ? Math.round((coverageSum / n) * 100) : 0,
      totalSuggestions: suggestions,
      totalLlmCalls: llmCalls,
      totalTalkMs: { repMs, prospectMs },
      slotCoverage: [...slotAgg.entries()].map(([id, v]) => ({
        id,
        label: v.label,
        coveredPct: n ? Math.round((v.covered / n) * 100) : 0,
      })),
      trend: all.slice(-20).map((r) => ({
        id: r.id,
        startedAt: r.startedAt,
        coveragePct: Math.round((coveredCount(r) / (r.slotDefs.length || 1)) * 100),
      })),
    };
  }
}

export function makeSessionId(startedAt: Date, rand: string): string {
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  return `sess-${stamp}-${rand}`;
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "");
}
