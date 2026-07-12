export const OPENAI_API_KEY_STORAGE_KEY = "shortflow.openai.apiKey";
export const MAX_TTS_CHARACTERS = 4_096;
export const MAX_STT_BYTES = 25 * 1024 * 1024;
export const MAX_TRANSCRIPT_SEGMENTS = 10_000;
export const MAX_TRANSCRIPT_CHARACTERS = 1_000_000;
export const MAX_TRANSCRIPT_SEGMENT_CHARACTERS = 4_000;
export const MAX_TRANSCRIPT_SRT_CHARACTERS = 5_000_000;

export const TTS_MODELS = Object.freeze([
  "gpt-4o-mini-tts",
  "tts-1-hd",
  "tts-1",
] as const);
export type TtsModel = (typeof TTS_MODELS)[number];

export const TTS_VOICES = Object.freeze([
  "alloy", "ash", "ballad", "coral", "echo", "fable", "nova",
  "onyx", "sage", "shimmer", "verse", "marin", "cedar",
] as const);
export type TtsVoice = (typeof TTS_VOICES)[number];
export type TtsFormat = "wav" | "mp3" | "aac" | "flac";

export const STT_MODELS = Object.freeze([
  "gpt-4o-transcribe-diarize",
  "gpt-4o-transcribe",
  "gpt-4o-mini-transcribe",
  "whisper-1",
] as const);
export type SttModel = (typeof STT_MODELS)[number];

export interface TtsRequest {
  text: string;
  model: TtsModel;
  voice: TtsVoice;
  format: TtsFormat;
  speed: number;
  instructions?: string;
  signal?: AbortSignal;
}

export interface TtsResult {
  bytes: Uint8Array;
  mimeType: string;
  extension: TtsFormat;
  model: TtsModel;
  voice: TtsVoice;
}

export interface SttRequest {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
  model: SttModel;
  language?: string;
  prompt?: string;
  signal?: AbortSignal;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export interface SttResult {
  text: string;
  segments: TranscriptSegment[];
  srt: string;
  model: SttModel;
}

export interface SecureStorageLike {
  getItem(key: string): Promise<Uint8Array>;
}

export interface SpeechResponseLike {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
  json?(): Promise<unknown>;
  text?(): Promise<string>;
}

export type SpeechFetch = (
  input: string,
  init?: RequestInit,
) => Promise<SpeechResponseLike>;

export interface SpeechApiClientOptions {
  endpoint?: string;
  apiKeyProvider?: () => Promise<string>;
  fetcher?: SpeechFetch;
  timeoutMs?: number;
  setTimer?: (handler: () => void, milliseconds: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class SpeechApiError extends Error {
  override readonly name = "SpeechApiError";
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function requiredString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new SpeechApiError("INVALID_INPUT", `${label}을(를) 입력해 주세요.`);
  }
  const clean = value.trim();
  if (clean.length > maximum) {
    throw new SpeechApiError("INVALID_INPUT", `${label}은(는) 최대 ${maximum.toLocaleString("ko-KR")}자입니다.`);
  }
  return clean;
}

function normalizedLanguage(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const clean = value.trim().toLocaleLowerCase("en-US");
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/u.test(clean)) {
    throw new SpeechApiError("INVALID_INPUT", "언어 코드는 ko, en, ko-KR 형식으로 입력해 주세요.");
  }
  return clean;
}

function forbiddenHostname(hostname: string): boolean {
  const host = hostname
    .toLocaleLowerCase("en-US")
    .replace(/^\[|\]$/gu, "")
    .replace(/\.$/u, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) return true;
  if (
    host === "::" ||
    host === "::1" ||
    host.startsWith("::ffff:") ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    /^(?:fe8|fe9|fea|feb)/u.test(host) ||
    host === "0.0.0.0"
  ) return true;
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    return false;
  }
  const [first = -1, second = -1] = octets;
  return first === 10 || first === 127 || first === 0 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
}

