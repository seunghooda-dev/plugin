import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PROFILES } from "../src/core";
import { createAssetRightsReport, normalizeAssetRightsRecord } from "../src/asset-rights";
import { SAFE_ZONE_PROFILES } from "../src/safe-zone";
import {
  FINAL_QC_PROFILES,
  FINAL_QC_SCHEMA_VERSION,
  MAX_QC_CAPTIONS,
  MAX_QC_MEDIA_ITEMS,
  MAX_QC_WAIVERS,
  FinalQCError,
  type FinalQCReport,
  type FinalQCSnapshot,
  type QCCheck,
  type QCWaiver,
  evaluateFinalQC,
  finalQCReportToJSON,
  finalQCReportToMarkdown,
  redactQCSnapshot,
  redactQCText,
} from "../src/final-qc";

function healthySnapshot(): FinalQCSnapshot {
  return {
    platform: "youtube-shorts",
    sequence: {
      name: "ShortFlow_Final",
      width: 1080,
      height: 1920,
      duration: 30,
      frameRate: 29.97,
      videoTrackCount: 1,
      audioTrackCount: 1,
    },
    captions: [
      {
        id: "caption-1",
        text: "안녕하세요",
        start: 0,
        end: 2,
        rect: { x: 0.12, y: 0.55, width: 0.55, height: 0.1 },
      },
    ],
    safeZoneElements: [
      {
        id: "logo-1",
        label: "Logo",
        rect: { x: 0.1, y: 0.1, width: 0.5, height: 0.4 },
      },
    ],
    audio: {
      truePeakDbtp: -2,
      clippedSampleCount: 0,
      longestSilenceSeconds: 0.5,
      totalSilenceSeconds: 1,
      dialogueLufs: -16,
      bgmLufs: -24,
    },
    media: {
      offlineMedia: [],
      missingFonts: [],
      missingAssets: [],
      guideOverlays: [],
      rightsReport: createAssetRightsReport([
        normalizeAssetRightsRecord({
          assetId: "c:/assets/music/hook.wav",
          assetName: "hook.wav",
          kind: "music",
          source: "Artlist",
          license: "Creator Pro",
          commercialUse: "allowed",
          expiresAt: "2027-07-11",
          attribution: "Music: hook.wav, Artlist, Creator Pro",
          updatedAt: 1_750_000_000_000,
        }),
      ], 1_750_000_000_000),
    },
    output: {
      fileName: "ShortFlow_Final.mp4",
      directoryPath: "C:\\Exports",
      exists: false,
    },
  };
}

function report(
  mutate?: (snapshot: FinalQCSnapshot) => void,
  waivers: readonly QCWaiver[] = [],
): FinalQCReport {
  const snapshot = healthySnapshot();
  mutate?.(snapshot);
  return evaluateFinalQC(snapshot, waivers, 1_750_000_000_000);
}

function checks(value: FinalQCReport, code: string): QCCheck[] {
  return value.checks.filter((item) => item.code === code);
}

function has(value: FinalQCReport, code: string, level: QCCheck["level"]): boolean {
  return checks(value, code).some((item) => item.level === level);
}

function expectCode(code: FinalQCError["code"]): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof FinalQCError);
    assert.equal(error.code, code);
    assert.ok(error.message.length > 0);
    return true;
  };
}

