import { Mp3Encoder } from "@breezystack/lamejs";
import { GoogleGenAI } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GUIDE_LANGUAGES } from "../../../lib/audioguide";

export const runtime = "nodejs";
export const maxDuration = 300;

const VALID_VOICES = new Set(["Kore", "Achernar", "Aoede", "Charon", "Gacrux", "Iapetus", "Sulafat", "Schedar", "Achird"]);
const TERMINAL_STATES = new Set(["JOB_STATE_SUCCEEDED", "JOB_STATE_FAILED", "JOB_STATE_CANCELLED", "JOB_STATE_EXPIRED"]);

function client() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("MISSING_API_KEY");
  return new GoogleGenAI({ apiKey });
}

function isQuotaError(error: unknown) {
  const record = error as { status?: number; code?: number; message?: string };
  return record?.status === 429
    || record?.code === 429
    || /RESOURCE_EXHAUSTED|exceeded your current quota|rate.?limit/i.test(record?.message ?? "");
}

function speechPrompt(text: string, style: string, languageId: string) {
  const language = GUIDE_LANGUAGES.find((item) => item.id === languageId);
  const languageLock = language
    ? `MANDATORY LANGUAGE LOCK:\nThe transcript is in ${language.speechName}. Speak exclusively in this language with native pronunciation. Never translate, paraphrase, or switch language. Foreign names and Italian place names must not cause a change of language or accent.`
    : "Detect the transcript language and keep that same language and accent for the entire recording.";
  return `Generate spoken narration from the transcript below. Speak only the transcript and begin immediately. Never read these instructions aloud.\n\n${languageLock}\n\nPERFORMANCE DIRECTION (this controls style only, never language):\n${style}\nKeep the selected voice, accent, pace, pitch and energy consistent with every other segment in this job.\n\n### TRANSCRIPT\n${text}`;
}

type BatchMp3Result = {
  mp3: Buffer;
  warnings: string[];
  repairedSegments: number;
};

type BatchFallback = {
  chunks: string[];
  voice: string;
  style: string;
  language: string;
};

function encodeMp3(buffers: Buffer[]) {
  const pcm = Buffer.concat(buffers);
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  const encoder = new Mp3Encoder(1, 24000, 128);
  const output: Uint8Array[] = [];
  for (let index = 0; index < samples.length; index += 1152) {
    const encoded = encoder.encodeBuffer(samples.subarray(index, index + 1152));
    if (encoded.length) output.push(Uint8Array.from(encoded));
  }
  const flushed = encoder.flush();
  if (flushed.length) output.push(Uint8Array.from(flushed));
  return Buffer.concat(output);
}

function mp3Response(buffer: Buffer, fileName: string, repairedSegments: number) {
  const safeName = fileName.replace(/[^\w.\- ]+/g, "_").replace(/[\r\n"]/g, "_").slice(0, 180) || "voce.mp3";
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < buffer.byteLength; offset += 64 * 1024) {
        controller.enqueue(new Uint8Array(buffer.subarray(offset, offset + 64 * 1024)));
      }
      controller.close();
    },
  });
  return new NextResponse(stream, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Content-Disposition": `attachment; filename="${safeName}"`,
      "Cache-Control": "private, no-store",
      "X-Voce-Repaired-Segments": String(repairedSegments),
    },
  });
}

async function synthesizeFallback(text: string, voice: string, style: string, language: string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await client().models.generateContent({
        model: process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: speechPrompt(text, style, language) }] }],
        config: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      });
      const data = findInlineAudioData(response);
      if (data) return Buffer.from(data, "base64");
      lastError = new Error("Gemini non ha restituito audio nel tentativo di riparazione.");
    } catch (error) {
      lastError = error;
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 900 * (attempt + 1)));
  }
  throw lastError instanceof Error ? lastError : new Error("Riparazione segmento non riuscita.");
}

function findInlineAudioData(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const inline = record.inlineData ?? record.inline_data;
  if (inline && typeof inline === "object") {
    const data = (inline as Record<string, unknown>).data;
    if (typeof data === "string" && data.trim()) return data;
  }
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const data = findInlineAudioData(item);
        if (data) return data;
      }
    } else if (child && typeof child === "object") {
      const data = findInlineAudioData(child);
      if (data) return data;
    }
  }
  return undefined;
}

function rowTextPreview(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const text = typeof record.text === "string" ? record.text : "";
  if (text) return text.slice(0, 180);
  for (const child of Object.values(record)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const preview = rowTextPreview(item);
        if (preview) return preview;
      }
    } else if (child && typeof child === "object") {
      const preview = rowTextPreview(child);
      if (preview) return preview;
    }
  }
  return "";
}

