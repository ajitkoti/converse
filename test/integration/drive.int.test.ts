/**
 * REAL Google Drive integration test — hits the live Drive API via a service
 * account. Skipped unless BOTH of these are set, so it never runs in normal CI:
 *
 *   GOOGLE_APPLICATION_CREDENTIALS = path to a service-account JSON (Drive API on)
 *   GDRIVE_TEST_FOLDER             = a folder id the service account can write to
 *                                    (a folder inside a Shared Drive, ideally)
 *
 * Run it with:  npm run test:int
 * It creates a throwaway root folder under GDRIVE_TEST_FOLDER, exercises the full
 * DriveDb round-trip against real Drive, and deletes the folder afterwards.
 */

import * as fs from "node:fs";
import { describe, it, expect, afterAll } from "vitest";
import { DriveExporter, TOKEN_PATH } from "../../src/server/gdrive.js";
import { DriveDb } from "../../src/server/drive-db.js";
import type { SessionRecord, CallAnalysis } from "../../src/server/types.js";

// Enabled when a target folder is set AND we have creds by either path:
//   - a service account (GOOGLE_APPLICATION_CREDENTIALS) — needs a Shared Drive folder, or
//   - your own OAuth token (GOOGLE_OAUTH_CLIENT + a saved .gdrive-token.json) —
//     works against a personal My Drive folder since the token carries your storage.
const HAS_SERVICE_ACCOUNT = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS);
const HAS_OAUTH = Boolean(process.env.GOOGLE_OAUTH_CLIENT) && fs.existsSync(TOKEN_PATH);
const ENABLED = Boolean(process.env.GDRIVE_TEST_FOLDER) && (HAS_SERVICE_ACCOUNT || HAS_OAUTH);
const PARENT = process.env.GDRIVE_TEST_FOLDER ?? "";
const ROOT_NAME = "Converse IT (safe to delete)";

function sampleRecord(id: string): SessionRecord {
  return {
    id,
    startedAt: "2026-07-27T10:00:00.000Z",
    endedAt: "2026-07-27T10:05:00.000Z",
    mode: "live",
    rep: "IntegrationBot",
    framework: "meddpicc",
    durationMs: 300000,
    slotDefs: [{ id: "identifyPain", label: "Pain", escalateBy: 25 }],
    slots: { identifyPain: { status: "covered", confidence: 0.9, evidence: ["losing 10 hours"], lastUpdatedTs: 1 } } as unknown as SessionRecord["slots"],
    transcript: [{ speaker: "prospect", text: "we lose ten hours a week", tsStart: 0, tsEnd: 5000 }],
    suggestions: [],
    talk: { repMs: 1, prospectMs: 1 },
  };
}
const analysis = (tag: string): CallAnalysis => ({
  wentWell: [tag], didntGoWell: [], improvements: [], followUpEmail: "hi", missedOpportunities: [],
  redFlags: [], budget: "n/a", keyDecisions: [], sentiment: { overall: "neutral", rationale: tag }, generatedBy: "offline",
});

const drive = ENABLED ? new DriveExporter() : null;

afterAll(async () => {
  if (!drive) return;
  try {
    const rootId = await drive.ensureFolder(ROOT_NAME, PARENT); // returns existing id
    await drive.deleteFile(rootId); // cascades to all children
  } catch { /* best effort cleanup */ }
});

describe.skipIf(!ENABLED)("Drive integration (real API)", () => {
  const id = `it-${Date.now()}`;
  const db = () => new DriveDb(drive!, { rootName: ROOT_NAME, parentId: PARENT });

  it("connects with the service account", () => {
    expect(drive!.status().connected).toBe(true);
  });

  it("stores a call and lists it back", async () => {
    await db().storeCall({ ...sampleRecord(id), analysis: analysis("v1") });
    const calls = await db().listCalls();
    const mine = calls.find((c) => c.id === id);
    expect(mine).toBeTruthy();
    expect(mine!.hasTranscript).toBe(true);
    expect(mine!.hasAnalysis).toBe(true);
  }, 30000);

  it("reads back the record and analysis", async () => {
    const rec = await db().getRecord(id);
    expect(rec?.rep).toBe("IntegrationBot");
    const a = await db().getAnalysis(id);
    expect(a?.wentWell).toEqual(["v1"]);
  }, 30000);

  it("refreshes the analysis and overwrites it in Drive", async () => {
    const fresh = await db().refreshAnalysis(id, () => analysis("v2"));
    expect(fresh?.wentWell).toEqual(["v2"]);
    const stored = await db().getAnalysis(id);
    expect(stored?.wentWell).toEqual(["v2"]);
  }, 30000);

  it("uploads and downloads a recording", async () => {
    const bytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]);
    await db().putRecording(id, bytes);
    const back = await db().getRecordingBytes(id);
    expect(back && [...back]).toEqual([...bytes]);
  }, 30000);
});