describe("platform profiles and healthy gate", () => {
  it("defines YouTube Shorts, Reels, and TikTok profiles", () => {
    assert.deepEqual(Object.keys(FINAL_QC_PROFILES).sort(), [
      "instagram-reels",
      "tiktok",
      "youtube-shorts",
    ]);
  });

  it("reuses core dimensions and duration limits", () => {
    for (const profile of Object.values(FINAL_QC_PROFILES)) {
      const core = PROFILES.find((candidate) => candidate.id === profile.id);
      assert.ok(core);
      assert.equal(profile.width, core.width);
      assert.equal(profile.height, core.height);
      assert.equal(profile.maxDuration, core.maxDuration);
    }
  });

  it("reuses safe-zone revisions", () => {
    for (const profile of Object.values(FINAL_QC_PROFILES)) {
      assert.equal(profile.safeZoneRevision, SAFE_ZONE_PROFILES[profile.id].revision);
    }
  });

  it("passes a production-ready snapshot", () => {
    const value = report();
    assert.equal(value.schemaVersion, FINAL_QC_SCHEMA_VERSION);
    assert.equal(value.status, "pass");
    assert.equal(value.blocking, false);
    assert.deepEqual(value.blockingCodes, []);
    assert.equal(value.counts.error, 0);
    assert.ok(value.counts.pass > 10);
  });

  it("supports healthy snapshots for every platform", () => {
    for (const platform of ["youtube-shorts", "instagram-reels", "tiktok"] as const) {
      const value = report((snapshot) => { snapshot.platform = platform; });
      assert.equal(value.blocking, false, platform);
    }
  });
});

describe("sequence checks", () => {
  it("hard-blocks the wrong resolution", () => {
    const value = report((snapshot) => { snapshot.sequence.width = 720; snapshot.sequence.height = 1280; });
    assert.equal(has(value, "frame-size", "error"), true);
    assert.equal(checks(value, "frame-size")[0]?.hardBlock, true);
    assert.equal(value.blocking, true);
  });

  it("hard-blocks the wrong aspect ratio independently", () => {
    const value = report((snapshot) => { snapshot.sequence.height = 1080; });
    assert.equal(has(value, "aspect-ratio", "error"), true);
    assert.ok(value.blockingCodes.includes("aspect-ratio"));
  });

  it("hard-blocks an invalid duration", () => {
    const value = report((snapshot) => { snapshot.sequence.duration = 0; });
    assert.equal(has(value, "duration", "error"), true);
    assert.ok(value.blockingCodes.includes("duration"));
  });

  it("blocks an over-limit platform duration but permits a documented waiver", () => {
    const waiver = { code: "duration-limit", reason: "승인된 장편 캠페인 버전", createdAt: 123 };
    const value = report((snapshot) => { snapshot.sequence.duration = 181; }, [waiver]);
    assert.equal(has(value, "duration-limit", "error"), true);
    assert.equal(checks(value, "duration-limit")[0]?.waived, true);
    assert.equal(value.blocking, false);
    assert.equal(value.status, "warning");
  });

  it("allows common delivery frame rates", () => {
    for (const frameRate of [23.976, 24, 25, 29.97, 30, 50, 59.94, 60]) {
      assert.equal(has(report((snapshot) => { snapshot.sequence.frameRate = frameRate; }), "frame-rate", "pass"), true);
    }
  });

  it("blocks an unsupported frame rate unless waived", () => {
    const unwaived = report((snapshot) => { snapshot.sequence.frameRate = 12; });
    assert.equal(unwaived.blocking, true);
    const waived = report(
      (snapshot) => { snapshot.sequence.frameRate = 12; },
      [{ code: "frame-rate", reason: "스톱모션 원본 프레임레이트", createdAt: 123 }],
    );
    assert.equal(waived.blocking, false);
  });

  it("hard-blocks a sequence without video", () => {
    const value = report((snapshot) => { snapshot.sequence.videoTrackCount = 0; });
    assert.equal(has(value, "video-track", "error"), true);
    assert.ok(value.blockingCodes.includes("video-track"));
  });

  it("warns but does not block a deliberate silent short", () => {
    const value = report((snapshot) => { snapshot.sequence.audioTrackCount = 0; });
    assert.equal(has(value, "audio-track", "warning"), true);
    assert.equal(value.blocking, false);
  });

  it("warns for an empty sequence name", () => {
    const value = report((snapshot) => { snapshot.sequence.name = ""; });
    assert.equal(has(value, "sequence-name", "warning"), true);
  });
});

