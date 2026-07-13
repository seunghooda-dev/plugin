import {
  THUMBNAIL_LAYOUTS,
  addLayer,
  calculateLayoutRects,
  canvasToImageBytes,
  canvasToPngBytes,
  createThumbnailState,
  inferThumbnailImageMime,
  removeLayer,
  renderThumbnail,
  renderThumbnailSvg,
  reorderLayers,
  setLayout,
  thumbnailBytesToDataUrl,
  updateAdjustments,
  updateBadgeOverlay,
  updateOverlay,
  updateTextOverlay,
  updateTransform,
  type CanvasContextLike,
  type CanvasImageLike,
  type ThumbnailAdjustments,
  type ThumbnailBadgeOverlay,
  type ThumbnailExportFormat,
  type ThumbnailLayer,
  type ThumbnailLayoutId,
  type ThumbnailOverlay,
  type ThumbnailState,
  type ThumbnailTextOverlay,
  type ThumbnailTransform,
} from "./thumbnail";
import { bind, clearChildren, element, valueOf } from "./ui";

export const THUMBNAIL_STORAGE_KEY = "shortflow.thumbnail.layers.v1";
export const THUMBNAIL_OUTPUT_FOLDER_TOKEN_KEY = "shortflow.thumbnail.outputFolderToken.v1";
export const THUMBNAIL_FILE_TYPES = Object.freeze(["png", "jpg", "jpeg", "webp"] as const);
export const THUMBNAIL_AI_PRESETS = Object.freeze([
  "basic",
  "vivid",
  "upscale",
  "remove-bg",
  "chat",
] as const);
export const MAX_THUMBNAIL_AI_PROMPT_CHARACTERS = 4_096;
export const MAX_THUMBNAIL_AI_RESULT_BYTES = 50 * 1024 * 1024;
export const MAX_THUMBNAIL_SOURCE_BYTES = 50 * 1024 * 1024;

type MaybePromise<T> = T | Promise<T>;

export interface ThumbnailFileEntry {
  name?: string;
  nativePath?: string;
  url?: string;
  isFile?: boolean;
  read?(options?: { format?: unknown }): MaybePromise<unknown>;
  write?(data: ArrayBuffer, options?: { format?: unknown }): MaybePromise<unknown>;
}

export interface ThumbnailFolderEntry {
  name?: string;
  nativePath?: string;
  isFolder?: boolean;
  createFile(
    name: string,
    options?: { overwrite?: boolean },
  ): Promise<ThumbnailFileEntry>;
}

export interface ThumbnailLocalFileSystem {
  getFileForOpening(options?: {
    allowMultiple?: boolean;
    types?: readonly string[];
  }): Promise<ThumbnailFileEntry | ThumbnailFileEntry[] | null | undefined>;
  createPersistentToken(entry: ThumbnailFileEntry | ThumbnailFolderEntry): Promise<string>;
  getEntryForPersistentToken(token: string): Promise<ThumbnailFileEntry | ThumbnailFolderEntry>;
  getFolder(): Promise<ThumbnailFolderEntry | null | undefined>;
}

export interface ThumbnailStorage {
  getItem(key: string): MaybePromise<unknown>;
  setItem(key: string, value: string): MaybePromise<unknown>;
  removeItem?(key: string): MaybePromise<unknown>;
}

export interface ThumbnailControllerAdapter {
  localFileSystem: ThumbnailLocalFileSystem;
  storage?: ThumbnailStorage;
  binaryFormat?: unknown;
}

export type ThumbnailAIResult =
  | Uint8Array
  | ArrayBuffer
  | {
      bytes: Uint8Array | ArrayBuffer;
      name?: string;
    };

export interface ThumbnailControllerOptions {
  adapter?: ThumbnailControllerAdapter;
  storageKey?: string;
  onActivity?: (message: string) => void;
  onError?: (error: unknown, context: string) => void;
  onAIRequest?: (
    pngBytes: Uint8Array,
    preset: string,
    prompt: string,
  ) => MaybePromise<ThumbnailAIResult>;
  imageFactory?: () => LoadableImage;
  now?: () => number;
}

export interface ThumbnailHistoryItem {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly bytes: Uint8Array;
  readonly preset: string;
  readonly prompt: string;
  readonly createdAt: number;
}

export interface ThumbnailBrandDefaults {
  layout: ThumbnailLayoutId;
  backgroundColor: string;
  textColor?: string;
  brightness: number;
  contrast: number;
  saturation: number;
  shadow: number;
  glow: number;
  shadowColor: string;
  glowColor: string;
}

interface LoadableImage extends CanvasImageLike {
  src: string;
  complete?: boolean;
  onload: (() => void) | null;
  onerror: ((event?: unknown) => void) | null;
  decode?: () => Promise<void>;
}

interface SourceRecord {
  id: string;
  name: string;
  url: string;
  token: string | null;
  kind: "file" | "generated";
  createdAt: number;
}

interface StoredLayer {
  id: string;
  name: string;
  token: string;
  createdAt: number;
  adjustments?: Partial<ThumbnailAdjustments>;
  overlay?: Partial<ThumbnailOverlay>;
  transform?: Partial<ThumbnailTransform>;
}

