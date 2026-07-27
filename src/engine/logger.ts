/**
 * JSONL logger. Every classifier call/response and every suggestion decision is
 * appended as one JSON line. This log is the PRIMARY iteration tool for tuning
 * the engine post-call (see build plan: "read the classifier JSONL log and fix
 * the worst behavior").
 *
 * The engine depends only on the JsonlLogger interface, so tests can pass an
 * in-memory logger and assert on decisions without touching the filesystem.
 */

export type LogRecord = Record<string, unknown> & { event: string; ts: number };

export interface JsonlLogger {
  log(record: LogRecord): void;
}

/** No-op logger (default). */
export const nullLogger: JsonlLogger = { log() {} };

/** Collects records in memory — used by tests. */
export class MemoryLogger implements JsonlLogger {
  readonly records: LogRecord[] = [];
  log(record: LogRecord): void {
    this.records.push(record);
  }
  ofEvent(event: string): LogRecord[] {
    return this.records.filter((r) => r.event === event);
  }
}

/**
 * Appends JSONL to a file. Kept out of the engine's import graph on purpose —
 * only the app/harness constructs this (it touches `node:fs`). Synchronous
 * append is fine: records are small and infrequent (≈1 per 20s of call).
 */
export class FileLogger implements JsonlLogger {
  #fs: typeof import("node:fs");
  #path: string;
  constructor(path: string, fs: typeof import("node:fs")) {
    this.#path = path;
    this.#fs = fs;
  }
  log(record: LogRecord): void {
    this.#fs.appendFileSync(this.#path, JSON.stringify(record) + "\n");
  }
}
