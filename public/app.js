// Browser client for Converse — multi-view app + rich in-call overlay.

const $ = (id) => document.getElementById(id);
const nav = $("nav");
const mainEl = $("main");
const overlay = $("overlay");

let ws = null;
let audioStop = null;
let elapsedMs = 0;
let slotDefs = [];
let statusBySlot = {};
let slotsData = {}; // full SlotStates for the inspector
let talk = { repMs: 0, prospectMs: 0 };
let currentSlot = null;
let inspectSlot = null;
let coach = { repWords: 0, questions: 0 };
let objTimer = null;
let cardTimer = null;
let toastTimer = null;
let notesTimer = null;
let lastRecord = null;
let state = { settings: {}, defaults: {}, context: [], drive: { connected: false } };

const api = {
  async get(p) { return (await fetch(p)).json(); },
  async post(p, b) { return (await fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b || {}) })).json(); },
};

// ---------- Theme ----------
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $("theme-toggle").textContent = t === "light" ? "☀" : "☾";
  localStorage.setItem("converse-theme", t);
}
applyTheme(localStorage.getItem("converse-theme") || "dark");
$("theme-toggle").addEventListener("click", () =>
  applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light"));

// ---------- Views ----------
function showView(name) {
  for (const v of document.querySelectorAll(".view")) v.classList.add("hidden");
  $(`view-${name}`).classList.remove("hidden");
  for (const b of document.querySelectorAll(".nav-link")) b.classList.toggle("active", b.dataset.view === name);
  mainEl.scrollTop = 0;
  if (name === "history") loadHistory();
  if (name === "context") renderContext();
  if (name === "settings") fillSettings();
  if (name === "dashboard") loadDashboard();
}
function showApp() { nav.classList.remove("hidden"); mainEl.classList.remove("hidden"); overlay.classList.add("hidden"); }
function showOverlayScreen() { nav.classList.add("hidden"); mainEl.classList.add("hidden"); overlay.classList.remove("hidden"); }

// ---------- Init ----------
async function init() {
  state = await api.get("/api/state");
  renderDrivePill();
  fillSettings();
  await loadHistory(true);
}
function renderDrivePill() {
  const pill = $("drive-pill"); const d = state.drive || {};
  pill.textContent = d.connected ? `Drive: on (${d.method})` : "Drive: local only";
  pill.className = `pill ${d.connected ? "ok" : "off"}`;
  pill.title = d.reason || "";
}

// ---------- WebSocket ----------
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.binaryType = "arraybuffer";
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("Could not reach the copilot server."));
    ws.onmessage = (e) => { if (typeof e.data === "string") handle(JSON.parse(e.data)); };
    ws.onclose = () => { if (audioStop) audioStop(); };
  });
}
function send(o) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); }

function handle(msg) {
  switch (msg.type) {
    case "ready":
      slotDefs = msg.slotDefs; statusBySlot = {}; slotsData = msg.slots || {};
      for (const s of msg.slotDefs) statusBySlot[s.id] = "empty";
      applySlots(msg.slots); buildRail(); $("mode-badge").textContent = msg.mode; showOverlayScreen();
      break;
    case "status": toast(msg.text, msg.level); if (msg.level === "error") setupStatus(msg.text); break;
    case "transcript": onTranscript(msg.event); break;
    case "guidance": onGuidance(msg.event); break;
    case "summary": lastRecord = msg.record; renderSummary(msg.record, { live: true, saved: msg.saved }); break;
    case "drive": renderDriveResult(msg); break;
    case "coaching": toast("🎯 " + msg.signal.message, "warn"); break;
    case "objection": onObjection(msg); break;
    case "export": renderExportResult(msg); break;
    case "ended":
      $("rec").style.animation = "none"; $("rec").style.background = "var(--dim)";
      showApp(); showView("summary");
      // keep the socket open so Drive/Slack export can reach the session
      break;
  }
}

