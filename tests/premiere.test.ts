import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  ShortFlowError,
  assertAudioInsertRangeAvailable,
  assertAutomationPlan,
  audioProjectItemDurationSeconds,
  buildExportFilename,
  buildSafeZoneItemAlignmentActions,
  centeredPosition,
  cloneSequence,
  commitTimelineInsertAfterPreflight,
  errorMessage,
  exportTimestamp,
  joinNativePath,
  keyframeValue,
  normalizeExportExtension,
  normalizePremierePath,
  premiereContextKey,
  planClipPunchKeyframes,
  prepareInsertAssetPreflight,
  punchApplicabilityWarning,
  readSequenceStatus,
  removeVerifiedClonedSequenceFromProject,
  sameMediaPath,
  scanSequenceMediaQC,
  setSequencePlayerPosition,
  tickTimeSeconds,
  translateSafeZonePosition,
  validatePremiereImportPath,
  zeroBasedTrackIndex,
} from "../src/premiere";
import type { SilenceCutPlan } from "../src/automation";
import type { PointF, Project, VideoClipTrackItem } from "@adobe/premierepro";
import type { SafeZoneAlignment } from "../src/safe-zone";

function assertShortFlowError(error: unknown, code: string): boolean {
  assert.ok(error instanceof ShortFlowError);
  assert.equal(error.code, code);
  assert.ok(error.message.length > 0);
  return true;
}