interface StoredThumbnailState {
  version: 1 | 2 | 3;
  width?: number;
  height?: number;
  layout: ThumbnailLayoutId;
  selectedLayerId: string | null;
  backgroundColor?: string;
  textOverlay?: Partial<ThumbnailTextOverlay>;
  badgeOverlay?: Partial<ThumbnailBadgeOverlay>;
  layers: StoredLayer[];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fileName(entry: ThumbnailFileEntry): string {
  return String(entry.name ?? entry.nativePath ?? "썸네일 이미지").trim() || "썸네일 이미지";
}

function fileUrl(entry: ThumbnailFileEntry): string {
  return String(entry.url ?? "").trim();
}

function isUsableFileEntry(entry: unknown): entry is ThumbnailFileEntry {
  if (typeof entry !== "object" || entry === null) return false;
  const candidate = entry as ThumbnailFileEntry;
  return candidate.isFile !== false
    && typeof (entry as Partial<ThumbnailFolderEntry>).createFile !== "function"
    && fileName(candidate).length > 0;
}

function isUsableFolderEntry(entry: unknown): entry is ThumbnailFolderEntry {
  if (typeof entry !== "object" || entry === null) return false;
  const candidate = entry as ThumbnailFolderEntry;
  return candidate.isFolder !== false && typeof candidate.createFile === "function";
}

function validLayout(value: unknown): value is ThumbnailLayoutId {
  return THUMBNAIL_LAYOUTS.some((layout) => layout.id === value);
}

function layoutFromControl(value: string): ThumbnailLayoutId {
  if (validLayout(value)) return value;
  switch (value) {
    case "1": return "full";
    case "2": return "vertical";
    case "3": return "hero-left";
    case "4": return "grid";
    default: throw new RangeError(`지원하지 않는 썸네일 분할 값입니다: ${value}`);
  }
}

function layoutCount(layout: ThumbnailLayoutId): number {
  return THUMBNAIL_LAYOUTS.find((item) => item.id === layout)?.count ?? 1;
}

function isThumbnailAIPreset(value: string): value is (typeof THUMBNAIL_AI_PRESETS)[number] {
  return THUMBNAIL_AI_PRESETS.some((preset) => preset === value);
}

function exportFormatFromControl(value: string): ThumbnailExportFormat {
  return value === "jpg" ? "jpg" : "png";
}

function sourceId(now: number, index: number): string {
  return `thumb-${now.toString(36)}-${index.toString(36)}`;
}

function timestampName(now: number, format: ThumbnailExportFormat): string {
  const date = new Date(now);
  const parts = [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  ].map((value, index) => String(value).padStart(index === 0 ? 4 : 2, "0"));
  return `ShortFlow_Thumbnail_${parts.join("")}.${format === "jpg" ? "jpg" : "png"}`;
}

function timestampSvgName(now: number): string {
  return timestampName(now, "png").replace(/\.png$/u, ".svg");
}

function assertByteLength(byteLength: number, maximum: number, message: string): void {
  if (!Number.isFinite(byteLength) || byteLength < 0 || byteLength > maximum) {
    throw new Error(message);
  }
}

function normalizeBytes(value: unknown, maximum = MAX_THUMBNAIL_AI_RESULT_BYTES): Uint8Array {
  if (value instanceof Uint8Array) {
    assertByteLength(value.byteLength, maximum, "이미지 데이터가 허용된 크기를 초과했습니다.");
    return value.slice();
  }
  if (value instanceof ArrayBuffer) {
    assertByteLength(value.byteLength, maximum, "이미지 데이터가 허용된 크기를 초과했습니다.");
    return new Uint8Array(value.slice(0));
  }
  if (ArrayBuffer.isView(value)) {
    assertByteLength(value.byteLength, maximum, "이미지 데이터가 허용된 크기를 초과했습니다.");
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  throw new TypeError("AI가 유효한 이미지 바이트를 반환하지 않았습니다.");
}

function aiResultBytes(result: ThumbnailAIResult): { bytes: Uint8Array; name?: string } {
  if (result instanceof Uint8Array || result instanceof ArrayBuffer) {
    return { bytes: normalizeBytes(result, MAX_THUMBNAIL_AI_RESULT_BYTES) };
  }
  const bytes = normalizeBytes(result.bytes, MAX_THUMBNAIL_AI_RESULT_BYTES);
  return result.name?.trim() ? { bytes, name: result.name.trim() } : { bytes };
}

function base64Encode(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const combined = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    output += alphabet[(combined >> 18) & 63] ?? "";
    output += alphabet[(combined >> 12) & 63] ?? "";
    output += second === undefined ? "=" : (alphabet[(combined >> 6) & 63] ?? "");
    output += third === undefined ? "=" : (alphabet[combined & 63] ?? "");
  }
  return output;
}

function utf8Encode(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    let codePoint = value.codePointAt(index);
    if (codePoint === undefined) continue;
    if (codePoint > 0xffff) index += 1;
    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    } else {
      codePoint = Math.min(codePoint, 0x10ffff);
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function pngUrl(bytes: Uint8Array): string {
  try {
    if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function" && typeof Blob !== "undefined") {
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      return URL.createObjectURL(new Blob([buffer], { type: "image/png" }));
    }
  } catch {
    // 일부 UXP 버전은 Blob은 노출하지만 object URL 생성은 지원하지 않습니다.
  }
  return `data:image/png;base64,${base64Encode(bytes)}`;
}

function revokeGeneratedUrl(url: string): void {
  if (!url.startsWith("blob:")) return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    // URL 해제 실패는 플러그인 종료나 UXP 구현 차이에서 발생할 수 있습니다.
  }
}

function parseStored(raw: unknown): StoredThumbnailState | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredThumbnailState>;
    if (
      (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3) ||
      !validLayout(parsed.layout) ||
      !Array.isArray(parsed.layers)
    ) {
      return null;
    }
    const layers = parsed.layers
      .filter((item): item is StoredLayer => Boolean(
        item &&
        typeof item.id === "string" &&
        typeof item.name === "string" &&
        typeof item.token === "string" &&
        item.token.trim(),
      ))
      .slice(0, 4)
      .map((item) => ({
        id: item.id.trim(),
        name: item.name.trim(),
        token: item.token.trim(),
        createdAt: typeof item.createdAt === "number" && Number.isFinite(item.createdAt) && item.createdAt >= 0
          ? Math.floor(item.createdAt)
          : 0,
        ...(item.adjustments && typeof item.adjustments === "object"
          ? { adjustments: item.adjustments }
          : {}),
        ...(item.overlay && typeof item.overlay === "object"
          ? { overlay: item.overlay }
          : {}),
        ...(item.transform && typeof item.transform === "object"
          ? { transform: item.transform }
          : {}),
      }));
    const stored: StoredThumbnailState = {
      version: parsed.version,
      layout: parsed.layout,
      selectedLayerId: typeof parsed.selectedLayerId === "string"
        ? parsed.selectedLayerId
        : null,
      layers,
    };
    if (parsed.version === 2 || parsed.version === 3) {
      if (typeof parsed.width === "number") stored.width = parsed.width;
      if (typeof parsed.height === "number") stored.height = parsed.height;
      if (typeof parsed.backgroundColor === "string") {
        stored.backgroundColor = parsed.backgroundColor;
      }
    }
    if (parsed.version === 3) {
      if (parsed.textOverlay && typeof parsed.textOverlay === "object") {
        stored.textOverlay = parsed.textOverlay;
      }
      if (parsed.badgeOverlay && typeof parsed.badgeOverlay === "object") {
        stored.badgeOverlay = parsed.badgeOverlay;
      }
    }
    return stored;
  } catch {
    return null;
  }
}

export function createDefaultThumbnailControllerAdapter(): ThumbnailControllerAdapter {
  let uxp: unknown;
  try {
    uxp = require("uxp") as unknown;
  } catch (error) {
    throw new Error(`UXP 파일 시스템을 불러오지 못했습니다: ${errorText(error)}`);
  }
  const root = uxp as {
    storage?: {
      localFileSystem?: ThumbnailLocalFileSystem;
      formats?: { binary?: unknown };
    };
  };
  const localFileSystem = root.storage?.localFileSystem;
  if (!localFileSystem) throw new Error("UXP localFileSystem API를 사용할 수 없습니다.");
  const browserStorage = typeof localStorage === "undefined" ? undefined : localStorage;
  const adapter: ThumbnailControllerAdapter = { localFileSystem };
  if (browserStorage) adapter.storage = browserStorage;
  if (root.storage?.formats?.binary !== undefined) {
    adapter.binaryFormat = root.storage.formats.binary;
  }
  return adapter;
}

