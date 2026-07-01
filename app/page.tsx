"use client";

import { useEffect, useMemo, useRef, useState, type InputHTMLAttributes } from "react";
import { Mp3Encoder } from "@breezystack/lamejs";
import { GUIDE_LANGUAGES, parseAudioguide, stripParagraphTitles, type GuideSection } from "../lib/audioguide";
import { readApiPayload, type ApiPayload } from "../lib/http-response";

const VOICES = [
  ["Kore", "Decisa"], ["Achernar", "Morbida"], ["Aoede", "Ariose"],
  ["Charon", "Informativa"], ["Gacrux", "Matura"], ["Iapetus", "Nitida"],
  ["Sulafat", "Calda"], ["Schedar", "Equilibrata"], ["Achird", "Amichevole"],
] as const;

const STYLES = [
  ["Naturale", "Use a natural, clear and engaging narration style."],
  ["Audiolibro", "Narrate like a professional audiobook reader: warm, expressive and with natural pauses."],
  ["Podcast", "Use the confident, conversational tone of a professional podcast."],
  ["Documentario", "Use an authoritative, measured and cinematic documentary tone."],
] as const;

type GuideFile = {
  id: string;
  name: string;
  baseName: string;
  sections: GuideSection[];
};

type GuideResult = {
  id: string;
  fileName: string;
  voice: string;
  url: string;
  savedAt?: string;
  saveError?: string;
};

type LocalBatchJob = {
  localId: string;
  sourceKey: string;
  name: string;
  fileName: string;
  voice: string;
  state: string;
  createdAt: string;
  error?: string;
  savedAt?: string;
  savedPath?: string;
  saveError?: string;
  saveWarning?: string;
  chunks?: string[];
  language?: string;
  style?: string;
  outputSubdir?: string;
};

type FolderInputProps = InputHTMLAttributes<HTMLInputElement> & {
  webkitdirectory?: string;
  directory?: string;
};

type FolderBatchTask = {
  sourceId: string;
  sourceName: string;
  languageId: string;
  suffix: string;
  voice: string;
  fileName: string;
  outputSubdir: string;
  chunks: string[];
};

type OutputWritable = {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
};

type OutputFileHandle = {
  createWritable(): Promise<OutputWritable>;
};

type OutputDirectoryHandle = {
  kind: "directory";
  name: string;
  getDirectoryHandle(name: string, options: { create: boolean }): Promise<OutputDirectoryHandle>;
  getFileHandle(name: string, options: { create: boolean }): Promise<OutputFileHandle>;
  queryPermission?(options: { mode: "readwrite" }): Promise<PermissionState>;
  requestPermission?(options: { mode: "readwrite" }): Promise<PermissionState>;
};

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options: { id: string; mode: "readwrite" }) => Promise<OutputDirectoryHandle>;
};

const BATCH_STORAGE_KEY = "voce-gemini-batch-jobs-v1";
const OUTPUT_DIRECTORY_DB = "voce-output-directory";
const BATCH_TERMINAL_STATES = new Set(["JOB_STATE_SUCCEEDED", "JOB_STATE_FAILED", "JOB_STATE_CANCELLED", "JOB_STATE_EXPIRED"]);

function timestampFilePart() {
  return new Date().toISOString().slice(0, 19).replace("T", "_").replace(/:/g, "-");
}

function openOutputDirectoryDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(OUTPUT_DIRECTORY_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("handles");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function rememberOutputDirectory(handle: OutputDirectoryHandle) {
  const db = await openOutputDirectoryDb();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction("handles", "readwrite");
    transaction.objectStore("handles").put(handle, "output");
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

async function restoreOutputDirectory() {
  const db = await openOutputDirectoryDb();
  const handle = await new Promise<OutputDirectoryHandle | undefined>((resolve, reject) => {
    const request = db.transaction("handles").objectStore("handles").get("output");
    request.onsuccess = () => resolve(request.result as OutputDirectoryHandle | undefined);
    request.onerror = () => reject(request.error);
  });
  db.close();
  return handle;
}

function safeLocalFileName(value: string) {
  return value.replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_").slice(0, 180) || `voce_${timestampFilePart()}.mp3`;
}

function browserDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = safeLocalFileName(fileName);
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function batchStateLabel(state: string) {
  const labels: Record<string, string> = {
    JOB_STATE_PENDING: "In attesa",
    JOB_STATE_RUNNING: "In elaborazione",
    JOB_STATE_SUCCEEDED: "Pronto",
    JOB_STATE_FAILED: "Fallito",
    JOB_STATE_CANCELLED: "Annullato",
    JOB_STATE_EXPIRED: "Scaduto",
  };
  return labels[state] ?? state.replace("JOB_STATE_", "");
}

function splitText(text: string, maxChars = 1000) {
  const paragraphs = text.trim().split(/\n\s*\n/).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  const push = (part: string) => {
    if (!part) return;
    if ((current + "\n\n" + part).trim().length <= maxChars) {
      current = current ? `${current}\n\n${part}` : part;
    } else {
      if (current) chunks.push(current);
      current = part;
    }
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxChars) {
      push(paragraph);
      continue;
    }
    const sentences = paragraph.match(/[^.!?…]+(?:[.!?…]+[”’\"']?|$)/g) ?? [paragraph];
    for (const sentence of sentences) {
      const clean = sentence.trim();
      if (clean.length <= maxChars) {
        push(clean);
      } else {
        const words = clean.split(/\s+/);
        let section = "";
        for (const word of words) {
          if (`${section} ${word}`.trim().length > maxChars) {
            push(section);
            section = word;
          } else section = `${section} ${word}`.trim();
        }
        push(section);
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function encodeMp3(buffers: ArrayBuffer[]) {
  const totalBytes = buffers.reduce((sum, item) => sum + item.byteLength, 0);
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const item of buffers) {
    merged.set(new Uint8Array(item), offset);
    offset += item.byteLength;
  }

  const samples = new Int16Array(merged.buffer);
  const encoder = new Mp3Encoder(1, 24000, 128);
  const output: Uint8Array<ArrayBuffer>[] = [];
  const blockSize = 1152;
  for (let i = 0; i < samples.length; i += blockSize) {
    const encoded = encoder.encodeBuffer(samples.subarray(i, i + blockSize));
    if (encoded.length) output.push(Uint8Array.from(encoded));
  }
  const flushed = encoder.flush();
  if (flushed.length) output.push(Uint8Array.from(flushed));
  return new Blob(output, { type: "audio/mpeg" });
}

function waitWithAbort(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer);
      reject(new DOMException("Operazione annullata", "AbortError"));
    }, { once: true });
  });
}

async function waitCountdownWithAbort(seconds: number, signal: AbortSignal, onTick: (remaining: number) => void) {
  for (let remaining = seconds; remaining > 0; remaining--) {
    onTick(remaining);
    await waitWithAbort(1000, signal);
  }
}

async function requestAudioChunk(
  payload: { text: string; voice: string; style: string; language?: string },
  signal: AbortSignal,
  onWait: (seconds: number) => void,
) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    if (response.ok) return response.arrayBuffer();
    const data = await response.json().catch(() => ({}));
    const retryAfter = Number(data.retryAfter ?? 0);
    if (response.status === 429 && data.retryable && retryAfter > 0 && attempt < 3) {
      onWait(retryAfter);
      await waitWithAbort((retryAfter + 1) * 1000, signal);
      continue;
    }
    throw new Error(data.error || "La generazione non è riuscita.");
  }
  throw new Error("Gemini è ancora occupato dopo i tentativi automatici. La coda può essere ripresa senza perdere le parti completate.");
}

class BatchQuotaError extends Error {
  retryAfter: number;

  constructor(message: string, retryAfter = 60) {
    super(message);
    this.name = "BatchQuotaError";
    this.retryAfter = Math.max(60, retryAfter);
  }
}

