export const BRAND_KIT_SCHEMA_VERSION = 1 as const;
export const BRAND_KIT_STORAGE_KEY = "shortflow.brand-kits.v1";
export const MAX_BRAND_KITS = 20;
export const MAX_BRAND_KIT_IMPORT_BYTES = 2_000_000;

export type CaptionPosition = "top" | "center" | "bottom";
export type BrandThumbnailLayout =
  | "full"
  | "vertical"
  | "horizontal"
  | "hero-left"
  | "hero-top"
  | "grid";
export type BrandTtsModel = "gpt-4o-mini-tts" | "tts-1-hd" | "tts-1";

export interface BrandFontPreset {
  readonly family: string;
  readonly weight: number;
  readonly fallback: string;
}

export interface BrandColorPreset {
  readonly primary: string;
  readonly secondary: string;
  readonly accent: string;
}

export interface BrandFilePreset {
  readonly token: string;
  readonly name: string;
}

export interface BrandCaptionStyle {
  readonly maxChars: number;
  readonly position: CaptionPosition;
  readonly shadow: boolean;
  readonly highlight: boolean;
}

export interface BrandThumbnailDefaults {
  readonly layout: BrandThumbnailLayout;
  readonly backgroundColor: string;
  readonly textColor: string;
  readonly brightness: number;
  readonly contrast: number;
  readonly saturation: number;
  readonly shadow: number;
  readonly glow: number;
  readonly shadowColor: string;
  readonly glowColor: string;
}

export interface BrandTtsPreset {
  readonly model: BrandTtsModel;
  readonly voice: string;
  readonly speed: number;
}

export interface BrandMogrtPreset extends BrandFilePreset {
  readonly track: number;
}

export interface BrandKit {
  readonly schemaVersion: typeof BRAND_KIT_SCHEMA_VERSION;
  readonly id: string;
  readonly name: string;
  readonly font: BrandFontPreset;
  readonly colors: BrandColorPreset;
  readonly logo: BrandFilePreset;
  readonly caption: BrandCaptionStyle;
  readonly thumbnail: BrandThumbnailDefaults;
  readonly tts: BrandTtsPreset;
  readonly mogrt: BrandMogrtPreset;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface BrandKitInput {
  readonly schemaVersion?: unknown;
  readonly id?: unknown;
  readonly name?: unknown;
  readonly font?: Partial<BrandFontPreset> | unknown;
  readonly colors?: Partial<BrandColorPreset> | unknown;
  readonly logo?: Partial<BrandFilePreset> | unknown;
  readonly caption?: Partial<BrandCaptionStyle> | unknown;
  readonly thumbnail?: Partial<BrandThumbnailDefaults> | unknown;
  readonly tts?: Partial<BrandTtsPreset> | unknown;
  readonly mogrt?: Partial<BrandMogrtPreset> | unknown;
  readonly createdAt?: unknown;
  readonly updatedAt?: unknown;
}

export interface BrandKitValidationIssue {
  readonly level: "error" | "warning";
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface BrandKitStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem?(key: string): void | Promise<void>;
}

export interface BrandKitAdapter {
  readonly storage: BrandKitStorage;
}

export interface BrandKitLibraryOptions {
  readonly storageKey?: string;
  readonly maxKits?: number;
  readonly now?: () => number;
  readonly idFactory?: (name: string, index: number) => string;
}

export interface BrandKitImportOptions {
  readonly replace?: boolean;
  readonly preserveIds?: boolean;
}

interface StoredBrandKitDocument {
  schemaVersion: typeof BRAND_KIT_SCHEMA_VERSION;
  activeKitId: string | null;
  kits: BrandKit[];
}

interface PortableBrandKitDocument {
  schemaVersion: typeof BRAND_KIT_SCHEMA_VERSION;
  exportedAt: number;
  activeKitId: string | null;
  kits: unknown[];
}

type ErrorCode =
  | "DUPLICATE_ID"
  | "IMPORT_TOO_LARGE"
  | "INVALID_IMPORT"
  | "INVALID_INPUT"
  | "LIMIT_EXCEEDED"
  | "NOT_FOUND"
  | "STORAGE_ERROR"
  | "UNSUPPORTED_VERSION";

export class BrandKitError extends Error {
  override readonly name = "BrandKitError";
  readonly code: ErrorCode;
  readonly causeValue?: unknown;

