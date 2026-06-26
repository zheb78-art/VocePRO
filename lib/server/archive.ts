import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const AUDIO_ARCHIVE_DIR = process.env.VOCE_OUTPUT_DIR || join(process.cwd(), "generated-mp3");

export function safeAudioFileName(fileName: string) {
  const cleaned = fileName
    .normalize("NFKD")
    .replace(/[^\w.\- ]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 180);
  const fallback = `voce-${new Date().toISOString().replace(/[:.]/g, "-")}.mp3`;
  return (cleaned || fallback).replace(/\.mp3$/i, "") + ".mp3";
}

export function safeArchiveSubdir(value = "") {
  return value
    .split(/[\\/]+/)
    .map((part) => part.normalize("NFKD").replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80))
    .filter(Boolean)
    .join("/");
}

export function audioArchivePath(fileName: string, subdir = "") {
  const safeSubdir = safeArchiveSubdir(subdir);
  return join(AUDIO_ARCHIVE_DIR, safeSubdir, safeAudioFileName(fileName));
}

export async function saveArchivedAudio(fileName: string, audio: Buffer, subdir = "") {
  const safeSubdir = safeArchiveSubdir(subdir);
  const outputDir = join(AUDIO_ARCHIVE_DIR, safeSubdir);
  await mkdir(outputDir, { recursive: true });
  const safeName = safeAudioFileName(fileName);
  const path = join(outputDir, safeName);
  await writeFile(path, audio);
  return { fileName: safeName, subdir: safeSubdir, path, size: audio.byteLength, savedAt: new Date().toISOString() };
}

export async function getArchivedAudio(fileName: string, subdir = "") {
  const path = audioArchivePath(fileName, subdir);
  try {
    const [info, audio] = await Promise.all([stat(path), readFile(path)]);
    return { path, audio, size: info.size, savedAt: info.mtime.toISOString() };
  } catch {
    return null;
  }
}
