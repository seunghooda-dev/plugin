import { sanitizeFileName } from "./core";

export type MaybePromise<T> = T | Promise<T>;
export type SpeechOutputKind = "tts" | "stt";
export type TtsAudioFormat = "wav" | "mp3" | "aac" | "flac";
export type TranscriptFormat = "txt" | "srt";
export type SpeechOutputFormat = TtsAudioFormat | TranscriptFormat;
export type SpeechBinary = ArrayBuffer | ArrayBufferView | readonly number[];

export interface SpeechFileEntry {
  name?: string;
  nativePath?: string;
  isFile?: boolean;
  read?(options?: { format?: unknown }): MaybePromise<unknown>;
  write?(data: string | ArrayBuffer, options?: { format?: unknown }): MaybePromise<unknown>;
}

export interface SpeechFolderEntry {
  name?: string;
  nativePath?: string;
  isFolder?: boolean;
  getEntries(): Promise<Array<SpeechFileEntry | SpeechFolderEntry>>;
  createFile(
    name: string,
    options?: { overwrite?: boolean },
  ): Promise<SpeechFileEntry>;
}

export interface SpeechLocalFileSystemAdapter {
  getFileForOpening(options?: {
    allowMultiple?: boolean;
    types?: readonly string[];
  }): Promise<SpeechFileEntry | SpeechFileEntry[] | null | undefined>;
  getFolder(): Promise<SpeechFolderEntry | null | undefined>;
  createPersistentToken(entry: SpeechFolderEntry): Promise<string>;
  getEntryForPersistentToken(token: string): Promise<SpeechFileEntry | SpeechFolderEntry>;
}

export interface SpeechStorageAdapter {
  getItem(key: string): MaybePromise<unknown>;
  setItem(key: string, value: string): MaybePromise<unknown>;
  removeItem?(key: string): MaybePromise<unknown>;
}

export interface SpeechFileAdapter {
  localFileSystem: SpeechLocalFileSystemAdapter;
  storage: SpeechStorageAdapter;
  binaryFormat: unknown;
  textFormat: unknown;
}

export interface DefaultSpeechFileAdapterOptions {
  uxp?: unknown;
  storage?: SpeechStorageAdapter;
}

export interface SpeechInputFile {
  entry: SpeechFileEntry;
  name: string;
  nativePath: string;
  extension: SttInputExtension;
  mimeType: string;
  bytes: Uint8Array;
  size: number;
}

export interface SpeechOutputFolder {
  kind: SpeechOutputKind;
  entry: SpeechFolderEntry;
  token: string;
  name: string;
  nativePath: string;
}

export interface SpeechWriteResult {
  kind: SpeechOutputKind;
  format: SpeechOutputFormat;
  entry: SpeechFileEntry;
  name: string;
  nativePath: string;
  size: number;
}

export interface SpeechFileManagerOptions {
  tokenKeys?: Partial<Record<SpeechOutputKind, string>>;
}

export type SpeechFileErrorCode =
  | "CANCELLED"
  | "EMPTY_FILE"
  | "FILE_TOO_LARGE"
  | "FILESYSTEM_ERROR"
  | "INVALID_ENTRY"
  | "INVALID_FILENAME"
  | "INVALID_FORMAT"
  | "OUTPUT_FOLDER_NOT_SET"
  | "PERMISSION_DENIED"
  | "STORAGE_ERROR"
  | "TOKEN_EXPIRED"
  | "UNSUPPORTED_API"
  | "UNSUPPORTED_FILE"
  | "WRITE_FAILED";

export class SpeechFileError extends Error {
  override readonly name = "SpeechFileError";
  readonly code: SpeechFileErrorCode;
  readonly originalError?: unknown;

