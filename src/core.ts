export type ReframeMode = "fill" | "fit" | "none";
export type RangeMode = "full" | "inout" | "playhead";

export interface ShortProfile {
  id: string;
  label: string;
  width: number;
  height: number;
  maxDuration: number;
}

export const PROFILES: readonly ShortProfile[] = Object.freeze([
  Object.freeze({
    id: "youtube-shorts",
    label: "YouTube Shorts (9:16)",
    width: 1080,
    height: 1920,
    maxDuration: 180,
  }),
  Object.freeze({
    id: "instagram-reels",
    label: "Instagram Reels (9:16)",
    width: 1080,
    height: 1920,
    maxDuration: 90,
  }),
  Object.freeze({
    id: "tiktok",
    label: "TikTok (9:16)",
    width: 1080,
    height: 1920,
    maxDuration: 600,
  }),
  Object.freeze({
    id: "square",
    label: "Square (1:1)",
    width: 1080,
    height: 1080,
    maxDuration: 60,
  }),
] as const);

// RegExp 생성자를 사용해 정적 분석기의 no-control-regex 오탐을 피하면서
// Windows 제어 문자를 포함한 파일명 금지 문자를 동일하게 제거합니다.
const CONTROL_CHARACTERS = new RegExp("[\\x00-\\x1f]", "gu");
const INVALID_NAME_CHARACTERS = new RegExp("[<>:\"/\\\\|?*\\x00-\\x1f]", "gu");
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

function safeLimit(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || !value || value < 1) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

export function sanitizeSequenceName(value: unknown, maxLength = 120): string {
  const limit = safeLimit(maxLength, 120);
  const cleaned = String(value ?? "")
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/[<>:"/\\|?*]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, limit)
    .trim();
  return cleaned || "ShortFlow";
}

function splitExtension(value: string): { stem: string; extension: string } {
  const lastDot = value.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === value.length - 1) {
    return { stem: value, extension: "" };
  }
  return {
    stem: value.slice(0, lastDot),
    extension: value.slice(lastDot),
  };
}

export function sanitizeFileName(value: unknown, maxLength = 180): string {
  const limit = safeLimit(maxLength, 180);
  let cleaned = String(value ?? "")
    .replace(INVALID_NAME_CHARACTERS, "_")
    .replace(/\.\.+/gu, "_")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[. ]+$/gu, "");

  if (!cleaned || /^[_ .-]+$/u.test(cleaned)) {
    return "shortflow".slice(0, limit);
  }

  if (WINDOWS_RESERVED_NAME.test(cleaned)) {
    cleaned = `_${cleaned}`;
  }

  if (cleaned.length > limit) {
    const { stem, extension } = splitExtension(cleaned);
    const safeExtension = extension.length < limit ? extension : "";
    cleaned = `${stem.slice(0, Math.max(1, limit - safeExtension.length))}${safeExtension}`;
  }

  cleaned = cleaned.replace(/[. ]+$/gu, "");
  return cleaned || "shortflow".slice(0, limit);
}