async function createBatchJob(
  payload: { displayName: string; voice: string; language: string; style: string; chunks: string[] },
  signal: AbortSignal,
): Promise<ApiPayload & { name: string }> {
  const response = await fetch("/api/batch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  const data = await readApiPayload(response, "Invio Batch non riuscito");
  if (response.ok && data.name) return { ...data, name: data.name };
  if (response.status === 429 || data.quotaExceeded) {
    throw new BatchQuotaError(data.error || "Quota Batch Gemini momentaneamente esaurita.", Number(data.retryAfter) || 60);
  }
  throw new Error(data.error || `Invio Batch non riuscito (HTTP ${response.status}).`);
}

export default function Home() {
  const [mode, setMode] = useState<"text" | "guide">("text");
  const [text, setText] = useState("");
  const [voice, setVoice] = useState("Kore");
  const [style, setStyle] = useState<string>(STYLES[0][1]);
  const [customStyle, setCustomStyle] = useState("");
  const [status, setStatus] = useState<"idle" | "working" | "ready" | "error">("idle");
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const [audioUrl, setAudioUrl] = useState("");
  const [guideFiles, setGuideFiles] = useState<GuideFile[]>([]);
  const [guideLanguage, setGuideLanguage] = useState("");
  const [activeGuideId, setActiveGuideId] = useState("");
  const [guideError, setGuideError] = useState("");
  const [guideResults, setGuideResults] = useState<GuideResult[]>([]);
  const [generationMethod, setGenerationMethod] = useState<"standard" | "batch">("batch");
  const [batchJobs, setBatchJobs] = useState<LocalBatchJob[]>([]);
  const [batchHydrated, setBatchHydrated] = useState(false);
  const [batchDownloading, setBatchDownloading] = useState("");
  const [autoCleanBatch, setAutoCleanBatch] = useState(true);
  const [folderWorkflowSummary, setFolderWorkflowSummary] = useState("");
  const [folderAvailableLanguages, setFolderAvailableLanguages] = useState<string[]>([]);
  const [folderSelectedLanguages, setFolderSelectedLanguages] = useState<string[]>([]);
  const [folderRetryCount, setFolderRetryCount] = useState(0);
  const [folderWorkflowFinished, setFolderWorkflowFinished] = useState(false);
  const [outputDirectoryName, setOutputDirectoryName] = useState("");
  const [directorySavingSupported, setDirectorySavingSupported] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const resumeRef = useRef<{ key: string; buffers: ArrayBuffer[] }>({ key: "", buffers: [] });
  const resultUrlsRef = useRef<string[]>([]);
  const manualTextRef = useRef("");
  const batchJobsRef = useRef<LocalBatchJob[]>([]);
  const refreshingBatchRef = useRef(false);
  const savingBatchRef = useRef(new Set<string>());
  const pendingBatchSavesRef = useRef<LocalBatchJob[]>([]);
  const savingBatchQueueRef = useRef(false);
  const batchCleanupTimerRef = useRef<number | null>(null);
  const folderTasksRef = useRef<FolderBatchTask[]>([]);
  const outputDirectoryRef = useRef<OutputDirectoryHandle | null>(null);
  const narrationCleanup = useMemo(() => mode === "guide" ? stripParagraphTitles(text) : { text, removedTitles: [] }, [mode, text]);
  const chunks = useMemo(() => splitText(narrationCleanup.text), [narrationCleanup.text]);
  const commonGuideLanguages = useMemo(() => GUIDE_LANGUAGES.filter((language) =>
    guideFiles.length > 0 && guideFiles.every((file) => file.sections.some((section) => section.id === language.id)),
  ), [guideFiles]);
  const activeGuide = useMemo(() => guideFiles.find((file) => file.id === activeGuideId), [guideFiles, activeGuideId]);
  const selectedFolderTaskCount = useMemo(() => {
    const selected = new Set(folderSelectedLanguages);
    return folderTasksRef.current.filter((task) => selected.has(task.languageId)).length;
  }, [folderAvailableLanguages, folderSelectedLanguages]);

  useEffect(() => () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    resultUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    if (batchCleanupTimerRef.current) window.clearTimeout(batchCleanupTimerRef.current);
  }, [audioUrl]);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(BATCH_STORAGE_KEY);
      if (stored) setBatchJobs(JSON.parse(stored));
    } catch {
      window.localStorage.removeItem(BATCH_STORAGE_KEY);
    } finally {
      setBatchHydrated(true);
    }
  }, []);

  useEffect(() => {
    const supported = typeof window !== "undefined" && Boolean((window as DirectoryPickerWindow).showDirectoryPicker);
    setDirectorySavingSupported(supported);
    if (!supported) return;
    restoreOutputDirectory()
      .then(async (handle) => {
        if (!handle) return;
        outputDirectoryRef.current = handle;
        setOutputDirectoryName(handle.name);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    batchJobsRef.current = batchJobs;
    if (batchHydrated) window.localStorage.setItem(BATCH_STORAGE_KEY, JSON.stringify(batchJobs));
  }, [batchJobs, batchHydrated]);

  useEffect(() => {
    if (!batchHydrated || !outputDirectoryName) return;
    enqueueBatchSaves(batchJobsRef.current.filter((job) => job.state === "JOB_STATE_SUCCEEDED" && !job.savedAt));
  }, [batchHydrated, outputDirectoryName]);

  useEffect(() => {
    if (!batchHydrated || !autoCleanBatch || !batchJobs.length || status === "working" || folderAvailableLanguages.length) return;
    const containsFolderJobs = batchJobs.some((job) => job.sourceKey.includes("\"folder-workflow-v1\""));
    if (containsFolderJobs && !folderWorkflowFinished) return;
    const allSucceededAndSaved = batchJobs.every((job) => job.state === "JOB_STATE_SUCCEEDED" && job.savedAt);
    if (!allSucceededAndSaved || savingBatchQueueRef.current || savingBatchRef.current.size) return;
    if (batchCleanupTimerRef.current) window.clearTimeout(batchCleanupTimerRef.current);
    batchCleanupTimerRef.current = window.setTimeout(() => {
      clearBatchInterface("Tutti i Batch sono stati salvati. Interfaccia pulita automaticamente.");
      batchCleanupTimerRef.current = null;
    }, 3500);
    return () => {
      if (batchCleanupTimerRef.current) {
        window.clearTimeout(batchCleanupTimerRef.current);
        batchCleanupTimerRef.current = null;
      }
    };
  }, [batchJobs, batchHydrated, autoCleanBatch, status, folderAvailableLanguages.length, folderWorkflowFinished]);

  useEffect(() => {
    if (!batchHydrated) return;
    refreshBatchJobs();
    const timer = window.setInterval(refreshBatchJobs, 30000);
    return () => window.clearInterval(timer);
  }, [batchHydrated]);

  useEffect(() => {
    if (guideFiles.length > 1) setGenerationMethod("batch");
  }, [guideFiles.length]);

  function clearGuideResults() {
    resultUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    resultUrlsRef.current = [];
    setGuideResults([]);
  }

  function resetResult() {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl("");
    setStatus("idle");
    setProgress(0);
    setMessage("");
    resumeRef.current = { key: "", buffers: [] };
    clearGuideResults();
  }

  function clearBatchInterface(nextMessage = "Interfaccia pulita. Gli MP3 salvati restano nella cartella scelta sul computer.") {
    if (batchCleanupTimerRef.current) {
      window.clearTimeout(batchCleanupTimerRef.current);
      batchCleanupTimerRef.current = null;
    }
    pendingBatchSavesRef.current = [];
    folderTasksRef.current = [];
    setFolderWorkflowSummary("");
    setFolderAvailableLanguages([]);
    setFolderSelectedLanguages([]);
    setFolderRetryCount(0);
    setFolderWorkflowFinished(false);
    setBatchDownloading("");
    setBatchJobs([]);
    setGuideFiles([]);
    setGuideLanguage("");
    setActiveGuideId("");
    setGuideError("");
    setText("");
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl("");
    clearGuideResults();
    resumeRef.current = { key: "", buffers: [] };
    setProgress(0);
    setStatus("ready");
    setMessage(nextMessage);
  }

  async function chooseOutputDirectory() {
    try {
      const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
      if (!picker) {
        setMessage("Questo browser userà la cartella Download. Chrome o Edge permettono di scegliere una cartella specifica.");
        setStatus("ready");
        return;
      }
      const handle = await picker({ id: "voce-mp3-output", mode: "readwrite" });
      outputDirectoryRef.current = handle;
      setOutputDirectoryName(handle.name);
      await rememberOutputDirectory(handle).catch(() => undefined);
      setBatchJobs((current) => current.map((job) => job.state === "JOB_STATE_SUCCEEDED" && !job.savedAt ? { ...job, saveError: undefined } : job));
      const ready = batchJobsRef.current.filter((job) => job.state === "JOB_STATE_SUCCEEDED" && !job.savedAt);
      setMessage(`Cartella “${handle.name}” pronta. Salvo automaticamente gli MP3 completati.`);
      setStatus("ready");
      enqueueBatchSaves(ready);
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        setMessage(`Non posso usare la cartella scelta: ${(error as Error).message}`);
        setStatus("error");
      }
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.assign("/login");
  }

  function changeMode(nextMode: "text" | "guide") {
    if (status === "working" || nextMode === mode) return;
    if (mode === "text") manualTextRef.current = text;
    setMode(nextMode);
    if (nextMode === "text") setText(manualTextRef.current);
    else if (guideLanguage) setText(activeGuide?.sections.find((section) => section.id === guideLanguage)?.text ?? "");
    resetResult();
  }

  async function loadGuideFiles(files: FileList | null) {
    if (!files?.length) return;
    setGuideError("");
    const parsed: GuideFile[] = [];
    const errors: string[] = [];
    for (const file of Array.from(files)) {
      if (!file.name.toLocaleLowerCase().endsWith(".txt")) {
        errors.push(`${file.name}: formato non valido`);
        continue;
      }
      if (file.size > 5 * 1024 * 1024) {
        errors.push(`${file.name}: supera 5 MB`);
        continue;
      }
      const bytes = await file.arrayBuffer();
      let source = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      if (source.includes("�")) source = new TextDecoder("windows-1252").decode(bytes);
      const sections = parseAudioguide(source);
      if (!sections.length) {
        errors.push(`${file.name}: nessuna lingua riconosciuta`);
        continue;
      }
      parsed.push({
        id: `${file.name}-${file.size}-${file.lastModified}`,
        name: file.name,
        baseName: file.name.replace(/\.txt$/i, ""),
        sections,
      });
    }
    if (!parsed.length) {
      setGuideError(errors.join(" · ") || "Nessun file valido selezionato.");
      return;
    }
    const combined = [...guideFiles];
    for (const file of parsed) {
      const existingIndex = combined.findIndex((item) => item.id === file.id);
      if (existingIndex >= 0) combined[existingIndex] = file;
      else combined.push(file);
    }
    const common = GUIDE_LANGUAGES.filter((language) =>
      combined.every((file) => file.sections.some((section) => section.id === language.id)),
    );
    const nextLanguage = common.some((language) => language.id === guideLanguage) ? guideLanguage : common[0]?.id ?? "";
    const nextActive = parsed[0];
    setGuideFiles(combined);
    if (combined.length > 1) setGenerationMethod("batch");
    setGuideLanguage(nextLanguage);
    setActiveGuideId(nextActive.id);
    setText(nextActive.sections.find((section) => section.id === nextLanguage)?.text ?? "");
    if (!common.length) errors.push("I file non hanno alcuna lingua in comune");
    setGuideError(errors.join(" · "));
    resetResult();
  }

  function chooseGuideLanguage(id: string) {
    setGuideLanguage(id);
    setText(activeGuide?.sections.find((section) => section.id === id)?.text ?? "");
    resetResult();
  }

  function previewGuide(file: GuideFile) {
    if (status === "working") return;
    setActiveGuideId(file.id);
    setText(file.sections.find((section) => section.id === guideLanguage)?.text ?? "");
  }

  function removeGuideFile(id: string) {
    if (status === "working") return;
    const remaining = guideFiles.filter((file) => file.id !== id);
    const common = GUIDE_LANGUAGES.filter((language) =>
      remaining.length > 0 && remaining.every((file) => file.sections.some((section) => section.id === language.id)),
    );
    const nextLanguage = common.some((language) => language.id === guideLanguage) ? guideLanguage : common[0]?.id ?? "";
    const nextActive = remaining.find((file) => file.id === activeGuideId) ?? remaining[0];
    setGuideFiles(remaining);
    setGuideLanguage(nextLanguage);
    setActiveGuideId(nextActive?.id ?? "");
    setText(nextActive?.sections.find((section) => section.id === nextLanguage)?.text ?? "");
    setGuideError("");
    resetResult();
  }

  async function refreshBatchJobs() {
    if (refreshingBatchRef.current || abortRef.current) return;
    const active = batchJobsRef.current.filter((job) => !BATCH_TERMINAL_STATES.has(job.state));
    if (!active.length) return;
    refreshingBatchRef.current = true;
    const jobsToSave: LocalBatchJob[] = [];
    try {
      const updates: LocalBatchJob[] = [];
      for (let offset = 0; offset < active.length; offset += 5) {
        const group = await Promise.all(active.slice(offset, offset + 5).map(async (job) => {
          try {
            const response = await fetch(`/api/batch?name=${encodeURIComponent(job.name)}`, { cache: "no-store" });
            const data = await readApiPayload(response, "Stato Batch non disponibile");
            if (!response.ok) throw new Error(data.error || "Stato non disponibile");
            const updated = { ...job, state: data.state ?? job.state, error: data.error || undefined };
            if (updated.state === "JOB_STATE_SUCCEEDED" && !updated.savedAt && !updated.saveError && outputDirectoryRef.current) jobsToSave.push(updated);
            return updated;
          } catch (error) {
            return { ...job, error: (error as Error).message };
          }
        }));
        updates.push(...group);
      }
      const byId = new Map(updates.map((job) => [job.localId, job]));
      setBatchJobs((current) => current.map((job) => byId.get(job.localId) ?? job));
      enqueueBatchSaves(jobsToSave);
    } finally {
      refreshingBatchRef.current = false;
    }
  }

  async function saveBlobToComputer(blob: Blob, fileName: string, outputSubdir = "") {
    const pickerSupported = Boolean((window as DirectoryPickerWindow).showDirectoryPicker);
    if (!pickerSupported) {
      browserDownload(blob, fileName);
      return { savedAt: new Date().toISOString(), path: `Download/${safeLocalFileName(fileName)}` };
    }

    const root = outputDirectoryRef.current;
    if (!root) throw new Error("Seleziona prima la cartella di salvataggio in alto.");
    if (root.queryPermission && await root.queryPermission({ mode: "readwrite" }) !== "granted") {
      throw new Error("Il browser richiede di autorizzare nuovamente la cartella di salvataggio.");
    }
    let directory = root;
    const parts = outputSubdir.split(/[\\/]+/).map((part) => safeLocalFileName(part).replace(/\.mp3$/i, "")).filter(Boolean);
    for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: true });
    const safeName = safeLocalFileName(fileName);
    const file = await directory.getFileHandle(safeName, { create: true });
    const writable = await file.createWritable();
    await writable.write(blob);
    await writable.close();
    return {
      savedAt: new Date().toISOString(),
      path: [root.name, ...parts, safeName].join("/"),
    };
  }

  async function fetchBatchResult(job: LocalBatchJob) {
    const response = job.chunks?.length
      ? await fetch("/api/batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "result",
            name: job.name,
            fileName: job.fileName,
            voice: job.voice,
            language: job.language,
            style: job.style,
            chunks: job.chunks,
          }),
        })
      : await fetch(`/api/batch?name=${encodeURIComponent(job.name)}&download=1&fileName=${encodeURIComponent(job.fileName)}`);
    if (!response.ok) {
      const data = await readApiPayload(response, "Preparazione MP3 non riuscita");
      throw new Error(data.error || "Preparazione MP3 non riuscita.");
    }
    return {
      blob: await response.blob(),
      repairedSegments: Number(response.headers.get("X-Voce-Repaired-Segments") || 0),
    };
  }

  async function saveBatchResult(job: LocalBatchJob) {
    if (savingBatchRef.current.has(job.localId)) return false;
    savingBatchRef.current.add(job.localId);
    try {
      const result = await fetchBatchResult(job);
      const saved = await saveBlobToComputer(result.blob, job.fileName, job.outputSubdir);
      const saveWarning = result.repairedSegments ? `${result.repairedSegments} ${result.repairedSegments === 1 ? "segmento rigenerato" : "segmenti rigenerati"} perché Gemini non aveva restituito audio.` : undefined;
      batchJobsRef.current = batchJobsRef.current.map((item) => item.localId === job.localId ? {
        ...item,
        savedAt: saved.savedAt,
        savedPath: saved.path,
        saveError: undefined,
        saveWarning,
      } : item);
      setBatchJobs(batchJobsRef.current);
      return true;
    } catch (error) {
      batchJobsRef.current = batchJobsRef.current.map((item) => item.localId === job.localId ? {
        ...item,
        saveError: (error as Error).message,
      } : item);
      setBatchJobs(batchJobsRef.current);
      return false;
    } finally {
      savingBatchRef.current.delete(job.localId);
    }
  }

  function mergeBatchJobUpdates(updates: LocalBatchJob[]) {
    const byId = new Map(updates.map((job) => [job.localId, job]));
    batchJobsRef.current = batchJobsRef.current.map((job) => byId.get(job.localId) ?? job);
    setBatchJobs(batchJobsRef.current);
  }

  async function waitForFolderBlock(
    jobs: LocalBatchJob[],
    blockNumber: number,
    signal: AbortSignal,
    onSaved: (saved: number) => void,
  ) {
    const blockIds = new Set(jobs.map((job) => job.localId));
    const saveAttempts = new Map<string, number>();

    while (true) {
      if (signal.aborted) throw new DOMException("Operazione annullata", "AbortError");
      let current = batchJobsRef.current.filter((job) => blockIds.has(job.localId));
      const statusUpdates: LocalBatchJob[] = [];
      const pending = current.filter((job) => !job.savedAt && !BATCH_TERMINAL_STATES.has(job.state));

      for (let offset = 0; offset < pending.length; offset += 5) {
        const group = await Promise.all(pending.slice(offset, offset + 5).map(async (job) => {
          try {
            const response = await fetch(`/api/batch?name=${encodeURIComponent(job.name)}`, {
              cache: "no-store",
              signal,
            });
            const data = await readApiPayload(response, "Stato Batch non disponibile");
            if (!response.ok) throw new Error(data.error || "Stato non disponibile");
            return { ...job, state: data.state ?? job.state, error: data.error || undefined };
          } catch (error) {
            if ((error as Error).name === "AbortError") throw error;
            return { ...job, error: (error as Error).message };
          }
        }));
        statusUpdates.push(...group);
      }
      if (statusUpdates.length) mergeBatchJobUpdates(statusUpdates);

      current = batchJobsRef.current.filter((job) => blockIds.has(job.localId));
      const failedJob = current.find((job) =>
        ["JOB_STATE_FAILED", "JOB_STATE_CANCELLED", "JOB_STATE_EXPIRED"].includes(job.state),
      );

      const readyToSave = current.filter((job) => job.state === "JOB_STATE_SUCCEEDED" && !job.savedAt);
      for (let index = 0; index < readyToSave.length; index++) {
        const job = readyToSave[index];
        setMessage(`Blocco ${blockNumber} · salvo MP3 ${index + 1}/${readyToSave.length}: ${job.fileName}`);
        const saved = await saveBatchResult(job);
        if (!saved) {
          const attempts = (saveAttempts.get(job.localId) ?? 0) + 1;
          saveAttempts.set(job.localId, attempts);
          const latest = batchJobsRef.current.find((item) => item.localId === job.localId);
          if (attempts >= 3 || /cartella|autorizz/i.test(latest?.saveError ?? "")) {
            throw new Error(`${job.fileName}: ${latest?.saveError || "salvataggio non riuscito"}`);
          }
          await waitWithAbort(attempts * 2000, signal);
        }
      }

      current = batchJobsRef.current.filter((job) => blockIds.has(job.localId));
      const savedCount = current.filter((job) => job.savedAt).length;
      onSaved(savedCount);
      if (failedJob) {
        throw new Error(`${failedJob.fileName}: il job è ${batchStateLabel(failedJob.state).toLocaleLowerCase()}. Gli altri MP3 pronti del blocco sono stati comunque salvati.`);
      }
      if (savedCount === jobs.length) return;

      const succeeded = current.filter((job) => job.state === "JOB_STATE_SUCCEEDED").length;
      const running = current.length - succeeded;
      setMessage(`Blocco ${blockNumber} · ${savedCount}/${jobs.length} MP3 salvati · ${running} job ancora in elaborazione`);
      await waitWithAbort(30000, signal);
    }
  }

  async function enqueueBatchSaves(jobs: LocalBatchJob[]) {
    const queuedIds = new Set(pendingBatchSavesRef.current.map((job) => job.localId));
    for (const job of jobs) {
      if (queuedIds.has(job.localId) || savingBatchRef.current.has(job.localId)) continue;
      pendingBatchSavesRef.current.push(job);
      queuedIds.add(job.localId);
    }
    if (savingBatchQueueRef.current) return;
    savingBatchQueueRef.current = true;
    try {
      while (pendingBatchSavesRef.current.length) {
        const next = pendingBatchSavesRef.current.shift();
        if (next) await saveBatchResult(next);
      }
    } finally {
      savingBatchQueueRef.current = false;
    }
  }

  async function submitBatchQueue() {
    if (!guideFiles.length || !guideLanguage) return;
    setStatus("working");
    setProgress(0);
    setMessage("Preparo i job Batch…");
    const controller = new AbortController();
    abortRef.current = controller;
    const firstVoiceIndex = Math.max(0, VOICES.findIndex(([name]) => name === voice));
    const suffix = GUIDE_LANGUAGES.find((language) => language.id === guideLanguage)?.suffix ?? guideLanguage;
    let submitted = 0;
    let skipped = 0;

    try {
      for (let index = 0; index < guideFiles.length; index++) {
        const file = guideFiles[index];
        const section = file.sections.find((item) => item.id === guideLanguage);
        if (!section?.text) throw new Error(`${file.name} non contiene la lingua selezionata.`);
        const assignedVoice = VOICES[(firstVoiceIndex + index) % VOICES.length][0];
        const fileName = `${file.baseName}_${suffix}.mp3`;
        const narration = stripParagraphTitles(section.text).text;
        const jobStyle = customStyle.trim() || style;
        const jobChunks = splitText(narration);
        const sourceKey = JSON.stringify(["complete-batch-repair-v3", file.id, guideLanguage, assignedVoice, jobStyle]);
        if (batchJobsRef.current.some((job) => job.sourceKey === sourceKey && !["JOB_STATE_FAILED", "JOB_STATE_CANCELLED", "JOB_STATE_EXPIRED"].includes(job.state))) {
          skipped++;
          setProgress(Math.round(((index + 1) / guideFiles.length) * 100));
          continue;
        }

        setMessage(`Invio job ${index + 1}/${guideFiles.length}: ${file.name}`);
        const data = await createBatchJob({
          displayName: fileName,
          voice: assignedVoice,
          language: guideLanguage,
          style: jobStyle,
          chunks: jobChunks,
        }, controller.signal);
        const job: LocalBatchJob = {
          localId: `${data.name}-${Date.now()}`,
          sourceKey,
          name: data.name,
          fileName,
          voice: assignedVoice,
          state: data.state ?? "JOB_STATE_PENDING",
          createdAt: data.createTime ?? new Date().toISOString(),
          chunks: jobChunks,
          language: guideLanguage,
          style: jobStyle,
          outputSubdir: suffix,
        };
        batchJobsRef.current = [...batchJobsRef.current, job];
        setBatchJobs(batchJobsRef.current);
        submitted++;
        setProgress(Math.round(((index + 1) / guideFiles.length) * 100));
      }
      setStatus("ready");
      setMessage(`${submitted} job inviati a Gemini${skipped ? `, ${skipped} già presenti` : ""}. Ora puoi anche spegnere il computer.`);
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        setMessage("Invio interrotto. I job già confermati continueranno sui server Google.");
      } else setMessage((error as Error).message);
      setStatus("error");
    } finally {
      abortRef.current = null;
    }
  }

  function toggleFolderLanguage(languageId: string) {
    setFolderSelectedLanguages((current) =>
      current.includes(languageId) ? current.filter((id) => id !== languageId) : [...current, languageId],
    );
  }

  async function prepareFolderWorkflow(files: FileList | null) {
    if (!files?.length) return;
    setMode("guide");
    setGenerationMethod("batch");
    setStatus("working");
    setProgress(0);
    setMessage("Leggo la cartella…");
    setGuideError("");
    setFolderWorkflowSummary("");
    setFolderAvailableLanguages([]);
    setFolderSelectedLanguages([]);
    setFolderRetryCount(0);
    setFolderWorkflowFinished(false);
    folderTasksRef.current = [];
    const controller = new AbortController();
    abortRef.current = controller;
    const tasks: FolderBatchTask[] = [];
    const errors: string[] = [];
    const txtFiles = Array.from(files).filter((file) => file.name.toLocaleLowerCase().endsWith(".txt"));

    try {
      for (const file of txtFiles) {
        if (controller.signal.aborted) throw new DOMException("Operazione annullata", "AbortError");
        const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        if (file.size > 5 * 1024 * 1024) {
          errors.push(`${relativePath}: supera 5 MB`);
          continue;
        }
        const bytes = await file.arrayBuffer();
        let source = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
        if (source.includes("�")) source = new TextDecoder("windows-1252").decode(bytes);
        const sections = parseAudioguide(source);
        if (!sections.length) {
          errors.push(`${relativePath}: nessuna lingua riconosciuta`);
          continue;
        }
        const baseName = file.name.replace(/\.txt$/i, "");
        for (const section of sections) {
          const language = GUIDE_LANGUAGES.find((item) => item.id === section.id);
          if (!language) continue;
          const narration = stripParagraphTitles(section.text).text;
          const taskChunks = splitText(narration);
          if (!taskChunks.length) {
            errors.push(`${relativePath} · ${language.label}: testo vuoto dopo la pulizia`);
            continue;
          }
          tasks.push({
            sourceId: `${relativePath}-${file.size}-${file.lastModified}-${section.id}`,
            sourceName: relativePath,
            languageId: section.id,
            suffix: language.suffix,
            voice: VOICES[0][0],
            fileName: `${baseName}_${language.suffix}.mp3`,
            outputSubdir: language.suffix,
            chunks: taskChunks,
          });
        }
      }

      if (!tasks.length) throw new Error(errors.join(" · ") || "Nessun file TXT valido trovato nella cartella.");
      const available = GUIDE_LANGUAGES.filter((language) => tasks.some((task) => task.languageId === language.id)).map((language) => language.id);
      folderTasksRef.current = tasks;
      setFolderAvailableLanguages(available);
      setFolderSelectedLanguages(available);
      setFolderWorkflowSummary(`${txtFiles.length} TXT letti · ${available.length} lingue trovate · blocchi da 50 MP3`);
      setProgress(100);
      setStatus("ready");
      setMessage("Cartella analizzata. Scegli le lingue e avvia le conversioni.");
      if (errors.length) setGuideError(errors.slice(0, 6).join(" · ") + (errors.length > 6 ? ` · altri ${errors.length - 6} avvisi` : ""));
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        setMessage("Analisi della cartella annullata.");
        setStatus("idle");
      } else {
        setMessage((error as Error).message);
        setStatus("error");
      }
    } finally {
      abortRef.current = null;
    }
  }

  async function startFolderWorkflow() {
    const selected = new Set(folderSelectedLanguages);
    const firstVoiceIndex = Math.max(0, VOICES.findIndex(([name]) => name === voice));
    const tasks = folderTasksRef.current
      .filter((task) => selected.has(task.languageId))
      .map((task, index) => ({ ...task, voice: VOICES[(firstVoiceIndex + index) % VOICES.length][0] }));
    if (!tasks.length) {
      setMessage("Seleziona almeno una lingua da convertire.");
      setStatus("error");
      return;
    }
    if (directorySavingSupported && !outputDirectoryRef.current) {
      setMessage("Prima scegli la cartella MP3: è diversa dalla cartella TXT che hai caricato.");
      setStatus("error");
      return;
    }

    setStatus("working");
    setProgress(0);
    setGuideError("");
    setFolderRetryCount(0);
    setFolderWorkflowFinished(false);
    const controller = new AbortController();
    abortRef.current = controller;
    const jobStyle = customStyle.trim() || style;
    const blockSize = 50;
    let submitted = 0;
    let skipped = 0;
    let cursor = 0;
    let blockNumber = 1;
    let completedTasks = 0;
    let emptyQuotaRetries = 0;
    const failed: string[] = [];

    try {
      while (cursor < tasks.length) {
        const blockJobs: LocalBatchJob[] = [];
        const blockFailures: string[] = [];
        let quotaBoundary: BatchQuotaError | null = null;

        while (cursor < tasks.length && blockJobs.length < blockSize) {
          const task = tasks[cursor];
          const sourceKey = JSON.stringify(["folder-workflow-v1", task.sourceId, task.languageId, task.voice, jobStyle]);
          const existing = batchJobsRef.current.find((job) =>
            job.sourceKey === sourceKey && !["JOB_STATE_FAILED", "JOB_STATE_CANCELLED", "JOB_STATE_EXPIRED"].includes(job.state),
          );
          if (existing) {
            skipped++;
            blockJobs.push(existing);
            cursor++;
            continue;
          }

          setMessage(`Blocco ${blockNumber} · invio ${blockJobs.length + 1}/50: ${task.fileName}`);
          try {
            const data = await createBatchJob({
              displayName: task.fileName,
              voice: task.voice,
              language: task.languageId,
              style: jobStyle,
              chunks: task.chunks,
            }, controller.signal);
            const job: LocalBatchJob = {
              localId: `${data.name}-${Date.now()}`,
              sourceKey,
              name: data.name,
              fileName: task.fileName,
              voice: task.voice,
              state: data.state ?? "JOB_STATE_PENDING",
              createdAt: data.createTime ?? new Date().toISOString(),
              chunks: task.chunks,
              language: task.languageId,
              style: jobStyle,
              outputSubdir: task.outputSubdir,
            };
            batchJobsRef.current = [...batchJobsRef.current, job];
            setBatchJobs(batchJobsRef.current);
            blockJobs.push(job);
            submitted++;
            cursor++;
          } catch (error) {
            if ((error as Error).name === "AbortError") throw error;
            if (error instanceof BatchQuotaError) {
              quotaBoundary = error;
              break;
            }
            blockFailures.push(`${task.sourceName} · _${task.suffix}: ${(error as Error).message}`);
            cursor++;
            setMessage(`Errore su ${task.fileName}; continuo l’invio del blocco…`);
          }
        }

        if (blockJobs.length) {
          setMessage(`Blocco ${blockNumber} inviato. Attendo elaborazione e salvataggio di ${blockJobs.length} MP3…`);
          await waitForFolderBlock(
            blockJobs,
            blockNumber,
            controller.signal,
            (savedInBlock) => setProgress(Math.round(((completedTasks + savedInBlock) / tasks.length) * 100)),
          );
          completedTasks += blockJobs.length;
        }

        if (blockFailures.length) {
          failed.push(...blockFailures);
          break;
        }

        if (quotaBoundary) {
          if (!blockJobs.length) {
            emptyQuotaRetries++;
            if (emptyQuotaRetries >= 3) {
              failed.push(`${tasks[cursor].sourceName} · _${tasks[cursor].suffix}: quota ancora esaurita dopo tre attese.`);
              break;
            }
          } else {
            emptyQuotaRetries = 0;
          }
          await waitCountdownWithAbort(quotaBoundary.retryAfter, controller.signal, (remaining) => {
            setMessage(`Quota Gemini raggiunta. I ${blockJobs.length} MP3 accettati sono stati salvati; riprovo i rimanenti tra ${remaining} secondi…`);
          });
          blockNumber++;
          continue;
        }

        if (cursor < tasks.length) {
          await waitCountdownWithAbort(60, controller.signal, (remaining) => {
            setMessage(`Blocco ${blockNumber} completato e salvato. Prossimo blocco tra ${remaining} secondi…`);
          });
          blockNumber++;
        }
      }

      if (failed.length) {
        setStatus("error");
        setFolderRetryCount(failed.length);
        setMessage(`${submitted} job inviati, ${failed.length} non inviati. Usa il pulsante qui sotto per riprovare soltanto quelli mancanti.`);
        setFolderWorkflowSummary(`${submitted} inviati · ${skipped} già presenti · ${failed.length} da riprovare`);
        setGuideError(failed.slice(0, 5).join(" · ") + (failed.length > 5 ? ` · altri ${failed.length - 5} errori` : ""));
      } else {
        setStatus("ready");
        setFolderRetryCount(0);
        setFolderWorkflowFinished(true);
        setProgress(100);
        setMessage(`${tasks.length} MP3 completati e salvati${skipped ? `, ${skipped} job erano già presenti` : ""}.`);
        setFolderWorkflowSummary(`${tasks.length} MP3 salvati per ${folderSelectedLanguages.length} ${folderSelectedLanguages.length === 1 ? "lingua" : "lingue"}.`);
        folderTasksRef.current = [];
        setFolderAvailableLanguages([]);
        setFolderSelectedLanguages([]);
      }
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        setMessage("Flusso cartella interrotto. I job già confermati continueranno sui server Google.");
      } else {
        setFolderRetryCount((current) => Math.max(1, current));
        setMessage((error as Error).message);
      }
      setStatus("error");
    } finally {
      abortRef.current = null;
    }
  }

  async function submitTextBatch() {
    const cleanText = text.trim();
    if (!cleanText) return;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl("");
    setStatus("working");
    setProgress(0);
    setMessage("Preparo il job Batch…");
    const controller = new AbortController();
    abortRef.current = controller;
    const jobStyle = customStyle.trim() || style;
    const jobChunks = splitText(cleanText);
    const fileName = `testo-libero_${timestampFilePart()}.mp3`;
    const sourceKey = JSON.stringify(["text-batch-v1", cleanText, voice, jobStyle]);

    try {
      if (batchJobsRef.current.some((job) => job.sourceKey === sourceKey && !["JOB_STATE_FAILED", "JOB_STATE_CANCELLED", "JOB_STATE_EXPIRED"].includes(job.state))) {
        setProgress(100);
        setStatus("ready");
        setMessage("Questo testo è già presente nei job Batch.");
        return;
      }
      const data = await createBatchJob({
        displayName: fileName,
        voice,
        language: "",
        style: jobStyle,
        chunks: jobChunks,
      }, controller.signal);
      const job: LocalBatchJob = {
        localId: `${data.name}-${Date.now()}`,
        sourceKey,
        name: data.name,
        fileName,
        voice,
        state: data.state ?? "JOB_STATE_PENDING",
        createdAt: data.createTime ?? new Date().toISOString(),
        chunks: jobChunks,
        language: "",
        style: jobStyle,
      };
      batchJobsRef.current = [...batchJobsRef.current, job];
      setBatchJobs(batchJobsRef.current);
      setProgress(100);
      setStatus("ready");
      setMessage("Job Batch inviato a Gemini. Puoi chiudere la pagina e tornare più tardi.");
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        setMessage("Invio Batch annullato.");
        setStatus("idle");
      } else {
        setMessage((error as Error).message);
        setStatus("error");
      }
    } finally {
      abortRef.current = null;
    }
  }

  async function downloadBatchResult(job: LocalBatchJob) {
    setBatchDownloading(job.localId);
    try {
      if (outputDirectoryRef.current || !(window as DirectoryPickerWindow).showDirectoryPicker) {
        const saved = await saveBatchResult(job);
        if (!saved) throw new Error("Salvataggio non riuscito.");
      } else {
        const result = await fetchBatchResult(job);
        browserDownload(result.blob, job.fileName);
        setBatchJobs((current) => current.map((item) => item.localId === job.localId ? {
          ...item,
          savedAt: new Date().toISOString(),
          savedPath: `Download/${job.fileName}`,
          saveError: undefined,
          saveWarning: result.repairedSegments ? `${result.repairedSegments} ${result.repairedSegments === 1 ? "segmento rigenerato" : "segmenti rigenerati"} perché Gemini non aveva restituito audio.` : undefined,
        } : item));
      }
    } catch (error) {
      setMessage((error as Error).message);
      setStatus("error");
    } finally {
      setBatchDownloading("");
    }
  }

  async function cancelBatchJob(job: LocalBatchJob) {
    if (!BATCH_TERMINAL_STATES.has(job.state)) {
      const response = await fetch(`/api/batch?name=${encodeURIComponent(job.name)}`, { method: "DELETE" });
      if (!response.ok) {
        const data = await readApiPayload(response, "Annullamento non riuscito");
        setMessage(data.error || "Annullamento non riuscito.");
        setStatus("error");
        return;
      }
    }
    setBatchJobs((current) => current.filter((item) => item.localId !== job.localId));
  }

  async function generateSingle() {
    if (!text.trim()) return;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl("");
    setStatus("working");
    setProgress(0);
    setMessage("Preparo la narrazione…");
    const controller = new AbortController();
    abortRef.current = controller;
    const generationKey = JSON.stringify([text, voice, customStyle.trim() || style]);
    if (resumeRef.current.key !== generationKey) {
      resumeRef.current = { key: generationKey, buffers: [] };
    }
    const pcmParts = resumeRef.current.buffers;
    const startAt = pcmParts.length;

    try {
      if (startAt > 0) setMessage(`Riprendo dalla parte ${startAt + 1} di ${chunks.length}`);
      for (let i = startAt; i < chunks.length; i++) {
        setMessage(`Genero la parte ${i + 1} di ${chunks.length}`);
        pcmParts.push(await requestAudioChunk(
          { text: chunks[i], voice, style: customStyle.trim() || style },
          controller.signal,
          (seconds) => setMessage(`Limite temporaneo: riprovo automaticamente tra ${seconds} secondi…`),
        ));
        resumeRef.current = { key: generationKey, buffers: pcmParts };
        setProgress(Math.round(((i + 1) / chunks.length) * 90));
      }
      setMessage("Creo il file MP3…");
      const mp3 = encodeMp3(pcmParts);
      const url = URL.createObjectURL(mp3);
      setAudioUrl(url);
      saveBlobToComputer(mp3, "voce.mp3")
        .then((saved) => setMessage(`Il tuo audio è pronto e salvato in automatico${saved.path ? `: ${saved.path}` : ""}`))
        .catch((error) => setMessage(`Il tuo audio è pronto, ma il salvataggio automatico non è riuscito: ${(error as Error).message}`));
      setProgress(100);
      setMessage("Il tuo audio è pronto. Salvataggio automatico in corso…");
      setStatus("ready");
      resumeRef.current = { key: "", buffers: [] };
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        setMessage("Generazione annullata.");
        setStatus("idle");
      } else {
        setMessage((error as Error).message);
        setStatus("error");
      }
    } finally {
      abortRef.current = null;
    }
  }

  async function generateGuideQueue() {
    if (!guideFiles.length || !guideLanguage) return;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl("");
    setStatus("working");
    setProgress(0);
    const controller = new AbortController();
    abortRef.current = controller;
    const firstVoiceIndex = Math.max(0, VOICES.findIndex(([name]) => name === voice));
    const tasks = guideFiles.map((file, index) => {
      const section = file.sections.find((item) => item.id === guideLanguage);
      const assignedVoice = VOICES[(firstVoiceIndex + index) % VOICES.length][0];
      const narration = stripParagraphTitles(section?.text ?? "").text;
      return { file, text: narration, assignedVoice, chunks: splitText(narration) };
    });
    const totalChunks = tasks.reduce((sum, task) => sum + task.chunks.length, 0);
    let completedChunks = tasks.reduce((sum, task) =>
      sum + (guideResults.some((result) => result.id === task.file.id) ? task.chunks.length : 0), 0);

    try {
      for (let fileIndex = 0; fileIndex < tasks.length; fileIndex++) {
        const task = tasks[fileIndex];
        if (guideResults.some((result) => result.id === task.file.id)) continue;
        if (!task.text) throw new Error(`${task.file.name} non contiene la lingua selezionata.`);
        const generationKey = JSON.stringify([task.file.id, guideLanguage, task.text, task.assignedVoice, customStyle.trim() || style]);
        if (resumeRef.current.key !== generationKey) resumeRef.current = { key: generationKey, buffers: [] };
        const pcmParts = resumeRef.current.buffers;
        const startAt = pcmParts.length;
        completedChunks += startAt;

        for (let chunkIndex = startAt; chunkIndex < task.chunks.length; chunkIndex++) {
          setMessage(`File ${fileIndex + 1}/${tasks.length} · parte ${chunkIndex + 1}/${task.chunks.length} · ${task.assignedVoice}`);
          pcmParts.push(await requestAudioChunk(
            { text: task.chunks[chunkIndex], voice: task.assignedVoice, style: customStyle.trim() || style, language: guideLanguage },
            controller.signal,
            (seconds) => setMessage(`File ${fileIndex + 1}/${tasks.length} · limite temporaneo, riprendo tra ${seconds} secondi…`),
          ));
          resumeRef.current = { key: generationKey, buffers: pcmParts };
          completedChunks++;
          setProgress(Math.round((completedChunks / Math.max(totalChunks, 1)) * 90));
        }

        setMessage(`Creo ${task.file.baseName}.mp3…`);
        const suffix = GUIDE_LANGUAGES.find((language) => language.id === guideLanguage)?.suffix ?? guideLanguage;
        const fileName = `${task.file.baseName}_${suffix}.mp3`;
        const mp3 = encodeMp3(pcmParts);
        const url = URL.createObjectURL(mp3);
        resultUrlsRef.current.push(url);
        const result: GuideResult = {
          id: task.file.id,
          fileName,
          voice: task.assignedVoice,
          url,
        };
        setGuideResults((current) => [...current.filter((item) => item.id !== result.id), result]);
        saveBlobToComputer(mp3, fileName, suffix)
          .then((saved) => setGuideResults((current) => current.map((item) => item.id === result.id ? { ...item, savedAt: saved.savedAt ?? new Date().toISOString(), saveError: undefined } : item)))
          .catch((error) => setGuideResults((current) => current.map((item) => item.id === result.id ? { ...item, saveError: (error as Error).message } : item)));
        resumeRef.current = { key: "", buffers: [] };
      }
      setProgress(100);
      setMessage(`${tasks.length} MP3 pronti`);
      setStatus("ready");
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        setMessage("Coda sospesa. Potrai riprenderla.");
        setStatus("error");
      } else {
        setMessage((error as Error).message);
        setStatus("error");
      }
    } finally {
      abortRef.current = null;
    }
  }

  function generate() {
    if (mode === "guide") return generationMethod === "batch" ? submitBatchQueue() : generateGuideQueue();
    return generationMethod === "batch" ? submitTextBatch() : generateSingle();
  }

  function updatePreviewText(value: string) {
    setText(value);
    if (mode !== "guide" || !activeGuideId || !guideLanguage) return;
    setGuideFiles((files) => files.map((file) => file.id !== activeGuideId ? file : {
      ...file,
      sections: file.sections.map((section) => section.id === guideLanguage ? { ...section, text: value } : section),
    }));
    resetResult();
  }

  const folderInputProps: FolderInputProps = { webkitdirectory: "", directory: "" };

  return (
    <main>
      <nav>
        <div className="brand"><span className="mark">V</span> Voce</div>
        <div className="navActions">
          <button type="button" className={`outputDirectory ${outputDirectoryName ? "ready" : ""}`} onClick={chooseOutputDirectory} disabled={status === "working"}>
            {directorySavingSupported ? outputDirectoryName ? `Cambia cartella: ${outputDirectoryName}` : "Scegli cartella MP3" : "Download del browser"}
          </button>
          <span className="badge">Gemini TTS</span>
          <button type="button" className="logoutButton" onClick={logout}>Esci</button>
        </div>
      </nav>
      <section className="hero">
        <p className="eyebrow">IL TESTO PRENDE VOCE</p>
        <h1>Da parole scritte<br />a <em>storie da ascoltare.</em></h1>
        <div className="heroSide">
          <p className="lead">Incolla il tuo testo oppure estrai una lingua da un’audioguida multilingue e ottieni un unico MP3.</p>
          <div className="modeButtons">
            <button className={mode === "text" ? "active" : ""} onClick={() => changeMode("text")}>Testo libero</button>
            <button className={mode === "guide" ? "active" : ""} onClick={() => changeMode("guide")}>Crea audioguida</button>
          </div>
        </div>
      </section>

      {mode === "guide" && <section className="guideBox">
        <div className="guideIntro">
          <span className="guideIcon">TXT+</span>
          <div><h2>Carica i file delle audioguide</h2><p>I file vengono elaborati in coda; la voce cambia automaticamente per ogni audioguida.</p></div>
        </div>
        <div className="guideActions">
          <label className="fileButton" htmlFor="guide-file">{guideFiles.length ? "Aggiungi altri TXT" : "Scegli file TXT"}</label>
          <input id="guide-file" className="fileInput" type="file" multiple accept=".txt,text/plain" onChange={(event) => { loadGuideFiles(event.target.files); event.target.value = ""; }} disabled={status === "working"} />
          <label className="fileButton secondary" htmlFor="guide-folder">Scegli cartella</label>
          <input id="guide-folder" className="fileInput" type="file" multiple accept=".txt,text/plain" {...folderInputProps} onChange={(event) => { prepareFolderWorkflow(event.target.files); event.target.value = ""; }} disabled={status === "working"} />
          {guideFiles.length > 0 && <select aria-label="Lingua delle audioguide" value={guideLanguage} onChange={(event) => chooseGuideLanguage(event.target.value)} disabled={status === "working" || !commonGuideLanguages.length}>
            {commonGuideLanguages.map((language) => <option key={language.id} value={language.id}>{language.label} · _{language.suffix}</option>)}
          </select>}
        </div>
        {folderWorkflowSummary && <p className="fileStatus">{folderWorkflowSummary}</p>}
        {folderAvailableLanguages.length > 0 && <div className="folderLanguagePicker">
          <div className="folderLanguageHeader">
            <div><strong>Lingue da convertire</strong><span>Blocchi da 50: il successivo parte 60 secondi dopo che tutti gli MP3 del precedente sono stati salvati.</span></div>
            <div>
              <button type="button" onClick={() => setFolderSelectedLanguages(folderAvailableLanguages)} disabled={status === "working"}>Tutte</button>
              <button type="button" onClick={() => setFolderSelectedLanguages([])} disabled={status === "working"}>Nessuna</button>
            </div>
          </div>
          <div className="folderLanguageGrid">
            {GUIDE_LANGUAGES.filter((language) => folderAvailableLanguages.includes(language.id)).map((language) => (
              <label className={folderSelectedLanguages.includes(language.id) ? "selected" : ""} key={language.id}>
                <input
                  type="checkbox"
                  checked={folderSelectedLanguages.includes(language.id)}
                  onChange={() => toggleFolderLanguage(language.id)}
                  disabled={status === "working"}
                />
                <span>{language.label}<small>_{language.suffix}</small></span>
              </label>
            ))}
          </div>
          {directorySavingSupported && !outputDirectoryName && <div className="folderOutputRequirement">
            <span><strong>Cartella MP3 non selezionata.</strong> La cartella dei TXT è soltanto la sorgente; scegli separatamente dove salvare gli audio.</span>
            <button type="button" onClick={chooseOutputDirectory}>Scegli cartella MP3</button>
          </div>}
          {!directorySavingSupported && <div className="folderOutputRequirement warning">
            <span>Questo browser non consente il salvataggio automatico in una cartella: gli MP3 dovranno essere scaricati manualmente. Usa Chrome o Edge per automatizzarlo.</span>
          </div>}
          <div className="folderLanguageFooter">
            <span>{folderSelectedLanguages.length} {folderSelectedLanguages.length === 1 ? "lingua selezionata" : "lingue selezionate"} · {selectedFolderTaskCount} MP3</span>
            <button type="button" className="startFolderBatch" onClick={startFolderWorkflow} disabled={status === "working" || !selectedFolderTaskCount || (directorySavingSupported && !outputDirectoryName)}>
              Avvia {selectedFolderTaskCount} {selectedFolderTaskCount === 1 ? "conversione" : "conversioni"} →
            </button>
          </div>
        </div>}
        {guideFiles.length > 0 && <div className="queue">
          <div className="queueHeader"><strong>Coda di generazione</strong><span>{guideFiles.length} {guideFiles.length === 1 ? "file" : "file"}</span></div>
          {guideFiles.map((file, index) => {
            const firstVoiceIndex = Math.max(0, VOICES.findIndex(([name]) => name === voice));
            const assignedVoice = VOICES[(firstVoiceIndex + index) % VOICES.length][0];
            const suffix = GUIDE_LANGUAGES.find((language) => language.id === guideLanguage)?.suffix ?? guideLanguage;
            const completed = guideResults.find((result) => result.id === file.id);
            return <div className={`queueItem ${file.id === activeGuideId ? "active" : ""}`} key={file.id}>
              <button className="queuePreview" type="button" onClick={() => previewGuide(file)} disabled={status === "working"}>
                <span className="queueNumber">{String(index + 1).padStart(2, "0")}</span>
                <span className="queueName"><strong>{file.name}</strong><small>{file.baseName}_{suffix || "lingua"}.mp3</small></span>
                <span className={`queueVoice ${completed ? "complete" : ""}`}>{completed ? "Pronto" : assignedVoice}</span>
              </button>
              {completed && <a className="queueDownload" href={completed.url} download={completed.fileName} title={`Scarica ${completed.fileName}`}>MP3 ↓</a>}
              <button className="queueRemove" type="button" aria-label={`Rimuovi ${file.name}`} onClick={() => removeGuideFile(file.id)} disabled={status === "working"}>×</button>
            </div>;
          })}
        </div>}
        {guideError && <p className="guideError">{guideError}</p>}
      </section>}

      {batchHydrated && batchJobs.length > 0 && <section className="batchJobsPanel">
        <div className="batchJobsHeader">
          <div><span className="batchEyebrow">LAVORI PERSISTENTI</span><h2>Job Batch</h2><p>Continuano su Google; gli MP3 pronti vengono salvati nella cartella scelta sul computer.</p></div>
          <div className="batchHeaderActions">
            <label className="batchAutoClean"><input type="checkbox" checked={autoCleanBatch} onChange={(event) => setAutoCleanBatch(event.target.checked)} /> Pulisci alla fine</label>
            <button type="button" onClick={refreshBatchJobs}>Aggiorna stato ↻</button>
            <button type="button" onClick={() => clearBatchInterface()}>Pulisci</button>
          </div>
        </div>
        <div className="batchJobList">
          {[...batchJobs].reverse().map((job) => <div className={`batchJob ${job.state === "JOB_STATE_SUCCEEDED" ? "succeeded" : ""}`} key={job.localId}>
            <div className="batchJobMain">
              <span className={`batchState ${job.state.toLocaleLowerCase()}`}>{batchStateLabel(job.state)}</span>
              <span className="batchJobName">
                <strong>{job.fileName}</strong>
                <small>Voce {job.voice}{job.outputSubdir ? ` · cartella ${job.outputSubdir}` : ""} · {new Date(job.createdAt).toLocaleString("it-IT")}</small>
                {job.savedAt && <small className="savedMeta">Salvato sul computer · {new Date(job.savedAt).toLocaleString("it-IT")}</small>}
                {job.saveWarning && <small className="saveWarning">{job.saveWarning}</small>}
                {job.saveError && <small className="saveError">Salvataggio automatico non riuscito: {job.saveError}</small>}
              </span>
            </div>
            {job.error && <span className="batchJobError">{job.error}</span>}
            <div className="batchJobActions">
              {job.state === "JOB_STATE_SUCCEEDED" && <button type="button" className="batchDownload" onClick={() => downloadBatchResult(job)} disabled={batchDownloading === job.localId}>{batchDownloading === job.localId ? "Preparo MP3…" : job.savedAt ? "Salva di nuovo ↓" : "Salva MP3 ↓"}</button>}
              {job.state === "JOB_STATE_SUCCEEDED" && (job.saveError || job.saveWarning) && <button type="button" className="batchCancel" onClick={() => saveBatchResult(job)}>{job.saveWarning ? "Ricrea completo" : "Riprova salvataggio"}</button>}
              <button type="button" className="batchCancel" onClick={() => cancelBatchJob(job)}>{BATCH_TERMINAL_STATES.has(job.state) ? "Rimuovi" : "Annulla"}</button>
            </div>
          </div>)}
        </div>
      </section>}

      <section className="studio">
        <div className="panel editor">
          <div className="panelTitle"><span>01</span><h2>{mode === "guide" ? "Testo estratto" : "Il tuo testo"}</h2><small>{text.length.toLocaleString("it-IT")} caratteri</small></div>
          <textarea value={text} onChange={(e) => mode === "guide" ? updatePreviewText(e.target.value) : setText(e.target.value)} placeholder={mode === "guide" ? "Carica uno o più file TXT per visualizzare la lingua selezionata…" : "Inizia a scrivere, oppure incolla qui il testo da trasformare in voce…"} disabled={status === "working"} />
          <div className="textMeta"><span>{chunks.length || 0} {chunks.length === 1 ? "segmento" : "segmenti"}</span><span>{mode === "guide" && narrationCleanup.removedTitles.length ? `${narrationCleanup.removedTitles.length} ${narrationCleanup.removedTitles.length === 1 ? "titolo escluso" : "titoli esclusi"} dalla lettura` : "Divisione automatica alle pause naturali"}</span></div>
        </div>

        <aside className="panel controls">
          <div className="panelTitle"><span>02</span><h2>{mode === "guide" ? "Le voci" : "La voce"}</h2></div>
          <label>Modalità di generazione</label>
          <div className="generationModes">
            <button type="button" className={generationMethod === "standard" ? "selected" : ""} onClick={() => setGenerationMethod("standard")} disabled={status === "working"}><strong>Standard</strong><small>Risultati immediati</small></button>
            <button type="button" className={generationMethod === "batch" ? "selected" : ""} onClick={() => setGenerationMethod("batch")} disabled={status === "working"}><strong>Batch</strong><small>50% meno · asincrono</small></button>
          </div>
          {generationMethod === "batch" && <p className="batchHint">{mode === "guide" ? "Un job persistente per file. Dopo la conferma dell’invio puoi chiudere tutto e tornare più tardi." : "Crea un job persistente per il testo libero. È ideale per testi lunghi o quando vuoi chiudere la pagina e tornare più tardi."}</p>}
          <label>{mode === "guide" ? "Prima voce della rotazione" : "Voce narrante"}</label>
          <select value={voice} onChange={(e) => { setVoice(e.target.value); resetResult(); }} disabled={status === "working"}>
            {VOICES.map(([name, description]) => <option value={name} key={name}>{name} — {description}</option>)}
          </select>
          {mode === "guide" && <p className="voiceHint">Ogni file usa la voce successiva nell’elenco.</p>}

          <label>Stile di lettura</label>
          <div className="styleGrid">
            {STYLES.map(([name, instruction]) => (
              <button type="button" className={style === instruction && !customStyle ? "selected" : ""} onClick={() => { setStyle(instruction); setCustomStyle(""); resetResult(); }} key={name} disabled={status === "working"}>{name}</button>
            ))}
          </div>
          <label htmlFor="direction">Indicazioni personali <small>opzionale</small></label>
          <input id="direction" value={customStyle} onChange={(e) => { setCustomStyle(e.target.value); resetResult(); }} placeholder="Es. lento, intimo, con accento italiano…" disabled={status === "working"} />

          {status === "working" ? (
            <button className="generate stop" onClick={() => abortRef.current?.abort()}>Annulla</button>
          ) : (
            <button className="generate" onClick={generate} disabled={mode === "guide" ? !guideFiles.length || !guideLanguage : !text.trim()}>{mode === "guide" ? generationMethod === "batch" ? `Invia ${guideFiles.length} job Batch` : `Genera ${guideFiles.length} ${guideFiles.length === 1 ? "audioguida" : "audioguide"}` : generationMethod === "batch" ? "Invia job Batch" : "Genera l’audio"} <span>→</span></button>
          )}

          {status !== "idle" && <div className={`result ${status}`}>
            <div className="resultRow"><span>{message}</span><strong>{progress}%</strong></div>
            <div className="progress"><i style={{ width: `${progress}%` }} /></div>
            {status === "error" && folderRetryCount > 0 && folderAvailableLanguages.length > 0 && (
              <button type="button" className="retryFolderWorkflow" onClick={startFolderWorkflow}>
                Riprova {folderRetryCount} {folderRetryCount === 1 ? "conversione mancante" : "conversioni mancanti"} →
              </button>
            )}
            {audioUrl && <><audio src={audioUrl} controls /><a className="download" href={audioUrl} download="voce.mp3">Scarica MP3 ↓</a></>}
            {guideResults.length > 0 && <div className="completedHeader"><strong>{guideResults.length} {guideResults.length === 1 ? "file pronto" : "file pronti"}</strong><span>Scaricabili anche mentre la coda continua</span></div>}
            {guideResults.length > 0 && <div className="resultFiles">{guideResults.map((result) => <a href={result.url} download={result.fileName} key={result.id}><span>{result.fileName}<small>Voce {result.voice}{result.savedAt ? " · salvato" : result.saveError ? " · salvataggio non riuscito" : " · salvataggio in corso"}</small></span><strong>↓</strong></a>)}</div>}
          </div>}
        </aside>
      </section>
      <footer><span>La chiave API rimane protetta sul server.</span><span>PCM 24 kHz · MP3 128 kbps</span></footer>
    </main>
  );
}