// ---------- Overlay ----------
function buildRail() {
  const rail = $("rail"); rail.innerHTML = "";
  for (const s of slotDefs) {
    const row = document.createElement("div");
    row.className = "slot"; row.id = `slot-${s.id}`;
    row.innerHTML = `<span class="dot"></span><span class="slot-label">${s.label}</span>`;
    row.addEventListener("click", () => openInspector(s.id));
    rail.appendChild(row);
  }
  refreshRail(); updateScore();
}
function applySlots(slots) {
  slotsData = { ...slotsData, ...slots };
  for (const [id, st] of Object.entries(slots)) statusBySlot[id] = st.status;
}
function refreshRail() {
  const nowSec = elapsedMs / 1000;
  let mostOverdue = null, mostOverBy = 0;
  for (const s of slotDefs) {
    const status = statusBySlot[s.id] ?? "empty";
    if (status !== "covered" && s.escalateBy != null) {
      const overBy = nowSec - s.escalateBy;
      if (overBy > 0 && overBy > mostOverBy) { mostOverBy = overBy; mostOverdue = s.id; }
    }
  }
  for (const s of slotDefs) {
    const row = $(`slot-${s.id}`); if (!row) continue;
    const st = statusBySlot[s.id] ?? "empty";
    row.classList.toggle("partial", st === "partial");
    row.classList.toggle("covered", st === "covered");
    row.classList.toggle("overdue", s.id === mostOverdue);
  }
}
function updateScore() {
  const covered = slotDefs.filter((s) => statusBySlot[s.id] === "covered").length;
  $("score").textContent = `${covered}/${slotDefs.length}`;
}
function onTranscript(ev) {
  if (ev.tsEnd > elapsedMs) { elapsedMs = ev.tsEnd; $("timer").textContent = fmt(elapsedMs); refreshRail(); }
  if (!ev.utteranceEnd && ev.text) {
    const who = ev.speaker === "rep" ? "You" : "Prospect";
    const cls = ev.speaker === "rep" ? "who-rep" : "who-prospect";
    $("caption").innerHTML = `<b class="${cls}">${who}:</b> ${escapeHtml(ev.text)}`;
    if (ev.isFinal) {
      const dur = Math.max(0, ev.tsEnd - ev.tsStart);
      talk[ev.speaker === "rep" ? "repMs" : "prospectMs"] += dur;
      if (ev.speaker === "rep") {
        coach.repWords += ev.text.trim().split(/\s+/).filter(Boolean).length;
        if (ev.text.includes("?")) coach.questions++;
        updateCoachStats();
      }
      updateTalkMeter();
      appendTranscript(ev.speaker, ev.text);
    }
  }
}
function appendTranscript(speaker, text) {
  const list = $("tx-list");
  const div = document.createElement("div");
  div.className = `tx-line ${speaker}`;
  div.innerHTML = `<b>${speaker === "rep" ? "You" : "Prospect"}:</b> ${escapeHtml(text)}`;
  list.appendChild(div);
  list.scrollTop = list.scrollHeight;
}
function updateCoachStats() {
  const min = talk.repMs / 60000;
  const wpm = min > 0 ? Math.round(coach.repWords / min) : 0;
  $("coach-stats").textContent = `Q ${coach.questions} · ${wpm} wpm`;
}
function onObjection(msg) {
  $("obj-label").textContent = msg.label;
  $("obj-doc").textContent = msg.doc ? `· ${msg.doc}` : "";
  $("obj-snippet").textContent = msg.snippet || "No matching battlecard — add one in Context.";
  $("obj-card").classList.remove("hidden");
  if (objTimer) clearTimeout(objTimer);
  objTimer = setTimeout(() => $("obj-card").classList.add("hidden"), 30000);
}
function updateTalkMeter() {
  const total = talk.repMs + talk.prospectMs;
  const rep = total ? Math.round((talk.repMs / total) * 100) : 50;
  $("tm-rep").style.width = rep + "%"; $("tm-pro").style.width = (100 - rep) + "%";
  $("tm-label").textContent = total ? `you ${rep}% · them ${100 - rep}%` : "—";
}
function onGuidance(ev) {
  if (ev.type === "slots") { applySlots(ev.slots); refreshRail(); updateScore(); if (inspectSlot) openInspector(inspectSlot); }
  else if (ev.type === "suggestion") showCard(ev);
  else if (ev.type === "suggestion-dropped" && ev.reason !== "latency-exceeded") { /* silent */ }
}
function showCard(ev) {
  currentSlot = ev.slotId;
  const def = slotDefs.find((s) => s.id === ev.slotId);
  $("card-slot").textContent = def ? def.label : ev.slotId;
  $("card-reason").textContent = (ev.reason || "").includes("manual") ? "you asked" : "nudge";
  $("card-q").textContent = ev.question;
  const card = $("card"); card.classList.remove("hidden");
  requestAnimationFrame(() => card.classList.add("show"));
  if (cardTimer) clearTimeout(cardTimer);
  cardTimer = setTimeout(dismissCard, 25000);
}
function dismissCard() {
  const card = $("card"); card.classList.remove("show"); currentSlot = null;
  if (cardTimer) clearTimeout(cardTimer);
  setTimeout(() => card.classList.add("hidden"), 300);
}
function snoozeCurrent() { if (!currentSlot) return; send({ type: "snooze", slot: currentSlot }); toast(`Snoozed ${labelOf(currentSlot)} for 5 min`, "info"); dismissCard(); }

