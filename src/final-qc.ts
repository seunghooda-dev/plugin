import { PROFILES, sanitizeFileName, validateShort } from "./core";
import {
  SAFE_ZONE_PROFILES,
  assessSafeZone,
  type NormalizedRect,
  type SocialPlatform,
} from "./safe-zone";

export const FINAL_QC_SCHEMA_VERSION = 1 as const;
export const MAX_QC_SNAPSHOT_BYTES = 5 * 1024 * 1024;
export const MAX_QC_CAPTIONS = 5_000;
export const MAX_QC_ELEMENTS = 5_000;
export const MAX_QC_MEDIA_ITEMS = 10_000;
export const MAX_QC_WAIVERS = 200;

export type FinalQCLevel = "pass" | "warning" | "error";
export type FinalQCCategory =
  | "sequence"
  | "caption"
  | "safe-zone"
  | "audio"
  | "media"
  | "output";

export interface FinalQCProfile {
  id: SocialPlatform;
  label: string;
  width: number;
  height: number;
  maxDuration: number;
  allowedFrameRates: readonly number[];
  minCaptionSeconds: number;
  maxCaptionCps: number;
  maxTruePeakDbtp: number;
  maxSilenceSeconds: number;
  minDialogueBgmDifferenceDb: number;
  maxDialogueBgmDifferenceDb: number;
  safeZoneRevision: string;
  outputExtensions: readonly string[];
}

function coreProfile(id: SocialPlatform): (typeof PROFILES)[number] {
  const profile = PROFILES.find((candidate) => candidate.id === id);
  if (!profile) throw new Error(`Missing core QC profile: ${id}`);
  return profile;
}

function makeProfile(
  id: SocialPlatform,
  maxCaptionCps: number,
  minCaptionSeconds: number,
): FinalQCProfile {
  const base = coreProfile(id);
  return Object.freeze({
    id,
    label: SAFE_ZONE_PROFILES[id].label,
    width: base.width,
    height: base.height,
    maxDuration: base.maxDuration,
    allowedFrameRates: Object.freeze([23.976, 24, 25, 29.97, 30, 50, 59.94, 60]),
    minCaptionSeconds,
    maxCaptionCps,
    maxTruePeakDbtp: -1,
    maxSilenceSeconds: 3,
    minDialogueBgmDifferenceDb: 6,
    maxDialogueBgmDifferenceDb: 18,
    safeZoneRevision: SAFE_ZONE_PROFILES[id].revision,
    outputExtensions: Object.freeze([".mp4"]),
  });
}

export const FINAL_QC_PROFILES: Readonly<Record<SocialPlatform, FinalQCProfile>> =
  Object.freeze({
    "youtube-shorts": makeProfile("youtube-shorts", 17, 0.8),
    "instagram-reels": makeProfile("instagram-reels", 20, 0.8),
    tiktok: makeProfile("tiktok", 20, 0.7),
  });

export interface SequenceQCSnapshot {
  name: string;
  width: number;
  height: number;
  duration: number;
  frameRate: number;
  videoTrackCount: number;
  audioTrackCount: number;
}

export interface CaptionQCSnapshot {
  id: string;
  text: string;
  start: number;
  end: number;
  rect: NormalizedRect;
}

export interface SafeZoneElementSnapshot {
  id: string;
  label: string;
  rect: NormalizedRect;
}

export interface AudioQCSnapshot {
  truePeakDbtp?: number;
  clippedSampleCount?: number;
  longestSilenceSeconds?: number;
  totalSilenceSeconds?: number;
  dialogueLufs?: number;
  bgmLufs?: number;
}

export interface MediaQCSnapshot {
  offlineMedia: readonly string[];
  missingFonts: readonly string[];
  missingAssets: readonly string[];
  guideOverlays: readonly string[];
}

export interface OutputQCSnapshot {
  fileName: string;
  directoryPath: string;
  exists?: boolean;
}

