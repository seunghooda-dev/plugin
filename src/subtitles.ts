export const SUBTITLE_DOCUMENT_VERSION = 1 as const;
export const SUBTITLE_AUTOSAVE_SCHEMA = "shortflow.subtitles.autosave" as const;
export const SUBTITLE_UNDO_LIMIT = 50;

const MIN_CUE_DURATION = 0.001;
const DEFAULT_PROJECT_KEY = "untitled-project";

export interface SubtitleWord {
  wordId: string;
  s: number;
  e: number;
  t: string;
  hidden: boolean;
}

export interface SubtitleCue {
  cueId: string;
  start: number;
  end: number;
  text: string;
  enabled: boolean;
  hidden: boolean;
  words: SubtitleWord[];
}

export interface SubtitleDocument {
  version: typeof SUBTITLE_DOCUMENT_VERSION;
  projectKey: string;
  cues: SubtitleCue[];
}

export interface NormalizeSubtitleOptions {
  projectKey?: string;
}

export interface SubtitleValidationIssue {
  path: string;
  code:
    | "INVALID_DOCUMENT"
    | "UNSUPPORTED_VERSION"
    | "INVALID_PROJECT_KEY"
    | "INVALID_CUE"
    | "DUPLICATE_CUE_ID"
    | "INVALID_TIME"
    | "INVALID_TEXT"
    | "INVALID_WORD"
    | "DUPLICATE_WORD_ID"
    | "WORD_OUTSIDE_CUE";
  message: string;
}

export interface SubtitleValidationResult {
  valid: boolean;
  issues: SubtitleValidationIssue[];
}

export interface SplitCuePoint {
  wordId?: string;
  charIndex?: number;
  time?: number;
}

export interface BuildSrtOptions {
  includeDisabled?: boolean;
  includeHidden?: boolean;
}

export interface ActiveSubtitlePosition {
  cueId: string;
  cueIndex: number;
  wordId: string | null;
  wordIndex: number;
}

export interface ParseSrtOptions {
  projectKey?: string;
}

export interface SubtitleAutosaveEnvelope {
  schema: typeof SUBTITLE_AUTOSAVE_SCHEMA;
  version: typeof SUBTITLE_DOCUMENT_VERSION;
  projectKey: string;
  document: SubtitleDocument;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizedProjectKey(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_PROJECT_KEY;
  const clean = value.trim().replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 500);
  return clean || DEFAULT_PROJECT_KEY;
}

function normalizedText(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/^\uFEFF/gu, "").replace(/\r\n?/gu, "\n").trim()
    : "";
}

function normalizedItemId(value: unknown): string {
  return typeof value === "string"
    ? value.trim().replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 160)
    : "";
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

function generatedId(prefix: "cue" | "word", seed: string): string {
  return `${prefix}_${stableHash(seed)}`;
}

function uniqueId(preferred: string, used: Set<string>): string {
  const base = preferred.trim() || "item";
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let suffix = 2;
  while (used.has(`${base}~${suffix}`)) suffix += 1;
  const result = `${base}~${suffix}`;
  used.add(result);
  return result;
}

function cloneWord(word: SubtitleWord): SubtitleWord {
  return { ...word };
}

function cloneCue(cue: SubtitleCue): SubtitleCue {
  return { ...cue, words: cue.words.map(cloneWord) };
}

export function cloneSubtitleDocument(document: SubtitleDocument): SubtitleDocument {
  return {
    version: SUBTITLE_DOCUMENT_VERSION,
    projectKey: document.projectKey,
    cues: document.cues.map(cloneCue),
  };
}

function wordDisplayText(words: readonly SubtitleWord[]): string {
  return words
    .filter((word) => !word.hidden && word.t.trim())
    .map((word) => word.t.trim())
    .join(" ")
    .replace(/\s+([,.;:!?%)}\]])/gu, "$1")
    .replace(/([([{])\s+/gu, "$1")
    .trim();
}

function proportionalWords(
  text: string,
  start: number,
  end: number,
  cueSeed: string,
): SubtitleWord[] {
  const matches = [...text.matchAll(/\S+/gu)];
  if (matches.length === 0) return [];
  const duration = Math.max(MIN_CUE_DURATION, end - start);
  const denominator = Math.max(1, text.length);
  return matches.map((match, index) => {
    const token = match[0];
    const tokenStart = match.index ?? 0;
    const tokenEnd = tokenStart + token.length;
    const s = start + duration * (tokenStart / denominator);
    const e = index === matches.length - 1
      ? end
      : start + duration * (tokenEnd / denominator);
    return {
      wordId: generatedId("word", `${cueSeed}|${index}|${tokenStart}|${token}`),
      s,
      e: Math.min(end, Math.max(s + Number.EPSILON, e)),
      t: token,
      hidden: false,
    };
  });
}

function normalizedWords(
  value: unknown,
  cue: { cueId: string; start: number; end: number; text: string },
): SubtitleWord[] {
  if (!Array.isArray(value) || value.length === 0) {
    return proportionalWords(cue.text, cue.start, cue.end, cue.cueId);
  }
  const used = new Set<string>();
  const words: SubtitleWord[] = [];
  value.forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const text = normalizedText(raw.t ?? raw.text);
    if (!text) return;
    const fallbackStart = cue.start + (cue.end - cue.start) * (index / value.length);
    const fallbackEnd = cue.start + (cue.end - cue.start) * ((index + 1) / value.length);
    const s = Math.max(cue.start, Math.min(cue.end - MIN_CUE_DURATION, finiteNumber(raw.s ?? raw.start, fallbackStart)));
    const e = Math.max(s + MIN_CUE_DURATION, Math.min(cue.end, finiteNumber(raw.e ?? raw.end, fallbackEnd)));
    const suppliedId = normalizedItemId(raw.wordId);
    const preferred = suppliedId
      ? suppliedId
      : generatedId("word", `${cue.cueId}|${index}|${s}|${e}|${text}`);
    words.push({
      wordId: uniqueId(preferred, used),
      s,
      e,
      t: text,
      hidden: raw.hidden === true,
    });
  });
  words.sort((left, right) => left.s - right.s || left.e - right.e);
  return words.length > 0 ? words : proportionalWords(cue.text, cue.start, cue.end, cue.cueId);
}

