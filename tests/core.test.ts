import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PROFILES,
  calculateRelativeScale,
  formatDuration,
  markerToSegment,
  resolveTimeRange,
  sanitizeFileName,
  sanitizeSequenceName,
  validateShort,
} from "../src/core";

const EPSILON = 1e-9;
const INVALID_FILE_CHARACTERS = new RegExp("[<>:\"/\\\\|?*\\x00-\\x1f]", "u");

function assertClose(actual: number, expected: number): void {
  assert.ok(
    Math.abs(actual - expected) <= EPSILON,
    `expected ${actual} to be within ${EPSILON} of ${expected}`,
  );
}

type ProfileView = {
  id?: string;
  width: number;
  height: number;
  maxDuration: number;
};

function profileMap(): Map<string, ProfileView> {
  const value: unknown = PROFILES;

  if (Array.isArray(value)) {
    return new Map(
      (value as unknown[]).map((entry, index) => {
        const profile = entry as ProfileView;
        return [profile.id ?? String(index), profile] as const;
      }),
    );
  }

  return new Map(
    Object.entries(value as Record<string, unknown>).map(
      ([id, entry]) => [id, entry as ProfileView] as const,
    ),
  );
}

type MarkerSegmentView = {
  name: string;
  comments: string;
  start: number;
  end: number;
  duration: number;
  index: number;
};

type QCItemView = {
  level: "error" | "warning" | "pass";
  code: string;
  message: string;
};

const healthyShort = {
  width: 1080,
  height: 1920,
  duration: 45,
  captionTrackCount: 1,
  videoTrackCount: 1,
  audioTrackCount: 1,
  expectedWidth: 1080,
  expectedHeight: 1920,
  maxDuration: 60,
  name: "ShortFlow_9x16",
};

function qcItems(
  overrides: Partial<typeof healthyShort> = {},
): QCItemView[] {
  return validateShort({ ...healthyShort, ...overrides }) as unknown as QCItemView[];
}

describe("PROFILES", () => {
  it("exposes every platform profile used by the panel", () => {
    const profiles = profileMap();

    for (const id of [
      "youtube-shorts",
      "instagram-reels",
      "tiktok",
      "square",
    ]) {
      assert.ok(profiles.has(id), `missing profile: ${id}`);
    }
  });

  it("uses production-safe positive dimensions and durations", () => {
    const profiles = profileMap();
    assert.ok(profiles.size >= 4);

    for (const [id, profile] of profiles) {
      assert.ok(Number.isInteger(profile.width), `${id} width must be an integer`);
      assert.ok(Number.isInteger(profile.height), `${id} height must be an integer`);
      assert.ok(profile.width >= 16, `${id} width is too small`);
      assert.ok(profile.height >= 16, `${id} height is too small`);
      assert.ok(
        Number.isFinite(profile.maxDuration) && profile.maxDuration > 0,
        `${id} maxDuration must be positive`,
      );
    }
  });

  it("defines the expected vertical and square canvas sizes", () => {
    const profiles = profileMap();

    for (const id of ["youtube-shorts", "instagram-reels", "tiktok"]) {
      const profile = profiles.get(id);
      assert.ok(profile);
      assert.equal(profile.width, 1080);
      assert.equal(profile.height, 1920);
    }

    const square = profiles.get("square");
    assert.ok(square);
    assert.equal(square.width, 1080);
    assert.equal(square.height, 1080);
  });
});

describe("sanitizeSequenceName", () => {
  it("trims and collapses whitespace without damaging Unicode", () => {
    assert.equal(
      sanitizeSequenceName("  여름  여행\t숏폼  "),
      "여름 여행 숏폼",
    );
  });

  it("removes filesystem delimiters and control characters", () => {
    const result = sanitizeSequenceName('  bad<>:"/\\|?*\u0000\u001f name  ');

    assert.doesNotMatch(result, INVALID_FILE_CHARACTERS);
    assert.equal(result.trim(), result);
  });

  it("returns a stable fallback for an empty or fully unsafe value", () => {
    assert.equal(sanitizeSequenceName(" \t\r\n "), "ShortFlow");
    assert.equal(sanitizeSequenceName("<>:\"/\\|?*"), "ShortFlow");
  });

  it("honors a caller-provided maximum length", () => {
    const result = sanitizeSequenceName("1234567890abcdefghij", 12);
    assert.equal(result.length, 12);
    assert.equal(result, "1234567890ab");
  });

  it("never exceeds the default 120-character Premiere field limit", () => {
    const result = sanitizeSequenceName("가".repeat(500));
    assert.equal(result.length, 120);
  });

  it("falls back to the default limit for an invalid maxLength", () => {
    assert.equal(sanitizeSequenceName("가".repeat(500), 0).length, 120);
    assert.equal(sanitizeSequenceName("가".repeat(500), Number.NaN).length, 120);
    assert.equal(sanitizeSequenceName("abcdefg", 5.9), "abcde");
  });
});