export interface FinalQCSnapshot {
  platform: SocialPlatform;
  sequence: SequenceQCSnapshot;
  captions: readonly CaptionQCSnapshot[];
  safeZoneElements: readonly SafeZoneElementSnapshot[];
  audio: AudioQCSnapshot;
  media: MediaQCSnapshot;
  output: OutputQCSnapshot;
}

export interface QCWaiver {
  code: string;
  reason: string;
  createdAt: number;
}

export interface QCCheck {
  code: string;
  category: FinalQCCategory;
  level: FinalQCLevel;
  message: string;
  hardBlock: boolean;
  waived: boolean;
  waiver?: QCWaiver;
}

export interface FinalQCReport {
  schemaVersion: typeof FINAL_QC_SCHEMA_VERSION;
  generatedAt: number;
  platform: SocialPlatform;
  profile: FinalQCProfile;
  snapshotSummary: {
    sequenceName: string;
    dimensions: string;
    duration: number;
    frameRate: number;
    captionCount: number;
    outputFileName: string;
  };
  checks: QCCheck[];
  counts: Record<FinalQCLevel, number>;
  status: FinalQCLevel;
  blocking: boolean;
  blockingCodes: string[];
  acceptedWaivers: QCWaiver[];
  rejectedWaivers: Array<QCWaiver & { reasonRejected: string }>;
}

export type FinalQCErrorCode =
  | "INVALID_SNAPSHOT"
  | "INPUT_TOO_LARGE"
  | "UNSUPPORTED_PLATFORM";

export class FinalQCError extends Error {
  override readonly name = "FinalQCError";
  readonly code: FinalQCErrorCode;