  constructor(code: ErrorCode, message: string, causeValue?: unknown) {
    super(message);
    this.code = code;
    if (causeValue !== undefined) this.causeValue = causeValue;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export const DEFAULT_BRAND_KIT = deepFreezeKit({
  schemaVersion: BRAND_KIT_SCHEMA_VERSION,
  id: "brand-default",
  name: "새 브랜드 키트",
  font: {
    family: "Pretendard",
    weight: 700,
    fallback: "Arial, sans-serif",
  },
  colors: {
    primary: "#ffffff",
    secondary: "#111111",
    accent: "#8b5cf6",
  },
  logo: { token: "", name: "" },
  caption: {
    maxChars: 24,
    position: "bottom",
    shadow: true,
    highlight: false,
  },
  thumbnail: {
    layout: "full",
    backgroundColor: "#111111",
    textColor: "#ffffff",
    brightness: 100,
    contrast: 100,
    saturation: 100,
    shadow: 0,
    glow: 0,
    shadowColor: "#000000",
    glowColor: "#8b5cf6",
  },
  tts: {
    model: "gpt-4o-mini-tts",
    voice: "marin",
    speed: 1,
  },
  mogrt: { token: "", name: "", track: 2 },
  createdAt: 0,
  updatedAt: 0,
});

const LAYOUTS = new Set<BrandThumbnailLayout>([
  "full",
  "vertical",
  "horizontal",
  "hero-left",
  "hero-top",
  "grid",
]);
const TTS_MODELS = new Set<BrandTtsModel>([
  "gpt-4o-mini-tts",
  "tts-1-hd",
  "tts-1",
]);
const CAPTION_POSITIONS = new Set<CaptionPosition>(["top", "center", "bottom"]);
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{2,63}$/u;
const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu;
const UNSAFE_FONT_PATTERN = /[{};<>"'\\/\u0000-\u001f\u007f]|url\s*\(/iu;
const UNSAFE_TOKEN_PATTERN = /[\u0000-\u001f\u007f]/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function finiteTime(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function clampNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function cleanText(value: unknown, fallback: string, maximum: number): string {
  if (typeof value !== "string") return fallback;
  const clean = value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximum)
    .trim();
  return clean || fallback;
}

function isSafeFontName(value: unknown): value is string {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= 120 &&
    !UNSAFE_FONT_PATTERN.test(value);
}

function fontName(value: unknown, fallback: string): string {
  return isSafeFontName(value)
    ? value.trim().replace(/\s+/gu, " ")
    : fallback;
}

function fallbackFonts(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.length > 240) return fallback;
  const names = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (names.length === 0 || names.length > 8 || names.some((name) => !isSafeFontName(name))) {
    return fallback;
  }
  return names.join(", ");
}

function fontWeight(value: unknown, fallback: number): number {
  const clamped = clampNumber(value, fallback, 100, 900);
  return Math.round(clamped / 100) * 100;
}

function normalizeHexColor(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !HEX_COLOR_PATTERN.test(value.trim())) return fallback;
  const clean = value.trim().toLowerCase();
  if (clean.length === 4) {
    const red = clean[1] ?? "0";
    const green = clean[2] ?? "0";
    const blue = clean[3] ?? "0";
    return `#${red}${red}${green}${green}${blue}${blue}`;
  }
  return clean;
}

function safeToken(value: unknown): string {
  if (typeof value !== "string") return "";
  const clean = value.trim();
  if (!clean || clean.length > 4_096 || UNSAFE_TOKEN_PATTERN.test(clean)) return "";
  return clean;
}

function filePreset(
  value: unknown,
  requireMogrt = false,
): BrandFilePreset {
  const input = record(value);
  const name = cleanText(input.name, "", 260);
  const validName = !requireMogrt || name === "" || /\.mogrt$/iu.test(name);
  const normalizedName = validName ? name : "";
  const token = normalizedName ? safeToken(input.token) : "";
  return Object.freeze({ token, name: normalizedName });
}

function validId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function slug(value: string): string {
  const clean = value
    .normalize("NFKD")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 28);
  return clean || "brand";
}

function generatedId(name: string, now: number): string {
  return `${slug(name)}-${Math.max(0, Math.floor(now)).toString(36)}`.slice(0, 64);
}

function uniqueId(preferred: string, used: ReadonlySet<string>): string {
  let base = preferred;
  if (!validId(base)) base = "brand-kit";
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base.slice(0, 60)}-${suffix}`)) suffix += 1;
  return `${base.slice(0, 60)}-${suffix}`;
}

function deepFreezeKit(kit: BrandKit): BrandKit {
  return Object.freeze({
    ...kit,
    font: Object.freeze({ ...kit.font }),
    colors: Object.freeze({ ...kit.colors }),
    logo: Object.freeze({ ...kit.logo }),
    caption: Object.freeze({ ...kit.caption }),
    thumbnail: Object.freeze({ ...kit.thumbnail }),
    tts: Object.freeze({ ...kit.tts }),
    mogrt: Object.freeze({ ...kit.mogrt }),
  });
}

export interface NormalizeBrandKitOptions {
  readonly now?: number;
  readonly generatedId?: string;
  readonly forceId?: string;
  readonly stripTokens?: boolean;
}

export function normalizeBrandKit(
  value: unknown,
  options: NormalizeBrandKitOptions = {},
): BrandKit {
  const input = record(value);
  const now = finiteTime(options.now, Date.now());
  const name = cleanText(input.name, DEFAULT_BRAND_KIT.name, 80);
  const font = record(input.font);
  const colors = record(input.colors);
  const caption = record(input.caption);
  const thumbnail = record(input.thumbnail);
  const tts = record(input.tts);
  const mogrtInput = record(input.mogrt);
  const logo = filePreset(input.logo);
  const mogrt = filePreset(mogrtInput, true);
  const preferredId = options.forceId ?? input.id;
  const fallbackId = validId(options.generatedId)
    ? options.generatedId
    : generatedId(name, now);
  const id = validId(preferredId) ? preferredId : fallbackId;
  const createdAt = finiteTime(input.createdAt, now);
  const updatedAt = Math.max(createdAt, finiteTime(input.updatedAt, now));
  const position = CAPTION_POSITIONS.has(caption.position as CaptionPosition)
    ? caption.position as CaptionPosition
    : DEFAULT_BRAND_KIT.caption.position;
  const layout = LAYOUTS.has(thumbnail.layout as BrandThumbnailLayout)
    ? thumbnail.layout as BrandThumbnailLayout
    : DEFAULT_BRAND_KIT.thumbnail.layout;
  const model = TTS_MODELS.has(tts.model as BrandTtsModel)
    ? tts.model as BrandTtsModel
    : DEFAULT_BRAND_KIT.tts.model;

  return deepFreezeKit({
    schemaVersion: BRAND_KIT_SCHEMA_VERSION,
    id,
    name,
    font: {
      family: fontName(font.family, DEFAULT_BRAND_KIT.font.family),
      weight: fontWeight(font.weight, DEFAULT_BRAND_KIT.font.weight),
      fallback: fallbackFonts(font.fallback, DEFAULT_BRAND_KIT.font.fallback),
    },
    colors: {
      primary: normalizeHexColor(colors.primary, DEFAULT_BRAND_KIT.colors.primary),
      secondary: normalizeHexColor(colors.secondary, DEFAULT_BRAND_KIT.colors.secondary),
      accent: normalizeHexColor(colors.accent, DEFAULT_BRAND_KIT.colors.accent),
    },
    logo: options.stripTokens ? { ...logo, token: "" } : logo,
    caption: {
      maxChars: Math.round(clampNumber(
        caption.maxChars,
        DEFAULT_BRAND_KIT.caption.maxChars,
        8,
        80,
      )),
      position,
      shadow: booleanValue(caption.shadow, DEFAULT_BRAND_KIT.caption.shadow),
      highlight: booleanValue(caption.highlight, DEFAULT_BRAND_KIT.caption.highlight),
    },
    thumbnail: {
      layout,
      backgroundColor: normalizeHexColor(
        thumbnail.backgroundColor,
        DEFAULT_BRAND_KIT.thumbnail.backgroundColor,
      ),
      textColor: normalizeHexColor(
        thumbnail.textColor,
        DEFAULT_BRAND_KIT.thumbnail.textColor,
      ),
      brightness: clampNumber(
        thumbnail.brightness,
        DEFAULT_BRAND_KIT.thumbnail.brightness,
        0,
        200,
      ),
      contrast: clampNumber(
        thumbnail.contrast,
        DEFAULT_BRAND_KIT.thumbnail.contrast,
        0,
        200,
      ),
      saturation: clampNumber(
        thumbnail.saturation,
        DEFAULT_BRAND_KIT.thumbnail.saturation,
        0,
        200,
      ),
      shadow: clampNumber(thumbnail.shadow, DEFAULT_BRAND_KIT.thumbnail.shadow, 0, 100),
      glow: clampNumber(thumbnail.glow, DEFAULT_BRAND_KIT.thumbnail.glow, 0, 100),
      shadowColor: normalizeHexColor(
        thumbnail.shadowColor,
        DEFAULT_BRAND_KIT.thumbnail.shadowColor,
      ),
      glowColor: normalizeHexColor(
        thumbnail.glowColor,
        DEFAULT_BRAND_KIT.thumbnail.glowColor,
      ),
    },
    tts: {
      model,
      voice: cleanText(tts.voice, DEFAULT_BRAND_KIT.tts.voice, 120),
      speed: clampNumber(tts.speed, DEFAULT_BRAND_KIT.tts.speed, 0.25, 4),
    },
    mogrt: {
      ...mogrt,
      token: options.stripTokens ? "" : mogrt.token,
      track: Math.round(clampNumber(
        mogrtInput.track,
        DEFAULT_BRAND_KIT.mogrt.track,
        1,
        99,
      )),
    },
    createdAt,
    updatedAt,
  });
}

function issue(
  issues: BrandKitValidationIssue[],
  level: BrandKitValidationIssue["level"],
  code: string,
  path: string,
  message: string,
): void {
  issues.push(Object.freeze({ level, code, path, message }));
}

function validateRange(
  issues: BrandKitValidationIssue[],
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): void {
  if (value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    issue(issues, "error", "OUT_OF_RANGE", path, `${path} 값은 ${minimum}~${maximum} 범위여야 합니다.`);
  }
}

export function validateBrandKit(value: unknown): readonly BrandKitValidationIssue[] {
  const issues: BrandKitValidationIssue[] = [];
  if (!isRecord(value)) {
    issue(issues, "error", "INVALID_OBJECT", "$", "브랜드 키트는 객체여야 합니다.");
    return Object.freeze(issues);
  }
  if (value.schemaVersion !== undefined && value.schemaVersion !== BRAND_KIT_SCHEMA_VERSION) {
    issue(issues, "error", "UNSUPPORTED_VERSION", "schemaVersion", "지원하지 않는 스키마 버전입니다.");
  }
  if (value.id !== undefined && !validId(value.id)) {
    issue(issues, "error", "INVALID_ID", "id", "브랜드 키트 ID 형식이 올바르지 않습니다.");
  }
  if (value.name !== undefined && (typeof value.name !== "string" || !value.name.trim() || value.name.length > 80)) {
    issue(issues, "error", "INVALID_NAME", "name", "이름은 1~80자의 문자열이어야 합니다.");
  }

  const font = record(value.font);
  if (font.family !== undefined && !isSafeFontName(font.family)) {
    issue(issues, "error", "INVALID_FONT", "font.family", "안전한 폰트 패밀리 이름이 아닙니다.");
  }
  if (font.fallback !== undefined && fallbackFonts(font.fallback, "") === "") {
    issue(issues, "error", "INVALID_FONT", "font.fallback", "fallback 폰트 목록이 올바르지 않습니다.");
  }
  validateRange(issues, font.weight, "font.weight", 100, 900);
  if (typeof font.weight === "number" && font.weight % 100 !== 0) {
    issue(issues, "warning", "FONT_WEIGHT_ROUNDED", "font.weight", "폰트 굵기는 100 단위로 반올림됩니다.");
  }

  const colors = record(value.colors);
  for (const key of ["primary", "secondary", "accent"] as const) {
    if (colors[key] !== undefined && (
      typeof colors[key] !== "string" || !HEX_COLOR_PATTERN.test(colors[key].trim())
    )) {
      issue(issues, "error", "INVALID_COLOR", `colors.${key}`, "색상은 #RGB 또는 #RRGGBB 형식이어야 합니다.");
    }
  }

  for (const [path, preset, requireMogrt] of [
    ["logo", record(value.logo), false],
    ["mogrt", record(value.mogrt), true],
  ] as const) {
    if (
      preset.token !== undefined &&
      preset.token !== "" &&
      safeToken(preset.token) === ""
    ) {
      issue(issues, "error", "INVALID_TOKEN", `${path}.token`, "persistent token이 비어 있거나 안전하지 않습니다.");
    }
    if (safeToken(preset.token) && (typeof preset.name !== "string" || !preset.name.trim())) {
      issue(issues, "error", "TOKEN_WITHOUT_NAME", `${path}.name`, "persistent token에는 파일 이름이 필요합니다.");
    }
    if (preset.name !== undefined && (typeof preset.name !== "string" || preset.name.length > 260)) {
      issue(issues, "error", "INVALID_FILE_NAME", `${path}.name`, "파일 이름이 올바르지 않습니다.");
    }
    if (requireMogrt && typeof preset.name === "string" && preset.name && !/\.mogrt$/iu.test(preset.name)) {
      issue(issues, "error", "INVALID_MOGRT", "mogrt.name", "MOGRT 파일 이름은 .mogrt로 끝나야 합니다.");
    }
  }

  const caption = record(value.caption);
  validateRange(issues, caption.maxChars, "caption.maxChars", 8, 80);
  if (caption.position !== undefined && !CAPTION_POSITIONS.has(caption.position as CaptionPosition)) {
    issue(issues, "error", "INVALID_POSITION", "caption.position", "자막 위치가 올바르지 않습니다.");
  }
  for (const key of ["shadow", "highlight"] as const) {
    if (caption[key] !== undefined && typeof caption[key] !== "boolean") {
      issue(issues, "error", "INVALID_BOOLEAN", `caption.${key}`, "boolean 값이어야 합니다.");
    }
  }

  const thumbnail = record(value.thumbnail);
  if (thumbnail.layout !== undefined && !LAYOUTS.has(thumbnail.layout as BrandThumbnailLayout)) {
    issue(issues, "error", "INVALID_LAYOUT", "thumbnail.layout", "썸네일 레이아웃이 올바르지 않습니다.");
  }
  for (const key of ["backgroundColor", "textColor", "shadowColor", "glowColor"] as const) {
    if (thumbnail[key] !== undefined && (
      typeof thumbnail[key] !== "string" || !HEX_COLOR_PATTERN.test(thumbnail[key].trim())
    )) {
      issue(issues, "error", "INVALID_COLOR", `thumbnail.${key}`, "색상은 #RGB 또는 #RRGGBB 형식이어야 합니다.");
    }
  }
  for (const key of ["brightness", "contrast", "saturation"] as const) {
    validateRange(issues, thumbnail[key], `thumbnail.${key}`, 0, 200);
  }
  for (const key of ["shadow", "glow"] as const) {
    validateRange(issues, thumbnail[key], `thumbnail.${key}`, 0, 100);
  }

  const tts = record(value.tts);
  if (tts.model !== undefined && !TTS_MODELS.has(tts.model as BrandTtsModel)) {
    issue(issues, "error", "INVALID_TTS_MODEL", "tts.model", "지원하지 않는 TTS 모델입니다.");
  }
  if (tts.voice !== undefined && (
    typeof tts.voice !== "string" || !tts.voice.trim() || tts.voice.length > 120 || UNSAFE_TOKEN_PATTERN.test(tts.voice)
  )) {
    issue(issues, "error", "INVALID_VOICE", "tts.voice", "TTS 음성 이름이 올바르지 않습니다.");
  }
  validateRange(issues, tts.speed, "tts.speed", 0.25, 4);
  validateRange(issues, record(value.mogrt).track, "mogrt.track", 1, 99);
  return Object.freeze(issues);
}

function mergeKit(existing: BrandKit, patch: unknown): BrandKitInput {
  const input = record(patch);
  return {
    ...existing,
    name: input.name ?? existing.name,
    font: { ...existing.font, ...record(input.font) },
    colors: { ...existing.colors, ...record(input.colors) },
    logo: { ...existing.logo, ...record(input.logo) },
    caption: { ...existing.caption, ...record(input.caption) },
    thumbnail: { ...existing.thumbnail, ...record(input.thumbnail) },
    tts: { ...existing.tts, ...record(input.tts) },
    mogrt: { ...existing.mogrt, ...record(input.mogrt) },
  };
}

function portableKit(kit: BrandKit): Record<string, unknown> {
  return {
    schemaVersion: BRAND_KIT_SCHEMA_VERSION,
    id: kit.id,
    name: kit.name,
    font: { ...kit.font },
    colors: { ...kit.colors },
    logo: { name: kit.logo.name },
    caption: { ...kit.caption },
    thumbnail: { ...kit.thumbnail },
    tts: { ...kit.tts },
    mogrt: { name: kit.mogrt.name, track: kit.mogrt.track },
    createdAt: kit.createdAt,
    updatedAt: kit.updatedAt,
  };
}

function parseDocument(raw: string): PortableBrandKitDocument {
  if (new TextEncoder().encode(raw).byteLength > MAX_BRAND_KIT_IMPORT_BYTES) {
    throw new BrandKitError("IMPORT_TOO_LARGE", "브랜드 키트 JSON은 2MB를 초과할 수 없습니다.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new BrandKitError("INVALID_IMPORT", "브랜드 키트 JSON 문법이 올바르지 않습니다.", error);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.kits)) {
    throw new BrandKitError("INVALID_IMPORT", "브랜드 키트 JSON 문서 구조가 올바르지 않습니다.");
  }
  if (parsed.schemaVersion !== BRAND_KIT_SCHEMA_VERSION) {
    throw new BrandKitError("UNSUPPORTED_VERSION", `스키마 버전 ${String(parsed.schemaVersion)}은 지원하지 않습니다.`);
  }
  return {
    schemaVersion: BRAND_KIT_SCHEMA_VERSION,
    exportedAt: finiteTime(parsed.exportedAt, 0),
    activeKitId: typeof parsed.activeKitId === "string" ? parsed.activeKitId : null,
    kits: parsed.kits,
  };
}

export function createDefaultBrandKitAdapter(storage?: BrandKitStorage): BrandKitAdapter {
  const candidate = storage ?? (
    globalThis as unknown as { localStorage?: BrandKitStorage }
  ).localStorage;
  if (!candidate || typeof candidate.getItem !== "function" || typeof candidate.setItem !== "function") {
    throw new BrandKitError("STORAGE_ERROR", "UXP localStorage를 사용할 수 없습니다.");
  }
  return { storage: candidate };
}

export class BrandKitLibrary {
  private readonly storageKey: string;
  private readonly maxKits: number;
  private readonly now: () => number;
  private readonly idFactory: ((name: string, index: number) => string) | undefined;
  private kitValues: BrandKit[] = [];
  private activeIdValue: string | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly adapter: BrandKitAdapter = createDefaultBrandKitAdapter(),
    options: BrandKitLibraryOptions = {},
  ) {
    this.storageKey = options.storageKey ?? BRAND_KIT_STORAGE_KEY;
    const requestedMax = options.maxKits ?? MAX_BRAND_KITS;
    this.maxKits = Number.isFinite(requestedMax)
      ? Math.min(MAX_BRAND_KITS, Math.max(1, Math.floor(requestedMax)))
      : MAX_BRAND_KITS;
    this.now = options.now ?? (() => Date.now());
    this.idFactory = options.idFactory;
  }

  get kits(): readonly BrandKit[] {
    return Object.freeze([...this.kitValues]);
  }

  get activeKitId(): string | null {
    return this.activeIdValue;
  }

  get activeKit(): BrandKit | null {
    return this.kitValues.find((kit) => kit.id === this.activeIdValue) ?? null;
  }

  get(id: string): BrandKit | null {
    return this.kitValues.find((kit) => kit.id === id) ?? null;
  }

  async load(): Promise<readonly BrandKit[]> {
    let raw: string | null;
    try {
      raw = await this.adapter.storage.getItem(this.storageKey);
    } catch (error) {
      throw new BrandKitError("STORAGE_ERROR", "브랜드 키트 저장소를 읽지 못했습니다.", error);
    }
    if (!raw) {
      this.kitValues = [];
      this.activeIdValue = null;
      return this.kits;
    }
    const document = parseDocument(raw);
    const used = new Set<string>();
    const loaded: BrandKit[] = [];
    for (const candidate of document.kits.slice(0, this.maxKits)) {
      if (!isRecord(candidate)) continue;
      const normalized = normalizeBrandKit(candidate, { now: this.now() });
      if (used.has(normalized.id)) continue;
      used.add(normalized.id);
      loaded.push(normalized);
    }
    this.kitValues = loaded;
    this.activeIdValue = loaded.some((kit) => kit.id === document.activeKitId)
      ? document.activeKitId
      : null;
    return this.kits;
  }

  create(input: BrandKitInput = {}): Promise<BrandKit> {
    return this.enqueue(async () => {
      this.ensureCapacity(1);
      const now = this.now();
      const name = cleanText(input.name, DEFAULT_BRAND_KIT.name, 80);
      const id = this.makeUniqueId(input.id, name, this.kitValues.length, now);
      const kit = normalizeBrandKit(input, { now, forceId: id });
      this.kitValues = [...this.kitValues, kit];
      if (!this.activeIdValue) this.activeIdValue = kit.id;
      await this.persist();
      return kit;
    });
  }

  update(id: string, patch: BrandKitInput): Promise<BrandKit> {
    return this.enqueue(async () => {
      const index = this.indexOf(id);
      const existing = this.kitValues[index]!;
      const updated = normalizeBrandKit(mergeKit(existing, patch), {
        now: this.now(),
        forceId: existing.id,
      });
      this.kitValues = this.kitValues.map((kit, kitIndex) => kitIndex === index
        ? deepFreezeKit({ ...updated, createdAt: existing.createdAt, updatedAt: this.now() })
        : kit);
      await this.persist();
      return this.kitValues[index]!;
    });
  }

  remove(id: string): Promise<BrandKit> {
    return this.enqueue(async () => {
      const index = this.indexOf(id);
      const removed = this.kitValues[index]!;
      this.kitValues = this.kitValues.filter((_kit, kitIndex) => kitIndex !== index);
      if (this.activeIdValue === id) this.activeIdValue = null;
      await this.persist();
      return removed;
    });
  }

  duplicate(id: string, requestedName?: string): Promise<BrandKit> {
    return this.enqueue(async () => {
      this.ensureCapacity(1);
      const source = this.kitValues[this.indexOf(id)]!;
      const now = this.now();
      const name = cleanText(requestedName, `${source.name} 복사본`, 80);
      const duplicateId = this.makeUniqueId(undefined, name, this.kitValues.length, now);
      const copy = normalizeBrandKit({ ...source, id: duplicateId, name }, {
        now,
        forceId: duplicateId,
      });
      const duplicate = deepFreezeKit({ ...copy, createdAt: now, updatedAt: now });
      this.kitValues = [...this.kitValues, duplicate];
      await this.persist();
      return duplicate;
    });
  }

  setActive(id: string | null): Promise<BrandKit | null> {
    return this.enqueue(async () => {
      if (id !== null && !this.kitValues.some((kit) => kit.id === id)) {
        throw new BrandKitError("NOT_FOUND", `브랜드 키트를 찾지 못했습니다: ${id}`);
      }
      this.activeIdValue = id;
      await this.persist();
      return this.activeKit;
    });
  }

  exportJSON(ids?: readonly string[]): string {
    const selected = ids
      ? ids.map((id) => {
          const kit = this.get(id);
          if (!kit) throw new BrandKitError("NOT_FOUND", `브랜드 키트를 찾지 못했습니다: ${id}`);
          return kit;
        })
      : this.kitValues;
    return JSON.stringify({
      schemaVersion: BRAND_KIT_SCHEMA_VERSION,
      exportedAt: this.now(),
      activeKitId: selected.some((kit) => kit.id === this.activeIdValue)
        ? this.activeIdValue
        : null,
      kits: selected.map(portableKit),
    } satisfies PortableBrandKitDocument, null, 2);
  }

  importJSON(
    json: string,
    options: BrandKitImportOptions = {},
  ): Promise<readonly BrandKit[]> {
    return this.enqueue(async () => {
      const document = parseDocument(json);
      const base = options.replace ? [] : [...this.kitValues];
      if (base.length + document.kits.length > this.maxKits) {
        throw new BrandKitError("LIMIT_EXCEEDED", `브랜드 키트는 최대 ${this.maxKits}개까지 저장할 수 있습니다.`);
      }
      const used = new Set(base.map((kit) => kit.id));
      const imported: BrandKit[] = [];
      const idMap = new Map<string, string>();
      const now = this.now();
      document.kits.forEach((candidate, index) => {
        if (!isRecord(candidate)) {
          throw new BrandKitError("INVALID_INPUT", `${index + 1}번째 브랜드 키트가 객체가 아닙니다.`);
        }
        const name = cleanText(candidate.name, DEFAULT_BRAND_KIT.name, 80);
        const originalId = typeof candidate.id === "string" ? candidate.id : "";
        const requestedId = options.preserveIds !== false && validId(originalId)
          ? originalId
          : this.generatedCandidate(name, base.length + imported.length, now + index);
        const id = uniqueId(requestedId, used);
        used.add(id);
        if (originalId && !idMap.has(originalId)) idMap.set(originalId, id);
        imported.push(normalizeBrandKit(candidate, {
          now: now + index,
          forceId: id,
          stripTokens: true,
        }));
      });
      this.kitValues = [...base, ...imported];
      const mappedActive = document.activeKitId
        ? idMap.get(document.activeKitId) ?? null
        : null;
      if (options.replace) this.activeIdValue = mappedActive;
      else if (!this.activeIdValue && mappedActive) this.activeIdValue = mappedActive;
      await this.persist();
      return Object.freeze([...imported]);
    });
  }

  clear(): Promise<void> {
    return this.enqueue(async () => {
      this.kitValues = [];
      this.activeIdValue = null;
      try {
        if (this.adapter.storage.removeItem) {
          await this.adapter.storage.removeItem(this.storageKey);
        } else {
          await this.adapter.storage.setItem(this.storageKey, "");
        }
      } catch (error) {
        throw new BrandKitError("STORAGE_ERROR", "브랜드 키트 저장소를 지우지 못했습니다.", error);
      }
    });
  }

  private indexOf(id: string): number {
    const index = this.kitValues.findIndex((kit) => kit.id === id);
    if (index < 0) throw new BrandKitError("NOT_FOUND", `브랜드 키트를 찾지 못했습니다: ${id}`);
    return index;
  }

  private ensureCapacity(additional: number): void {
    if (this.kitValues.length + additional > this.maxKits) {
      throw new BrandKitError("LIMIT_EXCEEDED", `브랜드 키트는 최대 ${this.maxKits}개까지 저장할 수 있습니다.`);
    }
  }

  private generatedCandidate(name: string, index: number, now: number): string {
    const candidate = this.idFactory?.(name, index);
    return validId(candidate) ? candidate : generatedId(name, now);
  }

  private makeUniqueId(
    requested: unknown,
    name: string,
    index: number,
    now: number,
  ): string {
    const preferred = validId(requested)
      ? requested
      : this.generatedCandidate(name, index, now);
    return uniqueId(preferred, new Set(this.kitValues.map((kit) => kit.id)));
  }

  private async persist(): Promise<void> {
    const document: StoredBrandKitDocument = {
      schemaVersion: BRAND_KIT_SCHEMA_VERSION,
      activeKitId: this.activeIdValue,
      kits: this.kitValues,
    };
    try {
      await this.adapter.storage.setItem(this.storageKey, JSON.stringify(document));
    } catch (error) {
      throw new BrandKitError("STORAGE_ERROR", "브랜드 키트를 저장하지 못했습니다.", error);
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const runWithRollback = async (): Promise<T> => {
      const previousKits = this.kitValues;
      const previousActiveId = this.activeIdValue;
      try {
        return await operation();
      } catch (error) {
        this.kitValues = previousKits;
        this.activeIdValue = previousActiveId;
        throw error;
      }
    };
    const run = this.mutationQueue.then(runWithRollback, runWithRollback);
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }
}
