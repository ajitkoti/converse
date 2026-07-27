/**
 * Replay harness — the primary iteration tool (build plan: "read the classifier
 * JSONL log and fix the worst behavior"). Runs a call fixture end-to-end through
 * the engine, prints the guidance stream, and writes a JSONL log to logs/.
 *
 * Usage:
 *   npm run replay                 # good-call fixture, offline keyword classifier
 *   npm run replay -- bad-call     # bad-call fixture
 *   npm run replay -- path/to.json
 *   ANTHROPIC_API_KEY=... npm run replay   # use the real classifier + question gen
 *
 * "10x speed" doesn't change logic — the engine derives time from transcript
 * timestamps — so this runs as fast as possible and just reports.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { QualificationEngine } from "../src/engine/qualification.js";
import { AnthropicLlmClient } from "../src/engine/anthropic-client.js";
import { FileLogger } from "../src/engine/logger.js";
import type { LlmClient } from "../src/engine/llm.js";
import type { GuidanceEvent, TranscriptEvent } from "../src/engine/types.js";
import { FakeLlmClient } from "../test/support/fake-llm.js";
import { loadCallFixture } from "../test/support/fixtures.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

function resolveFixture(arg: string | undefined): string {
  const name = arg ?? "good-call";
  if (name.endsWith(".json")) return path.resolve(name);
  return path.join(root, "src", "fixtures", `${name}.json`);
}

function fmt(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

async function main(): Promise<void> {
  const fixturePath = resolveFixture(process.argv[2]);
  const fixtureName = path.basename(fixturePath, ".json");
  const events = loadCallFixture(JSON.parse(fs.readFileSync(fixturePath, "utf8")));

  const logsDir = path.join(root, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const logPath = path.join(logsDir, `replay-${fixtureName}-${Date.now()}.jsonl`);
  const logger = new FileLogger(logPath, fs);

  const llm: LlmClient = process.env.ANTHROPIC_API_KEY
    ? new AnthropicLlmClient()
    : new FakeLlmClient();
  const mode = process.env.ANTHROPIC_API_KEY ? "real Anthropic" : "offline keyword classifier";

  console.log(`\n▶ replaying ${fixtureName} (${events.length} events) — ${mode}`);
  console.log(`  log → ${path.relative(root, logPath)}\n`);

  const engine = new QualificationEngine({ llm, logger });
  engine.on("guidance", (e: GuidanceEvent) => {
    if (e.type === "suggestion") {
      console.log(`  [${fmt(e.ts)}] 💡 (${e.slotId}, ${e.latencyMs}ms) ${e.question}`);
    } else if (e.type === "suggestion-dropped") {
      console.log(`  [${fmt(e.ts)}] ⨯ dropped ${e.slotId} (${e.reason})`);
    }
  });

  for (const e of events as TranscriptEvent[]) {
    engine.ingest(e);
    await engine.idle();
  }
  engine.flush();
  await engine.idle();

  console.log(`\n  final coverage @ ${fmt(engine.callTimeMs)}:`);
  const slots = engine.getSlots();
  const dot = (s: string) => (s === "covered" ? "🟢" : s === "partial" ? "🟡" : "⚪");
  for (const [id, st] of Object.entries(slots)) {
    const ev = st.evidence[0] ? `  ← "${st.evidence[0].slice(0, 56)}"` : "";
    console.log(`    ${dot(st.status)} ${id.padEnd(16)} ${st.status.padEnd(8)}${ev}`);
  }
  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
