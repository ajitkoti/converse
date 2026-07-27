// Browser client for Converse. Multi-view app (home / history / context /
// settings / summary) + the full-screen in-call overlay. Talks to the local
// server over a JSON API (state/history/context/settings) and a WebSocket
// (live session stream). Live mode captures mic + shared tab audio.

const $ = (id) => document.getElementById(id);
const nav = $("nav");
const mainEl = $("main");
const overlay = $("overlay");

let ws = null;
let audioStop = null;
let elapsedMs = 0;
let slotDefs = [];
let statusBySlot = {};
let currentSlot = null;
let cardTimer = null;
let toastTimer = null;
let lastRecord = null;
let state = { settings: {}, defaults: {}, context: [], drive: { connected: false } };

const api = {
  async get(path) { const r = await fetch(path); return r.json(); },
  async post(path, body) {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    return r.json();
  },
};

// ---------- Views ----------
function showView(name) {
  for (const v of document.querySelectorAll(".view")) v.classList.add("hidden");
  $(`view-${name}`).classList.remove("hidden");
  for (const b of document.querySelectorAll(".nav-link")) b.classList.toggle("active", b.dataset.view === name);
  mainEl.scrollTop = 0;
  if (name === "history") loadHistory();
  if (name === "context") renderContext();
  if (name === "settings") fillSettings();
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
  const pill = $("drive-pill");
  const d = state.drive || {};
  pill.textContent = d.connected ? `Drive: on (${d.method})` : "Drive: local only";
  pill.className = `pill ${d.connected ? "ok" : "off"}`;
  pill.title = d.reason || "";
}

// ---------- WebSocket / session ----------
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
function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

function handle(msg) {
  switch (msg.type) {
    case "ready":
      slotDefs = msg.slotDefs; statusBySlot = {};
      for (const s of msg.slotDefs) statusBySlot[s.id] = "empty";
      applySlots(msg.slots); buildRail(); $("mode-badge").textContent = msg.mode; showOverlayScreen();
      break;
    case "status": toast(msg.text, msg.level); if (msg.level === "error") setupStatus(msg.text); break;
    case "transcript": onTranscript(msg.event); break;
    case "guidance": onGuidance(msg.event); break;
    case "summary": lastRecord = msg.record; renderSummary(msg.record, { live: true, saved: msg.saved }); break;
    case "drive": renderDriveResult(msg); break;
    case "ended":
      $("rec").style.animation = "none"; $("rec").style.background = "var(--dim)";
      showApp(); showView("summary");
      if (ws) ws.close();
      break;
  }
}

// ---------- Overlay rendering ----------
function buildRail() {
  const rail = $("rail"); rail.innerHTML = "";
  for (const s of slotDefs) {
    const row = document.createElement("div");
    row.className = "slot"; row.id = `slot-${s.id}`;
    row.innerHTML = `<span class="dot"></span><span class="slot-label">${s.label}</span>`;
    rail.appendChild(row);
  }
  refreshRail();
}
function applySlots(slots) { for (const [id, st] of Object.entries(slots)) statusBySlot[id] = st.status; }
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
    const status = statusBySlot[s.id] ?? "empty";
    row.classList.toggle("partial", status === "partial");
    row.classList.toggle("covered", status === "covered");
    row.classList.toggle("overdue", s.id === mostOverdue);
  }
}
function onTranscript(ev) {
  if (ev.tsEnd > elapsedMs) { elapsedMs = ev.tsEnd; $("timer").textContent = fmt(elapsedMs); refreshRail(); }
  if (!ev.utteranceEnd && ev.text) {
    const who = ev.speaker === "rep" ? "You" : "Prospect";
    const cls = ev.speaker === "rep" ? "who-rep" : "who-prospect";
    $("caption").innerHTML = `<b class="${cls}">${who}:</b> ${escapeHtml(ev.text)}`;
  }
}
function onGuidance(ev) {
  if (ev.type === "slots") { applySlots(ev.slots); refreshRail(); }
  else if (ev.type === "suggestion") showCard(ev);
}
function showCard(ev) {
  currentSlot = ev.slotId;
  const def = slotDefs.find((s) => s.id === ev.slotId);
  $("card-slot").textContent = def ? def.label : ev.slotId;
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
function snoozeCurrent() {
  if (!currentSlot) return;
  send({ type: "snooze", slot: currentSlot });
  toast(`Snoozed ${labelOf(currentSlot)} for 5 min`, "info");
  dismissCard();
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
  audioStop = () => {
    try { ac.close(); } catch {}
    mic.getTracks().forEach((t) => t.stop());
    if (display) display.getTracks().forEach((t) => t.stop());
    audioStop = null;
  };
}
function hookChannel(ac, stream, channel) {
  const src = ac.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ac, "pcm");
  node.port.onmessage = (e) => {
    const pcm = new Uint8Array(e.data);
    const frame = new Uint8Array(pcm.length + 1);
    frame[0] = channel; frame.set(pcm, 1);
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(frame.buffer);
  };
  const sink = ac.createGain(); sink.gain.value = 0;
  src.connect(node); node.connect(sink); sink.connect(ac.destination);
}