export function createSubtitleDocument(
  projectKey: string,
  cues: readonly Partial<SubtitleCue>[] = [],
): SubtitleDocument {
  return normalizeSubtitleDocument({
    version: SUBTITLE_DOCUMENT_VERSION,
    projectKey,
    cues,
  });
}

export function normalizeSubtitleDocument(
  value: unknown,
  options: NormalizeSubtitleOptions = {},
): SubtitleDocument {
  const input = isRecord(value) ? value : {};
  const projectKey = normalizedProjectKey(options.projectKey ?? input.projectKey);
  const rawCues = Array.isArray(input.cues) ? input.cues : [];
  const usedCueIds = new Set<string>();
  const cues: SubtitleCue[] = [];

  rawCues.forEach((raw, index) => {
    if (!isRecord(raw)) return;
    const start = Math.max(0, finiteNumber(raw.start, 0));
    const candidateEnd = finiteNumber(raw.end, start + 2);
    const end = Math.max(start + MIN_CUE_DURATION, candidateEnd);
    const text = normalizedText(raw.text);
    const suppliedId = normalizedItemId(raw.cueId);
    const preferred = suppliedId
      ? suppliedId
      : generatedId("cue", `${projectKey}|${index}|${start}|${end}|${text}`);
    const cueId = uniqueId(preferred, usedCueIds);
    const words = normalizedWords(raw.words, { cueId, start, end, text });
    cues.push({
      cueId,
      start,
      end,
      text: text || wordDisplayText(words),
      enabled: raw.enabled !== false,
      hidden: raw.hidden === true,
      words,
    });
  });
  cues.sort((left, right) => left.start - right.start || left.end - right.end || left.cueId.localeCompare(right.cueId));
  return { version: SUBTITLE_DOCUMENT_VERSION, projectKey, cues };
}