function positiveFinite(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function calculateRelativeScale(
  currentScale: number,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  mode: ReframeMode,
): number {
  const baseScale = positiveFinite(currentScale, 100);
  if (mode === "none") {
    return baseScale;
  }

  const dimensions = [sourceWidth, sourceHeight, targetWidth, targetHeight];
  if (dimensions.some((dimension) => !Number.isFinite(dimension) || dimension <= 0)) {
    return baseScale;
  }

  const widthRatio = targetWidth / sourceWidth;
  const heightRatio = targetHeight / sourceHeight;
  const ratio = mode === "fit"
    ? Math.min(widthRatio, heightRatio)
    : Math.max(widthRatio, heightRatio);
  const next = baseScale * ratio;
  return positiveFinite(next, baseScale);
}

export interface ResolveTimeRangeInput {
  mode: RangeMode;
  sequenceEnd: number;
  inPoint?: number;
  outPoint?: number;
  playhead?: number;
  maxDuration?: number;
}

export interface ResolvedTimeRange {
  start: number;
  end: number;
  duration: number;
  usedFallback: boolean;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function validOptionalDuration(value: number | undefined): number | null {
  return Number.isFinite(value) && value !== undefined && value > 0 ? value : null;
}

export function resolveTimeRange(input: ResolveTimeRangeInput): ResolvedTimeRange {
  const sequenceEnd = Number.isFinite(input.sequenceEnd) && input.sequenceEnd > 0
    ? input.sequenceEnd
    : 0;
  const maximum = validOptionalDuration(input.maxDuration);
  let start = 0;
  let end = sequenceEnd;
  let usedFallback = false;

  if (input.mode === "inout") {
    const hasFinitePoints = Number.isFinite(input.inPoint) && Number.isFinite(input.outPoint);
    if (hasFinitePoints && input.inPoint !== undefined && input.outPoint !== undefined && input.outPoint > input.inPoint) {
      start = clamp(input.inPoint, 0, sequenceEnd);
      end = clamp(input.outPoint, 0, sequenceEnd);
      if (end <= start) {
        start = 0;
        end = sequenceEnd;
        usedFallback = true;
      }
    } else {
      usedFallback = true;
    }
  } else if (input.mode === "playhead") {
    if (Number.isFinite(input.playhead) && input.playhead !== undefined) {
      start = clamp(input.playhead, 0, sequenceEnd);
      end = sequenceEnd;
    } else {
      usedFallback = true;
    }
  }

  if (maximum !== null) {
    end = Math.min(end, start + maximum);
  }

  start = Number.isFinite(start) ? start : 0;
  end = Number.isFinite(end) ? Math.max(start, end) : start;
  const duration = Math.max(0, end - start);
  return { start, end, duration, usedFallback };
}

export interface MarkerInput {
  name: string;
  comments: string;
  start: number;
  duration: number;
  index: number;
}

export interface MarkerSegment {
  name: string;
  comments: string;
  start: number;
  end: number;
  duration: number;
  index: number;
}

export function markerToSegment(
  marker: MarkerInput,
  sequenceEnd: number,
  defaultDuration: number,
): MarkerSegment | null {
  if (
    !Number.isFinite(marker.start)
    || !Number.isFinite(marker.duration)
    || !Number.isFinite(sequenceEnd)
    || sequenceEnd <= 0
    || marker.start >= sequenceEnd
  ) {
    return null;
  }

  const start = Math.max(0, marker.start);
  const fallback = positiveFinite(defaultDuration, 1);
  const requestedDuration = marker.duration > 0 ? marker.duration : fallback;
  const end = Math.min(sequenceEnd, start + requestedDuration);
  if (end <= start) {
    return null;
  }

  return {
    name: sanitizeSequenceName(marker.name || `Short ${marker.index + 1}`),
    comments: String(marker.comments ?? ""),
    start,
    end,
    duration: end - start,
    index: Number.isInteger(marker.index) ? marker.index : 0,
  };
}

export function formatDuration(seconds: number): string {
  const whole = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const remainingSeconds = whole % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(remainingSeconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

export type QCLevel = "error" | "warning" | "pass";

export interface QCItem {
  level: QCLevel;
  code: string;
  message: string;
}

export interface ValidateShortInput {
  width: number;
  height: number;
  duration: number;
  captionTrackCount: number;
  videoTrackCount: number;
  audioTrackCount: number;
  expectedWidth: number;
  expectedHeight: number;
  maxDuration: number;
  name: string;
}

function qc(level: QCLevel, code: string, message: string): QCItem {
  return { level, code, message };
}

export function validateShort(input: ValidateShortInput): QCItem[] {
  const results: QCItem[] = [];
  const frameValid = Number.isFinite(input.width)
    && Number.isFinite(input.height)
    && input.width === input.expectedWidth
    && input.height === input.expectedHeight;
  results.push(frameValid
    ? qc("pass", "frame-size", `프레임 크기가 ${input.width}×${input.height}로 정확합니다.`)
    : qc("error", "frame-size", `프레임 크기를 ${input.expectedWidth}×${input.expectedHeight}로 맞춰 주세요.`));

  const durationValid = Number.isFinite(input.duration) && input.duration > 0;
  if (!durationValid) {
    results.push(qc("error", "duration", "내보낼 수 있는 유효한 길이가 없습니다."));
  } else if (Number.isFinite(input.maxDuration) && input.maxDuration > 0 && input.duration > input.maxDuration) {
    results.push(qc("warning", "duration-limit", `현재 길이가 플랫폼 권장 한도 ${formatDuration(input.maxDuration)}를 초과합니다.`));
  } else {
    results.push(qc("pass", "duration", `길이 ${formatDuration(input.duration)}가 설정 범위 안입니다.`));
  }

  results.push(input.videoTrackCount > 0
    ? qc("pass", "video-track", `비디오 트랙 ${input.videoTrackCount}개를 확인했습니다.`)
    : qc("error", "video-track", "비디오 트랙이 없습니다."));

  results.push(input.audioTrackCount > 0
    ? qc("pass", "audio-track", `오디오 트랙 ${input.audioTrackCount}개를 확인했습니다.`)
    : qc("warning", "audio-track", "오디오 트랙이 없습니다. 무음 숏폼인지 확인해 주세요."));

  results.push(input.captionTrackCount > 0
    ? qc("pass", "caption-track", `캡션 트랙 ${input.captionTrackCount}개를 확인했습니다.`)
    : qc("warning", "caption-track", "캡션 트랙이 없습니다. 무음 시청 환경을 고려해 주세요."));

  results.push(String(input.name ?? "").trim()
    ? qc("pass", "sequence-name", "시퀀스 이름이 지정되어 있습니다.")
    : qc("warning", "sequence-name", "시퀀스 이름이 비어 있습니다."));

  return results;
}
