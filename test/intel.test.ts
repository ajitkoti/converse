import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { IntelScout } from "../src/server/intel.js";
import { objectionTree } from "../src/server/objection-tree.js";
import { ContextLibrary } from "../src/server/context.js";

let tmp: string;
let ctx: ContextLibrary;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "converse-intel-"));
  fs.writeFileSync(path.join(tmp, "battlecard-vs-acme.md"), "Acme is slow and pricey. We win on speed and native integrations.");
  fs.writeFileSync(path.join(tmp, "case-study-northwind.md"), "Northwind cut reconciliation time 60% and saw ROI in 8 weeks. A great reference for skeptical buyers.");
  ctx = new ContextLibrary(tmp);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("IntelScout — competitor detection", () => {
  it("recognizes a default competitor and surfaces the battlecard", () => {
    const scout = new IntelScout(ctx);
    const hit = scout.detect("Honestly we already use Workday for this today.");
    expect(hit?.kind).toBe("competitor");
    expect(hit?.label).toContain("Workday");
    expect(hit?.cue.toLowerCase()).toBe("workday");
  });

  it("infers a competitor name from a battlecard filename (vs-acme)", () => {
    const scout = new IntelScout(ctx);
    expect(scout.competitors).toContain("acme");
    const hit = scout.detect("We're pretty happy with Acme right now.");
    expect(hit?.kind).toBe("competitor");
    expect(hit?.doc).toBe("battlecard-vs-acme");
  });

  it("accepts extra competitors from settings", () => {
    const scout = new IntelScout(ctx, ["Contoso"]);
    const hit = scout.detect("Our team piloted Contoso last year.");
    expect(hit?.label).toContain("Contoso");
  });

  it("does not fire on unrelated speech", () => {
    expect(new IntelScout(ctx).detect("We lose ten hours a week to manual work.")).toBeNull();
  });

  it("does not match a competitor substring inside another word", () => {
    // 'sapling' must not match 'sap'
    const scout = new IntelScout(ctx);
    expect(scout.detect("We planted a sapling in the courtyard.")).toBeNull();
  });
});

describe("IntelScout — proof-point detection", () => {
  it("fires on a request for a case study and surfaces a proof doc", () => {
    const scout = new IntelScout(ctx);
    const hit = scout.detect("Do you have a case study or reference I can look at?");
    expect(hit?.kind).toBe("proof-point");
    expect(hit?.doc).toBe("case-study-northwind");
  });

  it("fires on an ROI question", () => {
    const hit = new IntelScout(ctx).detect("What kind of ROI do your customers actually see?");
    expect(hit?.kind).toBe("proof-point");
  });

  it("competitor mention wins over a proof cue in the same sentence", () => {
    const hit = new IntelScout(ctx).detect("We use Workday — any case study on switching?");
    expect(hit?.kind).toBe("competitor");
  });
});

describe("objectionTree", () => {
  it("returns an acknowledge→...→advance flow for a known type", () => {
    const steps = objectionTree("price");
    expect(steps.length).toBeGreaterThanOrEqual(3);
    expect(steps[0]!.label).toBe("Acknowledge");
    expect(steps[steps.length - 1]!.label).toBe("Advance");
    for (const s of steps) expect(s.say.length).toBeGreaterThan(0);
  });

  it("covers every objection type", () => {
    for (const t of ["price", "timing", "competitor", "authority", "trust", "status-quo"] as const) {
      expect(objectionTree(t).length).toBeGreaterThan(0);
    }
  });
});