export function validateSubtitleDocument(value: unknown): SubtitleValidationResult {
  const issues: SubtitleValidationIssue[] = [];
  if (!isRecord(value)) {
    return {
      valid: false,
      issues: [{ path: "$", code: "INVALID_DOCUMENT", message: "자막 문서는 객체여야 합니다." }],
    };
  }
  if (value.version !== SUBTITLE_DOCUMENT_VERSION) {
    issues.push({ path: "version", code: "UNSUPPORTED_VERSION", message: `지원하는 자막 문서 버전은 ${SUBTITLE_DOCUMENT_VERSION}입니다.` });
  }
  if (typeof value.projectKey !== "string" || !value.projectKey.trim()) {
    issues.push({ path: "projectKey", code: "INVALID_PROJECT_KEY", message: "프로젝트 키가 비어 있습니다." });
  }
  if (!Array.isArray(value.cues)) {
    issues.push({ path: "cues", code: "INVALID_DOCUMENT", message: "cues는 배열이어야 합니다." });
    return { valid: false, issues };
  }
  const cueIds = new Set<string>();
  value.cues.forEach((raw, cueIndex) => {
    const path = `cues[${cueIndex}]`;
    if (!isRecord(raw)) {
      issues.push({ path, code: "INVALID_CUE", message: "큐는 객체여야 합니다." });
      return;
    }
    if (typeof raw.cueId !== "string" || !raw.cueId.trim()) {
      issues.push({ path: `${path}.cueId`, code: "INVALID_CUE", message: "cueId가 비어 있습니다." });
    } else if (cueIds.has(raw.cueId)) {
      issues.push({ path: `${path}.cueId`, code: "DUPLICATE_CUE_ID", message: "cueId가 중복되었습니다." });
    } else cueIds.add(raw.cueId);
    const start = typeof raw.start === "number" ? raw.start : Number.NaN;
    const end = typeof raw.end === "number" ? raw.end : Number.NaN;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      issues.push({ path, code: "INVALID_TIME", message: "큐 시간은 0 이상이며 종료가 시작보다 커야 합니다." });
    }
    if (typeof raw.enabled !== "boolean" || typeof raw.hidden !== "boolean") {
      issues.push({ path, code: "INVALID_CUE", message: "큐의 enabled와 hidden은 불리언이어야 합니다." });
    }
    if (typeof raw.text !== "string") {
      issues.push({ path: `${path}.text`, code: "INVALID_TEXT", message: "큐 텍스트는 문자열이어야 합니다." });
    }
    if (!Array.isArray(raw.words)) {
      issues.push({ path: `${path}.words`, code: "INVALID_WORD", message: "words는 배열이어야 합니다." });
      return;
    }
    const wordIds = new Set<string>();
    raw.words.forEach((word, wordIndex) => {
      const wordPath = `${path}.words[${wordIndex}]`;
      if (!isRecord(word) || typeof word.wordId !== "string" || !word.wordId.trim() || typeof word.t !== "string") {
        issues.push({ path: wordPath, code: "INVALID_WORD", message: "단어 형식이 올바르지 않습니다." });
        return;
      }
      if (wordIds.has(word.wordId)) {
        issues.push({ path: `${wordPath}.wordId`, code: "DUPLICATE_WORD_ID", message: "wordId가 중복되었습니다." });
      } else wordIds.add(word.wordId);
      const wordStart = typeof word.s === "number" ? word.s : Number.NaN;
      const wordEnd = typeof word.e === "number" ? word.e : Number.NaN;
      if (!Number.isFinite(wordStart) || !Number.isFinite(wordEnd) || wordEnd <= wordStart) {
        issues.push({ path: wordPath, code: "INVALID_TIME", message: "단어 시간이 올바르지 않습니다." });
      } else if (Number.isFinite(start) && Number.isFinite(end) && (wordStart < start || wordEnd > end)) {
        issues.push({ path: wordPath, code: "WORD_OUTSIDE_CUE", message: "단어 시간이 큐 범위를 벗어났습니다." });
      }
      if (typeof word.hidden !== "boolean") {
        issues.push({ path: `${wordPath}.hidden`, code: "INVALID_WORD", message: "단어 hidden은 불리언이어야 합니다." });
      }
    });
  });
  return { valid: issues.length === 0, issues };
}

function requireCueIndex(document: SubtitleDocument, cueId: string): number {
  const index = document.cues.findIndex((cue) => cue.cueId === cueId);
  if (index < 0) throw new Error(`자막 큐를 찾을 수 없습니다: ${cueId}`);
  return index;
}

function replaceCueAt(document: SubtitleDocument, index: number, cue: SubtitleCue): SubtitleDocument {
  const cues = document.cues.slice();
  cues[index] = cue;
  return { ...document, cues };
}

export function editSubtitleWord(
  document: SubtitleDocument,
  cueId: string,
  wordId: string,
  text: string,
): SubtitleDocument {
  const cueIndex = requireCueIndex(document, cueId);
  const cue = document.cues[cueIndex] as SubtitleCue;
  const wordIndex = cue.words.findIndex((word) => word.wordId === wordId);
  if (wordIndex < 0) throw new Error(`자막 단어를 찾을 수 없습니다: ${wordId}`);
  const source = cue.words[wordIndex] as SubtitleWord;
  const parts = normalizedText(text).match(/\S+/gu) ?? [];
  const usedWordIds = new Set(cue.words.filter((_word, index) => index !== wordIndex).map((word) => word.wordId));
  const replacements = parts.map((part, index): SubtitleWord => {
    const duration = source.e - source.s;
    const s = source.s + duration * (index / parts.length);
    const e = source.s + duration * ((index + 1) / parts.length);
    return {
      ...source,
      wordId: uniqueId(index === 0 ? source.wordId : `${source.wordId}~edit-${index + 1}`, usedWordIds),
      s,
      e,
      t: part,
    };
  });
  const words = [
    ...cue.words.slice(0, wordIndex),
    ...replacements,
    ...cue.words.slice(wordIndex + 1),
  ];
  if (words.length === 0) {
    return { ...document, cues: document.cues.filter((_candidate, index) => index !== cueIndex) };
  }
  return replaceCueAt(document, cueIndex, { ...cue, words, text: wordDisplayText(words) });
}

export function setSubtitleWordHidden(
  document: SubtitleDocument,
  cueId: string,
  wordId: string,
  hidden = true,
): SubtitleDocument {
  const cueIndex = requireCueIndex(document, cueId);
  const cue = document.cues[cueIndex] as SubtitleCue;
  if (!cue.words.some((word) => word.wordId === wordId)) throw new Error(`자막 단어를 찾을 수 없습니다: ${wordId}`);
  const words = cue.words.map((word) => word.wordId === wordId ? { ...word, hidden } : word);
  return replaceCueAt(document, cueIndex, { ...cue, words, text: wordDisplayText(words) });
}

