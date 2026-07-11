import {
  SUBTITLE_DOCUMENT_VERSION,
  SubtitleUndoRedo,
  buildSrt,
  cloneSubtitleDocument,
  createSubtitleDocument,
  deserializeSubtitleAutosave,
  editSubtitleWord,
  findActiveSubtitle,
  joinSubtitleWords,
  mergeSubtitleCues,
  normalizeSubtitleDocument,
  parseSrt,
  reflowSubtitleCues,
  secondsToSrtTime,
  serializeSubtitleAutosave,
  setSubtitleCueEnabled,
  setSubtitleWordHidden,
  splitSubtitleCue,
  subtitleAutosaveKey,
  subtitleSeekTime,
  validateSubtitleDocument,
  type ActiveSubtitlePosition,
  type SubtitleDocument,
} from "./subtitles";

export const DEFAULT_SUBTITLE_DOM_LIMIT = 300;
export const MAX_SUBTITLE_DOM_LIMIT = 1_000;
export const DEFAULT_SUBTITLE_DOM_WORD_LIMIT = 5_000;
export const MAX_SUBTITLE_DOM_WORD_LIMIT = 20_000;
export const DEFAULT_SUBTITLE_CUE_LIMIT = 5_000;
export const MAX_SUBTITLE_CUE_LIMIT = 10_000;
export const MAX_SUBTITLE_WORDS_PER_CUE = 1_000;
export const MAX_SUBTITLE_TEXT_LENGTH = 20_000;
export const MAX_SUBTITLE_TOTAL_WORDS = 200_000;
export const MAX_SUBTITLE_TOTAL_TEXT_LENGTH = 5_000_000;
export const MAX_SUBTITLE_AI_JSON_BYTES = 2 * 1024 * 1024;

type MaybePromise<T> = T | Promise<T>;

export interface SubtitleDomEvent {
  target?: SubtitleDomElement | null;
  key?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  preventDefault(): void;
}

export interface SubtitleDomClassList {
  add(...tokens: string[]): void;
  remove(...tokens: string[]): void;
  toggle(token: string, force?: boolean): boolean;
  contains(token: string): boolean;
}

export interface SubtitleDomElement {
  id: string;
  tagName: string;
  className: string;
  textContent: string;
  value: string;
  disabled: boolean;
  hidden: boolean;
  checked: boolean;
  title: string;
  dataset: Record<string, string | undefined>;
  parentElement: SubtitleDomElement | null;
  readonly children: readonly SubtitleDomElement[];
  readonly classList: SubtitleDomClassList;
  append(...nodes: SubtitleDomElement[]): void;
  replaceChildren(...nodes: SubtitleDomElement[]): void;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getAttribute(name: string): string | null;
  addEventListener(type: string, listener: (event: SubtitleDomEvent) => void): void;
  removeEventListener(type: string, listener: (event: SubtitleDomEvent) => void): void;
  querySelector(selector: string): SubtitleDomElement | null;
  querySelectorAll(selector: string): readonly SubtitleDomElement[];
  focus?(): void;
  click?(): void;
  scrollIntoView?(options?: unknown): void;
}

export interface SubtitleDomDocument {
  getElementById(id: string): SubtitleDomElement | null;
  createElement(tagName: string): SubtitleDomElement;
}

export interface SubtitleStorageAdapter {
  getItem(key: string): MaybePromise<unknown>;
  setItem(key: string, value: string): MaybePromise<unknown>;
  removeItem?(key: string): MaybePromise<unknown>;
}

export type SubtitleAiAction = "reflow" | "review" | "translate";

export interface SubtitleAiRequest {
  action: SubtitleAiAction;
  document: SubtitleDocument;
  maxChars: number;
  targetLanguage?: string;
}

export interface SubtitleAiValidationOptions {
  maxCueCount?: number;
}

export interface SubtitleControllerOptions {
  dom?: SubtitleDomDocument;
  getProjectKey?: () => MaybePromise<string>;
  storage?: SubtitleStorageAdapter | null;
  onSeek?: (seconds: number, cueId: string, wordId?: string) => MaybePromise<void>;
  onChange?: (document: SubtitleDocument) => void;
  onImportSrt?: () => MaybePromise<string | null | undefined>;
  onExportSrt?: (srt: string, suggestedName: string) => MaybePromise<void>;
  aiProvider?: (request: SubtitleAiRequest) => MaybePromise<unknown>;
  validateAiResponse?: (
    payload: unknown,
    request: SubtitleAiRequest,
    defaultValidator: (payload: unknown) => SubtitleDocument,
  ) => MaybePromise<SubtitleDocument>;
  onActivity?: (message: string) => void;
  onError?: (error: unknown, context: string) => void;
  maxCueCount?: number;
  domCueLimit?: number;
  domWordLimit?: number;
  autosaveDelayMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanProjectKey(value: unknown): string {
  return createSubtitleDocument(typeof value === "string" ? value : "untitled-project").projectKey;
}

function integerInRange(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed)
    ? Math.max(minimum, Math.min(maximum, Math.round(parsed)))
    : fallback;
}

function documentIssueMessage(document: unknown): string {
  const result = validateSubtitleDocument(document);
  return result.valid
    ? ""
    : result.issues.slice(0, 3).map((issue) => `${issue.path}: ${issue.message}`).join(" ");
}

