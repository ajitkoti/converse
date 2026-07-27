# converse

**Live Sales Qualification Copilot** — a real-time MEDDPICC coverage engine for
discovery calls. It tracks which qualification slots the *prospect* has actually
covered, escalates the ones running overdue against a time budget, and surfaces a
single contextual next-question at natural pauses.

It's designed to plug into
[`Laxcorp-Research/project-raven`](https://github.com/Laxcorp-Research/project-raven)
(mic + system-audio capture, echo cancellation, Deepgram, Claude) **without
touching raven's audio pipeline** — but the engine is a standalone async module
with zero Electron/UI knowledge, so it also runs server-side or in tests.

See **[ARCHITECTURE.md](./ARCHITECTURE.md)** for the design, the raven
integration points, and the overlay contract.

## Run it (30 seconds, no keys)

```bash
npm install
npm start
```

Open **http://localhost:5173** and click a **Demo** — watch the 8 MEDDPICC dots
fill in (grey → amber → green) as the call progresses, and see the copilot pop a
single contextual question when a topic runs overdue. No API keys, no microphone,
nothing to configure.

- **Demo · strong call** — a great prospect reveals everything; the rail goes green.
- **Demo · rough call** — a vague prospect; the copilot nudges you with bridging
  questions at the pauses.

### Go live on a real call

1. `cp .env.example .env` and add your `DEEPGRAM_API_KEY`
   (from [console.deepgram.com](https://console.deepgram.com)). Optionally add
   `ANTHROPIC_API_KEY` so suggestions use `claude-haiku-4-5` instead of the
   offline engine.
2. `npm start`, open the page, click **Go live**.
3. Allow the **microphone** (that's you, the rep), then in the screen-share
   picker choose your **meeting tab and tick "Share tab audio"** (that's the
   prospect). Use **Chrome/Edge** — tab-audio capture is a Chromium feature.

Your mic and the meeting audio are transcribed as separate channels, so the
engine always knows who said what — a rep *asking* about budget never marks
budget covered. Audio and transcripts stay on your machine except for the
streams sent to your own Deepgram/Anthropic keys. (In-browser echo cancellation
stands in for raven's native AEC3.)

Hotkeys in the overlay: **Esc** dismiss · **S** snooze the nudged topic 5 min.

## What's here

```
src/server/            local server: serves the overlay, runs the engine, relays Deepgram
public/                the browser overlay (slot rail, suggestion card, timer)
src/engine/            the standalone engine (no Electron imports — enforced by a test)
  transcript-bus.ts    Deepgram (mic + system) → one TranscriptEvent stream
  qualification.ts     slot state machine + haiku classifier + escalation/suggestion
  prompts/             the LLM prompts, isolated (edited more than the code)
  config.json          single source of truth for every tunable
src/integration/       reference glue for the raven Electron app (Deepgram tap → engine → IPC)
src/fixtures/          good + bad discovery-call fixtures
scripts/replay.ts      replay a fixture end-to-end; write the JSONL iteration log
test/                  22 offline tests (replay fixtures through the real engine)
```

## Developer commands

```bash
npm test            # 22 tests, no network, no audio hardware
npm run typecheck
npm run replay                 # replay good-call in the terminal (offline classifier)
npm run replay -- bad-call     # replay the vague/deflecting call
ANTHROPIC_API_KEY=... npm run replay   # use the real claude-haiku-4-5 classifier
```

`npm run replay` and every live/demo session write a per-run JSONL log to `logs/`
— the primary tool for tuning the engine after a call.

## Configuration

Every tunable — model names, classifier cadence, transcript window sizes,
suggestion cooldown and latency budget, the MEDDPICC slot schema, and the
per-slot escalation time budgets — lives in
[`src/engine/config.json`](./src/engine/config.json). Behavior is meant to be
tuned there, not in code.

## Status

- ✅ Phase 0 — raven orientation ([ARCHITECTURE.md](./ARCHITECTURE.md))
- ✅ Phase 1 — transcript event bus + fixtures + tests
- ✅ Phase 2 — qualification state engine + merge rules + tests
- ✅ Phase 3 — escalation + question generation + tests
- ✅ Phase 4 — overlay UI: a runnable browser overlay + local server (demo + live
  modes) so you can test the whole thing today without native audio toolchains.
  The same engine also drops into the raven Electron app via
  `src/integration/raven-copilot.ts` (contract in ARCHITECTURE.md).

Why a browser app and not the raven Electron fork? raven needs native
per-platform builds (Swift audio capture, WebRTC AEC3) and a Mac/Windows dev
toolchain. This browser host runs the identical engine, captures both channels
(mic + shared tab audio) with zero native build, and works cross-platform — the
fastest path to actually using it. The raven adapter is ready for when you want
the native stealth overlay.