/**
 * THUMBNAIL LAB 패널의 파일 권한, 편집 상태, Canvas와 AI 결과 수명을 관리합니다.
 * index.ts에서는 initialize()만 호출하면 되며 AI 전송 자체는 onAIRequest로 주입합니다.
 */
export class ThumbnailController {
  private readonly adapter: ThumbnailControllerAdapter;
  private readonly storageKey: string;
  private readonly now: () => number;
  private readonly sources = new Map<string, SourceRecord>();
  private readonly imageCache = new Map<string, Promise<CanvasImageLike>>();
  private readonly historyItems: ThumbnailHistoryItem[] = [];
  private stateValue: ThumbnailState = createThumbnailState();
  private initialized = false;
  private dragFromIndex = -1;
  private renderScheduled = false;
  private renderRevision = 0;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private canvasLimitReason: string | null = null;
  private exportInProgress = false;
  private disposed = false;

  constructor(private readonly options: ThumbnailControllerOptions = {}) {
    this.adapter = options.adapter ?? createDefaultThumbnailControllerAdapter();
    this.storageKey = options.storageKey ?? THUMBNAIL_STORAGE_KEY;
    this.now = options.now ?? (() => Date.now());
  }

  get state(): ThumbnailState {
    return this.stateValue;
  }

  get history(): readonly ThumbnailHistoryItem[] {
    return this.historyItems.map((item) => ({ ...item, bytes: item.bytes.slice() }));
  }

  /** Applies a brand preset to the layout and every current image layer. */
  async applyBrandDefaults(defaults: ThumbnailBrandDefaults): Promise<void> {
    this.stateValue = createThumbnailState({
      width: this.stateValue.width,
      height: this.stateValue.height,
      layout: defaults.layout,
      backgroundColor: defaults.backgroundColor,
      textOverlay: {
        ...this.stateValue.textOverlay,
        color: defaults.textColor ?? this.stateValue.textOverlay.color,
      },
      badgeOverlay: this.stateValue.badgeOverlay,
      selectedLayerId: this.stateValue.selectedLayerId,
      layers: this.stateValue.layers.map((layer) => ({
        id: layer.id,
        source: layer.source,
        adjustments: {
          brightness: defaults.brightness,
          contrast: defaults.contrast,
          saturation: defaults.saturation,
        },
        overlay: {
          shadow: defaults.shadow,
          glow: defaults.glow,
          shadowColor: defaults.shadowColor,
          glowColor: defaults.glowColor,
        },
        transform: layer.transform,
      })),
    });
    await this.persist();
    this.syncUI();
    this.requestRender();
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.bindEvents();
    await this.restore();
    this.canvasLimitReason = this.detectCanvasLimit();
    this.syncUI();
    try {
      await this.renderCanvas();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error ?? "알 수 없는 오류");
      this.setCanvasLimited(message);
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const flushPendingPersist = this.persistTimer !== null;
    if (this.persistTimer !== null) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    try {
      if (flushPendingPersist) await this.persist();
    } catch (error) {
      this.options.onError?.(error, "썸네일 종료 전 자동 저장 실패");
      if (!this.options.onError) console.error("썸네일 종료 전 자동 저장 실패", error);
    } finally {
      for (const source of this.sources.values()) {
        if (source.kind === "generated") revokeGeneratedUrl(source.url);
      }
      this.sources.clear();
      this.imageCache.clear();
      this.historyItems.splice(0);
    }
  }

  private async guard(task: () => MaybePromise<void>, context: string): Promise<void> {
    try {
      await task();
    } catch (error) {
      this.options.onError?.(error, context);
      if (!this.options.onError) console.error(context, error);
      this.syncUI();
    }
  }

  private detectCanvasLimit(): string | null {
    let canvas: HTMLCanvasElement;
    try {
      canvas = element<HTMLCanvasElement>("thumbnail-canvas");
    } catch (error) {
      return `썸네일 Canvas 요소를 찾지 못했습니다: ${errorText(error)}`;
    }

    let ctx: Partial<CanvasContextLike> | null = null;
    try {
      ctx = canvas.getContext("2d") as Partial<CanvasContextLike> | null;
    } catch {
      return "2D Canvas 컨텍스트를 만들지 못했습니다.";
    }
    if (!ctx) return "2D Canvas 컨텍스트를 만들지 못했습니다.";

    const missing: string[] = [];
    if (typeof ctx.drawImage !== "function") missing.push("이미지 합성");
    if (typeof ctx.fillText !== "function") missing.push("텍스트 렌더링");

    const exportCanvas = canvas as unknown as {
      convertToBlob?: unknown;
      toBlob?: unknown;
      toDataURL?: unknown;
    };
    if (
      typeof exportCanvas.convertToBlob !== "function" &&
      typeof exportCanvas.toBlob !== "function" &&
      typeof exportCanvas.toDataURL !== "function"
    ) {
      missing.push("PNG/JPG 내보내기");
    }

    return missing.length > 0
      ? `현재 Premiere UXP Canvas가 ${missing.join(", ")} 기능을 제공하지 않습니다.`
      : null;
  }

  private setCanvasLimited(message: string): void {
    this.canvasLimitReason = message;
    this.syncCanvasCapabilityUI();
    this.options.onActivity?.(`썸네일 미리보기/내보내기는 현재 UXP Canvas 제한으로 비활성화되었습니다: ${message}`);
  }

  private syncCanvasCapabilityUI(): void {
    const reason = this.canvasLimitReason;
    const exporting = this.exportInProgress;
    const exportButton = element<HTMLButtonElement>("thumb-export-btn");
    const svgFallbackButton = element<HTMLButtonElement>("thumb-export-svg-btn");
    const exportFormat = element<HTMLSelectElement>("thumb-export-format-select");
    exportButton.disabled = Boolean(reason) || exporting;
    svgFallbackButton.disabled = exporting;
    exportFormat.disabled = Boolean(reason) || exporting;
    exportButton.title = exporting
      ? "썸네일 내보내기가 진행 중입니다."
      : reason ? `현재 저장할 수 없습니다: ${reason}` : "";
    svgFallbackButton.title = exporting
      ? "썸네일 내보내기가 진행 중입니다."
      : reason
        ? `PNG/JPG 대신 SVG fallback으로 저장합니다: ${reason}`
        : "SVG fallback 썸네일을 저장합니다.";

    const canvas = element<HTMLCanvasElement>("thumbnail-canvas");
    canvas.setAttribute(
      "aria-label",
      reason
        ? `1280 × 720 썸네일 미리보기 비활성화: ${reason}`
        : "1280 × 720 썸네일 미리보기 캔버스",
    );
    const shell = canvas.closest<HTMLElement>(".thumbnail-canvas-shell");
    shell?.classList.toggle("is-limited", Boolean(reason));
    if (!shell) return;

    let notice = shell.querySelector<HTMLElement>("#thumbnail-canvas-fallback-notice");
    if (!reason) {
      notice?.remove();
      return;
    }
    if (!notice) {
      notice = document.createElement("div");
      notice.id = "thumbnail-canvas-fallback-notice";
      notice.className = "thumbnail-canvas-fallback-notice";
      notice.setAttribute("role", "status");
      shell.append(notice);
    }
    notice.textContent = `${reason} 썸네일 편집값은 저장되지만, PNG/JPG 출력은 fallback 구현 후 활성화됩니다.`;
  }

