import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore, makeSessionId } from "../src/server/store.js";
import { Settings } from "../src/server/settings.js";
import { buildPreCallBrief } from "../src/server/precall.js";
import type { SessionRecord } from "../src/server/types.js";

let tmp: string;
let store: SessionStore;
let settings: Settings;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "converse-demoexcl-"));
  store = new SessionStore(tmp);
  settings = new Settings(path.join(tmp, "c.json"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function rec(over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: makeSessionId(new Date("2026-07-20T10:00:00Z"), Math.random().toString(36).slice(2, 6)),
    startedAt: "2026-07-20T10:00:00.000Z",
    endedAt: "2026-07-20T10:05:00.000Z",
    mode: "live",
    persona: "CFO at Northwind",
    framework: "meddpicc",
    durationMs: 300000,
    slotDefs: [{ id: "identifyPain", label: "Pain", escalateBy: 25 }],
    slots: {
      identifyPain: { status: "covered", confidence: 0.9, evidence: ["losing 10 hours a week"], lastUpdatedTs: 1 },
    } as unknown as SessionRecord["slots"],
    transcript: [],
    suggestions: [],
    talk: { repMs: 1, prospectMs: 1 },
    objections: [],
    intel: [{ ts: 2000, kind: "competitor", label: "Competitor: Workday" }],
    ...over,
  };
}

describe("demo calls are excluded from all real-data surfaces", () => {
  it("store.list()/allRecords()/analytics ignore demo records", () => {
    store.save(rec({ mode: "demo", id: "sess-demo-a" }));
    store.save(rec({ mode: "live", id: "sess-live-b" }));

    expect(store.list().map((s) => s.id)).toEqual(["sess-live-b"]);
    expect(store.allRecords().map((r) => r.id)).toEqual(["sess-live-b"]);
    const a = store.analytics();
    expect(a.totalCalls).toBe(1);
    expect(a.liveCalls).toBe(1);
  });

  it("a demo call never becomes the pre-call brief's 'last call'", () => {
    // Only a demo on record → brief must report no prior call, not the demo's data.
    store.save(rec({ mode: "demo", intel: [{ ts: 1, kind: "competitor", label: "Competitor: Workday" }] }));
    const b = buildPreCallBrief(store, settings, { persona: "Arhan Koti" });
    expect(b.lastCall).toBeNull();
  });
});

describe("pre-call brief is scoped to the persona", () => {
  it("does not present an unrelated real call as this deal's last call", () => {
    store.save(rec({ mode: "live", persona: "CFO at Northwind", notes: "northwind" }));
    // Different prospect → no match → no last-call recap (never invent a relationship).
    const b = buildPreCallBrief(store, settings, { persona: "Arhan Koti", account: "Acme" });
    expect(b.lastCall).toBeNull();
  });

  it("uses a matching call when the persona lines up", () => {
    store.save(rec({ mode: "live", persona: "CFO at Northwind", notes: "northwind deal" }));
    const b = buildPreCallBrief(store, settings, { persona: "Northwind" });
    expect(b.lastCall).not.toBeNull();
  });
});