// ---------- Start / end ----------
async function begin(mode, fixture) {
  const persona = $("home-persona").value.trim();
  if (persona !== (state.settings.persona || "")) {
    state.settings = await api.post("/api/settings", { persona });
  }
  try { await connect(); } catch (err) { setupStatus(err.message); return; }
  if (mode === "live") {
    try { await startLiveAudio(); }
    catch { setupStatus("Microphone permission is required for live mode."); if (ws) ws.close(); return; }
  }
  resetOverlay();
  send({ type: "start", mode, fixture });
}
function endCall() {
  send({ type: "stop" });
  if (audioStop) audioStop();
}
function resetOverlay() {
  elapsedMs = 0; currentSlot = null;
  $("timer").textContent = "00:00"; $("caption").innerHTML = "";
  $("rec").style.animation = ""; $("rec").style.background = "var(--green)";
  dismissCard();
}

// ---------- Summary ----------
function renderSummary(rec, opts = {}) {
  const covered = rec.slotDefs.filter((s) => rec.slots[s.id]?.status === "covered").length;
  $("summary-meta").innerHTML = [
    `<span>${new Date(rec.startedAt).toLocaleString()}</span>`,
    `<span>${fmt(rec.durationMs)}</span>`,
    `<span>${rec.mode}${rec.fixture ? " · " + rec.fixture : ""}</span>`,
    rec.persona ? `<span>persona: ${escapeHtml(rec.persona)}</span>` : "",
    `<span><b>${covered}/${rec.slotDefs.length}</b> covered</span>`,
  ].join("");

  $("summary-grid").innerHTML = rec.slotDefs.map((d) => {
    const st = rec.slots[d.id] || { status: "empty", evidence: [] };
    const ev = st.evidence && st.evidence.length ? `“${escapeHtml(st.evidence[st.evidence.length - 1])}”` : "—";
    return `<div class="sum-slot ${st.status}"><div class="top"><span class="dot"></span><span class="name">${d.label}</span><span class="st">${st.status}</span></div><div class="ev">${ev}</div></div>`;
  }).join("");

  $("summary-nudges").innerHTML = rec.suggestions.length
    ? `<h3>Copilot nudges (${rec.suggestions.length})</h3>` + rec.suggestions.map((s) =>
        `<div class="nudge"><span class="when">${fmt(s.ts)}</span>${escapeHtml(s.question)}</div>`).join("")
    : "";

  $("drive-result").innerHTML = "";
  const dl = (kind) => `/api/download?id=${encodeURIComponent(rec.id)}&kind=${kind}`;
  $("dl-summary").onclick = () => location.assign(dl("summary"));
  $("dl-transcript").onclick = () => location.assign(dl("transcript"));
  const exportBtn = $("export-drive");
  exportBtn.style.display = opts.live ? "" : "none"; // drive export only for the just-finished call
  if (!opts.saved && opts.live) toast("Auto-save is off — downloads use the in-memory record.", "warn");
}
function renderDriveResult(msg) {
  const el = $("drive-result");
  if (msg.ok) {
    el.innerHTML = "✅ Exported to Google Drive: " + msg.files.map((f) => `<a href="${f.link}" target="_blank">${f.name}</a>`).join(" · ");
  } else {
    el.innerHTML = `<span style="color:var(--amber)">Drive export: ${escapeHtml(msg.error || "failed")}</span>`;
  }
}