export function joinSubtitleWords(
  document: SubtitleDocument,
  cueId: string,
  firstWordId: string,
  secondWordId?: string,
): SubtitleDocument {
  const cueIndex = requireCueIndex(document, cueId);
  const cue = document.cues[cueIndex] as SubtitleCue;
  const firstIndex = cue.words.findIndex((word) => word.wordId === firstWordId);
  if (firstIndex < 0) throw new Error(`자막 단어를 찾을 수 없습니다: ${firstWordId}`);
  const secondIndex = secondWordId
    ? cue.words.findIndex((word) => word.wordId === secondWordId)
    : firstIndex + 1;
  if (secondIndex < 0 || secondIndex >= cue.words.length) throw new Error("붙일 다음 단어가 없습니다.");
  if (Math.abs(secondIndex - firstIndex) !== 1) throw new Error("서로 인접한 단어만 붙일 수 있습니다.");
  const leftIndex = Math.min(firstIndex, secondIndex);
  const rightIndex = Math.max(firstIndex, secondIndex);
  const left = cue.words[leftIndex] as SubtitleWord;
  const right = cue.words[rightIndex] as SubtitleWord;
  const joined: SubtitleWord = {
    wordId: left.wordId,
    s: Math.min(left.s, right.s),
    e: Math.max(left.e, right.e),
    t: `${left.t.trim()}${right.t.trim()}`,
    hidden: false,
  };
  const words = [...cue.words.slice(0, leftIndex), joined, ...cue.words.slice(rightIndex + 1)];
  return replaceCueAt(document, cueIndex, { ...cue, words, text: wordDisplayText(words) });
}

export function setSubtitleCueEnabled(
  document: SubtitleDocument,
  cueId: string,
  enabled: boolean,
): SubtitleDocument {
  const index = requireCueIndex(document, cueId);
  const cue = document.cues[index] as SubtitleCue;
  return replaceCueAt(document, index, { ...cue, enabled });
}

export function setSubtitleCueHidden(
  document: SubtitleDocument,
  cueId: string,
  hidden: boolean,
): SubtitleDocument {
  const index = requireCueIndex(document, cueId);
  const cue = document.cues[index] as SubtitleCue;
  return replaceCueAt(document, index, { ...cue, hidden });
}

export function findActiveSubtitle(
  document: SubtitleDocument,
  seconds: number,
): ActiveSubtitlePosition | null {
  if (!Number.isFinite(seconds)) return null;
  const cueIndex = document.cues.findIndex((cue) =>
    cue.enabled && !cue.hidden && seconds >= cue.start && seconds < cue.end);
  if (cueIndex < 0) return null;
  const cue = document.cues[cueIndex] as SubtitleCue;
  const visibleWords = cue.words
    .map((word, wordIndex) => ({ word, wordIndex }))
    .filter(({ word }) => !word.hidden && word.t.trim());
  if (visibleWords.length === 0) {
    return { cueId: cue.cueId, cueIndex, wordId: null, wordIndex: -1 };
  }
  let active = visibleWords[0] as { word: SubtitleWord; wordIndex: number };
  if (validWordTimings(cue)) {
    for (const candidate of visibleWords) {
      if (seconds >= candidate.word.s) active = candidate;
      else break;
    }
  } else {
    const progress = Math.max(0, Math.min(1, (seconds - cue.start) / Math.max(MIN_CUE_DURATION, cue.end - cue.start)));
    const total = visibleWords.reduce((sum, candidate) => sum + Math.max(1, candidate.word.t.replace(/\s/gu, "").length), 0);
    const target = progress * total;
    let consumed = 0;
    for (const candidate of visibleWords) {
      consumed += Math.max(1, candidate.word.t.replace(/\s/gu, "").length);
      active = candidate;
      if (target <= consumed) break;
    }
  }
  return {
    cueId: cue.cueId,
    cueIndex,
    wordId: active.word.wordId,
    wordIndex: active.wordIndex,
  };
}

export function subtitleSeekTime(
  document: SubtitleDocument,
  cueId: string,
  wordId?: string,
): number {
  const cue = document.cues[requireCueIndex(document, cueId)] as SubtitleCue;
  if (!wordId) return cue.start;
  const word = cue.words.find((candidate) => candidate.wordId === wordId);
  if (!word) throw new Error(`자막 단어를 찾을 수 없습니다: ${wordId}`);
  return Number.isFinite(word.s) ? Math.max(cue.start, Math.min(cue.end, word.s)) : cue.start;
}

function validWordTimings(cue: SubtitleCue): boolean {
  return cue.words.length > 1 && cue.words.every((word) =>
    Number.isFinite(word.s) && Number.isFinite(word.e) && word.s >= cue.start && word.e <= cue.end && word.e > word.s);
}