describe("sanitizeFileName", () => {
  it("leaves an ordinary Unicode filename unchanged", () => {
    assert.equal(sanitizeFileName("쇼츠 최종본_v2.mp4"), "쇼츠 최종본_v2.mp4");
  });

  it("neutralizes traversal and absolute-path payloads", () => {
    for (const payload of [
      "../../Windows/System32/config/SAM",
      "..\\..\\secret\\token.txt",
      "C:\\Users\\victim\\file.mp4",
    ]) {
      const result = sanitizeFileName(payload);
      assert.ok(result.length > 0);
      assert.doesNotMatch(result, /[\\/]/u);
      assert.equal(result.includes(".."), false);
    }
  });

  it("removes Windows-invalid characters and control bytes", () => {
    const result = sanitizeFileName('a<b>c:d"e/f\\g|h?i*j\u0000.mp4');
    assert.doesNotMatch(result, INVALID_FILE_CHARACTERS);
    assert.ok(result.length > 0);
  });

  it("does not return a Windows device name", () => {
    for (const reserved of [
      "CON",
      "prn",
      "AUX.txt",
      "nul.mp4",
      "COM1",
      "lpt9.mov",
    ]) {
      const result = sanitizeFileName(reserved);
      assert.doesNotMatch(
        result,
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu,
      );
    }
  });

  it("strips trailing dots and spaces", () => {
    const result = sanitizeFileName("final export...   ");
    assert.doesNotMatch(result, /[. ]$/u);
    assert.ok(result.startsWith("final export"));
  });

  it("returns a safe fallback when nothing usable remains", () => {
    const result = sanitizeFileName("  ...  ");
    assert.equal(result, "shortflow");
    assert.doesNotMatch(result, INVALID_FILE_CHARACTERS);
  });

  it("honors an explicit filename length limit", () => {
    const result = sanitizeFileName(`${"a".repeat(100)}.mp4`, 24);
    assert.ok(result.length <= 24);
    assert.ok(result.length > 0);
    assert.doesNotMatch(result, /[. ]$/u);
  });

  it("keeps the extension when truncating a long name", () => {
    const result = sanitizeFileName(`${"a".repeat(100)}.mp4`, 24);
    assert.equal(result.length, 24);
    assert.ok(result.endsWith(".mp4"));
  });

  it("drops an extension that would not fit the limit", () => {
    const result = sanitizeFileName(`clip.${"x".repeat(40)}`, 10);
    assert.ok(result.length <= 10);
    assert.ok(result.length > 0);
    assert.equal(result.includes("."), false);
  });
});