function preflightDocumentShape(value: unknown, maximum: number): void {
  if (!isRecord(value) || !Array.isArray(value.cues)) return;
  if (value.cues.length > maximum) {
    throw new Error(`자막 큐는 최대 ${maximum.toLocaleString("ko-KR")}개까지 처리할 수 있습니다.`);
  }
  let totalWords = 0;
  let totalTextLength = 0;
  for (const rawCue of value.cues) {
    if (!isRecord(rawCue)) continue;
    const textLength = typeof rawCue.text === "string" ? rawCue.text.length : 0;
    const wordCount = Array.isArray(rawCue.words) ? rawCue.words.length : 0;
    if (textLength > MAX_SUBTITLE_TEXT_LENGTH) {
      throw new Error(`자막 큐 텍스트가 안전 제한 ${MAX_SUBTITLE_TEXT_LENGTH.toLocaleString("ko-KR")}자를 초과했습니다.`);
    }
    if (wordCount > MAX_SUBTITLE_WORDS_PER_CUE) {
      throw new Error(`자막 큐 단어 수가 안전 제한 ${MAX_SUBTITLE_WORDS_PER_CUE.toLocaleString("ko-KR")}개를 초과했습니다.`);
    }
    totalTextLength += textLength;
    totalWords += wordCount;
    if (totalTextLength > MAX_SUBTITLE_TOTAL_TEXT_LENGTH || totalWords > MAX_SUBTITLE_TOTAL_WORDS) break;
  }
  if (totalWords > MAX_SUBTITLE_TOTAL_WORDS) {
    throw new Error(`자막 문서의 전체 단어 수가 안전 제한 ${MAX_SUBTITLE_TOTAL_WORDS.toLocaleString("ko-KR")}개를 초과했습니다.`);
  }
  if (totalTextLength > MAX_SUBTITLE_TOTAL_TEXT_LENGTH) {
    throw new Error(`자막 문서의 전체 텍스트가 안전 제한 ${MAX_SUBTITLE_TOTAL_TEXT_LENGTH.toLocaleString("ko-KR")}자를 초과했습니다.`);
  }
}

function enforceDocumentLimits(document: SubtitleDocument, maximum: number): SubtitleDocument {
  const validationMessage = documentIssueMessage(document);
  if (validationMessage) throw new Error(`자막 문서 형식이 올바르지 않습니다. ${validationMessage}`);
  if (document.cues.length > maximum) {
    throw new Error(`자막 큐는 최대 ${maximum.toLocaleString("ko-KR")}개까지 처리할 수 있습니다.`);
  }
  let totalWords = 0;
  let totalTextLength = 0;
  for (const cue of document.cues) {
    totalWords += cue.words.length;
    totalTextLength += cue.text.length;
    if (cue.text.length > MAX_SUBTITLE_TEXT_LENGTH) {
      throw new Error(`큐 ${cue.cueId}의 텍스트가 안전 제한 ${MAX_SUBTITLE_TEXT_LENGTH.toLocaleString("ko-KR")}자를 초과했습니다.`);
    }
    if (cue.words.length > MAX_SUBTITLE_WORDS_PER_CUE) {
      throw new Error(`큐 ${cue.cueId}의 단어 수가 안전 제한 ${MAX_SUBTITLE_WORDS_PER_CUE.toLocaleString("ko-KR")}개를 초과했습니다.`);
    }
  }
  if (totalWords > MAX_SUBTITLE_TOTAL_WORDS) {
    throw new Error(`자막 문서의 전체 단어 수가 안전 제한 ${MAX_SUBTITLE_TOTAL_WORDS.toLocaleString("ko-KR")}개를 초과했습니다.`);
  }
  if (totalTextLength > MAX_SUBTITLE_TOTAL_TEXT_LENGTH) {
    throw new Error(`자막 문서의 전체 텍스트가 안전 제한 ${MAX_SUBTITLE_TOTAL_TEXT_LENGTH.toLocaleString("ko-KR")}자를 초과했습니다.`);
  }
  return document;
}

function parseAiPayload(payload: unknown): unknown {
  if (typeof payload !== "string") return payload;
  let bytes = 0;
  for (let index = 0; index < payload.length; index += 1) {
    const code = payload.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < payload.length) {
      const next = payload.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
    if (bytes > MAX_SUBTITLE_AI_JSON_BYTES) break;
  }
  if (bytes > MAX_SUBTITLE_AI_JSON_BYTES) {
    throw new Error("AI 자막 응답이 2MB 안전 제한을 초과했습니다.");
  }
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    throw new Error("AI 자막 응답이 유효한 JSON이 아닙니다.");
  }
}

