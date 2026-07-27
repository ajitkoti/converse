import { describe, it, expect, vi } from "vitest";
import { DeepgramLive } from "../src/server/deepgram.js";

class FakeSock {
  handlers: Record<string, (...a: unknown[]) => void> = {};
  readyState = 1; // OPEN
  bufferedAmount = 0;
  sent: unknown[] = [];
  closed = false;
  on(ev: string, cb: (...a: unknown[]) => void) { this.handlers[ev] = cb; }
  fire(ev: string, ...a: unknown[]) { this.handlers[ev]?.(...a); }
  send(d: unknown) { this.sent.push(d); }
  close() { this.closed = true; }
  removeAllListeners() {}
}

function makeFactory() {
  const created: FakeSock[] = [];
  const factory = () => {
    const s = new FakeSock();
    created.push(s);
    return s as unknown as import("../src/server/deepgram.js").DeepgramSocket;
  };
  return { created, factory };
}

describe("DeepgramLive resilience", () => {
  it("auto-reconnects with backoff on an unexpected drop", () => {
    vi.useFakeTimers();
    const { created, factory } = makeFactory();
    const dg = new DeepgramLive({ apiKey: "k", socketFactory: factory });
    let opened = 0, reconnecting = 0, reconnected = 0;
    dg.on("open", () => opened++);
    dg.on("reconnecting", () => reconnecting++);
    dg.on("reconnected", () => reconnected++);

    created[0]!.fire("open");
    expect(opened).toBe(1);

    created[0]!.fire("close"); // network blip
    expect(reconnecting).toBe(1);
    expect(created.length).toBe(1);

    vi.advanceTimersByTime(1100); // ~1s backoff
    expect(created.length).toBe(2); // reconnected socket created
    created[1]!.fire("open");
    expect(reconnected).toBe(1);
    vi.useRealTimers();
  });

  it("does not reconnect after finish()", () => {
    const { created, factory } = makeFactory();
    const dg = new DeepgramLive({ apiKey: "k", socketFactory: factory });
    created[0]!.fire("open");
    let closed = 0, reconnecting = 0;
    dg.on("close", () => closed++);
    dg.on("reconnecting", () => reconnecting++);
    dg.finish();
    created[0]!.fire("close");
    expect(closed).toBe(1);
    expect(reconnecting).toBe(0);
    expect(created.length).toBe(1);
  });

  it("drops audio under backpressure but sends when the buffer is clear", () => {
    const { created, factory } = makeFactory();
    const dg = new DeepgramLive({ apiKey: "k", socketFactory: factory });
    created[0]!.fire("open");
    const s = created[0]!;

    s.bufferedAmount = 0;
    dg.send(Buffer.from([1, 2]));
    expect(s.sent.length).toBe(1);

    s.bufferedAmount = 2 * 1024 * 1024; // exceed the cap
    dg.send(Buffer.from([3, 4]));
    expect(s.sent.length).toBe(1); // dropped
    expect(dg.stats.droppedBackpressure).toBe(1);
  });

  it("drops audio while disconnected", () => {
    const { created, factory } = makeFactory();
    const dg = new DeepgramLive({ apiKey: "k", socketFactory: factory });
    // never fired 'open' → not connected
    dg.send(Buffer.from([1]));
    expect(created[0]!.sent.length).toBe(0);
    expect(dg.stats.droppedWhileDown).toBe(1);
  });
});
