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
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function precise(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
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
  const margins = {
    top: clamp(number(value.top, fallback.top), 0, 0.45),
    right: clamp(number(value.right, fallback.right), 0, 0.45),
    bottom: clamp(number(value.bottom, fallback.bottom), 0, 0.45),
    left: clamp(number(value.left, fallback.left), 0, 0.45),
  };
  if (margins.left + margins.right >= 0.85) {
    margins.left = fallback.left;
    margins.right = fallback.right;
  }
  if (margins.top + margins.bottom >= 0.85) {
    margins.top = fallback.top;
    margins.bottom = fallback.bottom;
  }
  return Object.freeze(margins);
}

export function safeContentRect(
  platform: SocialPlatform,
  role: "content" | "caption" = "content",
  customMargins?: Partial<SafeZoneMargins>,
): NormalizedRect {
  const profile = SAFE_ZONE_PROFILES[platform];
  if (!profile) throw new RangeError(`지원하지 않는 플랫폼 Safe Zone입니다: ${String(platform)}`);
  const base = role === "caption" ? profile.captionMargins : profile.contentMargins;
  const margins = customMargins ? normalizeMargins(customMargins, base) : base;
  return Object.freeze({
    x: margins.left,
    y: margins.top,
    width: 1 - margins.left - margins.right,
    height: 1 - margins.top - margins.bottom,
  });
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
  const rect = normalizeRect(element);
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
  const original = normalizeRect(element);
  const safe = safeContentRect(platform, role, customMargins);
  if (original.width <= 0 || original.height <= 0) {
    return { rect: original, deltaX: 0, deltaY: 0, scale: 1, changed: false, wasOversized: false };
  }
  const scale = Math.min(1, safe.width / original.width, safe.height / original.height);
  const width = original.width * scale;
  const height = original.height * scale;
  const maximumX = safe.x + safe.width - width;
  const maximumY = safe.y + safe.height - height;
  const x = clamp(original.x, safe.x, maximumX);
  const y = clamp(original.y, safe.y, maximumY);
  const rect = Object.freeze({ x, y, width, height });
  return {
    rect,
    deltaX: x - original.x,
    deltaY: y - original.y,
    scale,
    changed: Math.abs(x - original.x) > 1e-9 || Math.abs(y - original.y) > 1e-9 || scale < 1 - 1e-9,
    wasOversized: scale < 1 - 1e-9,
  };
}

export function pixelRectToNormalized(
  rect: { x: number; y: number; width: number; height: number },
  frameWidth: number,
  frameHeight: number,
): NormalizedRect {
  const width = number(frameWidth);
  const height = number(frameHeight);
  if (width <= 0 || height <= 0) throw new RangeError("프레임 크기는 0보다 커야 합니다.");
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
  const normalized = normalizeRect(rect);
  return Object.freeze({
    x: normalized.x * width,
    y: normalized.y * height,
    width: normalized.width * width,
    height: normalized.height * height,
  });
}
