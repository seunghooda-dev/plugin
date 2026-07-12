import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_AUTOMATION_SEGMENTS,
  buildPunchKeyframes,
  createAutomationAnalysisFingerprint,
  normalizeAutomationAnalysisSettings,
  normalizeSpeechSegments,
  planSilenceCuts,
  recommendPunchCues,
} from "../src/automation";

describe("automation analysis fingerprint", () => {
  const segments = [
    { start: 2, end: 3, text: "두 번째", speaker: "B" },
    { start: 0, end: 1, text: "첫 번째", speaker: "A" },
  ];
  const settings = {
    minSilence: 0.42,
    padding: 0.08,
    trimLeading: true,
    trimTrailing: true,
    punchEnabled: true,
    punchScale: 112,
    punchCount: 12,
    keywords: [" 중요 ", "핵심"],
  };

  function fingerprint(overrides: Record<string, unknown> = {}): string {
    return createAutomationAnalysisFingerprint({
      transcriptName: "Interview A",
      sourceDuration: 4,
      segments,
      settings,
      sourceContextKey: "ctx_project_sequence",
      ...overrides,
    });
  }

  it("normalizes effective analysis controls before fingerprinting", () => {
    assert.deepEqual(normalizeAutomationAnalysisSettings({
      minSilence: -10,
      padding: 99,
      trimLeading: false,
      trimTrailing: false,
      punchEnabled: true,
      punchScale: 999,
      punchCount: 999,
      keywords: [" 중요 ", "중요", "핵심"],
    }), {
      minSilence: 0.1,
      padding: 2,
      trimLeading: false,
      trimTrailing: false,
      punchEnabled: true,
      punchScale: 150,
      punchCount: 100,
      keywords: ["중요", "핵심"],
    });
  });

  it("is deterministic for equivalent normalized transcript ordering and controls", () => {
    const first = fingerprint();
    const second = fingerprint({
      segments: [...segments].reverse().map((segment) => ({ ...segment, text: ` ${segment.text} ` })),
      settings: { ...settings, keywords: ["중요", "핵심"] },
    });
    assert.equal(first, second);
    assert.match(first, /^auto_v1_[a-z0-9]{7}_[a-z0-9]{7}$/u);
    assert.doesNotMatch(first, /Interview|project|sequence|첫 번째/u);
  });

  it("changes when transcript, cut, punch, or source context inputs change", () => {
    const baseline = fingerprint();
    const variants = [
      fingerprint({ transcriptName: "Interview B" }),
      fingerprint({ sourceDuration: 5 }),
      fingerprint({ segments: segments.map((segment, index) => index === 0 ? { ...segment, text: "변경" } : segment) }),
      fingerprint({ settings: { ...settings, minSilence: 0.8 } }),
      fingerprint({ settings: { ...settings, padding: 0.2 } }),
      fingerprint({ settings: { ...settings, punchEnabled: false } }),
      fingerprint({ settings: { ...settings, punchScale: 125 } }),
      fingerprint({ settings: { ...settings, punchCount: 3 } }),
      fingerprint({ settings: { ...settings, keywords: ["다른 키워드"] } }),
      fingerprint({ sourceContextKey: "ctx_other_sequence" }),
    ];
    assert.equal(new Set([baseline, ...variants]).size, variants.length + 1);
  });

  it("rejects an unusable fingerprint source duration", () => {
    assert.throws(() => fingerprint({ sourceDuration: Number.NaN }), /fingerprint/u);
  });
});

