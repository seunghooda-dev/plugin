import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_AUTOMATION_MARKERS,
  MAX_AUTOMATION_SEGMENTS,
  MAX_AUTOMATION_SEGMENT_TEXT_LENGTH,
  MAX_PUNCH_KEYWORDS,
  assertAutomationMarkerBudget,
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

  it("rejects zero and negative fingerprint source durations", () => {
    assert.throws(() => fingerprint({ sourceDuration: 0 }), /fingerprint/u);
    assert.throws(() => fingerprint({ sourceDuration: -4 }), /fingerprint/u);
  });

  it("applies documented defaults and strict boolean semantics to loose settings input", () => {
    assert.deepEqual(normalizeAutomationAnalysisSettings({}), {
      minSilence: 0.42,
      padding: 0.08,
      trimLeading: true,
      trimTrailing: true,
      punchEnabled: false,
      punchScale: 112,
      punchCount: 12,
      keywords: [],
    });
    const loose = normalizeAutomationAnalysisSettings({
      punchEnabled: "true",
      trimLeading: "false",
      trimTrailing: 0,
      keywords: "중요" as unknown as string[],
    });
    assert.equal(loose.punchEnabled, false);
    assert.equal(loose.trimLeading, true);
    assert.equal(loose.trimTrailing, true);
    assert.deepEqual(loose.keywords, []);
  });

  it("caps punch keywords at the configured maximum", () => {
    const keywords = Array.from({ length: MAX_PUNCH_KEYWORDS + 20 }, (_value, index) => `키워드${index}`);
    const settings = normalizeAutomationAnalysisSettings({ keywords });
    assert.equal(settings.keywords.length, MAX_PUNCH_KEYWORDS);
  });

  it("ignores trimmed transcript names and segments that normalize away", () => {
    const baseline = fingerprint();
    assert.equal(fingerprint({ transcriptName: "  Interview A  " }), baseline);
    assert.equal(fingerprint({
      segments: [
        ...segments,
        { start: 9, end: 8, text: "무효" },
        { start: 0.2, end: 0.4, text: "   " },
      ],
    }), baseline);
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

  it("returns no segments for a non-array input or a non-positive duration", () => {
    assert.deepEqual(normalizeSpeechSegments(null as never, 10), []);
    assert.deepEqual(normalizeSpeechSegments([{ start: 0, end: 1, text: "valid" }], 0), []);
    assert.deepEqual(normalizeSpeechSegments([{ start: 0, end: 1, text: "valid" }], Number.NaN), []);
  });

  it("drops segments that clamp to nothing at the duration boundary", () => {
    assert.deepEqual(normalizeSpeechSegments([
      { start: 12, end: 15, text: "beyond source" },
      { start: 9.5, end: 20, text: "clipped tail" },
    ], 10), [{ start: 9.5, end: 10, text: "clipped tail" }]);
  });

  it("accepts segment text at the length limit and rejects longer text", () => {
    const limit = "글".repeat(MAX_AUTOMATION_SEGMENT_TEXT_LENGTH);
    assert.deepEqual(
      normalizeSpeechSegments([{ start: 0, end: 1, text: limit }], 2),
      [{ start: 0, end: 1, text: limit }],
    );
    assert.throws(() => normalizeSpeechSegments([{ start: 0, end: 1, text: `${limit}자` }], 2), /최대/u);
  });

  it("sanitizes speaker labels and drops non-string speakers", () => {
    const controlChars = String.fromCharCode(0, 31);
    const [first, second] = normalizeSpeechSegments([
      { start: 0, end: 1, text: "hello", speaker: ` A${controlChars}  B ` },
      { start: 2, end: 3, text: "world", speaker: 42 as unknown as string },
    ], 4);
    assert.equal(first?.speaker, "A B");
    assert.deepEqual(second, { start: 2, end: 3, text: "world" });
    const [long] = normalizeSpeechSegments([
      { start: 0, end: 1, text: "hi", speaker: "s".repeat(200) },
    ], 2);
    assert.equal(long?.speaker?.length, 80);
  });

  it("orders identical timestamps deterministically by text then speaker", () => {
    assert.deepEqual(normalizeSpeechSegments([
      { start: 0, end: 1, text: "나", speaker: "B" },
      { start: 0, end: 1, text: "가", speaker: "B" },
      { start: 0, end: 1, text: "가", speaker: "A" },
    ], 2), [
      { start: 0, end: 1, text: "가", speaker: "A" },
      { start: 0, end: 1, text: "가", speaker: "B" },
      { start: 0, end: 1, text: "나", speaker: "B" },
    ]);
  });
});

