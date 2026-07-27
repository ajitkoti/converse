/**
 * Local server for the Live Sales Qualification Copilot.
 * - serves the browser app (public/)
 * - one WebSocket per browser → a Session (demo replay or live Deepgram)
 * - a small JSON API for history, settings, context files, and Drive status
 *
 * Run: `npm start`  then open http://localhost:5173
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { FileLogger } from "../engine/logger.js";
import { CLASSIFIER_SYSTEM } from "../engine/prompts/classifier.js";
import { QUESTION_SYSTEM } from "../engine/prompts/question-gen.js";
import { Session, type ServerToClient } from "./session.js";
import { Settings } from "./settings.js";
import { ContextLibrary } from "./context.js";
import { SessionStore } from "./store.js";
import { DriveExporter } from "./gdrive.js";
import { buildSummaryMarkdown, buildTranscriptMarkdown } from "./summary.js";
import type { SlotId } from "../engine/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

loadEnv(path.join(root, ".env"));
const PORT = Number(process.env.PORT ?? 5173);

const publicDir = path.join(root, "public");
const settings = new Settings(path.join(root, "converse.config.json"));
const context = new ContextLibrary(path.join(root, "context"));
const store = new SessionStore(path.join(root, "data"));
const drive = new DriveExporter();

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname.startsWith("/api/")) {
    await handleApi(req, res, url);
    return;
  }
  serveStatic(url.pathname, res);
});

function serveStatic(urlPath: string, res: http.ServerResponse): void {
  const rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath).replace(/^\/+/, "");
  const filePath = path.join(publicDir, rel);
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
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  try {
    const p = url.pathname;

    if (req.method === "GET" && p === "/api/state") {
      return json(200, {
        settings: settings.get(),
        context: context.list(),
        drive: drive.status(),
        defaults: { classifierPrompt: CLASSIFIER_SYSTEM, questionPrompt: QUESTION_SYSTEM },
      });
    }
    if (req.method === "GET" && p === "/api/history") {
      return json(200, { sessions: store.list() });
    }
    if (req.method === "GET" && p === "/api/session") {
      const rec = store.read(url.searchParams.get("id") ?? "");
      return rec ? json(200, rec) : json(404, { error: "not found" });
    }
    if (req.method === "GET" && p === "/api/download") {
      const rec = store.read(url.searchParams.get("id") ?? "");
      if (!rec) return json(404, { error: "not found" });
      const kind = url.searchParams.get("kind") ?? "summary";
      const body =
        kind === "transcript" ? buildTranscriptMarkdown(rec)
        : kind === "json" ? JSON.stringify(rec, null, 2)
        : buildSummaryMarkdown(rec);
      const ext = kind === "json" ? "json" : "md";
      res.writeHead(200, {
        "Content-Type": kind === "json" ? "application/json" : "text/markdown",
        "Content-Disposition": `attachment; filename="${rec.id}.${kind}.${ext}"`,
      });
      return void res.end(body);
    }
    if (req.method === "POST" && p === "/api/settings") {
      const patch = await readJson(req);
      return json(200, settings.update(patch));
    }
    if (req.method === "POST" && p === "/api/context/reload") {
      context.reload();
      return json(200, { context: context.list() });
    }
    if (req.method === "POST" && p === "/api/context/save") {
      const { name, text } = await readJson<{ name: string; text: string }>(req);
      const safe = String(name).replace(/[^a-zA-Z0-9 _-]/g, "").trim() || "note";
      fs.mkdirSync(path.join(root, "context"), { recursive: true });
      fs.writeFileSync(path.join(root, "context", `${safe}.md`), String(text ?? ""));
      context.reload();
      return json(200, { context: context.list() });
    }
    if (req.method === "POST" && p === "/api/context/delete") {
      const { name } = await readJson<{ name: string }>(req);
      const safe = String(name).replace(/[^a-zA-Z0-9 _-]/g, "");
      const f = path.join(root, "context", `${safe}.md`);
      if (f.startsWith(path.join(root, "context")) && fs.existsSync(f)) fs.unlinkSync(f);
      context.reload();
      return json(200, { context: context.list() });
    }
    return json(404, { error: "unknown endpoint" });
  } catch (err) {
    json(500, { error: String(err) });
  }
}

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
    driveRootFolderId: process.env.GDRIVE_FOLDER_ID,
    logger,
    settings,
    context,
    store,
    drive,
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
      case "export-drive":
        void session.exportDrive();
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
  const d = drive.status();
  console.log(`\n  ⚡ Converse copilot → http://localhost:${PORT}\n`);
  console.log(`     Demo mode:  ready (no keys needed)`);
  console.log(`     Live mode:  Deepgram ${hasDg ? "✓" : "✗ (set DEEPGRAM_API_KEY)"} · Claude ${hasClaude ? "✓" : "✗ (offline suggestions)"}`);
  console.log(`     Drive:      ${d.connected ? `✓ (${d.method})` : "✗ (local save only)"}`);
  console.log(`     Context:    ${context.count} doc(s) loaded\n`);
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

function readJson<T = Record<string, unknown>>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        resolve(body ? (JSON.parse(body) as T) : ({} as T));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}
