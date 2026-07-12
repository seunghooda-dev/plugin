export type SocialPlatform = "youtube-shorts" | "instagram-reels" | "tiktok";

export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SafeZoneMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface SafeZoneProfile {
  id: SocialPlatform;
  label: string;
  revision: string;
  contentMargins: SafeZoneMargins;
  captionMargins: SafeZoneMargins;
}

export interface SafeZoneAssessment {
  platform: SocialPlatform;
  role: "content" | "caption";
  safeRect: NormalizedRect;
  elementRect: NormalizedRect;
  inside: boolean;
  overflow: SafeZoneMargins;
  overlapRatio: number;
}

export interface SafeZoneAlignment {
  rect: NormalizedRect;
  deltaX: number;
  deltaY: number;
  scale: number;
  changed: boolean;
  wasOversized: boolean;
}

export type SafeZoneBmpBitDepth = 24 | 32;

export interface SafeZoneBmpRenderOptions {
  width: number;
  height: number;
  platform: SocialPlatform;
  role?: "content" | "caption";
  customMargins?: Partial<SafeZoneMargins>;
  /** 32-bit is the default and carries an explicit BGRA alpha mask. */
  bitsPerPixel?: SafeZoneBmpBitDepth;
  /** Draws a red/white outer warning frame. Defaults to true. */
  includeRemovalWarning?: boolean;
  /** Optional caller limit that may only tighten the built-in safety limit. */
  maxPixels?: number;
  /** Optional caller limit that may only tighten the built-in safety limit. */
  maxBytes?: number;
}

export interface SafeZoneBmpRenderResult {
  bytes: Uint8Array;
  mimeType: "image/bmp";
  suggestedFileName: string;
  width: number;
  height: number;
  bitsPerPixel: SafeZoneBmpBitDepth;
  rowStride: number;
  pixelDataOffset: number;
  byteLength: number;
  safeRectPixels: Readonly<{ x: number; y: number; width: number; height: number }>;
  removalWarningRendered: boolean;
  /** A guide is an editing aid and must never remain enabled in the final export. */
  removeBeforeExport: true;
}

export const MAX_SAFE_ZONE_BMP_DIMENSION = 16_384;
export const MAX_SAFE_ZONE_BMP_PIXELS = 16_777_216;
export const MAX_SAFE_ZONE_BMP_BYTES = 80 * 1024 * 1024;

/**
 * 플랫폼 UI는 수시로 바뀌므로, 아래 값은 9:16 기준의 보수적인 편집 가이드입니다.
 * UI에서 사용자 지정이 가능하도록 revision을 함께 보관하며 공식 픽셀 규격으로 간주하지 않습니다.
 */
export const SAFE_ZONE_PROFILES: Readonly<Record<SocialPlatform, SafeZoneProfile>> = Object.freeze({
  "youtube-shorts": Object.freeze({
    id: "youtube-shorts",
    label: "YouTube Shorts",
    revision: "2026-conservative",
    contentMargins: Object.freeze({ top: 0.07, right: 0.17, bottom: 0.18, left: 0.055 }),
    captionMargins: Object.freeze({ top: 0.12, right: 0.18, bottom: 0.22, left: 0.07 }),
  }),
  "instagram-reels": Object.freeze({
    id: "instagram-reels",
    label: "Instagram Reels",
    revision: "2026-conservative",
    contentMargins: Object.freeze({ top: 0.08, right: 0.15, bottom: 0.2, left: 0.055 }),
    captionMargins: Object.freeze({ top: 0.12, right: 0.16, bottom: 0.24, left: 0.07 }),
  }),
  tiktok: Object.freeze({
    id: "tiktok",
    label: "TikTok",
    revision: "2026-conservative",
    contentMargins: Object.freeze({ top: 0.09, right: 0.19, bottom: 0.22, left: 0.06 }),
    captionMargins: Object.freeze({ top: 0.13, right: 0.2, bottom: 0.26, left: 0.075 }),
  }),
});

