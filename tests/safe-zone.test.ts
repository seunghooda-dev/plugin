import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_SAFE_ZONE_BMP_BYTES,
  MAX_SAFE_ZONE_BMP_DIMENSION,
  MAX_SAFE_ZONE_BMP_PIXELS,
  SAFE_ZONE_PROFILES,
  alignToSafeZone,
  assertSafeZoneAlignment,
  assessSafeZone,
  normalizeMargins,
  normalizeRect,
  normalizedRectToPixels,
  pixelRectToNormalized,
  renderSafeZoneGuideBmp,
  safeContentRect,
  safeZoneGuideLabel,
  type SafeZoneBmpRenderResult,
} from "../src/safe-zone";

function bmpView(result: SafeZoneBmpRenderResult): DataView {
  return new DataView(result.bytes.buffer, result.bytes.byteOffset, result.bytes.byteLength);
}

function logicalPixel(result: SafeZoneBmpRenderResult, x: number, y: number): number[] {
  const bytesPerPixel = result.bitsPerPixel / 8;
  const offset = result.pixelDataOffset + (result.height - 1 - y) * result.rowStride + x * bytesPerPixel;
  return Array.from(result.bytes.slice(offset, offset + bytesPerPixel));
}

describe("safe-zone profiles", () => {
  it("publishes conservative presets for all three platforms", () => {
    assert.deepEqual(Object.keys(SAFE_ZONE_PROFILES).sort(), [
      "instagram-reels", "tiktok", "youtube-shorts",
    ]);
    for (const profile of Object.values(SAFE_ZONE_PROFILES)) {
      assert.match(profile.revision, /conservative/u);
      assert.ok(profile.captionMargins.bottom >= profile.contentMargins.bottom);
      assert.ok(profile.captionMargins.right >= profile.contentMargins.right);
    }
  });

  it("returns a smaller caption region than general content", () => {
    const content = safeContentRect("youtube-shorts", "content");
    const caption = safeContentRect("youtube-shorts", "caption");
    assert.ok(caption.width < content.width);
    assert.ok(caption.height < content.height);
  });

  it("builds user-visible guide labels with platform, role, and revision", () => {
    assert.equal(
      safeZoneGuideLabel("instagram-reels", "caption"),
      "Instagram Reels 자막 Safe Zone · 2026-conservative · 보수적 가이드",
    );
  });

  it("rejects an unknown platform", () => {
    assert.throws(() => safeContentRect("unknown" as never), /지원하지/u);
    assert.throws(() => safeZoneGuideLabel("unknown" as never), /지원하지/u);
  });

  it("labels the default content role", () => {
    assert.equal(
      safeZoneGuideLabel("youtube-shorts"),
      "YouTube Shorts 콘텐츠 Safe Zone · 2026-conservative · 보수적 가이드",
    );
  });

  it("merges partial custom margins with the selected role baseline", () => {
    const margins = SAFE_ZONE_PROFILES.tiktok.captionMargins;
    const rect = safeContentRect("tiktok", "caption", { bottom: 0 });
    assert.equal(rect.x, margins.left);
    assert.equal(rect.y, margins.top);
    assert.equal(rect.width, 1 - margins.left - margins.right);
    assert.equal(rect.height, 1 - margins.top);
  });

  it("supports slider extremes from zero to the 0.45 margin cap", () => {
    const full = safeContentRect("youtube-shorts", "content", { top: 0, right: 0, bottom: 0, left: 0 });
    assert.deepEqual(full, { x: 0, y: 0, width: 1, height: 1 });
    const tight = safeContentRect("youtube-shorts", "content", { top: 0.45, right: 0.45, bottom: 0.25, left: 0.25 });
    assert.ok(Math.abs(tight.width - 0.3) <= 1e-12);
    assert.ok(Math.abs(tight.height - 0.3) <= 1e-12);
    assert.throws(() => safeContentRect("youtube-shorts", "content", { top: 0.46 }), /margin/u);
  });
});