function chunkIndexFromKey(key: unknown, fallbackIndex: number) {
  const match = String(key ?? "").match(/(\d+)$/);
  return match ? Number(match[1]) : fallbackIndex;
}

async function buildBatchMp3(outputFile: string, fallback?: BatchFallback): Promise<BatchMp3Result> {
  const outputPath = join(tmpdir(), `voce-results-${randomUUID()}.jsonl`);
  try {
    await client().files.download({ file: outputFile, downloadPath: outputPath });
  } catch (error) {
    await unlink(outputPath).catch(() => undefined);
    throw error;
  }
  const rawResults = await readFile(outputPath, "utf8");
  await unlink(outputPath).catch(() => undefined);
  const rows = rawResults.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const ordered = rows.sort((a, b) => String(a.key ?? "").localeCompare(String(b.key ?? "")));
  const audioByIndex = new Map<number, Buffer>();
  const missing = new Map<number, string>();
  const warnings: string[] = [];
  ordered.forEach((item, rowIndex) => {
    const index = chunkIndexFromKey(item.key, rowIndex);
    const key = String(item.key ?? `segmento-${index + 1}`);
    if (item.error || item.status) {
      missing.set(index, `${key}: ${item.error?.message || item.status?.message || "segmento non riuscito"}`);
      return;
    }
    const data = findInlineAudioData(item.response);
    if (!data) {
      const preview = rowTextPreview(item.response);
      missing.set(index, `${key}: nessun audio restituito${preview ? ` (${preview})` : ""}`);
      return;
    }
    audioByIndex.set(index, Buffer.from(data, "base64"));
  });

  const expectedSegments = fallback?.chunks.length ?? Math.max(ordered.length, Math.max(...audioByIndex.keys(), -1) + 1);
  for (let index = 0; index < expectedSegments; index++) {
    if (!audioByIndex.has(index)) missing.set(index, missing.get(index) ?? `chunk-${String(index).padStart(4, "0")}: audio mancante`);
  }

  let repairedSegments = 0;
  if (missing.size) {
    if (!fallback?.chunks.length) {
      throw new Error("Uno o più segmenti non contengono audio. Per rigenerarli serve un job creato con la nuova versione dell’app: reinvia questa audioguida in Batch.");
    }
    for (const [index, reason] of [...missing.entries()].sort((a, b) => a[0] - b[0])) {
      const text = fallback.chunks[index]?.trim();
      if (!text) throw new Error(`Il segmento ${index + 1} è mancante e non trovo il testo originale per rigenerarlo.`);
      warnings.push(`${reason}; rigenerato con TTS standard`);
      audioByIndex.set(index, await synthesizeFallback(text, fallback.voice, fallback.style, fallback.language));
      repairedSegments++;
    }
  }

  const audio = [...audioByIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, buffer]) => buffer);
  if (audio.length !== expectedSegments) throw new Error("Impossibile creare un MP3 completo: alcuni segmenti non sono stati recuperati.");
  return { mp3: encodeMp3(audio), warnings, repairedSegments };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (body.action === "result") {
      const name = typeof body.name === "string" ? body.name : "";
      const fileName = typeof body.fileName === "string" ? body.fileName : `${name.replace(/[^\w.-]+/g, "_")}.mp3`;
      const voice = VALID_VOICES.has(body.voice) ? body.voice : "Kore";
      const language = typeof body.language === "string" ? body.language : "";
      const style = typeof body.style === "string" ? body.style.trim().slice(0, 500) : "Leggi in modo naturale e chiaro.";
      const chunks = Array.isArray(body.chunks)
        ? body.chunks.filter((chunk: unknown) => typeof chunk === "string" && chunk.trim()).slice(0, 200)
        : [];
      if (!name.startsWith("batches/")) return NextResponse.json({ error: "Job Batch non valido." }, { status: 400 });
      if (!chunks.length) return NextResponse.json({ error: "Testi dei segmenti mancanti: non posso garantire un MP3 completo. Reinvia il Batch con la nuova versione dell’app." }, { status: 400 });
      if (chunks.some((chunk: string) => chunk.length > 1200)) {
        return NextResponse.json({ error: "Uno dei segmenti da riparare supera 1.200 caratteri." }, { status: 400 });
      }
      const job = await client().batches.get({ name });
      if (job.state !== "JOB_STATE_SUCCEEDED") {
        return NextResponse.json({ error: "Il job non è ancora completato.", state: job.state }, { status: 409 });
      }
      const outputFile = job.dest?.fileName;
      if (!outputFile) return NextResponse.json({ error: "Il job non contiene un file di risultati." }, { status: 502 });
      const result = await buildBatchMp3(outputFile, { chunks, voice, style, language });
      return mp3Response(result.mp3, fileName, result.repairedSegments);
    }

    const displayName = typeof body.displayName === "string" ? body.displayName.slice(0, 120) : "Audioguida";
    const voice = VALID_VOICES.has(body.voice) ? body.voice : "Kore";
    const language = typeof body.language === "string" ? body.language : "";
    const style = typeof body.style === "string" ? body.style.trim().slice(0, 500) : "Leggi in modo naturale e chiaro.";
    const chunks = Array.isArray(body.chunks)
      ? body.chunks.filter((chunk: unknown) => typeof chunk === "string" && chunk.trim()).slice(0, 200)
      : [];
    if (!chunks.length) return NextResponse.json({ error: "Nessun segmento da elaborare." }, { status: 400 });
    if (chunks.some((chunk: string) => chunk.length > 1200)) {
      return NextResponse.json({ error: "Uno dei segmenti supera 1.200 caratteri." }, { status: 400 });
    }

    const ai = client();
    const inputPath = join(tmpdir(), `voce-batch-${randomUUID()}.jsonl`);
    const jsonl = chunks.map((text: string, index: number) => JSON.stringify({
      key: `chunk-${String(index).padStart(4, "0")}`,
      request: {
        contents: [{ parts: [{ text: speechPrompt(text, style, language) }] }],
        generation_config: {
          response_modalities: ["AUDIO"],
          speech_config: {
            voice_config: { prebuilt_voice_config: { voice_name: voice } },
          },
        },
      },
    })).join("\n");
    await writeFile(inputPath, `${jsonl}\n`, "utf8");
    let uploaded;
    try {
      uploaded = await ai.files.upload({ file: inputPath, config: { mimeType: "application/jsonl", displayName } });
    } finally {
      await unlink(inputPath).catch(() => undefined);
    }
    if (!uploaded.name) throw new Error("Google non ha restituito il riferimento al file Batch.");
    const job = await ai.batches.create({
      model: process.env.GEMINI_BATCH_TTS_MODEL || "gemini-3.1-flash-tts-preview",
      src: uploaded.name,
      config: { displayName },
    });
    return NextResponse.json({
      name: job.name,
      state: job.state,
      displayName: job.displayName,
      createTime: job.createTime,
      inputFile: uploaded.name,
    });
  } catch (error) {
    if ((error as Error).message === "MISSING_API_KEY") {
      return NextResponse.json({ error: "Configura GEMINI_API_KEY nel file .env.local." }, { status: 503 });
    }
    if (isQuotaError(error)) {
      return NextResponse.json({
        error: "Quota Batch Gemini momentaneamente esaurita. L’app completerà e salverà i job già accettati, attenderà 60 secondi e poi riproverà quelli rimasti.",
        quotaExceeded: true,
        retryAfter: 60,
      }, {
        status: 429,
        headers: { "Retry-After": "60" },
      });
    }
    console.error("Batch create error", error);
    return NextResponse.json({ error: (error as Error).message || "Impossibile creare il job Batch." }, { status: 502 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const name = request.nextUrl.searchParams.get("name");
    const download = request.nextUrl.searchParams.get("download") === "1";
    const fileName = request.nextUrl.searchParams.get("fileName") || `${name?.replace(/[^\w.-]+/g, "_")}.mp3`;
    if (!name?.startsWith("batches/")) return NextResponse.json({ error: "Job Batch non valido." }, { status: 400 });
    const job = await client().batches.get({ name });

    if (!download) {
      return NextResponse.json({
        name: job.name,
        state: job.state,
        createTime: job.createTime,
        updateTime: job.updateTime,
        endTime: job.endTime,
        error: job.error?.message,
        terminal: TERMINAL_STATES.has(job.state ?? ""),
      });
    }
    if (job.state !== "JOB_STATE_SUCCEEDED") {
      return NextResponse.json({ error: "Il job non è ancora completato.", state: job.state }, { status: 409 });
    }
    const outputFile = job.dest?.fileName;
    if (!outputFile) return NextResponse.json({ error: "Il job non contiene un file di risultati." }, { status: 502 });
    const result = await buildBatchMp3(outputFile);
    return mp3Response(result.mp3, fileName, result.repairedSegments);
  } catch (error) {
    console.error("Batch get error", error);
    return NextResponse.json({ error: (error as Error).message || "Impossibile recuperare il job Batch." }, { status: 502 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const name = request.nextUrl.searchParams.get("name");
    if (!name?.startsWith("batches/")) return NextResponse.json({ error: "Job Batch non valido." }, { status: 400 });
    await client().batches.cancel({ name });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message || "Impossibile annullare il job." }, { status: 502 });
  }
}
