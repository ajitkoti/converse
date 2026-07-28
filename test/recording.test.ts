import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startServer, type RunningServer } from "../src/server/app.js";

let tmp: string;
let server: RunningServer;
let base: string;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "converse-rec-"));
  server = await startServer({
    port: 0,
    publicDir: path.join(tmp, "public"),
    dataDir: path.join(tmp, "data"),
    contextDir: path.join(tmp, "context"),
    settingsFile: path.join(tmp, "converse.config.json"),
    logsDir: path.join(tmp, "logs"),
  });
  base = server.url;
  fs.mkdirSync(path.join(tmp, "public"), { recursive: true });
});
afterEach(async () => {
  await server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// These spin up a real HTTP server and do fetch round-trips, so they can flake
// under heavy CI parallelism (not a logic bug). Retry + a generous timeout make
// them reliable; a genuine regression still fails every retry.
describe("recording upload/download API", { retry: 2 }, () => {
  it("stores a posted recording and serves it back", { timeout: 20000 }, async () => {
    const id = "sess-2026-07-27_10-00-00-abcd";
    const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]); // fake webm header-ish

    const put = await fetch(`${base}/api/recording?id=${id}`, {
      method: "POST",
      headers: { "Content-Type": "audio/webm" },
      body: bytes,
    });
    expect(put.status).toBe(200);
    const body = (await put.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    // it landed on disk
    expect(fs.existsSync(path.join(tmp, "data", "recordings", `${id}.webm`))).toBe(true);

    const get = await fetch(`${base}/api/recording?id=${id}`);
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toContain("audio/webm");
    const back = new Uint8Array(await get.arrayBuffer());
    expect([...back]).toEqual([...bytes]);
  });

  it("rejects an empty upload and 404s an unknown recording", { timeout: 20000 }, async () => {
    const empty = await fetch(`${base}/api/recording?id=abc`, { method: "POST", headers: { "Content-Type": "audio/webm" }, body: new Uint8Array() });
    expect(empty.status).toBe(400);
    const missing = await fetch(`${base}/api/recording?id=does-not-exist`);
    expect(missing.status).toBe(404);
  });

  it("ignores path-traversal ids (sanitized to a safe filename)", { timeout: 20000 }, async () => {
    const res = await fetch(`${base}/api/recording?id=${encodeURIComponent("../../evil")}`, {
      method: "POST",
      headers: { "Content-Type": "audio/webm" },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(res.status).toBe(200);
    // nothing escaped the recordings dir
    expect(fs.existsSync(path.join(tmp, "data", "evil.webm"))).toBe(false);
    expect(fs.existsSync(path.join(tmp, "evil.webm"))).toBe(false);
  });
});