describe("safe-zone normalization", () => {
  it("clamps rectangles to the normalized canvas", () => {
    assert.deepEqual(normalizeRect({ x: -1, y: 0.8, width: 2, height: 0.5 }), {
      x: 0, y: 0.8, width: 1, height: 0.2,
    });
  });

  it("rejects impossible or malformed custom margins", () => {
    const fallback = SAFE_ZONE_PROFILES.tiktok.contentMargins;
    assert.throws(() => normalizeMargins({ left: 0.45, right: 0.45 }, fallback), /합/u);
    assert.throws(() => normalizeMargins({ left: -0.1 }, fallback), /margin/u);
    assert.throws(() => normalizeMargins({ left: "0.1" as unknown as number }, fallback), /margin/u);
  });

  it("round-trips pixel and normalized rectangles", () => {
    const normalized = pixelRectToNormalized({ x: 108, y: 192, width: 540, height: 960 }, 1080, 1920);
    assert.deepEqual(normalized, { x: 0.1, y: 0.1, width: 0.5, height: 0.5 });
    assert.deepEqual(normalizedRectToPixels(normalized, 1080, 1920), {
      x: 108, y: 192, width: 540, height: 960,
    });
  });

  it("rejects an invalid frame size", () => {
    assert.throws(() => pixelRectToNormalized({ x: 0, y: 0, width: 1, height: 1 }, 0, 100));
    assert.throws(() => normalizedRectToPixels({ x: 0, y: 0, width: 1, height: 1 }, 100, 0));
  });

  it("round-trips fractional coordinates within nanounit precision", () => {
    const source = { x: 0.123456789, y: 0.234567891, width: 0.345678912, height: 0.456789123 };
    const pixels = normalizedRectToPixels(source, 1080, 1920);
    const roundTrip = pixelRectToNormalized(pixels, 1080, 1920);
    for (const key of ["x", "y", "width", "height"] as const) {
      assert.ok(Math.abs(roundTrip[key] - source[key]) <= 1e-9);
    }
  });

  it("treats missing or non-finite normalized fields as zero", () => {
    assert.deepEqual(normalizeRect({}), { x: 0, y: 0, width: 0, height: 0 });
    assert.deepEqual(
      normalizeRect({ x: 0.75, width: 0.5, height: Number.NaN }),
      { x: 0.75, y: 0, width: 0.25, height: 0 },
    );
  });

  it("requires both margin sums to stay below 0.85", () => {
    const fallback = SAFE_ZONE_PROFILES.tiktok.contentMargins;
    assert.throws(() => normalizeMargins({ top: 0.45, bottom: 0.4 }, fallback), /상하/u);
    assert.deepEqual(
      normalizeMargins({ top: 0.45, bottom: 0.39 }, fallback),
      { top: 0.45, right: fallback.right, bottom: 0.39, left: fallback.left },
    );
    assert.throws(() => normalizeMargins(null as never, fallback), /객체/u);
  });

  it("clamps pixel rects that overflow the frame and rejects malformed pixel rects", () => {
    assert.deepEqual(
      pixelRectToNormalized({ x: 540, y: 0, width: 1080, height: 1920 }, 1080, 1920),
      { x: 0.5, y: 0, width: 0.5, height: 1 },
    );
    assert.throws(() => pixelRectToNormalized({ x: 0, y: 0, width: 0, height: 10 }, 100, 100), /픽셀 rect/u);
    assert.throws(() => pixelRectToNormalized({ x: Number.NaN, y: 0, width: 10, height: 10 }, 100, 100), /픽셀 rect/u);
    assert.throws(() => normalizedRectToPixels({ x: 11, y: 0, width: 1, height: 1 }, 100, 100), /안전 범위/u);
  });
});