/** Strict default boundary for untrusted AI reflow/review/translation JSON. */
export function validateAiSubtitleResponse(
  payload: unknown,
  request: SubtitleAiRequest,
  options: SubtitleAiValidationOptions = {},
): SubtitleDocument {
  const parsed = parseAiPayload(payload);
  const wrapped = isRecord(parsed) && "document" in parsed ? parsed.document : parsed;
  if (!isRecord(wrapped) || !Array.isArray(wrapped.cues)) {
    throw new Error("AI 자막 응답에는 cues 배열이 필요합니다.");
  }
  const candidate = {
    ...wrapped,
    version: wrapped.version ?? SUBTITLE_DOCUMENT_VERSION,
    projectKey: wrapped.projectKey ?? request.document.projectKey,
  };
  if (candidate.projectKey !== request.document.projectKey) {
    throw new Error("AI 자막 응답의 프로젝트 키가 현재 문서와 일치하지 않습니다.");
  }
  const maximum = integerInRange(
    options.maxCueCount,
    DEFAULT_SUBTITLE_CUE_LIMIT,
    1,
    MAX_SUBTITLE_CUE_LIMIT,
  );
  preflightDocumentShape(candidate, maximum);
  const strictMessage = documentIssueMessage(candidate);
  if (strictMessage) throw new Error(`AI 자막 JSON 검증에 실패했습니다. ${strictMessage}`);
  const normalized = enforceDocumentLimits(normalizeSubtitleDocument(candidate), maximum);
  if (normalized.cues.length !== wrapped.cues.length) {
    throw new Error("AI 자막 응답에 정규화할 수 없는 큐가 포함되어 있습니다.");
  }
  if (request.action === "review" || request.action === "translate") {
    if (normalized.cues.length !== request.document.cues.length) {
      throw new Error("AI 검토·번역은 큐 개수를 변경할 수 없습니다.");
    }
    normalized.cues.forEach((cue, index) => {
      const sourceCue = request.document.cues[index];
      if (!sourceCue || cue.cueId !== sourceCue.cueId) {
        throw new Error("AI 검토·번역은 기존 cueId 순서를 유지해야 합니다.");
      }
      if (
        cue.start !== sourceCue.start || cue.end !== sourceCue.end ||
        cue.enabled !== sourceCue.enabled || cue.hidden !== sourceCue.hidden
      ) {
        throw new Error("AI 검토·번역은 큐 시간과 표시 상태를 변경할 수 없습니다.");
      }
      if (cue.words.length !== sourceCue.words.length) {
        throw new Error("AI 검토·번역은 단어 개수를 변경할 수 없습니다.");
      }
      cue.words.forEach((word, wordIndex) => {
        const sourceWord = sourceCue.words[wordIndex];
        if (!sourceWord || word.wordId !== sourceWord.wordId) {
          throw new Error("AI 검토·번역은 기존 wordId 순서를 유지해야 합니다.");
        }
        if (word.s !== sourceWord.s || word.e !== sourceWord.e || word.hidden !== sourceWord.hidden) {
          throw new Error("AI 검토·번역은 단어 시간과 숨김 상태를 변경할 수 없습니다.");
        }
      });
    });
  }
  if (request.action === "reflow") {
    const tooLong = normalized.cues.find((cue) => cue.enabled && !cue.hidden && cue.text.length > request.maxChars);
    if (tooLong) throw new Error(`AI 줄바꿈 결과에 ${request.maxChars}자를 초과한 큐가 있습니다.`);
    const sourceWords = request.document.cues.flatMap((cue) => cue.words);
    const resultWords = normalized.cues.flatMap((cue) => cue.words);
    if (resultWords.length !== sourceWords.length) {
      throw new Error("AI 줄바꿈은 단어를 추가하거나 삭제할 수 없습니다.");
    }
    resultWords.forEach((word, index) => {
      const sourceWord = sourceWords[index];
      if (
        word.wordId !== sourceWord?.wordId || word.t !== sourceWord.t ||
        word.s !== sourceWord.s || word.e !== sourceWord.e || word.hidden !== sourceWord.hidden
      ) {
        throw new Error("AI 줄바꿈은 단어 ID, 순서, 내용 및 시간을 유지해야 합니다.");
      }
    });
  }
  return normalized;
}

function defaultDom(): SubtitleDomDocument {
  const candidate = (globalThis as unknown as { document?: unknown }).document;
  if (!candidate) throw new Error("자막 편집기에 DOM document가 필요합니다.");
  return candidate as SubtitleDomDocument;
}

function defaultStorage(): SubtitleStorageAdapter | null {
  const candidate = (globalThis as unknown as { localStorage?: SubtitleStorageAdapter }).localStorage;
  return candidate ?? null;
}

function defaultSetTimer(callback: () => void, delayMs: number): unknown {
  return setTimeout(callback, delayMs);
}

function defaultClearTimer(timer: unknown): void {
  clearTimeout(timer as ReturnType<typeof setTimeout>);
}

function suggestedSrtName(projectKey: string): string {
  const safe = projectKey
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_")
    .replace(/\s+/gu, "_")
    .replace(/[. ]+$/gu, "")
    .slice(0, 80) || "ShortFlow";
  return `${safe}_subtitles.srt`;
}

function cleanTargetLanguage(value: string): string {
  const clean = value.trim().replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 32);
  if (!clean) throw new Error("번역 대상 언어를 입력해 주세요.");
  if (!/^[\p{L}][\p{L}\p{M}\p{N} -]*$/u.test(clean)) {
    throw new Error("번역 대상 언어에는 언어 이름만 입력해 주세요.");
  }
  if (/\b(?:ignore|instruction|system|prompt|assistant|schema|json|previous)\b/iu.test(clean)) {
    throw new Error("번역 대상 언어에 명령문을 포함할 수 없습니다.");
  }
  return clean;
}

function documentsEqual(left: SubtitleDocument, right: SubtitleDocument): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function closestWithData(
  start: SubtitleDomElement | null | undefined,
  key: string,
  boundary: SubtitleDomElement,
): SubtitleDomElement | null {
  let current = start ?? null;
  while (current) {
    if (current.dataset[key] !== undefined) return current;
    if (current === boundary) break;
    current = current.parentElement;
  }
  return null;
}

export class SubtitleController {
  private readonly dom: SubtitleDomDocument;
  private readonly storage: SubtitleStorageAdapter | null;
  private readonly maximumCues: number;
  private readonly domLimit: number;
  private readonly domWordLimit: number;
  private readonly autosaveDelay: number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private readonly cleanups: Array<() => void> = [];
  private documentValue = createSubtitleDocument("untitled-project");
  private history = new SubtitleUndoRedo(this.documentValue);
  private selectedCueId = "";
  private selectedWordId = "";
  private activePosition: ActiveSubtitlePosition | null = null;
  private lastPlayheadSeconds = Number.NaN;
  private autosaveTimer: unknown = null;
  private saveQueue: Promise<void> = Promise.resolve();
  private busyAction = "";
  private initialized = false;
  private renderedCueCount = 0;
  private renderedWordCount = 0;

  constructor(private readonly options: SubtitleControllerOptions = {}) {
    this.dom = options.dom ?? defaultDom();
    this.storage = options.storage === undefined ? defaultStorage() : options.storage;
    this.maximumCues = integerInRange(
      options.maxCueCount,
      DEFAULT_SUBTITLE_CUE_LIMIT,
      1,
      MAX_SUBTITLE_CUE_LIMIT,
    );
    this.domLimit = integerInRange(
      options.domCueLimit,
      DEFAULT_SUBTITLE_DOM_LIMIT,
      1,
      Math.min(MAX_SUBTITLE_DOM_LIMIT, this.maximumCues),
    );
    this.domWordLimit = integerInRange(
      options.domWordLimit,
      DEFAULT_SUBTITLE_DOM_WORD_LIMIT,
      1,
      MAX_SUBTITLE_DOM_WORD_LIMIT,
    );
    this.autosaveDelay = integerInRange(options.autosaveDelayMs, 500, 0, 60_000);
    this.setTimer = options.setTimer ?? defaultSetTimer;
    this.clearTimer = options.clearTimer ?? defaultClearTimer;
  }