  private bindEvents(): void {
    bind("thumbnail-source-btn", "click", () => this.guard(
      () => this.chooseSources(),
      "썸네일 소스 추가 실패",
    ));
    bind("thumbnail-layout-select", "change", () => this.guard(
      () => this.changeLayout(),
      "썸네일 분할 변경 실패",
    ));
    bind("thumb-export-btn", "click", () => this.guard(
      () => this.exportImage(),
      "썸네일 저장 실패",
    ));
    bind("thumb-export-svg-btn", "click", () => this.guard(
      () => this.exportSvgFallback(),
      "썸네일 SVG fallback 저장 실패",
    ));
    bind("thumb-ai-run-btn", "click", () => this.guard(
      () => this.runAI(),
      "AI 썸네일 보정 실패",
    ));

    for (const id of [
      "thumb-title-input",
      "thumb-title-color",
      "thumb-title-size-input",
      "thumb-badge-input",
      "thumb-badge-color",
      "thumb-badge-background-color",
    ]) {
      bind(id, "input", () => this.updateTextAndBadge());
      bind(id, "change", () => this.updateTextAndBadge());
    }

    for (const id of [
      "thumb-zoom-input",
      "thumb-offset-x-input",
      "thumb-offset-y-input",
      "thumb-brightness-input",
      "thumb-contrast-input",
      "thumb-saturation-input",
    ]) {
      if (id === "thumb-zoom-input" || id === "thumb-offset-x-input" || id === "thumb-offset-y-input") {
        bind(id, "input", () => this.updateSelectedTransform());
      } else {
        bind(id, "input", () => this.updateSelectedAdjustments());
      }
    }
    for (const id of [
      "thumb-shadow-checkbox",
      "thumb-shadow-color",
      "thumb-glow-checkbox",
      "thumb-glow-color",
    ]) {
      bind(id, "input", () => this.updateSelectedOverlay());
      bind(id, "change", () => this.updateSelectedOverlay());
    }

    const canvas = element<HTMLCanvasElement>("thumbnail-canvas");
    canvas.addEventListener("click", (event) => this.selectCanvasCell(event));
  }