describe("normalizeSpeechSegments", () => {
  it("sorts, trims, and clamps STT segments", () => {
    assert.deepEqual(normalizeSpeechSegments([
      { start: 5, end: 20, text: " second " },
      { start: -2, end: 2, text: " first " },
      { start: 3, end: 3, text: "invalid" },
      { start: 4, end: 5, text: " " },
    ], 10), [
      { start: 0, end: 2, text: "first" },
      { start: 5, end: 10, text: "second" },
    ]);
  });

  it("keeps an optional bounded speaker label", () => {
    const [segment] = normalizeSpeechSegments([
      { start: 0, end: 1, text: "hello", speaker: " speaker_1 " },
    ], 2);
    assert.equal(segment?.speaker, "speaker_1");
  });

  it("drops missing, non-finite, null, and string STT timestamps instead of treating them as zero", () => {
    const malformed = [
      { end: 1, text: "missing start" },
      { start: 0, text: "missing end" },
      { start: Number.NaN, end: 1, text: "NaN start" },
      { start: 0, end: Number.POSITIVE_INFINITY, text: "infinite end" },
      { start: null, end: 1, text: "null start" },
      { start: "0", end: "1", text: "string timestamps" },
    ] as unknown as Parameters<typeof normalizeSpeechSegments>[0];
    assert.deepEqual(normalizeSpeechSegments(malformed, 2), []);
  });

  it("rejects excessive STT input before planning", () => {
    const segments = Array.from({ length: MAX_AUTOMATION_SEGMENTS + 1 }, (_value, index) => ({
      start: index,
      end: index + 0.5,
      text: "speech",
    }));
    assert.throws(() => normalizeSpeechSegments(segments, MAX_AUTOMATION_SEGMENTS + 2), /최대/u);
  });
});

describe("planSilenceCuts", () => {
  it("turns transcript gaps into padded jump cuts", () => {
    const plan = planSilenceCuts([
      { start: 1, end: 3, text: "one" },
      { start: 5, end: 7, text: "two" },
    ], 8, { minSilence: 0.5, padding: 0.1 });
    assert.deepEqual(plan.cuts.map(({ start, end }) => [start, end]), [
      [0, 0.9],
      [3.1, 4.9],
      [7.1, 8],
    ]);
    assert.equal(Math.round(plan.removedDuration * 10) / 10, 3.6);
    assert.equal(Math.round(plan.outputDuration * 10) / 10, 4.4);
  });

  it("can preserve leading and trailing handles", () => {
    const plan = planSilenceCuts([
      { start: 2, end: 3, text: "voice" },
    ], 6, { minSilence: 0.5, padding: 0, trimLeading: false, trimTrailing: false });
    assert.deepEqual(plan.cuts, []);
    assert.deepEqual(plan.keeps.map(({ start, end }) => [start, end]), [[0, 6]]);
  });

  it("merges overlapping speech before finding silence", () => {
    const plan = planSilenceCuts([
      { start: 0, end: 2, text: "one" },
      { start: 1.5, end: 3, text: "two" },
      { start: 3.2, end: 4, text: "three" },
    ], 4, { minSilence: 0.5, padding: 0.15 });
    assert.equal(plan.cuts.length, 0);
  });

  it("does not cut sub-threshold pauses", () => {
    const plan = planSilenceCuts([
      { start: 0, end: 1, text: "one" },
      { start: 1.2, end: 2, text: "two" },
    ], 2, { minSilence: 0.3, padding: 0 });
    assert.equal(plan.cuts.length, 0);
    assert.match(plan.warnings.join(" "), /긴 무음/u);
  });

  it("returns a safe no-op when STT contains no valid speech", () => {
    const plan = planSilenceCuts([], 10);
    assert.equal(plan.removedDuration, 0);
    assert.deepEqual(plan.keeps.map(({ start, end }) => [start, end]), [[0, 10]]);
    assert.match(plan.warnings[0] ?? "", /STT/u);
  });

  it("warns before an aggressive removal", () => {
    const plan = planSilenceCuts([
      { start: 4, end: 5, text: "tiny speech" },
    ], 10, { padding: 0, minSilence: 0.1 });
    assert.equal(plan.removedDuration, 9);
    assert.match(plan.warnings.join(" "), /60%/u);
  });

  it("never absorbs a short real speech keep into neighboring silence cuts", () => {
    const plan = planSilenceCuts([
      { start: 0.45, end: 0.5, text: "짧지만 실제 발화" },
    ], 1, { minSilence: 0.1, padding: 0, minKeep: 0.12 });
    assert.deepEqual(plan.cuts.map(({ start, end }) => [start, end]), [[0, 0.45], [0.5, 1]]);
    assert.deepEqual(plan.keeps.map(({ start, end }) => [start, end]), [[0.45, 0.5]]);
    assert.equal(plan.cuts.some((cut) => cut.start < 0.5 && cut.end > 0.45), false);
    assert.match(plan.warnings.join(" "), /발화.*보존/u);
  });

  it("partitions the full duration into sorted non-overlapping cuts and keeps", () => {
    const plan = planSilenceCuts([
      { start: 0.4, end: 0.7, text: "one" },
      { start: 1.1, end: 1.15, text: "short speech" },
      { start: 1.8, end: 2.3, text: "two" },
    ], 3, { minSilence: 0.2, padding: 0.03, minKeep: 0.12 });
    const partition = [...plan.cuts, ...plan.keeps].sort((left, right) => left.start - right.start);
    assert.ok(partition.every((item, index) => index === 0 || item.start >= (partition[index - 1]?.end ?? 0)));
    assert.ok(Math.abs(partition.reduce((sum, item) => sum + item.duration, 0) - plan.sourceDuration) < 1e-9);
    assert.ok(Math.abs(plan.removedDuration + plan.outputDuration - plan.sourceDuration) < 1e-9);
    assert.equal(plan.cuts.some((cut) => plan.speech.some((speech) => cut.start < speech.end && cut.end > speech.start)), false);
  });

  it("rejects cut plans above the configured review limit", () => {
    const segments = [
      { start: 1, end: 2, text: "one" },
      { start: 4, end: 5, text: "two" },
      { start: 7, end: 8, text: "three" },
    ];
    assert.throws(() => planSilenceCuts(segments, 9, {
      minSilence: 0.5,
      padding: 0,
      maximumCuts: 2,
    }), /최대 2개/u);
  });

  it("rejects an invalid source duration", () => {
    assert.throws(() => planSilenceCuts([], 0), /길이/u);
  });
});

