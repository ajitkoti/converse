// Electron wrapper. Runs the local server in-process against per-user (userData)
// paths, then opens a window pointed at it. Demo mode needs nothing; live mode
// uses the OS mic + screen/loopback audio (see setDisplayMediaRequestHandler).
//
// The server is the compiled ESM in dist/ — loaded via dynamic import from this
// CommonJS entry. Build first: `npm run build`.

const { app, BrowserWindow, session, desktopCapturer, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

let mainWindow = null;
let server = null;

const appPath = app.getAppPath(); // dev: repo; packaged (asar:false): resources/app
const userData = app.getPath("userData");

function seedContext(seedDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const already = fs.existsSync(destDir) ? fs.readdirSync(destDir).filter((f) => f.endsWith(".md")) : [];
  if (already.length > 0) return; // user already has docs — don't clobber
  if (!fs.existsSync(seedDir)) return;
  for (const f of fs.readdirSync(seedDir)) {
    if (f.endsWith(".md")) fs.copyFileSync(path.join(seedDir, f), path.join(destDir, f));
  }
}

async function boot() {
  const contextDir = path.join(userData, "context");
  seedContext(path.join(appPath, "context"), contextDir);

  // Load the ESM server and its .env loader.
  const appJs = pathToFileURL(path.join(appPath, "dist", "server", "app.js")).href;
  const { startServer, loadEnvFile } = await import(appJs);
  loadEnvFile(path.join(userData, ".env"));

  server = await startServer({
    port: Number(process.env.PORT || 5173),
    publicDir: path.join(appPath, "public"),
    dataDir: path.join(userData, "data"),
    contextDir,
    settingsFile: path.join(userData, "converse.config.json"),
    logsDir: path.join(userData, "logs"),
    env: {
      DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      DEEPGRAM_MODEL: process.env.DEEPGRAM_MODEL,
      GDRIVE_FOLDER_ID: process.env.GDRIVE_FOLDER_ID,
    },
  });

  // Media permissions for live mode.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));
  try {
    session.defaultSession.setDisplayMediaRequestHandler(
      (_request, callback) => {
        desktopCapturer
          .getSources({ types: ["screen", "window"] })
          .then((sources) => callback({ video: sources[0], audio: "loopback" }))
          .catch(() => callback({}));
      },
      { useSystemPicker: true },
    );
  } catch {
    /* older Electron without this API — live tab-audio may be limited */
  }

  createWindow();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0a0c10",
    title: "Converse",
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.loadURL(server.url);
  // Open external links (e.g. Drive) in the real browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.on("closed", () => (mainWindow = null));
}

app.whenReady().then(boot).catch((err) => {
  console.error("Failed to start Converse:", err);
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && server) createWindow();
});
app.on("window-all-closed", async () => {
  if (server) await server.close().catch(() => {});
  if (process.platform !== "darwin") app.quit();
});
