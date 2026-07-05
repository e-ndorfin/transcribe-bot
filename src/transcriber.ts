import { readFile } from "node:fs/promises";
import path from "node:path";

export type TranscriptionResult = {
  ok: boolean;
  text: string;
  items: TranscriptionItem[];
  error?: string;
};

export type TranscriptionItem = {
  text: string;
  startMs?: number;
  endMs?: number;
};

export type TranscribeOptions = {
  url: string;
  wavPath: string;
  speaker: string;
  userId: string;
  timeoutMs: number;
};

export async function transcribeWav(options: TranscribeOptions): Promise<TranscriptionResult> {
  if (isDisabledUrl(options.url)) {
    return {
      ok: false,
      text: "",
      items: [],
      error: "Transcription disabled by TRANSCRIBE_URL."
    };
  }

  try {
    const form = new FormData();
    const audio = await readFile(options.wavPath);
    const blob = new Blob([audio], { type: "audio/wav" });

    form.set("file", blob, path.basename(options.wavPath));
    form.set("speaker", options.speaker);
    form.set("userId", options.userId);

    const requestInit: RequestInit = {
      method: "POST",
      body: form
    };
    if (options.timeoutMs > 0) {
      requestInit.signal = AbortSignal.timeout(options.timeoutMs);
    }

    const response = await fetch(options.url, requestInit);

    const responseText = await response.text();

    if (!response.ok) {
      return {
        ok: false,
        text: "",
        items: [],
        error: `Transcription server returned HTTP ${response.status}: ${responseText.slice(0, 500)}`
      };
    }

    const parsed = normalizeResponseText(responseText);
    return {
      ok: true,
      text: parsed.text,
      items: parsed.items
    };
  } catch (error) {
    return {
      ok: false,
      text: "",
      items: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function isDisabledUrl(url: string): boolean {
  const normalized = url.trim().toLowerCase();
  return normalized === "" || normalized === "off" || normalized === "disabled" || normalized === "none";
}

function normalizeResponseText(responseText: string): { text: string; items: TranscriptionItem[] } {
  const trimmed = responseText.trim();
  if (!trimmed) {
    return { text: "", items: [] };
  }

  try {
    const json = JSON.parse(trimmed) as unknown;
    const items = extractItems(json);
    const extracted = extractText(json)?.trim() || items.map((item) => item.text).join(" ").trim();
    return { text: extracted, items };
  } catch {
    // Plain text is a valid transcription response.
  }

  return { text: trimmed, items: [] };
}

function extractText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  for (const key of ["text", "transcript", "output", "result"]) {
    if (typeof record[key] === "string") {
      return record[key] as string;
    }
  }

  const list = Array.isArray(record.sentences) ? record.sentences : record.segments;
  if (Array.isArray(list)) {
    const segmentText = list
      .map((segment) => {
        if (typeof segment === "string") {
          return segment;
        }
        if (segment && typeof segment === "object" && typeof (segment as Record<string, unknown>).text === "string") {
          return (segment as Record<string, string>).text;
        }
        return "";
      })
      .filter(Boolean)
      .join(" ");

    return segmentText || undefined;
  }

  return undefined;
}

function extractItems(value: unknown): TranscriptionItem[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  const list = Array.isArray(record.sentences) ? record.sentences : record.segments;
  if (!Array.isArray(list)) {
    return [];
  }

  return list
    .map((item): TranscriptionItem | undefined => {
      if (typeof item === "string") {
        const text = item.trim();
        return text ? { text } : undefined;
      }

      if (!item || typeof item !== "object") {
        return undefined;
      }

      const itemRecord = item as Record<string, unknown>;
      const text = typeof itemRecord.text === "string" ? itemRecord.text.trim() : "";
      if (!text) {
        return undefined;
      }

      return {
        text,
        startMs: secondsFieldToMs(itemRecord.start),
        endMs: secondsFieldToMs(itemRecord.end)
      };
    })
    .filter((item): item is TranscriptionItem => item !== undefined);
}

function secondsFieldToMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return Math.max(0, Math.round(value * 1_000));
}