  constructor(code: SpeechFileErrorCode, message: string, originalError?: unknown) {
    super(message);
    this.code = code;
    if (originalError !== undefined) {
      this.originalError = originalError;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export const MAX_STT_INPUT_BYTES = 25 * 1024 * 1024;
export const TTS_OUTPUT_FOLDER_TOKEN_KEY = "shortflow.speech.ttsOutputFolderToken";
export const STT_OUTPUT_FOLDER_TOKEN_KEY = "shortflow.speech.sttOutputFolderToken";

export const STT_INPUT_TYPES = Object.freeze([
  "mp3",
  "mp4",
  "mpeg",
  "mpga",
  "m4a",
  "wav",
  "webm",
] as const);

export type SttInputExtension = (typeof STT_INPUT_TYPES)[number];

const STT_INPUT_SET = new Set<string>(STT_INPUT_TYPES);
const TTS_FORMAT_SET = new Set<TtsAudioFormat>(["wav", "mp3", "aac", "flac"]);
const TRANSCRIPT_FORMAT_SET = new Set<TranscriptFormat>(["txt", "srt"]);
const MAX_FILENAME_LENGTH = 180;
const MAX_COLLISION_ATTEMPTS = 10_000;

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function extensionOf(pathOrName: string): string {
  const clean = pathOrName.trim().split(/[?#]/u, 1)[0] ?? "";
  const filename = clean.slice(Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\")) + 1);
  const dot = filename.lastIndexOf(".");
  return dot > 0 && dot < filename.length - 1
    ? filename.slice(dot + 1).toLocaleLowerCase("en-US")
    : "";
}

export function classifySttInput(pathOrName: string): SttInputExtension | null {
  if (typeof pathOrName !== "string" || !pathOrName.trim()) {
    return null;
  }
  const extension = extensionOf(pathOrName);
  return STT_INPUT_SET.has(extension) ? extension as SttInputExtension : null;
}

export function sttMimeType(extension: SttInputExtension): string {
  switch (extension) {
    case "mp3":
    case "mpeg":
    case "mpga":
      return "audio/mpeg";
    case "mp4":
      return "video/mp4";
    case "m4a":
      return "audio/mp4";
    case "wav":
      return "audio/wav";
    case "webm":
      return "audio/webm";
  }
}

export function speechBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value.slice();
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value.slice(0));
  }
  if (ArrayBuffer.isView(value)) {
    const source = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return source.slice();
  }
  if (
    Array.isArray(value)
    && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  ) {
    return Uint8Array.from(value as number[]);
  }
  throw new SpeechFileError(
    "INVALID_ENTRY",
    "파일을 바이너리 데이터로 읽지 못했습니다.",
  );
}

/** UXP 25.6에서도 동작하도록 TextEncoder 없이 UTF-8 바이트 수를 계산합니다. */
export function utf8ByteLength(value: string): number {
  let length = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0x80) {
      length += 1;
    } else if (codeUnit < 0x800) {
      length += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        length += 4;
        index += 1;
      } else {
        length += 3;
      }
    } else {
      length += 3;
    }
  }
  return length;
}

export function validateSttBytes(value: unknown): Uint8Array {
  const bytes = speechBytes(value);
  if (bytes.byteLength === 0) {
    throw new SpeechFileError("EMPTY_FILE", "선택한 음성 파일이 비어 있습니다.");
  }
  if (bytes.byteLength > MAX_STT_INPUT_BYTES) {
    throw new SpeechFileError(
      "FILE_TOO_LARGE",
      "STT 입력 파일은 실제 바이너리 크기가 25MB 이하여야 합니다.",
    );
  }
  return bytes;
}

function normalizeOutputFormat(format: string): SpeechOutputFormat {
  const normalized = format.trim().replace(/^\./u, "").toLocaleLowerCase("en-US");
  if (TTS_FORMAT_SET.has(normalized as TtsAudioFormat)) {
    return normalized as TtsAudioFormat;
  }
  if (TRANSCRIPT_FORMAT_SET.has(normalized as TranscriptFormat)) {
    return normalized as TranscriptFormat;
  }
  throw new SpeechFileError(
    "INVALID_FORMAT",
    "지원하지 않는 음성 출력 파일 형식입니다.",
  );
}

export function safeSpeechFilename(
  requestedName: string,
  format: SpeechOutputFormat,
): string {
  const extension = normalizeOutputFormat(format);
  const raw = String(requestedName ?? "")
    .replace(/[\\/]+/gu, " ")
    .replace(/\.[a-z0-9]{1,10}$/iu, "")
    .trim();
  const maximumStemLength = MAX_FILENAME_LENGTH - extension.length - 1;
  const stem = sanitizeFileName(raw, maximumStemLength);
  if (!stem) {
    throw new SpeechFileError("INVALID_FILENAME", "안전한 출력 파일 이름을 만들지 못했습니다.");
  }
  return `${stem}.${extension}`;
}

