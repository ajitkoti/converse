/**
 * One-time Google Drive OAuth connect (loopback flow). Run: `npm run connect-drive`.
 *
 * Prereq: create an OAuth client (type "Desktop app") in Google Cloud Console,
 * download the json, and point GOOGLE_OAUTH_CLIENT at it (in .env or the shell).
 * This opens a consent URL, catches the redirect locally, and writes
 * .gdrive-token.json which the app then uses to upload session artifacts.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import { buildOAuthClient, DRIVE_SCOPES, TOKEN_PATH } from "../src/server/gdrive.js";
import { CALENDAR_SCOPES } from "../src/server/gcal.js";

const clientPath = process.env.GOOGLE_OAUTH_CLIENT;
if (!clientPath || !fs.existsSync(clientPath)) {
  console.error("Set GOOGLE_OAUTH_CLIENT to your OAuth client json (Desktop app) first.");
  process.exit(1);
}

const PORT = 5273;
const oauth = buildOAuthClient(clientPath);
const url = oauth.generateAuthUrl({ access_type: "offline", scope: [...DRIVE_SCOPES, ...CALENDAR_SCOPES], prompt: "consent" });

const server = http.createServer(async (req, res) => {
  const code = new URL(req.url ?? "", `http://localhost:${PORT}`).searchParams.get("code");
  if (!code) {
    res.writeHead(400).end("no code");
    return;
  }
  try {
    const { tokens } = await oauth.getToken(code);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    res.writeHead(200, { "Content-Type": "text/html" }).end(
      "<h2>✅ Google Drive connected.</h2><p>You can close this tab and return to the app.</p>",
    );
    console.log(`\n  ✅ Saved ${TOKEN_PATH}. Drive export is now enabled.\n`);
    server.close(() => process.exit(0));
  } catch (err) {
    res.writeHead(500).end(String(err));
    console.error(err);
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`\n  Open this URL to authorize Google Drive:\n\n  ${url}\n`);
  console.log(`  Waiting for the redirect on http://localhost:${PORT} ...\n`);
});
