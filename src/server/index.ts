/**
 * Local server for the Live Sales Qualification Copilot.
 * - serves the browser overlay (public/)
 * - one WebSocket per browser → a Session (demo replay or live Deepgram)
 *
 * Run: `npm start`  then open http://localhost:5173
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { FileLogger } from "../engine/logger.js";
import { Session, type ServerToClient } from "./session.js";
import type { SlotId } from "../engine/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

loadEnv(path.join(root, ".env"));
const PORT = Number(process.env.PORT ?? 5173);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const publicDir = path.join(root, "public");

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]!);
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const filePath = path.join(publicDir, rel);
  // prevent path traversal
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] ?? "application/octet-stream" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws: WebSocket) => {
  const send = (msg: ServerToClient) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  fs.mkdirSync(path.join(root, "logs"), { recursive: true });
  const logger = new FileLogger(path.join(root, "logs", `session-${Date.now()}.jsonl`), fs);

  const session = new Session(send, {
    deepgramApiKey: process.env.DEEPGRAM_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    deepgramModel: process.env.DEEPGRAM_MODEL,
    logger,
  });

  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (isBinary) {
      session.onAudio(data);
      return;
    }
    let msg: { type?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    switch (msg.type) {
      case "start":
        session.start({
          mode: msg.mode === "live" ? "live" : "demo",
          fixture: typeof msg.fixture === "string" ? msg.fixture : undefined,
          speed: typeof msg.speed === "number" ? msg.speed : undefined,
        });
        break;
      case "snooze":
        if (typeof msg.slot === "string") session.snooze(msg.slot as SlotId);
        break;
      case "stop":
        session.stop();
        break;
    }
  });

  ws.on("close", () => session.stop());
  ws.on("error", () => session.stop());
});

server.listen(PORT, () => {
  const hasDg = Boolean(process.env.DEEPGRAM_API_KEY);
  const hasClaude = Boolean(process.env.ANTHROPIC_API_KEY);
  console.log(`\n  ⚡ Converse copilot → http://localhost:${PORT}\n`);
  console.log(`     Demo mode:  ready (no keys needed)`);
  console.log(`     Live mode:  Deepgram ${hasDg ? "✓" : "✗ (set DEEPGRAM_API_KEY)"} · Claude ${hasClaude ? "✓" : "✗ (offline suggestions)"}\n`);
});

/** Minimal .env loader (KEY=VALUE lines), no dependency. */
function loadEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let val = m[2]!.trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
