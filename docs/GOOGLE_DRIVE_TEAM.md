# Team Google Drive + end-to-end integration testing

Converse can use a **Google Shared Drive (Team Drive)** as the shared call
database: every member signs in with their own Google account, points their app
at the same Shared Drive folder, and everyone's calls collect there, filed by
type — `Recordings/ Transcripts/ Summaries/ Analyses/ Sessions/`.

This doc covers (1) the team setup and (2) exactly what to provide so the
**headless integration test** can verify Drive against your real account.

---

## 1. Team setup (per-user Google sign-in → shared Team Drive)

**One-time, by an admin:**

1. In Google Workspace, create a **Shared Drive** (e.g. "Sales Calls"). Add every
   rep as a member with **Content manager** (or Contributor) access.
2. Inside it, create a folder (e.g. "Converse"). Open it and copy the **folder id**
   from the URL (`.../folders/<THIS_ID>`).
3. Set up an **OAuth client** (Google Cloud Console → APIs & Services →
   Credentials → *Desktop app*). Enable the **Google Drive API** and
   **Google Calendar API** for the project. Download the client JSON.

**Per rep, once:**

1. Put the OAuth client JSON somewhere and set `GOOGLE_OAUTH_CLIENT` to its path
   (`.env`), or use the packaged app's connect flow.
2. Start the app, go to **Settings → Google Drive → Connect**, and complete the
   Google sign-in **with your own account**. This grants Drive + Calendar.
   > If you connected Drive before team support existed, reconnect once — the
   > scope widened to full `drive` (needed so teammates can see each other's
   > files in the Shared Drive).
3. In **Settings**, paste the shared **Team Drive folder id** into
   *Team Drive folder id*, set your **Rep name**, and turn on
   *Sync finished calls to Google Drive*.

Now every finished call lands in the shared folder, attributed to the rep who ran
it. The **Cloud** view browses the whole team's calls; **Scorecard** rolls them
up per rep (tag by Rep name).

---

## 2. Headless integration test (what I need from you to verify Drive)

The gated test (`npm run test:int`) runs the full DriveDb round-trip (create
folders → store → list → fetch → refresh → recording upload → cleanup) against
real Drive. It works with **either** credential path — pick the one that matches
your Google account:

### 2a. Personal / Gmail account (no Shared Drives) → **OAuth token**

> A **service account cannot write to a consumer (Gmail) Drive** — it has no
> storage quota and consumer accounts have no Shared Drive to lend it one. Use
> your own login instead; your account has storage.

1. Create an **OAuth client** (Cloud Console → Credentials → *Desktop app*).
   Enable the **Drive API** and **Calendar API**. Set `GOOGLE_OAUTH_CLIENT` to the
   downloaded client JSON.
2. Mint a token once (opens a browser, you sign in with your account):
   ```bash
   npm run connect-drive
   ```
   This writes `.gdrive-token.json`.
3. Provide `.gdrive-token.json` + the client JSON + a **My Drive folder id**
   (`GDRIVE_TEST_FOLDER`). Then `npm run test:int` runs headlessly using your
   token — writes land in your own Drive.

   ⚠️ That token grants full Drive access to whatever account you signed in with.
   Prefer a **throwaway/test Google account**, or just run the manual check in §1
   yourself instead of handing the token over.

### 2b. Google Workspace → **service account + Shared Drive**

A service account lets the test hit Drive with **no browser consent at all** —
but only against a **Shared Drive** (Workspace).

**Create it (admin, ~5 min):**

1. Google Cloud Console → **IAM & Admin → Service Accounts → Create**. Name it
   e.g. `converse-it`. No roles needed. Create.
2. On the service account → **Keys → Add key → JSON**. Download it. Copy the
   service account **email** (`…@….iam.gserviceaccount.com`).
3. Enable the **Google Drive API** for the project (APIs & Services → Library).
4. **Share the target folder with the service account email** as *Content
   manager*:
   - Shared Drive: add the service account as a **member** of the Shared Drive.
   - Or a normal folder: right-click → Share → add the email.

**Provide to the app / environment (as env vars / secrets):**

| Variable | Value |
| --- | --- |
| `GOOGLE_APPLICATION_CREDENTIALS` | path to the service-account JSON |
| `GDRIVE_TEST_FOLDER` | the folder id the service account can write to |
| `DEEPGRAM_API_KEY` | *(optional)* to also verify pre-recorded transcription |
| `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) | *(optional)* to verify real LLM analysis |

Then run:

```bash
npm run test:int
```

It creates a throwaway `Converse IT (safe to delete)` folder under
`GDRIVE_TEST_FOLDER`, exercises the whole database, and **deletes it afterwards**.
Green = Drive works end to end against your account.

> Network note: these calls go through the environment's outbound proxy, so
> `googleapis.com`, `api.deepgram.com`, and `api.anthropic.com` must be allowed by
> the environment's network policy.

---

## 3. What still needs a human (can't be automated)

- **Per-user OAuth consent** — the "Sign in with Google" browser click is yours to
  do; there's no headless path for a real user's consent.
- **Live mic + shared-tab capture** — needs a microphone and a screen share, so a
  true live call (mic → Deepgram → transcript) is verified by running a real call
  in the app, not in CI.

For those two, the checklist in §1 (connect → run a live demo/real call → confirm
the Cloud folders populate → hit Refresh analysis) is the end-to-end pass.
