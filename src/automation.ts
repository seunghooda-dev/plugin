export interface TimedSpeechSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export interface TimeRange {
  start: number;
  end: number;
  duration: number;
}

export interface SilenceCutOptions {
  minSilence?: number;
  padding?: number;
  minKeep?: number;
  trimLeading?: boolean;
  trimTrailing?: boolean;
  maximumCuts?: number;
}

export interface SilenceCutPlan {
  sourceDuration: number;
  outputDuration: number;
  removedDuration: number;
  compressionRatio: number;
  speech: TimeRange[];
  cuts: TimeRange[];
  keeps: TimeRange[];
  warnings: string[];
}

export interface PunchCue {
  start: number;
  end: number;
  scale: number;
  reason: string;
  text: string;
}

export interface PunchOptions {
  scale?: number;
  duration?: number;
  transition?: number;
  minGap?: number;
  maximumCues?: number;
  keywords?: readonly string[];
}

export interface AutomationAnalysisSettingsInput {
  minSilence?: unknown;
  padding?: unknown;
  trimLeading?: unknown;
  trimTrailing?: unknown;
  punchEnabled?: unknown;
  punchScale?: unknown;
  punchCount?: unknown;
  keywords?: unknown;
}

export interface AutomationAnalysisSettings {
  readonly minSilence: number;
  readonly padding: number;
  readonly trimLeading: boolean;
  readonly trimTrailing: boolean;
  readonly punchEnabled: boolean;
  readonly punchScale: number;
  readonly punchCount: number;
  readonly keywords: readonly string[];
}

export interface AutomationAnalysisFingerprintInput {
  readonly transcriptName: string;
  readonly sourceDuration: number;
  readonly segments: readonly TimedSpeechSegment[];
  readonly settings: AutomationAnalysisSettingsInput;
  readonly sourceContextKey?: string;
}

export interface ScaleKeyframe {
  time: number;
  scale: number;
  interpolation: "hold" | "bezier";
}

export const MAX_AUTOMATION_SEGMENTS = 10_000;
export const MAX_AUTOMATION_SEGMENT_TEXT_LENGTH = 4_000;
export const MAX_PUNCH_KEYWORDS = 100;
export const MAX_AUTOMATION_MARKERS = 500;

const DEFAULT_SILENCE = 0.42;
const DEFAULT_PADDING = 0.08;
const EPSILON = 1e-6;