export function validateSpeechEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SpeechApiError("INVALID_ENDPOINT", "AI 엔드포인트 URL이 올바르지 않습니다.");
  }
  if (url.protocol !== "https:") {
    throw new SpeechApiError("INVALID_ENDPOINT", "AI 엔드포인트는 HTTPS 주소만 사용할 수 있습니다.");
  }
  if (url.username || url.password || url.search || url.hash || forbiddenHostname(url.hostname)) {
    throw new SpeechApiError("INVALID_ENDPOINT", "AI 엔드포인트에 인증정보, 쿼리, 내부 주소를 사용할 수 없습니다.");
  }
  const path = url.pathname.replace(/\/+$/gu, "") || "/v1";
  if (path.split("/").filter(Boolean).some((part) => part === "." || part === "..")) {
    throw new SpeechApiError("INVALID_ENDPOINT", "AI 엔드포인트 경로가 안전하지 않습니다.");
  }
  return `${url.origin}${path}`;
}

function decodeSecret(value: Uint8Array): string {
  try {
    return new TextDecoder().decode(value).trim();
  } catch {
    return "";
  }
}

export async function readOpenAIApiKey(storage: SecureStorageLike): Promise<string> {
  try {
    return decodeSecret(await storage.getItem(OPENAI_API_KEY_STORAGE_KEY));
  } catch {
    return "";
  }
}

function defaultApiKeyProvider(): () => Promise<string> {
  return async () => {
    let host: any;
    try {
      host = require("uxp") as any;
    } catch {
      throw new SpeechApiError("NO_SECURE_STORAGE", "Premiere Pro UXP 보안 저장소를 사용할 수 없습니다.");
    }
    const key = await readOpenAIApiKey(host.secureStorage as SecureStorageLike);
    return key;
  };
}

function validateApiKey(value: unknown): string {
  const key = typeof value === "string" ? value.trim() : "";
  if (key.length < 20 || /\s/u.test(key)) {
    throw new SpeechApiError("API_KEY_REQUIRED", "AI 설정 탭에서 유효한 OpenAI API 키를 먼저 저장해 주세요.");
  }
  return key;
}

function mimeForTts(format: TtsFormat): string {
  if (format === "wav") return "audio/wav";
  if (format === "aac") return "audio/aac";
  if (format === "flac") return "audio/flac";
  return "audio/mpeg";
}

function asciiHeader(bytes: Uint8Array, start: number, length: number): string {
  if (bytes.byteLength < start + length) return "";
  let result = "";
  for (let index = start; index < start + length; index += 1) {
    result += String.fromCharCode(bytes[index] ?? 0);
  }
  return result;
}