describe("caption checks", () => {
  it("warns when captions are absent", () => {
    const value = report((snapshot) => { snapshot.captions = []; });
    assert.equal(has(value, "caption-exists", "warning"), true);
    assert.equal(has(value, "caption-track", "warning"), true);
    assert.equal(value.blocking, false);
  });

  it("hard-blocks a caption outside the physical frame", () => {
    const value = report((snapshot) => { snapshot.captions[0]!.rect.x = -0.1; });
    assert.equal(has(value, "caption-outside-frame", "error"), true);
    assert.ok(value.blockingCodes.includes("caption-outside-frame"));
  });

  it("does not allow a waiver for a hard-block caption", () => {
    const value = report(
      (snapshot) => { snapshot.captions[0]!.rect.x = -0.1; },
      [{ code: "caption-outside-frame", reason: "의도적인 화면 밖 배치", createdAt: 123 }],
    );
    assert.equal(value.blocking, true);
    assert.equal(checks(value, "caption-outside-frame")[0]?.waived, false);
    assert.match(value.rejectedWaivers[0]?.reasonRejected ?? "", /hard-block/u);
  });

  it("hard-blocks invalid caption timing", () => {
    const value = report((snapshot) => { snapshot.captions[0]!.end = 31; });
    assert.equal(has(value, "caption-invalid-time", "error"), true);
    assert.equal(value.blocking, true);
  });

  it("warns for too-short caption exposure", () => {
    const value = report((snapshot) => { snapshot.captions[0]!.end = 0.3; });
    assert.equal(has(value, "caption-min-exposure", "warning"), true);
    assert.equal(value.blocking, false);
  });

  it("blocks excessive characters per second", () => {
    const value = report((snapshot) => {
      snapshot.captions[0]!.text = "가".repeat(100);
      snapshot.captions[0]!.end = 1;
    });
    assert.equal(has(value, "caption-cps", "error"), true);
    assert.equal(value.blocking, true);
  });

  it("detects overlapping caption times", () => {
    const value = report((snapshot) => {
      snapshot.captions = [
        snapshot.captions[0]!,
        { ...snapshot.captions[0]!, id: "caption-2", start: 1, end: 3 },
      ];
    });
    assert.equal(has(value, "caption-overlap", "error"), true);
  });

  it("permits a reasoned waiver for caption overlap", () => {
    const value = report(
      (snapshot) => {
        snapshot.captions = [
          snapshot.captions[0]!,
          { ...snapshot.captions[0]!, id: "caption-2", start: 1, end: 3 },
        ];
      },
      [{ code: "caption-overlap", reason: "이중 언어 자막 동시 표기", createdAt: 123 }],
    );
    assert.equal(value.blocking, false);
    assert.equal(checks(value, "caption-overlap")[0]?.waived, true);
  });

  it("warns when a caption violates the platform safe zone", () => {
    const value = report((snapshot) => { snapshot.captions[0]!.rect.y = 0.85; });
    assert.equal(has(value, "caption-safe-zone", "warning"), true);
    assert.match(checks(value, "caption-safe-zone")[0]?.message ?? "", /2026-conservative/u);
    assert.equal(value.blocking, false);
  });

  it("blocks an empty caption text as a waivable editorial error", () => {
    const value = report((snapshot) => { snapshot.captions[0]!.text = ""; });
    assert.equal(has(value, "caption-text", "error"), true);
    assert.equal(checks(value, "caption-text")[0]?.hardBlock, false);
  });
});

describe("safe-zone element checks", () => {
  it("passes content inside the reused platform safe zone", () => {
    assert.equal(has(report(), "content-safe-zone", "pass"), true);
  });

  it("warns for platform UI safe-zone intrusion", () => {
    const value = report((snapshot) => {
      snapshot.safeZoneElements[0]!.rect.x = 0.75;
      snapshot.safeZoneElements[0]!.rect.width = 0.2;
    });
    assert.equal(has(value, "content-safe-zone", "warning"), true);
    assert.match(checks(value, "content-safe-zone")[0]?.message ?? "", /2026-conservative/u);
  });

  it("reports a graphic outside the physical frame", () => {
    const value = report((snapshot) => { snapshot.safeZoneElements[0]!.rect.width = 1.1; });
    assert.equal(has(value, "content-outside-frame", "error"), true);
  });
});

