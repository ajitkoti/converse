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
// Force the loopback redirect to the port this script's local server listens on.
// A stock Desktop-app client JSON ships redirect_uris: ["http://localhost"] (port 80),
// so without this override Google would redirect the browser to port 80 and the
// consent code would never reach our server on PORT. Google allows any loopback port
// for Desktop clients without pre-registration, and the handler below reads `code`
// from any path, so /oauth2callback is fine.
const oauth = buildOAuthClient(clientPath, `http://localhost:${PORT}/oauth2callback`);
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