function number(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function precise(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function profileFor(platform: SocialPlatform): SafeZoneProfile {
  const profile = SAFE_ZONE_PROFILES[platform];
  if (!profile) throw new RangeError(`지원하지 않는 플랫폼 Safe Zone입니다: ${String(platform)}`);
  return profile;
}

function assertRole(role: unknown): asserts role is "content" | "caption" {
  if (role !== "content" && role !== "caption") {
    throw new RangeError(`지원하지 않는 Safe Zone 역할입니다: ${String(role)}`);
  }
}

function strictRect(value: unknown, label = "Safe Zone 요소"): NormalizedRect {
  if (!value || typeof value !== "object") throw new RangeError(`${label} rect가 필요합니다.`);
  const rect = value as Record<string, unknown>;
  if (![rect.x, rect.y, rect.width, rect.height].every((item) => typeof item === "number" && Number.isFinite(item))) {
    throw new RangeError(`${label} rect에는 유한한 숫자 x, y, width, height가 필요합니다.`);
  }
  const x = rect.x as number;
  const y = rect.y as number;
  const width = rect.width as number;
  const height = rect.height as number;
  if (width <= 0 || height <= 0) throw new RangeError(`${label} rect의 너비와 높이는 0보다 커야 합니다.`);
  if (Math.abs(x) > 10 || Math.abs(y) > 10 || width > 10 || height > 10) {
    throw new RangeError(`${label} rect가 정규화 좌표 안전 범위를 벗어났습니다.`);
  }
  return Object.freeze({ x: precise(x), y: precise(y), width: precise(width), height: precise(height) });
}

export function normalizeRect(value: Partial<NormalizedRect>): NormalizedRect {
  const x = clamp(number(value.x));
  const y = clamp(number(value.y));
  const width = clamp(number(value.width));
  const height = clamp(number(value.height));
  return Object.freeze({
    x,
    y,
    width: precise(Math.min(width, 1 - x)),
    height: precise(Math.min(height, 1 - y)),
  });
}

export function normalizeMargins(
  value: Partial<SafeZoneMargins>,
  fallback: SafeZoneMargins,
): SafeZoneMargins {
  if (!value || typeof value !== "object") throw new RangeError("Safe Zone margin 객체가 필요합니다.");
  const read = (key: keyof SafeZoneMargins): number => {
    const candidate = value[key];
    if (candidate === undefined) return fallback[key];
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0 || candidate > 0.45) {
      throw new RangeError(`Safe Zone ${key} margin은 0 이상 0.45 이하의 유한한 숫자여야 합니다.`);
    }
    return candidate;
  };
  const margins = { top: read("top"), right: read("right"), bottom: read("bottom"), left: read("left") };
  if (margins.left + margins.right >= 0.85) {
    throw new RangeError("Safe Zone 좌우 margin 합은 0.85보다 작아야 합니다.");
  }
  if (margins.top + margins.bottom >= 0.85) {
    throw new RangeError("Safe Zone 상하 margin 합은 0.85보다 작아야 합니다.");
  }
  return Object.freeze(margins);
}

export function safeContentRect(
  platform: SocialPlatform,
  role: "content" | "caption" = "content",
  customMargins?: Partial<SafeZoneMargins>,
): NormalizedRect {
  const profile = profileFor(platform);
  assertRole(role);
  const base = role === "caption" ? profile.captionMargins : profile.contentMargins;
  const margins = customMargins ? normalizeMargins(customMargins, base) : base;
  return Object.freeze({
    x: margins.left,
    y: margins.top,
    width: 1 - margins.left - margins.right,
    height: 1 - margins.top - margins.bottom,
  });
}

export function safeZoneGuideLabel(platform: SocialPlatform, role: "content" | "caption" = "content"): string {
  const profile = profileFor(platform);
  assertRole(role);
  const roleLabel = role === "caption" ? "자막" : "콘텐츠";
  return `${profile.label} ${roleLabel} Safe Zone · ${profile.revision} · 보수적 가이드`;
}

function intersectionArea(left: NormalizedRect, right: NormalizedRect): number {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return width * height;
}

export function assessSafeZone(
  element: Partial<NormalizedRect>,
  platform: SocialPlatform,
  role: "content" | "caption" = "content",
  customMargins?: Partial<SafeZoneMargins>,
): SafeZoneAssessment {
  const rect = strictRect(element);
  const safe = safeContentRect(platform, role, customMargins);
  const overflow = Object.freeze({
    top: Math.max(0, safe.y - rect.y),
    left: Math.max(0, safe.x - rect.x),
    right: Math.max(0, rect.x + rect.width - (safe.x + safe.width)),
    bottom: Math.max(0, rect.y + rect.height - (safe.y + safe.height)),
  });
  const area = rect.width * rect.height;
  const overlapRatio = area > 0 ? clamp(intersectionArea(rect, safe) / area) : 0;
  const inside = area > 0 && Object.values(overflow).every((value) => value <= 1e-9);
  return { platform, role, safeRect: safe, elementRect: rect, inside, overflow, overlapRatio };
}

export function alignToSafeZone(
  element: Partial<NormalizedRect>,
  platform: SocialPlatform,
  role: "content" | "caption" = "content",
  customMargins?: Partial<SafeZoneMargins>,
): SafeZoneAlignment {
  const original = strictRect(element);
  const safe = safeContentRect(platform, role, customMargins);
  const scale = Math.min(1, safe.width / original.width, safe.height / original.height);
  const width = original.width * scale;
  const height = original.height * scale;
  const maximumX = safe.x + safe.width - width;
  const maximumY = safe.y + safe.height - height;
  const originalCenterX = original.x + original.width / 2;
  const originalCenterY = original.y + original.height / 2;
  const x = clamp(originalCenterX - width / 2, safe.x, maximumX);
  const y = clamp(originalCenterY - height / 2, safe.y, maximumY);
  const rect = Object.freeze({ x: precise(x), y: precise(y), width: precise(width), height: precise(height) });
  const deltaX = precise(rect.x + rect.width / 2 - originalCenterX);
  const deltaY = precise(rect.y + rect.height / 2 - originalCenterY);
  return {
    rect,
    deltaX,
    deltaY,
    scale: precise(scale),
    changed: Math.abs(deltaX) > 1e-9 || Math.abs(deltaY) > 1e-9 || scale < 1 - 1e-9,
    wasOversized: scale < 1 - 1e-9,
  };
}

export function assertSafeZoneAlignment(
  value: unknown,
  platform: SocialPlatform,
  role: "content" | "caption" = "content",
  customMargins?: Partial<SafeZoneMargins>,
): SafeZoneAlignment {
  profileFor(platform);
  assertRole(role);
  if (!value || typeof value !== "object") throw new RangeError("Safe Zone alignment 객체가 필요합니다.");
  const input = value as Record<string, unknown>;
  const rect = strictRect(input.rect, "Safe Zone alignment");
  const deltaX = input.deltaX;
  const deltaY = input.deltaY;
  const scale = input.scale;
  if (
    typeof deltaX !== "number" || !Number.isFinite(deltaX) || Math.abs(deltaX) > 2 ||
    typeof deltaY !== "number" || !Number.isFinite(deltaY) || Math.abs(deltaY) > 2 ||
    typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0 || scale > 1 ||
    typeof input.changed !== "boolean" || typeof input.wasOversized !== "boolean"
  ) {
    throw new RangeError("Safe Zone alignment의 delta, scale 또는 상태 값이 올바르지 않습니다.");
  }
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > 1 + 1e-9 || rect.y + rect.height > 1 + 1e-9) {
    throw new RangeError("Safe Zone alignment 결과 rect가 출력 프레임을 벗어났습니다.");
  }
  if (!assessSafeZone(rect, platform, role, customMargins).inside) {
    throw new RangeError("Safe Zone alignment 결과 rect가 요청한 안전영역 안에 있지 않습니다.");
  }
  const resized = scale < 1 - 1e-9;
  const changed = Math.abs(deltaX) > 1e-9 || Math.abs(deltaY) > 1e-9 || resized;
  if (input.wasOversized !== resized || input.changed !== changed) {
    throw new RangeError("Safe Zone alignment 상태 플래그가 delta와 scale에 일치하지 않습니다.");
  }
  return Object.freeze({ rect, deltaX: precise(deltaX), deltaY: precise(deltaY), scale: precise(scale), changed, wasOversized: resized });
}