// Slot inspector
function openInspector(id) {
  inspectSlot = id;
  const def = slotDefs.find((s) => s.id === id); const st = slotsData[id] || { status: "empty", confidence: 0, evidence: [] };
  const ev = st.evidence && st.evidence.length ? `“${escapeHtml(st.evidence[st.evidence.length - 1])}”` : "No prospect evidence yet.";
  const box = $("inspector");
  box.innerHTML = `<button class="close" title="close">×</button>
    <h4>${def ? def.label : id}</h4>
    <div class="st">${st.status}${st.confidence ? ` · confidence ${st.confidence.toFixed(2)}` : ""}</div>
    <div class="ev ${st.evidence && st.evidence.length ? "" : "empty"}">${ev}</div>
    <div class="row-actions"><button class="btn" id="ask-now">Ask about this now</button></div>`;
  box.classList.remove("hidden");
  box.querySelector(".close").addEventListener("click", closeInspector);
  box.querySelector("#ask-now").addEventListener("click", () => { send({ type: "ask", slot: id }); toast(`Generating a question for ${def ? def.label : id}…`, "info"); closeInspector(); });
}
function closeInspector() { inspectSlot = null; $("inspector").classList.add("hidden"); }

// Panels
function togglePanel(which) {
  const panel = $(which === "transcript" ? "transcript-panel" : "notes-panel");
  const chip = $(which === "transcript" ? "toggle-transcript" : "toggle-notes");
  const open = panel.classList.toggle("hidden") === false;
  chip.classList.toggle("on", open);
  // avoid overlap: if both open, stack notes below—simplest: close the other
  if (open) {
    const other = which === "transcript" ? "notes-panel" : "transcript-panel";
    const otherChip = which === "transcript" ? "toggle-notes" : "toggle-transcript";
    $(other).classList.add("hidden"); $(otherChip).classList.remove("on");
  }
}

// ---------- Live audio ----------
async function startLiveAudio() {
  const ac = new AudioContext({ sampleRate: 16000 });
  await ac.audioWorklet.addModule("/pcm-worklet.js");
  const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  hookChannel(ac, mic, 0);
  let display = null;
  try { display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }); }
  catch { toast("Screen/tab not shared — only your mic will be transcribed.", "warn"); }
  if (display) {
    if (display.getAudioTracks().length) hookChannel(ac, display, 1);
    else toast('No tab audio captured — reshare and tick "Share tab audio".', "warn");
  }
  audioStop = () => { try { ac.close(); } catch {} mic.getTracks().forEach((t) => t.stop()); if (display) display.getTracks().forEach((t) => t.stop()); audioStop = null; };
}
function hookChannel(ac, stream, channel) {
  const src = ac.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ac, "pcm");
  node.port.onmessage = (e) => {
    const pcm = new Uint8Array(e.data); const frame = new Uint8Array(pcm.length + 1);
    frame[0] = channel; frame.set(pcm, 1);
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(frame.buffer);
  };
  const sink = ac.createGain(); sink.gain.value = 0;
  src.connect(node); node.connect(sink); sink.connect(ac.destination);
}

