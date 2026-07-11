import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ShortFlowError,
  centeredPosition,
  errorMessage,
  joinNativePath,
  keyframeValue,
  normalizeExportExtension,
  normalizePremierePath,
  sameMediaPath,
  tickTimeSeconds,
  zeroBasedTrackIndex,
} from "../src/premiere";

function assertShortFlowError(error: unknown, code: string): boolean {
  assert.ok(error instanceof ShortFlowError);
  assert.equal(error.code, code);
  assert.ok(error.message.length > 0);
  return true;
}

describe("tickTimeSeconds", () => {
  it("reads the synchronous seconds property from an Adobe TickTime-like object", () => {
    assert.equal(tickTimeSeconds({ seconds: 12.5 }), 12.5);
  });

  it("accepts a numeric string exposed by a host shim", () => {
    assert.equal(tickTimeSeconds({ seconds: "3.25" }), 3.25);
  });

  it("returns the caller fallback for missing and non-finite seconds", () => {
    assert.equal(tickTimeSeconds({}, 7), 7);
    assert.equal(tickTimeSeconds({ seconds: Number.NaN }, 8), 8);
    assert.equal(tickTimeSeconds({ seconds: Number.POSITIVE_INFINITY }, 9), 9);
  });

  it("does not confuse a bare number with TickTime", () => {
    assert.equal(tickTimeSeconds(5, -1), -1);
  });
});

describe("keyframeValue", () => {
  it("unwraps the official Keyframe.value.value shape", () => {
    assert.equal(keyframeValue({ value: { value: 125 } }), 125);
  });

  it("keeps compatibility with a direct value host shim", () => {
    assert.equal(keyframeValue({ value: 80 }), 80);
  });

  it("unwraps PointF values without cloning or mutation", () => {
    const point = { x: 960, y: 540 };
    assert.equal(keyframeValue({ value: { value: point } }), point);
    assert.deepEqual(point, { x: 960, y: 540 });
  });

  it("returns undefined for malformed keyframes", () => {
    assert.equal(keyframeValue(null), undefined);
    assert.equal(keyframeValue({}), undefined);
  });
});

describe("centeredPosition", () => {
  it("centers pixel-coordinate Motion positions on the target frame", () => {
    assert.deepEqual(centeredPosition({ x: 960, y: 540 }, 1080, 1920), {
      x: 540,
      y: 960,
    });
  });

  it("centers normalized Motion positions at 0.5, 0.5", () => {
    assert.deepEqual(centeredPosition({ x: 0.25, y: 0.75 }, 1080, 1920), {
      x: 0.5,
      y: 0.5,
    });
  });

  it("does not mutate the source PointF-like object", () => {
    const point = { x: 200, y: 300 };
    centeredPosition(point, 1000, 500);
    assert.deepEqual(point, { x: 200, y: 300 });
  });

  it("rejects malformed points and unusable target sizes", () => {
    assert.equal(centeredPosition({ x: 1 }, 100, 100), null);
    assert.equal(centeredPosition({ x: Number.NaN, y: 1 }, 100, 100), null);
    assert.equal(centeredPosition({ x: 1, y: 1 }, 0, 100), null);
  });
});

describe("zeroBasedTrackIndex", () => {
  it("preserves valid zero-based API indices", () => {
    assert.equal(zeroBasedTrackIndex(0), 0);
    assert.equal(zeroBasedTrackIndex(98), 98);
  });

  it("converts one-based UI track numbers", () => {
    assert.equal(zeroBasedTrackIndex(1, true), 0);
    assert.equal(zeroBasedTrackIndex(99, true), 98);
  });

  it("rejects fractional and non-finite values instead of silently rounding", () => {
    assert.throws(
      () => zeroBasedTrackIndex(1.5),
      (error) => assertShortFlowError(error, "INVALID_TRACK"),
    );
    assert.throws(
      () => zeroBasedTrackIndex(Number.NaN),
      (error) => assertShortFlowError(error, "INVALID_TRACK"),
    );
  });

  it("rejects zero for one-based UI tracks", () => {
    assert.throws(
      () => zeroBasedTrackIndex(0, true),
      (error) => assertShortFlowError(error, "INVALID_TRACK"),
    );
  });

  it("rejects indices beyond Premiere's guarded 99-track limit", () => {
    assert.throws(
      () => zeroBasedTrackIndex(99),
      (error) => assertShortFlowError(error, "INVALID_TRACK"),
    );
    assert.throws(
      () => zeroBasedTrackIndex(100, true),
      (error) => assertShortFlowError(error, "INVALID_TRACK"),
    );
  });
});

