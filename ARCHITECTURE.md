# Architecture — Live Sales Qualification Copilot

A Convinco-style live guidance layer for discovery calls: real-time MEDDPICC
coverage tracking, time-budgeted escalation, and contextual next-question
suggestions surfaced at natural pauses. Built to plug into
[`Laxcorp-Research/project-raven`](https://github.com/Laxcorp-Research/project-raven)
(mic + system-audio capture, WebRTC AEC3 echo cancellation, Deepgram streaming,
Claude/OpenAI) **without touching its audio pipeline**.

```
Deepgram WS ──► TranscriptEvent stream ──► QualificationEngine ──► GuidanceEvent stream ──► Overlay UI
 (per source:    (speaker, text, ts,        (slot state machine       (slot dots +
  mic / system)   isFinal, utteranceEnd)     + haiku classifier        one bridging
                                             + escalation rules)        question)
```

## The one principle

The qualification engine is a **standalone async module** with **zero Electron
imports and zero UI knowledge**. It consumes a `TranscriptEvent` stream and emits
a `GuidanceEvent` stream — nothing else. This keeps it portable (server-side
later, raven swappable) and, crucially, **fully testable offline**: every test in
this repo replays a fixture through the real engine with a scripted `LlmClient`,
no audio hardware and no network. The rule is enforced by
`test/contract.test.ts`, not just by convention.

> **Environment note.** This repo is the *engine* half of the build plan, developed
> and tested headless (no mic, no display), which is exactly the slice the plan's
> own architecture principle isolates. Phase 4's overlay lives in raven's Electron
> shell; the contract and reference adapter for it are here (`src/integration/`,
> and the "Overlay contract" section below), ready to wire up in a raven checkout.

---

## Phase 0 — raven orientation (the four answers)

Read from `Laxcorp-Research/project-raven` `main`. File paths and identifiers are
raven's; whitespace in quoted snippets is approximate.

### 1. Where do Deepgram messages arrive, and what is the shape?

`src/main/transcriptionService.ts`. raven uses a **raw `ws` WebSocket** against
the Deepgram streaming URL (not the SDK's `listen.live`). The connection options
(`startConnection(source)`):

```
model: 'nova-3', language, smart_format: 'true', interim_results: 'true',
punctuate: 'true', diarize: 'true', sample_rate: 16000, channels: 1,
encoding: 'linear16', endpointing: 300, utterance_end_ms: 1500
```

Messages land in `ws.onmessage` → `handleTranscriptResult(data, source)`. raven
reads `data.channel.alternatives[0].transcript` and `data.is_final` only.

**Gaps we depend on that raven currently drops:** `UtteranceEnd` and
`speech_final` messages are ignored, and word-level `start`/`end` timings are not
extracted (the `words` array is read only for the diarization `speaker` index).
**But** because `interim_results` and `utterance_end_ms` are already enabled,
Deepgram *is* sending those messages — raven just discards them. So we don't
change raven's Deepgram config; we add a **passive tap** on the socket (below)
that hands the raw JSON to our `TranscriptBus`, which is the only place that has
to understand `UtteranceEnd` / `is_final` / `start` / `duration`.

`TranscriptBus.ingestDeepgram()` in `src/engine/transcript-bus.ts` mirrors this
exact shape (`DeepgramResultsMessage` / `DeepgramUtteranceEndMessage`).

### 2. Are mic and system-audio transcripts distinguishable? (REP vs PROSPECT)

**Yes, deterministically.** raven opens **two separate Deepgram WebSocket
connections** (`micConnection`, `systemConnection`), started together in
`start()` via `Promise.all([startConnection('mic'), startConnection('system')])`.
The `source: 'mic' | 'system'` argument is threaded through to
`handleTranscriptResult(data, source)`, which maps:

```
source === 'mic'    → 'you'   (the REP / microphone)
source === 'system' → 'them'  (the PROSPECT / system audio)
```

Because separation is by **physical audio stream**, not Deepgram diarization, the
REP/PROSPECT tag is reliable. We adopt this directly: `mic → "rep"`,
`system → "prospect"` (`RavenCopilot.onDeepgramMessage`). This matters — the
classifier only counts **PROSPECT** utterances as evidence (a rep *asking* about
budget must never mark Metrics covered), and that guarantee rests on this clean
split.

### 3. Where is the AI provider abstraction? (reuse it)

`src/main/services/ai/` — `types.ts`, `anthropicProvider.ts`, `openaiProvider.ts`,
`providerFactory.ts`; orchestrated by `src/main/claudeService.ts`.

The `AIProvider` interface exposes `streamResponse(params, callbacks)` **and
`generateShort(system, prompt): Promise<string>`**. `generateShort` is exactly
what our short, structured classifier/question calls need. `providerFactory`
gives `getProFastProvider()` → `claude-haiku-4-5` (latency-optimized), matching
our config's classifier/question model.

We reuse this without importing it into the engine: the engine depends only on a
one-method `LlmClient` interface (`src/engine/llm.ts`), and the raven binding is a
one-liner —
`{ complete: (r) => provider.generateShort(r.system, r.user) }`. Keys stay in
raven's encrypted store (`getApiKey('anthropicApiKey')`); the engine never sees
them.

### 4. How does the overlay receive data? (IPC channels)

Main → overlay via `overlayWindow.webContents.send(channel, payload)`. Existing
channels (from `transcriptionService.ts`, `claudeService.ts`, `ipc.ts`):

| Channel | Payload | Source |
|---|---|---|
| `transcription:update` | `{ entry, isFinal, fullTranscript, interims }` | transcriptionService |
| `transcription:status` | connection status (`mic-connected`, …) | transcriptionService |
| `claude:response` | `{ type: 'start'\|'delta'\|'done'\|'error', … }` | claudeService (broadcast pattern) |

We add **one** new channel, `guidance:update`, carrying our `GuidanceEvent`,
following the `claude:response` broadcast pattern. Overlay hotkeys come back on
`guidance:snooze` / `guidance:dismiss` (renderer → main via `ipcMain.on`).

---

## Module map (this repo)

| File | Responsibility | Phase |
|---|---|---|
| `src/engine/types.ts` | `TranscriptEvent`, `SlotState`, `GuidanceEvent` contracts | — |
| `src/engine/config.json` + `config.ts` | **single source of truth** for every tunable (models, cadence, windows, cooldown, slot schema, time budgets) | — |
| `src/engine/transcript-bus.ts` | normalize both Deepgram connections → one `TranscriptEvent` stream; rolling buffer + `recentWindow()` | 1 |
| `src/engine/qualification.ts` | slot state machine, classifier cadence loop, merge rules, escalation + question generation | 2 + 3 |
| `src/engine/prompts/*.ts` | the LLM prompts, isolated (edited more than code) | 2 + 3 |
| `src/engine/llm.ts` | `LlmClient` interface + defensive JSON extraction | — |
| `src/engine/anthropic-client.ts` | standalone Anthropic `LlmClient` (the **only** SDK importer) | — |
| `src/engine/logger.ts` | JSONL logger (the post-call iteration tool) | 2 |
| `src/integration/raven-copilot.ts` | reference glue: Deepgram tap → bus → engine → `guidance:update` | 4 |
| `scripts/replay.ts` | replay a fixture end-to-end, print guidance, write JSONL | testing |

## Data contracts

```ts
interface TranscriptEvent {
  speaker: "rep" | "prospect";
  text: string;
  tsStart: number; tsEnd: number;   // ms since call start
  isFinal: boolean;                 // Deepgram is_final
  utteranceEnd: boolean;            // synthesized from Deepgram UtteranceEnd (empty text)
}

type GuidanceEvent =
  | { type: "slots"; ts; slots: Record<SlotId, SlotState> }
  | { type: "suggestion"; ts; slotId; question; reason; latencyMs }
  | { type: "suggestion-dropped"; ts; slotId; reason; latencyMs };
```

## Determinism

The engine derives "now" from **transcript timestamps**, never the wall clock, so
a replayed fixture always produces the same slot states, classifier cadence,
escalation timing, and cooldown behavior. The single wall-clock use — measuring
real LLM latency for Phase 3's "drop if generation > 2.5s" rule — is injectable
(`monotonicNow`) and driven by a `FakeClock` in tests.

## Classifier & merge rules (Phase 2)

- Cadence: one `claude-haiku-4-5` call every **20s of call time OR every 6 final
  utterances**, whichever first (one call in flight at a time). `flush()` forces a
  final pass at call end.
- Window: last **90s** of transcript + current slot states.
- Structured JSON out, then merged under hard rules, all enforced in code
  (`#merge`) not just the prompt:
  1. **Evidence must be a verbatim PROSPECT quote** — the quote is verified as a
     normalized substring of prospect-channel text in the window. Rep speech and
     paraphrases are rejected (`unverified-quote`).
  2. **Never downgrade** — status moves monotonically `empty → partial → covered`.
  3. **`covered` needs a concrete answer** — vague/hedged answers cap at
     `partial` (prompt-enforced; the `bad-call` fixture pins this: a vague
     economic-buyer answer stays `partial`, never `covered`).
- Every call + response + merge decision is logged as one JSONL line.

## Escalation & suggestion (Phase 3)

Time budgets live in `config.json` (`budgets`, seconds of call time). A suggestion
opportunity fires only when **all** hold (deterministic, no LLM):

1. an overdue slot exists (past `escalateBy`, not `covered`);
2. an `UtteranceEnd` just fired **and** the last speaker was the prospect (so we
   only ever suggest into a real pause — never mid-utterance);
3. no suggestion in the last **90s** (hard cooldown — the #1 anti-spam guard);
4. exactly one target: the **most overdue** un-snoozed slot.

Then one `claude-haiku-4-5` call generates a single ≤20-word bridging question
that references what the prospect actually said. Latency budget: if generation
exceeds **2.5s** the suggestion is dropped (`suggestion-dropped`) — a late nudge
is worse than none. Firing consumes the cooldown whether the result shows or
drops, so a slow model can't be retried every pause.

## Wiring into raven (Phase 4)

Four touch points in raven's main process; **the audio pipeline is untouched**:

```ts
import { RavenCopilot } from "converse/integration/raven-copilot";
import { FileLogger } from "converse/engine";

// 1. LlmClient from raven's existing provider abstraction.
const provider = getProFastProvider();                       // src/main/services/ai
const llm = { complete: (r) => provider.generateShort(r.system, r.user) };

// 2. Copilot → broadcast guidance to the overlay renderer.
const copilot = new RavenCopilot({
  llm,
  broadcast: (payload) => overlayWindow.webContents.send("guidance:update", payload),
  logger: new FileLogger(logPath, fs),
});

// 3. PASSIVE tap on each Deepgram socket (raven already enables the flags we need).
ws.addEventListener("message", (e) =>
  copilot.onDeepgramMessage(source, JSON.parse(String(e.data))));  // source: 'mic' | 'system'

// 4. Overlay hotkeys.
ipcMain.on("guidance:snooze", (_e, slot) => copilot.snooze(slot));
copilot.endCall();  // on stop
```

### Overlay contract (Phase 4 renderer — build in the raven checkout)

Subscribe to `guidance:update` and render, sparsely:

- **Left rail:** 8 slot dots — grey `empty` / amber `partial` / green `covered`,
  one-word labels from `config.json` `slots[].label`. Pulse the most overdue slot.
  Seed/refresh from `type:"slots"` events.
- **Suggestion card:** on `type:"suggestion"`, show the one question, large type,
  auto-dismiss after 25s or on hotkey (dismiss / snooze-slot-5-min → send back on
  `guidance:dismiss` / `guidance:snooze`). Ignore `suggestion-dropped` (log only).
- **Elapsed timer.** Nothing else — sparse is the feature.

## Two hosts, one engine

The engine is deliberately host-agnostic. It ships with a **browser host** (the
runnable app) and a **raven adapter** (for the native Electron overlay); both feed
the same `TranscriptEvent` stream in and render the same `GuidanceEvent` stream
out.

```
                         ┌───────────────── shared engine ─────────────────┐
Browser host (this app): mic + shared tab audio → PCM → server → Deepgram ─┐
                                                                            ├─► TranscriptBus → QualificationEngine ─► GuidanceEvent
raven host (adapter):    raven's two Deepgram sockets (passive tap) ────────┘                                              │
                         └──────────────────────────────────────────────────────────────────────────────────────────────┘
   browser overlay (public/)  ◄──── GuidanceEvent ────►  raven overlay renderer (guidance:update)
```

**Browser host** (`src/server/` + `public/`): a local Node server serves the
overlay and, per browser, runs a `Session` that is either **demo** (a fixture
replayed in real time through the offline classifier — zero keys) or **live**
(mic via `getUserMedia` + prospect via `getDisplayMedia({audio:true})`, each
resampled to 16 kHz linear16 in an `AudioWorklet` and streamed to two Deepgram
connections server-side). Same `mic → rep`, `system → prospect` split as raven;
in-browser `echoCancellation` stands in for AEC3. This is the fastest way to
actually use the copilot — no native build.

**raven host** (`src/integration/raven-copilot.ts`): the passive-tap wiring
described above, for the native stealth overlay.

## Testing

- **Logic → fixtures.** `src/fixtures/*.json` replay through the real engine with
  a scripted/offline `LlmClient` at full speed; 22 tests cover speaker tagging,
  utterance-end markers, merge rules, cadence, escalation timing, cooldown,
  mid-utterance guard, latency drop, and the portability contract.
- **Feel → live.** Spam / latency / wrong-moment problems only surface live; after
  v1, run one mock/real call per iteration, then read the JSONL log and fix the
  worst behavior.
- **Known failure modes watched:** rep speech leaking into the prospect channel
  (rejected by prospect-only quote verification), vague answers over-scored
  (capped at `partial`), suggestions during monologues (only fire on
  `UtteranceEnd` pauses).

## Deferred to v2 (not built)

RAG over battlecards; post-call summary + CRM export of slot evidence; persona-
adaptive prompting; frameworks beyond MEDDPICC (the slot schema is already
config-driven, so this is cheap).