// ---------- Start / end ----------
async function begin(mode, fixture) {
  const persona = $("home-persona").value.trim();
  if (persona !== (state.settings.persona || "")) state.settings = await api.post("/api/settings", { persona });
  if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  try { await connect(); } catch (err) { setupStatus(err.message); return; }
  if (mode === "live") { try { await startLiveAudio(); } catch { setupStatus("Microphone permission is required for live mode."); if (ws) ws.close(); return; } }
  resetOverlay();
  send({ type: "start", mode, fixture });
}
function endCall() { send({ type: "stop" }); if (audioStop) audioStop(); }
function resetOverlay() {
  elapsedMs = 0; currentSlot = null; talk = { repMs: 0, prospectMs: 0 }; coach = { repWords: 0, questions: 0 };
  $("coach-stats").textContent = ""; $("obj-card").classList.add("hidden");
  $("timer").textContent = "00:00"; $("caption").innerHTML = ""; $("tx-list").innerHTML = ""; $("notes-area").value = "";
  $("rec").style.animation = ""; $("rec").style.background = "var(--green)";
  $("transcript-panel").classList.add("hidden"); $("notes-panel").classList.add("hidden");
  $("toggle-transcript").classList.remove("on"); $("toggle-notes").classList.remove("on");
  updateTalkMeter(); closeInspector(); dismissCard();
}