describe("audio checks", () => {
  it("hard-blocks digital clipping", () => {
    const value = report((snapshot) => { snapshot.audio.clippedSampleCount = 1; });
    assert.equal(has(value, "audio-clipping", "error"), true);
    assert.ok(value.blockingCodes.includes("audio-clipping"));
  });

  it("blocks a true peak above minus one dBTP", () => {
    const value = report((snapshot) => { snapshot.audio.truePeakDbtp = -0.5; });
    assert.equal(has(value, "audio-true-peak", "error"), true);
    assert.equal(checks(value, "audio-true-peak")[0]?.hardBlock, false);
  });

  it("hard-blocks a true peak above zero dBTP", () => {
    const value = report((snapshot) => { snapshot.audio.truePeakDbtp = 0.1; });
    assert.equal(checks(value, "audio-true-peak")[0]?.hardBlock, true);
  });

  it("warns when a true peak measurement is missing", () => {
    const value = report((snapshot) => { delete snapshot.audio.truePeakDbtp; });
    assert.equal(has(value, "audio-true-peak", "warning"), true);
  });

  it("warns for a long silence", () => {
    const value = report((snapshot) => { snapshot.audio.longestSilenceSeconds = 4; });
    assert.equal(has(value, "audio-silence", "warning"), true);
  });

  it("blocks an entirely silent populated audio track", () => {
    const value = report((snapshot) => { snapshot.audio.longestSilenceSeconds = 30; });
    assert.equal(has(value, "audio-silence", "error"), true);
  });

  it("blocks BGM that may mask dialogue", () => {
    const value = report((snapshot) => { snapshot.audio.dialogueLufs = -18; snapshot.audio.bgmLufs = -20; });
    assert.equal(has(value, "dialogue-bgm-balance", "error"), true);
  });

  it("warns for an excessively large dialogue/BGM gap", () => {
    const value = report((snapshot) => { snapshot.audio.dialogueLufs = -10; snapshot.audio.bgmLufs = -35; });
    assert.equal(has(value, "dialogue-bgm-balance", "warning"), true);
  });

  it("warns when dialogue/BGM measurements are absent", () => {
    const value = report((snapshot) => { delete snapshot.audio.dialogueLufs; delete snapshot.audio.bgmLufs; });
    assert.equal(has(value, "dialogue-bgm-balance", "warning"), true);
  });
});

describe("media and project hygiene", () => {
  for (const [field, code] of [
    ["offlineMedia", "offline-media"],
    ["missingFonts", "missing-font"],
    ["missingAssets", "missing-asset"],
    ["guideOverlays", "guide-overlay"],
  ] as const) {
    it(`hard-blocks ${code}`, () => {
      const value = report((snapshot) => { snapshot.media[field] = ["sensitive-item"] as never; });
      assert.equal(has(value, code, "error"), true);
      assert.equal(checks(value, code)[0]?.hardBlock, true);
      assert.ok(value.blockingCodes.includes(code));
    });
  }

  it("warns when the asset rights report is missing", () => {
    const value = report((snapshot) => { delete snapshot.media.rightsReport; });
    assert.equal(has(value, "asset-rights-report", "warning"), true);
    assert.equal(value.blocking, false);
  });

  it("does not warn about attribution when no tracked assets exist", () => {
    const value = report((snapshot) => {
      snapshot.media.rightsReport = createAssetRightsReport([], 1_750_000_000_000);
    });
    assert.equal(has(value, "asset-rights-attribution", "pass"), true);
    assert.equal(has(value, "asset-rights-attribution", "warning"), false);
  });

  it("hard-blocks forbidden or expired asset rights", () => {
    const value = report((snapshot) => {
      snapshot.media.rightsReport = createAssetRightsReport([
        normalizeAssetRightsRecord({
          assetId: "ai-hero",
          assetName: "hero.png",
          kind: "ai-image",
          source: "External AI",
          license: "Personal preview",
          commercialUse: "forbidden",
          expiresAt: "2024-01-01",
          attribution: "AI image: External AI",
          updatedAt: 1_750_000_000_000,
        }),
      ], 1_750_000_000_000);
    });
    assert.equal(has(value, "asset-rights-error", "error"), true);
    assert.equal(checks(value, "asset-rights-error")[0]?.hardBlock, true);
    assert.equal(value.blocking, true);
  });
});