export function pixelRectToNormalized(
  rect: { x: number; y: number; width: number; height: number },
  frameWidth: number,
  frameHeight: number,
): NormalizedRect {
  const width = number(frameWidth);
  const height = number(frameHeight);
  if (width <= 0 || height <= 0) throw new RangeError("프레임 크기는 0보다 커야 합니다.");
  if (!rect || typeof rect !== "object" || ![rect.x, rect.y, rect.width, rect.height].every((item) => typeof item === "number" && Number.isFinite(item)) || rect.width <= 0 || rect.height <= 0) {
    throw new RangeError("픽셀 rect에는 유한한 숫자 좌표와 0보다 큰 크기가 필요합니다.");
  }
  return normalizeRect({
    x: number(rect.x) / width,
    y: number(rect.y) / height,
    width: number(rect.width) / width,
    height: number(rect.height) / height,
  });
}

export function normalizedRectToPixels(
  rect: Partial<NormalizedRect>,
  frameWidth: number,
  frameHeight: number,
): { x: number; y: number; width: number; height: number } {
  const width = number(frameWidth);
  const height = number(frameHeight);
  if (width <= 0 || height <= 0) throw new RangeError("프레임 크기는 0보다 커야 합니다.");
  const normalized = strictRect(rect);
  return Object.freeze({
    x: normalized.x * width,
    y: normalized.y * height,
    width: normalized.width * width,
    height: normalized.height * height,
  });
}