// ---------- Summary ----------
function renderSummary(rec, opts = {}) {
  const covered = rec.slotDefs.filter((s) => rec.slots[s.id]?.status === "covered").length;
  const talkTotal = (rec.talk?.repMs || 0) + (rec.talk?.prospectMs || 0);
  const repPct = talkTotal ? Math.round((rec.talk.repMs / talkTotal) * 100) : 50;
  $("summary-meta").innerHTML = [
    `<span>${new Date(rec.startedAt).toLocaleString()}</span>`,
    `<span>${fmt(rec.durationMs)}</span>`,
    `<span>${rec.mode}${rec.fixture ? " · " + rec.fixture : ""}</span>`,
    rec.persona ? `<span>persona: ${escapeHtml(rec.persona)}</span>` : "",
    `<span><b>${covered}/${rec.slotDefs.length}</b> covered</span>`,
  ].join("");

  $("summary-talk").innerHTML = talkTotal
    ? `<div class="tm-bar"><i style="width:${repPct}%"></i><b style="width:${100 - repPct}%"></b></div><div class="lbl">Talk ratio — you ${repPct}% · prospect ${100 - repPct}%</div>`
    : "";

  const c = rec.coaching;
  $("summary-coaching").innerHTML = c
    ? [
        coachTile(c.talkRatioRepPct + "%", "you talked", c.talkRatioRepPct > 65),
        coachTile(c.questionsAsked, "questions", c.questionsAsked < 3),
        coachTile(c.repWpm, "your pace (wpm)", c.repWpm > 180),
        coachTile(fmt(c.longestMonologueMs), "longest monologue", c.longestMonologueMs > 75000),
      ].join("")
    : "";

  $("summary-objections").innerHTML = rec.objections && rec.objections.length
    ? `<h3>Objections raised (${rec.objections.length})</h3>` + rec.objections.map((o) =>
        `<div class="obj-row"><span class="when">${fmt(o.ts)}</span><b>${escapeHtml(o.label)}</b>${o.doc ? ` — battlecard: ${escapeHtml(o.doc)}` : ""}</div>`).join("")
    : "";

  $("summary-grid").innerHTML = rec.slotDefs.map((d) => {
    const st = rec.slots[d.id] || { status: "empty", evidence: [] };
    const ev = st.evidence && st.evidence.length ? `“${escapeHtml(st.evidence[st.evidence.length - 1])}”` : "—";
    return `<div class="sum-slot ${st.status}"><div class="top"><span class="dot"></span><span class="name">${d.label}</span><span class="st">${st.status}</span></div><div class="ev">${ev}</div></div>`;
  }).join("");

  const gaps = rec.slotDefs.filter((s) => rec.slots[s.id]?.status !== "covered");
  $("summary-next").innerHTML = gaps.length
    ? `<h3>Follow up next call</h3><div class="chips">${gaps.map((g) => `<span class="gap">${g.label}</span>`).join("")}</div>`
    : `<h3>Follow up next call</h3><div class="meta-dim">Full coverage — nice.</div>`;

  $("summary-notes").innerHTML = rec.notes && rec.notes.trim()
    ? `<h3>Notes</h3><div class="body">${escapeHtml(rec.notes.trim())}</div>` : "";

  $("summary-nudges").innerHTML = rec.suggestions.length
    ? `<h3 style="margin-top:20px">Copilot nudges (${rec.suggestions.length})</h3>` + rec.suggestions.map((s) =>
        `<div class="nudge"><span class="when">${fmt(s.ts)}</span>${escapeHtml(s.question)}</div>`).join("")
    : "";

  $("drive-result").innerHTML = "";
  const dl = (k) => `/api/download?id=${encodeURIComponent(rec.id)}&kind=${k}`;
  $("dl-summary").onclick = () => location.assign(dl("summary"));
  $("dl-transcript").onclick = () => location.assign(dl("transcript"));
  $("export-result").innerHTML = "";
  $("export-drive").style.display = opts.live ? "" : "none";
  $("export-slack").style.display = opts.live ? "" : "none";
  if (!opts.saved && opts.live) toast("Auto-save is off — downloads use the saved record.", "warn");
}
function coachTile(n, l, warn) { return `<div class="coach-tile ${warn ? "warn" : ""}"><div class="n">${n}</div><div class="l">${l}</div></div>`; }
function renderExportResult(msg) {
  $("export-result").innerHTML = msg.ok
    ? `✅ Sent to ${msg.target}.`
    : `<span style="color:var(--amber)">${msg.target} export: ${escapeHtml(msg.error || "failed")}</span>`;
}
function crmText(rec) {
  const lines = [`Discovery call — ${new Date(rec.startedAt).toLocaleString()}`, ""];
  for (const d of rec.slotDefs) {
    const st = rec.slots[d.id] || { status: "empty", evidence: [] };
    const ev = st.evidence && st.evidence.length ? st.evidence[st.evidence.length - 1] : "";
    lines.push(`${d.label} [${st.status}]${ev ? ": " + ev : ""}`);
  }
  if (rec.notes) lines.push("", "Notes: " + rec.notes);
  return lines.join("\n");
}
function emailSummary() {
  if (!lastRecord) return;
  const covered = lastRecord.slotDefs.filter((s) => lastRecord.slots[s.id]?.status === "covered").length;
  const subject = `Discovery call summary — ${covered}/${lastRecord.slotDefs.length} covered`;
  const body = crmText(lastRecord);
  location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
async function copyCrm() {
  if (!lastRecord) return;
  try { await navigator.clipboard.writeText(crmText(lastRecord)); toast("CRM fields copied", "info"); }
  catch { toast("Copy failed", "warn"); }
}
function renderDriveResult(msg) {
  $("drive-result").innerHTML = msg.ok
    ? "✅ Exported to Google Drive: " + msg.files.map((f) => `<a href="${f.link}" target="_blank">${f.name}</a>`).join(" · ")
    : `<span style="color:var(--amber)">Drive export: ${escapeHtml(msg.error || "failed")}</span>`;
}
async function copySummary() {
  if (!lastRecord) return;
  const md = await (await fetch(`/api/download?id=${encodeURIComponent(lastRecord.id)}&kind=summary`)).text();
  try { await navigator.clipboard.writeText(md); toast("Summary copied to clipboard", "info"); }
  catch { toast("Copy failed — use Download instead", "warn"); }
}

// ---------- History ----------
let historyCache = [];
async function loadHistory(homeOnly) {
  const { sessions } = await api.get("/api/history");
  historyCache = sessions;
  const recent = sessions.slice(0, 4);
  $("home-recent").innerHTML = recent.length ? `<div class="meta-dim">Recent sessions</div>` + recent.map(rowHtml).join("") : "";
  bindRows($("home-recent"));
  if (homeOnly) return;
  renderHistoryList(sessions);
}
function renderHistoryList(sessions) {
  $("history-list").innerHTML = sessions.length ? sessions.map(rowHtml).join("") : `<div class="meta-dim">No sessions yet — run a demo or a live call.</div>`;
  bindRows($("history-list"));
}
function rowHtml(s) {
  const pct = Math.round((s.covered / s.total) * 100);
  return `<div class="rec-card" data-id="${s.id}">
    <div class="grow"><div>${new Date(s.startedAt).toLocaleString()}</div>
    <div class="meta-dim">${s.mode} · ${fmt(s.durationMs)} · ${s.suggestions} nudge(s)</div></div>
    <div class="cov-bar"><i style="width:${pct}%"></i></div>
    <div class="cov meta-dim">${s.covered}/${s.total}</div>
    <button class="icon-btn" data-del="${s.id}" title="Delete">✕</button></div>`;
}
function bindRows(container) {
  for (const row of container.querySelectorAll(".rec-card")) {
    row.addEventListener("click", async (e) => {
      if (e.target.closest("[data-del]")) return;
      const rec = await api.get(`/api/session?id=${encodeURIComponent(row.dataset.id)}`);
      if (rec && rec.id) { lastRecord = rec; renderSummary(rec, { live: false, saved: true }); showView("summary"); }
    });
  }
  for (const b of container.querySelectorAll("[data-del]")) {
    b.addEventListener("click", async (e) => {
      e.stopPropagation();
      await api.post("/api/session/delete", { id: b.dataset.del });
      loadHistory();
    });
  }
}
async function downloadBackup() {
  const res = await fetch("/api/export-all");
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "converse-backup.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function purgeAll() {
  const { deleted } = await api.post("/api/purge", {});
  await loadHistory();
  toast(`Deleted ${deleted} call${deleted === 1 ? "" : "s"}.`, "info");
}
$("export-all").addEventListener("click", downloadBackup);
$("wipe-all").addEventListener("click", async () => {
  if (!confirm("Delete ALL saved calls from this machine? This cannot be undone.")) return;
  await purgeAll();
});
$("export-wipe").addEventListener("click", async () => {
  await downloadBackup();
  if (!confirm("Backup downloaded. Now delete all local call data? This cannot be undone.")) return;
  await purgeAll();
});
$("history-search").addEventListener("input", (e) => {
  const q = e.target.value.toLowerCase();
  renderHistoryList(historyCache.filter((s) => (new Date(s.startedAt).toLocaleString() + " " + s.mode).toLowerCase().includes(q)));
});

// ---------- Dashboard ----------
async function loadDashboard() {
  const a = await api.get("/api/analytics");
  const talkTotal = a.totalTalkMs.repMs + a.totalTalkMs.prospectMs;
  const repPct = talkTotal ? Math.round((a.totalTalkMs.repMs / talkTotal) * 100) : 50;
  $("stat-tiles").innerHTML = [
    tile(a.totalCalls, "calls recorded"),
    tile(`<span class="accent">${a.avgCoveragePct}%</span>`, "avg coverage"),
    tile(a.liveCalls, "live calls"),
    tile(a.totalSuggestions, "nudges surfaced"),
  ].join("");
  $("slot-coverage").innerHTML = a.slotCoverage.length
    ? a.slotCoverage.map((s) => `<div class="cov-row"><span>${s.label}</span><span class="track"><i style="width:${s.coveredPct}%"></i></span><span class="pct">${s.coveredPct}%</span></div>`).join("")
    : `<div class="meta-dim">No data yet.</div>`;
  $("trend").innerHTML = sparkline(a.trend.map((t) => t.coveragePct));
  $("dash-talk").innerHTML = talkTotal
    ? `<div class="tm-bar" style="width:100%;height:12px"><i style="width:${repPct}%"></i><b style="width:${100 - repPct}%"></b></div><div class="lg" style="margin-top:6px">you ${repPct}% · prospect ${100 - repPct}%</div>`
    : `<div class="meta-dim">No live-call talk data yet.</div>`;
}
function tile(n, l) { return `<div class="tile"><div class="n">${n}</div><div class="l">${l}</div></div>`; }
function sparkline(vals) {
  if (!vals.length) return `<div class="meta-dim">Not enough calls yet.</div>`;
  const w = 320, h = 64, pad = 6;
  const max = 100, min = 0;
  const pts = vals.map((v, i) => {
    const x = pad + (i * (w - 2 * pad)) / Math.max(1, vals.length - 1);
    const y = h - pad - ((v - min) / (max - min)) * (h - 2 * pad);
    return [x, y];
  });
  const line = pts.map((p) => p.join(",")).join(" ");
  const last = pts[pts.length - 1];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${line}"/><circle cx="${last[0]}" cy="${last[1]}" r="3"/></svg>`;
}

// ---------- Context ----------
function renderContext() {
  const list = $("context-list");
  list.innerHTML = state.context.length
    ? state.context.map((d) => `<div class="card-row"><div class="grow"><b>${escapeHtml(d.name)}</b> <span class="meta-dim">${d.chars} chars</span></div><button class="icon-btn" data-del="${escapeHtml(d.name)}">delete</button></div>`).join("")
    : `<div class="meta-dim">No context docs yet. Add battlecards, product notes, ICP — the copilot grounds questions in them.</div>`;
  for (const b of list.querySelectorAll("[data-del]"))
    b.addEventListener("click", async () => { state = { ...state, ...(await api.post("/api/context/delete", { name: b.dataset.del })) }; renderContext(); });
}

// ---------- Settings ----------
function fillSettings() {
  const s = state.settings || {};
  $("home-persona").value = s.persona || "";
  $("set-persona").value = s.persona || "";
  $("set-speed").value = s.demoSpeed ?? 6;
  $("set-model-classifier").value = s.config?.models?.classifier || "";
  $("set-model-question").value = s.config?.models?.questionGen || "";
  $("set-cooldown").value = s.config?.suggestion?.cooldownSeconds ?? "";
  $("set-drive-folder").value = s.driveFolderId || "";
  $("set-autosave").checked = s.autoSave !== false;
  $("set-usecontext").checked = s.useContext !== false;
  $("set-deepgram-key").value = ""; $("set-anthropic-key").value = "";
  $("dg-set").textContent = s.hasDeepgramKey ? "· saved ✓" : "";
  $("an-set").textContent = s.hasAnthropicKey ? "· saved ✓" : "";
  $("set-classifier-prompt").value = s.classifierPrompt || "";
  $("set-question-prompt").value = s.questionPrompt || "";
  $("set-classifier-prompt").placeholder = state.defaults.classifierPrompt || "";
  $("set-question-prompt").placeholder = state.defaults.questionPrompt || "";
  const fwSel = $("set-framework");
  fwSel.innerHTML = (state.frameworks || [{ id: "meddpicc", name: "MEDDPICC" }])
    .map((f) => `<option value="${f.id}">${f.name}</option>`).join("");
  fwSel.value = s.framework || "meddpicc";
  $("set-slack").value = s.slackWebhookUrl || "";
}
async function saveSettings() {
  const patch = {
    persona: $("set-persona").value.trim(),
    demoSpeed: Number($("set-speed").value) || 6,
    driveFolderId: $("set-drive-folder").value.trim() || undefined,
    autoSave: $("set-autosave").checked,
    useContext: $("set-usecontext").checked,
    classifierPrompt: $("set-classifier-prompt").value.trim(),
    questionPrompt: $("set-question-prompt").value.trim(),
    framework: $("set-framework").value,
    slackWebhookUrl: $("set-slack").value.trim() || undefined,
    config: { models: { classifier: $("set-model-classifier").value.trim() || undefined, questionGen: $("set-model-question").value.trim() || undefined }, suggestion: $("set-cooldown").value ? { cooldownSeconds: Number($("set-cooldown").value) } : undefined },
  };
  const dg = $("set-deepgram-key").value.trim(); const an = $("set-anthropic-key").value.trim();
  if (dg) patch.deepgramApiKey = dg;
  if (an) patch.anthropicApiKey = an;
  if (!patch.config.models.classifier && !patch.config.models.questionGen) delete patch.config.models;
  if (!patch.config.suggestion) delete patch.config.suggestion;
  if (!patch.config.models && !patch.config.suggestion) delete patch.config;
  state.settings = await api.post("/api/settings", patch);
  const note = $("settings-saved"); note.textContent = "Saved ✓"; setTimeout(() => (note.textContent = ""), 2000);
  fillSettings();
}

// ---------- Helpers ----------
function toast(text, level = "info") {
  const t = $("toast"); t.textContent = text; t.className = `toast ${level === "info" ? "" : level}`;
  t.classList.remove("hidden"); if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 4200);
}
function setupStatus(text) { $("setup-status").textContent = text; }
function labelOf(id) { const d = slotDefs.find((s) => s.id === id); return d ? d.label : id; }
function fmt(ms) { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; }
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