function charIndexForWord(cue: SubtitleCue, wordIndex: number): number {
  let offset = 0;
  for (let index = 0; index < wordIndex; index += 1) {
    const word = cue.words[index] as SubtitleWord;
    if (!word.hidden) offset += word.t.trim().length + (offset > 0 ? 1 : 0);
  }
  return offset;
}

function splitResolution(cue: SubtitleCue, point: SplitCuePoint | number | string): {
  wordIndex: number | null;
  charIndex: number;
  time: number;
} {
  const requested: SplitCuePoint = typeof point === "number"
    ? { charIndex: point }
    : typeof point === "string"
      ? { wordId: point }
      : point;
  let wordIndex = requested.wordId
    ? cue.words.findIndex((word) => word.wordId === requested.wordId)
    : -1;
  if (requested.wordId && wordIndex < 0) throw new Error(`자막 단어를 찾을 수 없습니다: ${requested.wordId}`);
  if (requested.wordId && wordIndex === 0) throw new Error("첫 단어 앞에서는 자막을 나눌 수 없습니다.");
  let charIndex = Number.isFinite(requested.charIndex) ? Math.round(requested.charIndex as number) : -1;
  if (wordIndex <= 0 && charIndex > 0 && validWordTimings(cue)) {
    const visible = cue.words.filter((word) => !word.hidden);
    let tokenStart = 0;
    for (let index = 0; index < visible.length; index += 1) {
      const word = visible[index] as SubtitleWord;
      const tokenEnd = tokenStart + word.t.trim().length;
      if (charIndex <= tokenEnd) {
        wordIndex = cue.words.findIndex((candidate) => candidate.wordId === word.wordId);
        break;
      }
      tokenStart = tokenEnd + 1;
    }
  }
  if (wordIndex > 0 && wordIndex < cue.words.length) {
    charIndex = charIndexForWord(cue, wordIndex);
    const word = cue.words[wordIndex] as SubtitleWord;
    const boundary = Math.max(cue.start + MIN_CUE_DURATION, Math.min(cue.end - MIN_CUE_DURATION, word.s));
    return { wordIndex, charIndex, time: boundary };
  }
  const safeIndex = Math.max(1, Math.min(cue.text.length - 1, charIndex));
  const explicitTime = finiteNumber(requested.time, Number.NaN);
  const beforeCharacters = cue.text.slice(0, safeIndex).replace(/\s/gu, "").length;
  const totalCharacters = cue.text.replace(/\s/gu, "").length;
  const proportional = cue.start + (cue.end - cue.start) * (beforeCharacters / Math.max(1, totalCharacters));
  return {
    wordIndex: null,
    charIndex: safeIndex,
    time: Number.isFinite(explicitTime) && explicitTime > cue.start && explicitTime < cue.end ? explicitTime : proportional,
  };
}

function derivedCueId(base: string, marker: string, cues: readonly SubtitleCue[]): string {
  return uniqueId(`${base}~${marker}`, new Set(cues.map((cue) => cue.cueId)));
}

export function splitSubtitleCue(
  document: SubtitleDocument,
  cueId: string,
  point: SplitCuePoint | number | string,
): SubtitleDocument {
  const cueIndex = requireCueIndex(document, cueId);
  const cue = document.cues[cueIndex] as SubtitleCue;
  if (cue.text.length < 2) throw new Error("두 부분으로 나눌 자막 텍스트가 부족합니다.");
  if (cue.end - cue.start < MIN_CUE_DURATION * 2) throw new Error("자막 구간이 너무 짧아 두 큐로 나눌 수 없습니다.");
  const resolution = splitResolution(cue, point);
  let leftText: string;
  let rightText: string;
  let leftWords: SubtitleWord[];
  let rightWords: SubtitleWord[];
  if (resolution.wordIndex !== null) {
    leftWords = cue.words.slice(0, resolution.wordIndex).map(cloneWord);
    rightWords = cue.words.slice(resolution.wordIndex).map(cloneWord);
    leftText = wordDisplayText(leftWords);
    rightText = wordDisplayText(rightWords);
  } else {
    leftText = cue.text.slice(0, resolution.charIndex).trim();
    rightText = cue.text.slice(resolution.charIndex).trim();
    leftWords = proportionalWords(leftText, cue.start, resolution.time, `${cue.cueId}|left`);
    rightWords = proportionalWords(rightText, resolution.time, cue.end, `${cue.cueId}|right`);
  }
  if (!leftText || !rightText) throw new Error("자막을 비어 있지 않은 두 부분으로 나눠 주세요.");
  const boundary = Math.max(cue.start + MIN_CUE_DURATION, Math.min(cue.end - MIN_CUE_DURATION, resolution.time));
  leftWords = leftWords.map((word) => ({ ...word, s: Math.max(cue.start, Math.min(boundary - MIN_CUE_DURATION, word.s)), e: Math.max(Math.max(cue.start, word.s) + MIN_CUE_DURATION, Math.min(boundary, word.e)) }));
  rightWords = rightWords.map((word) => ({ ...word, s: Math.max(boundary, Math.min(cue.end - MIN_CUE_DURATION, word.s)), e: Math.max(Math.max(boundary, word.s) + MIN_CUE_DURATION, Math.min(cue.end, word.e)) }));
  const rightId = derivedCueId(cue.cueId, "split", document.cues);
  const left: SubtitleCue = { ...cue, end: boundary, text: leftText, words: leftWords };
  const right: SubtitleCue = { ...cue, cueId: rightId, start: boundary, text: rightText, words: rightWords };
  return {
    ...document,
    cues: [...document.cues.slice(0, cueIndex), left, right, ...document.cues.slice(cueIndex + 1)],
  };
}