  private async chooseSources(): Promise<void> {
    const selection = await this.adapter.localFileSystem.getFileForOpening({
      allowMultiple: true,
      types: THUMBNAIL_FILE_TYPES,
    });
    if (!selection) return;
    const entries = Array.isArray(selection) ? selection : [selection];
    const available = 4 - this.stateValue.layers.length;
    if (entries.length > available) {
      throw new RangeError(`이미지는 최대 4개입니다. 현재 ${available}개를 더 추가할 수 있습니다.`);
    }

    const additions: SourceRecord[] = [];
    const baseTime = this.now();
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry) continue;
      if (!isUsableFileEntry(entry)) {
        throw new Error("선택한 항목이 읽을 수 있는 이미지 파일이 아닙니다.");
      }
      const tokenValue = await this.adapter.localFileSystem.createPersistentToken(entry);
      const token = typeof tokenValue === "string" ? tokenValue.trim() : "";
      if (!token) throw new Error(`${fileName(entry)} 파일의 영구 접근 권한을 만들지 못했습니다.`);
      const id = this.uniqueSourceId(sourceId(baseTime, index));
      additions.push({
        id,
        name: fileName(entry),
        token,
        url: await this.resolveEntryUrl(entry),
        kind: "file",
        createdAt: baseTime + index,
      });
    }

    for (const record of additions) {
      this.sources.set(record.id, record);
      this.stateValue = addLayer(this.stateValue, { id: record.id, source: record.id });
    }
    await this.persist();
    this.syncUI();
    this.requestRender();
    this.options.onActivity?.(`${additions.length}개 이미지를 썸네일 레이어에 추가했습니다.`);
  }

  private async changeLayout(): Promise<void> {
    const layout = layoutFromControl(valueOf("thumbnail-layout-select"));
    this.stateValue = setLayout(this.stateValue, layout);
    await this.persist();
    this.syncUI();
    this.requestRender();
  }

  private selectLayer(id: string | null): void {
    if (id !== null && !this.stateValue.layers.some((layer) => layer.id === id)) return;
    this.stateValue = createThumbnailState({
      width: this.stateValue.width,
      height: this.stateValue.height,
      layout: this.stateValue.layout,
      layers: this.stateValue.layers,
      selectedLayerId: id,
      backgroundColor: this.stateValue.backgroundColor,
      textOverlay: this.stateValue.textOverlay,
      badgeOverlay: this.stateValue.badgeOverlay,
    });
    this.syncUI();
    this.schedulePersist();
    this.requestRender();
  }

  private async deleteLayer(id: string): Promise<void> {
    const record = this.sources.get(id);
    this.stateValue = removeLayer(this.stateValue, id);
    this.sources.delete(id);
    this.imageCache.delete(id);
    if (record?.kind === "generated" && !this.historyItems.some((item) => item.url === record.url)) {
      revokeGeneratedUrl(record.url);
    }
    await this.persist();
    this.syncUI();
    this.requestRender();
    this.options.onActivity?.(`${record?.name ?? "이미지"} 레이어를 삭제했습니다.`);
  }

  private async moveLayer(from: number, to: number): Promise<void> {
    this.stateValue = reorderLayers(this.stateValue, from, to);
    await this.persist();
    this.renderLayerList();
    this.requestRender();
  }

  private updateSelectedAdjustments(): void {
    this.stateValue = updateAdjustments(this.stateValue, {
      brightness: Number(valueOf("thumb-brightness-input")),
      contrast: Number(valueOf("thumb-contrast-input")),
      saturation: Number(valueOf("thumb-saturation-input")),
    });
    this.syncInspector();
    this.schedulePersist();
    this.requestRender();
  }

  private updateSelectedTransform(): void {
    this.stateValue = updateTransform(this.stateValue, {
      zoom: Number(valueOf("thumb-zoom-input")) / 100,
      offsetX: Number(valueOf("thumb-offset-x-input")) / 100,
      offsetY: Number(valueOf("thumb-offset-y-input")) / 100,
    });
    this.syncInspector();
    this.schedulePersist();
    this.requestRender();
  }

  private updateSelectedOverlay(): void {
    const shadowEnabled = element<HTMLInputElement>("thumb-shadow-checkbox").checked;
    const glowEnabled = element<HTMLInputElement>("thumb-glow-checkbox").checked;
    this.stateValue = updateOverlay(this.stateValue, {
      shadow: shadowEnabled ? 24 : 0,
      glow: glowEnabled ? 28 : 0,
      shadowColor: valueOf("thumb-shadow-color"),
      glowColor: valueOf("thumb-glow-color"),
    });
    this.syncInspector();
    this.schedulePersist();
    this.requestRender();
  }

  private updateTextAndBadge(): void {
    this.stateValue = updateTextOverlay(this.stateValue, {
      text: valueOf("thumb-title-input"),
      color: valueOf("thumb-title-color"),
      fontSize: Number(valueOf("thumb-title-size-input")),
    });
    this.stateValue = updateBadgeOverlay(this.stateValue, {
      text: valueOf("thumb-badge-input"),
      color: valueOf("thumb-badge-color"),
      backgroundColor: valueOf("thumb-badge-background-color"),
      visible: valueOf("thumb-badge-input").trim().length > 0,
    });
    this.syncInspector();
    this.schedulePersist();
    this.requestRender();
  }

  private schedulePersist(): void {
    if (this.disposed) return;
    if (this.persistTimer !== null) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.guard(
        () => this.persist(),
        "썸네일 자동 저장 실패",
      );
    }, 250);
  }

  private selectCanvasCell(event: MouseEvent): void {
    if (this.stateValue.layers.length === 0) return;
    const canvas = element<HTMLCanvasElement>("thumbnail-canvas");
    const bounds = canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const x = ((event.clientX - bounds.left) / bounds.width) * this.stateValue.width;
    const y = ((event.clientY - bounds.top) / bounds.height) * this.stateValue.height;
    const rectangles = calculateLayoutRects(
      this.stateValue.width,
      this.stateValue.height,
      this.stateValue.layers.length,
      this.stateValue.layout,
    );
    const index = rectangles.findIndex((item) => (
      x >= item.x && x < item.x + item.width && y >= item.y && y < item.y + item.height
    ));
    this.selectLayer(this.stateValue.layers[index]?.id ?? null);
  }

  private requestRender(): void {
    if (this.disposed) return;
    this.renderRevision += 1;
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    const schedule = typeof requestAnimationFrame === "function"
      ? (callback: () => void) => requestAnimationFrame(callback)
      : (callback: () => void) => setTimeout(callback, 0);
    schedule(() => {
      if (this.disposed) return;
      this.renderScheduled = false;
      const revision = this.renderRevision;
      void this.guard(async () => {
        await this.renderCanvas();
        if (revision !== this.renderRevision) this.requestRender();
      }, "썸네일 미리보기 렌더 실패");
    });
  }

  private async renderCanvas(): Promise<void> {
    const detectedLimit = this.detectCanvasLimit();
    if (detectedLimit) {
      this.setCanvasLimited(detectedLimit);
      return;
    }
    const canvas = element<HTMLCanvasElement>("thumbnail-canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D Canvas 컨텍스트를 만들지 못했습니다.");
    await renderThumbnail(
      ctx as unknown as CanvasContextLike,
      this.stateValue,
      async (_source, layer) => this.loadImage(layer.id),
    );
  }

  private async loadImage(id: string): Promise<CanvasImageLike> {
    const cached = this.imageCache.get(id);
    if (cached) return cached;
    const record = this.sources.get(id);
    if (!record) throw new Error(`레이어 ${id}의 이미지 소스를 찾지 못했습니다.`);
    const pending = this.createLoadedImage(record.url, record.name);
    this.imageCache.set(id, pending);
    try {
      return await pending;
    } catch (error) {
      this.imageCache.delete(id);
      throw error;
    }
  }

  private createLoadedImage(url: string, name: string): Promise<CanvasImageLike> {
    const createImage = this.options.imageFactory ?? (() => new Image() as unknown as LoadableImage);
    return new Promise((resolve, reject) => {
      const image = createImage();
      let settled = false;
      const succeed = (): void => {
        if (settled) return;
        settled = true;
        image.onload = null;
        image.onerror = null;
        resolve(image);
      };
      const fail = (): void => {
        if (settled) return;
        settled = true;
        image.onload = null;
        image.onerror = null;
        reject(new Error(`${name} 이미지를 디코딩하지 못했습니다.`));
      };
      image.onload = succeed;
      image.onerror = fail;
      image.src = url;
      if (image.complete && (image.naturalWidth ?? image.width ?? 0) > 0) {
        succeed();
      } else if (typeof image.decode === "function") {
        void image.decode().then(succeed, () => {
          // decode()가 미지원 형식에서 거부돼도 onload가 성공할 수 있어 이벤트를 기다립니다.
        });
      }
    });
  }

  private async withExportLock(task: () => Promise<void>): Promise<void> {
    if (this.disposed) throw new Error("종료된 썸네일 편집기에서는 내보낼 수 없습니다.");
    if (this.exportInProgress) throw new Error("썸네일 내보내기가 이미 진행 중입니다.");
    this.exportInProgress = true;
    this.syncCanvasCapabilityUI();
    try {
      await task();
    } finally {
      this.exportInProgress = false;
      this.syncCanvasCapabilityUI();
    }
  }

  private async exportImage(): Promise<void> {
    await this.withExportLock(async () => {
      const format = exportFormatFromControl(valueOf("thumb-export-format-select"));
      const detectedLimit = this.detectCanvasLimit();
      if (detectedLimit) {
        this.setCanvasLimited(detectedLimit);
        throw new Error(`현재 환경에서는 썸네일 ${format.toUpperCase()} 저장을 지원하지 않습니다: ${detectedLimit}`);
      }
      await this.renderCanvas();
      const bytes = await canvasToImageBytes(element<HTMLCanvasElement>("thumbnail-canvas"), format);
      const folder = await this.resolveOutputFolder();
      if (!folder) return;
      const name = timestampName(this.now(), format);
      const entry = await this.writeExportFile(
        folder,
        name,
        bytes,
        `생성한 ${format.toUpperCase()} 파일에 쓰기 기능이 없습니다.`,
      );
      this.options.onActivity?.(`${fileName(entry) || name} 썸네일을 저장했습니다.`);
    });
  }

  private async exportSvgFallback(): Promise<void> {
    await this.withExportLock(async () => {
      const hrefs = new Map<string, string>();
      for (const layer of this.stateValue.layers) {
        hrefs.set(layer.id, await this.svgHrefForLayer(layer));
      }
      const svg = renderThumbnailSvg(this.stateValue, {
        title: "ShortFlow Studio thumbnail fallback",
        resolveImageHref: (_source, layer) => {
          const href = hrefs.get(layer.id);
          if (!href) throw new Error(`레이어 ${layer.id}의 SVG 이미지 경로를 찾지 못했습니다.`);
          return href;
        },
      });
      const bytes = utf8Encode(svg);
      const folder = await this.resolveOutputFolder();
      if (!folder) return;
      const name = timestampSvgName(this.now());
      const entry = await this.writeExportFile(
        folder,
        name,
        bytes,
        "생성한 SVG 파일에 쓰기 기능이 없습니다.",
      );
      this.options.onActivity?.(`${fileName(entry) || name} SVG fallback 썸네일을 저장했습니다.`);
    });
  }

  private async writeExportFile(
    folder: ThumbnailFolderEntry,
    name: string,
    bytes: Uint8Array,
    missingWriteMessage: string,
  ): Promise<ThumbnailFileEntry> {
    try {
      const entry = await folder.createFile(name, { overwrite: false });
      if (typeof entry.write !== "function") throw new Error(missingWriteMessage);
      await entry.write(bytesToArrayBuffer(bytes), { format: this.adapter.binaryFormat });
      return entry;
    } catch (error) {
      await this.clearOutputFolderTokenBestEffort();
      throw error;
    }
  }

  private async clearOutputFolderTokenBestEffort(): Promise<void> {
    const storage = this.adapter.storage;
    if (!storage) return;
    if (storage.removeItem) {
      try {
        await storage.removeItem(THUMBNAIL_OUTPUT_FOLDER_TOKEN_KEY);
        return;
      } catch {
        // removeItem 실패 시 빈 토큰 저장으로 권한 재사용을 막습니다.
      }
    }
    try {
      await storage.setItem(THUMBNAIL_OUTPUT_FOLDER_TOKEN_KEY, "");
    } catch {
      // token 정리 실패가 원래 파일 저장 오류를 가리지 않게 합니다.
    }
  }

  private async resolveOutputFolder(): Promise<ThumbnailFolderEntry | null> {
    const storage = this.adapter.storage;
    if (storage) {
      let stored: unknown;
      try {
        stored = await storage.getItem(THUMBNAIL_OUTPUT_FOLDER_TOKEN_KEY);
      } catch {
        this.options.onActivity?.("저장된 썸네일 출력 폴더 권한을 읽지 못해 폴더를 다시 선택합니다.");
      }
      const token = typeof stored === "string" ? stored.trim() : "";
      if (token) {
        try {
          const restored = await this.adapter.localFileSystem.getEntryForPersistentToken(token);
          if (isUsableFolderEntry(restored)) return restored;
        } catch {
          // 만료되거나 이동된 출력 폴더는 아래에서 다시 선택합니다.
        }
        await this.clearOutputFolderTokenBestEffort();
      }
    }

    const folder = await this.adapter.localFileSystem.getFolder();
    if (!folder) return null;
    if (!isUsableFolderEntry(folder)) {
      throw new Error("썸네일 출력 위치에는 파일이 아닌 폴더를 선택해 주세요.");
    }
    if (storage) {
      try {
        const tokenValue = await this.adapter.localFileSystem.createPersistentToken(folder);
        const token = typeof tokenValue === "string" ? tokenValue.trim() : "";
        if (!token) throw new Error("썸네일 출력 폴더의 영구 접근 권한을 만들지 못했습니다.");
        await storage.setItem(THUMBNAIL_OUTPUT_FOLDER_TOKEN_KEY, token);
      } catch {
        this.options.onActivity?.("썸네일은 저장하지만 출력 폴더 권한을 기억하지 못해 다음 저장 때 다시 선택해야 합니다.");
      }
    }
    return folder;
  }

  private async svgHrefForLayer(layer: ThumbnailLayer): Promise<string> {
    const record = this.sources.get(layer.id) ?? this.sources.get(layer.source);
    if (!record) throw new Error(`레이어 ${layer.id}의 SVG 이미지 원본을 찾지 못했습니다.`);
    const historyItem = this.historyItems.find((item) => item.id === record.id || item.url === record.url);
    if (historyItem) {
      return thumbnailBytesToDataUrl(historyItem.bytes, "image/png");
    }
    if (/^data:image\//iu.test(record.url)) return record.url;
    if (!record.token) {
      if (record.url) return record.url;
      throw new Error(`레이어 ${layer.id}의 SVG 이미지 경로를 찾지 못했습니다.`);
    }
    const entry = await this.adapter.localFileSystem.getEntryForPersistentToken(record.token);
    if (!isUsableFileEntry(entry) || typeof entry.read !== "function") {
      if (record.url) return record.url;
      throw new Error(`${record.name} 파일을 SVG에 포함할 수 없습니다.`);
    }
    const bytes = normalizeBytes(await entry.read({ format: this.adapter.binaryFormat }), MAX_THUMBNAIL_SOURCE_BYTES);
    return thumbnailBytesToDataUrl(bytes, inferThumbnailImageMime(fileName(entry), bytes));
  }

  private async runAI(): Promise<void> {
    const button = element<HTMLButtonElement>("thumb-ai-run-btn");
    const card = button.closest<HTMLElement>(".thumb-ai-card");
    if (button.disabled || card?.hidden) {
      throw new Error("썸네일 AI 보정은 내부 베타에서 비활성화되어 있습니다.");
    }
    const detectedLimit = this.detectCanvasLimit();
    if (detectedLimit) {
      this.setCanvasLimited(detectedLimit);
      throw new Error(`현재 환경에서는 썸네일 AI 입력 이미지를 만들 수 없습니다: ${detectedLimit}`);
    }
    if (!this.options.onAIRequest) {
      throw new Error("AI 실행 콜백이 연결되지 않았습니다. index.ts에서 onAIRequest를 주입해 주세요.");
    }
    const preset = valueOf("thumb-ai-preset-select");
    if (!isThumbnailAIPreset(preset)) {
      throw new Error("지원하는 AI 보정 프리셋을 선택해 주세요.");
    }
    const prompt = valueOf("thumb-ai-prompt-input")
      .normalize("NFKC")
      .replace(/[\u0000-\u001f\u007f]/gu, " ")
      .trim()
      .replace(/\s+/gu, " ");
    if (prompt.length > MAX_THUMBNAIL_AI_PROMPT_CHARACTERS) {
      throw new Error(`AI 추가 지시는 최대 ${MAX_THUMBNAIL_AI_PROMPT_CHARACTERS.toLocaleString("ko-KR")}자입니다.`);
    }
    if (preset === "chat" && !prompt) {
      throw new Error("AI 대화로 수정하려면 추가 지시를 입력해 주세요.");
    }
    button.disabled = true;
    try {
      await this.renderCanvas();
      const inputBytes = await canvasToPngBytes(element<HTMLCanvasElement>("thumbnail-canvas"));
      const result = aiResultBytes(await this.options.onAIRequest(inputBytes, preset, prompt));
      if (result.bytes.byteLength === 0) throw new Error("AI가 빈 이미지 데이터를 반환했습니다.");
      this.addAIResult(result.bytes, result.name, preset, prompt);
      await this.persist();
      this.syncUI();
      this.requestRender();
      this.options.onActivity?.(`${preset} AI 보정 결과를 새 레이어로 추가했습니다.`);
    } finally {
      button.disabled = false;
    }
  }

  private addAIResult(
    bytes: Uint8Array,
    requestedName: string | undefined,
    preset: string,
    prompt: string,
  ): void {
    if (this.stateValue.layers.length >= 4) {
      const evicted = this.stateValue.layers[0];
      if (evicted) {
        this.stateValue = removeLayer(this.stateValue, evicted.id);
        const old = this.sources.get(evicted.id);
        this.sources.delete(evicted.id);
        this.imageCache.delete(evicted.id);
        if (old?.kind === "generated" && !this.historyItems.some((item) => item.url === old.url)) {
          revokeGeneratedUrl(old.url);
        }
      }
    }
    const createdAt = this.now();
    const id = this.uniqueSourceId(sourceId(createdAt, this.historyItems.length));
    const name = requestedName?.trim() || `AI ${preset} 결과`;
    const url = pngUrl(bytes);
    this.sources.set(id, { id, name, url, token: null, kind: "generated", createdAt });
    this.stateValue = addLayer(this.stateValue, { id, source: id });
    this.historyItems.unshift({
      id,
      name,
      url,
      bytes: bytes.slice(),
      preset,
      prompt,
      createdAt,
    });
    while (this.historyItems.length > 10) {
      const removed = this.historyItems.pop();
      if (removed && ![...this.sources.values()].some((item) => item.url === removed.url)) {
        revokeGeneratedUrl(removed.url);
      }
    }
  }

  private restoreHistoryItem(item: ThumbnailHistoryItem): void {
    if (this.stateValue.layers.some((layer) => layer.id === item.id)) {
      this.selectLayer(item.id);
      return;
    }
    if (this.stateValue.layers.length >= 4) {
      const first = this.stateValue.layers[0];
      if (first) {
        this.stateValue = removeLayer(this.stateValue, first.id);
        this.sources.delete(first.id);
        this.imageCache.delete(first.id);
      }
    }
    const id = this.uniqueSourceId(item.id);
    this.sources.set(id, {
      id,
      name: item.name,
      url: item.url,
      token: null,
      kind: "generated",
      createdAt: item.createdAt,
    });
    this.stateValue = addLayer(this.stateValue, { id, source: id });
    this.syncUI();
    this.requestRender();
  }

  private uniqueSourceId(preferred: string): string {
    if (!this.sources.has(preferred)) return preferred;
    let suffix = 2;
    while (this.sources.has(`${preferred}-${suffix}`)) suffix += 1;
    return `${preferred}-${suffix}`;
  }

  private async resolveEntryUrl(entry: ThumbnailFileEntry): Promise<string> {
    if (!isUsableFileEntry(entry)) {
      throw new Error("선택한 항목이 읽을 수 있는 이미지 파일이 아닙니다.");
    }
    const direct = fileUrl(entry);
    if (direct) return direct;
    if (typeof entry.read !== "function") {
      throw new Error(`${fileName(entry)} 파일의 미리보기 URL을 만들 수 없습니다.`);
    }
    const data = await entry.read({ format: this.adapter.binaryFormat });
    return pngUrl(normalizeBytes(data, MAX_THUMBNAIL_SOURCE_BYTES));
  }

  private async restore(): Promise<void> {
    if (!this.adapter.storage) return;
    const stored = parseStored(await this.adapter.storage.getItem(this.storageKey));
    if (!stored) return;
    const restored: Array<{ record: SourceRecord; storedLayer: StoredLayer }> = [];
    for (const item of stored.layers) {
      try {
        const entry = await this.adapter.localFileSystem.getEntryForPersistentToken(item.token);
        restored.push({
          record: {
            id: this.uniqueSourceId(item.id),
            name: fileName(entry) || item.name,
            url: await this.resolveEntryUrl(entry),
            token: item.token,
            kind: "file",
            createdAt: item.createdAt,
          },
          storedLayer: item,
        });
      } catch (error) {
        this.options.onError?.(error, `${item.name} 썸네일 접근 권한 복원 실패`);
      }
    }
    for (const { record } of restored) this.sources.set(record.id, record);
    this.stateValue = createThumbnailState({
      ...(stored.width !== undefined ? { width: stored.width } : {}),
      ...(stored.height !== undefined ? { height: stored.height } : {}),
      layout: stored.layout,
      layers: restored.map(({ record, storedLayer }) => ({
        id: record.id,
        source: record.id,
        ...(storedLayer.adjustments ? { adjustments: storedLayer.adjustments } : {}),
        ...(storedLayer.overlay ? { overlay: storedLayer.overlay } : {}),
        ...(storedLayer.transform ? { transform: storedLayer.transform } : {}),
      })),
      selectedLayerId: restored.some(({ record }) => record.id === stored.selectedLayerId)
        ? stored.selectedLayerId
        : (restored[0]?.record.id ?? null),
      ...(stored.backgroundColor !== undefined
        ? { backgroundColor: stored.backgroundColor }
        : {}),
      ...(stored.textOverlay ? { textOverlay: stored.textOverlay } : {}),
      ...(stored.badgeOverlay ? { badgeOverlay: stored.badgeOverlay } : {}),
    });
  }

  private async persist(): Promise<void> {
    if (!this.adapter.storage) return;
    const layers: StoredLayer[] = [];
    for (const layer of this.stateValue.layers) {
      const source = this.sources.get(layer.id);
      if (source?.kind === "file" && source.token) {
        layers.push({
          id: source.id,
          name: source.name,
          token: source.token,
          createdAt: source.createdAt,
          adjustments: { ...layer.adjustments },
          overlay: { ...layer.overlay },
          transform: { ...layer.transform },
        });
      }
    }
    const stored: StoredThumbnailState = {
      version: 3,
      width: this.stateValue.width,
      height: this.stateValue.height,
      layout: this.stateValue.layout,
      selectedLayerId: this.stateValue.selectedLayerId,
      backgroundColor: this.stateValue.backgroundColor,
      textOverlay: { ...this.stateValue.textOverlay },
      badgeOverlay: { ...this.stateValue.badgeOverlay },
      layers,
    };
    await this.adapter.storage.setItem(this.storageKey, JSON.stringify(stored));
  }

  private syncUI(): void {
    this.syncLayoutControl();
    this.renderLayerList();
    this.syncInspector();
    this.syncCanvasCapabilityUI();
    this.renderHistory();
  }

  private syncLayoutControl(): void {
    const select = element<HTMLSelectElement>("thumbnail-layout-select");
    const hasExactValue = [...select.options].some((option) => option.value === this.stateValue.layout);
    select.value = hasExactValue ? this.stateValue.layout : String(layoutCount(this.stateValue.layout));
  }

  private syncInspector(): void {
    const layer = this.stateValue.layers.find((item) => item.id === this.stateValue.selectedLayerId);
    const brightness = element<HTMLInputElement>("thumb-brightness-input");
    const contrast = element<HTMLInputElement>("thumb-contrast-input");
    const saturation = element<HTMLInputElement>("thumb-saturation-input");
    const zoom = element<HTMLInputElement>("thumb-zoom-input");
    const offsetX = element<HTMLInputElement>("thumb-offset-x-input");
    const offsetY = element<HTMLInputElement>("thumb-offset-y-input");
    const shadow = element<HTMLInputElement>("thumb-shadow-checkbox");
    const shadowColor = element<HTMLInputElement>("thumb-shadow-color");
    const glow = element<HTMLInputElement>("thumb-glow-checkbox");
    const glowColor = element<HTMLInputElement>("thumb-glow-color");
    const title = element<HTMLInputElement>("thumb-title-input");
    const titleColor = element<HTMLInputElement>("thumb-title-color");
    const titleSize = element<HTMLInputElement>("thumb-title-size-input");
    const badge = element<HTMLInputElement>("thumb-badge-input");
    const badgeColor = element<HTMLInputElement>("thumb-badge-color");
    const badgeBackground = element<HTMLInputElement>("thumb-badge-background-color");
    const controls = [brightness, contrast, saturation, zoom, offsetX, offsetY, shadow, shadowColor, glow, glowColor];
    controls.forEach((control) => { control.disabled = !layer; });
    brightness.value = String(layer?.adjustments.brightness ?? 100);
    contrast.value = String(layer?.adjustments.contrast ?? 100);
    saturation.value = String(layer?.adjustments.saturation ?? 100);
    zoom.value = String(Math.round((layer?.transform.zoom ?? 1) * 100));
    offsetX.value = String(Math.round((layer?.transform.offsetX ?? 0) * 100));
    offsetY.value = String(Math.round((layer?.transform.offsetY ?? 0) * 100));
    shadow.checked = (layer?.overlay.shadow ?? 0) > 0;
    glow.checked = (layer?.overlay.glow ?? 0) > 0;
    shadowColor.value = layer?.overlay.shadowColor ?? "#000000";
    glowColor.value = layer?.overlay.glowColor ?? "#8b5cf6";
    title.value = this.stateValue.textOverlay.text;
    titleColor.value = this.stateValue.textOverlay.color;
    titleSize.value = String(this.stateValue.textOverlay.fontSize);
    badge.value = this.stateValue.badgeOverlay.text;
    badgeColor.value = this.stateValue.badgeOverlay.color;
    badgeBackground.value = this.stateValue.badgeOverlay.backgroundColor;
    for (const control of [brightness, contrast, saturation, zoom]) {
      const output = document.querySelector<HTMLOutputElement>(`[data-value-for="${control.id}"]`);
      if (output) output.value = `${control.value}%`;
    }
    for (const control of [offsetX, offsetY]) {
      const output = document.querySelector<HTMLOutputElement>(`[data-value-for="${control.id}"]`);
      if (output) output.value = `${Number(control.value) > 0 ? "+" : ""}${control.value}%`;
    }
  }

  private renderLayerList(): void {
    const target = element<HTMLElement>("thumbnail-layer-list");
    clearChildren(target);
    if (this.stateValue.layers.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state layer-empty-state";
      const icon = document.createElement("span");
      icon.className = "empty-state-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = "▱";
      const title = document.createElement("strong");
      title.textContent = "아직 레이어가 없습니다";
      const copy = document.createElement("p");
      copy.textContent = "소스 추가를 눌러 이미지를 불러오세요.";
      empty.append(icon, title, copy);
      target.append(empty);
      return;
    }

    this.stateValue.layers.forEach((layer, index) => {
      const source = this.sources.get(layer.id);
      const card = document.createElement("article");
      card.className = `layer-card draggable-card${layer.id === this.stateValue.selectedLayerId ? " is-selected" : ""}`;
      card.setAttribute("role", "listitem");
      card.setAttribute("aria-selected", String(layer.id === this.stateValue.selectedLayerId));
      card.tabIndex = 0;
      card.draggable = true;
      card.dataset.layerIndex = String(index);

      const handle = document.createElement("span");
      handle.className = "drag-handle";
      handle.setAttribute("aria-hidden", "true");
      handle.textContent = "⠿";
      const badge = document.createElement("span");
      badge.className = "layer-kind-badge";
      badge.textContent = source?.kind === "generated" ? "AI" : "IMG";
      const copy = document.createElement("div");
      copy.className = "layer-card-copy";
      const name = document.createElement("strong");
      name.textContent = source?.name ?? layer.id;
      const detail = document.createElement("small");
      detail.textContent = `${index + 1}번 셀 · ${this.stateValue.layout}`;
      copy.append(name, detail);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "layer-action";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `${name.textContent} 레이어 삭제`);
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.guard(() => this.deleteLayer(layer.id), "썸네일 레이어 삭제 실패");
      });
      card.addEventListener("click", () => this.selectLayer(layer.id));
      card.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this.selectLayer(layer.id);
        } else if (event.key === "Delete") {
          event.preventDefault();
          void this.guard(() => this.deleteLayer(layer.id), "썸네일 레이어 삭제 실패");
        }
      });
      card.addEventListener("dragstart", (event) => {
        this.dragFromIndex = index;
        card.classList.add("is-dragging");
        card.setAttribute("aria-grabbed", "true");
        event.dataTransfer?.setData("text/shortflow-thumbnail-index", String(index));
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      });
      card.addEventListener("dragover", (event) => {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      });
      card.addEventListener("drop", (event) => {
        event.preventDefault();
        const raw = event.dataTransfer?.getData("text/shortflow-thumbnail-index");
        const from = raw ? Number(raw) : this.dragFromIndex;
        if (!Number.isInteger(from) || from === index) return;
        void this.guard(() => this.moveLayer(from, index), "썸네일 레이어 순서 변경 실패");
      });
      card.addEventListener("dragend", () => {
        this.dragFromIndex = -1;
        card.classList.remove("is-dragging");
        card.setAttribute("aria-grabbed", "false");
      });
      card.append(handle, badge, copy, remove);
      target.append(card);
    });
  }

  private renderHistory(): void {
    const target = element<HTMLElement>("thumb-ai-history");
    clearChildren(target);
    if (this.historyItems.length === 0) {
      const empty = document.createElement("div");
      empty.className = "history-empty";
      empty.textContent = "아직 AI 보정 기록이 없습니다.";
      target.append(empty);
      return;
    }
    for (const item of this.historyItems) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "history-card";
      card.title = `${item.preset}${item.prompt ? ` · ${item.prompt}` : ""}`;
      card.setAttribute("role", "listitem");
      card.setAttribute("aria-label", `${item.name} 결과를 레이어로 복원`);
      const image = document.createElement("img");
      image.src = item.url;
      image.alt = item.name;
      card.append(image);
      card.addEventListener("click", () => this.restoreHistoryItem(item));
      target.append(card);
    }
  }
}

export async function initializeThumbnailController(
  options: ThumbnailControllerOptions = {},
): Promise<ThumbnailController> {
  const controller = new ThumbnailController(options);
  await controller.initialize();
  return controller;
}