describe("safe-zone assessment", () => {
  it("passes an element fully inside the safe area", () => {
    const result = assessSafeZone({ x: 0.2, y: 0.2, width: 0.4, height: 0.3 }, "tiktok");
    assert.equal(result.inside, true);
    assert.equal(result.overlapRatio, 1);
    assert.deepEqual(result.overflow, { top: 0, right: 0, bottom: 0, left: 0 });
  });

  it("reports right and bottom platform UI collisions", () => {
    const result = assessSafeZone({ x: 0.7, y: 0.75, width: 0.25, height: 0.2 }, "tiktok", "caption");
    assert.equal(result.inside, false);
    assert.ok(result.overflow.right > 0);
    assert.ok(result.overflow.bottom > 0);
    assert.ok(result.overlapRatio < 1);
  });

  it("does not treat a zero-area box as safe", () => {
    assert.throws(() => assessSafeZone({ x: 0.2, y: 0.2, width: 0, height: 0 }, "youtube-shorts"), /0보다/u);
  });

  it("accepts exact boundary contact and reports out-of-frame geometry", () => {
    const safe = safeContentRect("youtube-shorts", "caption");
    assert.equal(assessSafeZone(safe, "youtube-shorts", "caption").inside, true);
    const outside = assessSafeZone({ x: -0.1, y: 0.2, width: 0.3, height: 0.2 }, "youtube-shorts");
    assert.equal(outside.inside, false);
    assert.ok(outside.overflow.left > 0);
  });

  it("uses strict runtime types instead of coercing strings, null, or invalid roles", () => {
    assert.throws(() => assessSafeZone({ x: "0.2" as unknown as number, y: 0.2, width: 0.2, height: 0.2 }, "tiktok"), /유한한 숫자/u);
    assert.throws(() => assessSafeZone(null as never, "tiktok"), /rect/u);
    assert.throws(() => safeContentRect("tiktok", "other" as never), /역할/u);
  });

  it("reports zero overlap for an element fully outside the safe area", () => {
    const result = assessSafeZone({ x: 0, y: 0, width: 0.05, height: 0.05 }, "tiktok");
    assert.equal(result.inside, false);
    assert.equal(result.overlapRatio, 0);
    assert.ok(result.overflow.top > 0);
    assert.ok(result.overflow.left > 0);
    assert.equal(result.overflow.right, 0);
    assert.equal(result.overflow.bottom, 0);
  });

  it("measures overlap when the element contains the entire safe area", () => {
    const safe = safeContentRect("tiktok");
    const result = assessSafeZone({ x: -1, y: -1, width: 3, height: 3 }, "tiktok");
    assert.equal(result.inside, false);
    for (const overflow of Object.values(result.overflow)) assert.ok(overflow > 0);
    assert.ok(Math.abs(result.overlapRatio - (safe.width * safe.height) / 9) <= 1e-12);
  });

  it("rejects rects outside the normalized guard range", () => {
    assert.throws(() => assessSafeZone({ x: 11, y: 0, width: 0.5, height: 0.5 }, "tiktok"), /안전 범위/u);
    assert.throws(() => assessSafeZone({ x: 0, y: 0, width: 10.5, height: 0.5 }, "tiktok"), /안전 범위/u);
  });

  it("assesses against custom margins", () => {
    const margins = { top: 0.25, right: 0.25, bottom: 0.25, left: 0.25 };
    assert.equal(assessSafeZone({ x: 0.3, y: 0.3, width: 0.4, height: 0.4 }, "tiktok", "content", margins).inside, true);
    assert.equal(assessSafeZone({ x: 0.2, y: 0.3, width: 0.4, height: 0.4 }, "tiktok", "content", margins).inside, false);
  });
});