  get document(): SubtitleDocument {
    return cloneSubtitleDocument(this.documentValue);
  }

  get projectKey(): string {
    return this.documentValue.projectKey;
  }

  get isBusy(): boolean {
    return Boolean(this.busyAction);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.bindEvents();
    const projectKey = cleanProjectKey(await this.options.getProjectKey?.() ?? this.projectKey);
    await this.loadProject(projectKey, false);
  }

  dispose(): void {
    this.cleanups.splice(0).forEach((cleanup) => cleanup());
    if (this.autosaveTimer !== null) this.clearTimer(this.autosaveTimer);
    this.autosaveTimer = null;
    void this.flushAutosave().catch((error) => this.reportError(error, "자막 자동 저장 실패"));
    this.initialized = false;
  }

  async loadProject(projectKey: string, flushCurrent = true): Promise<void> {
    if (flushCurrent) await this.flushAutosave();
    const clean = cleanProjectKey(projectKey);
    let next = createSubtitleDocument(clean);
    if (this.storage) {
      try {
        const raw = await this.storage.getItem(subtitleAutosaveKey(clean));
        if (typeof raw === "string" && raw.trim()) {
          next = enforceDocumentLimits(deserializeSubtitleAutosave(raw, clean), this.maximumCues);
          this.options.onActivity?.(`프로젝트 자막 자동 저장 ${next.cues.length}개를 복원했습니다.`);
        }
      } catch (error) {
        this.reportError(error, "프로젝트 자막 복원 실패");
      }
    }
    this.documentValue = next;
    this.history = new SubtitleUndoRedo(next);
    this.selectedCueId = "";
    this.selectedWordId = "";
    this.activePosition = null;
    this.lastPlayheadSeconds = Number.NaN;
    this.render();
    this.emitChange();
  }

  setDocument(value: SubtitleDocument, recordHistory = false): void {
    preflightDocumentShape(value, this.maximumCues);
    const normalized = enforceDocumentLimits(
      normalizeSubtitleDocument(value, { projectKey: this.projectKey }),
      this.maximumCues,
    );
    if (recordHistory) this.documentValue = this.history.commit(normalized);
    else {
      this.documentValue = normalized;
      this.history.reset(normalized);
    }
    this.selectedCueId = "";
    this.selectedWordId = "";
    this.render();
    this.emitChange();
    this.scheduleAutosave();
  }

  importSrtText(srt: string): SubtitleDocument {
    const parsed = parseSrt(srt, { projectKey: this.projectKey });
    if (parsed.cues.length === 0) throw new Error("SRT에서 유효한 자막 큐를 찾지 못했습니다.");
    this.commit(parsed, `SRT 자막 ${parsed.cues.length}개를 불러왔습니다.`);
    return this.document;
  }

  exportSrtText(): string {
    const srt = buildSrt(this.documentValue);
    if (!srt) throw new Error("내보낼 활성 자막 큐가 없습니다.");
    return srt;
  }

  editWord(cueId: string, wordId: string, text: string): void {
    this.commit(editSubtitleWord(this.documentValue, cueId, wordId, text), "자막 단어를 수정했습니다.");
  }

  toggleWordHidden(cueId: string, wordId: string): void {
    const cue = this.documentValue.cues.find((candidate) => candidate.cueId === cueId);
    const word = cue?.words.find((candidate) => candidate.wordId === wordId);
    if (!word) throw new Error(`자막 단어를 찾을 수 없습니다: ${wordId}`);
    this.commit(setSubtitleWordHidden(this.documentValue, cueId, wordId, !word.hidden), word.hidden ? "단어 숨김을 해제했습니다." : "단어를 숨겼습니다.");
  }

  joinWord(cueId: string, wordId: string, direction: "previous" | "next"): void {
    const cue = this.documentValue.cues.find((candidate) => candidate.cueId === cueId);
    const index = cue?.words.findIndex((word) => word.wordId === wordId) ?? -1;
    if (!cue || index < 0) throw new Error(`자막 단어를 찾을 수 없습니다: ${wordId}`);
    const other = cue.words[index + (direction === "previous" ? -1 : 1)];
    if (!other) throw new Error(direction === "previous" ? "붙일 앞 단어가 없습니다." : "붙일 다음 단어가 없습니다.");
    this.commit(joinSubtitleWords(this.documentValue, cueId, wordId, other.wordId), "두 단어를 붙였습니다.");
  }

  toggleCueEnabled(cueId: string): void {
    const cue = this.documentValue.cues.find((candidate) => candidate.cueId === cueId);
    if (!cue) throw new Error(`자막 큐를 찾을 수 없습니다: ${cueId}`);
    this.commit(setSubtitleCueEnabled(this.documentValue, cueId, !cue.enabled), cue.enabled ? "자막 큐를 비활성화했습니다." : "자막 큐를 활성화했습니다.");
  }

  splitCueAtWord(cueId: string, wordId: string): void {
    this.commit(splitSubtitleCue(this.documentValue, cueId, wordId), "선택한 단어 앞에서 자막 큐를 나눴습니다.");
  }

  mergeCue(cueId: string, direction: "previous" | "next"): void {
    const index = this.documentValue.cues.findIndex((cue) => cue.cueId === cueId);
    if (index < 0) throw new Error(`자막 큐를 찾을 수 없습니다: ${cueId}`);
    const other = this.documentValue.cues[index + (direction === "previous" ? -1 : 1)];
    if (!other) throw new Error(direction === "previous" ? "합칠 앞 자막 큐가 없습니다." : "합칠 다음 자막 큐가 없습니다.");
    this.commit(mergeSubtitleCues(this.documentValue, cueId, other.cueId), "인접한 자막 큐를 합쳤습니다.");
  }