describe("punch recommendations", () => {
  const segments = [
    { start: 0, end: 1, text: "평범한 시작입니다" },
    { start: 3, end: 4, text: "이 부분이 정말 중요합니다!" },
    { start: 6, end: 7, text: "ShortFlow 비밀 기능" },
    { start: 7.2, end: 8, text: "너무 가까운 문장" },
  ];

  it("prioritizes keywords and emphasized sentences", () => {
    const cues = recommendPunchCues(segments, 10, {
      keywords: ["ShortFlow"],
      maximumCues: 2,
      minGap: 2,
    });
    assert.equal(cues.length, 2);
    assert.equal(cues.some((cue) => cue.reason.includes("ShortFlow".toLocaleLowerCase())), true);
    assert.equal(cues.some((cue) => cue.text.includes("중요")), true);
  });

  it("enforces scale, duration, and cue count boundaries", () => {
    const cues = recommendPunchCues(segments, 10, {
      scale: 500,
      duration: 0.01,
      maximumCues: 1,
    });
    assert.equal(cues.length, 1);
    assert.equal(cues[0]?.scale, 150);
    assert.ok((cues[0]?.end ?? 0) - (cues[0]?.start ?? 0) >= 0.25);
  });

  it("returns deterministic, non-overlapping punch ranges under dense input", () => {
    const dense = [
      { start: 0, end: 1, text: "중요한 첫 문장입니다!" },
      { start: 0.6, end: 1.6, text: "중요한 두 번째 문장입니다!" },
      { start: 1.2, end: 2.2, text: "중요한 세 번째 문장입니다!" },
    ];
    const options = { duration: 1.5, minGap: 0.5, maximumCues: 3 };
    const first = recommendPunchCues(dense, 3, options);
    const second = recommendPunchCues([...dense].reverse(), 3, options);
    assert.deepEqual(first, second);
    assert.ok(first.every((cue, index) => index === 0 || cue.start >= (first[index - 1]?.end ?? 0)));
    assert.ok(first.every((cue) => cue.start >= 0 && cue.end <= 3 && cue.end > cue.start));
  });

  it("returns no punch cues for an invalid source duration", () => {
    assert.deepEqual(recommendPunchCues(segments, Number.NaN), []);
  });

  it("builds smooth in, hold, and out scale keyframes", () => {
    const frames = buildPunchKeyframes([
      { start: 1, end: 2, scale: 112, reason: "test", text: "hello" },
    ], 100, 0.1);
    assert.deepEqual(frames, [
      { time: 1, scale: 100, interpolation: "bezier" },
      { time: 1.1, scale: 112, interpolation: "bezier" },
      { time: 1.9, scale: 112, interpolation: "hold" },
      { time: 2, scale: 100, interpolation: "bezier" },
    ]);
  });

  it("drops malformed punch cues", () => {
    assert.deepEqual(buildPunchKeyframes([
      { start: 2, end: 1, scale: 110, reason: "bad", text: "bad" },
    ]), []);
  });
});