export function mergeSubtitleCues(
  document: SubtitleDocument,
  firstCueId: string,
  secondCueId: string,
): SubtitleDocument {
  const firstIndex = requireCueIndex(document, firstCueId);
  const secondIndex = requireCueIndex(document, secondCueId);
  if (Math.abs(firstIndex - secondIndex) !== 1) throw new Error("서로 인접한 자막 큐만 합칠 수 있습니다.");
  const leftIndex = Math.min(firstIndex, secondIndex);
  const rightIndex = Math.max(firstIndex, secondIndex);
  const left = document.cues[leftIndex] as SubtitleCue;
  const right = document.cues[rightIndex] as SubtitleCue;
  const usedWordIds = new Set<string>();
  const words = [...left.words, ...right.words].map((word) => ({
    ...word,
    wordId: uniqueId(word.wordId, usedWordIds),
  }));
  const merged: SubtitleCue = {
    cueId: left.cueId,
    start: Math.min(left.start, right.start),
    end: Math.max(left.end, right.end),
    text: [left.text.trim(), right.text.trim()].filter(Boolean).join(" "),
    enabled: left.enabled || right.enabled,
    hidden: left.hidden && right.hidden,
    words,
  };
  return {
    ...document,
    cues: [...document.cues.slice(0, leftIndex), merged, ...document.cues.slice(rightIndex + 1)],
  };
}

function splitLongWord(word: SubtitleWord, maxChars: number, usedWordIds: Set<string>): SubtitleWord[] {
  if (word.t.length <= maxChars) return [cloneWord(word)];
  const pieces: SubtitleWord[] = [];
  const duration = word.e - word.s;
  for (let offset = 0, index = 0; offset < word.t.length; offset += maxChars, index += 1) {
    const text = word.t.slice(offset, offset + maxChars);
    const s = word.s + duration * (offset / word.t.length);
    const e = word.s + duration * ((offset + text.length) / word.t.length);
    // The original IDs are reserved before derived pieces are created. This keeps
    // a pre-existing `word~2` stable when a long `word` is split for reflow.
    const wordId = index === 0
      ? word.wordId
      : uniqueId(`${word.wordId}~${index + 1}`, usedWordIds);
    pieces.push({ ...word, wordId, s, e, t: text });
  }
  return pieces;
}