describe("calculateRelativeScale", () => {
  it("uses the larger axis ratio in fill mode", () => {
    assertClose(
      calculateRelativeScale(100, 1920, 1080, 1080, 1920, "fill"),
      177.77777777777777,
    );
  });

  it("uses the smaller axis ratio in fit mode", () => {
    assertClose(
      calculateRelativeScale(100, 1920, 1080, 1080, 1920, "fit"),
      56.25,
    );
  });

  it("applies the ratio relative to the clip's current scale", () => {
    assertClose(
      calculateRelativeScale(50, 1920, 1080, 1080, 1920, "fill"),
      88.88888888888889,
    );
  });

  it("supports proportional upscaling in both fit and fill modes", () => {
    assert.equal(
      calculateRelativeScale(100, 1080, 1920, 2160, 3840, "fill"),
      200,
    );
    assert.equal(
      calculateRelativeScale(100, 1080, 1920, 2160, 3840, "fit"),
      200,
    );
  });

  it("preserves current scale in none mode", () => {
    assert.equal(
      calculateRelativeScale(73.25, 1920, 1080, 1080, 1920, "none"),
      73.25,
    );
  });

  it("preserves a valid current scale when a dimension is zero", () => {
    assert.equal(
      calculateRelativeScale(75, 0, 1080, 1080, 1920, "fill"),
      75,
    );
    assert.equal(
      calculateRelativeScale(75, 1920, 1080, 1080, 0, "fit"),
      75,
    );
  });

  it("never returns NaN or Infinity for non-finite inputs", () => {
    for (const result of [
      calculateRelativeScale(Number.NaN, 1920, 1080, 1080, 1920, "fill"),
      calculateRelativeScale(80, Number.NaN, 1080, 1080, 1920, "fit"),
      calculateRelativeScale(80, 1920, 1080, Number.POSITIVE_INFINITY, 1920, "fill"),
      calculateRelativeScale(Number.POSITIVE_INFINITY, 1920, 1080, 1080, 1920, "none"),
    ]) {
      assert.ok(Number.isFinite(result));
      assert.ok(result > 0);
    }
  });
});

describe("resolveTimeRange", () => {
  it("returns the complete sequence in full mode", () => {
    assert.deepEqual(resolveTimeRange({ mode: "full", sequenceEnd: 120 }), {
      start: 0,
      end: 120,
      duration: 120,
      usedFallback: false,
    });
  });

  it("caps full mode at maxDuration", () => {
    assert.deepEqual(
      resolveTimeRange({ mode: "full", sequenceEnd: 120, maxDuration: 60 }),
      { start: 0, end: 60, duration: 60, usedFallback: false },
    );
  });

  it("uses a valid in/out range", () => {
    assert.deepEqual(
      resolveTimeRange({
        mode: "inout",
        sequenceEnd: 100,
        inPoint: 10,
        outPoint: 42.5,
      }),
      { start: 10, end: 42.5, duration: 32.5, usedFallback: false },
    );
  });

  it("caps a valid in/out range relative to its start", () => {
    assert.deepEqual(
      resolveTimeRange({
        mode: "inout",
        sequenceEnd: 100,
        inPoint: 40,
        outPoint: 90,
        maxDuration: 20,
      }),
      { start: 40, end: 60, duration: 20, usedFallback: false },
    );
  });

  it("clamps in/out points to sequence boundaries", () => {
    assert.deepEqual(
      resolveTimeRange({
        mode: "inout",
        sequenceEnd: 100,
        inPoint: -20,
        outPoint: 150,
      }),
      { start: 0, end: 100, duration: 100, usedFallback: false },
    );
  });

  it("falls back to the sequence when in/out points are missing", () => {
    assert.deepEqual(
      resolveTimeRange({
        mode: "inout",
        sequenceEnd: 80,
        maxDuration: 30,
      }),
      { start: 0, end: 30, duration: 30, usedFallback: true },
    );
  });

  it("falls back when the out point is not after the in point", () => {
    assert.deepEqual(
      resolveTimeRange({
        mode: "inout",
        sequenceEnd: 80,
        inPoint: 50,
        outPoint: 20,
      }),
      { start: 0, end: 80, duration: 80, usedFallback: true },
    );
  });

  it("starts at the playhead and applies maxDuration", () => {
    assert.deepEqual(
      resolveTimeRange({
        mode: "playhead",
        sequenceEnd: 100,
        playhead: 70,
        maxDuration: 20,
      }),
      { start: 70, end: 90, duration: 20, usedFallback: false },
    );
  });

  it("clamps a playhead range at the sequence end", () => {
    assert.deepEqual(
      resolveTimeRange({
        mode: "playhead",
        sequenceEnd: 100,
        playhead: 92,
        maxDuration: 30,
      }),
      { start: 92, end: 100, duration: 8, usedFallback: false },
    );
  });

  it("returns a finite empty range for an invalid sequence duration", () => {
    const range = resolveTimeRange({
      mode: "full",
      sequenceEnd: Number.NaN,
      maxDuration: Number.POSITIVE_INFINITY,
    });

    assert.equal(range.start, 0);
    assert.equal(range.end, 0);
    assert.equal(range.duration, 0);
    assert.ok(Number.isFinite(range.duration));
  });

  it("falls back to the full sequence when clamped in/out points collapse", () => {
    assert.deepEqual(
      resolveTimeRange({
        mode: "inout",
        sequenceEnd: 100,
        inPoint: 150,
        outPoint: 200,
      }),
      { start: 0, end: 100, duration: 100, usedFallback: true },
    );
  });

  it("falls back to the full sequence when the playhead is missing", () => {
    assert.deepEqual(
      resolveTimeRange({ mode: "playhead", sequenceEnd: 50 }),
      { start: 0, end: 50, duration: 50, usedFallback: true },
    );
  });

  it("clamps a negative playhead to the sequence start", () => {
    assert.deepEqual(
      resolveTimeRange({ mode: "playhead", sequenceEnd: 50, playhead: -10 }),
      { start: 0, end: 50, duration: 50, usedFallback: false },
    );
  });

  it("ignores a non-positive maxDuration", () => {
    assert.deepEqual(
      resolveTimeRange({ mode: "full", sequenceEnd: 40, maxDuration: 0 }),
      { start: 0, end: 40, duration: 40, usedFallback: false },
    );
  });
});

