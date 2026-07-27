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

## What's here

This repo is the portable **engine** (build-plan Phases 1–3 + the Phase 0
orientation and the Phase 4 integration contract), developed and tested fully
offline:

```
src/engine/            the standalone engine (no Electron imports — enforced by a test)
  transcript-bus.ts    Deepgram (mic + system) → one TranscriptEvent stream
  qualification.ts     slot state machine + haiku classifier + escalation/suggestion
  prompts/             the LLM prompts, isolated (edited more than the code)
  config.json          single source of truth for every tunable
src/integration/       reference glue for raven (Deepgram tap → engine → overlay IPC)
src/fixtures/          good + bad discovery-call fixtures
scripts/replay.ts      replay a fixture end-to-end; write the JSONL iteration log
test/                  22 offline tests (replay fixtures through the real engine)
```

## Quick start

```bash
npm install
npm test            # 22 tests, no network, no audio hardware
npm run typecheck

npm run replay                 # replay good-call (offline keyword classifier)
npm run replay -- bad-call     # replay the vague/deflecting call
ANTHROPIC_API_KEY=... npm run replay   # use the real claude-haiku-4-5 classifier
```

`npm run replay` prints the guidance stream and final slot coverage, and writes a
per-run JSONL log to `logs/` — the primary tool for tuning the engine after a
call.

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
- 📋 Phase 4 — overlay UI: contract + reference adapter here; the renderer is
  built in a raven checkout (needs the Electron shell + a live mic/system feed)
