/**
 * Context library. Drop Markdown files into context/ (battlecards, product
 * one-pagers, ICP, objection handling, pricing). They're loaded here and woven
 * into question generation so the copilot's suggestions are grounded in YOUR
 * product and playbook — not generic.
 *
 * v1 selection is deliberately simple (no vector DB): include whole docs up to a
 * character budget, most-relevant first. Relevance = keyword overlap between the
 * recent transcript window and each doc, so the battlecard that matches what's
 * being discussed floats to the top. Good enough and fully offline; a real RAG
 * index is a drop-in replacement behind contextBlock().
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface ContextDoc {
  name: string;
  text: string;
}

const DEFAULT_BUDGET = 2400; // chars injected into the prompt

export class ContextLibrary {
  #dir: string;
  #docs: ContextDoc[] = [];

  constructor(dir: string) {
    this.#dir = dir;
    this.reload();
  }

  reload(): ContextDoc[] {
    this.#docs = [];
    if (fs.existsSync(this.#dir)) {
      for (const f of fs.readdirSync(this.#dir).sort()) {
        if (!f.endsWith(".md") || f.toLowerCase() === "readme.md") continue;
        const text = fs.readFileSync(path.join(this.#dir, f), "utf8").trim();
        if (text) this.#docs.push({ name: f.replace(/\.md$/, ""), text });
      }
    }
    return this.#docs;
  }

  list(): Array<{ name: string; chars: number }> {
    return this.#docs.map((d) => ({ name: d.name, chars: d.text.length }));
  }

  /** Full text of one doc by name, or null if it isn't in the library. */
  get(name: string): string | null {
    return this.#docs.find((d) => d.name === name)?.text ?? null;
  }

  get count(): number {
    return this.#docs.length;
  }

  /** The single most relevant doc for a query, with a short snippet. */
  bestMatch(query: string, snippetChars = 320): { name: string; snippet: string } | null {
    if (!this.#docs.length) return null;
    const terms = tokenize(query);
    let best: ContextDoc | null = null;
    let bestScore = 0;
    for (const d of this.#docs) {
      const score = overlap(terms, tokenize(d.text));
      if (score > bestScore) {
        bestScore = score;
        best = d;
      }
    }
    if (!best || bestScore === 0) return null;
    return { name: best.name, snippet: best.text.slice(0, snippetChars).trim() };
  }

  /** Build the context block to inject, ranked by relevance to the window. */
  contextBlock(windowText: string, budget = DEFAULT_BUDGET): string | undefined {
    if (!this.#docs.length) return undefined;
    const terms = tokenize(windowText);
    const ranked = this.#docs
      .map((d) => ({ d, score: overlap(terms, tokenize(d.text)) }))
      .sort((a, b) => b.score - a.score);

    const parts: string[] = [];
    let used = 0;
    for (const { d } of ranked) {
      if (used >= budget) break;
      const slice = d.text.slice(0, Math.max(0, budget - used));
      parts.push(`### ${d.name}\n${slice}`);
      used += slice.length + d.name.length + 5;
    }
    return parts.join("\n\n");
  }
}

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n++;
  return n;
}