describe("markerToSegment", () => {
  it("converts a normal marker into a bounded segment", () => {
    const segment = markerToSegment(
      { name: "Hook", comments: "Open strong", start: 5, duration: 8, index: 2 },
      60,
      15,
    );

    assert.ok(segment);
    const view = segment as unknown as MarkerSegmentView;
    assert.equal(view.name, "Hook");
    assert.equal(view.comments, "Open strong");
    assert.equal(view.index, 2);
    assert.equal(view.start, 5);
    assert.equal(view.end, 13);
    assert.equal(view.duration, 8);
  });

  it("uses defaultDuration for a zero-duration Premiere marker", () => {
    const segment = markerToSegment(
      { name: "Beat", comments: "", start: 5, duration: 0, index: 0 },
      60,
      12,
    );

    assert.ok(segment);
    const view = segment as unknown as MarkerSegmentView;
    assert.equal(view.start, 5);
    assert.equal(view.end, 17);
    assert.equal(view.duration, 12);
  });

  it("clamps a marker segment at the sequence end", () => {
    const segment = markerToSegment(
      { name: "CTA", comments: "", start: 55, duration: 20, index: 4 },
      60,
      10,
    );

    assert.ok(segment);
    const view = segment as unknown as MarkerSegmentView;
    assert.equal(view.start, 55);
    assert.equal(view.end, 60);
    assert.equal(view.duration, 5);
  });

  it("returns null when the marker starts at or after sequence end", () => {
    assert.equal(
      markerToSegment(
        { name: "End", comments: "", start: 60, duration: 1, index: 0 },
        60,
        10,
      ),
      null,
    );
    assert.equal(
      markerToSegment(
        { name: "Past", comments: "", start: 61, duration: 1, index: 1 },
        60,
        10,
      ),
      null,
    );
  });

  it("returns null for non-finite timing data", () => {
    assert.equal(
      markerToSegment(
        { name: "Bad", comments: "", start: Number.NaN, duration: 1, index: 0 },
        60,
        10,
      ),
      null,
    );
  });

  it("returns null when the sequence has no usable duration", () => {
    for (const sequenceEnd of [0, -10, Number.NaN]) {
      assert.equal(
        markerToSegment(
          { name: "X", comments: "", start: 0, duration: 5, index: 0 },
          sequenceEnd,
          10,
        ),
        null,
      );
    }
  });

  it("names an unnamed marker from its 1-based index", () => {
    const segment = markerToSegment(
      { name: "", comments: "", start: 2, duration: 4, index: 4 },
      60,
      10,
    );

    assert.ok(segment);
    assert.equal((segment as unknown as MarkerSegmentView).name, "Short 5");
  });

  it("clamps a negative marker start to zero before measuring the duration", () => {
    const segment = markerToSegment(
      { name: "Early", comments: "", start: -5, duration: 10, index: 0 },
      60,
      10,
    );

    assert.ok(segment);
    const view = segment as unknown as MarkerSegmentView;
    assert.equal(view.start, 0);
    assert.equal(view.end, 10);
    assert.equal(view.duration, 10);
  });

  it("normalizes a non-integer index and falls back to one second for an invalid default duration", () => {
    const segment = markerToSegment(
      { name: "Beat", comments: "", start: 5, duration: 0, index: 2.5 },
      60,
      Number.NaN,
    );

    assert.ok(segment);
    const view = segment as unknown as MarkerSegmentView;
    assert.equal(view.index, 0);
    assert.equal(view.end, 6);
    assert.equal(view.duration, 1);
  });
});