function splitFilename(filename: string): { stem: string; extension: string } {
  const dot = filename.lastIndexOf(".");
  return dot > 0
    ? { stem: filename.slice(0, dot), extension: filename.slice(dot) }
    : { stem: filename, extension: "" };
}

export function uniqueSpeechFilename(
  requestedName: string,
  format: SpeechOutputFormat,
  existingNames: readonly string[],
): string {
  const safeName = safeSpeechFilename(requestedName, format);
  const occupied = new Set(
    existingNames.map((name) => name.normalize("NFC").toLocaleLowerCase("en-US")),
  );
  if (!occupied.has(safeName.normalize("NFC").toLocaleLowerCase("en-US"))) {
    return safeName;
  }

  const { stem, extension } = splitFilename(safeName);
  for (let index = 2; index <= MAX_COLLISION_ATTEMPTS; index += 1) {
    const suffix = ` (${index})`;
    const candidate = `${stem.slice(0, MAX_FILENAME_LENGTH - extension.length - suffix.length)}${suffix}${extension}`;
    if (!occupied.has(candidate.normalize("NFC").toLocaleLowerCase("en-US"))) {
      return candidate;
    }
  }
  throw new SpeechFileError(
    "INVALID_FILENAME",
    "동일한 이름의 파일이 너무 많아 충돌 없는 파일 이름을 만들지 못했습니다.",
  );
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name} ${error.message}`.trim();
  }
  const record = recordValue(error);
  if (record) {
    return `${String(record.code ?? "")} ${String(record.message ?? "")}`.trim();
  }
  return String(error ?? "");
}

function isCancellation(error: unknown): boolean {
  return /abort|cancel|canceled|cancelled|dismiss|user.?closed/iu.test(errorText(error));
}

function isPermissionError(error: unknown): boolean {
  return /access|denied|forbidden|not.?allowed|permission|security|unauthor|read.?only/iu.test(
    errorText(error),
  );
}

function fileSystemError(error: unknown, message: string): SpeechFileError {
  if (error instanceof SpeechFileError) {
    return error;
  }
  if (isCancellation(error)) {
    return new SpeechFileError("CANCELLED", "파일 선택이 취소되었습니다.", error);
  }
  if (isPermissionError(error)) {
    return new SpeechFileError(
      "PERMISSION_DENIED",
      "선택한 파일 또는 폴더에 접근할 권한이 없습니다.",
      error,
    );
  }
  return new SpeechFileError("FILESYSTEM_ERROR", message, error);
}

function storageError(error: unknown, message: string): SpeechFileError {
  return error instanceof SpeechFileError
    ? error
    : new SpeechFileError("STORAGE_ERROR", message, error);
}

function entryName(entry: { name?: string; nativePath?: string }): string {
  if (typeof entry.name === "string" && entry.name.trim()) {
    return entry.name.trim();
  }
  const path = typeof entry.nativePath === "string" ? entry.nativePath.trim() : "";
  const segments = path.split(/[\\/]/u);
  return segments[segments.length - 1]?.trim() ?? "";
}

function entryPath(entry: { nativePath?: string }): string {
  return typeof entry.nativePath === "string" ? entry.nativePath.trim() : "";
}

function isFile(entry: unknown): entry is SpeechFileEntry {
  const record = recordValue(entry);
  return Boolean(
    record
    && record.isFile !== false
    && entryName(record)
    && entryPath(record),
  );
}

function isFolder(entry: unknown): entry is SpeechFolderEntry {
  const record = recordValue(entry);
  return Boolean(
    record
    && record.isFolder !== false
    && typeof record.getEntries === "function"
    && typeof record.createFile === "function",
  );
}

export function createDefaultSpeechFileAdapter(
  options: DefaultSpeechFileAdapterOptions = {},
): SpeechFileAdapter {
  let uxp = options.uxp;
  if (!uxp) {
    try {
      uxp = require("uxp");
    } catch (error) {
      throw new SpeechFileError(
        "UNSUPPORTED_API",
        "UXP 파일 시스템을 사용할 수 없습니다. Premiere Pro UXP 패널에서 실행해 주세요.",
        error,
      );
    }
  }
  const uxpRecord = recordValue(uxp);
  const storageRecord = recordValue(uxpRecord?.storage);
  const localFileSystem = storageRecord?.localFileSystem as
    | SpeechLocalFileSystemAdapter
    | undefined;
  const formats = recordValue(storageRecord?.formats);
  const globalStorage = (
    globalThis as unknown as { localStorage?: SpeechStorageAdapter }
  ).localStorage;
  const storage = options.storage ?? globalStorage;
  if (!localFileSystem || !formats || !("binary" in formats) || !("utf8" in formats) || !storage) {
    throw new SpeechFileError(
      "UNSUPPORTED_API",
      "UXP localFileSystem, binary/utf8 형식 또는 localStorage를 사용할 수 없습니다.",
    );
  }
  return {
    localFileSystem,
    storage,
    binaryFormat: formats.binary,
    textFormat: formats.utf8,
  };
}

export class SpeechFileManager {
  readonly adapter: SpeechFileAdapter;
  readonly tokenKeys: Readonly<Record<SpeechOutputKind, string>>;
  private readonly folders = new Map<SpeechOutputKind, SpeechOutputFolder>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(adapter: SpeechFileAdapter, options: SpeechFileManagerOptions = {}) {
    if (!adapter?.localFileSystem || !adapter.storage) {
      throw new SpeechFileError(
        "UNSUPPORTED_API",
        "음성 파일 관리자에 UXP 파일 시스템과 저장소가 필요합니다.",
      );
    }
    this.adapter = adapter;
    this.tokenKeys = Object.freeze({
      tts: options.tokenKeys?.tts?.trim() || TTS_OUTPUT_FOLDER_TOKEN_KEY,
      stt: options.tokenKeys?.stt?.trim() || STT_OUTPUT_FOLDER_TOKEN_KEY,
    });
  }

  async selectSttInput(): Promise<SpeechInputFile> {
    let result: SpeechFileEntry | SpeechFileEntry[] | null | undefined;
    try {
      result = await this.adapter.localFileSystem.getFileForOpening({
        allowMultiple: false,
        types: STT_INPUT_TYPES,
      });
    } catch (error) {
      throw fileSystemError(error, "STT 입력 파일 선택 창을 열지 못했습니다.");
    }
    const entry = Array.isArray(result) ? result[0] : result;
    if (!entry) {
      throw new SpeechFileError("CANCELLED", "STT 입력 파일 선택이 취소되었습니다.");
    }
    if (!isFile(entry) || typeof entry.read !== "function") {
      throw new SpeechFileError("INVALID_ENTRY", "선택한 항목이 읽을 수 있는 파일이 아닙니다.");
    }
    const name = entryName(entry);
    const extension = classifySttInput(name || entryPath(entry));
    if (!extension) {
      throw new SpeechFileError(
        "UNSUPPORTED_FILE",
        "STT는 MP3, MP4, MPEG, MPGA, M4A, WAV, WEBM 파일만 지원합니다.",
      );
    }

    let raw: unknown;
    try {
      raw = await entry.read({ format: this.adapter.binaryFormat });
    } catch (error) {
      throw fileSystemError(error, `${name} 파일을 바이너리로 읽지 못했습니다.`);
    }
    const bytes = validateSttBytes(raw);
    return {
      entry,
      name,
      nativePath: entryPath(entry),
      extension,
      mimeType: sttMimeType(extension),
      bytes,
      size: bytes.byteLength,
    };
  }

  async selectOutputFolder(kind: SpeechOutputKind): Promise<SpeechOutputFolder> {
    let folder: SpeechFolderEntry | null | undefined;
    try {
      folder = await this.adapter.localFileSystem.getFolder();
    } catch (error) {
      throw fileSystemError(error, "음성 출력 폴더 선택 창을 열지 못했습니다.");
    }
    if (!folder) {
      throw new SpeechFileError("CANCELLED", "음성 출력 폴더 선택이 취소되었습니다.");
    }
    if (!isFolder(folder)) {
      throw new SpeechFileError("INVALID_ENTRY", "출력 위치에는 파일이 아닌 폴더를 선택해 주세요.");
    }

    let token: string;
    try {
      token = (await this.adapter.localFileSystem.createPersistentToken(folder)).trim();
    } catch (error) {
      throw fileSystemError(error, "출력 폴더 접근 토큰을 만들지 못했습니다.");
    }
    if (!token) {
      throw new SpeechFileError("FILESYSTEM_ERROR", "출력 폴더 접근 토큰이 비어 있습니다.");
    }
    try {
      await this.adapter.storage.setItem(this.tokenKeys[kind], token);
    } catch (error) {
      throw storageError(error, "출력 폴더 접근 토큰을 저장하지 못했습니다.");
    }
    const result: SpeechOutputFolder = {
      kind,
      entry: folder,
      token,
      name: entryName(folder),
      nativePath: entryPath(folder),
    };
    this.folders.set(kind, result);
    return { ...result };
  }

  async restoreOutputFolder(kind: SpeechOutputKind): Promise<SpeechOutputFolder | null> {
    let stored: unknown;
    try {
      stored = await this.adapter.storage.getItem(this.tokenKeys[kind]);
    } catch (error) {
      throw storageError(error, "저장된 출력 폴더 설정을 읽지 못했습니다.");
    }
    const token = typeof stored === "string" ? stored.trim() : "";
    if (!token) {
      this.folders.delete(kind);
      return null;
    }

    let entry: SpeechFileEntry | SpeechFolderEntry;
    try {
      entry = await this.adapter.localFileSystem.getEntryForPersistentToken(token);
    } catch (error) {
      await this.removeExpiredToken(kind);
      throw new SpeechFileError(
        "TOKEN_EXPIRED",
        "출력 폴더 권한이 만료되었거나 폴더가 이동되었습니다. 폴더를 다시 선택해 주세요.",
        error,
      );
    }
    if (!isFolder(entry)) {
      await this.removeExpiredToken(kind);
      throw new SpeechFileError(
        "TOKEN_EXPIRED",
        "저장된 출력 폴더를 찾을 수 없습니다. 폴더를 다시 선택해 주세요.",
      );
    }
    const result: SpeechOutputFolder = {
      kind,
      entry,
      token,
      name: entryName(entry),
      nativePath: entryPath(entry),
    };
    this.folders.set(kind, result);
    return { ...result };
  }

  async clearOutputFolder(kind: SpeechOutputKind): Promise<void> {
    try {
      if (this.adapter.storage.removeItem) {
        await this.adapter.storage.removeItem(this.tokenKeys[kind]);
      } else {
        await this.adapter.storage.setItem(this.tokenKeys[kind], "");
      }
    } catch (error) {
      throw storageError(error, "출력 폴더 설정을 지우지 못했습니다.");
    }
    this.folders.delete(kind);
  }

  async writeTtsAudio(
    data: SpeechBinary,
    requestedName: string,
    format: TtsAudioFormat,
  ): Promise<SpeechWriteResult> {
    if (!TTS_FORMAT_SET.has(format)) {
      throw new SpeechFileError("INVALID_FORMAT", "TTS 출력은 WAV, MP3, AAC, FLAC만 지원합니다.");
    }
    const bytes = speechBytes(data);
    if (bytes.byteLength === 0) {
      throw new SpeechFileError("EMPTY_FILE", "저장할 TTS 오디오 데이터가 비어 있습니다.");
    }
    return this.enqueueWrite(() => this.writeBinary("tts", bytes, requestedName, format));
  }

  async writeTranscript(
    text: string,
    requestedName: string,
    format: TranscriptFormat,
  ): Promise<SpeechWriteResult> {
    if (!TRANSCRIPT_FORMAT_SET.has(format)) {
      throw new SpeechFileError("INVALID_FORMAT", "STT 텍스트 출력은 TXT 또는 SRT만 지원합니다.");
    }
    if (typeof text !== "string" || text.length === 0) {
      throw new SpeechFileError("EMPTY_FILE", "저장할 STT 텍스트가 비어 있습니다.");
    }
    return this.enqueueWrite(() => this.writeText("stt", text, requestedName, format));
  }

  private async writeBinary(
    kind: SpeechOutputKind,
    bytes: Uint8Array,
    requestedName: string,
    format: TtsAudioFormat,
  ): Promise<SpeechWriteResult> {
    const folder = await this.requireOutputFolder(kind);
    const { entry, name } = await this.createCollisionFreeFile(folder.entry, requestedName, format);
    if (typeof entry.write !== "function") {
      throw new SpeechFileError("WRITE_FAILED", "생성한 출력 파일에 쓰기 기능이 없습니다.");
    }
    try {
      const buffer = bytes.slice().buffer;
      await entry.write(buffer, { format: this.adapter.binaryFormat });
    } catch (error) {
      throw fileSystemError(error, `${name} 오디오 파일을 저장하지 못했습니다.`);
    }
    return {
      kind,
      format,
      entry,
      name,
      nativePath: entryPath(entry),
      size: bytes.byteLength,
    };
  }

  private async writeText(
    kind: SpeechOutputKind,
    text: string,
    requestedName: string,
    format: TranscriptFormat,
  ): Promise<SpeechWriteResult> {
    const folder = await this.requireOutputFolder(kind);
    const { entry, name } = await this.createCollisionFreeFile(folder.entry, requestedName, format);
    if (typeof entry.write !== "function") {
      throw new SpeechFileError("WRITE_FAILED", "생성한 출력 파일에 쓰기 기능이 없습니다.");
    }
    try {
      await entry.write(text, { format: this.adapter.textFormat });
    } catch (error) {
      throw fileSystemError(error, `${name} 텍스트 파일을 저장하지 못했습니다.`);
    }
    return {
      kind,
      format,
      entry,
      name,
      nativePath: entryPath(entry),
      size: utf8ByteLength(text),
    };
  }

  private async requireOutputFolder(kind: SpeechOutputKind): Promise<SpeechOutputFolder> {
    const cached = this.folders.get(kind);
    if (cached) {
      return cached;
    }
    const restored = await this.restoreOutputFolder(kind);
    if (!restored) {
      throw new SpeechFileError(
        "OUTPUT_FOLDER_NOT_SET",
        kind === "tts"
          ? "먼저 TTS 오디오 출력 폴더를 선택해 주세요."
          : "먼저 STT 텍스트 출력 폴더를 선택해 주세요.",
      );
    }
    return restored;
  }

  private async createCollisionFreeFile(
    folder: SpeechFolderEntry,
    requestedName: string,
    format: SpeechOutputFormat,
  ): Promise<{ entry: SpeechFileEntry; name: string }> {
    let entries: Array<SpeechFileEntry | SpeechFolderEntry>;
    try {
      entries = await folder.getEntries();
    } catch (error) {
      throw fileSystemError(error, "출력 폴더의 파일 목록을 읽지 못했습니다.");
    }
    const existingNames = entries.map(entryName).filter(Boolean);
    let name = uniqueSpeechFilename(requestedName, format, existingNames);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const entry = await folder.createFile(name, { overwrite: false });
        if (!isFile(entry)) {
          throw new SpeechFileError("WRITE_FAILED", "출력 파일을 생성하지 못했습니다.");
        }
        return { entry, name };
      } catch (error) {
        if (!/exist|already|duplicate|collision/iu.test(errorText(error))) {
          throw fileSystemError(error, `${name} 출력 파일을 생성하지 못했습니다.`);
        }
        existingNames.push(name);
        name = uniqueSpeechFilename(requestedName, format, existingNames);
      }
    }
    throw new SpeechFileError(
      "WRITE_FAILED",
      "동시에 같은 이름의 파일이 반복 생성되어 안전한 출력 파일을 만들지 못했습니다.",
    );
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(operation, operation);
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async removeExpiredToken(kind: SpeechOutputKind): Promise<void> {
    this.folders.delete(kind);
    try {
      if (this.adapter.storage.removeItem) {
        await this.adapter.storage.removeItem(this.tokenKeys[kind]);
      } else {
        await this.adapter.storage.setItem(this.tokenKeys[kind], "");
      }
    } catch {
      // The token is unusable either way; a storage cleanup failure must not hide that fact.
    }
  }
}
