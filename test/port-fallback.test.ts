import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startServer, type RunningServer } from "../src/server/app.js";

let tmp: string;
const servers: RunningServer[] = [];
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "converse-port-"));
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function opts(port: number) {
  return {
    port,
    publicDir: path.join(tmp, "public"),
    dataDir: path.join(tmp, "data"),
    contextDir: path.join(tmp, "context"),
    settingsFile: path.join(tmp, "c.json"),
    logsDir: path.join(tmp, "logs"),
  };
}

describe("port-in-use handling", () => {
  // Regression: the WebSocketServer used to attach to the http server directly and
  // emit an unhandled EADDRINUSE that crashed startup before the port retry ran.
  it("falls back to the next port instead of crashing when the port is taken", { timeout: 20000 }, async () => {
    const a = await startServer(opts(5241));
    servers.push(a);
    expect(a.port).toBe(5241);

    const b = await startServer(opts(5241)); // same port → must retry, not throw
    servers.push(b);
    expect(b.port).toBeGreaterThan(5241);
    expect(b.port).toBeLessThanOrEqual(5241 + 15);
  });
});
