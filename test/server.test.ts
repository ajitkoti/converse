import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "../src/server/settings.js";
import { ContextLibrary } from "../src/server/context.js";
import { SessionStore, makeSessionId } from "../src/server/store.js";
import { buildSummaryMarkdown } from "../src/server/summary.js";
import type { SessionRecord } from "../src/server/types.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "converse-test-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function sampleRecord(): SessionRecord {
  return {
    id: makeSessionId(new Date("2026-07-27T10:00:00Z"), "abcd"),
    startedAt: "2026-07-27T10:00:00.000Z",
    endedAt: "2026-07-27T10:03:00.000Z",
    mode: "demo",
    fixture: "good-call",
    durationMs: 115000,
    slotDefs: [
      { id: "identifyPain", label: "Pain", escalateBy: 900 },
      { id: "metrics", label: "Metrics", escalateBy: 1200 },
    ],
    slots: {
      identifyPain: { status: "covered", confidence: 0.9, evidence: ["losing ten hours a week"], lastUpdatedTs: 14000 },
      metrics: { status: "empty", confidence: 0, evidence: [], lastUpdatedTs: 0 },
    } as unknown as SessionRecord["slots"],
    transcript: [{ speaker: "prospect", text: "losing ten hours a week", tsStart: 6000, tsEnd: 14000 }],
    suggestions: [{ ts: 30000, slotId: "metrics", question: "How many hours a week?", reason: "overdue", latencyMs: 800 }],
  };
}

describe("Settings", () => {
  it("persists, reloads, and normalizes empty prompts to undefined", () => {
    const file = path.join(tmp, "converse.config.json");
    const s = new Settings(file);
    s.update({ persona: "CFO", classifierPrompt: "   " });
    expect(fs.existsSync(file)).toBe(true);
    const reloaded = new Settings(file);
    expect(reloaded.get().persona).toBe("CFO");
    expect(reloaded.get().classifierPrompt).toBeUndefined();
    expect(reloaded.prompts("CTX").persona).toBe("CFO");
    expect(reloaded.prompts("CTX").contextBlock).toBe("CTX");
  });

  it("suppresses context injection when useContext is false", () => {
    const s = new Settings(path.join(tmp, "c.json"));
    s.update({ useContext: false });
    expect(s.prompts("CTX").contextBlock).toBeUndefined();
  });
});

describe("ContextLibrary", () => {
  it("loads .md docs (excluding README) and ranks by relevance", () => {
    fs.writeFileSync(path.join(tmp, "readme.md"), "ignore me");
    fs.writeFileSync(path.join(tmp, "pricing.md"), "annual subscription per entity budget approval");
    fs.writeFileSync(path.join(tmp, "security.md"), "soc2 encryption saml sso audit trail");
    const lib = new ContextLibrary(tmp);
    expect(lib.count).toBe(2);
    const block = lib.contextBlock("we need budget approval and pricing", 5000);
    expect(block).toBeDefined();
    expect(block).toContain("pricing");
    // pricing doc should rank ahead of security given the query overlap
    const secIdx = block!.indexOf("security");
    expect(block!.indexOf("pricing")).toBeLessThan(secIdx === -1 ? Infinity : secIdx);
  });

  it("returns undefined when empty", () => {
    expect(new ContextLibrary(tmp).contextBlock("anything")).toBeUndefined();
  });
});

describe("SessionStore + summary", () => {
  it("saves json + markdown, lists, and reads back", () => {
    const store = new SessionStore(tmp);
    const rec = sampleRecord();
    const paths = store.save(rec);
    expect(fs.existsSync(paths.json)).toBe(true);
    expect(fs.existsSync(paths.summary)).toBe(true);

    const list = store.list();
    expect(list.length).toBe(1);
    expect(list[0]?.covered).toBe(1);
    expect(list[0]?.total).toBe(2);

    const back = store.read(rec.id);
    expect(back?.id).toBe(rec.id);
  });

  it("renders a summary with coverage, evidence, and nudges", () => {
    const md = buildSummaryMarkdown(sampleRecord());
    expect(md).toContain("Pain");
    expect(md).toContain("losing ten hours a week");
    expect(md).toContain("Copilot nudges (1)");
    expect(md).toContain("Still open");
  });

  it("read() rejects path traversal", () => {
    const store = new SessionStore(tmp);
    expect(store.read("../../etc/passwd")).toBeNull();
  });
});
