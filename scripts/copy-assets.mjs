// Copy non-TS assets that tsc doesn't emit (JSON imported at runtime) into dist/.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jobs = [
  ["src/engine/config.json", "dist/engine/config.json"],
  ["src/fixtures/good-call.json", "dist/fixtures/good-call.json"],
  ["src/fixtures/bad-call.json", "dist/fixtures/bad-call.json"],
  ["src/fixtures/deepgram-phase1.json", "dist/fixtures/deepgram-phase1.json"],
];
for (const [from, to] of jobs) {
  const dst = path.join(root, to);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(path.join(root, from), dst);
}
console.log(`copied ${jobs.length} asset(s) into dist/`);