describe("assertAutomationMarkerBudget", () => {
  it("accepts totals up to the combined marker budget", () => {
    assert.doesNotThrow(() => assertAutomationMarkerBudget(0, 0));
    assert.doesNotThrow(() => assertAutomationMarkerBudget(400, 100));
    assert.doesNotThrow(() => assertAutomationMarkerBudget(MAX_AUTOMATION_MARKERS, 0));
  });

  it("rejects totals above the budget and unsafe counts", () => {
    assert.throws(() => assertAutomationMarkerBudget(400, 101), /최대 500개/u);
    assert.throws(() => assertAutomationMarkerBudget(-1, 0), /정수/u);
    assert.throws(() => assertAutomationMarkerBudget(1.5, 2), /정수/u);
    assert.throws(() => assertAutomationMarkerBudget(Number.NaN, 0), /정수/u);
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

  it("rejects negative and non-finite source durations", () => {
    assert.throws(() => planSilenceCuts([], -3), /길이/u);
    assert.throws(() => planSilenceCuts([], Number.NaN), /길이/u);
  });

  it("cuts a silence exactly at the minimum-length boundary", () => {
    const plan = planSilenceCuts([
      { start: 0, end: 1, text: "one" },
      { start: 1.5, end: 2, text: "two" },
    ], 2, { minSilence: 0.5, padding: 0 });
    assert.deepEqual(plan.cuts.map(({ start, end }) => [start, end]), [[1, 1.5]]);
    assert.deepEqual(plan.keeps.map(({ start, end }) => [start, end]), [[0, 1], [1.5, 2]]);
  });

  it("keeps interior cuts when leading and trailing trims are disabled", () => {
    const plan = planSilenceCuts([
      { start: 2, end: 3, text: "one" },
      { start: 5, end: 6, text: "two" },
    ], 7, { minSilence: 0.5, padding: 0, trimLeading: false, trimTrailing: false });
    assert.deepEqual(plan.cuts.map(({ start, end }) => [start, end]), [[3, 5]]);
    assert.deepEqual(plan.keeps.map(({ start, end }) => [start, end]), [[0, 3], [5, 7]]);
  });

  it("lets padding bridge gaps that would otherwise be cut", () => {
    const gapped = [
      { start: 0, end: 1, text: "one" },
      { start: 1.5, end: 3, text: "two" },
    ];
    assert.equal(planSilenceCuts(gapped, 3, { minSilence: 0.42, padding: 0 }).cuts.length, 1);
    const bridged = planSilenceCuts(gapped, 3, { minSilence: 0.42, padding: 0.3 });
    assert.equal(bridged.cuts.length, 0);
    assert.deepEqual(bridged.speech.map(({ start, end }) => [start, end]), [[0, 3]]);
  });

  it("can disable minimum-keep absorption entirely", () => {
    const plan = planSilenceCuts([
      { start: 0.45, end: 0.5, text: "짧은 발화" },
    ], 1, { minSilence: 0.1, padding: 0, minKeep: 0 });
    assert.deepEqual(plan.keeps.map(({ start, end }) => [start, end]), [[0.45, 0.5]]);
    assert.equal(plan.warnings.some((warning) => warning.includes("보존")), false);
  });

  it("accepts exactly the configured maximum number of cuts", () => {
    const plan = planSilenceCuts([
      { start: 1, end: 2, text: "one" },
      { start: 4, end: 5, text: "two" },
      { start: 7, end: 8, text: "three" },
    ], 9, { minSilence: 0.5, padding: 0, maximumCuts: 4 });
    assert.equal(plan.cuts.length, 4);
    assert.ok(Math.abs(plan.compressionRatio - plan.outputDuration / plan.sourceDuration) <= 1e-12);
  });

  it("accepts a plan at the combined 500-marker cap and rejects one above it", () => {
    const segmentAt = (index: number) => ({ start: index * 2 + 0.5, end: index * 2 + 1.5, text: `발화 ${index}` });
    const atCap = Array.from({ length: 499 }, (_value, index) => segmentAt(index));
    const plan = planSilenceCuts(atCap, 998, { minSilence: 0.4, padding: 0 });
    assert.equal(plan.cuts.length, MAX_AUTOMATION_MARKERS);
    const overCap = Array.from({ length: 500 }, (_value, index) => segmentAt(index));
    assert.throws(() => planSilenceCuts(overCap, 1000, { minSilence: 0.4, padding: 0 }), /최대 500개/u);
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

  it("clamps punch windows to the source boundaries", () => {
    const late = recommendPunchCues([
      { start: 9.4, end: 9.8, text: "마지막 하이라이트!" },
    ], 10, { duration: 2 });
    assert.deepEqual(late.map(({ start, end }) => [start, end]), [[8, 10]]);
    const early = recommendPunchCues([
      { start: 0, end: 0.2, text: "빠른 시작!" },
    ], 10, { duration: 1 });
    assert.deepEqual(early.map(({ start, end }) => [start, end]), [[0, 1]]);
  });

  it("fits the punch window inside a source shorter than the requested duration", () => {
    const cues = recommendPunchCues([
      { start: 0.1, end: 0.3, text: "아주 짧은 소스!" },
    ], 0.5, { duration: 3 });
    assert.deepEqual(cues.map(({ start, end }) => [start, end]), [[0, 0.5]]);
  });

  it("returns nothing for an empty transcript and clamps option floors", () => {
    assert.deepEqual(recommendPunchCues([], 10), []);
    const cues = recommendPunchCues([
      { start: 0, end: 1, text: "첫 강조 문장입니다!" },
      { start: 5, end: 6, text: "둘째 강조 문장입니다!" },
    ], 10, { maximumCues: 0, scale: 1 });
    assert.equal(cues.length, 1);
    assert.equal(cues[0]?.scale, 101);
  });

  it("matches keywords after NFKC normalization and labels reasons by score", () => {
    const cues = recommendPunchCues([
      { start: 0, end: 1, text: "shortflow 팁 공개" },
      { start: 4, end: 5, text: "그냥 평범한 한 문장" },
      { start: 8, end: 9, text: "정말 놀라운 발견입니다!" },
    ], 12, { keywords: ["ＳｈｏｒｔＦｌｏｗ"], maximumCues: 3, minGap: 1 });
    assert.equal(cues.length, 3);
    assert.deepEqual(cues.map((cue) => cue.reason), ["키워드: shortflow", "리듬 변화", "강조 문장"]);
  });

  it("boosts Korean emphasis vocabulary in punch scoring", () => {
    const cues = recommendPunchCues([
      { start: 0, end: 1, text: "핵심 정리입니다" },
      { start: 6, end: 7, text: "평범한 마무리" },
    ], 10, { maximumCues: 2, minGap: 1 });
    assert.deepEqual(cues.map((cue) => cue.reason), ["강조 문장", "리듬 변화"]);
  });

  it("collapses the plateau when the transition exceeds half the cue length", () => {
    const frames = buildPunchKeyframes([
      { start: 1, end: 1.5, scale: 120, reason: "test", text: "짧은 컷" },
    ], 100, 0.5);
    assert.deepEqual(frames, [
      { time: 1, scale: 100, interpolation: "bezier" },
      { time: 1.25, scale: 120, interpolation: "hold" },
      { time: 1.5, scale: 100, interpolation: "bezier" },
    ]);
  });

  it("never dips below the base scale and dedupes shared boundary keyframes", () => {
    const frames = buildPunchKeyframes([
      { start: 1, end: 2, scale: 90, reason: "low", text: "낮은 배율" },
      { start: 2, end: 3, scale: 120, reason: "high", text: "높은 배율" },
    ], 100, 0.1);
    assert.deepEqual(frames.map((frame) => frame.time), [1, 1.1, 1.9, 2, 2.1, 2.9, 3]);
    assert.ok(frames.every((frame) => frame.scale >= 100));
  });

  it("applies the minimum transition floor", () => {
    const frames = buildPunchKeyframes([
      { start: 0, end: 1, scale: 110, reason: "test", text: "플로어" },
    ], 100, 0.001);
    assert.deepEqual(frames.map((frame) => frame.time), [0, 0.02, 0.98, 1]);
  });

  it("drops cues with non-finite bounds", () => {
    assert.deepEqual(buildPunchKeyframes([
      { start: Number.NaN, end: 1, scale: 110, reason: "bad", text: "NaN 시작" },
      { start: 0, end: Number.POSITIVE_INFINITY, scale: 110, reason: "bad", text: "무한 끝" },
    ]), []);
  });
});