describe("output file checks", () => {
  it("hard-blocks unsafe filenames", () => {
    for (const fileName of ["../escape.mp4", "CON.mp4", "bad/name.mp4", ""]) {
      const value = report((snapshot) => { snapshot.output.fileName = fileName; });
      assert.equal(has(value, "output-filename", "error"), true, fileName);
    }
  });

  it("hard-blocks relative and traversal output paths", () => {
    for (const directoryPath of ["relative/folder", "C:\\Exports\\..\\Secret", "https://example.com/out"]) {
      const value = report((snapshot) => { snapshot.output.directoryPath = directoryPath; });
      assert.equal(has(value, "output-path", "error"), true, directoryPath);
    }
  });

  it("accepts Windows, UNC, and POSIX absolute paths", () => {
    for (const directoryPath of ["C:\\Exports", "\\\\NAS\\Share", "/Users/editor/Exports"]) {
      assert.equal(has(report((snapshot) => { snapshot.output.directoryPath = directoryPath; }), "output-path", "pass"), true);
    }
  });

  it("blocks a non-MP4 output format but permits waiver", () => {
    const value = report(
      (snapshot) => { snapshot.output.fileName = "final.mov"; },
      [{ code: "output-format", reason: "마스터 MOV 별도 납품", createdAt: 123 }],
    );
    assert.equal(has(value, "output-format", "error"), true);
    assert.equal(value.blocking, false);
  });

  it("warns before overwriting an existing output", () => {
    const value = report((snapshot) => { snapshot.output.exists = true; });
    assert.equal(has(value, "output-overwrite", "warning"), true);
    assert.equal(value.blocking, false);
  });
});

describe("waiver validation", () => {
  it("rejects a short reason and invalid time", () => {
    const value = report(undefined, [
      { code: "frame-rate", reason: "짧음", createdAt: 0 },
    ]);
    assert.equal(value.rejectedWaivers.length, 1);
  });

  it("rejects a valid waiver with no matching error", () => {
    const value = report(undefined, [
      { code: "frame-rate", reason: "승인된 예외 사유입니다", createdAt: 123 },
    ]);
    assert.equal(value.acceptedWaivers.length, 0);
    assert.match(value.rejectedWaivers[0]?.reasonRejected ?? "", /동일 코드/u);
  });

  it("redacts a waiver reason before reporting", () => {
    const value = report(
      (snapshot) => { snapshot.sequence.frameRate = 12; },
      [{ code: "frame-rate", reason: "승인 key sk-proj-abcdefghijk", createdAt: 123 }],
    );
    assert.equal(JSON.stringify(value).includes("sk-proj"), false);
  });
});

