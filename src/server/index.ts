/**
 * CLI entry point. Runs the server with repo-relative paths.
 * Run: `npm start`  then open http://localhost:5173
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, loadEnvFile } from "./app.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

loadEnvFile(path.join(root, ".env"));

const running = await startServer({
  port: Number(process.env.PORT ?? 5173),
  publicDir: path.join(root, "public"),
  dataDir: path.join(root, "data"),
  contextDir: path.join(root, "context"),
  settingsFile: path.join(root, "converse.config.json"),
  logsDir: path.join(root, "logs"),
  env: {
    DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    DEEPGRAM_MODEL: process.env.DEEPGRAM_MODEL,
    GDRIVE_FOLDER_ID: process.env.GDRIVE_FOLDER_ID,
  },
});

const d = running.drive.status();
console.log(`\n  ⚡ Converse copilot → ${running.url}\n`);
console.log(`     Demo mode:  ready (no keys needed)`);
console.log(`     Live mode:  Deepgram ${process.env.DEEPGRAM_API_KEY ? "✓" : "✗ (set in Settings or .env)"} · Claude ${process.env.ANTHROPIC_API_KEY ? "✓" : "✗ (offline suggestions)"}`);
console.log(`     Drive:      ${d.connected ? `✓ (${d.method})` : "✗ (local save only)"}`);
console.log(`     Context:    ${running.context.count} doc(s) loaded\n`);