interface BgraColor {
  b: number;
  g: number;
  r: number;
  a: number;
}

interface BmpLayout {
  width: number;
  height: number;
  bitsPerPixel: SafeZoneBmpBitDepth;
  bytesPerPixel: 3 | 4;
  rowStride: number;
  pixelDataOffset: number;
  pixelBytes: number;
  fileBytes: number;
}

const PLATFORM_GUIDE_COLORS: Readonly<Record<SocialPlatform, BgraColor>> = Object.freeze({
  "youtube-shorts": Object.freeze({ b: 58, g: 58, r: 255, a: 235 }),
  "instagram-reels": Object.freeze({ b: 204, g: 64, r: 255, a: 235 }),
  tiktok: Object.freeze({ b: 218, g: 232, r: 50, a: 235 }),
});

const REMOVAL_WARNING_COLOR: BgraColor = Object.freeze({ b: 32, g: 56, r: 255, a: 245 });
const REMOVAL_WARNING_CONTRAST: BgraColor = Object.freeze({ b: 245, g: 245, r: 245, a: 230 });

function requirePositiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label}은 1 이상의 안전한 정수여야 합니다.`);
  }
  return value;
}

function checkedProduct(left: number, right: number, label: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result)) throw new RangeError(`${label} 계산이 안전한 정수 범위를 벗어났습니다.`);
  return result;
}

function resolveTightenedLimit(value: unknown, builtIn: number, label: string): number {
  if (value === undefined) return builtIn;
  const limit = requirePositiveSafeInteger(value, label);
  if (limit > builtIn) {
    throw new RangeError(`${label}은 내장 안전 상한 ${builtIn.toLocaleString("en-US")}을 초과할 수 없습니다.`);
  }
  return limit;
}

function bmpLayout(options: SafeZoneBmpRenderOptions): BmpLayout {
  const width = requirePositiveSafeInteger(options.width, "BMP 너비");
  const height = requirePositiveSafeInteger(options.height, "BMP 높이");
  if (width > MAX_SAFE_ZONE_BMP_DIMENSION || height > MAX_SAFE_ZONE_BMP_DIMENSION) {
    throw new RangeError(`BMP 너비와 높이는 각각 ${MAX_SAFE_ZONE_BMP_DIMENSION.toLocaleString("en-US")}픽셀 이하여야 합니다.`);
  }
  const bitsPerPixel = options.bitsPerPixel ?? 32;
  if (bitsPerPixel !== 24 && bitsPerPixel !== 32) {
    throw new RangeError("Safe Zone BMP 비트 깊이는 24 또는 32여야 합니다.");
  }
  const bytesPerPixel = bitsPerPixel === 32 ? 4 : 3;
  const maxPixels = resolveTightenedLimit(options.maxPixels, MAX_SAFE_ZONE_BMP_PIXELS, "BMP 최대 픽셀 수");
  const pixels = checkedProduct(width, height, "BMP 픽셀 수");
  if (pixels > maxPixels) {
    throw new RangeError(`BMP 픽셀 수 ${pixels.toLocaleString("en-US")}가 안전 상한 ${maxPixels.toLocaleString("en-US")}을 초과합니다.`);
  }
  const rawRowBytes = checkedProduct(width, bytesPerPixel, "BMP 행 바이트 수");
  const rowStride = Math.ceil(rawRowBytes / 4) * 4;
  if (!Number.isSafeInteger(rowStride)) throw new RangeError("BMP 행 정렬 바이트 계산이 안전 범위를 벗어났습니다.");
  const pixelBytes = checkedProduct(rowStride, height, "BMP 픽셀 바이트 수");
  // BITMAPV4HEADER declares explicit BGRA masks for alpha-capable 32-bit guides.
  const pixelDataOffset = 14 + (bitsPerPixel === 32 ? 108 : 40);
  const fileBytes = pixelDataOffset + pixelBytes;
  const maxBytes = resolveTightenedLimit(options.maxBytes, MAX_SAFE_ZONE_BMP_BYTES, "BMP 최대 바이트 수");
  if (!Number.isSafeInteger(fileBytes) || fileBytes > 0xffff_ffff || fileBytes > maxBytes) {
    throw new RangeError(`BMP 출력 크기 ${fileBytes.toLocaleString("en-US")}바이트가 안전 상한 ${maxBytes.toLocaleString("en-US")}바이트를 초과합니다.`);
  }
  return { width, height, bitsPerPixel, bytesPerPixel, rowStride, pixelDataOffset, pixelBytes, fileBytes };
}

function writeBmpHeader(bytes: Uint8Array, layout: BmpLayout): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  bytes[0] = 0x42;
  bytes[1] = 0x4d;
  view.setUint32(2, layout.fileBytes, true);
  view.setUint32(10, layout.pixelDataOffset, true);
  const dibSize = layout.bitsPerPixel === 32 ? 108 : 40;
  view.setUint32(14, dibSize, true);
  view.setInt32(18, layout.width, true);
  // Positive height intentionally writes bottom-up rows for broad BMP compatibility.
  view.setInt32(22, layout.height, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, layout.bitsPerPixel, true);
  view.setUint32(30, layout.bitsPerPixel === 32 ? 3 : 0, true);
  view.setUint32(34, layout.pixelBytes, true);
  view.setInt32(38, 2_835, true);
  view.setInt32(42, 2_835, true);
  if (layout.bitsPerPixel === 32) {
    view.setUint32(54, 0x00ff_0000, true);
    view.setUint32(58, 0x0000_ff00, true);
    view.setUint32(62, 0x0000_00ff, true);
    view.setUint32(66, 0xff00_0000, true);
    view.setUint32(70, 0x7352_4742, true); // LCS_sRGB
  }
}

function pixelOffset(layout: BmpLayout, x: number, y: number): number {
  const bmpRow = layout.height - 1 - y;
  return layout.pixelDataOffset + bmpRow * layout.rowStride + x * layout.bytesPerPixel;
}

function writePixel(bytes: Uint8Array, layout: BmpLayout, x: number, y: number, color: BgraColor): void {
  if (x < 0 || y < 0 || x >= layout.width || y >= layout.height) return;
  const offset = pixelOffset(layout, x, y);
  bytes[offset] = color.b;
  bytes[offset + 1] = color.g;
  bytes[offset + 2] = color.r;
  if (layout.bytesPerPixel === 4) bytes[offset + 3] = color.a;
}

function drawSquare(
  bytes: Uint8Array,
  layout: BmpLayout,
  centerX: number,
  centerY: number,
  radius: number,
  color: BgraColor,
): void {
  for (let y = centerY - radius; y <= centerY + radius; y += 1) {
    for (let x = centerX - radius; x <= centerX + radius; x += 1) writePixel(bytes, layout, x, y, color);
  }
}

function drawLine(
  bytes: Uint8Array,
  layout: BmpLayout,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  thickness: number,
  color: BgraColor,
): void {
  const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), 1);
  const radius = Math.max(0, Math.floor((thickness - 1) / 2));
  for (let step = 0; step <= steps; step += 1) {
    const progress = step / steps;
    drawSquare(
      bytes,
      layout,
      Math.round(x1 + (x2 - x1) * progress),
      Math.round(y1 + (y2 - y1) * progress),
      radius,
      color,
    );
  }
}

function normalizedGuideRect(rect: NormalizedRect, layout: BmpLayout): Readonly<{ x: number; y: number; width: number; height: number }> {
  const lastX = layout.width - 1;
  const lastY = layout.height - 1;
  const left = Math.max(0, Math.min(lastX, Math.round(rect.x * lastX)));
  const top = Math.max(0, Math.min(lastY, Math.round(rect.y * lastY)));
  const right = Math.max(left, Math.min(lastX, Math.round((rect.x + rect.width) * lastX)));
  const bottom = Math.max(top, Math.min(lastY, Math.round((rect.y + rect.height) * lastY)));
  return Object.freeze({ x: left, y: top, width: right - left + 1, height: bottom - top + 1 });
}

function drawSafeRect(
  bytes: Uint8Array,
  layout: BmpLayout,
  rect: Readonly<{ x: number; y: number; width: number; height: number }>,
  color: BgraColor,
  role: "content" | "caption",
): void {
  const right = rect.x + rect.width - 1;
  const bottom = rect.y + rect.height - 1;
  const thickness = Math.max(1, Math.min(8, Math.round(Math.min(layout.width, layout.height) / 360)));
  const dash = Math.max(6, Math.round(Math.min(layout.width, layout.height) / 48));
  const gap = Math.max(4, Math.round(dash * 0.55));
  const visible = (offset: number): boolean => role === "content" || offset % (dash + gap) < dash;
  for (let inset = 0; inset < thickness; inset += 1) {
    for (let x = rect.x; x <= right; x += 1) {
      if (visible(x - rect.x)) {
        writePixel(bytes, layout, x, rect.y + inset, color);
        writePixel(bytes, layout, x, bottom - inset, color);
      }
    }
    for (let y = rect.y; y <= bottom; y += 1) {
      if (visible(y - rect.y)) {
        writePixel(bytes, layout, rect.x + inset, y, color);
        writePixel(bytes, layout, right - inset, y, color);
      }
    }
  }
}

function drawRemovalWarning(bytes: Uint8Array, layout: BmpLayout): void {
  const minimum = Math.min(layout.width, layout.height);
  const thickness = Math.max(2, Math.min(10, Math.round(minimum / 240)));
  const segment = Math.max(8, Math.round(minimum / 32));
  const colorAt = (position: number): BgraColor =>
    Math.floor(position / segment) % 2 === 0 ? REMOVAL_WARNING_COLOR : REMOVAL_WARNING_CONTRAST;
  for (let inset = 0; inset < thickness; inset += 1) {
    for (let x = inset; x < layout.width - inset; x += 1) {
      const color = colorAt(x);
      writePixel(bytes, layout, x, inset, color);
      writePixel(bytes, layout, x, layout.height - 1 - inset, color);
    }
    for (let y = inset; y < layout.height - inset; y += 1) {
      const color = colorAt(y);
      writePixel(bytes, layout, inset, y, color);
      writePixel(bytes, layout, layout.width - 1 - inset, y, color);
    }
  }
  const crossSize = Math.max(8, Math.min(64, Math.round(minimum / 22)));
  const margin = thickness + Math.max(3, Math.round(crossSize / 4));
  const rightStart = layout.width - 1 - margin - crossSize;
  for (const startX of [margin, rightStart]) {
    drawLine(bytes, layout, startX, margin, startX + crossSize, margin + crossSize, thickness, REMOVAL_WARNING_COLOR);
    drawLine(bytes, layout, startX + crossSize, margin, startX, margin + crossSize, thickness, REMOVAL_WARNING_COLOR);
  }
}

/**
 * Renders a deterministic, dependency-free BMP suitable for writing through a UXP file handle.
 * The logical drawing origin is top-left even though BMP rows are encoded bottom-up.
 */
export function renderSafeZoneGuideBmp(options: SafeZoneBmpRenderOptions): SafeZoneBmpRenderResult {
  if (!options || typeof options !== "object") throw new RangeError("Safe Zone BMP 렌더 옵션 객체가 필요합니다.");
  const role = options.role ?? "content";
  const profile = profileFor(options.platform);
  assertRole(role);
  if (options.includeRemovalWarning !== undefined && typeof options.includeRemovalWarning !== "boolean") {
    throw new RangeError("Safe Zone BMP 삭제 경고 옵션은 불리언이어야 합니다.");
  }
  const layout = bmpLayout(options);
  const safeRect = safeContentRect(options.platform, role, options.customMargins);
  const safeRectPixels = normalizedGuideRect(safeRect, layout);
  const bytes = new Uint8Array(layout.fileBytes);
  writeBmpHeader(bytes, layout);
  drawSafeRect(bytes, layout, safeRectPixels, PLATFORM_GUIDE_COLORS[profile.id], role);
  const removalWarningRendered = options.includeRemovalWarning !== false;
  if (removalWarningRendered) drawRemovalWarning(bytes, layout);
  return Object.freeze({
    bytes,
    mimeType: "image/bmp" as const,
    suggestedFileName: `shortflow-safe-zone-${profile.id}-${role}-${layout.width}x${layout.height}.bmp`,
    width: layout.width,
    height: layout.height,
    bitsPerPixel: layout.bitsPerPixel,
    rowStride: layout.rowStride,
    pixelDataOffset: layout.pixelDataOffset,
    byteLength: layout.fileBytes,
    safeRectPixels,
    removalWarningRendered,
    removeBeforeExport: true as const,
  });
}