function markerPlan(cutCount: number): SilenceCutPlan {
  const sourceDuration = cutCount + 1;
  const cuts = Array.from({ length: cutCount }, (_value, index) => ({
    start: index,
    end: index + 1,
    duration: 1,
  }));
  return {
    sourceDuration,
    outputDuration: 1,
    removedDuration: cutCount,
    compressionRatio: 1 / sourceDuration,
    speech: [],
    cuts,
    keeps: [{ start: cutCount, end: sourceDuration, duration: 1 }],
    warnings: [],
  };
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

describe("readSequenceStatus Host snapshot", () => {
  function selectedItem(start: number, end: number, type: "video" | "audio" = "video") {
    return {
      ...(type === "video" ? { isAdjustmentLayer: () => false } : {}),
      getStartTime: async () => ({ seconds: start }),
      getEndTime: async () => ({ seconds: end }),
    };
  }

  it("starts independent read-only Host calls together instead of serializing QC latency", async () => {
    const started = new Set<string>();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const delayed = <T>(name: string, value: T): Promise<T> => {
      started.add(name);
      return gate.then(() => value);
    };
    const sequence = {
      name: "Sequence 01",
      guid: "sequence-guid",
      getFrameSize: () => delayed("frame", { width: 1080, height: 1920 }),
      getEndTime: () => delayed("end", { seconds: 12 }),
      getInPoint: () => delayed("in", { seconds: 2 }),
      getOutPoint: () => delayed("out", { seconds: 10 }),
      getPlayerPosition: () => delayed("playhead", { seconds: 4 }),
      getSelection: async () => null,
      getVideoTrackCount: () => delayed("video-tracks", 3),
      getAudioTrackCount: () => delayed("audio-tracks", 4),
      getCaptionTrackCount: () => delayed("caption-tracks", 1),
      getSettings: async () => ({ getVideoFrameRate: () => ({ value: 30 }) }),
    };
    const pending = readSequenceStatus({
      project: { name: "Project", path: "C:\\Project.prproj", guid: "project-guid" },
      sequence,
    } as never);
    await Promise.resolve();
    const beforeRelease = [...started].sort();
    release();
    const status = await pending;

    assert.deepEqual(beforeRelease, [
      "audio-tracks",
      "caption-tracks",
      "end",
      "frame",
      "in",
      "out",
      "playhead",
      "video-tracks",
    ]);
    assert.deepEqual({
      width: status.width,
      height: status.height,
      duration: status.effectiveDuration,
      frameRate: status.frameRate,
      videoTracks: status.videoTrackCount,
      audioTracks: status.audioTrackCount,
      captionTracks: status.captionTrackCount,
    }, {
      width: 1080,
      height: 1920,
      duration: 8,
      frameRate: 30,
      videoTracks: 3,
      audioTracks: 4,
      captionTracks: 1,
    });
  });

  it("skips selection and playhead Host calls for the lightweight basic-QC path", async () => {
    let selectionCalls = 0;
    let playheadCalls = 0;
    const sequence = {
      name: "QC Sequence",
      guid: "sequence-guid",
      getFrameSize: async () => ({ width: 1080, height: 1920 }),
      getEndTime: async () => ({ seconds: 20 }),
      getInPoint: async () => ({ seconds: 0 }),
      getOutPoint: async () => ({ seconds: 20 }),
      getPlayerPosition: async () => { playheadCalls += 1; return { seconds: 5 }; },
      getSelection: async () => { selectionCalls += 1; return null; },
      getVideoTrackCount: async () => 1,
      getAudioTrackCount: async () => 1,
      getCaptionTrackCount: async () => 0,
      getSettings: async () => ({ getVideoFrameRate: () => ({ value: 30 }) }),
    };
    const status = await readSequenceStatus({
      project: { name: "Project", path: "C:\\Project.prproj", guid: "project-guid" },
      sequence,
    } as never, {
      includeSelection: false,
      includePlayerPosition: false,
    });

    assert.equal(selectionCalls, 0);
    assert.equal(playheadCalls, 0);
    assert.equal(status.playerPosition, 0);
    assert.equal(status.selectedItemCount, 0);
    assert.equal(status.effectiveDuration, 20);
  });

  it("reports timeline TrackItem selection counts and the combined selected range", async () => {
    const sequence = {
      name: "Selected Sequence",
      guid: "sequence-guid",
      getFrameSize: async () => ({ width: 1920, height: 1080 }),
      getEndTime: async () => ({ seconds: 30 }),
      getInPoint: async () => ({ seconds: 0 }),
      getOutPoint: async () => ({ seconds: 30 }),
      getPlayerPosition: async () => ({ seconds: 9 }),
      getSelection: async () => ({
        getTrackItems: async () => [
          selectedItem(4, 12, "video"),
          selectedItem(6, 14, "audio"),
        ],
      }),
      getVideoTrackCount: async () => 3,
      getAudioTrackCount: async () => 4,
      getCaptionTrackCount: async () => 0,
      getSettings: async () => ({ getVideoFrameRate: () => ({ value: 29.97 }) }),
    };

    const status = await readSequenceStatus({
      project: { name: "Project", path: "C:\\Project.prproj", guid: "project-guid" },
      sequence,
    } as never);

    assert.equal(status.selectedItemCount, 2);
    assert.equal(status.selectedVideoCount, 1);
    assert.equal(status.selectedStart, 4);
    assert.equal(status.selectedEnd, 14);
    assert.equal(status.playerPosition, 9);
  });

  it("falls back to TrackItem getIsSelected when Premiere selection returns an empty collection", async () => {
    const videoSelected = {
      ...selectedItem(2, 6, "video"),
      getIsSelected: async () => true,
    };
    const videoUnselected = {
      ...selectedItem(20, 24, "video"),
      getIsSelected: async () => false,
    };
    const audioSelected = {
      ...selectedItem(3, 8, "audio"),
      getIsSelected: async () => true,
    };
    const sequence = {
      name: "Host Selection Fallback",
      guid: "sequence-guid",
      getFrameSize: async () => ({ width: 1080, height: 1920 }),
      getEndTime: async () => ({ seconds: 30 }),
      getInPoint: async () => ({ seconds: 0 }),
      getOutPoint: async () => ({ seconds: 30 }),
      getPlayerPosition: async () => ({ seconds: 4 }),
      getSelection: async () => ({
        getTrackItems: async () => [],
      }),
      getVideoTrackCount: async () => 1,
      getAudioTrackCount: async () => 1,
      getCaptionTrackCount: async () => 0,
      getVideoTrack: async () => ({
        getTrackItems: () => [videoSelected, videoUnselected],
      }),
      getAudioTrack: async () => ({
        getTrackItems: () => [audioSelected],
      }),
      getSettings: async () => ({ getVideoFrameRate: () => ({ value: 30 }) }),
    };

    const status = await readSequenceStatus({
      project: { name: "Project", path: "C:\\Project.prproj", guid: "project-guid" },
      sequence,
    } as never);

    assert.equal(status.selectedItemCount, 2);
    assert.equal(status.selectedVideoCount, 1);
    assert.equal(status.selectedStart, 2);
    assert.equal(status.selectedEnd, 8);
  });

  it("falls back to TrackItem getIsSelected when Premiere selection inspection fails", async () => {
    const videoSelected = {
      ...selectedItem(5, 9, "video"),
      getIsSelected: async () => true,
    };
    const sequence = {
      name: "Selection Failure With Fallback",
      guid: "sequence-guid",
      getFrameSize: async () => ({ width: 1080, height: 1920 }),
      getEndTime: async () => ({ seconds: 10 }),
      getInPoint: async () => ({ seconds: 0 }),
      getOutPoint: async () => ({ seconds: 10 }),
      getPlayerPosition: async () => ({ seconds: 1 }),
      getSelection: async () => ({
        getTrackItems: async () => {
          throw new Error("Host selection unavailable");
        },
      }),
      getVideoTrackCount: async () => 1,
      getAudioTrackCount: async () => 0,
      getCaptionTrackCount: async () => 0,
      getVideoTrack: async () => ({
        getTrackItems: () => [videoSelected],
      }),
      getAudioTrack: async () => ({
        getTrackItems: () => [],
      }),
      getSettings: async () => ({ getVideoFrameRate: () => ({ value: 30 }) }),
    };

    const status = await readSequenceStatus({
      project: { name: "Project", path: "C:\\Project.prproj", guid: "project-guid" },
      sequence,
    } as never);

    assert.equal(status.selectedItemCount, 1);
    assert.equal(status.selectedVideoCount, 1);
    assert.equal(status.selectedStart, 5);
    assert.equal(status.selectedEnd, 9);
  });

  it("keeps the status read safe when Premiere selection and fallback inspection fail", async () => {
    const sequence = {
      name: "Selection Failure",
      guid: "sequence-guid",
      getFrameSize: async () => ({ width: 1080, height: 1920 }),
      getEndTime: async () => ({ seconds: 10 }),
      getInPoint: async () => ({ seconds: 0 }),
      getOutPoint: async () => ({ seconds: 10 }),
      getPlayerPosition: async () => ({ seconds: 1 }),
      getSelection: async () => ({
        getTrackItems: async () => {
          throw new Error("Host selection unavailable");
        },
      }),
      getVideoTrackCount: async () => 1,
      getAudioTrackCount: async () => 1,
      getCaptionTrackCount: async () => 0,
      getVideoTrack: async () => {
        throw new Error("video track unavailable");
      },
      getAudioTrack: async () => ({
        getTrackItems: () => {
          throw new Error("audio items unavailable");
        },
      }),
      getSettings: async () => ({ getVideoFrameRate: () => ({ value: 30 }) }),
    };

    const status = await readSequenceStatus({
      project: { name: "Project", path: "C:\\Project.prproj", guid: "project-guid" },
      sequence,
    } as never);

    assert.equal(status.selectedItemCount, 0);
    assert.equal(status.selectedVideoCount, 0);
    assert.equal(status.selectedStart, null);
    assert.equal(status.selectedEnd, null);
  });

  it("falls back the out point to the sequence end when the Host reports no out point", async () => {
    const sequence = {
      name: "No Out Point",
      guid: "sequence-guid",
      getFrameSize: async () => ({ width: 1080, height: 1920 }),
      getEndTime: async () => ({ seconds: 24 }),
      getInPoint: async () => ({ seconds: 6 }),
      getOutPoint: async () => { throw new Error("no out point set"); },
      getPlayerPosition: async () => ({ seconds: 0 }),
      getSelection: async () => null,
      getVideoTrackCount: async () => 1,
      getAudioTrackCount: async () => 1,
      getCaptionTrackCount: async () => 0,
      getSettings: async () => ({ getVideoFrameRate: () => ({ value: 30 }) }),
    };

    const status = await readSequenceStatus({
      project: { name: "Project", path: "C:\\Project.prproj", guid: "project-guid" },
      sequence,
    } as never);

    assert.equal(status.outPoint, 24);
    assert.equal(status.effectiveStart, 6);
    assert.equal(status.effectiveEnd, 24);
    assert.equal(status.effectiveDuration, 18);
  });
});

describe("scanSequenceMediaQC", () => {
  function mediaItem(name: string, id: string, offline = false) {
    return {
      getName: async () => name,
      getProjectItem: async () => ({
        getId: () => id,
        isOffline: async () => offline,
      }),
    };
  }

  function sequenceWithMedia(videoItems: unknown[], audioItems: unknown[] = []) {
    return {
      getVideoTrackCount: async () => 1,
      getAudioTrackCount: async () => audioItems.length > 0 ? 1 : 0,
      getVideoTrack: async () => ({
        getTrackItems: () => videoItems,
      }),
      getAudioTrack: async () => ({
        getTrackItems: () => audioItems,
      }),
    };
  }

  it("preserves media QC result shape while respecting the scan limit", async () => {
    const status = await scanSequenceMediaQC(3, {
      context: {
        project: { name: "Project", guid: "project-guid" },
        sequence: sequenceWithMedia([
          mediaItem("clip-01.mp4", "asset-1", true),
          mediaItem("__SHORTFLOW_SAFE_GUIDE_DO_NOT_EXPORT__safe-zone.bmp", "asset-2"),
          mediaItem("clip-03.mp4", "asset-3"),
          mediaItem("clip-04.mp4", "asset-4", true),
        ]),
      } as never,
      concurrency: 2,
    });

    assert.deepEqual(status.offlineMedia, ["clip-01.mp4"]);
    assert.deepEqual(status.guideOverlays, ["__SHORTFLOW_SAFE_GUIDE_DO_NOT_EXPORT__safe-zone.bmp"]);
    assert.equal(status.scannedItems, 3);
    assert.equal(status.truncated, true);
  });

  it("bounds TrackItem inspection concurrency for long timelines", async () => {
    let active = 0;
    let maxActive = 0;
    let completed = 0;
    const releases: Array<() => void> = [];
    const total = 9;
    const items = Array.from({ length: total }, (_value, index) => ({
      getName: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        return new Promise<string>((resolve) => {
          releases.push(() => {
            active -= 1;
            completed += 1;
            resolve(`clip-${index + 1}.mp4`);
          });
        });
      },
      getProjectItem: async () => ({
        getId: () => `asset-${index + 1}`,
        isOffline: async () => false,
      }),
    }));

    const pending = scanSequenceMediaQC(total, {
      context: {
        project: { name: "Project", guid: "project-guid" },
        sequence: sequenceWithMedia(items),
      } as never,
      concurrency: 3,
    });

    while (completed < total) {
      while (releases.length === 0) await Promise.resolve();
      const batch = releases.splice(0);
      for (const release of batch) release();
      await Promise.resolve();
    }
    const status = await pending;

    assert.equal(status.scannedItems, total);
    assert.equal(status.truncated, false);
    assert.equal(maxActive, 3);
  });

  it("deduplicates offline media by project-item id across differently named clips", async () => {
    const shared = (name: string) => ({
      getName: async () => name,
      getProjectItem: async () => ({ getId: () => "shared-asset", isOffline: async () => true }),
    });
    const status = await scanSequenceMediaQC(10, {
      context: {
        project: { name: "Project", guid: "project-guid" },
        sequence: sequenceWithMedia([shared("timeline-a.mp4"), shared("timeline-b.mp4")]),
      } as never,
      concurrency: 1,
    });

    assert.deepEqual(status.offlineMedia, ["timeline-a.mp4"]);
    assert.equal(status.scannedItems, 2);
    assert.equal(status.truncated, false);
  });

  it("labels unnamed offline media and scans audio-track clips", async () => {
    const status = await scanSequenceMediaQC(10, {
      context: {
        project: { name: "Project", guid: "project-guid" },
        sequence: sequenceWithMedia([], [mediaItem("", "audio-asset", true)]),
      } as never,
      concurrency: 1,
    });

    assert.deepEqual(status.offlineMedia, ["이름 없는 오프라인 미디어"]);
    assert.equal(status.scannedItems, 1);
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

  it("treats Motion positions within the +/-2 unit threshold as normalized coordinates", () => {
    assert.deepEqual(centeredPosition({ x: 2, y: -2 }, 1080, 1920), { x: 0.5, y: 0.5 });
    assert.deepEqual(centeredPosition({ x: 2.1, y: 0 }, 1080, 1920), { x: 540, y: 960 });
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

describe("buildExportFilename", () => {
  it("builds deterministic export names from sanitized sequence names and extensions", () => {
    const date = new Date(2026, 6, 11, 12, 34, 56);
    assert.equal(exportTimestamp(date), "20260711-123456");
    assert.equal(
      buildExportFilename("Client: Interview / Final", ".MP4", date),
      "Client_ Interview _ Final_20260711-123456.mp4",
    );
  });

  it("falls back from unsafe sequence names and codec extensions", () => {
    const date = new Date(2026, 0, 2, 3, 4, 5);
    assert.equal(
      buildExportFilename("\n\t", "../exe", date),
      "shortflow_20260102-030405.mp4",
    );
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

describe("Premiere import path boundary", () => {
  it("builds a deterministic opaque project+sequence key without exposing GUIDs or paths", () => {
    const key = premiereContextKey("project-guid-secret", "sequence-guid-secret");
    assert.match(key, /^ctx_[a-z0-9]{7}_[a-z0-9]{7}$/u);
    assert.equal(key, premiereContextKey("project-guid-secret", "sequence-guid-secret"));
    assert.notEqual(key, premiereContextKey("project-guid-secret", "other-sequence"));
    assert.doesNotMatch(key, /project|sequence|guid|[\\/]/u);
    assert.throws(
      () => premiereContextKey("", "sequence"),
      (error) => assertShortFlowError(error, "INVALID_HOST_CONTEXT"),
    );
  });

  it("accepts absolute Windows, UNC, and POSIX native file paths", () => {
    assert.equal(validatePremiereImportPath("C:\\Media\\voice.wav"), "C:\\Media\\voice.wav");
    assert.equal(validatePremiereImportPath("\\\\NAS\\Share\\captions.srt"), "\\\\NAS\\Share\\captions.srt");
    assert.equal(validatePremiereImportPath("/Users/editor/captions.srt"), "/Users/editor/captions.srt");
  });

  it("rejects relative, traversal, folder, extensionless, control-character, and non-string paths", () => {
    for (const value of [
      "captions.srt",
      "C:\\Media\\..\\captions.srt",
      "C:\\Media\\",
      "C:\\Media\\caption",
      "C:\\Media\\bad\nname.srt",
      "https://example.com/captions.srt",
      null,
    ]) {
      assert.throws(
        () => validatePremiereImportPath(value),
        (error) => assertShortFlowError(error, "INVALID_IMPORT_PATH"),
      );
    }
  });

  it("preflights asset insertion without touching the Premiere host", () => {
    assert.deepEqual(
      prepareInsertAssetPreflight("C:\\Media\\whoosh.wav", {
        videoTrackIndex: 0,
        audioTrackIndex: 2,
        displayName: "  효과음\n삽입  ",
        durationSeconds: "5.5" as never,
        expectedContextKey: " ctx_abc ",
      }),
      {
        assetPath: "C:\\Media\\whoosh.wav",
        videoTrackIndex: 0,
        audioTrackIndex: 2,
        displayName: "효과음 삽입",
        durationSeconds: 5.5,
        expectedContextKey: "ctx_abc",
      },
    );
  });

  it("rejects unsafe asset insertion inputs before Premiere host access", () => {
    assert.throws(
      () => prepareInsertAssetPreflight("relative.wav", { videoTrackIndex: 0, audioTrackIndex: 0 }),
      (error) => assertShortFlowError(error, "INVALID_IMPORT_PATH"),
    );
    assert.throws(
      () => prepareInsertAssetPreflight("C:\\Media\\whoosh.wav", null as never),
      (error) => assertShortFlowError(error, "INVALID_INSERT_OPTIONS"),
    );
    assert.throws(
      () => prepareInsertAssetPreflight("C:\\Media\\whoosh.wav", { videoTrackIndex: 99, audioTrackIndex: 0 }),
      (error) => assertShortFlowError(error, "INVALID_TRACK"),
    );
    assert.throws(
      () => prepareInsertAssetPreflight("C:\\Media\\whoosh.wav", { videoTrackIndex: 0, audioTrackIndex: 0, durationSeconds: 0 }),
      (error) => assertShortFlowError(error, "INVALID_ASSET_DURATION"),
    );
  });

  it("validates duration and track options before resolving a Premiere host context", () => {
    const source = readFileSync(path.resolve(__dirname, "../../src/premiere.ts"), "utf8");
    const functionStart = source.indexOf("export async function importAndInsertAsset");
    const functionEnd = source.indexOf("export function errorMessage", functionStart);
    const body = source.slice(functionStart, functionEnd);
    assert.ok(body.indexOf("prepareInsertAssetPreflight(nativePath, options)") < body.indexOf("getExpectedActiveContext(preflight.expectedContextKey)"));
    assert.match(body, /findImportedItem\(bin, assetPath, new Set<string>\(\)\)/u);
    assert.match(body, /if \(!imported\)[\s\S]*ASSET_IMPORT_FAILED/u);
    assert.match(body, /getExpectedActiveContext\(preflight\.expectedContextKey\)/u);
    assert.ok((body.match(/assertActiveContextKey\(contextKey\)/gu) ?? []).length >= 3);
    const bulkStart = source.indexOf("export async function importFilesToProject");
    const bulkBody = source.slice(bulkStart, functionStart);
    assert.match(bulkBody, /if \(!existing\) pendingPaths\.push\(path\)/u);
    assert.match(bulkBody, /if \(pendingPaths\.length === 0\) return 0/u);
    assert.match(bulkBody, /PROJECT_IMPORT_FAILED/u);
    assert.match(bulkBody, /getExpectedActiveContext\(expectedContext\)/u);
    assert.match(bulkBody, /assertActiveContextKey\(contextKey\)/u);
  });

  it("keeps the production insert transaction behind the audio collision gate", () => {
    const source = readFileSync(path.resolve(__dirname, "../../src/premiere.ts"), "utf8");
    const functionStart = source.indexOf("export async function importAndInsertAsset");
    const functionEnd = source.indexOf("export function errorMessage", functionStart);
    const body = source.slice(functionStart, functionEnd);
    assert.match(body, /audioProjectItemDurationSeconds\(clipProjectItem, audioMediaType\)/u);
    assert.match(body, /commitTimelineInsertAfterPreflight/u);
    const guardIndex = body.indexOf("assertAudioInsertRangeAvailable(");
    const actionIndex = body.indexOf("createInsertProjectItemAction(");
    assert.ok(guardIndex >= 0 && guardIndex < actionIndex);
  });

  it("rechecks the source Host context immediately before cloning for automation", () => {
    const source = readFileSync(path.resolve(__dirname, "../../src/premiere.ts"), "utf8");
    const cloneStart = source.indexOf("async function cloneSequence");
    const cloneEnd = source.indexOf("async function setSequenceFrame", cloneStart);
    const cloneBody = source.slice(cloneStart, cloneEnd);
    assert.ok(cloneBody.indexOf("await beforeCommit?.()") < cloneBody.indexOf("commitActionFactories(project"));
    assert.match(cloneBody, /beforeCommit\?: \(\) => void \| Promise<void>/u);

    const applyStart = source.indexOf("export async function applyAutomationPlan");
    const applyEnd = source.indexOf("export function translateSafeZonePosition", applyStart);
    const applyBody = source.slice(applyStart, applyEnd);
    assert.match(applyBody, /const sourceContextKey = premiereContextKey\(project\.guid, source\.guid\)/u);
    assert.match(applyBody, /\(\) => assertActiveContextKey\(sourceContextKey\)/u);
    assert.ok(applyBody.indexOf("const sourceContextKey") < applyBody.indexOf("const clone = await cloneSequence"));
  });

  it("rechecks the active Host context before committing Safe Zone alignment", () => {
    const source = readFileSync(path.resolve(__dirname, "../../src/premiere.ts"), "utf8");
    const functionStart = source.indexOf("export async function alignSelectedVideoToSafeZone");
    const functionEnd = source.indexOf("function unwrapPickerResult", functionStart);
    const body = source.slice(functionStart, functionEnd);
    assert.match(body, /const \{ project, sequence, contextKey \} = await getExpectedActiveContext\(\)/u);
    assert.ok(body.indexOf("await assertActiveContextKey(contextKey)") < body.indexOf("commitActionFactories(project, actions"));
    assert.equal((body.match(/assertActiveContextKey\(contextKey\)/gu) ?? []).length, 1);
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

describe("audio timeline insertion collision gate", () => {
  function trackItem(start: number, end: number) {
    return {
      getStartTime: async () => ({ seconds: start }),
      getEndTime: async () => ({ seconds: end }),
    };
  }

  function sequenceProbe(
    items: readonly unknown[],
    options: { count?: number; actualIndex?: number; getItemsError?: boolean } = {},
  ) {
    const count = options.count ?? 2;
    const actualIndex = options.actualIndex ?? 1;
    return {
      getAudioTrackCount: async () => count,
      getAudioTrack: async () => ({
        getIndex: async () => actualIndex,
        getTrackItems: (type: unknown, includeEmpty: boolean) => {
          assert.equal(type, "clip");
          assert.equal(includeEmpty, false);
          if (options.getItemsError) throw new Error("track unavailable");
          return [...items];
        },
      }),
    };
  }

  function transactionCounter() {
    let calls = 0;
    return {
      project: {
        executeTransaction: () => {
          calls += 1;
          return true;
        },
      },
      calls: () => calls,
    };
  }

  it("derives a finite audio duration only from public ClipProjectItem In/Out APIs", async () => {
    const requestedTypes: string[] = [];
    assert.equal(await audioProjectItemDurationSeconds({
      getInPoint: async (mediaType: string) => {
        requestedTypes.push(mediaType);
        return { seconds: 0.5 };
      },
      getOutPoint: async (mediaType: string) => {
        requestedTypes.push(mediaType);
        return { seconds: 3 };
      },
    }, "audio"), 2.5);
    assert.deepEqual(requestedTypes, ["audio", "audio"]);

    await assert.rejects(
      audioProjectItemDurationSeconds({
        getInPoint: async () => ({ seconds: 0 }),
        getOutPoint: async () => ({ seconds: 0 }),
      }, "audio"),
      (error: unknown) => assertShortFlowError(error, "ASSET_AUDIO_DURATION_UNAVAILABLE"),
    );
  });

  it("allows clips adjacent to both insertion boundaries and commits once", async () => {
    const sequence = sequenceProbe([trackItem(0, 5), trackItem(7, 9)]);
    const transaction = transactionCounter();
    await commitTimelineInsertAfterPreflight(
      () => assertAudioInsertRangeAvailable(sequence, 1, { seconds: 5 }, 2, "clip"),
      () => transaction.project.executeTransaction(),
    );
    assert.equal(transaction.calls(), 1);
  });

  it("blocks an occupied playhead interval before executeTransaction", async () => {
    const sequence = sequenceProbe([trackItem(4.5, 5.5)]);
    const transaction = transactionCounter();
    await assert.rejects(
      commitTimelineInsertAfterPreflight(
        () => assertAudioInsertRangeAvailable(sequence, 1, { seconds: 5 }, 2, "clip"),
        () => transaction.project.executeTransaction(),
      ),
      (error: unknown) => assertShortFlowError(error, "AUDIO_TRACK_COLLISION"),
    );
    assert.equal(transaction.calls(), 0);
  });

  it("blocks a nonexistent or unavailable audio track before executeTransaction", async () => {
    for (const scenario of [
      { sequence: sequenceProbe([], { count: 1 }), code: "INVALID_AUDIO_TRACK" },
      { sequence: sequenceProbe([], { getItemsError: true }), code: "AUDIO_TRACK_UNAVAILABLE" },
      { sequence: sequenceProbe([], { actualIndex: 0 }), code: "AUDIO_TRACK_UNAVAILABLE" },
    ]) {
      const transaction = transactionCounter();
      await assert.rejects(
        commitTimelineInsertAfterPreflight(
          () => assertAudioInsertRangeAvailable(scenario.sequence, 1, { seconds: 5 }, 2, "clip"),
          () => transaction.project.executeTransaction(),
        ),
        (error: unknown) => assertShortFlowError(error, scenario.code),
      );
      assert.equal(transaction.calls(), 0, scenario.code);
    }
  });

  it("reports transaction rejection without claiming the track is locked", async () => {
    let transactionCalls = 0;
    await assert.rejects(
      commitTimelineInsertAfterPreflight(
        async () => undefined,
        () => {
          transactionCalls += 1;
          return false;
        },
      ),
      (error: unknown) => {
        assertShortFlowError(error, "ASSET_INSERT_TRANSACTION_REJECTED");
        assert.ok(error instanceof ShortFlowError);
        assert.match(error.message, /잠금 상태를 미리 확인할 수 없/u);
        assert.doesNotMatch(error.message, /잠겼/u);
        return true;
      },
    );
    assert.equal(transactionCalls, 1);
  });

  it("detects a collision anywhere inside the insertion range, not only at the playhead", async () => {
    // Insertion range is [5, 10]; the clip [7, 8] touches neither boundary but sits mid-range.
    await assert.rejects(
      assertAudioInsertRangeAvailable(sequenceProbe([trackItem(7, 8)]), 1, { seconds: 5 }, 5, "clip"),
      (error: unknown) => assertShortFlowError(error, "AUDIO_TRACK_COLLISION"),
    );
    // A clip that fully spans the range also collides.
    await assert.rejects(
      assertAudioInsertRangeAvailable(sequenceProbe([trackItem(3, 12)]), 1, { seconds: 5 }, 5, "clip"),
      (error: unknown) => assertShortFlowError(error, "AUDIO_TRACK_COLLISION"),
    );
  });

  it("returns a frozen insertion range when the whole span is clear of clips", async () => {
    const range = await assertAudioInsertRangeAvailable(
      sequenceProbe([trackItem(0, 4), trackItem(11, 13)]),
      1,
      { seconds: 5 },
      5,
      "clip",
    );
    assert.deepEqual({ ...range }, { start: 5, end: 10, duration: 5 });
    assert.ok(Object.isFrozen(range));
  });

  it("rejects invalid audio track indices before probing the sequence", async () => {
    const probe = sequenceProbe([]);
    for (const index of [-1, 99, 1.5]) {
      await assert.rejects(
        assertAudioInsertRangeAvailable(probe, index, { seconds: 1 }, 1, "clip"),
        (error: unknown) => assertShortFlowError(error, "INVALID_AUDIO_TRACK"),
      );
    }
  });

  it("rejects an unusable insertion time or duration before probing the sequence", async () => {
    const probe = sequenceProbe([]);
    for (const [insertion, duration] of [
      [{ seconds: -1 }, 2],
      [{ seconds: Number.NaN }, 2],
      [{ seconds: 5 }, 0],
      [{ seconds: 5 }, 90_000],
    ] as const) {
      await assert.rejects(
        assertAudioInsertRangeAvailable(probe, 1, insertion, duration, "clip"),
        (error: unknown) => assertShortFlowError(error, "AUDIO_INSERT_RANGE_UNAVAILABLE"),
      );
    }
  });

  it("rejects a non-numeric, negative, or failing audio track count", async () => {
    for (const getAudioTrackCount of [
      async () => "4" as unknown as number,
      async () => -1,
      async () => { throw new Error("no track count"); },
    ]) {
      await assert.rejects(
        assertAudioInsertRangeAvailable({ getAudioTrackCount } as never, 1, { seconds: 5 }, 2, "clip"),
        (error: unknown) => assertShortFlowError(error, "AUDIO_TRACK_UNAVAILABLE"),
      );
    }
  });

  it("rejects an audio track whose clip count exceeds the safety cap", async () => {
    const tooMany = Array.from({ length: 5_001 }, () => ({}));
    const sequence = {
      getAudioTrackCount: async () => 2,
      getAudioTrack: async () => ({
        getIndex: async () => 1,
        getTrackItems: () => tooMany,
      }),
    };
    await assert.rejects(
      assertAudioInsertRangeAvailable(sequence as never, 1, { seconds: 5 }, 2, "clip"),
      (error: unknown) => assertShortFlowError(error, "AUDIO_TRACK_UNAVAILABLE"),
    );
  });

  it("rejects an audio track item that hides its time-range API", async () => {
    const sequence = {
      getAudioTrackCount: async () => 2,
      getAudioTrack: async () => ({
        getIndex: async () => 1,
        getTrackItems: () => [{}],
      }),
    };
    await assert.rejects(
      assertAudioInsertRangeAvailable(sequence as never, 1, { seconds: 5 }, 2, "clip"),
      (error: unknown) => assertShortFlowError(error, "AUDIO_TRACK_UNAVAILABLE"),
    );
  });

  it("aborts when In/Out probing throws or yields an out-of-bounds duration", async () => {
    for (const item of [
      { getInPoint: async () => { throw new Error("no in point"); }, getOutPoint: async () => ({ seconds: 5 }) },
      { getInPoint: async () => ({ seconds: -1 }), getOutPoint: async () => ({ seconds: 5 }) },
      { getInPoint: async () => ({ seconds: 0 }), getOutPoint: async () => ({ seconds: 90_000 }) },
    ]) {
      await assert.rejects(
        audioProjectItemDurationSeconds(item, "audio"),
        (error: unknown) => assertShortFlowError(error, "ASSET_AUDIO_DURATION_UNAVAILABLE"),
      );
    }
  });
});

describe("automation clone preparation and clip-local punch planning", () => {
  const cue = (start: number, end: number, scale = 120) => ({
    start,
    end,
    scale,
    reason: "test",
    text: "punch",
  });

  it("keeps a cue that covers the whole clip zoomed through both clip boundaries", () => {
    assert.deepEqual(planClipPunchKeyframes(1, 3, 100, [cue(0, 4)]), [
      { time: 0, value: 120 },
      { time: 2, value: 120 },
    ]);
  });

  it("adds reset values only at clip-local boundaries where the cue actually ends", () => {
    assert.deepEqual(planClipPunchKeyframes(1, 4, 100, [cue(0.5, 2)]), [
      { time: 0, value: 120 },
      { time: 1, value: 120 },
      { time: 1.1, value: 100 },
    ]);
    assert.deepEqual(planClipPunchKeyframes(1, 4, 100, [cue(3, 5)]), [
      { time: 1.9, value: 100 },
      { time: 2, value: 120 },
      { time: 3, value: 120 },
    ]);
    assert.deepEqual(planClipPunchKeyframes(1, 5, 100, [cue(2, 3)]), [
      { time: 0.9, value: 100 },
      { time: 1, value: 120 },
      { time: 2, value: 120 },
      { time: 2.1, value: 100 },
    ]);
  });

  it("reports requested punch cues that have no applicable video clip", () => {
    assert.equal(punchApplicabilityWarning(0, 0, 0), null);
    assert.equal(punchApplicabilityWarning(1, 0, 0), "펀치인 대상 비디오 클립이 없어 추천 마커만 유지했습니다.");
    assert.equal(punchApplicabilityWarning(1, 2, 0), "펀치인을 적용할 수 있는 비디오 클립이 없어 추천 마커만 유지했습니다.");
    assert.equal(punchApplicabilityWarning(1, 2, 1), null);
  });

  it("removes a discovered clone when rename, open, or activation preparation fails", async () => {
    for (const failure of ["rename", "open", "activate"] as const) {
      const sequences: Array<Record<string, unknown>> = [];
      const actions: string[] = [];
      let active: unknown = null;
      const cloneItem = {
        createSetNameAction: () => ({ kind: "rename" }),
        getParentBin: () => ({ createRemoveItemAction: () => ({ kind: "remove" }) }),
      };
      const clone = {
        guid: `clone-${failure}`,
        name: "Clone",
        getProjectItem: async () => cloneItem,
      };
      const source = {
        guid: `source-${failure}`,
        name: "Source",
        createCloneAction: () => ({ kind: "clone" }),
      };
      sequences.push(source);
      const project = {
        getSequences: async () => [...sequences],
        lockedAccess: (callback: () => void) => callback(),
        executeTransaction: (callback: (compound: { addAction(action: { kind: string }): boolean }) => void) => {
          callback({
            addAction: (action) => {
              actions.push(action.kind);
              if (action.kind === "clone") sequences.push(clone);
              if (action.kind === "remove") sequences.splice(sequences.indexOf(clone), 1);
              return !(failure === "rename" && action.kind === "rename");
            },
          });
          return true;
        },
        openSequence: async () => {
          if (failure === "open") throw new Error("open failed");
          return true;
        },
        setActiveSequence: async (sequence: unknown) => {
          if (failure === "activate" && sequence === clone) return false;
          active = sequence;
          return true;
        },
      } as unknown as Project;

      await assert.rejects(() => cloneSequence(project, source as unknown as never, "Prepared Clone"));
      assert.deepEqual(sequences, [source], `${failure} failure left an orphan clone`);
      assert.equal(active, source, `${failure} failure did not reactivate the source`);
      assert.ok(actions.includes("remove"), `${failure} failure did not remove the clone`);
    }
  });

  it("keeps clone GUID, context, and recovery hook failures inside the cleanup boundary", () => {
    const source = readFileSync(path.resolve(__dirname, "../../src/premiere.ts"), "utf8");
    const functionStart = source.indexOf("export async function applyAutomationPlan");
    const functionEnd = source.indexOf("export function translateSafeZonePosition", functionStart);
    const body = source.slice(functionStart, functionEnd);
    const guardedStart = body.indexOf("try {");
    assert.ok(guardedStart >= 0);
    assert.ok(guardedStart < body.indexOf("cloneGuid = guidKey(clone.guid)"));
    assert.ok(guardedStart < body.indexOf("const cloneContextKey = premiereContextKey"));
    assert.ok(guardedStart < body.indexOf("await hooks.onClonePrepared?."));
    assert.match(body, /catch \(error\)[\s\S]*removeKnownClonedSequenceFromProject\(project, source, clone\)/u);
  });

  it("renames, opens, and activates the newly discovered clone on the happy path", async () => {
    const sequences: Array<Record<string, unknown>> = [];
    const events: string[] = [];
    let active: unknown = null;
    const cloneItem = { createSetNameAction: (name: string) => ({ kind: "rename", name }) };
    const clone = { guid: "clone-guid", name: "Untitled Clone", getProjectItem: async () => cloneItem };
    const source = { guid: "source-guid", name: "Source", createCloneAction: () => ({ kind: "clone" }) };
    sequences.push(source);
    const project = {
      getSequences: async () => [...sequences],
      getActiveSequence: async () => active,
      lockedAccess: (callback: () => void) => callback(),
      executeTransaction: (callback: (compound: { addAction(action: { kind: string }): boolean }) => void) => {
        callback({
          addAction: (action) => {
            events.push(action.kind);
            if (action.kind === "clone") sequences.push(clone);
            return true;
          },
        });
        return true;
      },
      openSequence: async () => { events.push("open"); return true; },
      setActiveSequence: async (sequence: unknown) => { active = sequence; events.push("activate"); return true; },
    } as unknown as Project;

    const result = await cloneSequence(project, source as unknown as never, "My Short");
    assert.equal(result, clone);
    assert.equal(active, clone);
    assert.deepEqual(sequences, [source, clone]);
    assert.deepEqual(events, ["clone", "rename", "open", "activate"]);
  });

  it("throws CLONE_FAILED when Premiere rejects the clone transaction", async () => {
    const source = { guid: "s", name: "Source", createCloneAction: () => ({ kind: "clone" }) };
    const project = {
      getSequences: async () => [source],
      lockedAccess: (callback: () => void) => callback(),
      executeTransaction: () => false,
    } as unknown as Project;
    await assert.rejects(
      () => cloneSequence(project, source as unknown as never, "X"),
      (error) => assertShortFlowError(error, "CLONE_FAILED"),
    );
  });

  it("returns no punch keyframes for invalid clip ranges or non-overlapping cues", () => {
    assert.deepEqual(planClipPunchKeyframes(Number.NaN, 3, 100, [cue(0, 4)]), []);
    assert.deepEqual(planClipPunchKeyframes(3, 3, 100, [cue(0, 4)]), []);
    assert.deepEqual(planClipPunchKeyframes(1, 3, Number.NaN, [cue(0, 4)]), []);
    assert.deepEqual(planClipPunchKeyframes(1, 3, 100, [cue(5, 6)]), []);
  });

  it("clamps the punch zoom multiplier to its 1.01x floor and 1.5x ceiling", () => {
    assert.deepEqual(planClipPunchKeyframes(0, 2, 200, [cue(0, 2, 100)]), [
      { time: 0, value: 202 },
      { time: 2, value: 202 },
    ]);
    assert.deepEqual(planClipPunchKeyframes(0, 2, 200, [cue(0, 2, 300)]), [
      { time: 0, value: 300 },
      { time: 2, value: 300 },
    ]);
  });
});

describe("automation host validation", () => {
  it("accepts exactly 500 combined markers and rejects 501 before mutation", () => {
    const exact = markerPlan(499);
    const cue = { start: 499, end: 500, scale: 112, reason: "test", text: "punch" };
    assert.doesNotThrow(() => assertAutomationPlan(exact, [cue]));
    assert.throws(
      () => assertAutomationPlan(markerPlan(500), [{ ...cue, start: 500, end: 501 }]),
      (error) => assertShortFlowError(error, "TOO_MANY_AUTOMATION_MARKERS"),
    );
  });

  it("rejects non-finite, reversed, out-of-source, and inconsistent ranges without mutation", () => {
    const cases = [
      (plan: SilenceCutPlan) => { plan.cuts[0]!.start = Number.NaN; },
      (plan: SilenceCutPlan) => { plan.cuts[0]!.end = -1; },
      (plan: SilenceCutPlan) => { plan.cuts[0]!.end = plan.sourceDuration + 1; },
      (plan: SilenceCutPlan) => { plan.cuts[0]!.duration = 999; },
    ];
    for (const mutate of cases) {
      const plan = markerPlan(1);
      mutate(plan);
      const snapshot = structuredClone(plan);
      assert.throws(
        () => assertAutomationPlan(plan, []),
        (error) => assertShortFlowError(error, "INVALID_AUTOMATION_PLAN"),
      );
      assert.deepEqual(plan, snapshot);
    }
  });

  it("rejects malformed or source-outside punch cues", () => {
    const plan = markerPlan(1);
    for (const cue of [
      { start: 1, end: 3, scale: 112, reason: "outside", text: "outside" },
      { start: 1.5, end: 1, scale: 112, reason: "reverse", text: "reverse" },
      { start: 1, end: 2, scale: Number.NaN, reason: "nan", text: "nan" },
    ]) {
      assert.throws(
        () => assertAutomationPlan(plan, [cue]),
        (error) => assertShortFlowError(error, "INVALID_AUTOMATION_PLAN"),
      );
    }
  });

  it("rejects a tampered cut that overlaps protected speech", () => {
    const plan = markerPlan(1);
    plan.speech = [{ start: 0.25, end: 0.75, duration: 0.5 }];
    assert.throws(
      () => assertAutomationPlan(plan, []),
      (error) => assertShortFlowError(error, "INVALID_AUTOMATION_PLAN"),
    );
  });

  it("removes only a verified clone through the official project transaction path", async () => {
    const source = { guid: "source" };
    const removeAction = { kind: "remove-clone" };
    const cloneItem = {
      getParentBin: () => ({ createRemoveItemAction: (item: unknown) => item === cloneItem ? removeAction : null }),
    };
    const clone = { guid: "clone", getProjectItem: async () => cloneItem };
    let active: unknown = null;
    let added: unknown = null;
    const project = {
      getSequences: async () => [source, clone],
      setActiveSequence: async (sequence: unknown) => { active = sequence; return true; },
      lockedAccess: (callback: () => void) => callback(),
      executeTransaction: (callback: (compound: { addAction(action: unknown): boolean }) => void) => {
        callback({ addAction: (action) => { added = action; return true; } });
        return true;
      },
    } as unknown as Project;
    await removeVerifiedClonedSequenceFromProject(project, "source", "clone");
    assert.equal(active, source);
    assert.equal(added, removeAction);
  });

  it("keeps silence cuts as SF CUT review markers and contains no QE/private razor path", () => {
    const source = readFileSync(path.resolve(__dirname, "../../src/premiere.ts"), "utf8");
    assert.match(source, /no supported razor-at-time action/u);
    assert.match(source, /SF CUT 검토 마커/u);
    assert.doesNotMatch(source, /enableQE|\.qe\b|QE DOM/iu);
    assert.match(source, /removeVerifiedClonedSequenceFromProject\(project, sourceGuid, cloneGuid\)/u);
  });
});

describe("Safe Zone Motion alignment", () => {
  const alignment: SafeZoneAlignment = {
    rect: { x: 0.1, y: 0.2, width: 0.4, height: 0.4 },
    deltaX: 0.1,
    deltaY: 0.2,
    scale: 0.8,
    changed: true,
    wasOversized: true,
  };

  it("rechecks the active Host context immediately before Safe Zone alignment mutations", () => {
    const source = readFileSync(path.resolve(__dirname, "../../src/premiere.ts"), "utf8");
    const start = source.indexOf("export async function alignSelectedVideoToSafeZone");
    const end = source.indexOf("function unwrapPickerResult", start);
    const body = source.slice(start, end);
    assert.match(body, /getExpectedActiveContext\(\)/u);
    assert.match(body, /await assertActiveContextKey\(contextKey\)/u);
    assert.ok(body.indexOf("await assertActiveContextKey(contextKey)") < body.indexOf("commitActionFactories(project"));
  });

  it("translates normalized and pixel PointF values in their own coordinate spaces", () => {
    assert.deepEqual(translateSafeZonePosition({ x: 0.4, y: 0.5 }, 0.1, -0.2, 1080, 1920), {
      x: 0.5, y: 0.3, space: "normalized",
    });
    assert.deepEqual(translateSafeZonePosition({ x: 540, y: 960 }, 0.1, -0.2, 1080, 1920), {
      x: 648, y: 576, space: "pixels",
    });
    assert.equal(translateSafeZonePosition({ x: 0, y: 0 }, 0.1, 0.1, 1080, 1920), null);
    assert.equal(translateSafeZonePosition({ x: "540", y: 960 }, 0.1, 0.1, 1080, 1920), null);
  });

  it("preserves relative layout by adding one delta instead of assigning one shared center", () => {
    const first = translateSafeZonePosition({ x: 540, y: 700 }, 0.1, 0.05, 1080, 1920)!;
    const second = translateSafeZonePosition({ x: 740, y: 900 }, 0.1, 0.05, 1080, 1920)!;
    assert.equal(second.x - first.x, 200);
    assert.equal(second.y - first.y, 200);
  });

  it("builds position and proportional scale actions together for a safe static Motion item", async () => {
    const created: Array<{ kind: string; value: unknown }> = [];
    const position = {
      displayName: "Position",
      isTimeVarying: () => false,
      getStartValue: async () => ({ value: { value: { x: 100, y: 200 } } }),
      createKeyframe: (value: unknown) => ({ value }),
      createSetValueAction: (keyframe: { value: unknown }) => {
        const action = { kind: "position", value: keyframe.value };
        created.push(action);
        return action;
      },
    };
    const scale = {
      displayName: "Scale",
      isTimeVarying: () => false,
      getStartValue: async () => ({ value: { value: 100 } }),
      createKeyframe: (value: unknown) => ({ value }),
      createSetValueAction: (keyframe: { value: unknown }) => {
        const action = { kind: "scale", value: keyframe.value };
        created.push(action);
        return action;
      },
    };
    const component = {
      getMatchName: async () => "ADBE Motion",
      getDisplayName: async () => "Motion",
      getParamCount: () => 2,
      getParam: (index: number) => index === 0 ? position : scale,
    };
    const item = {
      isAdjustmentLayer: async () => false,
      getComponentChain: async () => ({ getComponentCount: () => 1, getComponentAtIndex: () => component }),
    } as unknown as VideoClipTrackItem;
    const result = await buildSafeZoneItemAlignmentActions(
      item,
      alignment,
      { width: 1000, height: 500 },
      (x, y) => ({ x, y }) as PointF,
    );
    assert.equal(result.changed, true);
    assert.equal(result.actions.length, 2);
    assert.deepEqual(created, []);
    for (const createAction of result.actions) createAction();
    assert.deepEqual(created, [
      { kind: "position", value: { x: 200, y: 300 } },
      { kind: "scale", value: 80 },
    ]);
  });

  it("preserves the whole item when a required Position or Scale property is keyed", async () => {
    const keyedPosition = {
      displayName: "Position",
      isTimeVarying: () => true,
      getStartValue: async () => ({ value: { value: { x: 100, y: 200 } } }),
    };
    const scale = {
      displayName: "Scale",
      isTimeVarying: () => false,
      getStartValue: async () => ({ value: { value: 100 } }),
    };
    const component = {
      getMatchName: async () => "ADBE Motion",
      getDisplayName: async () => "Motion",
      getParamCount: () => 2,
      getParam: (index: number) => index === 0 ? keyedPosition : scale,
    };
    const item = {
      isAdjustmentLayer: async () => false,
      getComponentChain: async () => ({ getComponentCount: () => 1, getComponentAtIndex: () => component }),
    } as unknown as VideoClipTrackItem;
    const result = await buildSafeZoneItemAlignmentActions(item, alignment, { width: 1000, height: 500 });
    assert.equal(result.changed, false);
    assert.deepEqual(result.actions, []);
    assert.match(result.warning ?? "", /위치 키프레임.*보존/u);
  });

  const moveOnly: SafeZoneAlignment = {
    rect: { x: 0, y: 0, width: 1, height: 1 }, deltaX: 0.1, deltaY: 0.2, scale: 1, changed: true, wasOversized: false,
  };
  const scaleOnly: SafeZoneAlignment = {
    rect: { x: 0, y: 0, width: 1, height: 1 }, deltaX: 0, deltaY: 0, scale: 0.8, changed: true, wasOversized: true,
  };
  const noChange: SafeZoneAlignment = {
    rect: { x: 0, y: 0, width: 1, height: 1 }, deltaX: 0, deltaY: 0, scale: 1, changed: false, wasOversized: false,
  };

  const staticParam = (kind: "position" | "scale", value: unknown) => ({
    displayName: kind === "position" ? "Position" : "Scale",
    isTimeVarying: () => false,
    getStartValue: async () => ({ value: { value } }),
    createKeyframe: (created: unknown) => ({ created }),
    createSetValueAction: (keyframe: { created: unknown }) => ({ kind, value: keyframe.created }),
  });

  function motionItem(
    params: { position?: unknown; scale?: unknown },
    options: { adjustment?: boolean; noChain?: boolean } = {},
  ): VideoClipTrackItem {
    const list = [params.position, params.scale].filter((param) => param !== undefined);
    const component = {
      getMatchName: async () => "ADBE Motion",
      getDisplayName: async () => "Motion",
      getParamCount: () => list.length,
      getParam: (index: number) => list[index] ?? null,
    };
    return {
      isAdjustmentLayer: async () => options.adjustment ?? false,
      getComponentChain: async () => options.noChain
        ? null
        : { getComponentCount: () => 1, getComponentAtIndex: () => component },
    } as unknown as VideoClipTrackItem;
  }

  it("no-ops without touching the item when neither move nor scale is needed", async () => {
    const result = await buildSafeZoneItemAlignmentActions({} as unknown as VideoClipTrackItem, noChange, { width: 1000, height: 500 });
    assert.deepEqual(result, { actions: [], changed: false });
  });

  it("builds a lone position action for a move-only alignment", async () => {
    const item = motionItem({ position: staticParam("position", { x: 100, y: 200 }) });
    const result = await buildSafeZoneItemAlignmentActions(item, moveOnly, { width: 1000, height: 500 }, (x, y) => ({ x, y }) as PointF);
    assert.equal(result.changed, true);
    assert.equal(result.actions.length, 1);
    assert.deepEqual(result.actions[0]!(), { kind: "position", value: { x: 200, y: 300 } });
  });

  it("builds a lone proportional scale action for a scale-only alignment", async () => {
    const item = motionItem({ scale: staticParam("scale", 100) });
    const result = await buildSafeZoneItemAlignmentActions(item, scaleOnly, { width: 1000, height: 500 });
    assert.equal(result.changed, true);
    assert.equal(result.actions.length, 1);
    assert.deepEqual(result.actions[0]!(), { kind: "scale", value: 80 });
  });

  it("preserves adjustment layers, missing components, and missing Motion properties", async () => {
    const adjustment = await buildSafeZoneItemAlignmentActions(
      motionItem({ position: staticParam("position", { x: 100, y: 200 }) }, { adjustment: true }),
      moveOnly,
      { width: 1000, height: 500 },
    );
    assert.match(adjustment.warning ?? "", /조정 레이어/u);

    const noComponent = await buildSafeZoneItemAlignmentActions(motionItem({}, { noChain: true }), moveOnly, { width: 1000, height: 500 });
    assert.match(noComponent.warning ?? "", /Motion 속성이 없는/u);

    const noPosition = await buildSafeZoneItemAlignmentActions(motionItem({}), moveOnly, { width: 1000, height: 500 });
    assert.match(noPosition.warning ?? "", /위치 속성이 없는/u);

    const noScale = await buildSafeZoneItemAlignmentActions(motionItem({}), scaleOnly, { width: 1000, height: 500 });
    assert.match(noScale.warning ?? "", /스케일 속성이 없는/u);
  });

  it("preserves keyed scale, ambiguous positions, and unreadable scale values", async () => {
    const keyedScale = await buildSafeZoneItemAlignmentActions(
      motionItem({ scale: { ...staticParam("scale", 100), isTimeVarying: () => true } }),
      scaleOnly,
      { width: 1000, height: 500 },
    );
    assert.equal(keyedScale.changed, false);
    assert.match(keyedScale.warning ?? "", /스케일 키프레임이 있는/u);

    const ambiguousPosition = await buildSafeZoneItemAlignmentActions(
      motionItem({ position: staticParam("position", { x: 0, y: 0 }) }),
      moveOnly,
      { width: 1000, height: 500 },
    );
    assert.match(ambiguousPosition.warning ?? "", /좌표 공간을 안전하게 판별하지 못해/u);

    const unreadableScale = await buildSafeZoneItemAlignmentActions(
      motionItem({ scale: staticParam("scale", "not-a-number") }),
      scaleOnly,
      { width: 1000, height: 500 },
    );
    assert.match(unreadableScale.warning ?? "", /스케일 값을 안전하게 읽지 못해/u);
  });

  it("preserves the item and reports the redacted reason when reading Motion throws", async () => {
    const item = { isAdjustmentLayer: async () => { throw new Error("host motion failure"); } } as unknown as VideoClipTrackItem;
    const result = await buildSafeZoneItemAlignmentActions(item, moveOnly, { width: 1000, height: 500 });
    assert.equal(result.changed, false);
    assert.deepEqual(result.actions, []);
    assert.match(result.warning ?? "", /안전하게 읽지 못해 선택 항목을 보존했습니다: .*host motion failure/u);
  });

  it("rejects unusable values, deltas, frames, integer unit corners, and runaway pixel translations", () => {
    assert.equal(translateSafeZonePosition(null, 0.1, 0.1, 1080, 1920), null);
    assert.equal(translateSafeZonePosition({ x: 0.4, y: 0.5 }, Number.NaN, 0.1, 1080, 1920), null);
    assert.equal(translateSafeZonePosition({ x: 0.4, y: 0.5 }, 0.1, 0.1, 0, 1920), null);
    assert.equal(translateSafeZonePosition({ x: 1, y: 1 }, 0.1, 0.1, 1080, 1920), null);
    assert.equal(translateSafeZonePosition({ x: 540, y: 960 }, 10, 0, 1080, 1920), null);
  });
});

describe("verified clone removal boundary", () => {
  function removableClone(guid: string) {
    return {
      guid,
      getProjectItem: async () => ({
        getParentBin: () => ({ createRemoveItemAction: () => ({ kind: "remove" }) }),
      }),
    };
  }

  it("rejects empty or identical clone identifiers before reading sequences", async () => {
    const project = {
      getSequences: async () => { throw new Error("sequences must not be read"); },
    } as unknown as Project;
    for (const [sourceGuid, cloneGuid] of [["", "clone"], ["source", ""], ["same", "same"]] as const) {
      await assert.rejects(
        () => removeVerifiedClonedSequenceFromProject(project, sourceGuid, cloneGuid),
        (error) => assertShortFlowError(error, "INVALID_CLONE_ID"),
      );
    }
  });

  it("throws SOURCE_SEQUENCE_NOT_FOUND when the preserved source is missing", async () => {
    const project = {
      getSequences: async () => [{ guid: "clone" }],
    } as unknown as Project;
    await assert.rejects(
      () => removeVerifiedClonedSequenceFromProject(project, "source", "clone"),
      (error) => assertShortFlowError(error, "SOURCE_SEQUENCE_NOT_FOUND"),
    );
  });

  it("resolves without reactivating or removing when the clone is already gone", async () => {
    let activated = false;
    const project = {
      getSequences: async () => [{ guid: "source" }],
      setActiveSequence: async () => { activated = true; return true; },
    } as unknown as Project;
    await removeVerifiedClonedSequenceFromProject(project, "source", "missing-clone");
    assert.equal(activated, false);
  });

  it("throws SOURCE_REACTIVATE_FAILED when the source cannot be reactivated", async () => {
    const source = { guid: "source" };
    const project = {
      getSequences: async () => [source, removableClone("clone")],
      setActiveSequence: async () => false,
      getActiveSequence: async () => ({ guid: "someone-else" }),
    } as unknown as Project;
    await assert.rejects(
      () => removeVerifiedClonedSequenceFromProject(project, "source", "clone"),
      (error) => assertShortFlowError(error, "SOURCE_REACTIVATE_FAILED"),
    );
  });

  it("wraps removal in lockedAccess and reports CLONE_REMOVE_FAILED on transaction rejection or lock failure", async () => {
    const source = { guid: "source" };
    for (const project of [
      {
        getSequences: async () => [source, removableClone("clone")],
        setActiveSequence: async () => true,
        getActiveSequence: async () => source,
        lockedAccess: (callback: () => void) => callback(),
        executeTransaction: () => false,
      },
      {
        getSequences: async () => [source, removableClone("clone")],
        setActiveSequence: async () => true,
        lockedAccess: () => { throw new Error("host locked-access failure"); },
        executeTransaction: () => true,
      },
    ] as unknown as Project[]) {
      await assert.rejects(
        () => removeVerifiedClonedSequenceFromProject(project, "source", "clone"),
        (error) => assertShortFlowError(error, "CLONE_REMOVE_FAILED"),
      );
    }
  });
});

describe("setSequencePlayerPosition validation", () => {
  it("rejects out-of-range playhead targets before any Host access", async () => {
    for (const seconds of [Number.NaN, Number.POSITIVE_INFINITY, -1, 86_400.5, 90_000]) {
      await assert.rejects(
        () => setSequencePlayerPosition(seconds),
        (error) => assertShortFlowError(error, "INVALID_PLAYHEAD"),
      );
    }
  });
});