  reflow(maxChars = this.maxChars()): void {
    const next = reflowSubtitleCues(this.documentValue, maxChars);
    if (documentsEqual(next, this.documentValue)) {
      this.setStatus(`${maxChars}자 기준으로 나눌 긴 자막이 없습니다.`, "ready");
      return;
    }
    this.commit(next, `긴 자막을 큐당 최대 ${maxChars}자로 나눴습니다.`);
  }

  undo(): void {
    if (!this.history.canUndo) return;
    this.documentValue = this.history.undo();
    this.afterHistoryChange("자막 편집을 되돌렸습니다.");
  }

  redo(): void {
    if (!this.history.canRedo) return;
    this.documentValue = this.history.redo();
    this.afterHistoryChange("자막 편집을 다시 실행했습니다.");
  }

  async seekToWord(cueId: string, wordId?: string): Promise<void> {
    const seconds = subtitleSeekTime(this.documentValue, cueId, wordId);
    await this.options.onSeek?.(seconds, cueId, wordId);
  }

  updatePlayhead(seconds: number): ActiveSubtitlePosition | null {
    this.lastPlayheadSeconds = seconds;
    const previousCueId = this.activePosition?.cueId;
    const previousWordId = this.activePosition?.wordId;
    this.activePosition = findActiveSubtitle(this.documentValue, seconds);
    const activeChanged = previousCueId !== this.activePosition?.cueId || previousWordId !== this.activePosition?.wordId;
    const list = this.optional("subtitle-cue-list");
    if (!list) return this.activePosition;
    list.querySelectorAll("[data-word-id]").forEach((element) => {
      const active = element.dataset.wordId === this.activePosition?.wordId && element.dataset.cueId === this.activePosition?.cueId;
      element.classList.toggle("is-active", active);
      if (active) {
        element.setAttribute("aria-current", "true");
        if (activeChanged) element.scrollIntoView?.({ block: "nearest" });
      } else element.removeAttribute("aria-current");
    });
    list.querySelectorAll("[data-cue-row]").forEach((element) => {
      element.classList.toggle("is-active", element.dataset.cueId === this.activePosition?.cueId);
    });
    return this.activePosition;
  }

  async runAi(action: SubtitleAiAction): Promise<void> {
    if (!this.options.aiProvider) throw new Error("AI 자막 provider가 연결되지 않았습니다.");
    await this.runBusy(`AI ${action}`, async () => {
      const targetLanguage = action === "translate"
        ? cleanTargetLanguage(this.value("subtitle-translate-language-input"))
        : "";
      const request: SubtitleAiRequest = {
        action,
        document: this.document,
        maxChars: this.maxChars(),
        ...(action === "translate" ? { targetLanguage } : {}),
      };
      const payload = await this.options.aiProvider?.(request);
      const defaultValidator = (value: unknown): SubtitleDocument => validateAiSubtitleResponse(value, request, { maxCueCount: this.maximumCues });
      const provided = this.options.validateAiResponse
        ? await this.options.validateAiResponse(payload, request, defaultValidator)
        : defaultValidator(payload);
      // A custom hook can enrich diagnostics, but may not bypass the strict
      // boundary applied to untrusted provider output.
      const result = defaultValidator(provided);
      if (result.projectKey !== this.projectKey) {
        throw new Error("AI 자막 검증 결과의 프로젝트 키가 현재 문서와 일치하지 않습니다.");
      }
      enforceDocumentLimits(result, this.maximumCues);
      const normalized = enforceDocumentLimits(
        normalizeSubtitleDocument(result, { projectKey: this.projectKey }),
        this.maximumCues,
      );
      this.commit(normalized, action === "reflow" ? "AI 자막 줄바꿈을 적용했습니다." : action === "review" ? "AI 자막 검토 결과를 적용했습니다." : "AI 자막 번역 결과를 적용했습니다.");
    });
  }

  async flushAutosave(): Promise<void> {
    if (this.autosaveTimer !== null) this.clearTimer(this.autosaveTimer);
    this.autosaveTimer = null;
    if (!this.storage) return;
    const key = subtitleAutosaveKey(this.projectKey);
    const serialized = serializeSubtitleAutosave(this.documentValue);
    this.saveQueue = this.saveQueue.catch(() => undefined).then(async () => {
      await this.storage?.setItem(key, serialized);
    });
    await this.saveQueue;
  }

  private required(id: string): SubtitleDomElement {
    const element = this.dom.getElementById(id);
    if (!element) throw new Error(`자막 편집기 UI 요소를 찾을 수 없습니다: #${id}`);
    return element;
  }

  private optional(id: string): SubtitleDomElement | null {
    return this.dom.getElementById(id);
  }

  private value(id: string): string {
    return this.required(id).value ?? "";
  }

  private maxChars(): number {
    return integerInRange(this.value("subtitle-max-chars-input"), 19, 4, 120);
  }

  private bind(element: SubtitleDomElement, type: string, handler: (event: SubtitleDomEvent) => void): void {
    element.addEventListener(type, handler);
    this.cleanups.push(() => element.removeEventListener(type, handler));
  }