describe("formatDuration", () => {
  it("formats zero and sub-minute values as MM:SS", () => {
    assert.equal(formatDuration(0), "00:00");
    assert.equal(formatDuration(5.9), "00:05");
    assert.equal(formatDuration(59.9), "00:59");
  });

  it("pads minutes and seconds", () => {
    assert.equal(formatDuration(65), "01:05");
    assert.equal(formatDuration(600), "10:00");
  });

  it("adds an hour field only when needed", () => {
    assert.equal(formatDuration(3599), "59:59");
    assert.equal(formatDuration(3661), "1:01:01");
  });

  it("rolls exactly one hour into the hour field", () => {
    assert.equal(formatDuration(3600), "1:00:00");
    assert.equal(formatDuration(3600.9), "1:00:00");
  });

  it("clamps negative and non-finite values to zero", () => {
    assert.equal(formatDuration(-1), "00:00");
    assert.equal(formatDuration(Number.NaN), "00:00");
    assert.equal(formatDuration(Number.POSITIVE_INFINITY), "00:00");
  });
});

describe("validateShort", () => {
  it("returns pass results for a production-ready short", () => {
    const items = qcItems();
    assert.ok(items.length > 0);
    assert.ok(items.some((item) => item.level === "pass"));
    assert.equal(items.some((item) => item.level === "error"), false);
    assert.equal(items.some((item) => item.level === "warning"), false);
  });

  it("reports an error for a resolution mismatch", () => {
    const items = qcItems({ width: 1920, height: 1080 });
    assert.ok(items.some((item) => item.level === "error"));
  });

  it("reports an error when there is no video track", () => {
    const items = qcItems({ videoTrackCount: 0 });
    assert.ok(items.some((item) => item.level === "error"));
  });

  it("reports an error for a zero or invalid duration", () => {
    assert.ok(qcItems({ duration: 0 }).some((item) => item.level === "error"));
    assert.ok(
      qcItems({ duration: Number.NaN }).some((item) => item.level === "error"),
    );
  });

  it("reports a warning when duration exceeds the platform limit", () => {
    const items = qcItems({ duration: 60.001 });
    assert.ok(items.some((item) => item.level === "warning"));
    assert.equal(items.some((item) => item.level === "error"), false);
  });

  it("accepts a duration exactly at the platform limit", () => {
    const items = qcItems({ duration: 60 });
    assert.equal(items.some((item) => item.level === "error"), false);
    assert.equal(items.some((item) => item.level === "warning"), false);
  });

  it("warns when a short has no caption track", () => {
    const items = qcItems({ captionTrackCount: 0 });
    assert.ok(items.some((item) => item.level === "warning"));
    assert.equal(items.some((item) => item.level === "error"), false);
  });

  it("warns when a short has no audio track", () => {
    const items = qcItems({ audioTrackCount: 0 });
    assert.ok(items.some((item) => item.level === "warning"));
    assert.equal(items.some((item) => item.level === "error"), false);
  });

  it("warns for an empty sequence name", () => {
    const items = qcItems({ name: "   " });
    assert.ok(items.some((item) => item.level === "warning"));
  });

  it("returns stable, renderable QC item fields", () => {
    const items = qcItems({
      width: 1920,
      height: 1080,
      duration: 120,
      videoTrackCount: 0,
      audioTrackCount: 0,
      captionTrackCount: 0,
      name: "",
    });

    assert.ok(items.some((item) => item.level === "error"));
    assert.ok(items.some((item) => item.level === "warning"));

    for (const item of items) {
      assert.ok(["error", "warning", "pass"].includes(item.level));
      assert.ok(typeof item.code === "string" && item.code.trim().length > 0);
      assert.ok(typeof item.message === "string" && item.message.trim().length > 0);
    }
  });
});
