import { NextRequest, NextResponse } from "next/server";
import { AUDIO_ARCHIVE_DIR, saveArchivedAudio } from "../../../lib/server/archive";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    const fileName = String(form.get("fileName") || "voce.mp3");
    const outputSubdir = String(form.get("outputSubdir") || "");
    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: "File audio mancante." }, { status: 400 });
    }
    if (file.size > 100 * 1024 * 1024) {
      return NextResponse.json({ error: "File troppo grande per il salvataggio automatico." }, { status: 413 });
    }
    const saved = await saveArchivedAudio(fileName, Buffer.from(await file.arrayBuffer()), outputSubdir);
    return NextResponse.json({ saved: true, outputDir: AUDIO_ARCHIVE_DIR, ...saved });
  } catch (error) {
    console.error("Archive save error", error);
    return NextResponse.json({ error: (error as Error).message || "Salvataggio non riuscito." }, { status: 502 });
  }
}