function finite(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamped(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function range(start: number, end: number): TimeRange {
  const safeStart = Math.max(0, start);
  const safeEnd = Math.max(safeStart, end);
  return Object.freeze({ start: safeStart, end: safeEnd, duration: safeEnd - safeStart });
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSegments(left: TimedSpeechSegment, right: TimedSpeechSegment): number {
  return left.start - right.start || left.end - right.end ||
    compareText(left.text, right.text) || compareText(left.speaker ?? "", right.speaker ?? "");
}

export function normalizeSpeechSegments(
  segments: readonly TimedSpeechSegment[],
  sourceDuration: number,
): TimedSpeechSegment[] {
  const duration = Math.max(0, finite(sourceDuration));
  if (!Array.isArray(segments) || duration <= 0) return [];
  if (segments.length > MAX_AUTOMATION_SEGMENTS) {
    throw new RangeError(`자동 편집은 최대 ${MAX_AUTOMATION_SEGMENTS.toLocaleString("ko-KR")}개 STT 구간까지 처리할 수 있습니다.`);
  }
  return segments
    .map((segment) => {
      if (
        typeof segment?.start !== "number" || !Number.isFinite(segment.start) ||
        typeof segment?.end !== "number" || !Number.isFinite(segment.end)
      ) return null;
      const start = clamped(segment.start, 0, duration);
      const end = clamped(segment.end, 0, duration);
      const text = typeof segment?.text === "string" ? segment.text.trim() : "";
      if (text.length > MAX_AUTOMATION_SEGMENT_TEXT_LENGTH) {
        throw new RangeError(`STT 구간 텍스트는 최대 ${MAX_AUTOMATION_SEGMENT_TEXT_LENGTH.toLocaleString("ko-KR")}자입니다.`);
      }
      const speaker = typeof segment?.speaker === "string"
        ? segment.speaker.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 80)
        : "";
      if (start < 0 || end <= start || !text) return null;
      return speaker ? { start, end, text, speaker } : { start, end, text };
    })
    .filter((segment): segment is TimedSpeechSegment => Boolean(segment))
    .sort(compareSegments);
}

export function assertAutomationMarkerBudget(cutCount: number, punchCount: number): void {
  if (!Number.isSafeInteger(cutCount) || cutCount < 0 || !Number.isSafeInteger(punchCount) || punchCount < 0) {
    throw new RangeError("자동 편집 마커 개수는 0 이상의 안전한 정수여야 합니다.");
  }
  if (cutCount + punchCount > MAX_AUTOMATION_MARKERS) {
    throw new RangeError(
      `자동 편집 마커는 컷과 펀치인을 합쳐 최대 ${MAX_AUTOMATION_MARKERS.toLocaleString("ko-KR")}개까지 만들 수 있습니다.`,
    );
  }
}

export function normalizeAutomationAnalysisSettings(
  input: AutomationAnalysisSettingsInput = {},
): AutomationAnalysisSettings {
  const keywords = Array.isArray(input.keywords)
    ? keywordTokens(input.keywords)
    : [];
  return Object.freeze({
    minSilence: clamped(finite(input.minSilence, DEFAULT_SILENCE), 0.1, 10),
    padding: clamped(finite(input.padding, DEFAULT_PADDING), 0, 2),
    trimLeading: input.trimLeading !== false,
    trimTrailing: input.trimTrailing !== false,
    punchEnabled: input.punchEnabled === true,
    punchScale: clamped(finite(input.punchScale, 112), 101, 150),
    punchCount: Math.round(clamped(finite(input.punchCount, 12), 1, 100)),
    keywords: Object.freeze(keywords),
  });
}

function updateFingerprintHash(hash: number, label: string, value: string): number {
  const token = `${label.length}:${label}:${value.length}:${value};`;
  let next = hash >>> 0;
  for (let index = 0; index < token.length; index += 1) {
    next ^= token.charCodeAt(index);
    next = Math.imul(next, 0x01000193);
  }
  return next >>> 0;
}

/**
 * Builds an opaque, deterministic identity for the exact transcript, effective controls,
 * and Premiere project+sequence context used by an automation analysis. No source text or
 * host identifier is embedded in the returned value.
 */
export function createAutomationAnalysisFingerprint(
  input: AutomationAnalysisFingerprintInput,
): string {
  const duration = typeof input.sourceDuration === "number" && Number.isFinite(input.sourceDuration)
    ? input.sourceDuration
    : 0;
  if (duration <= 0) throw new RangeError("자동 편집 fingerprint에는 0초보다 긴 소스가 필요합니다.");
  const segments = normalizeSpeechSegments(input.segments, duration);
  const settings = normalizeAutomationAnalysisSettings(input.settings);
  const transcriptName = typeof input.transcriptName === "string"
    ? input.transcriptName.trim().slice(0, 512)
    : "";
  const sourceContextKey = typeof input.sourceContextKey === "string"
    ? input.sourceContextKey.trim().slice(0, 512)
    : "";
  let primary = 0x811c9dc5;
  let secondary = 0x9e3779b9;
  const append = (label: string, value: unknown): void => {
    const text = typeof value === "string" ? value : String(value);
    primary = updateFingerprintHash(primary, label, text);
    secondary = updateFingerprintHash(secondary, label, text);
  };
  append("schema", "shortflow.automation.analysis.v1");
  append("markerLimit", MAX_AUTOMATION_MARKERS);
  append("transcriptName", transcriptName);
  append("duration", duration);
  append("segmentCount", segments.length);
  segments.forEach((segment, index) => {
    append(`segment.${index}.start`, segment.start);
    append(`segment.${index}.end`, segment.end);
    append(`segment.${index}.text`, segment.text);
    append(`segment.${index}.speaker`, segment.speaker ?? "");
  });
  append("minSilence", settings.minSilence);
  append("padding", settings.padding);
  append("trimLeading", settings.trimLeading);
  append("trimTrailing", settings.trimTrailing);
  append("punchEnabled", settings.punchEnabled);
  append("punchScale", settings.punchScale);
  append("punchCount", settings.punchCount);
  append("keywordCount", settings.keywords.length);
  settings.keywords.forEach((keyword, index) => append(`keyword.${index}`, keyword));
  append("sourceContext", sourceContextKey);
  return `auto_v1_${primary.toString(36).padStart(7, "0")}_${secondary.toString(36).padStart(7, "0")}`;
}

function mergeRanges(ranges: readonly TimeRange[], maximumGap = 0): TimeRange[] {
  const merged: TimeRange[] = [];
  for (const current of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && current.start <= previous.end + maximumGap + EPSILON) {
      merged[merged.length - 1] = range(previous.start, Math.max(previous.end, current.end));
    } else if (current.duration > EPSILON) {
      merged.push(range(current.start, current.end));
    }
  }
  return merged;
}

function complementRanges(ranges: readonly TimeRange[], duration: number): TimeRange[] {
  const result: TimeRange[] = [];
  let cursor = 0;
  for (const item of ranges) {
    if (item.start > cursor + EPSILON) result.push(range(cursor, item.start));
    cursor = Math.max(cursor, item.end);
  }
  if (cursor < duration - EPSILON) result.push(range(cursor, duration));
  return result;
}

/**
 * STT 음성 구간 사이의 공백을 비파괴 편집 계획으로 변환합니다. 결과는 실제 Premiere
 * 액션을 실행하지 않으며, 사용자가 검토할 컷/유지 구간과 예상 길이를 제공합니다.
 */
export function planSilenceCuts(
  segments: readonly TimedSpeechSegment[],
  sourceDuration: number,
  options: SilenceCutOptions = {},
): SilenceCutPlan {
  const duration = Math.max(0, finite(sourceDuration));
  if (duration <= 0) throw new RangeError("분석할 소스 길이는 0초보다 커야 합니다.");
  const minSilence = clamped(finite(options.minSilence, DEFAULT_SILENCE), 0.1, 10);
  const padding = clamped(finite(options.padding, DEFAULT_PADDING), 0, 2);
  const minKeep = clamped(finite(options.minKeep, 0.12), 0, 5);
  const maximumCuts = Math.round(clamped(finite(options.maximumCuts, MAX_AUTOMATION_MARKERS), 1, MAX_AUTOMATION_MARKERS));
  const normalized = normalizeSpeechSegments(segments, duration);
  const warnings: string[] = [];
  if (normalized.length === 0) {
    warnings.push("유효한 STT 음성 구간이 없어 자동 컷을 만들지 않았습니다.");
    return {
      sourceDuration: duration,
      outputDuration: duration,
      removedDuration: 0,
      compressionRatio: 1,
      speech: [], cuts: [], keeps: [range(0, duration)], warnings,
    };
  }

  const actualSpeech = mergeRanges(normalized.map((segment) => range(segment.start, segment.end)));
  const speech = mergeRanges(normalized.map((segment) => range(
    Math.max(0, segment.start - padding),
    Math.min(duration, segment.end + padding),
  )));
  const rawSilences = complementRanges(speech, duration);
  const cuts = rawSilences.filter((silence, index) => {
    const leading = index === 0 && silence.start <= EPSILON;
    const trailing = index === rawSilences.length - 1 && silence.end >= duration - EPSILON;
    if (leading && options.trimLeading === false) return false;
    if (trailing && options.trimTrailing === false) return false;
    return silence.duration + EPSILON >= minSilence;
  });
  let keeps = complementRanges(cuts, duration);

  // 너무 짧은 잔여 조각은 인접 컷에 흡수해 1~2프레임짜리 플래시 컷을 방지합니다.
  if (minKeep > 0 && keeps.some((item) => item.duration < minKeep)) {
    const expandedCuts = [...cuts];
    let absorbedSilenceKeeps = 0;
    let protectedSpeechKeeps = 0;
    for (const keep of keeps) {
      if (keep.duration + EPSILON >= minKeep) continue;
      const containsSpeech = actualSpeech.some((speechRange) =>
        keep.start < speechRange.end && keep.end > speechRange.start);
      if (containsSpeech) {
        protectedSpeechKeeps += 1;
        continue;
      }
      expandedCuts.push(keep);
      absorbedSilenceKeeps += 1;
    }
    if (absorbedSilenceKeeps > 0) {
      const mergedCuts = mergeRanges(expandedCuts.sort((a, b) => a.start - b.start));
      keeps = complementRanges(mergedCuts, duration);
      cuts.splice(0, cuts.length, ...mergedCuts);
      warnings.push("실제 발화가 없는 너무 짧은 잔여 구간을 인접 무음 컷에 합쳤습니다.");
    }
    if (protectedSpeechKeeps > 0) warnings.push("최소 유지 길이보다 짧은 실제 발화 구간은 삭제하지 않고 보존했습니다.");
  }
  if (cuts.length > maximumCuts) throw new RangeError(
    `자동 컷 계획은 최대 ${maximumCuts.toLocaleString("ko-KR")}개까지 만들 수 있습니다. ` +
    "최소 무음 길이를 늘리거나 분석 범위를 줄여 주세요.",
  );
  assertAutomationMarkerBudget(cuts.length, 0);

  const removedDuration = cuts.reduce((sum, item) => sum + item.duration, 0);
  const outputDuration = Math.max(0, duration - removedDuration);
  if (cuts.length === 0) warnings.push("설정한 기준보다 긴 무음 구간이 없습니다.");
  if (removedDuration > duration * 0.6) warnings.push("원본의 60% 이상이 제거됩니다. 적용 전에 컷 목록을 검토해 주세요.");

  return {
    sourceDuration: duration,
    outputDuration,
    removedDuration,
    compressionRatio: outputDuration / duration,
    speech,
    cuts,
    keeps,
    warnings,
  };
}

function keywordTokens(keywords: readonly string[]): string[] {
  return [...new Set(keywords.slice(0, MAX_PUNCH_KEYWORDS)
    .map((keyword) => typeof keyword === "string" ? keyword.normalize("NFKC").trim().slice(0, 80).toLocaleLowerCase() : "")
    .filter(Boolean))];
}

function cueScore(segment: TimedSpeechSegment, keywords: readonly string[]): { score: number; reason: string } {
  const text = segment.text.normalize("NFKC");
  const lowered = text.toLocaleLowerCase();
  const matched = keywords.find((keyword) => lowered.includes(keyword));
  let score = matched ? 5 : 0;
  if (/[!?！？]/u.test(text)) score += 3;
  if (/["“”'‘’][^"“”'‘’]+["“”'‘’]/u.test(text)) score += 1;
  if (/\b(?:중요|핵심|반드시|절대|비밀|결론|방법|이유|무료|주의)\b/iu.test(text)) score += 2;
  if (text.length >= 8 && text.length <= 45) score += 1;
  return { score, reason: matched ? `키워드: ${matched}` : score >= 3 ? "강조 문장" : "리듬 변화" };
}

export function recommendPunchCues(
  segments: readonly TimedSpeechSegment[],
  sourceDuration: number,
  options: PunchOptions = {},
): PunchCue[] {
  const duration = Math.max(0, finite(sourceDuration));
  const normalized = normalizeSpeechSegments(segments, duration);
  if (duration <= 0) return [];
  const scale = clamped(finite(options.scale, 112), 101, 150);
  const cueDuration = clamped(finite(options.duration, 0.9), 0.25, 3);
  const minGap = clamped(finite(options.minGap, 2.2), 0.5, 30);
  const maximum = Math.round(clamped(finite(options.maximumCues, 12), 1, 100));
  const keywords = keywordTokens(options.keywords ?? []);
  const candidates = normalized
    .map((segment) => ({ segment, ...cueScore(segment, keywords) }))
    .sort((left, right) => right.score - left.score || compareSegments(left.segment, right.segment));

  const selected: PunchCue[] = [];
  for (const candidate of candidates) {
    if (selected.length >= maximum) break;
    const center = (candidate.segment.start + candidate.segment.end) / 2;
    if (selected.some((cue) => Math.abs(((cue.start + cue.end) / 2) - center) < minGap)) continue;
    const start = clamped(center - cueDuration / 2, 0, Math.max(0, duration - cueDuration));
    const end = Math.min(duration, start + cueDuration);
    if (end <= start + EPSILON) continue;
    if (selected.some((cue) => start < cue.end - EPSILON && end > cue.start + EPSILON)) continue;
    selected.push({ start, end, scale, reason: candidate.reason, text: candidate.segment.text });
  }
  return selected.sort((left, right) => left.start - right.start || left.end - right.end || compareText(left.text, right.text));
}

export function buildPunchKeyframes(
  cues: readonly PunchCue[],
  baseScale = 100,
  transition = 0.12,
): ScaleKeyframe[] {
  const base = clamped(finite(baseScale, 100), 1, 10_000);
  const ramp = clamped(finite(transition, 0.12), 0.02, 1);
  const frames: ScaleKeyframe[] = [];
  for (const cue of [...cues].sort((left, right) =>
    left.start - right.start || left.end - right.end || left.scale - right.scale ||
    compareText(left.text, right.text) || compareText(left.reason, right.reason))) {
    if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.end <= cue.start) continue;
    const localRamp = Math.min(ramp, (cue.end - cue.start) / 2);
    frames.push(
      { time: cue.start, scale: base, interpolation: "bezier" },
      { time: cue.start + localRamp, scale: clamped(cue.scale, base, 10_000), interpolation: "bezier" },
      { time: cue.end - localRamp, scale: clamped(cue.scale, base, 10_000), interpolation: "hold" },
      { time: cue.end, scale: base, interpolation: "bezier" },
    );
  }
  const byTime = new Map<string, ScaleKeyframe>();
  for (const frame of frames) byTime.set(frame.time.toFixed(6), frame);
  return [...byTime.values()].sort((left, right) => left.time - right.time);
}
