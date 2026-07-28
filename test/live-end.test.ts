import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Session } from "../src/server/session.js";
import { Settings } from "../src/server/settings.js";
import { ContextLibrary } from "../src/server/context.js";
import { SessionStore } from "../src/server/store.js";
import { DriveExporter } from "../src/server/gdrive.js";
import { DriveDb } from "../src/server/drive-db.js";
import type { DriveClient } from "../src/server/gdrive.js";

// An in-memory DriveClient that reports connected, so DriveDb.storeCall runs.
function fakeDriveClient(): DriveClient & { puts: string[] } {
  const puts: string[] = [];
  return {
    puts,
    status: () => ({ connected: true, method: "oauth" }),
    ensureFolder: async () => "folder",
    findFile: async () => null,
    putFile: async (f) => {
      puts.push(f.name);
      return { id: `id-${f.name}`, link: `https://drive/${f.name}` };
    },
    readFile: async () => "{}",
    readFileBinary: async () => Buffer.from(""),
    listFolder: async () => [],
  };
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "converse-liveend-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("live call end (stop)", () => {
  // Regression: stop() (client "stop" / ws close) is the end of a live call and
  // must persist the record, run the debrief, and sync to Drive — previously it
  // only flushed the engine, so live calls silently produced nothing.
  it("saves the record, runs the debrief, and syncs to Drive on stop()", async () => {
    const client = fakeDriveClient();
    const captured: { type: string; ok?: boolean }[] = [];
    const session = new Session((m: { type: string; ok?: boolean }) => captured.push(m), {
      settings: new Settings(path.join(tmp, "converse.config.json")),
      context: new ContextLibrary(path.join(tmp, "context")),
      store: new SessionStore(path.join(tmp, "data")),
      drive: new DriveExporter(),
      driveDb: new DriveDb(client, {}),
    });

    session.stop();

    // #end() snapshots after a short delay, then runs the async analysis + Drive sync.
    await new Promise((r) => setTimeout(r, 900));

    const types = captured.map((m) => m.type);
    expect(types).toContain("summary"); // record built + saved
    expect(types).toContain("analysis"); // post-call debrief ran
    const drive = captured.find((m) => m.type === "drive");
    expect(drive?.ok).toBe(true); // synced to Drive
    expect(client.puts.length).toBeGreaterThan(0); // files actually written to the DB
  });

  it("runs the end sequence only once even if stop() is called twice", async () => {
    const client = fakeDriveClient();
    const captured: { type: string }[] = [];
    const session = new Session((m: { type: string }) => captured.push(m), {
      settings: new Settings(path.join(tmp, "converse.config.json")),
      context: new ContextLibrary(path.join(tmp, "context")),
      store: new SessionStore(path.join(tmp, "data")),
      drive: new DriveExporter(),
      driveDb: new DriveDb(client, {}),
    });

    session.stop();
    session.stop(); // e.g. client "stop" followed by ws close
    await new Promise((r) => setTimeout(r, 900));

    expect(captured.filter((m) => m.type === "summary").length).toBe(1);
  });
});