// ---------- Wire up ----------
for (const b of document.querySelectorAll(".nav-link")) b.addEventListener("click", () => showView(b.dataset.view));
for (const btn of document.querySelectorAll(".choice")) btn.addEventListener("click", () => begin(btn.dataset.mode, btn.dataset.fixture));
$("stop").addEventListener("click", endCall);
$("card-dismiss").addEventListener("click", dismissCard);
$("card-snooze").addEventListener("click", snoozeCurrent);
$("toggle-transcript").addEventListener("click", () => togglePanel("transcript"));
$("toggle-notes").addEventListener("click", () => togglePanel("notes"));
$("notes-area").addEventListener("input", (e) => {
  if (notesTimer) clearTimeout(notesTimer);
  const text = e.target.value;
  notesTimer = setTimeout(() => send({ type: "note", text }), 400);
});
$("summary-done").addEventListener("click", () => { if (ws && ws.readyState === WebSocket.OPEN) ws.close(); showView("home"); });
$("copy-summary").addEventListener("click", copySummary);
$("copy-crm").addEventListener("click", copyCrm);
$("export-email").addEventListener("click", emailSummary);
$("export-slack").addEventListener("click", () => { send({ type: "export-slack" }); toast("Posting to Slack…", "info"); });
$("obj-dismiss").addEventListener("click", () => $("obj-card").classList.add("hidden"));
$("export-drive").addEventListener("click", () => { send({ type: "export-drive" }); toast("Uploading to Google Drive…", "info"); });
$("settings-save").addEventListener("click", saveSettings);
for (const b of document.querySelectorAll("[data-reset]"))
  b.addEventListener("click", () => { $(b.dataset.reset === "classifier" ? "set-classifier-prompt" : "set-question-prompt").value = ""; });
$("ctx-save").addEventListener("click", async () => {
  const name = $("ctx-name").value.trim(), text = $("ctx-text").value;
  if (!name || !text.trim()) return;
  state = { ...state, ...(await api.post("/api/context/save", { name, text })) };
  $("ctx-name").value = ""; $("ctx-text").value = ""; renderContext();
});
$("ctx-reload").addEventListener("click", async () => { state = { ...state, ...(await api.post("/api/context/reload", {})) }; renderContext(); });
document.addEventListener("keydown", (e) => {
  if (overlay.classList.contains("hidden")) return;
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || "");
  if (e.key === "Escape") { if (inspectSlot) closeInspector(); else if (currentSlot) dismissCard(); else endCall(); return; }
  if (typing) return;
  const k = e.key.toLowerCase();
  if (k === "s") snoozeCurrent();
  else if (k === "t") togglePanel("transcript");
  else if (k === "n") togglePanel("notes");
});

init();