function looksLikeTtsAudio(format: TtsFormat, bytes: Uint8Array): boolean {
  if (format === "wav") {
    return bytes.byteLength >= 44 && asciiHeader(bytes, 0, 4) === "RIFF" && asciiHeader(bytes, 8, 4) === "WAVE";
  }
  if (format === "mp3") {
    return bytes.byteLength >= 3 && (
      asciiHeader(bytes, 0, 3) === "ID3" ||
      ((bytes[0] ?? 0) === 0xff && (((bytes[1] ?? 0) & 0xe0) === 0xe0))
    );
  }
  if (format === "flac") {
    return bytes.byteLength >= 4 && asciiHeader(bytes, 0, 4) === "fLaC";
  }
  if (format === "aac") {
    return bytes.byteLength >= 4 && (
      ((bytes[0] ?? 0) === 0xff && (((bytes[1] ?? 0) & 0xf0) === 0xf0)) ||
      asciiHeader(bytes, 4, 4) === "ftyp"
    );
  }
  return false;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Applies the same binary/format boundary to injected providers as the live API client. */
export function validateTtsResult(value: unknown, request?: TtsRequest): TtsResult {
  const record = recordValue(value);
  if (!record) throw new SpeechApiError("INVALID_RESPONSE", "TTS 응답 형식이 올바르지 않습니다.");
  if (!(record.bytes instanceof Uint8Array) || record.bytes.byteLength === 0) {
    throw new SpeechApiError("EMPTY_RESPONSE", "AI가 빈 음성 파일을 반환했습니다.");
  }
  const extension = record.extension;
  const model = record.model;
  const voice = record.voice;
  if (!TTS_MODELS.includes(model as TtsModel)) {
    throw new SpeechApiError("INVALID_RESPONSE", "TTS 응답 모델이 올바르지 않습니다.");
  }
  if (!TTS_VOICES.includes(voice as TtsVoice)) {
    throw new SpeechApiError("INVALID_RESPONSE", "TTS 응답 목소리가 올바르지 않습니다.");
  }
  if (!["wav", "mp3", "aac", "flac"].includes(String(extension))) {
    throw new SpeechApiError("INVALID_RESPONSE", "TTS 응답 파일 형식이 올바르지 않습니다.");
  }
  const format = extension as TtsFormat;
  const mimeType = typeof record.mimeType === "string" ? record.mimeType.trim().toLocaleLowerCase("en-US") : "";
  if (mimeType !== mimeForTts(format)) {
    throw new SpeechApiError("INVALID_RESPONSE", "TTS 응답 MIME 형식과 파일 확장자가 일치하지 않습니다.");
  }
  const bytes = record.bytes.slice();
  if (!looksLikeTtsAudio(format, bytes)) {
    throw new SpeechApiError("INVALID_RESPONSE", "TTS 응답 오디오 데이터가 요청한 파일 형식과 일치하지 않습니다.");
  }
  if (request && (format !== request.format || model !== request.model || voice !== request.voice)) {
    throw new SpeechApiError("INVALID_RESPONSE", "TTS 응답이 요청한 모델, 목소리 또는 파일 형식과 일치하지 않습니다.");
  }
  return {
    bytes,
    mimeType,
    extension: format,
    model: model as TtsModel,
    voice: voice as TtsVoice,
  };
}

function cleanResponseMessage(message: string): string {
  return message
    .replace(/bearer\s+[^\s"']+/giu, "Bearer [숨김]")
    .replace(/\bsk-[a-z0-9_-]{8,}\b/giu, "[API 키 숨김]")
    .replace(/[\u0000-\u001f]+/gu, " ")
    .trim()
    .slice(0, 500);
}

async function responseError(response: SpeechResponseLike, secret = ""): Promise<SpeechApiError> {
  let detail = "";
  try {
    const payload = await response.json?.();
    if (payload && typeof payload === "object") {
      const record = payload as Record<string, unknown>;
      const error = record.error;
      if (error && typeof error === "object") detail = String((error as Record<string, unknown>).message ?? "");
      else detail = String(record.message ?? "");
    }
  } catch {
    try { detail = await response.text?.() ?? ""; } catch { detail = ""; }
  }
  const safe = cleanResponseMessage(secret ? detail.split(secret).join("[API 키 숨김]") : detail);
  const base = response.status === 401
    ? "API 키가 거부되었습니다. AI 설정을 확인해 주세요."
    : response.status === 429
      ? "AI 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요."
      : `AI 음성 요청에 실패했습니다 (HTTP ${response.status}).`;
  return new SpeechApiError("API_ERROR", safe ? `${base} ${safe}` : base, response.status);
}

function normalizeSegment(value: unknown): TranscriptSegment | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const start = typeof record.start === "number" ? record.start : Number.NaN;
  const end = typeof record.end === "number" ? record.end : Number.NaN;
  const text = typeof record.text === "string"
    ? record.text.trim().slice(0, MAX_TRANSCRIPT_SEGMENT_CHARACTERS)
    : "";
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || !text) return null;
  const speaker = cleanSpeakerLabel(record.speaker);
  return speaker ? { start, end, text, speaker } : { start, end, text };
}

function validateSttFilename(filenameValue: unknown, mimeValue: unknown): string {
  const filename = requiredString(filenameValue, "STT 파일명", 260);
  if (filename === "." || filename === ".." || /[\\/\u0000-\u001f\u007f]/u.test(filename)) {
    throw new SpeechApiError("INVALID_INPUT", "STT 파일명에 경로 또는 제어 문자를 포함할 수 없습니다.");
  }
  const dot = filename.lastIndexOf(".");
  const extension = dot > 0 ? filename.slice(dot + 1).toLocaleLowerCase("en-US") : "";
  const mimeType = requiredString(mimeValue, "STT MIME 형식", 100).toLocaleLowerCase("en-US");
  const valid =
    (["mp3", "mpeg", "mpga"].includes(extension) && mimeType === "audio/mpeg") ||
    (extension === "mp4" && mimeType === "video/mp4") ||
    (extension === "m4a" && mimeType === "audio/mp4") ||
    (extension === "wav" && mimeType === "audio/wav") ||
    (extension === "webm" && mimeType === "audio/webm");
  if (!valid) {
    throw new SpeechApiError(
      "INVALID_INPUT",
      "STT 파일명 확장자와 MIME 형식이 일치하지 않습니다.",
    );
  }
  return filename;
}

function srtTime(seconds: number): string {
  const milliseconds = Math.max(0, Math.round(seconds * 1_000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1_000);
  const millis = milliseconds % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function cleanSubtitleText(value: string): string {
  return value.replace(/\r\n?/gu, "\n").replace(/\n+/gu, "\n").trim();
}

function cleanSpeakerLabel(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f[\]]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 80)
    : "";
}

function cleanSttPrompt(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const clean = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  if (clean.length > 1_000) {
    throw new SpeechApiError("INVALID_INPUT", "STT 힌트는 최대 1,000자입니다.");
  }
  return clean;
}

export function transcriptToSrt(segments: readonly TranscriptSegment[]): string {
  return [...segments]
    .filter((segment) => Number.isFinite(segment.start) && Number.isFinite(segment.end) && segment.end > segment.start && segment.text.trim())
    .sort((left, right) => left.start - right.start || left.end - right.end || left.text.localeCompare(right.text, "en-US"))
    .map((segment, index) => {
      const speaker = cleanSpeakerLabel(segment.speaker);
      const prefix = speaker ? `[${speaker}] ` : "";
      return `${index + 1}\n${srtTime(segment.start)} --> ${srtTime(segment.end)}\n${prefix}${cleanSubtitleText(segment.text)}\n`;
    })
    .join("\n");
}

/** Normalizes ordering and limits before controller/file output or callback publication. */
export function validateSttResult(value: unknown, expectedModel?: SttModel): SttResult {
  const record = recordValue(value);
  if (!record) throw new SpeechApiError("INVALID_RESPONSE", "STT 응답 형식이 올바르지 않습니다.");
  const model = record.model;
  if (!STT_MODELS.includes(model as SttModel) || (expectedModel !== undefined && model !== expectedModel)) {
    throw new SpeechApiError("INVALID_RESPONSE", "STT 응답 모델이 요청과 일치하지 않습니다.");
  }
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (!text) throw new SpeechApiError("EMPTY_RESPONSE", "AI가 빈 원고를 반환했습니다.");
  if (text.length > MAX_TRANSCRIPT_CHARACTERS) {
    throw new SpeechApiError("INVALID_RESPONSE", "STT 원고 응답이 허용된 크기를 초과했습니다.");
  }
  if (typeof record.srt !== "string") {
    throw new SpeechApiError("INVALID_RESPONSE", "STT SRT 응답 형식이 올바르지 않습니다.");
  }
  if (record.srt.length > MAX_TRANSCRIPT_SRT_CHARACTERS) {
    throw new SpeechApiError("INVALID_RESPONSE", "STT SRT 응답이 허용된 크기를 초과했습니다.");
  }
  const segments = (Array.isArray(record.segments) ? record.segments : [])
    .slice(0, MAX_TRANSCRIPT_SEGMENTS)
    .map(normalizeSegment)
    .filter((item): item is TranscriptSegment => Boolean(item))
    .sort((left, right) => left.start - right.start || left.end - right.end || left.text.localeCompare(right.text, "en-US"));
  const srt = transcriptToSrt(segments);
  if (srt.length > MAX_TRANSCRIPT_SRT_CHARACTERS) {
    throw new SpeechApiError("INVALID_RESPONSE", "정규화된 STT SRT가 허용된 크기를 초과했습니다.");
  }
  return { text, segments, srt, model: model as SttModel };
}

export class SpeechApiClient {
  readonly endpoint: string;
  private readonly apiKeyProvider: () => Promise<string>;
  private readonly fetcher: SpeechFetch;
  private readonly timeoutMs: number;
  private readonly setTimer: (handler: () => void, milliseconds: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(options: SpeechApiClientOptions = {}) {
    this.endpoint = validateSpeechEndpoint(options.endpoint ?? "https://api.openai.com/v1");
    this.apiKeyProvider = options.apiKeyProvider ?? defaultApiKeyProvider();
    this.fetcher = options.fetcher ?? (fetch as unknown as SpeechFetch);
    this.timeoutMs = Math.min(180_000, Math.max(5_000, Math.round(options.timeoutMs ?? 120_000)));
    this.setTimer = options.setTimer ?? ((handler, milliseconds) => setTimeout(handler, milliseconds));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  async synthesize(request: TtsRequest): Promise<TtsResult> {
    if (request.signal?.aborted) throw new SpeechApiError("CANCELLED", "AI 음성 요청이 취소되었습니다.");
    const text = requiredString(request.text, "TTS 대본", MAX_TTS_CHARACTERS);
    if (!TTS_MODELS.includes(request.model)) throw new SpeechApiError("INVALID_INPUT", "지원하지 않는 TTS 모델입니다.");
    if (!TTS_VOICES.includes(request.voice)) throw new SpeechApiError("INVALID_INPUT", "지원하지 않는 TTS 목소리입니다.");
    if (!["wav", "mp3", "aac", "flac"].includes(request.format)) throw new SpeechApiError("INVALID_INPUT", "지원하지 않는 TTS 파일 형식입니다.");
    const speed = Number(request.speed);
    if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) {
      throw new SpeechApiError("INVALID_INPUT", "TTS 속도는 0.25배에서 4배 사이여야 합니다.");
    }
    const body: Record<string, unknown> = {
      model: request.model,
      voice: request.voice,
      input: text,
      response_format: request.format,
      speed,
    };
    if (request.model === "gpt-4o-mini-tts" && request.instructions?.trim()) {
      body.instructions = requiredString(request.instructions, "말투 지시", MAX_TTS_CHARACTERS);
    }
    const response = await this.authorizedFetch(`${this.endpoint}/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, request.signal);
    if (!response.ok) throw await responseError(response);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return validateTtsResult({
      bytes,
      mimeType: mimeForTts(request.format),
      extension: request.format,
      model: request.model,
      voice: request.voice,
    }, request);
  }

  async transcribe(request: SttRequest): Promise<SttResult> {
    if (request.signal?.aborted) throw new SpeechApiError("CANCELLED", "AI 음성 요청이 취소되었습니다.");
    if (!(request.bytes instanceof Uint8Array) || request.bytes.byteLength === 0) {
      throw new SpeechApiError("INVALID_INPUT", "STT 입력 파일이 비어 있습니다.");
    }
    if (request.bytes.byteLength > MAX_STT_BYTES) {
      throw new SpeechApiError("FILE_TOO_LARGE", "STT 입력 파일은 25MB 이하여야 합니다.");
    }
    if (!STT_MODELS.includes(request.model)) throw new SpeechApiError("INVALID_INPUT", "지원하지 않는 STT 모델입니다.");
    const filename = validateSttFilename(request.filename, request.mimeType);
    const form = new FormData();
    form.append("file", new Blob([request.bytes.slice().buffer], { type: request.mimeType || "application/octet-stream" }), filename);
    form.append("model", request.model);
    const language = normalizedLanguage(request.language);
    const prompt = cleanSttPrompt(request.prompt);
    if (language) form.append("language", language);

    if (request.model === "gpt-4o-transcribe-diarize") {
      form.append("response_format", "diarized_json");
      form.append("chunking_strategy", "auto");
    } else if (request.model === "whisper-1") {
      form.append("response_format", "verbose_json");
      form.append("timestamp_granularities[]", "segment");
      if (prompt) form.append("prompt", prompt);
    } else {
      form.append("response_format", "json");
      if (prompt) form.append("prompt", prompt);
    }

    const response = await this.authorizedFetch(`${this.endpoint}/audio/transcriptions`, {
      method: "POST",
      body: form,
    }, request.signal);
    if (!response.ok) throw await responseError(response);
    let payload: unknown;
    try { payload = await response.json?.(); } catch { payload = null; }
    if (!payload || typeof payload !== "object") throw new SpeechApiError("INVALID_RESPONSE", "STT 응답 형식이 올바르지 않습니다.");
    const record = payload as Record<string, unknown>;
    return validateSttResult({
      text: record.text,
      segments: record.segments,
      srt: typeof record.srt === "string" ? record.srt : "",
      model: request.model,
    }, request.model);
  }

  private async authorizedFetch(
    url: string,
    init: RequestInit,
    externalSignal?: AbortSignal,
  ): Promise<SpeechResponseLike> {
    if (externalSignal?.aborted) throw new SpeechApiError("CANCELLED", "AI 음성 요청이 취소되었습니다.");
    const key = validateApiKey(await this.apiKeyProvider());
    if (externalSignal?.aborted) throw new SpeechApiError("CANCELLED", "AI 음성 요청이 취소되었습니다.");
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    let timedOut = false;
    let timer: unknown;
    let removeAbortListener: (() => void) | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = this.setTimer(() => {
        timedOut = true;
        controller?.abort();
        reject(new SpeechApiError("TIMEOUT", "AI 음성 요청 시간이 초과되었습니다."));
      }, this.timeoutMs);
    });
    const cancellation = externalSignal
      ? new Promise<never>((_resolve, reject) => {
        const abort = (): void => {
          controller?.abort();
          reject(new SpeechApiError("CANCELLED", "AI 음성 요청이 취소되었습니다."));
        };
        externalSignal.addEventListener("abort", abort, { once: true });
        removeAbortListener = () => externalSignal.removeEventListener("abort", abort);
      })
      : null;
    try {
      const pendingResponse = Promise.resolve().then(() => this.fetcher(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${key}` },
        ...(controller ? { signal: controller.signal } : {}),
      }));
      const response = await Promise.race(cancellation ? [pendingResponse, timeout, cancellation] : [pendingResponse, timeout]);
      if (!response.ok) throw await responseError(response, key);
      return response;
    } catch (error) {
      if (error instanceof SpeechApiError) throw error;
      if (externalSignal?.aborted) throw new SpeechApiError("CANCELLED", "AI 음성 요청이 취소되었습니다.");
      if (timedOut || controller?.signal.aborted) throw new SpeechApiError("TIMEOUT", "AI 음성 요청 시간이 초과되었습니다.");
      const rawMessage = error instanceof Error ? error.message : String(error);
      const message = cleanResponseMessage(rawMessage.split(key).join("[API 키 숨김]"));
      throw new SpeechApiError("NETWORK_ERROR", message ? `AI 음성 서버에 연결하지 못했습니다. ${message}` : "AI 음성 서버에 연결하지 못했습니다.");
    } finally {
      if (timer !== undefined) this.clearTimer(timer);
      removeAbortListener?.();
    }
  }
}
