import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const engineDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/engine");

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return walk(p);
    return d.name.endsWith(".ts") ? [p] : [];
  });
}

/**
 * PORTABILITY CONTRACT (build plan): the engine must have zero Electron / UI
 * knowledge so it stays portable (server-side later, raven swappable). Enforced
 * here instead of an eslint rule so it runs with the normal test command.
 */
describe("engine portability contract", () => {
  const forbidden = [/from\s+["']electron["']/, /require\(\s*["']electron["']\s*\)/, /from\s+["']react/, /\.\.\/renderer/, /\.\.\/preload/, /\.\.\/main/];

  it("no src/engine file imports Electron, React, or UI layers", () => {
    const offenders: string[] = [];
    for (const file of walk(engineDir)) {
      const src = fs.readFileSync(file, "utf8");
      for (const rx of forbidden) {
        if (rx.test(src)) offenders.push(`${path.basename(file)} matches ${rx}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("only anthropic-client.ts imports an LLM SDK (engine core is SDK-free)", () => {
    const sdkImporters = walk(engineDir).filter((f) =>
      /from\s+["']@anthropic-ai\/sdk["']/.test(fs.readFileSync(f, "utf8")),
    );
    expect(sdkImporters.map((f) => path.basename(f))).toEqual(["anthropic-client.ts"]);
  });
});
