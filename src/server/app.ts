/**
 * The server, as a reusable function. `startServer(opts)` wires the static app,
 * the WebSocket session stream, and the JSON API against caller-provided paths.
 * The CLI (index.ts) runs it with repo-relative paths; the Electron wrapper runs
 * it with per-user (userData) paths. Nothing here assumes how it's launched.
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { FileLogger } from "../engine/logger.js";
import { CLASSIFIER_SYSTEM } from "../engine/prompts/classifier.js";
import { QUESTION_SYSTEM } from "../engine/prompts/question-gen.js";
import { Session, type ServerToClient } from "./session.js";
import { Settings, type UserSettings } from "./settings.js";
import { ContextLibrary } from "./context.js";
import { SessionStore } from "./store.js";
import { DriveExporter } from "./gdrive.js";
import { frameworkList } from "./frameworks.js";
import { buildSummaryMarkdown, buildTranscriptMarkdown } from "./summary.js";
import type { SlotId } from "../engine/types.js";

export interface ServerOptions {
  port?: number;
  publicDir: string;
  dataDir: string;
  contextDir: string;
  settingsFile: string;
  logsDir: string;
  /** fallback keys (e.g. from process.env) — Settings values take precedence */
  env?: {
    DEEPGRAM_API_KEY?: string;
    ANTHROPIC_API_KEY?: string;
    DEEPGRAM_MODEL?: string;
    GDRIVE_FOLDER_ID?: string;
  };
}

export interface RunningServer {
  port: number;
  url: string;
  close: () => Promise<void>;
  drive: DriveExporter;
  context: ContextLibrary;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/** Keys must never be sent to the browser — expose only "is it set?" flags. */
function publicSettings(s: UserSettings): Record<string, unknown> {
  const { deepgramApiKey, anthropicApiKey, ...rest } = s;
  return { ...rest, hasDeepgramKey: Boolean(deepgramApiKey), hasAnthropicKey: Boolean(anthropicApiKey) };
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const env = opts.env ?? {};
  fs.mkdirSync(opts.contextDir, { recursive: true });
  fs.mkdirSync(opts.logsDir, { recursive: true });

  const settings = new Settings(opts.settingsFile);
  const context = new ContextLibrary(opts.contextDir);
  const store = new SessionStore(opts.dataDir);
  const drive = new DriveExporter();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) return void (await handleApi(req, res, url));
    serveStatic(url.pathname, res);
  });

  function serveStatic(urlPath: string, res: http.ServerResponse): void {
    const rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath).replace(/^\/+/, "");
    const filePath = path.join(opts.publicDir, rel);
    if (!filePath.startsWith(opts.publicDir)) return void res.writeHead(403).end("forbidden");
    fs.readFile(filePath, (err, data) => {
      if (err) return void res.writeHead(404).end("not found");
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
          settings: publicSettings(settings.get()),
          context: context.list(),
          drive: drive.status(),
          frameworks: frameworkList(),
          defaults: { classifierPrompt: CLASSIFIER_SYSTEM, questionPrompt: QUESTION_SYSTEM },
        });
      }
      if (req.method === "GET" && p === "/api/history") return json(200, { sessions: store.list() });
      if (req.method === "GET" && p === "/api/analytics") return json(200, store.analytics());
      if (req.method === "POST" && p === "/api/session/delete") {
        const { id } = await readJson<{ id: string }>(req);
        return json(200, { deleted: store.delete(String(id)) });
      }
      if (req.method === "GET" && p === "/api/export-all") {
        const body = JSON.stringify(store.allRecords(), null, 2);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="converse-backup.json"`,
        });
        return void res.end(body);
      }
      if (req.method === "POST" && p === "/api/purge") {
        return json(200, { deleted: store.purgeAll() });
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
        res.writeHead(200, {
          "Content-Type": kind === "json" ? "application/json" : "text/markdown",
          "Content-Disposition": `attachment; filename="${rec.id}.${kind}.${kind === "json" ? "json" : "md"}"`,
        });
        return void res.end(body);
      }
      if (req.method === "POST" && p === "/api/settings") {
        settings.update(await readJson(req));
        return json(200, publicSettings(settings.get()));
      }
      if (req.method === "POST" && p === "/api/context/reload") {
        context.reload();
        return json(200, { context: context.list() });
      }
      if (req.method === "POST" && p === "/api/context/save") {
        const { name, text } = await readJson<{ name: string; text: string }>(req);
        const safe = String(name).replace(/[^a-zA-Z0-9 _-]/g, "").trim() || "note";
        fs.writeFileSync(path.join(opts.contextDir, `${safe}.md`), String(text ?? ""));
        context.reload();
        return json(200, { context: context.list() });
      }
      if (req.method === "POST" && p === "/api/context/delete") {
        const { name } = await readJson<{ name: string }>(req);
        const safe = String(name).replace(/[^a-zA-Z0-9 _-]/g, "");
        const f = path.join(opts.contextDir, `${safe}.md`);
        if (f.startsWith(opts.contextDir) && fs.existsSync(f)) fs.unlinkSync(f);
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
    const logger = new FileLogger(path.join(opts.logsDir, `session-${Date.now()}.jsonl`), fs);
    const s = settings.get();
    const session = new Session(send, {
      deepgramApiKey: s.deepgramApiKey || env.DEEPGRAM_API_KEY,
      anthropicApiKey: s.anthropicApiKey || env.ANTHROPIC_API_KEY,
      deepgramModel: env.DEEPGRAM_MODEL,
      driveRootFolderId: s.driveFolderId || env.GDRIVE_FOLDER_ID,
      logger,
      settings,
      context,
      store,
      drive,
    });
    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) return void session.onAudio(data);
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
        case "ask":
          if (typeof msg.slot === "string") session.ask(msg.slot as SlotId);
          break;
        case "note":
          if (typeof msg.text === "string") session.setNotes(msg.text);
          break;
        case "export-drive":
          void session.exportDrive();
          break;
        case "export-slack":
          void session.exportSlack();
          break;
        case "stop":
          session.stop();
          break;
      }
    });
    ws.on("close", () => session.stop());
    ws.on("error", () => session.stop());
  });

  const port = await listen(server, opts.port ?? 5173);
  return {
    port,
    url: `http://localhost:${port}`,
    drive,
    context,
    close: () =>
      new Promise<void>((resolve) => {
        wss.close();
        server.close(() => resolve());
      }),
  };
}

/** Listen on `port`, falling back to the next few if it's taken. */
function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempt = port;
    const tryListen = () => {
      const onError = (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE" && attempt < port + 15) {
          attempt++;
          setImmediate(tryListen);
        } else {
          reject(e);
        }
      };
      server.once("error", onError);
      server.listen(attempt, () => {
        server.removeListener("error", onError);
        resolve(attempt);
      });
    };
    tryListen();
  });
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

/** Minimal .env loader (KEY=VALUE) into process.env — shared by CLI + Electron. */
export function loadEnvFile(file: string): void {
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