  private bindEvents(): void {
    const guarded = (task: () => void | Promise<void>, context: string): void => {
      void Promise.resolve().then(task).catch((error) => this.reportError(error, context));
    };
    this.bind(this.required("subtitle-undo-btn"), "click", () => this.undo());
    this.bind(this.required("subtitle-redo-btn"), "click", () => this.redo());
    this.bind(this.required("subtitle-reflow-btn"), "click", () => guarded(() => this.reflow(), "자막 줄바꿈 실패"));
    this.bind(this.required("subtitle-import-btn"), "click", () => guarded(() => this.importFromAdapter(), "SRT 불러오기 실패"));
    this.bind(this.required("subtitle-export-btn"), "click", () => guarded(() => this.exportToAdapter(), "SRT 내보내기 실패"));
    this.bind(this.required("subtitle-ai-reflow-btn"), "click", () => guarded(() => this.runAi("reflow"), "AI 자막 줄바꿈 실패"));
    this.bind(this.required("subtitle-ai-review-btn"), "click", () => guarded(() => this.runAi("review"), "AI 자막 검토 실패"));
    this.bind(this.required("subtitle-ai-translate-btn"), "click", () => guarded(() => this.runAi("translate"), "AI 자막 번역 실패"));
    this.bind(this.required("subtitle-max-chars-input"), "change", () => this.render());
    const list = this.required("subtitle-cue-list");
    this.bind(list, "click", (event) => guarded(() => this.handleListClick(event), "자막 편집 실패"));
    this.bind(list, "keydown", (event) => guarded(() => this.handleListKeydown(event), "자막 키보드 편집 실패"));
  }

  private async importFromAdapter(): Promise<void> {
    if (!this.options.onImportSrt) throw new Error("SRT 파일 선택 기능이 연결되지 않았습니다.");
    await this.runBusy("SRT 불러오기", async () => {
      const source = await this.options.onImportSrt?.();
      if (source === null || source === undefined) return;
      this.importSrtText(source);
    });
  }

  private async exportToAdapter(): Promise<void> {
    if (!this.options.onExportSrt) throw new Error("SRT 파일 저장 기능이 연결되지 않았습니다.");
    await this.runBusy("SRT 내보내기", async () => {
      await this.options.onExportSrt?.(this.exportSrtText(), suggestedSrtName(this.projectKey));
      this.options.onActivity?.("SRT 자막을 내보냈습니다.");
    });
  }

  private async runBusy(label: string, task: () => Promise<void>): Promise<void> {
    if (this.busyAction) throw new Error(`${this.busyAction} 작업이 이미 진행 중입니다.`);
    this.busyAction = label;
    this.setStatus(`${label} 처리 중…`, "busy");
    this.renderControls();
    try {
      await task();
    } finally {
      this.busyAction = "";
      this.renderControls();
      this.setStatus("자막 편집기 준비", "ready");
    }
  }

  private selected(): { cueId: string; wordId: string } | null {
    return this.selectedCueId && this.selectedWordId
      ? { cueId: this.selectedCueId, wordId: this.selectedWordId }
      : null;
  }

  private async handleListClick(event: SubtitleDomEvent): Promise<void> {
    const list = this.required("subtitle-cue-list");
    const actionTarget = closestWithData(event.target, "subtitleAction", list);
    if (!actionTarget || actionTarget.disabled) return;
    const action = actionTarget.dataset.subtitleAction ?? "";
    const cueId = actionTarget.dataset.cueId ?? "";
    const wordId = actionTarget.dataset.wordId ?? "";
    if (action === "select-word") {
      this.selectedCueId = cueId;
      this.selectedWordId = wordId;
      await this.seekToWord(cueId, wordId);
      this.render();
      return;
    }
    if (action === "save-word") {
      const editor = this.findWordEditor(cueId, wordId);
      this.editWord(cueId, wordId, editor?.value ?? "");
    } else if (action === "toggle-word") this.toggleWordHidden(cueId, wordId);
    else if (action === "join-previous") this.joinWord(cueId, wordId, "previous");
    else if (action === "join-next") this.joinWord(cueId, wordId, "next");
    else if (action === "toggle-cue") this.toggleCueEnabled(cueId);
    else if (action === "split-cue") this.splitCueAtWord(cueId, wordId || this.selectedWordId);
    else if (action === "merge-previous") this.mergeCue(cueId, "previous");
    else if (action === "merge-next") this.mergeCue(cueId, "next");
  }

  private async handleListKeydown(event: SubtitleDomEvent): Promise<void> {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const list = this.required("subtitle-cue-list");
    const editor = closestWithData(event.target, "wordEditor", list);
    if (editor) {
      if (event.key === "Enter") {
        event.preventDefault();
        this.editWord(editor.dataset.cueId ?? "", editor.dataset.wordId ?? "", editor.value);
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.selectedCueId = "";
        this.selectedWordId = "";
        this.render();
      }
      return;
    }
    const word = closestWithData(event.target, "wordId", list);
    if (!word) return;
    const cueId = word.dataset.cueId ?? "";
    const wordId = word.dataset.wordId ?? "";
    if (event.key === "h" || event.key === "H") {
      event.preventDefault();
      this.toggleWordHidden(cueId, wordId);
    } else if (event.key === "j" || event.key === "J") {
      event.preventDefault();
      this.joinWord(cueId, wordId, event.shiftKey ? "previous" : "next");
    } else if (event.key === "s" || event.key === "S") {
      event.preventDefault();
      this.splitCueAtWord(cueId, wordId);
    } else if (event.key === "e" || event.key === "E" || event.key === "F2") {
      event.preventDefault();
      this.selectedCueId = cueId;
      this.selectedWordId = wordId;
      this.render();
      this.findWordEditor(cueId, wordId)?.focus?.();
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      await this.moveWordSelection(cueId, wordId, event.key === "ArrowLeft" ? -1 : 1);
    }
  }

  private async moveWordSelection(cueId: string, wordId: string, delta: -1 | 1): Promise<void> {
    const cue = this.documentValue.cues.find((candidate) => candidate.cueId === cueId);
    const index = cue?.words.findIndex((word) => word.wordId === wordId) ?? -1;
    const next = cue?.words[index + delta];
    if (!next) return;
    this.selectedCueId = cueId;
    this.selectedWordId = next.wordId;
    await this.seekToWord(cueId, next.wordId);
    this.render();
    Array.from(this.required("subtitle-cue-list").querySelectorAll("[data-word-id]"))
      .find((element) => element.dataset.wordId === next.wordId && element.dataset.cueId === cueId)
      ?.focus?.();
  }