describe("alignToSafeZone", () => {
  it("moves an overflowing caption without resizing it", () => {
    const aligned = alignToSafeZone({ x: 0.8, y: 0.8, width: 0.15, height: 0.1 }, "instagram-reels", "caption");
    assert.equal(aligned.changed, true);
    assert.equal(aligned.scale, 1);
    assert.equal(assessSafeZone(aligned.rect, "instagram-reels", "caption").inside, true);
  });

  it("scales down an oversized element proportionally", () => {
    const aligned = alignToSafeZone({ x: 0, y: 0, width: 1, height: 1 }, "tiktok", "caption");
    assert.equal(aligned.wasOversized, true);
    assert.ok(aligned.scale < 1);
    assert.equal(assessSafeZone(aligned.rect, "tiktok", "caption").inside, true);
    const originalCenter = 0.5;
    assert.ok(Math.abs((aligned.rect.x + aligned.rect.width / 2) - (originalCenter + aligned.deltaX)) <= 1e-9);
    assert.ok(Math.abs((aligned.rect.y + aligned.rect.height / 2) - (originalCenter + aligned.deltaY)) <= 1e-9);
  });

  it("leaves an already safe element unchanged", () => {
    const aligned = alignToSafeZone({ x: 0.2, y: 0.2, width: 0.2, height: 0.2 }, "youtube-shorts");
    assert.equal(aligned.changed, false);
    assert.equal(aligned.deltaX, 0);
    assert.equal(aligned.deltaY, 0);
  });

  it("rejects empty, negative-size, non-finite, and string rects", () => {
    assert.throws(() => alignToSafeZone({ x: 0, y: 0, width: 0, height: 0 }, "tiktok"), /0보다/u);
    assert.throws(() => alignToSafeZone({ x: 0, y: 0, width: -1, height: 1 }, "tiktok"), /0보다/u);
    assert.throws(() => alignToSafeZone({ x: Number.NaN, y: 0, width: 1, height: 1 }, "tiktok"), /유한한/u);
    assert.throws(() => alignToSafeZone({ x: "0" as unknown as number, y: 0, width: 1, height: 1 }, "tiktok"), /유한한/u);
  });

  it("aligns an out-of-frame rect and is idempotent", () => {
    const first = alignToSafeZone({ x: -0.25, y: 0.9, width: 0.3, height: 0.2 }, "youtube-shorts", "content");
    assert.equal(first.changed, true);
    assert.equal(assessSafeZone(first.rect, "youtube-shorts", "content").inside, true);
    const second = alignToSafeZone(first.rect, "youtube-shorts", "content");
    assert.equal(second.changed, false);
    assert.equal(second.deltaX, 0);
    assert.equal(second.deltaY, 0);
    assert.equal(second.scale, 1);
  });

  it("validates complete alignment state, platform role, and custom margins", () => {
    const margins = { top: 0.1, right: 0.1, bottom: 0.2, left: 0.1 };
    const alignment = alignToSafeZone({ x: 0.8, y: 0.8, width: 0.2, height: 0.1 }, "tiktok", "caption", margins);
    assert.deepEqual(assertSafeZoneAlignment(alignment, "tiktok", "caption", margins), alignment);
    assert.throws(() => assertSafeZoneAlignment({ ...alignment, deltaX: "0" }, "tiktok", "caption", margins), /delta/u);
    assert.throws(() => assertSafeZoneAlignment({ ...alignment, scale: -1 }, "tiktok", "caption", margins), /scale/u);
    assert.throws(() => assertSafeZoneAlignment({ ...alignment, rect: null }, "tiktok", "caption", margins), /rect/u);
  });

  it("scales an extreme wide banner down to the safe width", () => {
    const safe = safeContentRect("youtube-shorts");
    const aligned = alignToSafeZone({ x: 0, y: 0.45, width: 1, height: 0.01 }, "youtube-shorts");
    assert.equal(aligned.wasOversized, true);
    assert.ok(Math.abs(aligned.scale - safe.width) <= 1e-9);
    assert.ok(Math.abs(aligned.rect.width - safe.width) <= 1e-9);
    assert.equal(assessSafeZone(aligned.rect, "youtube-shorts").inside, true);
  });

  it("scales an extreme tall banner down to the safe height", () => {
    const safe = safeContentRect("youtube-shorts");
    const aligned = alignToSafeZone({ x: 0.48, y: 0, width: 0.04, height: 1 }, "youtube-shorts");
    assert.equal(aligned.wasOversized, true);
    assert.ok(Math.abs(aligned.scale - safe.height) <= 1e-9);
    assert.ok(Math.abs(aligned.rect.height - safe.height) <= 1e-9);
    assert.equal(assessSafeZone(aligned.rect, "youtube-shorts").inside, true);
  });

  it("keeps a full-frame element when custom margins are zero", () => {
    const margins = { top: 0, right: 0, bottom: 0, left: 0 };
    const aligned = alignToSafeZone({ x: 0, y: 0, width: 1, height: 1 }, "tiktok", "content", margins);
    assert.equal(aligned.changed, false);
    assert.equal(aligned.scale, 1);
    assert.deepEqual(aligned.rect, { x: 0, y: 0, width: 1, height: 1 });
  });

  it("rejects alignment results whose flags disagree with delta and scale", () => {
    const clean = alignToSafeZone({ x: 0.2, y: 0.2, width: 0.2, height: 0.2 }, "youtube-shorts");
    assert.throws(() => assertSafeZoneAlignment({ ...clean, changed: true }, "youtube-shorts"), /플래그/u);
    assert.throws(() => assertSafeZoneAlignment({ ...clean, wasOversized: true }, "youtube-shorts"), /플래그/u);
    assert.throws(() => assertSafeZoneAlignment({ ...clean, scale: 1.2 }, "youtube-shorts"), /올바르지/u);
    assert.throws(() => assertSafeZoneAlignment({ ...clean, deltaX: 3 }, "youtube-shorts"), /올바르지/u);
    assert.throws(() => assertSafeZoneAlignment({ ...clean, changed: "yes" }, "youtube-shorts"), /올바르지/u);
    assert.throws(() => assertSafeZoneAlignment(null, "youtube-shorts"), /객체/u);
  });

  it("rejects alignment results outside the frame or the safe area", () => {
    const shape = { deltaX: 0, deltaY: 0, scale: 1, changed: false, wasOversized: false };
    assert.throws(
      () => assertSafeZoneAlignment({ ...shape, rect: { x: 0.9, y: 0.9, width: 0.2, height: 0.2 } }, "tiktok"),
      /출력 프레임/u,
    );
    assert.throws(
      () => assertSafeZoneAlignment({ ...shape, rect: { x: 0, y: 0, width: 0.2, height: 0.2 } }, "tiktok"),
      /안전영역/u,
    );
    assert.throws(
      () => assertSafeZoneAlignment({ ...shape, rect: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 } }, "unknown" as never),
      /지원하지/u,
    );
  });
});

