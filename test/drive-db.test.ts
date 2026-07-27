import { describe, it, expect, beforeEach } from "vitest";
import { DriveDb } from "../src/server/drive-db.js";
import type { DriveClient, DriveEntry, DriveFileInput, DriveStatus } from "../src/server/gdrive.js";
import type { CallAnalysis, SessionRecord } from "../src/server/types.js";

/** In-memory Drive so the database logic is tested without Google credentials. */
class FakeDrive implements DriveClient {
  folders = new Map<string, { name: string; parent?: string }>();
  files = new Map<string, { name: string; folder: string; content: string }>();
  #str = (c: string | Buffer) => (typeof c === "string" ? c : c.toString("utf8"));
  #seq = 0;
  connected = true;
  createCalls = 0;
  updateCalls = 0;

  status(): DriveStatus {
    return { connected: this.connected, method: "oauth" };
  }
  async ensureFolder(name: string, parentId?: string): Promise<string> {
    for (const [id, f] of this.folders) if (f.name === name && f.parent === parentId) return id;
    const id = `fld-${++this.#seq}`;
    this.folders.set(id, { name, parent: parentId });
    return id;
  }
  async findFile(name: string, folderId: string): Promise<DriveEntry | null> {
    for (const [id, f] of this.files) if (f.name === name && f.folder === folderId) return { id, name };
    return null;
  }
  async putFile(file: DriveFileInput, folderId: string): Promise<{ id: string; link: string }> {
    const existing = await this.findFile(file.name, folderId);
    if (existing) {
      this.updateCalls++;
      this.files.set(existing.id, { name: file.name, folder: folderId, content: this.#str(file.content) });
      return { id: existing.id, link: `link/${existing.id}` };
    }
    this.createCalls++;
    const id = `file-${++this.#seq}`;
    this.files.set(id, { name: file.name, folder: folderId, content: this.#str(file.content) });
    return { id, link: `link/${id}` };
  }
  async readFile(fileId: string): Promise<string> {
    return this.files.get(fileId)?.content ?? "";
  }
  async readFileBinary(fileId: string): Promise<Buffer> {
    return Buffer.from(this.files.get(fileId)?.content ?? "", "utf8");
  }
  async listFolder(folderId: string): Promise<DriveEntry[]> {
    return [...this.files.entries()].filter(([, f]) => f.folder === folderId).map(([id, f]) => ({ id, name: f.name }));
  }
  /** files sitting in the folder named `folderName` */
  filesInType(folderName: string): string[] {
    const folderId = [...this.folders.entries()].find(([, f]) => f.name === folderName)?.[0];
    return [...this.files.values()].filter((f) => f.folder === folderId).map((f) => f.name);
  }
}

function rec(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "sess-2026-07-27_10-00-00-abcd",
    startedAt: "2026-07-27T10:00:00.000Z",
    endedAt: "2026-07-27T10:05:00.000Z",
    mode: "live",
    framework: "meddpicc",
    durationMs: 300000,
    slotDefs: [{ id: "identifyPain", label: "Pain", escalateBy: 25 }],
    slots: { identifyPain: { status: "covered", confidence: 0.9, evidence: ["x"], lastUpdatedTs: 1 } } as unknown as SessionRecord["slots"],
    transcript: [{ speaker: "prospect", text: "we lose 10 hours", tsStart: 0, tsEnd: 5000 }],
    suggestions: [],
    talk: { repMs: 1, prospectMs: 1 },
    ...over,
  };
}

const analysis = (tag: string): CallAnalysis => ({
  wentWell: [tag], didntGoWell: [], improvements: [], followUpEmail: "hi", missedOpportunities: [],
  redFlags: [], budget: "n/a", keyDecisions: [], sentiment: { overall: "neutral", rationale: tag },
});

let fake: FakeDrive;
let db: DriveDb;
beforeEach(() => {
  fake = new FakeDrive();
  db = new DriveDb(fake);
});

describe("DriveDb.storeCall", () => {
  it("writes transcript/summary/session into the by-type folders", async () => {
    await db.storeCall(rec());
    expect(fake.filesInType("Transcripts")).toEqual(["sess-2026-07-27_10-00-00-abcd.transcript.md"]);
    expect(fake.filesInType("Summaries")).toEqual(["sess-2026-07-27_10-00-00-abcd.summary.md"]);
    expect(fake.filesInType("Sessions")).toEqual(["sess-2026-07-27_10-00-00-abcd.json"]);
    // no analysis on the record → no analysis file yet
    expect(fake.filesInType("Analyses")).toEqual([]);
  });

  it("writes an analysis file when the record carries one", async () => {
    await db.storeCall(rec({ analysis: analysis("v1") }));
    expect(fake.filesInType("Analyses")).toEqual(["sess-2026-07-27_10-00-00-abcd.analysis.json"]);
  });

  it("overwrites in place on re-store (no duplicate files)", async () => {
    await db.storeCall(rec());
    const created = fake.createCalls;
    await db.storeCall(rec()); // same id again
    expect(fake.filesInType("Sessions").length).toBe(1);
    expect(fake.updateCalls).toBeGreaterThan(0);
    expect(fake.createCalls).toBe(created); // nothing new created
  });
});

describe("DriveDb read + list", () => {
  it("lists calls with artifact flags", async () => {
    await db.storeCall(rec({ analysis: analysis("v1") }));
    const calls = await db.listCalls();
    expect(calls.length).toBe(1);
    expect(calls[0]!.id).toBe("sess-2026-07-27_10-00-00-abcd");
    expect(calls[0]!.hasTranscript).toBe(true);
    expect(calls[0]!.hasAnalysis).toBe(true);
    expect(calls[0]!.hasRecording).toBe(false);
  });

  it("reads back the stored record and analysis", async () => {
    await db.storeCall(rec({ analysis: analysis("v1"), notes: "call me back" }));
    const back = await db.getRecord("sess-2026-07-27_10-00-00-abcd");
    expect(back?.notes).toBe("call me back");
    const a = await db.getAnalysis("sess-2026-07-27_10-00-00-abcd");
    expect(a?.wentWell).toEqual(["v1"]);
  });

  it("getAnalysis returns null when none stored", async () => {
    await db.storeCall(rec());
    expect(await db.getAnalysis("sess-2026-07-27_10-00-00-abcd")).toBeNull();
  });
});

describe("DriveDb.refreshAnalysis", () => {
  it("re-runs analysis and overwrites the stored file", async () => {
    await db.storeCall(rec({ analysis: analysis("old") }));
    const fresh = await db.refreshAnalysis("sess-2026-07-27_10-00-00-abcd", () => analysis("new"));
    expect(fresh?.wentWell).toEqual(["new"]);
    // the stored analysis.json now reflects the refreshed content
    const stored = await db.getAnalysis("sess-2026-07-27_10-00-00-abcd");
    expect(stored?.wentWell).toEqual(["new"]);
    // still exactly one analysis file
    expect(fake.filesInType("Analyses").length).toBe(1);
  });

  it("returns null when the call is not in Drive", async () => {
    expect(await db.refreshAnalysis("nope", () => analysis("x"))).toBeNull();
  });

  it("accepts an async analyze function", async () => {
    await db.storeCall(rec());
    const fresh = await db.refreshAnalysis("sess-2026-07-27_10-00-00-abcd", async () => analysis("async"));
    expect(fresh?.sentiment.rationale).toBe("async");
  });
});

describe("DriveDb.analyzeRecording", () => {
  const deps = (analysisTag: string) => ({
    transcribe: async () => ({ text: "hello", lines: [{ speaker: "prospect" as const, text: "we lose 10 hours", tsStart: 0, tsEnd: 5000 }] }),
    analyze: () => analysis(analysisTag),
    now: () => "2026-07-27T10:00:00.000Z",
  });

  it("analyzes over an existing record without transcribing", async () => {
    await db.storeCall(rec());
    let transcribeCalled = false;
    const out = await db.analyzeRecording("sess-2026-07-27_10-00-00-abcd", {
      ...deps("fromRecord"),
      transcribe: async () => { transcribeCalled = true; return { text: "", lines: [] }; },
    });
    expect(out?.transcribed).toBe(false);
    expect(transcribeCalled).toBe(false);
    expect(out?.analysis.wentWell).toEqual(["fromRecord"]);
  });

  it("transcribes an audio-only recording, synthesizes a record, and analyzes it", async () => {
    // put only a recording (no session row) — simulate an audio file in Drive
    await db.putRecording("audio-only-1", Buffer.from("fake-webm-bytes"));
    const out = await db.analyzeRecording("audio-only-1", deps("fromAudio"));
    expect(out?.transcribed).toBe(true);
    expect(out?.analysis.wentWell).toEqual(["fromAudio"]);
    // it should now have persisted a transcript, session, and analysis
    expect(fake.filesInType("Transcripts")).toContain("audio-only-1.transcript.md");
    expect(fake.filesInType("Sessions")).toContain("audio-only-1.json");
    expect(fake.filesInType("Analyses")).toContain("audio-only-1.analysis.json");
    // and the audio-only id shows up in the listing
    const ids = (await db.listCalls()).map((c) => c.id);
    expect(ids).toContain("audio-only-1");
  });

  it("returns null when neither a record nor a recording exists", async () => {
    expect(await db.analyzeRecording("ghost", deps("x"))).toBeNull();
  });
});