describe("input size defense", () => {
  it("rejects unsupported platforms including prototype keys", () => {
    const snapshot = healthySnapshot();
    snapshot.platform = "__proto__" as never;
    assert.throws(() => evaluateFinalQC(snapshot), expectCode("UNSUPPORTED_PLATFORM"));
  });

  it("rejects too many captions before deep inspection", () => {
    const snapshot = healthySnapshot();
    snapshot.captions = Array.from({ length: MAX_QC_CAPTIONS + 1 }, () => snapshot.captions[0]!);
    assert.throws(() => evaluateFinalQC(snapshot), expectCode("INPUT_TOO_LARGE"));
  });

  it("rejects too many media records", () => {
    const snapshot = healthySnapshot();
    snapshot.media.offlineMedia = Array(MAX_QC_MEDIA_ITEMS + 1).fill("x");
    assert.throws(() => evaluateFinalQC(snapshot), expectCode("INPUT_TOO_LARGE"));
  });

  it("rejects too many waivers", () => {
    const waivers = Array.from({ length: MAX_QC_WAIVERS + 1 }, (_, index) => ({
      code: `code-${index}`,
      reason: "승인된 충분한 예외 사유",
      createdAt: 123,
    }));
    assert.throws(() => evaluateFinalQC(healthySnapshot(), waivers), expectCode("INPUT_TOO_LARGE"));
  });

  it("rejects a snapshot larger than five megabytes", () => {
    const snapshot = healthySnapshot();
    snapshot.sequence.name = "가".repeat(2_000_000);
    assert.throws(() => evaluateFinalQC(snapshot), expectCode("INPUT_TOO_LARGE"));
  });

  it("rejects circular snapshots", () => {
    const snapshot = healthySnapshot();
    (snapshot as unknown as Record<string, unknown>).self = snapshot;
    assert.throws(() => evaluateFinalQC(snapshot), expectCode("INVALID_SNAPSHOT"));
  });
});

describe("JSON, Markdown, and redaction", () => {
  it("redacts snapshot secrets without mutating the source", () => {
    const snapshot = healthySnapshot();
    (snapshot as unknown as Record<string, unknown>).apiKey = "sk-proj-abcdefghijk";
    const safe = redactQCSnapshot(snapshot);
    assert.equal(JSON.stringify(safe).includes("sk-proj"), false);
    assert.equal((snapshot as unknown as Record<string, unknown>).apiKey, "sk-proj-abcdefghijk");
  });

  it("redacts standalone sensitive text", () => {
    assert.equal(redactQCText("Authorization: Bearer sk-proj-abcdefghijk").includes("sk-proj"), false);
  });

  it("exports a parseable redacted JSON gate report", () => {
    const value = report((snapshot) => { snapshot.sequence.name = "name sk-proj-abcdefghijk"; });
    const json = finalQCReportToJSON(value);
    const parsed = JSON.parse(json) as FinalQCReport;
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(json.includes("sk-proj"), false);
  });

  it("carries the asset rights report into JSON and Markdown exports", () => {
    const value = report();
    const json = finalQCReportToJSON(value);
    const parsed = JSON.parse(json) as FinalQCReport;
    assert.equal(parsed.rightsReport?.assets[0]?.assetName, "hook.wav");
    assert.equal(parsed.rightsReport?.counts.error, 0);

    const markdown = finalQCReportToMarkdown(value);
    assert.match(markdown, /에셋 권리 리포트/u);
    assert.match(markdown, /Music: hook\.wav, Artlist, Creator Pro/u);
  });

  it("exports a readable Markdown gate table", () => {
    const markdown = finalQCReportToMarkdown(report());
    assert.match(markdown, /^# ShortFlow 최종 QC/u);
    assert.match(markdown, /\| 수준 \| 코드 \|/u);
    assert.match(markdown, /게이트: \*\*통과\*\*/u);
  });

  it("includes accepted and rejected waiver sections", () => {
    const accepted = report(
      (snapshot) => { snapshot.sequence.frameRate = 12; },
      [
        { code: "frame-rate", reason: "승인된 스톱모션 예외", createdAt: 123 },
        { code: "frame-size", reason: "hard block 시도 사유", createdAt: 123 },
      ],
    );
    const markdown = finalQCReportToMarkdown(accepted);
    assert.match(markdown, /승인된 Waiver/u);
    assert.match(markdown, /거부된 Waiver/u);
  });
});