// ---------- History ----------
async function loadHistory(homeOnly) {
  const { sessions } = await api.get("/api/history");
  const recent = sessions.slice(0, 4);
  $("home-recent").innerHTML = recent.length
    ? `<div class="meta-dim">Recent sessions</div>` + recent.map(rowHtml).join("")
    : "";
  bindRows($("home-recent"));
  if (homeOnly) return;
  $("history-list").innerHTML = sessions.length ? sessions.map(rowHtml).join("") : `<div class="meta-dim">No sessions yet — run a demo or a live call.</div>`;
  bindRows($("history-list"));
}
function rowHtml(s) {
  const pct = Math.round((s.covered / s.total) * 100);
  return `<div class="rec-card" data-id="${s.id}">
    <div class="grow"><div>${new Date(s.startedAt).toLocaleString()}</div>
    <div class="meta-dim">${s.mode} · ${fmt(s.durationMs)} · ${s.suggestions} nudge(s)</div></div>
    <div class="cov-bar"><i style="width:${pct}%"></i></div>
    <div class="cov meta-dim">${s.covered}/${s.total}</div></div>`;
}
function bindRows(container) {
  for (const row of container.querySelectorAll(".rec-card")) {
    row.addEventListener("click", async () => {
      const rec = await api.get(`/api/session?id=${encodeURIComponent(row.dataset.id)}`);
      if (rec && rec.id) { lastRecord = rec; renderSummary(rec, { live: false, saved: true }); showView("summary"); }
    });
  }
}

// ---------- Context ----------
function renderContext() {
  const list = $("context-list");
  list.innerHTML = state.context.length
    ? state.context.map((d) => `<div class="card-row"><div class="grow"><b>${escapeHtml(d.name)}</b> <span class="meta-dim">${d.chars} chars</span></div><button class="icon-btn" data-del="${escapeHtml(d.name)}">delete</button></div>`).join("")
    : `<div class="meta-dim">No context docs yet. Add battlecards, product notes, ICP — the copilot will ground questions in them.</div>`;
  for (const b of list.querySelectorAll("[data-del]")) {
    b.addEventListener("click", async () => { state = { ...state, ...(await api.post("/api/context/delete", { name: b.dataset.del })) }; renderContext(); });
  }
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
  $("set-classifier-prompt").value = s.classifierPrompt || "";
  $("set-question-prompt").value = s.questionPrompt || "";
  $("set-classifier-prompt").placeholder = state.defaults.classifierPrompt || "";
  $("set-question-prompt").placeholder = state.defaults.questionPrompt || "";
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
    config: {
      models: { classifier: $("set-model-classifier").value.trim() || undefined, questionGen: $("set-model-question").value.trim() || undefined },
      suggestion: $("set-cooldown").value ? { cooldownSeconds: Number($("set-cooldown").value) } : undefined,
    },
  };
  // prune empty config
  if (!patch.config.models.classifier && !patch.config.models.questionGen) delete patch.config.models;
  if (!patch.config.suggestion) delete patch.config.suggestion;
  if (!patch.config.models && !patch.config.suggestion) delete patch.config;
  state.settings = await api.post("/api/settings", patch);
  const note = $("settings-saved"); note.textContent = "Saved ✓";
  setTimeout(() => (note.textContent = ""), 2000);
}

// ---------- Helpers ----------
function toast(text, level = "info") {
  const t = $("toast"); t.textContent = text; t.className = `toast ${level === "info" ? "" : level}`;
  t.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
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
$("summary-done").addEventListener("click", () => showView("home"));
$("export-drive").addEventListener("click", () => { send({ type: "export-drive" }); toast("Uploading to Google Drive…", "info"); });
$("settings-save").addEventListener("click", saveSettings);
for (const b of document.querySelectorAll("[data-reset]")) {
  b.addEventListener("click", () => {
    if (b.dataset.reset === "classifier") $("set-classifier-prompt").value = "";
    else $("set-question-prompt").value = "";
  });
}
$("ctx-save").addEventListener("click", async () => {
  const name = $("ctx-name").value.trim(), text = $("ctx-text").value;
  if (!name || !text.trim()) return;
  state = { ...state, ...(await api.post("/api/context/save", { name, text })) };
  $("ctx-name").value = ""; $("ctx-text").value = ""; renderContext();
});
$("ctx-reload").addEventListener("click", async () => { state = { ...state, ...(await api.post("/api/context/reload", {})) }; renderContext(); });
document.addEventListener("keydown", (e) => {
  if (overlay.classList.contains("hidden")) return;
  if (e.key === "Escape") { if (currentSlot) dismissCard(); else endCall(); }
  else if (e.key.toLowerCase() === "s") snoozeCurrent();
});

init();
