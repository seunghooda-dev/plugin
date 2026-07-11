import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SAFE_ZONE_PROFILES,
  alignToSafeZone,
  assessSafeZone,
  normalizeMargins,
  normalizeRect,
  normalizedRectToPixels,
  pixelRectToNormalized,
  safeContentRect,
} from "../src/safe-zone";

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

  it("rejects an unknown platform", () => {
    assert.throws(() => safeContentRect("unknown" as never), /지원하지/u);
  });
});

describe("safe-zone normalization", () => {
  it("clamps rectangles to the normalized canvas", () => {
    assert.deepEqual(normalizeRect({ x: -1, y: 0.8, width: 2, height: 0.5 }), {
      x: 0, y: 0.8, width: 1, height: 0.2,
    });
  });

  it("falls back from impossible custom margins", () => {
    const fallback = SAFE_ZONE_PROFILES.tiktok.contentMargins;
    const margins = normalizeMargins({ left: 0.45, right: 0.45, top: 0.45, bottom: 0.45 }, fallback);
    assert.deepEqual(margins, fallback);
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
    assert.equal(assessSafeZone({ x: 0.2, y: 0.2, width: 0, height: 0 }, "youtube-shorts").inside, false);
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
  });

  it("leaves an already safe element unchanged", () => {
    const aligned = alignToSafeZone({ x: 0.2, y: 0.2, width: 0.2, height: 0.2 }, "youtube-shorts");
    assert.equal(aligned.changed, false);
    assert.equal(aligned.deltaX, 0);
    assert.equal(aligned.deltaY, 0);
  });

  it("gracefully no-ops an empty element", () => {
    const aligned = alignToSafeZone({ x: 0, y: 0, width: 0, height: 0 }, "tiktok");
    assert.equal(aligned.changed, false);
  });
});

