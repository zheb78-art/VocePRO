export const GUIDE_LANGUAGES = [
  { id: "it", suffix: "ita", label: "Italiano", speechName: "Italian with a native Italian accent", aliases: ["it", "ita", "italiano", "italian"] },
  { id: "en", suffix: "eng", label: "English", speechName: "English with a neutral native English accent", aliases: ["en", "eng", "english", "inglese"] },
  { id: "fr", suffix: "fra", label: "Français", speechName: "French with a native French accent", aliases: ["fr", "fra", "fre", "francais", "français", "french", "francese"] },
  { id: "de", suffix: "deu", label: "Deutsch", speechName: "German with a native German accent", aliases: ["de", "deu", "ger", "deutsch", "german", "tedesco"] },
  { id: "es", suffix: "spa", label: "Español", speechName: "Spanish with a native Spanish accent", aliases: ["es", "spa", "esp", "espanol", "español", "spanish", "spagnolo"] },
  { id: "zh", suffix: "zho", label: "中文", speechName: "Mandarin Chinese with a native Mandarin accent", aliases: ["zh", "zho", "chi", "cn", "zh-cn", "zh-hans", "中文", "汉语", "漢語", "普通话", "普通話", "mandarin", "mandarino", "chinese", "cinese", "chinese simplified", "simplified chinese", "cinese semplificato", "chinese traditional", "traditional chinese", "cinese tradizionale"] },
  { id: "ar", suffix: "ara", label: "العربية", speechName: "Modern Standard Arabic with a native Arabic accent", aliases: ["ar", "ara", "العربية", "arabic", "arabo"] },
  { id: "pt", suffix: "por", label: "Português", speechName: "European Portuguese with a native Portuguese accent", aliases: ["pt", "por", "portugues", "português", "portuguese", "portoghese"] },
  { id: "ja", suffix: "jpn", label: "日本語", speechName: "Japanese with a native Japanese accent", aliases: ["ja", "jp", "jpn", "日本語", "japanese", "giapponese"] },
  { id: "ru", suffix: "rus", label: "Русский", speechName: "Russian with a native Russian accent", aliases: ["ru", "rus", "русский", "russian", "russo"] },
  { id: "pl", suffix: "pol", label: "Polski", speechName: "Polish with a native Polish accent", aliases: ["pl", "pol", "polski", "polish", "polacco"] },
] as const;

export type GuideSection = { id: string; label: string; text: string };

export type NarrationCleanup = { text: string; removedTitles: string[] };

function isLikelyParagraphTitle(block: string, nextBlock = "") {
  if (block.includes("\n")) return false;
  const original = block.trim();
  const explicitMarkup = /^#{1,6}\s+/.test(original) || /^=+.*=+$/.test(original) || /:$/.test(original);
  const clean = original
    .replace(/^#{1,6}\s+/, "")
    .replace(/^=+\s*|\s*=+$/g, "")
    .replace(/:$/, "")
    .trim();
  const words = clean.split(/\s+/).filter(Boolean);
  if (!clean || clean.length > 100 || words.length > 12) return false;
  if (/[.!?…;,][\s”’"']*$/.test(clean)) return false;

  const letters = clean.match(/\p{L}/gu) ?? [];
  const upper = clean.match(/\p{Lu}/gu) ?? [];
  const mostlyUppercase = letters.length >= 3 && upper.length / letters.length >= 0.72;
  if (explicitMarkup || mostlyUppercase) return true;

  // Un titolo editoriale breve è normalmente seguito da un paragrafo molto
  // più lungo. Escludiamo invece i più comuni attacchi narrativi.
  const narrativeOpenings = /^(ora|adesso|quindi|immaginate|osservate|guardate|notate|proseguiamo|spostiamoci|entriamo|now|so|imagine|look|notice|let us|we |as we|maintenant|alors|imaginez|regardez|nous |jetzt|stellen sie|mira|ahora|imagine|olhem|agora|现在|接下来|请|さて|では|次に|ここで|الآن|والآن|دعونا|انظروا|теперь|сейчас|давайте|посмотрите|teraz|następnie|spójrzmy)/iu;
  const hasLongFollowingParagraph = nextBlock.trim().length >= Math.max(160, clean.length * 2.5);
  const hasCasedLetters = /[\p{Lu}\p{Ll}]/u.test(clean);
  const startsLikeTitle = !hasCasedLetters || /^\p{Lu}/u.test(clean);
  return hasLongFollowingParagraph && !narrativeOpenings.test(clean) && startsLikeTitle;
}

export function stripParagraphTitles(source: string): NarrationCleanup {
  const blocks = source.replace(/\r\n?/g, "\n").split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
  const removedTitles: string[] = [];
  const narration = blocks.filter((block, index) => {
    if (!isLikelyParagraphTitle(block, blocks[index + 1] ?? "")) return true;
    removedTitles.push(block.replace(/^#+\s*|^=+\s*|\s*=+$|:$/g, "").trim());
    return false;
  });
  return { text: narration.join("\n\n"), removedTitles };
}

function normalizeHeading(value: string) {
  let heading = value
    .trim()
    .replace(/^=+\s*|\s*=+$/g, "")
    .replace(/^#+\s*/, "")
    .replace(/^\[|\]$/g, "")
    .replace(/^(?:lingua|language|langue|idioma|sprache)\s*:\s*/i, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/:+$/, "")
    .trim();

  // Formati come "LINGUA: IT | Italiano" o "Italiano | IT".
  if (heading.includes("|")) {
    heading = heading
      .split("|")
      .map((part) => part.trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)[0] ?? heading;
  }

  return heading
    .toLocaleLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function parseAudioguide(source: string): GuideSection[] {
  const sections = new Map<string, GuideSection>();
  let active: (typeof GUIDE_LANGUAGES)[number] | undefined;
  let content: string[] = [];

  const save = () => {
    if (!active) return;
    const text = content.join("\n").trim();
    if (!text) return;
    const existing = sections.get(active.id);
    sections.set(active.id, {
      id: active.id,
      label: active.label,
      text: existing ? `${existing.text}\n\n${text}` : text,
    });
  };

  for (const rawLine of source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n")) {
    const normalized = normalizeHeading(rawLine);
    const language = GUIDE_LANGUAGES.find((item) =>
      item.aliases.some((alias) => normalizeHeading(alias) === normalized),
    );
    if (language) {
      save();
      active = language;
      content = [];
    } else if (active && !/^\s*={3,}\s*$/.test(rawLine)) {
      content.push(rawLine);
    }
  }
  save();
  return [...sections.values()];
}
