# Installing Converse

Two ways to run it. Most people want **Option A**.

---

## Option A — Download the app (no Node, no terminal)

Prebuilt installers are produced automatically for **macOS** and **Windows**.

1. Go to the repo's **Actions → "Build installers"**, open the latest successful
   run, and download the artifact for your OS:
   - `converse-mac` → a **`.dmg`**
   - `converse-win` → a **`.exe`** installer
   (Tagged releases also attach these to the GitHub **Releases** page.)
2. Install:
   - **macOS:** open the `.dmg`, drag **Converse** to Applications.
   - **Windows:** run the `.exe` and follow the installer.
3. Launch **Converse**. It opens straight to the app — click a **Demo** to try it
   immediately (no keys needed).

### First-launch security prompts (because the builds are unsigned)

These apps aren't code-signed (that needs paid Apple/Windows certificates), so the
OS will warn the first time. This is expected:

- **macOS:** right-click the app → **Open** → **Open** (once). Or after a blocked
  launch: System Settings → Privacy & Security → **Open Anyway**.
  - **If macOS says the app is “damaged and can’t be opened”** — that's the
    quarantine flag on an unsigned download, not real corruption. Clear it once:
    ```bash
    xattr -cr /Applications/Converse.app
    ```
    then open the app normally. (Signed/notarized builds — see below — never show this.)
- **Windows:** on the blue “Windows protected your PC” screen click
  **More info → Run anyway**.

### Live mode in the app

Demo mode works everywhere with nothing to configure. For a **real call**:

- Open **Settings** in the app and paste your **Deepgram API key**
  (from [console.deepgram.com](https://console.deepgram.com)); optionally an
  **Anthropic key** for sharper questions. No file editing required.
- Click **Go live**. Your **microphone** is the rep; the app captures
  **system/scr­een audio** for the prospect.
  - **Windows:** system (loopback) audio is captured automatically.
  - **macOS:** the OS can't hand system audio to an app without a virtual audio
    device. Install a free loopback device (e.g. **BlackHole**) and route your
    meeting audio to it, or use **Option B** in Chrome (tab-audio sharing works
    there with no extra setup). Your mic still works either way.

---

## Option B — Run from source (uses your browser)

Best if you want live mode on macOS with zero extra audio setup — Chrome's
tab-audio sharing captures the prospect cleanly.

**Prerequisite:** [Node.js LTS](https://nodejs.org).

- **macOS:** double-click **`start-mac.command`**.
- **Windows:** double-click **`start-windows.bat`**.
- **Any OS (terminal):** `npm install` then `npm start`.
- **From npm (no clone):** once published, `npx converse` (or
  `npm install -g converse && converse`) starts the same web app on
  **http://localhost:5173**.

It installs dependencies on first run and opens **http://localhost:5173**. For a
live call, click **Go live**, allow the **mic**, and in the screen-share picker
choose your **meeting tab with “Share tab audio” ticked** (use Chrome/Edge).

Keys: set them in the app's **Settings** tab, or create a `.env`
(`cp .env.example .env`).

---

## Google Drive export (optional, either option)

The app always saves sessions locally. To also push summaries to Drive, follow
the **Saving to Google Drive** steps in the [README](./README.md#saving-to-google-drive).

---

## Building the installers yourself

```bash
npm install
npm run dist:mac      # → release/*.dmg   (run on macOS)
npm run dist:win      # → release/*.exe   (run on Windows)
```

(Each OS builds its own installer; that's why CI uses both a macOS and a Windows
runner. `npm run app` runs the desktop app locally without packaging.)

## Signed, warning-free installers (optional)

The default CI builds are **unsigned** (hence the one-time security prompts / the
`xattr` step above). To ship installs with **no warnings**, add these repository
secrets and CI signs + notarizes automatically — no workflow edits needed:

| Secret | What it is |
| --- | --- |
| `CSC_LINK` | base64 of your code-signing cert (`.p12`) — an Apple **Developer ID Application** cert (macOS) or a code-signing cert from a CA (Windows). `base64 -i cert.p12 \| pbcopy` |
| `CSC_KEY_PASSWORD` | the `.p12` export password |
| `APPLE_ID` | your Apple ID email (macOS notarization) |
| `APPLE_APP_SPECIFIC_PASSWORD` | an [app-specific password](https://support.apple.com/en-us/102654) for that Apple ID |
| `APPLE_TEAM_ID` | your Apple Developer **Team ID** |

Getting the certs is the part only you can do: the macOS **Developer ID** needs an
[Apple Developer Program](https://developer.apple.com/programs/) membership
($99/yr); the Windows cert comes from a CA (DigiCert/Sectigo/etc). Once the
secrets are set, push a build and the `.dmg`/`.exe` come out signed + notarized.

## Publishing to npm

```bash
npm login        # your npm account
npm publish      # prepublishOnly runs the build first
```

Then anyone can `npx converse`.
