// End-to-end UI test: drives the real browser against a running server through a
// full demo call and every major view. Live audio isn't exercised (no hardware),
// but demo mode covers the entire UI + WebSocket + engine + persistence path.
//
// Usage: start the server (npm start), then: node test/e2e/ui.mjs
// Env: BASE_URL (default http://localhost:5173), SHOTS (screenshot dir).

import { chromium } from "playwright";
import * as fs from "node:fs";
import * as path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:5173";
const SHOTS = process.env.SHOTS || "/tmp/converse-e2e";
const EXEC = process.env.CHROMIUM || "/opt/pw-browsers/chromium";
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (name, cond, detail = "") => {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "✓" : "✗"} ${name}${detail ? "  — " + detail : ""}`);
};

const browser = await chromium.launch({ executablePath: EXEC, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
// Don't auto-launch the first-run tour during the main flow (it's a modal).
await page.addInitScript(() => localStorage.setItem("converse-tour-done", "1"));
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(String(e)));

try {
  // 1. Home loads
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("#view-home .choice");
  check("home renders with demo choices", await page.locator(".choice").count() >= 3);
  await page.screenshot({ path: path.join(SHOTS, "1-home.png") });

  // 2. Settings — framework selector present; speed up the demo
  await page.click('.nav-link[data-view="settings"]');
  await page.waitForFunction(() => document.querySelectorAll("#set-framework option").length >= 3);
  const fwOpts = await page.locator("#set-framework option").count();
  check("framework selector populated (MEDDPICC/BANT/SPICED)", fwOpts >= 3, `${fwOpts} options`);
  check("AI provider selector present (Anthropic + OpenAI)", (await page.locator("#set-provider option").count()) === 2);
  check("OpenAI key field + Drive connect button present", (await page.locator("#set-openai-key, #drive-connect").count()) === 2);
  check("per-field ? help popovers present", (await page.locator(".settings-grid .qm").count()) >= 10);
  await page.fill("#set-speed", "20");
  await page.click("#settings-save");
  await page.waitForFunction(() => document.getElementById("settings-saved")?.textContent?.includes("Saved"));
  check("settings save works", true);

  // 3. Start a demo call
  await page.click('.nav-link[data-view="home"]');
  await page.click('.choice[data-fixture="good-call"]');
  await page.waitForSelector("#overlay:not(.hidden)", { timeout: 10000 });
  check("overlay opens on demo start", true);
  await page.waitForSelector("#rail .slot");
  check("slot rail rendered (8 dots)", await page.locator("#rail .slot").count() === 8);

  // 4. Timer advances + a slot goes green during the call
  await page.waitForFunction(() => document.getElementById("timer")?.textContent !== "00:00", { timeout: 15000 });
  check("call timer advances", true);
  await page.waitForFunction(() => /wpm/.test(document.getElementById("coach-stats")?.textContent || ""), { timeout: 20000 });
  check("live coaching stats (questions + wpm) show", true);
  await page.waitForFunction(() => /clf|nudge/.test(document.getElementById("perf")?.textContent || ""), { timeout: 20000 });
  check("live perf HUD (classifier/nudge latency) shows", true);
  await page.waitForFunction(() => document.querySelector("#rail .slot.covered"), { timeout: 25000 });
  check("a slot turns green (covered) live", true);

  // 5. Slot inspector + Ask now
  await page.click("#rail .slot");
  await page.waitForSelector("#inspector:not(.hidden)");
  check("slot inspector opens on click", await page.locator("#inspector h4").count() === 1);
  await page.click("#ask-now");
  check("Ask-now button clickable", true);

  // 6. Transcript + notes panels
  await page.click("#toggle-transcript");
  await page.waitForSelector("#transcript-panel:not(.hidden)");
  check("transcript panel toggles + has lines", await page.locator("#tx-list .tx-line").count() > 0);
  await page.click("#toggle-notes");
  await page.fill("#notes-area", "E2E note: check SOC2 timeline.");
  check("notes panel accepts input", (await page.inputValue("#notes-area")).includes("SOC2"));
  await page.screenshot({ path: path.join(SHOTS, "2-overlay.png") });

  // 7. Let the call finish → summary
  await page.waitForSelector("#view-summary:not(.hidden)", { timeout: 40000 });
  check("summary view appears after call", true);
  const covered = await page.locator("#summary-grid .sum-slot.covered").count();
  check("summary shows covered slots", covered > 0, `${covered} covered`);
  check("summary shows talk ratio", (await page.locator("#summary-talk .tm-bar").count()) === 1);
  check("summary shows notes", (await page.textContent("#summary-notes"))?.includes("SOC2"));
  check("summary shows coaching tiles", (await page.locator("#summary-coaching .coach-tile").count()) >= 3);
  check("summary shows perf latency tiles", (await page.textContent("#summary-coaching"))?.includes("latency"));
  check("summary has export buttons (Slack/Email/CRM)", (await page.locator("#export-slack, #export-email, #copy-crm").count()) === 3);
  // AI deal debrief lands shortly after the summary (heuristic in demo mode)
  await page.waitForFunction(() => document.querySelector("#summary-analysis .ai-debrief:not(.pending)"), null, { timeout: 15000 });
  check("post-call AI debrief renders", (await page.locator("#summary-analysis .ai-debrief").count()) === 1);
  check("AI debrief has went-well/red-flag columns", (await page.locator("#summary-analysis .ai-col").count()) >= 2);
  check("AI debrief has a follow-up email", (await page.locator("#summary-analysis .ai-email pre").count()) === 1);
  check("AI debrief shows a sentiment badge", (await page.locator("#summary-analysis .ai-sentiment").count()) === 1);
  // good-call names Workday / NetSuite, so competitive intel should have fired
  check("summary shows in-call intelligence", (await page.locator("#summary-intel .intel-row").count()) >= 1);
  await page.screenshot({ path: path.join(SHOTS, "3-summary.png") });

  // 8. Dashboard
  await page.click('.nav-link[data-view="dashboard"]');
  await page.waitForSelector("#stat-tiles .tile");
  const calls = await page.locator("#stat-tiles .tile .n").first().textContent();
  check("dashboard tiles populated", Number(calls) >= 1, `${calls} calls`);
  check("dashboard slot-coverage bars", await page.locator("#slot-coverage .cov-row").count() > 0);
  check("dashboard has an LLM-calls tile", (await page.textContent("#stat-tiles"))?.includes("LLM calls"));
  await page.screenshot({ path: path.join(SHOTS, "4-dashboard.png") });

  // 9. History + search + reopen
  await page.click('.nav-link[data-view="history"]');
  await page.waitForSelector("#history-list .rec-card");
  check("history lists the call", await page.locator("#history-list .rec-card").count() >= 1);
  await page.fill("#history-search", "demo");
  check("history search filters", await page.locator("#history-list .rec-card").count() >= 1);

  // 10. Help view
  await page.click('.nav-link[data-view="help"]');
  await page.waitForSelector("#view-help:not(.hidden) .help-card");
  check("help view has how-to sections", (await page.locator("#view-help .help-card").count()) >= 8);

  // guided tour launches and dismisses
  await page.click("#replay-tour");
  await page.waitForSelector("#tour:not(.hidden)");
  check("guided tour launches", (await page.textContent("#tp-title"))?.length > 0);
  await page.click("#tp-next"); // advance a step
  await page.click("#tp-skip");
  await page.waitForFunction(() => document.getElementById("tour").classList.contains("hidden"));
  check("guided tour advances and dismisses", true);
  await page.click('.nav-link[data-view="help"]'); // tour returned us to home; go back for the theme step

  // 11. Theme toggle
  await page.click("#theme-toggle");
  check("theme toggles to light", (await page.getAttribute("html", "data-theme")) === "light");
  await page.click("#theme-toggle");
  check("theme toggles back to dark", (await page.getAttribute("html", "data-theme")) === "dark");

  check("no console/page errors", consoleErrors.length === 0, consoleErrors.slice(0, 2).join(" | "));
} catch (err) {
  check("run completed without exception", false, String(err).split("\n")[0]);
  await page.screenshot({ path: path.join(SHOTS, "error.png") }).catch(() => {});
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots in ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
