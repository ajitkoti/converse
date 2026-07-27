/**
 * Pre-recorded transcription — turn a stored audio recording into a transcript
 * when a call has no transcript yet (e.g. an audio file dropped into Drive).
 * Uses Deepgram's pre-recorded REST endpoint with diarization + utterances.
 *
 * The HTTP call takes an injectable `fetchImpl` and the response parser is a
 * pure function, so both are unit-tested without hitting the network. Speaker
 * mapping is best-effort: a mixed mono recording can't reliably tell the rep
 * from the prospect, so diarized speaker 0 → "rep" and everyone else →
 * "prospect" (the AI debrief reads the transcript regardless).
 */

import type { TranscriptLine } from "./types.js";
import type { SessionRecord } from "./types.js";

export interface PrerecordedResult {
  text: string;
  lines: TranscriptLine[];
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: Buffer }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Parse a Deepgram pre-recorded response into transcript lines (pure). */
export function parsePrerecorded(json: unknown): PrerecordedResult {
  const root = (json ?? {}) as Record<string, any>;
  const utterances = root?.results?.utterances;
  const lines: TranscriptLine[] = [];
  if (Array.isArray(utterances)) {
    for (const u of utterances) {
      const text = String(u?.transcript ?? "").trim();
      if (!text) continue;
      lines.push({
        speaker: Number(u?.speaker) === 0 ? "rep" : "prospect",
        text,
        tsStart: Math.round((Number(u?.start) || 0) * 1000),
        tsEnd: Math.round((Number(u?.end) || 0) * 1000),
      });
    }
  }
  const alt = root?.results?.channels?.[0]?.alternatives?.[0];
  const flat = String(alt?.transcript ?? "").trim();
  if (!lines.length && flat) lines.push({ speaker: "prospect", text: flat, tsStart: 0, tsEnd: 0 });
  const text = lines.length ? lines.map((l) => l.text).join(" ") : flat;
  return { text, lines };
}

/** Transcribe an audio buffer via Deepgram's pre-recorded API. */
export async function deepgramPrerecorded(
  apiKey: string,
  audio: Buffer,
  opts: { model?: string; contentType?: string; fetchImpl?: FetchLike } = {},
): Promise<PrerecordedResult> {
  const model = opts.model ?? "nova-2";
  const fetchImpl = (opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike));
  const url = `https://api.deepgram.com/v1/listen?model=${encodeURIComponent(model)}&smart_format=true&punctuate=true&diarize=true&utterances=true`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { Authorization: `Token ${apiKey}`, "Content-Type": opts.contentType ?? "audio/webm" },
    body: audio,
  });
  if (!res.ok) throw new Error(`Deepgram pre-recorded failed: ${res.status}`);
  return parsePrerecorded(await res.json());
}

/** Build a minimal SessionRecord from transcript lines (for an audio-only call). */
export function recordFromTranscript(id: string, lines: TranscriptLine[], nowIso: string): SessionRecord {
  let repMs = 0;
  let prospectMs = 0;
  for (const l of lines) {
    const d = Math.max(0, l.tsEnd - l.tsStart);
    if (l.speaker === "rep") repMs += d;
    else prospectMs += d;
  }
  const durationMs = lines.length ? Math.max(...lines.map((l) => l.tsEnd)) : 0;
  return {
    id,
    startedAt: nowIso,
    endedAt: nowIso,
    mode: "live",
    framework: "meddpicc",
    durationMs,
    slotDefs: [],
    slots: {} as SessionRecord["slots"],
    transcript: lines,
    suggestions: [],
    talk: { repMs, prospectMs },
  };
}
