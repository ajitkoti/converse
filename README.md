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

## Install

- **Easiest — download the desktop app** (macOS `.dmg` / Windows `.exe`, no Node,
  no terminal): see **[INSTALL.md](./INSTALL.md)**. Installers are built
  automatically in CI for both platforms.
- **Run from source** — double-click `start-mac.command` / `start-windows.bat`, or
  `npm install && npm start` (below).

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

When the call ends you get a **summary screen**: MEDDPICC coverage grid with the
verbatim prospect quote behind each slot, the questions the copilot surfaced, and
what's still open. Every session is auto-saved locally and shows up under
**History**.

## Features

- **Live overlay** — 8-slot MEDDPICC rail (pulses the most overdue), one
  bridging-question card at natural pauses, elapsed timer, live caption.
- **Post-call summary + history** — coverage with evidence quotes and the nudges
  given; browse and reopen past calls.
- **Save transcripts & summaries** — auto-saved to `data/sessions/` as JSON +
  Markdown; one-click **download** or **export to Google Drive**.
- **Context via Markdown** — drop battlecards / product docs / ICP into
  `context/` (or the **Context** tab); the copilot grounds its questions in the
  most relevant ones.
- **Custom prompts & settings** — edit the classifier and question prompts, set a
  prospect **persona**, change models, cooldown, demo speed, and Drive folder from
  the **Settings** tab (persisted to `converse.config.json`).
- **Everything logged** — each classifier/suggestion decision is written to
  `logs/*.jsonl` for tuning.

## Saving to Google Drive

The app always saves locally. To also push summaries/transcripts to Drive:

1. In Google Cloud Console create an **OAuth client (Desktop app)**, download the
   JSON, and set `GOOGLE_OAUTH_CLIENT=/path/to/client.json` in `.env`.
2. Run `npm run connect-drive` once and approve — it saves `.gdrive-token.json`.
3. Start the app, finish a call, and click **Export to Drive** on the summary. By
   default it creates/uses a **"Converse Sessions"** folder (override with
   `GDRIVE_FOLDER_ID` or the Settings field).

(A service-account JSON via `GOOGLE_APPLICATION_CREDENTIALS` works too — share the
target folder with the service-account email.)

## Context & prompts

- **Context:** any `.md` in `context/` is loaded and injected into question
  generation (relevance-ranked to the live transcript, within a token budget).
  Manage from the **Context** tab or on disk. Example files are included — replace
  them with yours.
- **Prompts:** the classifier and question prompts live in
  `src/engine/prompts/` and can be overridden from the **Settings** tab without
  touching code (blank = built-in).

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
public/                the browser app (nav, overlay, summary, history, context, settings)
src/server/            local server + app services
  index.ts             static + WebSocket + JSON API (history/settings/context/drive)
  session.ts           per-connection: bus + engine + recording + export
  deepgram.ts          live Deepgram connections (one per channel)
  offline-llm.ts       deterministic classifier for demo/tests (no keys)
  settings.ts          converse.config.json (prompts, persona, budgets, models)
  context.ts           context/*.md loader + relevance-ranked injection
  store.ts / summary.ts  session persistence + Markdown summary/transcript
  gdrive.ts            optional Google Drive export
src/engine/            the standalone engine (no Electron imports — enforced by a test)
  transcript-bus.ts    Deepgram (mic + system) → one TranscriptEvent stream
  qualification.ts     slot state machine + haiku classifier + escalation/suggestion
  prompts/             the LLM prompts, isolated (edited more than the code)
  config.json          single source of truth for every tunable
src/integration/       reference glue for the raven Electron app (Deepgram tap → engine → IPC)
context/               your Markdown context docs (examples included)
scripts/               replay + connect-drive CLIs
test/                  29 offline tests (engine + server modules)
```

## Developer commands

```bash
npm test            # 29 tests, no network, no audio hardware
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
