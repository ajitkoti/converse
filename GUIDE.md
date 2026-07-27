# Converse — Setup & User Guide

Everything you need to set up Converse and use it on real calls. If you just want
to install it, see **[INSTALL.md](./INSTALL.md)**; this guide covers setup *and*
day-to-day use.

- [1. What Converse does](#1-what-converse-does)
- [2. Setup](#2-setup)
- [3. Quick start — try a demo](#3-quick-start--try-a-demo)
- [4. The interface](#4-the-interface)
- [5. Running a real call (live mode)](#5-running-a-real-call-live-mode)
- [6. After the call — summary, downloads, history](#6-after-the-call--summary-downloads-history)
- [7. Ground it in your product — context docs](#7-ground-it-in-your-product--context-docs)
- [8. Customize — persona, prompts, models, settings](#8-customize--persona-prompts-models-settings)
- [9. Saving to Google Drive](#9-saving-to-google-drive)
- [10. Where your data lives (privacy)](#10-where-your-data-lives-privacy)
- [11. Troubleshooting](#11-troubleshooting)
- [12. MEDDPICC cheat-sheet](#12-meddpicc-cheat-sheet)

---

## 1. What Converse does

Converse listens to a live discovery call and, in real time:

- **Tracks MEDDPICC coverage** — 8 qualification areas, marked grey (not covered),
  amber (partially covered), or green (covered) — based only on what the
  **prospect** actually says.
- **Escalates what's overdue** — each area has a time budget; if it's still open
  late in the call, its dot pulses.
- **Suggests one bridging question** at a natural pause when an area is overdue —
  phrased around what the prospect just said, not a generic script line.

After the call it produces a **summary** with the evidence behind each area and
the questions it surfaced, saved locally (and optionally to Google Drive).

---

## 2. Setup

### Option A — the desktop app (recommended, no Node)

1. Download and install per **[INSTALL.md](./INSTALL.md)** (macOS `.dmg` /
   Windows `.exe`).
2. Launch **Converse**. It opens to the **Home** screen.
3. That's it for demo mode. For live calls, add your Deepgram key in **Settings**
   (see §5).

### Option B — run from source

1. Install [Node.js LTS](https://nodejs.org).
2. Double-click `start-mac.command` (Mac) or `start-windows.bat` (Windows), **or**
   run `npm install && npm start`.
3. It opens **http://localhost:5173**.

No API keys are needed to explore — demo mode works immediately.

---

## 3. Quick start — try a demo

On the **Home** screen, click one of the demo buttons:

- **Demo · strong call** — a great prospect who reveals everything. Watch the 8
  dots on the left fill in and go green.
- **Demo · rough call** — a vague prospect. Watch a **suggestion card** pop up
  with a bridging question when an area falls behind.

Demos run a scripted call at a few times real speed, so the whole thing takes
under a minute. When it finishes you land on the **Summary** screen.

> Demos use a built-in offline engine — no keys, no internet needed.

---

## 4. The interface

### Home & the top navigation

- **Home** — start a demo or a live call; set a per-call persona; see recent calls.
- **History** — every past call; click one to reopen its summary.
- **Context** — your product docs that ground the copilot's questions.
- **Settings** — keys, persona, models, prompts, and tuning.
- The pill on the right shows whether **Google Drive** is connected.

### The in-call overlay

When a call is running, the screen switches to the overlay:

- **Left rail — the 8 dots.** Each is a MEDDPICC area (§12). Colors:
  - ⚪️ **grey** = not covered
  - 🟡 **amber** = partially covered
  - 🟢 **green** = covered
  The **most overdue** area **pulses** so you know where to steer.
- **Suggestion card** (bottom center) — appears at a pause when an area is
  overdue. One question, phrased around what the prospect said. It auto-dismisses
  after 25 seconds.
- **Timer** (top left) — elapsed call time. **Caption** (bottom) — the last thing
  said, labelled *You* or *Prospect*.
- **End call** (top right) — finishes the call and builds the summary.

**Keyboard shortcuts (during a call):**

| Key | Action |
| --- | --- |
| `Esc` | dismiss the current suggestion (or end the call if none is showing) |
| `S` | snooze the nudged area for 5 minutes |

---

## 5. Running a real call (live mode)

### One-time: add your keys

Open **Settings** and paste:

- **Deepgram API key** (required for live transcription) — free tier at
  [console.deepgram.com](https://console.deepgram.com).
- **Anthropic API key** (optional) — makes the suggested questions sharper. Without
  it, live still transcribes and uses the offline suggestion engine.

Click **Save settings**. Keys are stored locally on your machine and are never
shown back in the browser (you'll just see "saved ✓").

### Start the call

1. On **Home**, optionally type a **persona** (e.g. "CFO — ROI & risk focused").
2. Click **● Go live**.
3. Allow the **microphone** — that's you, the rep.
4. Share the **prospect's audio**:
   - **Desktop app on Windows:** the app captures system (loopback) audio
     automatically.
   - **Desktop app on macOS:** macOS can't hand system audio to an app without a
     virtual audio device — install a free one like **BlackHole** and route your
     meeting audio to it, **or** use the browser (Option B) where tab-sharing just
     works. Your mic works either way.
   - **Browser (run-from-source, Chrome/Edge):** in the screen-share picker choose
     your **meeting tab** and tick **"Share tab audio."**

Your voice and the prospect's are transcribed on **separate channels**, so the
copilot always knows who said what — you *asking* about budget never marks budget
covered.

> **Echo note:** the browser/app uses built-in echo cancellation. It's good, not
> perfect; if your own voice occasionally leaks into the prospect channel, that's
> the known limitation the native raven app's AEC3 is designed for.

---

## 6. After the call — summary, downloads, history

Click **End call** (or `Esc`) to finish. The **Summary** screen shows:

- **Coverage grid** — every area, its status, and the **verbatim prospect quote**
  that earned it.
- **Copilot nudges** — the questions it surfaced and when.
- Buttons:
  - **Download summary** / **Transcript** — Markdown files.
  - **Export to Drive** — upload the summary + transcript + raw JSON to Google
    Drive (see §9).
  - **Done** — back to Home.

Every call is **auto-saved locally** and appears under **History**, where you can
reopen its summary and re-download anytime. (You can turn auto-save off in
Settings.)

---

## 7. Ground it in your product — context docs

By default the copilot's questions are smart but generic. Feed it your material
and they get specific to *your* product and playbook.

Open the **Context** tab and add Markdown docs — battlecards, a product
one-pager, ICP notes, objection handling, pricing. For each doc:

- Give it a name and paste the content, then **Save doc**.
- Delete or edit anytime; **Reload from disk** picks up files you edited outside
  the app.

The copilot automatically pulls the **most relevant** doc(s) into each suggestion,
based on what's being discussed. Two example docs ship with it — replace them with
yours.

> You can also just drop `.md` files into the `context/` folder (run-from-source)
> or the app's context folder (§10) — same effect.

---

## 8. Customize — persona, prompts, models, settings

Everything in **Settings** (saved to `converse.config.json`):

| Setting | What it does |
| --- | --- |
| **Persona** | Tunes questions to who you're selling to (CFO vs. end-user, etc.). |
| **Demo speed** | How fast demo calls replay. |
| **Classifier / Question model** | Which Claude model to use (default `claude-haiku-4-5`). |
| **Suggestion cooldown** | Minimum seconds between nudges (anti-spam). |
| **Google Drive folder id** | Where exports go (blank = auto "Converse Sessions"). |
| **Deepgram / Anthropic keys** | Live-mode credentials. |
| **Auto-save** | Save every finished call locally. |
| **Inject context docs** | Toggle whether context docs feed the suggestions. |
| **Classifier / Question prompt** | Override the built-in prompts entirely (blank = built-in; there's a "Reset to default" button). |

The two prompt editors let you rewrite how the copilot judges coverage and how it
phrases questions — the built-in text is shown as the placeholder so you can copy
and tweak it.

---

## 9. Saving to Google Drive

Optional — local saving always works without this.

1. In Google Cloud Console create an **OAuth client (Desktop app)**, download the
   JSON, and set `GOOGLE_OAUTH_CLIENT=/path/to/client.json` in your `.env`.
2. Run `npm run connect-drive` once and approve in the browser (saves a token).
3. Finish a call and click **Export to Drive** — it creates/uses a
   **"Converse Sessions"** folder and uploads the summary, transcript, and JSON.

(A Google **service account** works too — set `GOOGLE_APPLICATION_CREDENTIALS`
and share the target folder with the service-account email.) Full details in the
[README](./README.md#saving-to-google-drive).

---

## 10. Where your data lives (privacy)

Everything stays on your machine. Nothing is sent anywhere except the audio
streamed to **your own** Deepgram/Anthropic keys and files you explicitly export
to **your own** Google Drive.

| What | Run from source | Desktop app |
| --- | --- | --- |
| Saved sessions | `data/sessions/` | `Converse/data/` in your user data folder\* |
| Context docs | `context/` | `Converse/context/` |
| Settings + keys | `converse.config.json` | `Converse/converse.config.json` |
| Debug logs | `logs/*.jsonl` | `Converse/logs/` |

\* User data folder: macOS `~/Library/Application Support/Converse`,
Windows `%APPDATA%\Converse`.

Keys are stored in plain text in the settings file (fine for a personal local
tool). Delete the file to remove them.

---

## 11. Troubleshooting

**"No tab audio captured" / the prospect isn't transcribed.**
Re-share and make sure **"Share tab audio"** is ticked (browser), or that you're
sharing the correct tab/window. On macOS desktop app, use a loopback device or the
browser path (§5).

**The mic isn't working.**
Grant microphone permission when prompted. In the browser, check the site isn't
muted in your OS/browser settings.

**Live suggestions feel generic.**
Add your **Anthropic key** (Settings) for model-generated questions, and add
**Context docs** (§7). Without an Anthropic key, live uses the offline engine.

**"Deepgram error" appears.**
Your `DEEPGRAM_API_KEY` is missing or invalid — re-check it in Settings.

**The app didn't open / port in use.**
Converse uses port 5173 and automatically tries the next few if it's taken. If
you started it from source, open the printed `http://localhost:<port>` URL.

**"Unknown developer" warning on first launch.**
Expected — the builds are unsigned. Mac: right-click → **Open**. Windows: **More
info → Run anyway**. (§Install)

**Nothing goes green in a real call.**
The copilot only counts **prospect** statements as evidence, and only concrete
answers count (vague answers stay amber). That's by design — it's tracking real
qualification, not that a topic was mentioned.

---

## 12. MEDDPICC cheat-sheet

What each dot means (and what "covered" requires):

| Dot | Area | Covered when the prospect… |
| --- | --- | --- |
| **Pain** | Identify Pain | names a concrete business pain and its consequence |
| **Metrics** | Metrics | quantifies the impact (hours, £/$, %, headcount) |
| **Econ Buyer** | Economic Buyer | identifies who owns the budget / signs off |
| **Criteria** | Decision Criteria | states what a solution must do to win |
| **Process** | Decision Process | describes the steps/timeline to a decision |
| **Paper** | Paper Process | mentions procurement / legal / security steps |
| **Champion** | Champion | shows they'll advocate for this internally |
| **Competition** | Competition | names alternatives, incumbents, or "do nothing" |

The area labels and time budgets are configurable in
[`src/engine/config.json`](./src/engine/config.json) — and the whole framework can
be swapped since the slot schema is config-driven.

---

Questions or something behaving oddly on a real call? The per-session debug log
(`logs/*.jsonl`) records every decision the copilot made — it's the fastest way to
see *why* it did what it did.
