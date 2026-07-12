import {
  createSubtitleDocument,
  validateSubtitleDocument,
  type SubtitleCue,
  type SubtitleDocument,
  type SubtitleWord,
} from "./subtitles";

export const DEFAULT_WHISPER_JSON_INPUT_CHAR_LIMIT = 32 * 1024 * 1024;
export const DEFAULT_WHISPER_CUE_LIMIT = 10_000;
export const DEFAULT_WHISPER_WORDS_PER_CUE_LIMIT = 5_000;
export const DEFAULT_WHISPER_TOTAL_WORD_LIMIT = 200_000;
export const DEFAULT_WHISPER_TOTAL_TEXT_CHAR_LIMIT = 5_000_000;

const MIN_TIMESTAMP_DURATION = 0.001;

export type WhisperSubtitleImportErrorCode =
  | "INVALID_JSON"
  | "INVALID_SCHEMA"
  | "INVALID_TIME"
  | "UNSORTED_TIMESTAMPS"
  | "LIMIT_EXCEEDED";

export class WhisperSubtitleImportError extends Error {
  override readonly name = "WhisperSubtitleImportError";

  constructor(
    readonly code: WhisperSubtitleImportErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ParseWhisperJsonOptions {
  projectKey?: string;
  maxInputChars?: number;
  maxCueCount?: number;
  maxWordsPerCue?: number;
  maxTotalWords?: number;
  maxTotalTextChars?: number;
}

interface WhisperWordInput {
  word: string;
  start: number;
  end: number;
}

interface WhisperSegmentInput {
  text: string;
  start: number;
  end: number;
  words: WhisperWordInput[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function limit(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > fallback) {
    throw new WhisperSubtitleImportError(
      "INVALID_SCHEMA",
      `${label} 제한은 1 이상 ${fallback.toLocaleString("ko-KR")} 이하의 안전한 정수여야 합니다.`,
    );
  }
  return value;
}

function requiredFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WhisperSubtitleImportError("INVALID_TIME", `${path}는 유한한 숫자여야 합니다.`);
  }
  return value;
}

function requiredText(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new WhisperSubtitleImportError("INVALID_SCHEMA", `${path}는 문자열이어야 합니다.`);
  }
  const text = value.replace(/^\uFEFF/gu, "").replace(/\r\n?/gu, "\n").trim();
  if (!text) {
    throw new WhisperSubtitleImportError("INVALID_SCHEMA", `${path}가 비어 있습니다.`);
  }
  return text;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

function stableTime(value: number): string {
  return value.toString();
}

function stableCueId(segment: WhisperSegmentInput, index: number): string {
  const ordinal = String(index + 1).padStart(6, "0");
  const fingerprint = stableHash([
    stableTime(segment.start),
    stableTime(segment.end),
    segment.text,
  ].join("|"));
  return `whisper_cue_${ordinal}_${fingerprint}`;
}

function stableWordId(
  cueId: string,
  word: WhisperWordInput,
  index: number,
): string {
  const ordinal = String(index + 1).padStart(6, "0");
  const fingerprint = stableHash([
    cueId,
    stableTime(word.start),
    stableTime(word.end),
    word.word,
  ].join("|"));
  return `${cueId}_word_${ordinal}_${fingerprint}`;
}

function assertOrdered(
  previous: { start: number; end: number } | undefined,
  current: { start: number; end: number },
  path: string,
): void {
  if (
    previous &&
    (current.start < previous.start ||
      (current.start === previous.start && current.end < previous.end))
  ) {
    throw new WhisperSubtitleImportError(
      "UNSORTED_TIMESTAMPS",
      `${path}가 시작·종료 시간 순서로 정렬되어 있지 않습니다.`,
    );
  }
}

function parseWord(
  value: unknown,
  segment: { start: number; end: number },
  segmentIndex: number,
  wordIndex: number,
): WhisperWordInput {
  const path = `segments[${segmentIndex}].words[${wordIndex}]`;
  if (!isRecord(value)) {
    throw new WhisperSubtitleImportError("INVALID_SCHEMA", `${path}는 객체여야 합니다.`);
  }
  const word = requiredText(value.word, `${path}.word`);
  const start = requiredFiniteNumber(value.start, `${path}.start`);
  const end = requiredFiniteNumber(value.end, `${path}.end`);
  if (start < 0 || end - start < MIN_TIMESTAMP_DURATION) {
    throw new WhisperSubtitleImportError(
      "INVALID_TIME",
      `${path} 시간은 0 이상이며 최소 ${MIN_TIMESTAMP_DURATION}초 길이여야 합니다.`,
    );
  }
  if (start < segment.start || end > segment.end) {
    throw new WhisperSubtitleImportError(
      "INVALID_TIME",
      `${path} 시간이 상위 자막 큐 범위를 벗어났습니다.`,
    );
  }
  return { word, start, end };
}

function parseSegment(
  value: unknown,
  segmentIndex: number,
  maximumWords: number,
): WhisperSegmentInput {
  const path = `segments[${segmentIndex}]`;
  if (!isRecord(value)) {
    throw new WhisperSubtitleImportError("INVALID_SCHEMA", `${path}는 객체여야 합니다.`);
  }
  const text = requiredText(value.text, `${path}.text`);
  const start = requiredFiniteNumber(value.start, `${path}.start`);
  const end = requiredFiniteNumber(value.end, `${path}.end`);
  if (start < 0 || end - start < MIN_TIMESTAMP_DURATION) {
    throw new WhisperSubtitleImportError(
      "INVALID_TIME",
      `${path} 시간은 0 이상이며 최소 ${MIN_TIMESTAMP_DURATION}초 길이여야 합니다.`,
    );
  }
  if (!Array.isArray(value.words) || value.words.length === 0) {
    throw new WhisperSubtitleImportError(
      "INVALID_SCHEMA",
      `${path}.words에 단어 타임스탬프가 없습니다. Whisper를 word_timestamps 옵션으로 실행해 주세요.`,
    );
  }
  if (value.words.length > maximumWords) {
    throw new WhisperSubtitleImportError(
      "LIMIT_EXCEEDED",
      `${path}.words가 큐당 최대 ${maximumWords.toLocaleString("ko-KR")}개를 초과했습니다.`,
    );
  }

  const words: WhisperWordInput[] = [];
  value.words.forEach((rawWord, wordIndex) => {
    const word = parseWord(rawWord, { start, end }, segmentIndex, wordIndex);
    assertOrdered(words[words.length - 1], word, `${path}.words[${wordIndex}]`);
    words.push(word);
  });
  return { text, start, end, words };
}

function toSubtitleWord(cueId: string, word: WhisperWordInput, index: number): SubtitleWord {
  return {
    wordId: stableWordId(cueId, word, index),
    s: word.start,
    e: word.end,
    t: word.word,
    hidden: false,
  };
}

function toSubtitleCue(segment: WhisperSegmentInput, index: number): SubtitleCue {
  const cueId = stableCueId(segment, index);
  return {
    cueId,
    start: segment.start,
    end: segment.end,
    text: segment.text,
    enabled: true,
    hidden: false,
    words: segment.words.map((word, wordIndex) => toSubtitleWord(cueId, word, wordIndex)),
  };
}

function assertPreserved(
  document: SubtitleDocument,
  expected: readonly SubtitleCue[],
): void {
  if (document.cues.length !== expected.length) {
    throw new WhisperSubtitleImportError("INVALID_SCHEMA", "Whisper 자막 큐 변환 결과가 누락되었습니다.");
  }
  expected.forEach((cue, cueIndex) => {
    const converted = document.cues[cueIndex];
    if (
      !converted ||
      converted.cueId !== cue.cueId ||
      converted.start !== cue.start ||
      converted.end !== cue.end ||
      converted.text !== cue.text ||
      converted.words.length !== cue.words.length
    ) {
      throw new WhisperSubtitleImportError(
        "INVALID_SCHEMA",
        `segments[${cueIndex}] 변환 중 원본 시간 또는 텍스트가 변경되었습니다.`,
      );
    }
    cue.words.forEach((word, wordIndex) => {
      const convertedWord = converted.words[wordIndex];
      if (
        !convertedWord ||
        convertedWord.wordId !== word.wordId ||
        convertedWord.s !== word.s ||
        convertedWord.e !== word.e ||
        convertedWord.t !== word.t
      ) {
        throw new WhisperSubtitleImportError(
          "INVALID_SCHEMA",
          `segments[${cueIndex}].words[${wordIndex}] 변환 중 원본 단어 시간이 변경되었습니다.`,
        );
      }
    });
  });
}

/** Converts official Whisper JSON emitted with word_timestamps into the editor document model. */
export function parseWhisperJson(
  value: string,
  options: ParseWhisperJsonOptions = {},
): SubtitleDocument {
  if (typeof value !== "string") {
    throw new WhisperSubtitleImportError("INVALID_SCHEMA", "Whisper JSON 입력은 문자열이어야 합니다.");
  }
  const maximumInputCharacters = limit(
    options.maxInputChars,
    DEFAULT_WHISPER_JSON_INPUT_CHAR_LIMIT,
    "JSON 입력 문자 수",
  );
  const maximumCues = limit(options.maxCueCount, DEFAULT_WHISPER_CUE_LIMIT, "자막 큐 수");
  const maximumWordsPerCue = limit(
    options.maxWordsPerCue,
    DEFAULT_WHISPER_WORDS_PER_CUE_LIMIT,
    "큐당 단어 수",
  );
  const maximumTotalWords = limit(
    options.maxTotalWords,
    DEFAULT_WHISPER_TOTAL_WORD_LIMIT,
    "전체 단어 수",
  );
  const maximumTotalTextCharacters = limit(
    options.maxTotalTextChars,
    DEFAULT_WHISPER_TOTAL_TEXT_CHAR_LIMIT,
    "전체 텍스트 문자 수",
  );

  if (value.length > maximumInputCharacters) {
    throw new WhisperSubtitleImportError(
      "LIMIT_EXCEEDED",
      `Whisper JSON 입력이 최대 ${maximumInputCharacters.toLocaleString("ko-KR")}자를 초과했습니다.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value.replace(/^\uFEFF/gu, "")) as unknown;
  } catch {
    throw new WhisperSubtitleImportError("INVALID_JSON", "Whisper JSON을 읽을 수 없습니다.");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.segments)) {
    throw new WhisperSubtitleImportError("INVALID_SCHEMA", "Whisper JSON의 segments 배열이 없습니다.");
  }
  if (parsed.segments.length === 0) {
    throw new WhisperSubtitleImportError("INVALID_SCHEMA", "Whisper JSON의 segments 배열이 비어 있습니다.");
  }
  if (parsed.segments.length > maximumCues) {
    throw new WhisperSubtitleImportError(
      "LIMIT_EXCEEDED",
      `Whisper 자막 큐가 최대 ${maximumCues.toLocaleString("ko-KR")}개를 초과했습니다.`,
    );
  }

  let totalWords = 0;
  let totalTextCharacters = 0;
  const segments: WhisperSegmentInput[] = [];
  parsed.segments.forEach((rawSegment, segmentIndex) => {
    const segment = parseSegment(rawSegment, segmentIndex, maximumWordsPerCue);
    assertOrdered(segments[segments.length - 1], segment, `segments[${segmentIndex}]`);
    totalWords += segment.words.length;
    totalTextCharacters += segment.text.length;
    totalTextCharacters += segment.words.reduce((sum, word) => sum + word.word.length, 0);
    if (totalWords > maximumTotalWords) {
      throw new WhisperSubtitleImportError(
        "LIMIT_EXCEEDED",
        `Whisper 단어가 최대 ${maximumTotalWords.toLocaleString("ko-KR")}개를 초과했습니다.`,
      );
    }
    if (totalTextCharacters > maximumTotalTextCharacters) {
      throw new WhisperSubtitleImportError(
        "LIMIT_EXCEEDED",
        `Whisper 텍스트가 최대 ${maximumTotalTextCharacters.toLocaleString("ko-KR")}자를 초과했습니다.`,
      );
    }
    segments.push(segment);
  });

  const cues = segments.map(toSubtitleCue);
  const document = createSubtitleDocument(options.projectKey ?? "local-whisper", cues);
  assertPreserved(document, cues);
  const validation = validateSubtitleDocument(document);
  if (!validation.valid) {
    const issue = validation.issues[0];
    throw new WhisperSubtitleImportError(
      "INVALID_SCHEMA",
      `Whisper 자막 문서 검증에 실패했습니다${issue ? `: ${issue.path} ${issue.message}` : "."}`,
    );
  }
  return document;
}
