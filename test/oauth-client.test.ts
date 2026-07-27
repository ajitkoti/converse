import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  saveOAuthClient,
  resolveOAuthClientPath,
  oauthClientConfigured,
  OAUTH_CLIENT_PASTED,
  OAUTH_CLIENT_BUNDLED,
} from "../src/server/gdrive.js";

// resolveOAuthClientPath / saveOAuthClient work off cwd-relative files, so run
// each test inside a throwaway cwd and restore the process state afterwards.
let tmp: string;
let cwd: string;
let envClient: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "converse-oauth-"));
  cwd = process.cwd();
  envClient = process.env.GOOGLE_OAUTH_CLIENT;
  delete process.env.GOOGLE_OAUTH_CLIENT;
  process.chdir(tmp);
});

afterEach(() => {
  process.chdir(cwd);
  if (envClient === undefined) delete process.env.GOOGLE_OAUTH_CLIENT;
  else process.env.GOOGLE_OAUTH_CLIENT = envClient;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const validClient = JSON.stringify({
  installed: {
    client_id: "abc.apps.googleusercontent.com",
    client_secret: "shh",
    redirect_uris: ["http://localhost"],
  },
});

describe("OAuth client resolution", () => {
  it("reports unconfigured when no client is present", () => {
    expect(resolveOAuthClientPath()).toBeUndefined();
    expect(oauthClientConfigured()).toBe(false);
  });

  it("rejects non-JSON input", () => {
    expect(() => saveOAuthClient("not json")).toThrow(/valid JSON/i);
    expect(fs.existsSync(OAUTH_CLIENT_PASTED)).toBe(false);
  });

  it("rejects JSON without an installed/web block", () => {
    expect(() => saveOAuthClient(JSON.stringify({ nope: true }))).toThrow(/installed.*web|client_id/i);
    expect(fs.existsSync(OAUTH_CLIENT_PASTED)).toBe(false);
  });

  it("stores a valid pasted client and then resolves it", () => {
    saveOAuthClient(validClient);
    expect(fs.existsSync(OAUTH_CLIENT_PASTED)).toBe(true);
    expect(resolveOAuthClientPath()).toBe(OAUTH_CLIENT_PASTED);
    expect(oauthClientConfigured()).toBe(true);
  });

  it("prefers the GOOGLE_OAUTH_CLIENT env path over a pasted client", () => {
    saveOAuthClient(validClient);
    const envPath = path.join(tmp, "env-client.json");
    fs.writeFileSync(envPath, validClient);
    process.env.GOOGLE_OAUTH_CLIENT = envPath;
    expect(resolveOAuthClientPath()).toBe(envPath);
  });

  it("falls back to a bundled client when nothing else is set", () => {
    fs.writeFileSync(OAUTH_CLIENT_BUNDLED, validClient);
    expect(resolveOAuthClientPath()).toBe(OAUTH_CLIENT_BUNDLED);
  });
});
