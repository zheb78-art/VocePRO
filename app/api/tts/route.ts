import { GoogleGenAI } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";
import { GUIDE_LANGUAGES } from "../../../lib/audioguide";

export const runtime = "nodejs";
export const maxDuration = 60;

const VALID_VOICES = new Set(["Kore", "Achernar", "Aoede", "Charon", "Gacrux", "Iapetus", "Sulafat", "Schedar", "Achird"]);

function getQuotaDetails(error: unknown) {
  const raw = (error as Error)?.message ?? "";
  try {
    const start = raw.indexOf('{"error"');
    const payload = JSON.parse(start >= 0 ? raw.slice(start) : raw);
    const details = payload?.error?.details ?? [];
    const retryInfo = details.find((item: Record<string, string>) => item["@type"]?.endsWith("RetryInfo"));
    const quotaInfo = details.find((item: Record<string, string>) => item["@type"]?.endsWith("QuotaFailure"));
    const violation = quotaInfo?.violations?.[0];
    const retryAfter = Math.ceil(Number.parseFloat(retryInfo?.retryDelay ?? "0"));
    const quotaId = String(violation?.quotaId ?? "");
    const metric = String(violation?.quotaMetric ?? "");
    return {
      retryAfter: Number.isFinite(retryAfter) ? retryAfter : 0,
      isFreeTier: /free.?tier/i.test(`${quotaId} ${metric}`),
      metric: metric.split("/").pop() ?? "",
    };
  } catch {
    return { retryAfter: 0, isFreeTier: /free.?tier/i.test(raw), metric: "" };
  }
}

function formatWait(seconds: number) {
  if (seconds < 60) return `${seconds} secondi`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} minuti`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours} ora e ${remainingMinutes} minuti` : `${hours} ora`;
}

async function synthesize(text: string, voice: string, style: string, languageId: string, attempt = 0) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("MISSING_API_KEY");
  const ai = new GoogleGenAI({ apiKey });
  const language = GUIDE_LANGUAGES.find((item) => item.id === languageId);
  const languageLock = language
    ? `The transcript is in ${language.speechName}. Speak exclusively in this language with native pronunciation. Never translate or switch language because of foreign names.`
    : "Detect the transcript language and keep it unchanged.";
  const prompts = [
    `Generate spoken narration from the transcript below. Speak only the transcript; do not read these instructions aloud.\n\nMANDATORY LANGUAGE LOCK:\n${languageLock}\n\nPERFORMANCE DIRECTION (style only, never language):\n${style}\nMaintain the same voice, accent, pace and tone throughout.\n\n### TRANSCRIPT\n${text}`,
    `Read the following transcript aloud exactly as written. Begin speaking immediately. ${languageLock} Keep a steady pace and consistent voice. Performance direction: ${style}\n\nTRANSCRIPT:\n${text}`,
    `${languageLock}\n\nRead aloud exactly as written:\n${text}`,
  ];
  const prompt = prompts[Math.min(attempt, prompts.length - 1)];
  const response = await ai.models.generateContent({
    model: process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts",
    contents: [{ parts: [{ text: prompt }] }],
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    },
  });
  const data = response.candidates?.[0]?.content?.parts?.find((part) => part.inlineData)?.inlineData?.data;
  if (!data) {
    const candidate = response.candidates?.[0];
    const diagnostics = {
      finishReason: candidate?.finishReason,
      blockReason: response.promptFeedback?.blockReason,
      returnedText: candidate?.content?.parts?.some((part) => Boolean(part.text)),
    };
    const error = new Error("NO_AUDIO");
    Object.assign(error, { diagnostics });
    throw error;
  }
  return Buffer.from(data, "base64");
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const voice = typeof body.voice === "string" && VALID_VOICES.has(body.voice) ? body.voice : "Kore";
    const style = typeof body.style === "string" ? body.style.trim().slice(0, 500) : "Leggi in modo naturale e chiaro.";
    const language = typeof body.language === "string" ? body.language : "";
    if (!text) return NextResponse.json({ error: "Inserisci del testo." }, { status: 400 });
    if (text.length > 1200) return NextResponse.json({ error: "Il segmento è troppo lungo." }, { status: 400 });

    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const audio = await synthesize(text, voice, style, language, attempt);
        return new NextResponse(audio, {
          headers: { "Content-Type": "audio/pcm", "Cache-Control": "no-store" },
        });
      } catch (error) {
        lastError = error;
        const status = (error as { status?: number }).status;
        if ((error as Error).message === "MISSING_API_KEY" || status === 429) break;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
      }
    }
    if ((lastError as Error)?.message === "MISSING_API_KEY") {
      return NextResponse.json({ error: "Configura GEMINI_API_KEY nel file .env.local." }, { status: 503 });
    }
    if ((lastError as { status?: number })?.status === 429) {
      const quota = getQuotaDetails(lastError);
      if (quota.isFreeTier) {
        return NextResponse.json(
          { error: "La chiave API risulta ancora associata a un progetto Free Tier. Verifica che proprio il progetto della chiave usata dall’app sia indicato come Paid in Google AI Studio.", retryable: false },
          { status: 429 },
        );
      }
      if (quota.retryAfter > 0) {
        const retryable = quota.retryAfter <= 120;
        return NextResponse.json(
          {
            error: retryable
              ? `Limite temporaneo Gemini raggiunto. Riprova tra ${formatWait(quota.retryAfter)}.`
              : `Gemini richiede un’attesa di circa ${formatWait(quota.retryAfter)}. La coda è stata sospesa e potrà riprendere dal segmento interrotto. Controlla i limiti attivi nella pagina Usage di Google AI Studio.`,
            retryable,
            retryAfter: quota.retryAfter,
            metric: quota.metric,
          },
          { status: 429, headers: { "Retry-After": String(quota.retryAfter) } },
        );
      }
      return NextResponse.json(
        { error: "Limite Gemini raggiunto per questo progetto o modello. Controlla Tier, credito disponibile e limiti attivi nella pagina Usage di Google AI Studio; la coda potrà riprendere dal segmento interrotto.", retryable: false },
        { status: 429 },
      );
    }
    if ((lastError as Error)?.message === "NO_AUDIO") {
      console.error("Gemini TTS returned no audio", (lastError as { diagnostics?: unknown }).diagnostics);
      return NextResponse.json(
        { error: "Gemini non ha prodotto audio per questo segmento dopo tre strategie di lettura. Il progresso è conservato: riprova oppure usa la modalità Batch, più adatta alle audioguide multiple." },
        { status: 502 },
      );
    }
    console.error("Gemini TTS error", lastError);
    return NextResponse.json({ error: "Gemini non ha restituito l’audio. Riprova tra poco." }, { status: 502 });
  } catch {
    return NextResponse.json({ error: "Richiesta non valida." }, { status: 400 });
  }
}
