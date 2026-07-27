import { describe, it, expect } from "vitest";
import { normalizeEvents } from "../src/server/gcal.js";

describe("normalizeEvents", () => {
  it("normalizes timed + all-day events and drops self/resource attendees", () => {
    const events = normalizeEvents([
      {
        id: "e1",
        summary: "Discovery — Northwind",
        start: { dateTime: "2026-07-28T15:00:00Z" },
        end: { dateTime: "2026-07-28T15:30:00Z" },
        attendees: [
          { email: "me@zer07labs.com", self: true },
          { email: "dana@northwind.com", displayName: "Dana (CFO)" },
          { email: "room@resource.calendar.google.com", resource: true },
        ],
        hangoutLink: "https://meet.google.com/abc",
      },
      { id: "e2", summary: "All-day offsite", start: { date: "2026-07-30" }, end: { date: "2026-07-31" } },
    ] as any);

    expect(events.length).toBe(2);
    expect(events[0]).toMatchObject({ id: "e1", title: "Discovery — Northwind", start: "2026-07-28T15:00:00Z", link: "https://meet.google.com/abc" });
    // self + resource attendees filtered out, displayName preferred
    expect(events[0]!.attendees).toEqual(["Dana (CFO)"]);
    // all-day uses the date field
    expect(events[1]).toMatchObject({ id: "e2", start: "2026-07-30", end: "2026-07-31", attendees: [] });
  });

  it("defaults a missing title and skips items without an id", () => {
    const events = normalizeEvents([{ start: {}, end: {} }, { id: "e3" }] as any);
    expect(events.length).toBe(1);
    expect(events[0]).toMatchObject({ id: "e3", title: "(no title)", attendees: [] });
  });

  it("returns [] for undefined", () => {
    expect(normalizeEvents(undefined)).toEqual([]);
  });
});
