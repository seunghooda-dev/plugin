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
});
