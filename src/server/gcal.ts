/**
 * Google Calendar (read-only). Reuses the same OAuth token as Drive (one Google
 * sign-in grants both drive.file and calendar.readonly), so connecting Drive via
 * the web flow also lights up Calendar. Gracefully disabled when unconfigured.
 *
 * Upcoming/recent meetings feed the pre-call brief: pick a meeting and its title
 * + attendees prefill the account/persona. The event normalizer is a pure,
 * tested function; the API call is a thin wrapper.
 */

import * as fs from "node:fs";
import { google, type calendar_v3 } from "googleapis";
import { buildOAuthClient, resolveOAuthClientPath, TOKEN_PATH } from "./gdrive.js";

export const CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];

export interface CalEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  attendees: string[];
  link?: string;
}

/** Normalize Google Calendar event items into our slim shape (pure). */
export function normalizeEvents(items: calendar_v3.Schema$Event[] | undefined): CalEvent[] {
  return (items ?? [])
    .map((e) => ({
      id: String(e.id ?? ""),
      title: String(e.summary ?? "(no title)"),
      start: e.start?.dateTime ?? e.start?.date ?? "",
      end: e.end?.dateTime ?? e.end?.date ?? "",
      attendees: Array.isArray(e.attendees)
        ? e.attendees
            .filter((a) => !a.self && !a.resource)
            .map((a) => a.displayName || a.email || "")
            .filter(Boolean)
        : [],
      link: e.hangoutLink ?? e.htmlLink ?? undefined,
    }))
    .filter((e) => e.id);
}

export class CalendarClient {
  #cal: calendar_v3.Calendar | null = null;
  #connected = false;

  constructor() {
    this.reload();
  }

  reload(): void {
    try {
      const clientPath = resolveOAuthClientPath();
      if (clientPath && fs.existsSync(TOKEN_PATH)) {
        const oauth = buildOAuthClient(clientPath);
        oauth.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8")));
        this.#cal = google.calendar({ version: "v3", auth: oauth });
        this.#connected = true;
        return;
      }
      if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        const auth = new google.auth.GoogleAuth({ scopes: CALENDAR_SCOPES });
        this.#cal = google.calendar({ version: "v3", auth });
        this.#connected = true;
        return;
      }
      this.#cal = null;
      this.#connected = false;
    } catch {
      this.#cal = null;
      this.#connected = false;
    }
  }

  status(): { connected: boolean } {
    return { connected: this.#connected };
  }

  /**
   * Meetings in a ±2-week window. `nowMs` is injectable for tests. Note: the
   * token must carry the calendar scope (reconnect Google if it was granted for
   * Drive only) or the API call throws — the caller surfaces that.
   */
  async listEvents(range: "upcoming" | "recent", opts: { max?: number; nowMs?: number } = {}): Promise<CalEvent[]> {
    if (!this.#cal) throw new Error("Calendar not connected");
    const max = opts.max ?? 8;
    const now = new Date(opts.nowMs ?? Date.now());
    const twoWeeks = 14 * 24 * 60 * 60 * 1000;
    const params =
      range === "recent"
        ? { timeMin: new Date(now.getTime() - twoWeeks).toISOString(), timeMax: now.toISOString() }
        : { timeMin: now.toISOString(), timeMax: new Date(now.getTime() + twoWeeks).toISOString() };
    const res = await this.#cal.events.list({
      calendarId: "primary",
      singleEvents: true,
      orderBy: "startTime",
      maxResults: max,
      ...params,
    });
    const events = normalizeEvents(res.data.items ?? undefined);
    return range === "recent" ? events.reverse() : events; // recent: most-recent first
  }
}