describe("normalizeExportExtension", () => {
  it("normalizes the extension returned by EncoderManager", () => {
    assert.equal(normalizeExportExtension(".MP4"), "mp4");
    assert.equal(normalizeExportExtension("  .MOV  "), "mov");
  });

  it("accepts numeric codec extensions", () => {
    assert.equal(normalizeExportExtension("m2v"), "m2v");
  });

  it("falls back for path injection and punctuation", () => {
    assert.equal(normalizeExportExtension("../exe"), "mp4");
    assert.equal(normalizeExportExtension("mp4;cmd"), "mp4");
  });

  it("normalizes a safe custom fallback", () => {
    assert.equal(normalizeExportExtension("", ".MXF"), "mxf");
  });

  it("uses mp4 when the custom fallback is unsafe", () => {
    assert.equal(normalizeExportExtension(null, "../bad"), "mp4");
  });
});

describe("normalizePremierePath and sameMediaPath", () => {
  it("normalizes Windows drive paths case-insensitively", () => {
    assert.equal(
      normalizePremierePath(" C:\\Media\\Refs\\HERO.PNG\\ "),
      "c:/media/refs/hero.png",
    );
  });

  it("preserves UNC roots while normalizing case", () => {
    assert.equal(
      normalizePremierePath("\\\\NAS\\Share\\Clip.MOV\\"),
      "//nas/share/clip.mov",
    );
  });

  it("preserves POSIX case sensitivity", () => {
    assert.equal(normalizePremierePath("/Media/Hero.PNG/"), "/Media/Hero.PNG");
  });

  it("matches Windows paths across separator and case differences", () => {
    assert.equal(
      sameMediaPath("C:\\MEDIA\\Clip.MOV", "c:/media/clip.mov"),
      true,
    );
  });

  it("does not collapse distinct POSIX-case paths", () => {
    assert.equal(sameMediaPath("/Media/Hero.png", "/Media/hero.png"), false);
  });

  it("never considers two empty paths the same media", () => {
    assert.equal(sameMediaPath("", ""), false);
  });
});

describe("joinNativePath", () => {
  it("joins Windows folders with a backslash", () => {
    assert.equal(joinNativePath("C:\\Exports", "short.mp4"), "C:\\Exports\\short.mp4");
  });

  it("joins POSIX folders with a slash", () => {
    assert.equal(joinNativePath("/Users/editor/Exports", "short.mp4"), "/Users/editor/Exports/short.mp4");
  });

  it("avoids duplicate trailing separators", () => {
    assert.equal(joinNativePath("C:\\Exports\\", "short.mp4"), "C:\\Exports\\short.mp4");
    assert.equal(joinNativePath("/tmp/", "short.mp4"), "/tmp/short.mp4");
  });

  it("supports a POSIX root output folder", () => {
    assert.equal(joinNativePath("/", "short.mp4"), "/short.mp4");
  });

  it("strips accidental leading separators from the filename", () => {
    assert.equal(joinNativePath("C:\\Exports", "\\short.mp4"), "C:\\Exports\\short.mp4");
  });

  it("rejects traversal and nested filename paths", () => {
    for (const filename of ["../escape.mp4", "..\\escape.mp4", "nested/escape.mp4"]) {
      assert.throws(
        () => joinNativePath("C:\\Exports", filename),
        (error) => assertShortFlowError(error, "INVALID_OUTPUT_PATH"),
      );
    }
  });

  it("rejects missing folder or filename values", () => {
    assert.throws(
      () => joinNativePath("", "short.mp4"),
      (error) => assertShortFlowError(error, "INVALID_OUTPUT_PATH"),
    );
    assert.throws(
      () => joinNativePath("C:\\Exports", ""),
      (error) => assertShortFlowError(error, "INVALID_OUTPUT_PATH"),
    );
  });
});

describe("errorMessage", () => {
  it("returns Error messages and stringifies host values", () => {
    assert.equal(errorMessage(new Error("host failed")), "host failed");
    assert.equal(errorMessage("plain failure"), "plain failure");
  });

  it("uses the Korean fallback for nullish values", () => {
    assert.equal(errorMessage(null), "알 수 없는 오류");
  });

  it("redacts credentials before errors reach activity logs", () => {
    const secret = "sk-proj-abcdefghijk123456";
    const message = errorMessage(new Error(`Authorization: Bearer ${secret}`));
    assert.equal(message.includes(secret), false);
    assert.match(message, /REDACTED/u);
  });
});