  constructor(code: FinalQCErrorCode, message: string) {
    super(message);
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface MutableCheck extends Omit<QCCheck, "waived"> {
  waived?: boolean;
}

const HARD_BLOCK_CODES = new Set([
  "frame-size",
  "aspect-ratio",
  "duration",
  "video-track",
  "caption-outside-frame",
  "caption-invalid-time",
  "audio-clipping",
  "offline-media",
  "missing-font",
  "missing-asset",
  "guide-overlay",
  "output-filename",
  "output-path",
]);

const SECRET_KEY_PATTERN = /api.?key|authorization|bearer|password|secret|access.?token|refresh.?token/iu;

export function redactQCText(value: unknown): string {
  const text = String(value ?? "");
  return text
    .replace(/(authorization\s*[:=]\s*)bearer\s+[^\s,;"'}]+/giu, "$1Bearer [REDACTED]")
    .replace(/\bbearer\s+[a-z0-9._~+/-]{8,}/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk|sess)-[a-z0-9_-]{8,}\b/giu, "[REDACTED]")
    .replace(/((?:api[_-]?key|password|secret|access[_-]?token|refresh[_-]?token)\s*[:=]\s*)[^\s,;]+/giu, "$1[REDACTED]")
    .slice(0, 2_000);
}

function redactedClone(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return redactQCText(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return undefined;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return "[BINARY_OMITTED]";
  const object = value as object;
  if (seen.has(object)) return "[CIRCULAR]";
  seen.add(object);
  try {
    if (Array.isArray(value)) return value.map((item) => redactedClone(item, seen));
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SECRET_KEY_PATTERN.test(key) ? "[REDACTED]" : redactedClone(item, seen);
    }
    return result;
  } finally {
    seen.delete(object);
  }
}

export function redactQCSnapshot(snapshot: FinalQCSnapshot): FinalQCSnapshot {
  return redactedClone(snapshot) as FinalQCSnapshot;
}

function check(
  code: string,
  category: FinalQCCategory,
  level: FinalQCLevel,
  message: string,
  hardBlock = HARD_BLOCK_CODES.has(code),
): MutableCheck {
  return { code, category, level, message: redactQCText(message), hardBlock };
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function approximately(value: number, expected: number, tolerance = 0.015): boolean {
  return Math.abs(value - expected) <= tolerance;
}

function validateInput(snapshot: FinalQCSnapshot, waivers: readonly QCWaiver[]): void {
  if (!snapshot || typeof snapshot !== "object") {
    throw new FinalQCError("INVALID_SNAPSHOT", "최종 QC snapshot이 필요합니다.");
  }
  if (!Object.prototype.hasOwnProperty.call(FINAL_QC_PROFILES, snapshot.platform)) {
    throw new FinalQCError("UNSUPPORTED_PLATFORM", "지원하지 않는 숏폼 플랫폼입니다.");
  }
  const arrays: Array<{ value: unknown; max: number; label: string }> = [
    { value: snapshot.captions, max: MAX_QC_CAPTIONS, label: "captions" },
    { value: snapshot.safeZoneElements, max: MAX_QC_ELEMENTS, label: "safeZoneElements" },
    { value: snapshot.media?.offlineMedia, max: MAX_QC_MEDIA_ITEMS, label: "offlineMedia" },
    { value: snapshot.media?.missingFonts, max: MAX_QC_MEDIA_ITEMS, label: "missingFonts" },
    { value: snapshot.media?.missingAssets, max: MAX_QC_MEDIA_ITEMS, label: "missingAssets" },
    { value: snapshot.media?.guideOverlays, max: MAX_QC_MEDIA_ITEMS, label: "guideOverlays" },
    { value: waivers, max: MAX_QC_WAIVERS, label: "waivers" },
  ];
  for (const item of arrays) {
    if (!Array.isArray(item.value)) {
      throw new FinalQCError("INVALID_SNAPSHOT", `${item.label}은 배열이어야 합니다.`);
    }
    if (item.value.length > item.max) {
      throw new FinalQCError("INPUT_TOO_LARGE", `${item.label} 입력 개수가 안전 한도를 초과했습니다.`);
    }
  }
  let serialized: string;
  try { serialized = JSON.stringify(snapshot); } catch {
    throw new FinalQCError("INVALID_SNAPSHOT", "순환 참조가 있는 snapshot은 검사할 수 없습니다.");
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_QC_SNAPSHOT_BYTES) {
    throw new FinalQCError("INPUT_TOO_LARGE", "최종 QC snapshot 크기가 5MB를 초과했습니다.");
  }
}

function outOfFrame(rect: NormalizedRect): boolean {
  return !rect || ![rect.x, rect.y, rect.width, rect.height].every(finite) ||
    rect.width <= 0 || rect.height <= 0 || rect.x < 0 || rect.y < 0 ||
    rect.x + rect.width > 1 + 1e-9 || rect.y + rect.height > 1 + 1e-9;
}

function extensionOf(fileName: string): string {
  const index = fileName.lastIndexOf(".");
  return index > 0 ? fileName.slice(index).toLocaleLowerCase("en-US") : "";
}

function pathIsSafe(path: string): boolean {
  if (!path || path.length > 2_048 || /[\0\r\n]/u.test(path) || /^[a-z][a-z\d+.-]*:/iu.test(path) && !/^[a-z]:[\\/]/iu.test(path)) return false;
  const absolute = /^(?:[a-z]:[\\/]|\\\\|\/)/iu.test(path);
  const traversal = path.replace(/\\/gu, "/").split("/").includes("..");
  return absolute && !traversal;
}

function addSequenceChecks(
  snapshot: FinalQCSnapshot,
  profile: FinalQCProfile,
  checks: MutableCheck[],
): void {
  const coreChecks = validateShort({
    width: snapshot.sequence.width,
    height: snapshot.sequence.height,
    duration: snapshot.sequence.duration,
    captionTrackCount: snapshot.captions.length > 0 ? 1 : 0,
    videoTrackCount: snapshot.sequence.videoTrackCount,
    audioTrackCount: snapshot.sequence.audioTrackCount,
    expectedWidth: profile.width,
    expectedHeight: profile.height,
    maxDuration: profile.maxDuration,
    name: snapshot.sequence.name,
  });
  for (const item of coreChecks) {
    const level = item.code === "duration-limit" && item.level === "warning" ? "error" : item.level;
    checks.push(check(item.code, "sequence", level, item.message));
  }

  const ratio = snapshot.sequence.width / snapshot.sequence.height;
  const expectedRatio = profile.width / profile.height;
  checks.push(approximately(ratio, expectedRatio, 0.001)
    ? check("aspect-ratio", "sequence", "pass", "출력 종횡비가 9:16으로 정확합니다.")
    : check("aspect-ratio", "sequence", "error", "출력 종횡비를 9:16으로 맞춰 주세요."));

  const frameRate = snapshot.sequence.frameRate;
  const allowed = finite(frameRate) && profile.allowedFrameRates.some((rate) => approximately(frameRate, rate));
  checks.push(allowed
    ? check("frame-rate", "sequence", "pass", `프레임레이트 ${frameRate}fps를 사용할 수 있습니다.`)
    : check("frame-rate", "sequence", "error", "지원되는 프레임레이트를 선택해 주세요.", false));
}

function addCaptionChecks(
  snapshot: FinalQCSnapshot,
  profile: FinalQCProfile,
  checks: MutableCheck[],
): void {
  if (snapshot.captions.length === 0) {
    checks.push(check("caption-exists", "caption", "warning", "캡션이 없습니다. 무음 시청 환경을 확인해 주세요.", false));
    return;
  }
  checks.push(check("caption-exists", "caption", "pass", `캡션 ${snapshot.captions.length}개를 확인했습니다.`, false));
  const sorted = [...snapshot.captions].sort((left, right) => left.start - right.start);
  let previous: CaptionQCSnapshot | undefined;
  for (const caption of sorted) {
    const duration = caption.end - caption.start;
    const timeValid = finite(caption.start) && finite(caption.end) && caption.start >= 0 && caption.end <= snapshot.sequence.duration + 1e-6 && duration > 0;
    if (!timeValid) {
      checks.push(check("caption-invalid-time", "caption", "error", "유효 범위를 벗어난 캡션 시간이 있습니다."));
      continue;
    }
    const text = String(caption.text ?? "").trim();
    checks.push(text
      ? check("caption-text", "caption", "pass", "캡션 텍스트가 비어 있지 않습니다.", false)
      : check("caption-text", "caption", "error", "빈 캡션 텍스트가 있습니다.", false));
    checks.push(duration >= profile.minCaptionSeconds
      ? check("caption-min-exposure", "caption", "pass", "캡션 노출 시간이 최소 기준을 충족합니다.", false)
      : check("caption-min-exposure", "caption", "warning", `최소 ${profile.minCaptionSeconds}초보다 짧은 캡션이 있습니다.`, false));
    const characters = [...text.replace(/\s/gu, "")].length;
    const cps = duration > 0 ? characters / duration : Infinity;
    checks.push(cps <= profile.maxCaptionCps
      ? check("caption-cps", "caption", "pass", "캡션 읽기 속도가 기준 안입니다.", false)
      : check("caption-cps", "caption", "error", `최대 ${profile.maxCaptionCps} CPS를 초과한 캡션이 있습니다.`, false));

    if (outOfFrame(caption.rect)) {
      checks.push(check("caption-outside-frame", "caption", "error", "화면 밖으로 나간 캡션이 있습니다."));
    } else {
      checks.push(check("caption-outside-frame", "caption", "pass", "캡션이 출력 프레임 안에 있습니다."));
      const assessment = assessSafeZone(caption.rect, snapshot.platform, "caption");
      checks.push(assessment.inside
        ? check("caption-safe-zone", "safe-zone", "pass", "캡션이 플랫폼 안전영역 안에 있습니다.", false)
        : check("caption-safe-zone", "safe-zone", "warning", "플랫폼 UI에 가려질 수 있는 캡션이 있습니다.", false));
    }
    if (previous && caption.start < previous.end - 1e-6) {
      checks.push(check("caption-overlap", "caption", "error", "시간이 겹치는 캡션이 있습니다.", false));
    }
    previous = !previous || caption.end > previous.end ? caption : previous;
  }
}

function addSafeZoneChecks(snapshot: FinalQCSnapshot, checks: MutableCheck[]): void {
  if (snapshot.safeZoneElements.length === 0) {
    checks.push(check("content-safe-zone", "safe-zone", "pass", "별도 안전영역 검사 요소가 없습니다.", false));
    return;
  }
  for (const element of snapshot.safeZoneElements) {
    if (outOfFrame(element.rect)) {
      checks.push(check("content-outside-frame", "safe-zone", "error", "화면 밖으로 나간 그래픽 요소가 있습니다.", false));
      continue;
    }
    const assessment = assessSafeZone(element.rect, snapshot.platform, "content");
    checks.push(assessment.inside
      ? check("content-safe-zone", "safe-zone", "pass", "그래픽 요소가 플랫폼 안전영역 안에 있습니다.", false)
      : check("content-safe-zone", "safe-zone", "warning", "플랫폼 UI 안전영역을 침범한 그래픽 요소가 있습니다.", false));
  }
}

function addAudioChecks(
  snapshot: FinalQCSnapshot,
  profile: FinalQCProfile,
  checks: MutableCheck[],
): void {
  const audio = snapshot.audio;
  const clipped = finite(audio.clippedSampleCount) ? Math.max(0, audio.clippedSampleCount) : 0;
  checks.push(clipped === 0
    ? check("audio-clipping", "audio", "pass", "디지털 클리핑이 없습니다.")
    : check("audio-clipping", "audio", "error", "클리핑된 오디오 샘플이 있습니다."));

  if (!finite(audio.truePeakDbtp)) {
    checks.push(check("audio-true-peak", "audio", "warning", "True Peak 측정값이 없습니다.", false));
  } else if (audio.truePeakDbtp <= profile.maxTruePeakDbtp) {
    checks.push(check("audio-true-peak", "audio", "pass", `True Peak가 ${profile.maxTruePeakDbtp} dBTP 이하입니다.`, false));
  } else {
    checks.push(check("audio-true-peak", "audio", "error", `True Peak를 ${profile.maxTruePeakDbtp} dBTP 이하로 낮춰 주세요.`, audio.truePeakDbtp > 0));
  }

  const silence = finite(audio.longestSilenceSeconds) ? Math.max(0, audio.longestSilenceSeconds) : 0;
  if (silence >= snapshot.sequence.duration - 1e-6 && snapshot.sequence.duration > 0 && snapshot.sequence.audioTrackCount > 0) {
    checks.push(check("audio-silence", "audio", "error", "오디오 트랙 전체가 무음으로 감지되었습니다.", false));
  } else if (silence > profile.maxSilenceSeconds) {
    checks.push(check("audio-silence", "audio", "warning", `${profile.maxSilenceSeconds}초를 넘는 무음 구간이 있습니다.`, false));
  } else {
    checks.push(check("audio-silence", "audio", "pass", "긴 무음 구간이 없습니다.", false));
  }

  if (finite(audio.dialogueLufs) && finite(audio.bgmLufs)) {
    const difference = audio.dialogueLufs - audio.bgmLufs;
    if (difference < profile.minDialogueBgmDifferenceDb) {
      checks.push(check("dialogue-bgm-balance", "audio", "error", "BGM이 대사를 가릴 수 있습니다.", false));
    } else if (difference > profile.maxDialogueBgmDifferenceDb) {
      checks.push(check("dialogue-bgm-balance", "audio", "warning", "대사와 BGM 레벨 차이가 지나치게 큽니다.", false));
    } else {
      checks.push(check("dialogue-bgm-balance", "audio", "pass", "대사와 BGM 균형이 기준 안입니다.", false));
    }
  } else {
    checks.push(check("dialogue-bgm-balance", "audio", "warning", "대사/BGM 라우드니스 측정값이 없습니다.", false));
  }
}

function countCheck(
  checks: MutableCheck[],
  code: string,
  label: string,
  items: readonly string[],
): void {
  checks.push(items.length === 0
    ? check(code, "media", "pass", `${label} 문제가 없습니다.`)
    : check(code, "media", "error", `${label} ${items.length}개를 해결해야 합니다.`));
}

function addMediaChecks(snapshot: FinalQCSnapshot, checks: MutableCheck[]): void {
  countCheck(checks, "offline-media", "오프라인 미디어", snapshot.media.offlineMedia);
  countCheck(checks, "missing-font", "누락 폰트", snapshot.media.missingFonts);
  countCheck(checks, "missing-asset", "누락 에셋", snapshot.media.missingAssets);
  countCheck(checks, "guide-overlay", "남아 있는 가이드 오버레이", snapshot.media.guideOverlays);
}

function addOutputChecks(
  snapshot: FinalQCSnapshot,
  profile: FinalQCProfile,
  checks: MutableCheck[],
): void {
  const fileName = String(snapshot.output.fileName ?? "").trim();
  const sanitized = sanitizeFileName(fileName);
  const nameValid = fileName.length > 0 && fileName.length <= 180 && fileName === sanitized && !/[\\/]/u.test(fileName);
  checks.push(nameValid
    ? check("output-filename", "output", "pass", "출력 파일명이 안전합니다.")
    : check("output-filename", "output", "error", "출력 파일명에 금지 문자, 경로 구분자 또는 예약 이름이 있습니다."));

  const extension = extensionOf(fileName);
  checks.push(profile.outputExtensions.includes(extension)
    ? check("output-format", "output", "pass", "출력 컨테이너 형식이 플랫폼 전달 규격에 맞습니다.", false)
    : check("output-format", "output", "error", `출력 확장자를 ${profile.outputExtensions.join(" 또는 ")}로 설정해 주세요.`, false));

  checks.push(pathIsSafe(String(snapshot.output.directoryPath ?? ""))
    ? check("output-path", "output", "pass", "출력 폴더 경로가 안전한 절대 경로입니다.")
    : check("output-path", "output", "error", "출력 폴더는 traversal이 없는 유효한 절대 경로여야 합니다."));
  if (snapshot.output.exists) {
    checks.push(check("output-overwrite", "output", "warning", "같은 이름의 출력 파일이 이미 존재합니다.", false));
  }
}

function waiverValid(waiver: QCWaiver): boolean {
  return Boolean(
    waiver &&
    typeof waiver.code === "string" && waiver.code.trim() &&
    typeof waiver.reason === "string" && waiver.reason.trim().length >= 5 &&
    finite(waiver.createdAt) && waiver.createdAt > 0,
  );
}

export function evaluateFinalQC(
  snapshot: FinalQCSnapshot,
  waivers: readonly QCWaiver[] = [],
  generatedAt = Date.now(),
): FinalQCReport {
  validateInput(snapshot, waivers);
  const safeSnapshot = redactQCSnapshot(snapshot);
  const profile = FINAL_QC_PROFILES[safeSnapshot.platform];
  const checks: MutableCheck[] = [];
  addSequenceChecks(safeSnapshot, profile, checks);
  addCaptionChecks(safeSnapshot, profile, checks);
  addSafeZoneChecks(safeSnapshot, checks);
  addAudioChecks(safeSnapshot, profile, checks);
  addMediaChecks(safeSnapshot, checks);
  addOutputChecks(safeSnapshot, profile, checks);

  const waiverMap = new Map<string, QCWaiver>();
  const rejectedWaivers: Array<QCWaiver & { reasonRejected: string }> = [];
  for (const rawWaiver of waivers) {
    const waiver = redactedClone(rawWaiver) as QCWaiver;
    if (!waiverValid(waiver)) {
      rejectedWaivers.push({ ...waiver, reasonRejected: "검사 코드, 5자 이상의 사유와 유효한 시간이 필요합니다." });
    } else {
      waiverMap.set(waiver.code, waiver);
    }
  }

  const acceptedByCode = new Map<string, QCWaiver>();
  for (const item of checks) {
    item.waived = false;
    if (item.level !== "error") continue;
    const waiver = waiverMap.get(item.code);
    if (!waiver) continue;
    if (item.hardBlock) {
      if (!rejectedWaivers.some((candidate) => candidate.code === waiver.code && candidate.reasonRejected.includes("hard-block"))) {
        rejectedWaivers.push({ ...waiver, reasonRejected: "hard-block 검사는 waiver로 통과시킬 수 없습니다." });
      }
      continue;
    }
    item.waived = true;
    item.waiver = waiver;
    acceptedByCode.set(waiver.code, waiver);
  }
  for (const waiver of waiverMap.values()) {
    const alreadyRejected = rejectedWaivers.some((candidate) => candidate.code === waiver.code);
    if (!acceptedByCode.has(waiver.code) && !alreadyRejected) {
      rejectedWaivers.push({ ...waiver, reasonRejected: "현재 보고서에 waiver 가능한 동일 코드 오류가 없습니다." });
    }
  }

  const finalChecks = checks as QCCheck[];
  const blockingChecks = finalChecks.filter((item) => item.level === "error" && !item.waived);
  const counts: Record<FinalQCLevel, number> = { pass: 0, warning: 0, error: 0 };
  for (const item of finalChecks) counts[item.level] += 1;
  const status: FinalQCLevel = blockingChecks.length > 0
    ? "error"
    : finalChecks.some((item) => item.level === "warning" || item.waived)
      ? "warning"
      : "pass";

  return {
    schemaVersion: FINAL_QC_SCHEMA_VERSION,
    generatedAt: finite(generatedAt) ? generatedAt : Date.now(),
    platform: safeSnapshot.platform,
    profile,
    snapshotSummary: {
      sequenceName: redactQCText(safeSnapshot.sequence.name),
      dimensions: `${safeSnapshot.sequence.width}×${safeSnapshot.sequence.height}`,
      duration: safeSnapshot.sequence.duration,
      frameRate: safeSnapshot.sequence.frameRate,
      captionCount: safeSnapshot.captions.length,
      outputFileName: redactQCText(safeSnapshot.output.fileName),
    },
    checks: finalChecks,
    counts,
    status,
    blocking: blockingChecks.length > 0,
    blockingCodes: [...new Set(blockingChecks.map((item) => item.code))],
    acceptedWaivers: [...acceptedByCode.values()],
    rejectedWaivers,
  };
}

export function finalQCReportToJSON(report: FinalQCReport): string {
  return JSON.stringify(redactedClone(report), null, 2);
}

function markdownCell(value: unknown): string {
  return redactQCText(value).replace(/\|/gu, "\\|").replace(/[\r\n]+/gu, " ");
}

export function finalQCReportToMarkdown(report: FinalQCReport): string {
  const safe = redactedClone(report) as FinalQCReport;
  const gate = safe.blocking ? "차단" : "통과";
  const lines = [
    `# ShortFlow 최종 QC — ${markdownCell(safe.profile.label)}`,
    "",
    `- 게이트: **${gate}**`,
    `- 상태: **${safe.status}**`,
    `- 생성 시각: ${safe.generatedAt}`,
    `- 시퀀스: ${markdownCell(safe.snapshotSummary.sequenceName)}`,
    `- 출력: ${markdownCell(safe.snapshotSummary.outputFileName)}`,
    "",
    "| 수준 | 코드 | 범주 | 판정 | 내용 |",
    "|---|---|---|---|---|",
  ];
  for (const item of safe.checks) {
    lines.push(`| ${item.level} | ${markdownCell(item.code)} | ${item.category} | ${item.waived ? "waived" : item.hardBlock ? "hard-block" : "-"} | ${markdownCell(item.message)} |`);
  }
  if (safe.acceptedWaivers.length > 0) {
    lines.push("", "## 승인된 Waiver", "");
    for (const waiver of safe.acceptedWaivers) {
      lines.push(`- ${markdownCell(waiver.code)} — ${markdownCell(waiver.reason)} (${waiver.createdAt})`);
    }
  }
  if (safe.rejectedWaivers.length > 0) {
    lines.push("", "## 거부된 Waiver", "");
    for (const waiver of safe.rejectedWaivers) {
      lines.push(`- ${markdownCell(waiver.code)} — ${markdownCell(waiver.reasonRejected)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
