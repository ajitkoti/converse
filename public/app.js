// Browser overlay client. Connects to the local server over WebSocket, renders
// the slot rail + suggestion card, and (live mode) captures mic + shared tab
// audio, streaming linear16 PCM to the server for Deepgram.

const $ = (id) => document.getElementById(id);
const setup = $("setup");
const overlay = $("overlay");

let ws = null;
let audioStop = null;
let elapsedMs = 0;
let slotDefs = [];
let statusBySlot = {};
let currentSlot = null; // slot targeted by the visible card
let cardTimer = null;
let toastTimer = null;

// ---------- WebSocket ----------
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.binaryType = "arraybuffer";
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("Could not reach the copilot server."));
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      handle(JSON.parse(e.data));
    };
    ws.onclose = () => {
      if (audioStop) audioStop();
    };
  });
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function handle(msg) {
  switch (msg.type) {
    case "ready":
      slotDefs = msg.slotDefs;
      statusBySlot = {};
      for (const s of msg.slotDefs) statusBySlot[s.id] = "empty";
      applySlots(msg.slots);
      buildRail();
      $("mode-badge").textContent = msg.mode;
      showOverlay();
      break;
    case "status":
      toast(msg.text, msg.level);
      if (msg.level === "error") setupStatus(msg.text);
      break;
    case "transcript":
      onTranscript(msg.event);
      break;
    case "guidance":
      onGuidance(msg.event);
      break;
    case "ended":
      toast("Call ended — final coverage shown.", "info");
      $("rec").style.animation = "none";
      $("rec").style.background = "var(--dim)";
      break;
  }
}

// ---------- Rendering ----------
function buildRail() {
  const rail = $("rail");
  rail.innerHTML = "";
  for (const s of slotDefs) {
    const row = document.createElement("div");
    row.className = "slot";
    row.id = `slot-${s.id}`;
    row.innerHTML = `<span class="dot"></span><span class="slot-label">${s.label}</span>`;
    rail.appendChild(row);
  }
  refreshRail();
}

function applySlots(slots) {
  for (const [id, st] of Object.entries(slots)) statusBySlot[id] = st.status;
}

function refreshRail() {
  const nowSec = elapsedMs / 1000;
  let mostOverdue = null;
  let mostOverBy = 0;
  for (const s of slotDefs) {
    const status = statusBySlot[s.id] ?? "empty";
    if (status !== "covered" && s.escalateBy != null) {
      const overBy = nowSec - s.escalateBy;
      if (overBy > 0 && overBy > mostOverBy) {
        mostOverBy = overBy;
        mostOverdue = s.id;
      }
    }
  }
  for (const s of slotDefs) {
    const row = $(`slot-${s.id}`);
    if (!row) continue;
    const status = statusBySlot[s.id] ?? "empty";
    row.classList.toggle("partial", status === "partial");
    row.classList.toggle("covered", status === "covered");
    row.classList.toggle("overdue", s.id === mostOverdue);
  }
}

function onTranscript(ev) {
  if (ev.tsEnd > elapsedMs) {
    elapsedMs = ev.tsEnd;
    $("timer").textContent = fmt(elapsedMs);
    refreshRail();
  }
  if (!ev.utteranceEnd && ev.text) {
    const who = ev.speaker === "rep" ? "You" : "Prospect";
    const cls = ev.speaker === "rep" ? "who-rep" : "who-prospect";
    $("caption").innerHTML = `<b class="${cls}">${who}:</b> ${escapeHtml(ev.text)}`;
  }
}

function onGuidance(ev) {
  if (ev.type === "slots") {
    applySlots(ev.slots);
    refreshRail();
  } else if (ev.type === "suggestion") {
    showCard(ev);
  }
  // suggestion-dropped: intentionally silent (logged server-side).
}

function showCard(ev) {
  currentSlot = ev.slotId;
  const def = slotDefs.find((s) => s.id === ev.slotId);
  $("card-slot").textContent = def ? def.label : ev.slotId;
  $("card-q").textContent = ev.question;
  const card = $("card");
  card.classList.remove("hidden");
  requestAnimationFrame(() => card.classList.add("show"));
  if (cardTimer) clearTimeout(cardTimer);
  cardTimer = setTimeout(dismissCard, 25000); // auto-dismiss after 25s
}

function dismissCard() {
  const card = $("card");
  card.classList.remove("show");
  currentSlot = null;
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

  const mic = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
  });
  hookChannel(ac, mic, 0);

  let display = null;
  try {
    display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch {
    toast("Screen/tab not shared — only your mic will be transcribed.", "warn");
  }
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
    frame[0] = channel;
    frame.set(pcm, 1);
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(frame.buffer);
  };
  const sink = ac.createGain();
  sink.gain.value = 0; // keep the graph pulling without audible playback
  src.connect(node);
  node.connect(sink);
  sink.connect(ac.destination);
}

// ---------- Screens & controls ----------
async function begin(mode, fixture) {
  try {
    await connect();
  } catch (err) {
    setupStatus(err.message);
    return;
  }
  if (mode === "live") {
    try {
      await startLiveAudio();
    } catch (err) {
      setupStatus("Microphone permission is required for live mode.");
      if (ws) ws.close();
      return;
    }
  }
  send({ type: "start", mode, fixture });
}

function end() {
  send({ type: "stop" });
  if (audioStop) audioStop();
  if (ws) ws.close();
  overlay.classList.add("hidden");
  setup.classList.remove("hidden");
  resetOverlay();
}

function resetOverlay() {
  elapsedMs = 0;
  currentSlot = null;
  $("timer").textContent = "00:00";
  $("caption").innerHTML = "";
  $("rec").style.animation = "";
  $("rec").style.background = "var(--green)";
  dismissCard();
}

function showOverlay() {
  setup.classList.add("hidden");
  overlay.classList.remove("hidden");
}

function toast(text, level = "info") {
  const t = $("toast");
  t.textContent = text;
  t.className = `toast ${level === "info" ? "" : level}`;
  t.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 4200);
}
function setupStatus(text) { $("setup-status").textContent = text; }
function labelOf(id) { const d = slotDefs.find((s) => s.id === id); return d ? d.label : id; }
function fmt(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

// ---------- Wire up ----------
for (const btn of document.querySelectorAll(".choice")) {
  btn.addEventListener("click", () => begin(btn.dataset.mode, btn.dataset.fixture));
}
$("stop").addEventListener("click", end);
$("card-dismiss").addEventListener("click", dismissCard);
$("card-snooze").addEventListener("click", snoozeCurrent);
document.addEventListener("keydown", (e) => {
  if (overlay.classList.contains("hidden")) return;
  if (e.key === "Escape") {
    if (currentSlot) dismissCard();
    else end();
  } else if (e.key.toLowerCase() === "s") {
    snoozeCurrent();
  }
});