describe("Safe Zone BMP byte renderer", () => {
  it("renders an importable 32-bit BGRA V4 BMP at a 1080x1920 timeline size", () => {
    const result = renderSafeZoneGuideBmp({
      width: 1080,
      height: 1920,
      platform: "tiktok",
      role: "caption",
      includeRemovalWarning: false,
    });
    const view = bmpView(result);
    assert.deepEqual(Array.from(result.bytes.slice(0, 2)), [0x42, 0x4d]);
    assert.equal(view.getUint32(2, true), result.byteLength);
    assert.equal(view.getUint32(10, true), 122);
    assert.equal(view.getUint32(14, true), 108);
    assert.equal(view.getInt32(18, true), 1080);
    assert.equal(view.getInt32(22, true), 1920);
    assert.equal(view.getUint16(26, true), 1);
    assert.equal(view.getUint16(28, true), 32);
    assert.equal(view.getUint32(30, true), 3);
    assert.equal(view.getUint32(34, true), result.rowStride * result.height);
    assert.equal(view.getUint32(54, true), 0x00ff_0000);
    assert.equal(view.getUint32(58, true), 0x0000_ff00);
    assert.equal(view.getUint32(62, true), 0x0000_00ff);
    assert.equal(view.getUint32(66, true), 0xff00_0000);
    assert.equal(result.rowStride, 1080 * 4);
    assert.equal(result.byteLength, 122 + 1080 * 4 * 1920);
    assert.equal(result.mimeType, "image/bmp");
    assert.match(result.suggestedFileName, /tiktok-caption-1080x1920\.bmp$/u);
    assert.equal(result.removeBeforeExport, true);

    const border = logicalPixel(result, result.safeRectPixels.x, result.safeRectPixels.y);
    const center = logicalPixel(
      result,
      result.safeRectPixels.x + Math.floor(result.safeRectPixels.width / 2),
      result.safeRectPixels.y + Math.floor(result.safeRectPixels.height / 2),
    );
    assert.equal(border[3], 235);
    assert.equal(center[3], 0);
    const topDownOffset = result.pixelDataOffset + result.safeRectPixels.y * result.rowStride + result.safeRectPixels.x * 4;
    assert.equal(result.bytes[topDownOffset + 3], 0, "BMP 픽셀 행은 bottom-up이어야 합니다.");
  });

  it("writes a 24-bit BGR BMP with four-byte row padding", () => {
    const result = renderSafeZoneGuideBmp({
      width: 101,
      height: 67,
      platform: "youtube-shorts",
      bitsPerPixel: 24,
      includeRemovalWarning: false,
    });
    const view = bmpView(result);
    assert.equal(result.pixelDataOffset, 54);
    assert.equal(view.getUint32(14, true), 40);
    assert.equal(view.getUint16(28, true), 24);
    assert.equal(view.getUint32(30, true), 0);
    assert.equal(result.rowStride, 304);
    assert.equal(result.byteLength, 54 + 304 * 67);
    for (let row = 0; row < result.height; row += 1) {
      assert.equal(result.bytes[result.pixelDataOffset + row * result.rowStride + 303], 0);
    }
    assert.equal(logicalPixel(result, result.safeRectPixels.x, result.safeRectPixels.y).length, 3);
  });

  it("uses platform colors, a dashed caption border, and a distinct removal warning", () => {
    const base = { width: 320, height: 568, includeRemovalWarning: false } as const;
    const youtube = renderSafeZoneGuideBmp({ ...base, platform: "youtube-shorts", role: "content" });
    const tiktok = renderSafeZoneGuideBmp({ ...base, platform: "tiktok", role: "content" });
    const caption = renderSafeZoneGuideBmp({ ...base, platform: "tiktok", role: "caption" });
    const warned = renderSafeZoneGuideBmp({ ...base, platform: "tiktok", role: "content", includeRemovalWarning: true });
    const youtubeColor = logicalPixel(youtube, youtube.safeRectPixels.x, youtube.safeRectPixels.y);
    const tiktokColor = logicalPixel(tiktok, tiktok.safeRectPixels.x, tiktok.safeRectPixels.y);
    assert.notDeepEqual(youtubeColor.slice(0, 3), tiktokColor.slice(0, 3));
    assert.notDeepEqual(caption.safeRectPixels, tiktok.safeRectPixels);
    assert.equal(logicalPixel(caption, caption.safeRectPixels.x, caption.safeRectPixels.y)[3], 235);
    assert.equal(logicalPixel(caption, caption.safeRectPixels.x + 8, caption.safeRectPixels.y)[3], 0);
    assert.equal(logicalPixel(tiktok, 0, 0)[3], 0);
    const warningColor = logicalPixel(warned, 0, 0);
    assert.ok((warningColor[3] ?? 0) > 0);
    assert.notDeepEqual(warningColor.slice(0, 3), tiktokColor.slice(0, 3));
    assert.equal(warned.removalWarningRendered, true);
    assert.equal(tiktok.removalWarningRendered, false);
  });

  it("is deterministic and does not mutate custom margins", () => {
    const customMargins = { top: 0.1, right: 0.2, bottom: 0.25, left: 0.08 };
    const snapshot = { ...customMargins };
    const options = {
      width: 160,
      height: 284,
      platform: "instagram-reels" as const,
      role: "caption" as const,
      customMargins,
    };
    const first = renderSafeZoneGuideBmp(options);
    const second = renderSafeZoneGuideBmp(options);
    assert.deepEqual(first.bytes, second.bytes);
    assert.deepEqual(customMargins, snapshot);
  });

  it("rejects unsafe dimensions, pixel counts, byte counts, and bit depths before allocation", () => {
    const base = { width: 1080, height: 1920, platform: "tiktok" as const };
    assert.throws(
      () => renderSafeZoneGuideBmp({ ...base, width: MAX_SAFE_ZONE_BMP_DIMENSION + 1 }),
      /각각/u,
    );
    assert.throws(() => renderSafeZoneGuideBmp({ ...base, width: 1.5 }), /안전한 정수/u);
    assert.throws(
      () => renderSafeZoneGuideBmp({ ...base, maxPixels: base.width * base.height - 1 }),
      /픽셀 수/u,
    );
    assert.throws(
      () => renderSafeZoneGuideBmp({ width: 10, height: 10, platform: "tiktok", maxBytes: 521 }),
      /출력 크기/u,
    );
    assert.throws(
      () => renderSafeZoneGuideBmp({ ...base, maxPixels: MAX_SAFE_ZONE_BMP_PIXELS + 1 }),
      /내장 안전 상한/u,
    );
    assert.throws(
      () => renderSafeZoneGuideBmp({ ...base, maxBytes: MAX_SAFE_ZONE_BMP_BYTES + 1 }),
      /내장 안전 상한/u,
    );
    assert.throws(
      () => renderSafeZoneGuideBmp({ ...base, bitsPerPixel: 16 as never }),
      /24 또는 32/u,
    );
  });

  it("survives one-pixel and stride-padded tiny canvases", () => {
    const single = renderSafeZoneGuideBmp({ width: 1, height: 1, platform: "tiktok" });
    assert.deepEqual(single.safeRectPixels, { x: 0, y: 0, width: 1, height: 1 });
    assert.equal(single.rowStride, 4);
    assert.equal(single.byteLength, 122 + 4);
    assert.equal(single.removalWarningRendered, true);
    assert.equal(logicalPixel(single, 0, 0)[3], 245);
    const padded = renderSafeZoneGuideBmp({
      width: 2, height: 3, platform: "tiktok", bitsPerPixel: 24, includeRemovalWarning: false,
    });
    assert.equal(padded.rowStride, 8);
    assert.equal(padded.byteLength, 54 + 8 * 3);
  });

  it("renders an extreme aspect ratio strip at the dimension cap", () => {
    const result = renderSafeZoneGuideBmp({
      width: MAX_SAFE_ZONE_BMP_DIMENSION,
      height: 1,
      platform: "youtube-shorts",
      includeRemovalWarning: false,
    });
    assert.equal(result.width, MAX_SAFE_ZONE_BMP_DIMENSION);
    assert.equal(result.height, 1);
    assert.equal(result.safeRectPixels.y, 0);
    assert.equal(result.safeRectPixels.height, 1);
    assert.ok(result.safeRectPixels.x > 0);
    assert.equal(result.byteLength, 122 + MAX_SAFE_ZONE_BMP_DIMENSION * 4);
    assert.equal(logicalPixel(result, result.safeRectPixels.x, 0)[3], 235);
  });

  it("accepts caller limits exactly at the required size", () => {
    const exact = renderSafeZoneGuideBmp({ width: 10, height: 10, platform: "tiktok", maxPixels: 100, maxBytes: 522 });
    assert.equal(exact.byteLength, 522);
    assert.throws(() => renderSafeZoneGuideBmp({ width: 10, height: 10, platform: "tiktok", maxPixels: 0 }), /1 이상/u);
    assert.throws(() => renderSafeZoneGuideBmp({ width: 10, height: 10, platform: "tiktok", maxBytes: 1.5 }), /1 이상/u);
  });

  it("validates renderer option types", () => {
    assert.throws(() => renderSafeZoneGuideBmp(null as never), /옵션 객체/u);
    assert.throws(
      () => renderSafeZoneGuideBmp({ width: 32, height: 32, platform: "tiktok", includeRemovalWarning: "no" as never }),
      /불리언/u,
    );
    assert.throws(
      () => renderSafeZoneGuideBmp({ width: 32, height: 32, platform: "tiktok", role: "banner" as never }),
      /역할/u,
    );
    assert.throws(() => renderSafeZoneGuideBmp({ width: 32, height: 32, platform: "unknown" as never }), /지원하지/u);
  });

  it("honors custom margins in the rendered pixel rect", () => {
    const result = renderSafeZoneGuideBmp({
      width: 100,
      height: 100,
      platform: "instagram-reels",
      customMargins: { top: 0, right: 0, bottom: 0, left: 0 },
      includeRemovalWarning: false,
    });
    assert.deepEqual(result.safeRectPixels, { x: 0, y: 0, width: 100, height: 100 });
    assert.equal(logicalPixel(result, 0, 0)[3], 235);
    assert.equal(logicalPixel(result, 99, 99)[3], 235);
    assert.equal(logicalPixel(result, 50, 50)[3], 0);
  });
});