  private findWordEditor(cueId: string, wordId: string): SubtitleDomElement | null {
    return Array.from(this.required("subtitle-cue-list").querySelectorAll("[data-word-editor]"))
      .find((element) => element.dataset.cueId === cueId && element.dataset.wordId === wordId) ?? null;
  }

  private commit(next: SubtitleDocument, message: string): void {
    const safe = enforceDocumentLimits(next, this.maximumCues);
    this.documentValue = this.history.commit(safe);
    this.reconcileSelection();
    this.render();
    this.emitChange();
    this.scheduleAutosave();
    this.options.onActivity?.(message);
  }

  private afterHistoryChange(message: string): void {
    this.reconcileSelection();
    this.render();
    this.emitChange();
    this.scheduleAutosave();
    this.options.onActivity?.(message);
  }

  private reconcileSelection(): void {
    const cue = this.documentValue.cues.find((candidate) => candidate.cueId === this.selectedCueId);
    if (!cue?.words.some((word) => word.wordId === this.selectedWordId)) {
      this.selectedCueId = "";
      this.selectedWordId = "";
    }
  }

  private emitChange(): void {
    this.options.onChange?.(this.document);
  }

  private scheduleAutosave(): void {
    if (!this.storage) return;
    if (this.autosaveTimer !== null) this.clearTimer(this.autosaveTimer);
    this.autosaveTimer = this.setTimer(() => {
      this.autosaveTimer = null;
      void this.flushAutosave().catch((error) => this.reportError(error, "자막 자동 저장 실패"));
    }, this.autosaveDelay);
  }

  private reportError(error: unknown, context: string): void {
    this.setStatus(error instanceof Error ? error.message : String(error), "error");
    this.options.onError?.(error, context);
  }

  private setStatus(message: string, state: "ready" | "busy" | "error"): void {
    const status = this.optional("subtitle-status");
    if (!status) return;
    status.textContent = message;
    status.dataset.status = state;
  }

  private create(tagName: string, className = "", text = ""): SubtitleDomElement {
    const element = this.dom.createElement(tagName);
    element.className = className;
    element.textContent = text;
    return element;
  }

  private actionButton(
    label: string,
    action: string,
    cueId: string,
    wordId = "",
    disabled = false,
    className = "subtitle-action-button",
  ): SubtitleDomElement {
    const button = this.create("button", className, label);
    button.setAttribute("type", "button");
    button.dataset.subtitleAction = action;
    button.dataset.cueId = cueId;
    if (wordId) button.dataset.wordId = wordId;
    button.disabled = disabled || this.isBusy;
    return button;
  }

  private render(): void {
    const list = this.required("subtitle-cue-list");
    list.replaceChildren();
    this.renderedCueCount = 0;
    this.renderedWordCount = 0;
    if (this.documentValue.cues.length === 0) {
      const empty = this.create("div", "subtitle-empty-state");
      empty.setAttribute("role", "status");
      const title = this.create("strong", "", "편집할 자막이 없습니다");
      const copy = this.create("p", "", "STT 결과를 연결하거나 SRT 파일을 불러와 주세요.");
      empty.append(title, copy);
      list.append(empty);
    } else {
      let remainingWords = this.domWordLimit;
      for (let index = 0; index < Math.min(this.domLimit, this.documentValue.cues.length); index += 1) {
        const cue = this.documentValue.cues[index];
        if (!cue || (remainingWords <= 0 && cue.words.length > 0)) break;
        const wordLimit = Math.min(cue.words.length, remainingWords);
        list.append(this.renderCue(cue.cueId, index, wordLimit));
        this.renderedCueCount += 1;
        this.renderedWordCount += wordLimit;
        remainingWords -= wordLimit;
      }
      if (this.renderedCueCount === 0) {
        list.append(this.create("p", "subtitle-dom-limit-note", "DOM 안전 제한으로 표시할 수 있는 자막이 없습니다. SRT 내보내기에는 전체 문서가 유지됩니다."));
      }
    }
    list.setAttribute("aria-busy", String(this.isBusy));
    this.renderControls();
    this.renderMeta();
    this.setStatus(this.busyAction ? `${this.busyAction} 처리 중…` : "자막 편집기 준비", this.busyAction ? "busy" : "ready");
    if (Number.isFinite(this.lastPlayheadSeconds)) this.updatePlayhead(this.lastPlayheadSeconds);
  }