function cueWordGroups(cue: SubtitleCue, maxChars: number): SubtitleWord[][] {
  const usedWordIds = new Set(cue.words.map((word) => word.wordId));
  const source = cue.words.length > 0
    ? cue.words.flatMap((word) => splitLongWord(word, maxChars, usedWordIds))
    : proportionalWords(cue.text, cue.start, cue.end, cue.cueId);
  const groups: SubtitleWord[][] = [];
  let current: SubtitleWord[] = [];
  let length = 0;
  for (const word of source) {
    const visibleLength = word.hidden ? 0 : word.t.trim().length;
    const addition = visibleLength + (length > 0 && visibleLength > 0 ? 1 : 0);
    if (current.length > 0 && visibleLength > 0 && length + addition > maxChars) {
      groups.push(current);
      current = [];
      length = 0;
    }
    current.push(cloneWord(word));
    length += visibleLength + (length > 0 && visibleLength > 0 ? 1 : 0);
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

export function reflowSubtitleCues(document: SubtitleDocument, maxChars: number): SubtitleDocument {
  const limit = Math.floor(maxChars);
  if (!Number.isFinite(limit) || limit < 1 || limit > 10_000) {
    throw new Error("자막 최대 글자 수는 1자에서 10,000자 사이여야 합니다.");
  }
  const used = new Set(document.cues.map((cue) => cue.cueId));
  const cues: SubtitleCue[] = [];
  for (const cue of document.cues) {
    if (!cue.enabled || cue.hidden || cue.text.length <= limit) {
      cues.push(cloneCue(cue));
      continue;
    }
    const groups = cueWordGroups(cue, limit);
    if (groups.length * MIN_CUE_DURATION > cue.end - cue.start + Number.EPSILON) {
      throw new Error("자막 구간이 너무 짧아 현재 최대 글자 수로 나눌 수 없습니다.");
    }
    const weights = groups.map((words) => Math.max(1, wordDisplayText(words).replace(/\s/gu, "").length));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    let elapsedWeight = 0;
    let previousEnd = cue.start;
    groups.forEach((words, index) => {
      const weight = weights[index] ?? 1;
      const fallbackStart = cue.start + (cue.end - cue.start) * (elapsedWeight / totalWeight);
      elapsedWeight += weight;
      const fallbackEnd = cue.start + (cue.end - cue.start) * (elapsedWeight / totalWeight);
      const timed = validWordTimings(cue);
      const remainingGroups = groups.length - index;
      const latestStart = cue.end - MIN_CUE_DURATION * remainingGroups;
      const measuredStart = words[0]?.s ?? fallbackStart;
      const start = index === 0
        ? cue.start
        : Math.max(previousEnd, Math.min(latestStart, timed ? measuredStart : fallbackStart));
      const nextMeasuredStart = groups[index + 1]?.[0]?.s;
      const measuredEnd = words[words.length - 1]?.e ?? fallbackEnd;
      const latestEnd = cue.end - MIN_CUE_DURATION * (groups.length - index - 1);
      const preferredEnd = index === groups.length - 1
        ? cue.end
        : timed && typeof nextMeasuredStart === "number" && Number.isFinite(nextMeasuredStart)
          ? Math.min(measuredEnd, nextMeasuredStart)
          : timed
            ? measuredEnd
            : fallbackEnd;
      const end = Math.max(start + MIN_CUE_DURATION, Math.min(latestEnd, preferredEnd));
      const boundedWords = words.map((word) => {
        const wordStart = Math.max(start, Math.min(end - MIN_CUE_DURATION, finiteNumber(word.s, start)));
        const wordEnd = Math.max(wordStart + MIN_CUE_DURATION, Math.min(end, finiteNumber(word.e, end)));
        return { ...word, s: wordStart, e: wordEnd };
      });
      const cueId = index === 0 ? cue.cueId : uniqueId(`${cue.cueId}~reflow-${index + 1}`, used);
      cues.push({
        ...cue,
        cueId,
        start,
        end,
        text: wordDisplayText(boundedWords),
        words: boundedWords,
      });
      previousEnd = end;
    });
  }
  return { ...document, cues };
}

function pad(value: number, length: number): string {
  return String(Math.floor(value)).padStart(length, "0");
}

export function secondsToSrtTime(seconds: number): string {
  const milliseconds = Math.max(0, Math.round(finiteNumber(seconds, 0) * 1_000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1_000);
  const millis = milliseconds % 1_000;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secs, 2)},${pad(millis, 3)}`;
}

export function srtTimeToSeconds(value: string): number | null {
  const clean = value.trim().replace(",", ".");
  const parts = clean.split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+(?:\.\d+)?$/u.test(part))) return null;
  const seconds = Number(parts[parts.length - 1]);
  const minutes = Number(parts[parts.length - 2]);
  const hours = parts.length === 3 ? Number(parts[0]) : 0;
  if (!Number.isFinite(seconds) || !Number.isFinite(minutes) || !Number.isFinite(hours) || seconds >= 60 || minutes >= 60) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

export function buildSrt(document: SubtitleDocument, options: BuildSrtOptions = {}): string {
  const cues = document.cues.filter((cue) =>
    (options.includeDisabled === true || cue.enabled) &&
    (options.includeHidden === true || !cue.hidden) &&
    cue.text.trim());
  const rendered = cues.map((cue) => {
    const text = cue.words.some((word) => word.hidden)
      ? wordDisplayText(cue.words)
      : cue.text;
    return { cue, text: text.replace(/\r\n?/gu, "\n").trim() };
  }).filter(({ text }) => text);
  return rendered.map(({ cue, text }, index) => {
    return [
      String(index + 1),
      `${secondsToSrtTime(cue.start)} --> ${secondsToSrtTime(cue.end)}`,
      text,
    ].join("\n");
  }).join("\n\n") + (rendered.length > 0 ? "\n" : "");
}

export function parseSrt(value: string, options: ParseSrtOptions = {}): SubtitleDocument {
  const projectKey = normalizedProjectKey(options.projectKey);
  const clean = String(value ?? "").replace(/^\uFEFF/gu, "").replace(/\r\n?/gu, "\n").trim();
  if (!clean) return createSubtitleDocument(projectKey);
  const cues: Partial<SubtitleCue>[] = [];
  for (const block of clean.split(/\n[\t ]*\n+/gu)) {
    const lines = block.split("\n");
    if (/^\d+$/u.test(lines[0]?.trim() ?? "")) lines.shift();
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const timing = lines[timingIndex]?.match(/^\s*([^\s]+)\s*-->\s*([^\s]+)(?:\s+.*)?$/u);
    if (!timing) continue;
    const start = srtTimeToSeconds(timing[1] ?? "");
    const end = srtTimeToSeconds(timing[2] ?? "");
    if (start === null || end === null || end <= start) continue;
    const text = lines.slice(timingIndex + 1).join("\n").trim();
    if (!text) continue;
    cues.push({ start, end, text, enabled: true, hidden: false });
  }
  return createSubtitleDocument(projectKey, cues);
}

export function subtitleAutosaveKey(projectKey: string): string {
  const normalized = normalizedProjectKey(projectKey);
  return `shortflow.subtitles.v${SUBTITLE_DOCUMENT_VERSION}.${stableHash(normalized)}.${encodeURIComponent(normalized).slice(0, 80)}`;
}

export function serializeSubtitleDocument(document: SubtitleDocument): string {
  const normalized = normalizeSubtitleDocument(document, { projectKey: document.projectKey });
  return JSON.stringify(normalized);
}

export function deserializeSubtitleDocument(value: string, projectKey?: string): SubtitleDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("저장된 자막 문서 JSON을 읽을 수 없습니다.");
  }
  if (!isRecord(parsed) || parsed.version !== SUBTITLE_DOCUMENT_VERSION) {
    throw new Error("지원하지 않는 자막 문서 버전입니다.");
  }
  const normalized = normalizeSubtitleDocument(parsed);
  if (projectKey !== undefined && normalized.projectKey !== normalizedProjectKey(projectKey)) {
    throw new Error("저장된 자막 문서가 현재 프로젝트와 일치하지 않습니다.");
  }
  return normalized;
}

export function serializeSubtitleAutosave(document: SubtitleDocument): string {
  const normalized = normalizeSubtitleDocument(document, { projectKey: document.projectKey });
  const envelope: SubtitleAutosaveEnvelope = {
    schema: SUBTITLE_AUTOSAVE_SCHEMA,
    version: SUBTITLE_DOCUMENT_VERSION,
    projectKey: normalized.projectKey,
    document: normalized,
  };
  return JSON.stringify(envelope);
}

export function deserializeSubtitleAutosave(value: string, projectKey: string): SubtitleDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("자동 저장 자막 JSON을 읽을 수 없습니다.");
  }
  if (!isRecord(parsed) || parsed.schema !== SUBTITLE_AUTOSAVE_SCHEMA || parsed.version !== SUBTITLE_DOCUMENT_VERSION) {
    throw new Error("지원하지 않는 자막 자동 저장 형식입니다.");
  }
  const expected = normalizedProjectKey(projectKey);
  if (parsed.projectKey !== expected) throw new Error("자동 저장 자막이 현재 프로젝트와 일치하지 않습니다.");
  return deserializeSubtitleDocument(JSON.stringify(parsed.document), expected);
}

export class SubtitleUndoRedo {
  private undoStack: SubtitleDocument[] = [];
  private redoStack: SubtitleDocument[] = [];
  private value: SubtitleDocument;
  readonly maxDepth: number;

  constructor(initial: SubtitleDocument, maxDepth = SUBTITLE_UNDO_LIMIT) {
    this.value = cloneSubtitleDocument(initial);
    this.maxDepth = Math.max(1, Math.min(SUBTITLE_UNDO_LIMIT, Math.floor(finiteNumber(maxDepth, SUBTITLE_UNDO_LIMIT))));
  }

  get current(): SubtitleDocument {
    return cloneSubtitleDocument(this.value);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoDepth(): number {
    return this.undoStack.length;
  }

  get redoDepth(): number {
    return this.redoStack.length;
  }

  commit(next: SubtitleDocument): SubtitleDocument {
    if (next.projectKey !== this.value.projectKey) throw new Error("다른 프로젝트의 자막 문서는 기록할 수 없습니다.");
    this.undoStack.push(cloneSubtitleDocument(this.value));
    if (this.undoStack.length > this.maxDepth) this.undoStack.splice(0, this.undoStack.length - this.maxDepth);
    this.value = cloneSubtitleDocument(next);
    this.redoStack = [];
    return this.current;
  }

  undo(): SubtitleDocument {
    const previous = this.undoStack.pop();
    if (!previous) return this.current;
    this.redoStack.push(cloneSubtitleDocument(this.value));
    this.value = previous;
    return this.current;
  }

  redo(): SubtitleDocument {
    const next = this.redoStack.pop();
    if (!next) return this.current;
    this.undoStack.push(cloneSubtitleDocument(this.value));
    this.value = next;
    return this.current;
  }

  reset(next: SubtitleDocument): SubtitleDocument {
    this.value = cloneSubtitleDocument(next);
    this.undoStack = [];
    this.redoStack = [];
    return this.current;
  }
}

// Short aliases keep host/controller integration readable while the explicit
// names above remain self-documenting for direct consumers.
export const editWord = editSubtitleWord;
export const hideWord = setSubtitleWordHidden;
export const joinWords = joinSubtitleWords;
export const setCueEnabled = setSubtitleCueEnabled;
export const setCueHidden = setSubtitleCueHidden;
export const splitCue = splitSubtitleCue;
export const mergeCues = mergeSubtitleCues;
export const reflowCues = reflowSubtitleCues;
export const parseSRT = parseSrt;
export const buildSRT = buildSrt;
export { SubtitleUndoRedo as UndoRedo };
