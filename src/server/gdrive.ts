/**
 * Google Drive export. Optional and gracefully degrading: if no credentials are
 * configured the app still saves everything locally and the UI just shows Drive
 * as "not connected". Two auth paths, checked in order:
 *
 *   1. OAuth (recommended for personal use):
 *        - put your OAuth client json at the path in GOOGLE_OAUTH_CLIENT
 *        - run `npm run connect-drive` once → saves .gdrive-token.json
 *   2. Service account:
 *        - set GOOGLE_APPLICATION_CREDENTIALS to the service-account json
 *        - share your target Drive folder with the service-account email
 *
 * Target folder: settings.driveFolderId, else GDRIVE_FOLDER_ID, else Drive root.
 * That folder id may live in a **Shared Drive** (Team Drive): every call passes
 * the all-drives flags, and the scope is full `drive`, so a team can point every
 * member's app at the same Shared Drive folder and share one call database. The
 * broad scope is required because `drive.file` only exposes files THIS app
 * created for THIS user — teammates couldn't see each other's calls.
 */

import * as fs from "node:fs";
import { google, type drive_v3 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

export const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive"];
export const TOKEN_PATH = ".gdrive-token.json";

/** Flags that make every Files API call work inside Shared Drives too. */
const ALL_DRIVES = { supportsAllDrives: true, includeItemsFromAllDrives: true } as const;

export interface DriveFileInput {
  name: string;
  mimeType: string;
  content: string | Buffer;
}

export interface DriveStatus {
  connected: boolean;
  method: "oauth" | "service-account" | "none";
  reason?: string;
}

export interface DriveEntry {
  id: string;
  name: string;
  modifiedTime?: string;
}

/**
 * The subset of Drive operations the higher-level `DriveDb` needs. DriveExporter
 * implements it against the real API; tests inject an in-memory fake so the
 * database logic can be verified without Google credentials.
 */
export interface DriveClient {
  status(): DriveStatus;
  ensureFolder(name: string, parentId?: string): Promise<string>;
  /** find a file by exact name within a folder */
  findFile(name: string, folderId: string): Promise<DriveEntry | null>;
  /** create the file, or overwrite it in place if one with that name already exists */
  putFile(file: DriveFileInput, folderId: string): Promise<{ id: string; link: string }>;
  /** read a file's contents as a string */
  readFile(fileId: string): Promise<string>;
  /** read a file's raw bytes (for binary files like recordings) */
  readFileBinary(fileId: string): Promise<Buffer>;
  /** list files directly inside a folder */
  listFolder(folderId: string): Promise<DriveEntry[]>;
}

export function buildOAuthClient(clientJsonPath: string, redirectOverride?: string): OAuth2Client {
  const raw = JSON.parse(fs.readFileSync(clientJsonPath, "utf8"));
  const creds = raw.installed ?? raw.web;
  if (!creds) throw new Error("OAuth client json missing 'installed'/'web' block");
  const redirect = redirectOverride ?? creds.redirect_uris?.[0] ?? "http://localhost:5273/oauth2callback";
  return new google.auth.OAuth2(creds.client_id, creds.client_secret, redirect);
}

/** Is an OAuth client configured (so the web sign-in flow is possible)? */
export function oauthClientConfigured(): boolean {
  const p = process.env.GOOGLE_OAUTH_CLIENT;
  return !!p && fs.existsSync(p);
}

export class DriveExporter implements DriveClient {
  #drive: drive_v3.Drive | null = null;
  #status: DriveStatus = { connected: false, method: "none" };

  constructor() {
    this.#init();
  }

  /** Re-read credentials/token (e.g. after the web sign-in flow saves a token). */
  reload(): void {
    this.#init();
  }

  #init(): void {
    try {
      const clientPath = process.env.GOOGLE_OAUTH_CLIENT;
      if (clientPath && fs.existsSync(clientPath) && fs.existsSync(TOKEN_PATH)) {
        const oauth = buildOAuthClient(clientPath);
        oauth.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8")));
        this.#drive = google.drive({ version: "v3", auth: oauth });
        this.#status = { connected: true, method: "oauth" };
        return;
      }
      if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        const auth = new google.auth.GoogleAuth({ scopes: DRIVE_SCOPES });
        this.#drive = google.drive({ version: "v3", auth });
        this.#status = { connected: true, method: "service-account" };
        return;
      }
      this.#status = {
        connected: false,
        method: "none",
        reason: "No Drive credentials. See .env.example → set up GOOGLE_OAUTH_CLIENT and run `npm run connect-drive`.",
      };
    } catch (err) {
      this.#status = { connected: false, method: "none", reason: String(err) };
    }
  }

  status(): DriveStatus {
    return this.#status;
  }

  /** Ensure a named subfolder exists under parent; returns its id. */
  async ensureFolder(name: string, parentId?: string): Promise<string> {
    if (!this.#drive) throw new Error("Drive not connected");
    const q = [
      `name = '${name.replace(/'/g, "\\'")}'`,
      "mimeType = 'application/vnd.google-apps.folder'",
      "trashed = false",
      parentId ? `'${parentId}' in parents` : "",
    ]
      .filter(Boolean)
      .join(" and ");
    const found = await this.#drive.files.list({ q, fields: "files(id)", pageSize: 1, ...ALL_DRIVES });
    const hit = found.data.files?.[0]?.id;
    if (hit) return hit;
    const made = await this.#drive.files.create({
      requestBody: {
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: parentId ? [parentId] : undefined,
      },
      fields: "id",
      supportsAllDrives: true,
    });
    return made.data.id!;
  }

  /** Find a file by exact name within a folder (non-trashed). */
  async findFile(name: string, folderId: string): Promise<DriveEntry | null> {
    if (!this.#drive) throw new Error("Drive not connected");
    const q = [
      `name = '${name.replace(/'/g, "\\'")}'`,
      `'${folderId}' in parents`,
      "trashed = false",
    ].join(" and ");
    const res = await this.#drive.files.list({ q, fields: "files(id, name, modifiedTime)", pageSize: 1, ...ALL_DRIVES });
    const hit = res.data.files?.[0];
    return hit?.id ? { id: hit.id, name: hit.name ?? name, modifiedTime: hit.modifiedTime ?? undefined } : null;
  }

  /** Create a file, or overwrite it in place if one with the same name exists in the folder. */
  async putFile(file: DriveFileInput, folderId: string): Promise<{ id: string; link: string }> {
    if (!this.#drive) throw new Error("Drive not connected");
    const existing = await this.findFile(file.name, folderId);
    if (existing) {
      const res = await this.#drive.files.update({
        fileId: existing.id,
        media: { mimeType: file.mimeType, body: file.content },
        fields: "id, webViewLink",
        supportsAllDrives: true,
      });
      return { id: res.data.id!, link: res.data.webViewLink ?? "" };
    }
    const res = await this.#drive.files.create({
      requestBody: { name: file.name, parents: [folderId] },
      media: { mimeType: file.mimeType, body: file.content },
      fields: "id, webViewLink",
      supportsAllDrives: true,
    });
    return { id: res.data.id!, link: res.data.webViewLink ?? "" };
  }

  /** Read a file's contents as a string. */
  async readFile(fileId: string): Promise<string> {
    if (!this.#drive) throw new Error("Drive not connected");
    const res = await this.#drive.files.get({ fileId, alt: "media", supportsAllDrives: true }, { responseType: "text" });
    return typeof res.data === "string" ? res.data : JSON.stringify(res.data);
  }

  /** Read a file's raw bytes (for binary files like recordings). */
  async readFileBinary(fileId: string): Promise<Buffer> {
    if (!this.#drive) throw new Error("Drive not connected");
    const res = await this.#drive.files.get({ fileId, alt: "media", supportsAllDrives: true }, { responseType: "arraybuffer" });
    return Buffer.from(res.data as ArrayBuffer);
  }

  /** List files directly inside a folder (non-trashed), newest first. */
  async listFolder(folderId: string): Promise<DriveEntry[]> {
    if (!this.#drive) throw new Error("Drive not connected");
    const q = `'${folderId}' in parents and trashed = false`;
    const res = await this.#drive.files.list({
      q,
      fields: "files(id, name, modifiedTime)",
      orderBy: "modifiedTime desc",
      pageSize: 1000,
      ...ALL_DRIVES,
    });
    return (res.data.files ?? []).map((f) => ({ id: f.id!, name: f.name ?? "", modifiedTime: f.modifiedTime ?? undefined }));
  }

  /** Permanently delete a file or folder by id (folders cascade). */
  async deleteFile(fileId: string): Promise<void> {
    if (!this.#drive) throw new Error("Drive not connected");
    await this.#drive.files.delete({ fileId, supportsAllDrives: true });
  }

  /** Upload files into a folder. Returns [{name, id, link}]. */
  async upload(
    files: DriveFileInput[],
    folderId?: string,
  ): Promise<Array<{ name: string; id: string; link: string }>> {
    if (!this.#drive) throw new Error("Drive not connected");
    const out: Array<{ name: string; id: string; link: string }> = [];
    for (const f of files) {
      const res = await this.#drive.files.create({
        requestBody: { name: f.name, parents: folderId ? [folderId] : undefined },
        media: { mimeType: f.mimeType, body: f.content },
        fields: "id, webViewLink",
        supportsAllDrives: true,
      });
      out.push({ name: f.name, id: res.data.id!, link: res.data.webViewLink ?? "" });
    }
    return out;
  }
}