  private renderCue(cueId: string, index: number, wordLimit: number): SubtitleDomElement {
    const cue = this.documentValue.cues.find((candidate) => candidate.cueId === cueId);
    if (!cue) throw new Error(`자막 큐를 찾을 수 없습니다: ${cueId}`);
    const row = this.create("article", `subtitle-cue-row${cue.enabled ? "" : " is-disabled"}${cue.hidden ? " is-hidden" : ""}`);
    row.dataset.cueRow = "true";
    row.dataset.cueId = cue.cueId;
    row.setAttribute("role", "listitem");
    row.setAttribute("aria-label", `${index + 1}번 자막, ${secondsToSrtTime(cue.start)}부터 ${secondsToSrtTime(cue.end)}까지`);

    const header = this.create("header", "subtitle-cue-header");
    const number = this.create("strong", "subtitle-cue-number", String(index + 1).padStart(2, "0"));
    const time = this.create("time", "subtitle-cue-time", `${secondsToSrtTime(cue.start)} → ${secondsToSrtTime(cue.end)}`);
    const count = this.create("span", `subtitle-char-count${cue.text.length > this.maxChars() ? " is-warning" : ""}`, `${cue.text.length}자`);
    const actions = this.create("div", "subtitle-cue-actions");
    const toggle = this.actionButton(cue.enabled ? "켜짐" : "꺼짐", "toggle-cue", cue.cueId, "", false);
    toggle.setAttribute("aria-pressed", String(cue.enabled));
    toggle.title = "자막 큐 활성화/비활성화";
    const selected = this.selectedCueId === cue.cueId ? this.selectedWordId : "";
    const selectedIndex = cue.words.findIndex((word) => word.wordId === selected);
    actions.append(
      this.actionButton("앞과 합치기", "merge-previous", cue.cueId, "", index === 0),
      this.actionButton("나누기", "split-cue", cue.cueId, selected, selectedIndex <= 0),
      this.actionButton("뒤와 합치기", "merge-next", cue.cueId, "", index === this.documentValue.cues.length - 1),
      toggle,
    );
    header.append(number, time, count, actions);

    const words = this.create("div", "subtitle-word-list");
    words.setAttribute("aria-label", `${index + 1}번 자막 단어`);
    if (cue.words.length === 0) words.append(this.create("span", "subtitle-plain-text", cue.text));
    cue.words.slice(0, wordLimit).forEach((word) => {
      const selectedWord = this.selectedCueId === cue.cueId && this.selectedWordId === word.wordId;
      const button = this.actionButton(
        word.t,
        "select-word",
        cue.cueId,
        word.wordId,
        !cue.enabled,
        `subtitle-word${word.hidden ? " is-hidden" : ""}${selectedWord ? " is-selected" : ""}`,
      );
      button.dataset.wordId = word.wordId;
      button.setAttribute("aria-pressed", String(selectedWord));
      button.setAttribute("aria-label", `${word.t}, ${secondsToSrtTime(word.s)}${word.hidden ? ", 숨김" : ""}`);
      button.title = "클릭: 재생 위치 이동 · E/F2: 수정 · H: 숨김 · J: 뒤 단어와 붙이기 · S: 큐 나누기";
      words.append(button);
    });
    if (wordLimit < cue.words.length) {
      const remainder = this.create("span", "subtitle-dom-limit-note", `+${(cue.words.length - wordLimit).toLocaleString("ko-KR")}개 단어 DOM 생략`);
      remainder.title = "성능 보호를 위해 화면 렌더링만 생략했습니다. 문서·SRT에는 전체 단어가 유지됩니다.";
      words.append(remainder);
    }
    row.append(header, words);
    if (selectedIndex >= 0) row.append(this.renderWordEditor(cue.cueId, selectedIndex));
    return row;
  }

  private renderWordEditor(cueId: string, wordIndex: number): SubtitleDomElement {
    const cue = this.documentValue.cues.find((candidate) => candidate.cueId === cueId);
    const word = cue?.words[wordIndex];
    if (!cue || !word) return this.create("div");
    const editor = this.create("div", "subtitle-word-editor-row");
    const label = this.create("label", "sr-only", "선택한 단어 수정");
    const input = this.create("input", "subtitle-word-editor");
    input.value = word.t;
    input.dataset.wordEditor = "true";
    input.dataset.cueId = cueId;
    input.dataset.wordId = word.wordId;
    input.setAttribute("type", "text");
    input.setAttribute("autocomplete", "off");
    input.setAttribute("aria-label", `${word.t} 단어 수정`);
    const actions = this.create("div", "subtitle-word-editor-actions");
    actions.append(
      this.actionButton("저장", "save-word", cueId, word.wordId),
      this.actionButton(word.hidden ? "숨김 해제" : "숨기기", "toggle-word", cueId, word.wordId),
      this.actionButton("앞 단어와 붙이기", "join-previous", cueId, word.wordId, wordIndex === 0),
      this.actionButton("뒤 단어와 붙이기", "join-next", cueId, word.wordId, wordIndex === cue.words.length - 1),
    );
    editor.append(label, input, actions);
    return editor;
  }

  private renderControls(): void {
    const empty = this.documentValue.cues.length === 0;
    const states: Array<[string, boolean]> = [
      ["subtitle-undo-btn", !this.history.canUndo],
      ["subtitle-redo-btn", !this.history.canRedo],
      ["subtitle-reflow-btn", empty],
      ["subtitle-export-btn", empty || !this.options.onExportSrt],
      ["subtitle-ai-reflow-btn", empty || !this.options.aiProvider],
      ["subtitle-ai-review-btn", empty || !this.options.aiProvider],
      ["subtitle-ai-translate-btn", empty || !this.options.aiProvider],
      ["subtitle-import-btn", !this.options.onImportSrt],
    ];
    states.forEach(([id, disabled]) => {
      const element = this.optional(id);
      if (element) element.disabled = disabled || this.isBusy;
    });
    const root = this.optional("subtitle-editor");
    root?.setAttribute("aria-busy", String(this.isBusy));
  }

  private renderMeta(): void {
    const meta = this.optional("subtitle-meta");
    if (!meta) return;
    const cueCount = this.documentValue.cues.length;
    const wordCount = this.documentValue.cues.reduce((sum, cue) => sum + cue.words.length, 0);
    const disabled = this.documentValue.cues.filter((cue) => !cue.enabled || cue.hidden).length;
    meta.textContent = `${cueCount.toLocaleString("ko-KR")}개 큐 · ${wordCount.toLocaleString("ko-KR")}개 단어 · 비활성 ${disabled.toLocaleString("ko-KR")}개 · DOM 큐 ${this.renderedCueCount.toLocaleString("ko-KR")}/${cueCount.toLocaleString("ko-KR")} · 단어 ${this.renderedWordCount.toLocaleString("ko-KR")}/${wordCount.toLocaleString("ko-KR")} · 최대 ${this.maxChars()}자`;
    const truncated = this.renderedCueCount < cueCount || this.renderedWordCount < wordCount;
    meta.classList.toggle("is-warning", truncated);
    meta.title = truncated
      ? `성능 보호를 위해 최대 ${this.domLimit.toLocaleString("ko-KR")}개 큐와 ${this.domWordLimit.toLocaleString("ko-KR")}개 단어만 화면에 렌더링합니다. 전체 문서는 저장·내보내기에 유지됩니다.`
      : "전체 자막 큐를 표시하고 있습니다.";
  }
}
