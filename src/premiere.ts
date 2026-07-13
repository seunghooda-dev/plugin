import {
  calculateRelativeScale,
  markerToSegment,
  resolveTimeRange,
  sanitizeFileName,
  sanitizeSequenceName,
  validateShort,
  type MarkerSegment,
  type QCItem,
  type ReframeMode,
  type ResolvedTimeRange,
} from "./core";
import type {
  ExportMode,
  ExportRange,
  ReframeScope,
  SequenceRangeMode,
} from "./settings";
import {
  MAX_AUTOMATION_MARKERS,
  assertAutomationMarkerBudget,
  type PunchCue,
  type SilenceCutPlan,
  type TimeRange,
} from "./automation";
import {
  assertSafeZoneAlignment,
  type SafeZoneAlignment,
  type SafeZoneMargins,
  type SocialPlatform,
} from "./safe-zone";
import type {
  Action,
  AudioClipTrackItem,
  Component,
  ComponentParam,
  FolderItem,
  Keyframe,
  PointF,
  Project,
  ProjectItem,
  Sequence,
  VideoClipTrackItem,
  premierepro,
} from "@adobe/premierepro";
import {
  computeMotionSamples,
  motionOpacity,
  slidePosition,
  type MotionDirection,
  type MotionEasing,
  type MotionKind,
} from "./motion";

// UXP host modules are injected by Premiere at runtime and intentionally stay external in Vite.
function unavailableHostModule<T extends object>(moduleName: string, cause: unknown): T {
  return new Proxy({}, {
    get() {
      const detail = cause instanceof Error ? ` (${cause.message})` : "";
      throw new Error(`${moduleName} 호스트 모듈은 Premiere Pro UXP에서만 사용할 수 있습니다.${detail}`);
    },
  }) as T;
}

let ppro: premierepro;
try {
  ppro = require("premierepro") as premierepro;
} catch (error) {
  ppro = unavailableHostModule<premierepro>("premierepro", error);
}

let uxp: any;
try {
  uxp = require("uxp") as any;
} catch (error) {
  uxp = unavailableHostModule<Record<string, unknown>>("uxp", error);
}

export class ShortFlowError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ShortFlowError";
    this.code = code;
  }
}

export interface PremiereContext {
  project: Project;
  sequence: Sequence;
}

export interface SequenceStatus {
  hostVersion: string;
  projectName: string;
  projectPath: string;
  sequenceName: string;
  sequenceGuid: string;
  width: number;
  height: number;
  frameRate: number;
  sequenceEnd: number;
  inPoint: number;
  outPoint: number;
  playerPosition: number;
  effectiveStart: number;
  effectiveEnd: number;
  effectiveDuration: number;
  videoTrackCount: number;
  audioTrackCount: number;
  captionTrackCount: number;
  selectedItemCount: number;
  selectedVideoCount: number;
  selectedStart: number | null;
  selectedEnd: number | null;
}

export interface CreateShortOptions {
  width: number;
  height: number;
  name: string;
  rangeMode: SequenceRangeMode;
  maxDuration: number;
  reframeMode: ReframeMode;
  scope: ReframeScope;
  centerClips: boolean;
  explicitRange?: { start: number; end: number };
}

export interface ReframeResult {
  discovered: number;
  changed: number;
  skipped: number;
  warningMessages: string[];
}

export interface CreateShortResult {
  sequence: Sequence;
  sequenceName: string;
  width: number;
  height: number;
  range: ResolvedTimeRange;
  reframe: ReframeResult;
  warnings: string[];
}

export interface PersistentEntryResult {
  entry: any;
  token: string;
  name: string;
  nativePath: string;
}

export interface ExportVideoOptions {
  presetFile: any;
  outputFolder: any;
  mode: ExportMode;
  range: ExportRange;
}

export interface InsertAssetOptions {
  videoTrackIndex: number;
  audioTrackIndex: number;
  displayName?: string;
  /** Opaque project+sequence key captured before asynchronous generation began. */
  expectedContextKey?: string;
  /** Optional still-image duration in seconds, used for removable guide overlays. */
  durationSeconds?: number;
}

export interface InsertAssetPreflight {
  assetPath: string;
  videoTrackIndex: number;
  audioTrackIndex: number;
  displayName: string;
  durationSeconds?: number;
  expectedContextKey?: string;
}

export interface AudioInsertSequenceProbe {
  getAudioTrackCount(): Promise<number>;
  getAudioTrack(trackIndex: number): Promise<unknown>;
}

export interface AudioInsertRange {
  readonly start: number;
  readonly end: number;
  readonly duration: number;
}

export interface AutomationMarkerResult {
  cutMarkers: number;
  punchMarkers: number;
}

export interface AutomationApplyResult extends AutomationMarkerResult {
  sequenceName: string;
  punchedClips: number;
  skippedClips: number;
  warnings: string[];
}

export interface AutomationApplyHooks {
  expectedContextKey?: string;
  onClonePrepared?: (details: {
    sourceGuid: string;
    cloneGuid: string;
    sequenceName: string;
  }) => void | Promise<void>;
}

export interface AutomationMutationGuard {
  sourceContextKey?: string;
}

export interface SafeZoneAlignResult {
  selected: number;
  changed: number;
  skipped: number;
  warnings: string[];
}

export interface SafeZoneTranslatedPoint {
  x: number;
  y: number;
  space: "normalized" | "pixels";
}

export function tickTimeSeconds(value: unknown, fallback = 0): number {
  const seconds = Number(
    typeof value === "object" && value !== null && "seconds" in value
      ? (value as { seconds: unknown }).seconds
      : Number.NaN,
  );
  return Number.isFinite(seconds) ? seconds : fallback;
}

/** Adobe Keyframe.value is wrapped as { value: actualValue }. */
export function keyframeValue(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("value" in value)) {
    return undefined;
  }
  const outer = (value as { value: unknown }).value;
  if (typeof outer === "object" && outer !== null && "value" in outer) {
    return (outer as { value: unknown }).value;
  }
  return outer;
}

export function centeredPosition(
  value: unknown,
  targetWidth: number,
  targetHeight: number,
): { x: number; y: number } | null {
  if (
    typeof value !== "object"
    || value === null
    || !("x" in value)
    || !("y" in value)
  ) {
    return null;
  }
  const x = Number((value as { x: unknown }).x);
  const y = Number((value as { y: unknown }).y);
  if (
    !Number.isFinite(x)
    || !Number.isFinite(y)
    || !Number.isFinite(targetWidth)
    || !Number.isFinite(targetHeight)
    || targetWidth <= 0
    || targetHeight <= 0
  ) {
    return null;
  }
  const normalized = Math.abs(x) <= 2 && Math.abs(y) <= 2;
  return normalized
    ? { x: 0.5, y: 0.5 }
    : { x: targetWidth / 2, y: targetHeight / 2 };
}

export function zeroBasedTrackIndex(value: number, oneBased = false): number {
  if (!Number.isInteger(value)) {
    throw new ShortFlowError("INVALID_TRACK", "트랙 번호는 정수여야 합니다.");
  }
  const index = value - (oneBased ? 1 : 0);
  if (index < 0 || index > 98) {
    throw new ShortFlowError(
      "INVALID_TRACK",
      oneBased ? "트랙 번호는 1~99 범위여야 합니다." : "트랙 인덱스는 0~98 범위여야 합니다.",
    );
  }
  return index;
}

export function normalizeExportExtension(value: unknown, fallback = "mp4"): string {
  const normalizedFallback = fallback
    .trim()
    .replace(/^\.+/u, "")
    .toLocaleLowerCase("en-US");
  const safeFallback = /^[a-z0-9]{1,10}$/u.test(normalizedFallback)
    ? normalizedFallback
    : "mp4";
  const normalized = String(value ?? "")
    .trim()
    .replace(/^\.+/u, "")
    .toLocaleLowerCase("en-US");
  return /^[a-z0-9]{1,10}$/u.test(normalized) ? normalized : safeFallback;
}

export function normalizePremierePath(value: string): string {
  const normalized = value.trim().normalize("NFC").replace(/\\/gu, "/");
  const isUnc = normalized.startsWith("//");
  const isWindows = /^[a-z]:\//iu.test(normalized) || isUnc;
  let collapsed = normalized.replace(/\/+/gu, "/");
  if (isUnc) {
    collapsed = "//" + collapsed.replace(/^\/+/u, "");
  }
  if (
    collapsed.length > 1
    && collapsed.endsWith("/")
    && !/^[a-z]:\/$/iu.test(collapsed)
  ) {
    collapsed = collapsed.slice(0, -1);
  }
  return isWindows ? collapsed.toLocaleLowerCase("en-US") : collapsed;
}

export function sameMediaPath(left: string, right: string): boolean {
  const normalizedLeft = normalizePremierePath(left);
  return normalizedLeft !== "" && normalizedLeft === normalizePremierePath(right);
}

const AUDIO_INSERT_EXTENSIONS = new Set([
  "aac", "aif", "aiff", "flac", "m4a", "mp3", "ogg", "wav", "wma",
]);

function isAudioInsertAssetPath(nativePath: string): boolean {
  const filename = nativePath.replace(/\\/gu, "/").split("/").at(-1) ?? "";
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return false;
  return AUDIO_INSERT_EXTENSIONS.has(filename.slice(dot + 1).toLocaleLowerCase("en-US"));
}

export function validatePremiereImportPath(value: unknown): string {
  if (typeof value !== "string") {
    throw new ShortFlowError("INVALID_IMPORT_PATH", "가져올 파일 경로는 문자열이어야 합니다.");
  }
  const path = value.trim();
  if (!path || path.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(path)) {
    throw new ShortFlowError("INVALID_IMPORT_PATH", "가져올 파일 경로가 비어 있거나 안전 제한을 벗어났습니다.");
  }
  const slashed = path.replace(/\\/gu, "/");
  const windowsDrive = /^[a-z]:\//iu.test(slashed);
  const unc = slashed.startsWith("//") && slashed.split("/").filter(Boolean).length >= 3;
  const posix = slashed.startsWith("/") && !slashed.startsWith("//");
  if (!windowsDrive && !unc && !posix) {
    throw new ShortFlowError("INVALID_IMPORT_PATH", "가져올 파일은 절대 nativePath여야 합니다.");
  }
  const parts = slashed.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..") || path.endsWith("/") || path.endsWith("\\")) {
    throw new ShortFlowError("INVALID_IMPORT_PATH", "가져올 파일 경로에 상대 경로 또는 폴더 경로를 사용할 수 없습니다.");
  }
  const filename = parts.at(-1) ?? "";
  if (!filename || filename.endsWith(".") || !/\.[^./\\]+$/u.test(filename)) {
    throw new ShortFlowError("INVALID_IMPORT_PATH", "가져올 파일 경로에 유효한 파일명과 확장자가 필요합니다.");
  }
  return path;
}

export function prepareInsertAssetPreflight(
  nativePath: unknown,
  options: InsertAssetOptions,
): InsertAssetPreflight {
  const assetPath = validatePremiereImportPath(nativePath);
  if (!options || typeof options !== "object") {
    throw new ShortFlowError("INVALID_INSERT_OPTIONS", "자산 삽입 트랙 설정이 필요합니다.");
  }
  const videoTrackIndex = zeroBasedTrackIndex(options.videoTrackIndex);
  const audioTrackIndex = zeroBasedTrackIndex(options.audioTrackIndex);
  let duration: number | undefined;
  if (options.durationSeconds !== undefined) {
    duration = Number(options.durationSeconds);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 86_400) {
      throw new ShortFlowError("INVALID_ASSET_DURATION", "가이드 오버레이 길이는 0초 초과 24시간 이하여야 합니다.");
    }
  }
  const displayName = String(options.displayName ?? "자산")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 120) || "자산";
  const preflight: InsertAssetPreflight = {
    assetPath,
    videoTrackIndex,
    audioTrackIndex,
    displayName,
  };
  if (duration !== undefined) preflight.durationSeconds = duration;
  if (typeof options.expectedContextKey === "string" && options.expectedContextKey.trim()) {
    preflight.expectedContextKey = options.expectedContextKey.trim();
  }
  return preflight;
}

function guidKey(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof (value as { toString?: () => string }).toString === "function") {
    return (value as { toString: () => string }).toString();
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

function contextHash(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

/** Opaque context identity; it contains no project name, path, or raw host GUID. */
export function premiereContextKey(projectGuid: unknown, sequenceGuid: unknown): string {
  const project = guidKey(projectGuid).trim();
  const sequence = guidKey(sequenceGuid).trim();
  if (!project || !sequence) {
    throw new ShortFlowError("INVALID_HOST_CONTEXT", "프로젝트·시퀀스 식별자를 확인하지 못했습니다.");
  }
  const source = `${project}\u0000${sequence}`;
  return `ctx_${contextHash(source, 0x811c9dc5)}_${contextHash(source, 0x9e3779b9)}`;
}

function expectedContextKey(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || !/^ctx_[a-z0-9]{7}_[a-z0-9]{7}$/u.test(value)) {
    throw new ShortFlowError("INVALID_HOST_CONTEXT", "Host context key 형식이 올바르지 않습니다.");
  }
  return value;
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

type ActionFactory = () => Action | readonly Action[];

function actionArray(value: Action | readonly Action[]): readonly Action[] {
  return Array.isArray(value) ? value : [value];
}

function commitActionFactories(project: Project, factories: readonly ActionFactory[], undoLabel: string): boolean {
  if (factories.length === 0) {
    return true;
  }
  let committed = false;
  let allAdded = true;
  try {
    project.lockedAccess(() => {
      committed = project.executeTransaction((compoundAction) => {
        for (const factory of factories) {
          const actions = actionArray(factory());
          if (actions.length === 0 || actions.some((action) => !action)) {
            allAdded = false;
            throw new Error("Premiere returned an empty or invalid action.");
          }
          for (const action of actions) {
            if (compoundAction.addAction(action) === false) {
              allAdded = false;
              throw new Error("Premiere rejected an action in the compound transaction.");
            }
          }
        }
      }, undoLabel);
    });
  } catch {
    return false;
  }
  return Boolean(committed && allAdded);
}

/** Keeps every timeline transaction behind its asynchronous safety checks. */
export async function commitTimelineInsertAfterPreflight(
  preflight: () => unknown | Promise<unknown>,
  commit: () => boolean,
): Promise<void> {
  await preflight();
  let committed = false;
  try {
    committed = commit();
  } catch {
    committed = false;
  }
  if (!committed) {
    throw new ShortFlowError(
      "ASSET_INSERT_TRANSACTION_REJECTED",
      "Premiere가 자산 삽입 transaction을 거부했습니다. 공개 API로 오디오 트랙 잠금 상태를 미리 확인할 수 없으므로 대상 트랙이 현재 편집 가능한지 확인해 주세요.",
    );
  }
}

function assertPositiveDimensions(width: number, height: number): void {
  if (
    !Number.isFinite(width)
    || !Number.isFinite(height)
    || !Number.isInteger(width)
    || !Number.isInteger(height)
    || width < 16
    || height < 16
    || width > 16384
    || height > 16384
  ) {
    throw new ShortFlowError("INVALID_FRAME_SIZE", "출력 해상도는 16~16384px 범위의 정수여야 합니다.");
  }
}

function assertShortDuration(value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value > 600) {
    throw new ShortFlowError("INVALID_DURATION", "숏폼 최대 길이는 0초 초과 600초 이하의 숫자여야 합니다.");
  }
}

export function getRuntimeInfo(): { hostVersion: string; uxpVersion: string } {
  try {
    return {
      hostVersion: String(uxp.host?.version ?? "unknown"),
      uxpVersion: String(uxp.versions?.uxp ?? uxp.version ?? "unknown"),
    };
  } catch {
    // Mock Host and static verification run outside Premiere UXP.
    return { hostVersion: "unknown", uxpVersion: "unknown" };
  }
}

export async function getActiveContext(): Promise<PremiereContext> {
  const project = await ppro.Project.getActiveProject();
  if (!project) {
    throw new ShortFlowError("NO_ACTIVE_PROJECT", "활성 Premiere Pro 프로젝트가 없습니다.");
  }
  const sequence = await project.getActiveSequence();
  if (!sequence) {
    throw new ShortFlowError("NO_ACTIVE_SEQUENCE", "활성 시퀀스가 없습니다. 타임라인을 먼저 열어 주세요.");
  }
  return { project, sequence };
}

function contextKeyOf(context: PremiereContext): string {
  return premiereContextKey(context.project.guid, context.sequence.guid);
}

async function getExpectedActiveContext(expectedValue?: string): Promise<PremiereContext & { contextKey: string }> {
  const expected = expectedContextKey(expectedValue);
  const context = await getActiveContext();
  const contextKey = contextKeyOf(context);
  if (expected && contextKey !== expected) {
    throw new ShortFlowError("HOST_CONTEXT_CHANGED", "작업 중 활성 프로젝트 또는 시퀀스가 변경되었습니다.");
  }
  return { ...context, contextKey };
}

async function assertActiveContextKey(expected: string): Promise<void> {
  const context = await getActiveContext();
  if (contextKeyOf(context) !== expected) {
    throw new ShortFlowError("HOST_CONTEXT_CHANGED", "작업 중 활성 프로젝트 또는 시퀀스가 변경되었습니다.");
  }
}

/** Reads an opaque project+sequence identity without mutating Premiere state. */
export async function readActiveContextKey(): Promise<string> {
  return contextKeyOf(await getActiveContext());
}

export async function setSequencePlayerPosition(seconds: number): Promise<void> {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86_400) {
    throw new ShortFlowError("INVALID_PLAYHEAD", "이동할 재생 위치가 올바르지 않습니다.");
  }
  const { sequence } = await getActiveContext();
  const moved = await sequence.setPlayerPosition(ppro.TickTime.createWithSeconds(seconds));
  if (!moved) throw new ShortFlowError("PLAYHEAD_MOVE_FAILED", "Premiere 재생 헤드를 이동하지 못했습니다.");
}

export async function removeVerifiedClonedSequenceFromProject(
  project: Project,
  sourceGuid: string,
  cloneGuid: string,
): Promise<void> {
  const sourceKey = sourceGuid.trim();
  const cloneKey = cloneGuid.trim();
  if (!sourceKey || !cloneKey || sourceKey === cloneKey) {
    throw new ShortFlowError("INVALID_CLONE_ID", "원본과 복제 시퀀스 식별자가 올바르지 않습니다.");
  }
  const sequences = await project.getSequences();
  const source = sequences.find((sequence) => guidKey(sequence.guid) === sourceKey);
  const clone = sequences.find((sequence) => guidKey(sequence.guid) === cloneKey);
  if (!source) throw new ShortFlowError("SOURCE_SEQUENCE_NOT_FOUND", "보존된 원본 시퀀스를 찾지 못했습니다.");
  if (!clone) return;
  await removeKnownClonedSequenceFromProject(project, source, clone);
}

async function removeKnownClonedSequenceFromProject(
  project: Project,
  source: Sequence,
  clone: Sequence,
): Promise<void> {
  const sourceKey = guidKey(source.guid).trim();
  const cloneKey = guidKey(clone.guid).trim();
  if (source === clone || (sourceKey && cloneKey && sourceKey === cloneKey)) {
    throw new ShortFlowError("INVALID_CLONE_ID", "원본과 복제 시퀀스를 안전하게 구분하지 못했습니다.");
  }
  if (await project.setActiveSequence(source) === false) {
    const active = await project.getActiveSequence();
    const activeKey = active ? guidKey(active.guid).trim() : "";
    if (active !== source && (!sourceKey || activeKey !== sourceKey)) {
      throw new ShortFlowError("SOURCE_REACTIVATE_FAILED", "복제 시퀀스 정리 전에 원본 시퀀스를 다시 활성화하지 못했습니다.");
    }
  }
  const item = await clone.getProjectItem();
  const parent = item.getParentBin();
  if (!commitActionFactories(project, [() => parent.createRemoveItemAction(item)], "ShortFlow: 실패한 복제 시퀀스 제거")) {
    throw new ShortFlowError("CLONE_REMOVE_FAILED", "실패한 복제 시퀀스를 제거하지 못했습니다.");
  }
}

export async function removeVerifiedClonedSequence(sourceGuid: string, cloneGuid: string): Promise<void> {
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new ShortFlowError("NO_ACTIVE_PROJECT", "활성 Premiere Pro 프로젝트가 없습니다.");
  await removeVerifiedClonedSequenceFromProject(project, sourceGuid, cloneGuid);
}

export async function readPlayerPositionSeconds(): Promise<number> {
  const { sequence } = await getActiveContext();
  return tickTimeSeconds(await sequence.getPlayerPosition(), 0);
}

function isVideoTrackItem(item: unknown): item is VideoClipTrackItem {
  return Boolean(
    item
    && typeof item === "object"
    && "isAdjustmentLayer" in item
    && typeof (item as { isAdjustmentLayer?: unknown }).isAdjustmentLayer === "function",
  );
}

async function trackItemIsSelected(item: unknown): Promise<boolean> {
  if (!item || typeof item !== "object" || !("getIsSelected" in item)) {
    return false;
  }
  const getIsSelected = (item as { getIsSelected?: unknown }).getIsSelected;
  if (typeof getIsSelected !== "function") {
    return false;
  }
  try {
    return Boolean(await getIsSelected.call(item));
  } catch {
    return false;
  }
}

function premiereClipTrackItemType(): unknown {
  try {
    return ppro.Constants?.TrackItemType?.CLIP;
  } catch {
    return undefined;
  }
}

function normalizeTrackItems(items: unknown): Array<VideoClipTrackItem | AudioClipTrackItem> {
  return Array.isArray(items) ? items as Array<VideoClipTrackItem | AudioClipTrackItem> : [];
}

async function getClipTrackItems(track: unknown): Promise<Array<VideoClipTrackItem | AudioClipTrackItem>> {
  if (!track || typeof track !== "object" || !("getTrackItems" in track)) {
    return [];
  }
  const getTrackItems = (track as { getTrackItems?: unknown }).getTrackItems;
  if (typeof getTrackItems !== "function") {
    return [];
  }
  const clipType = premiereClipTrackItemType();
  if (clipType !== undefined) {
    try {
      return normalizeTrackItems(await getTrackItems.call(track, clipType, false));
    } catch {
      // Some test doubles and Host shims expose a no-argument getTrackItems.
    }
  }
  try {
    return normalizeTrackItems(await getTrackItems.call(track));
  } catch {
    return [];
  }
}

const MAX_AUDIO_INSERT_TRACK_ITEMS = 5_000;
const AUDIO_INSERT_TIME_EPSILON = 1e-6;

export async function audioProjectItemDurationSeconds<TMediaType>(
  clipProjectItem: {
    getInPoint(mediaType: TMediaType): Promise<unknown>;
    getOutPoint(mediaType: TMediaType): Promise<unknown>;
  },
  audioMediaType: TMediaType,
): Promise<number> {
  let inPoint: unknown;
  let outPoint: unknown;
  try {
    [inPoint, outPoint] = await Promise.all([
      clipProjectItem.getInPoint(audioMediaType),
      clipProjectItem.getOutPoint(audioMediaType),
    ]);
  } catch {
    throw new ShortFlowError(
      "ASSET_AUDIO_DURATION_UNAVAILABLE",
      "오디오 길이를 Premiere 공개 API로 확인하지 못해 타임라인 삽입을 중단했습니다.",
    );
  }
  const start = tickTimeSeconds(inPoint, Number.NaN);
  const end = tickTimeSeconds(outPoint, Number.NaN);
  const duration = end - start;
  if (
    !Number.isFinite(start)
    || !Number.isFinite(end)
    || start < 0
    || end <= start
    || !Number.isFinite(duration)
    || duration > 86_400
  ) {
    throw new ShortFlowError(
      "ASSET_AUDIO_DURATION_UNAVAILABLE",
      "오디오의 유효한 In/Out 길이를 확인하지 못해 타임라인 삽입을 중단했습니다.",
    );
  }
  return duration;
}

export async function assertAudioInsertRangeAvailable(
  sequence: AudioInsertSequenceProbe,
  audioTrackIndex: number,
  insertionTime: unknown,
  durationSeconds: number,
  clipTrackItemType: unknown,
): Promise<AudioInsertRange> {
  if (!Number.isInteger(audioTrackIndex) || audioTrackIndex < 0 || audioTrackIndex > 98) {
    throw new ShortFlowError("INVALID_AUDIO_TRACK", "오디오 트랙 인덱스가 0~98 범위를 벗어났습니다.");
  }
  const start = tickTimeSeconds(insertionTime, Number.NaN);
  const end = start + durationSeconds;
  if (
    !Number.isFinite(start)
    || start < 0
    || !Number.isFinite(durationSeconds)
    || durationSeconds <= 0
    || durationSeconds > 86_400
    || !Number.isFinite(end)
    || end <= start
  ) {
    throw new ShortFlowError(
      "AUDIO_INSERT_RANGE_UNAVAILABLE",
      "재생헤드와 오디오 삽입 구간을 확실히 계산하지 못해 삽입을 중단했습니다.",
    );
  }

  let trackCountValue: unknown;
  try {
    trackCountValue = await sequence.getAudioTrackCount();
  } catch {
    throw new ShortFlowError(
      "AUDIO_TRACK_UNAVAILABLE",
      "현재 시퀀스의 오디오 트랙 수를 확인하지 못해 삽입을 중단했습니다.",
    );
  }
  if (
    typeof trackCountValue !== "number"
    || !Number.isSafeInteger(trackCountValue)
    || trackCountValue < 0
  ) {
    throw new ShortFlowError(
      "AUDIO_TRACK_UNAVAILABLE",
      "현재 시퀀스의 오디오 트랙 정보가 올바르지 않아 삽입을 중단했습니다.",
    );
  }
  const trackCount = trackCountValue;
  if (audioTrackIndex >= trackCount) {
    throw new ShortFlowError(
      "INVALID_AUDIO_TRACK",
      `요청한 오디오 트랙 A${audioTrackIndex + 1}이 현재 시퀀스에 없습니다.`,
    );
  }

  let track: unknown;
  try {
    track = await sequence.getAudioTrack(audioTrackIndex);
  } catch {
    throw new ShortFlowError(
      "AUDIO_TRACK_UNAVAILABLE",
      `오디오 트랙 A${audioTrackIndex + 1}에 접근하지 못해 삽입을 중단했습니다.`,
    );
  }
  if (!track || typeof track !== "object") {
    throw new ShortFlowError(
      "AUDIO_TRACK_UNAVAILABLE",
      `오디오 트랙 A${audioTrackIndex + 1}을 사용할 수 없어 삽입을 중단했습니다.`,
    );
  }
  const getIndex = (track as { getIndex?: unknown }).getIndex;
  const getTrackItems = (track as { getTrackItems?: unknown }).getTrackItems;
  if (
    typeof getIndex !== "function"
    || typeof getTrackItems !== "function"
    || clipTrackItemType === undefined
    || clipTrackItemType === null
  ) {
    throw new ShortFlowError(
      "AUDIO_TRACK_UNAVAILABLE",
      `오디오 트랙 A${audioTrackIndex + 1}의 공개 API를 사용할 수 없어 삽입을 중단했습니다.`,
    );
  }

  let actualTrackIndexValue: unknown;
  let items: unknown;
  try {
    actualTrackIndexValue = await getIndex.call(track);
    items = await getTrackItems.call(track, clipTrackItemType, false);
  } catch {
    throw new ShortFlowError(
      "AUDIO_TRACK_UNAVAILABLE",
      `오디오 트랙 A${audioTrackIndex + 1}의 클립 구간을 확인하지 못해 삽입을 중단했습니다.`,
    );
  }
  if (
    typeof actualTrackIndexValue !== "number"
    || !Number.isSafeInteger(actualTrackIndexValue)
    || actualTrackIndexValue !== audioTrackIndex
    || !Array.isArray(items)
  ) {
    throw new ShortFlowError(
      "AUDIO_TRACK_UNAVAILABLE",
      `오디오 트랙 A${audioTrackIndex + 1}의 식별 정보가 일치하지 않아 삽입을 중단했습니다.`,
    );
  }
  if (items.length > MAX_AUDIO_INSERT_TRACK_ITEMS) {
    throw new ShortFlowError(
      "AUDIO_TRACK_UNAVAILABLE",
      `오디오 트랙 A${audioTrackIndex + 1}의 클립 수가 안전 검사 한도를 초과했습니다.`,
    );
  }

  let collision = false;
  try {
    await forEachLimited(items, 16, async (item) => {
      if (collision || !item || typeof item !== "object") {
        if (!collision) throw new Error("Invalid audio track item.");
        return;
      }
      const getStartTime = (item as { getStartTime?: unknown }).getStartTime;
      const getEndTime = (item as { getEndTime?: unknown }).getEndTime;
      if (typeof getStartTime !== "function" || typeof getEndTime !== "function") {
        throw new Error("Audio track item range API is unavailable.");
      }
      const [itemStartValue, itemEndValue] = await Promise.all([
        getStartTime.call(item),
        getEndTime.call(item),
      ]);
      const itemStart = tickTimeSeconds(itemStartValue, Number.NaN);
      const itemEnd = tickTimeSeconds(itemEndValue, Number.NaN);
      if (!Number.isFinite(itemStart) || !Number.isFinite(itemEnd) || itemStart < 0 || itemEnd <= itemStart) {
        throw new Error("Audio track item has an invalid range.");
      }
      if (
        itemStart < end - AUDIO_INSERT_TIME_EPSILON
        && itemEnd > start + AUDIO_INSERT_TIME_EPSILON
      ) {
        collision = true;
      }
    });
  } catch {
    throw new ShortFlowError(
      "AUDIO_TRACK_UNAVAILABLE",
      `오디오 트랙 A${audioTrackIndex + 1}의 모든 클립 구간을 확인하지 못해 삽입을 중단했습니다.`,
    );
  }
  if (collision) {
    throw new ShortFlowError(
      "AUDIO_TRACK_COLLISION",
      `오디오 트랙 A${audioTrackIndex + 1}의 현재 재생헤드 구간에 기존 클립이 있습니다. 빈 구간으로 이동한 뒤 다시 시도해 주세요.`,
    );
  }

  return Object.freeze({ start, end, duration: durationSeconds });
}

async function scanSelectedTrackItems(sequence: Sequence): Promise<Array<VideoClipTrackItem | AudioClipTrackItem>> {
  const selected: Array<VideoClipTrackItem | AudioClipTrackItem> = [];
  const scanTracks = async (
    countMethod: "getVideoTrackCount" | "getAudioTrackCount",
    trackMethod: "getVideoTrack" | "getAudioTrack",
  ): Promise<void> => {
    const countFn = (sequence as unknown as Record<string, unknown>)[countMethod];
    const trackFn = (sequence as unknown as Record<string, unknown>)[trackMethod];
    if (typeof countFn !== "function" || typeof trackFn !== "function") {
      return;
    }
    let count = 0;
    try {
      count = Math.max(0, Math.min(200, Math.floor(Number(await countFn.call(sequence)) || 0)));
    } catch {
      return;
    }
    for (let index = 0; index < count; index += 1) {
      let track: unknown;
      try {
        track = await trackFn.call(sequence, index);
      } catch {
        continue;
      }
      for (const item of await getClipTrackItems(track)) {
        if (await trackItemIsSelected(item)) {
          selected.push(item);
        }
      }
    }
  };
  await Promise.all([
    scanTracks("getVideoTrackCount", "getVideoTrack"),
    scanTracks("getAudioTrackCount", "getAudioTrack"),
  ]);
  return selected;
}

async function readSelectionRange(sequence: Sequence): Promise<{
  count: number;
  videoCount: number;
  start: number | null;
  end: number | null;
  items: Array<VideoClipTrackItem | AudioClipTrackItem>;
}> {
  try {
    let items: Array<VideoClipTrackItem | AudioClipTrackItem> = [];
    try {
      const selection = await sequence.getSelection();
      items = selection ? normalizeTrackItems(await selection.getTrackItems()) : [];
    } catch {
      items = [];
    }
    if (items.length === 0) {
      items = await scanSelectedTrackItems(sequence);
    }
    const itemRanges = await Promise.all(items.map(async (item) => {
      const video = isVideoTrackItem(item);
      if (typeof item?.getStartTime !== "function" || typeof item?.getEndTime !== "function") {
        return { video, start: Number.NaN, end: Number.NaN };
      }
      try {
        const [startTime, endTime] = await Promise.all([
          item.getStartTime(),
          item.getEndTime(),
        ]);
        return {
          video,
          start: tickTimeSeconds(startTime, Number.NaN),
          end: tickTimeSeconds(endTime, Number.NaN),
        };
      } catch {
        return { video, start: Number.NaN, end: Number.NaN };
      }
    }));
    let start = Number.POSITIVE_INFINITY;
    let end = Number.NEGATIVE_INFINITY;
    let videoCount = 0;
    for (const range of itemRanges) {
      if (range.video) {
        videoCount += 1;
      }
      if (Number.isFinite(range.start)) start = Math.min(start, range.start);
      if (Number.isFinite(range.end)) end = Math.max(end, range.end);
    }
    return {
      count: items.length,
      videoCount,
      start: Number.isFinite(start) ? start : null,
      end: Number.isFinite(end) ? end : null,
      items,
    };
  } catch {
    return { count: 0, videoCount: 0, start: null, end: null, items: [] };
  }
}

type SequenceTimeMethod = "getEndTime" | "getInPoint" | "getOutPoint" | "getPlayerPosition";

async function safeTime(
  sequence: Sequence,
  methodName: SequenceTimeMethod,
  fallback: number,
): Promise<number> {
  try {
    const value = await sequence[methodName]();
    return tickTimeSeconds(value, fallback);
  } catch {
    return fallback;
  }
}

async function safeFrameRate(sequence: Sequence): Promise<number> {
  try {
    return Number((await sequence.getSettings()).getVideoFrameRate().value) || 0;
  } catch {
    return 0;
  }
}

export interface ReadSequenceStatusOptions {
  /** Selection details are unnecessary for basic QC and can be expensive on large selections. */
  includeSelection?: boolean;
  /** The basic QC panel does not use the playhead position. */
  includePlayerPosition?: boolean;
  /** Reject the read if the active project/sequence changed after the caller captured its context. */
  expectedContextKey?: string;
}

export async function readSequenceStatus(
  context?: PremiereContext,
  options: ReadSequenceStatusOptions = {},
): Promise<SequenceStatus> {
  const { project, sequence } = context ?? await getExpectedActiveContext(options.expectedContextKey);
  const includeSelection = options.includeSelection !== false;
  const includePlayerPosition = options.includePlayerPosition !== false;
  // Premiere UXP calls cross the Host boundary. These values are independent,
  // read-only snapshots, so start them together instead of accumulating one
  // bridge round-trip per field.
  const [
    frame,
    sequenceEnd,
    inPoint,
    rawOutPoint,
    playerPosition,
    selection,
    rawVideoTrackCount,
    rawAudioTrackCount,
    rawCaptionTrackCount,
    frameRate,
  ] = await Promise.all([
    sequence.getFrameSize(),
    safeTime(sequence, "getEndTime", 0),
    safeTime(sequence, "getInPoint", 0),
    safeTime(sequence, "getOutPoint", Number.NaN),
    includePlayerPosition ? safeTime(sequence, "getPlayerPosition", 0) : Promise.resolve(0),
    includeSelection
      ? readSelectionRange(sequence)
      : Promise.resolve({ count: 0, videoCount: 0, start: null, end: null, items: [] }),
    sequence.getVideoTrackCount(),
    sequence.getAudioTrackCount(),
    sequence.getCaptionTrackCount(),
    safeFrameRate(sequence),
  ]);
  const outPoint = Number.isFinite(rawOutPoint) ? rawOutPoint : sequenceEnd;
  const effective = resolveTimeRange({
    mode: "inout",
    sequenceEnd,
    inPoint,
    outPoint,
  });
  const videoTrackCount = Number(rawVideoTrackCount) || 0;
  const audioTrackCount = Number(rawAudioTrackCount) || 0;
  const captionTrackCount = Number(rawCaptionTrackCount) || 0;

  return {
    hostVersion: getRuntimeInfo().hostVersion,
    projectName: String(project.name ?? "이름 없는 프로젝트"),
    projectPath: String(project.path ?? ""),
    sequenceName: String(sequence.name ?? "이름 없는 시퀀스"),
    sequenceGuid: guidKey(sequence.guid),
    width: Number(frame?.width) || 0,
    height: Number(frame?.height) || 0,
    frameRate,
    sequenceEnd,
    inPoint,
    outPoint,
    playerPosition,
    effectiveStart: effective.start,
    effectiveEnd: effective.end,
    effectiveDuration: effective.duration,
    videoTrackCount,
    audioTrackCount,
    captionTrackCount,
    selectedItemCount: selection.count,
    selectedVideoCount: selection.videoCount,
    selectedStart: selection.start,
    selectedEnd: selection.end,
  };
}

export interface SequenceMediaQCStatus {
  offlineMedia: string[];
  guideOverlays: string[];
  scannedItems: number;
  truncated: boolean;
}

export interface SequenceMediaQCScanOptions {
  context?: PremiereContext;
  concurrency?: number;
}

const MEDIA_QC_SCAN_CONCURRENCY = 16;

function mediaQCConcurrency(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return MEDIA_QC_SCAN_CONCURRENCY;
  return Math.min(32, Math.max(1, Math.round(value)));
}

async function forEachLimited<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runner = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runner()));
}

/** Scans timeline-backed project items without exposing native media paths. */
export async function scanSequenceMediaQC(
  maximumItems = 10_000,
  options: SequenceMediaQCScanOptions = {},
): Promise<SequenceMediaQCStatus> {
  const { sequence } = options.context ?? await getActiveContext();
  const limit = Math.min(10_000, Math.max(1, Math.round(maximumItems)));
  const concurrency = mediaQCConcurrency(options.concurrency);
  const offlineMedia = new Set<string>();
  const guideOverlays = new Set<string>();
  const seenProjectItems = new Set<string>();
  const itemsToInspect: Array<VideoClipTrackItem | AudioClipTrackItem> = [];
  let truncated = false;

  const inspect = async (item: VideoClipTrackItem | AudioClipTrackItem): Promise<void> => {
    const name = String(await item.getName()).slice(0, 260);
    if (name.includes("__SHORTFLOW_SAFE_GUIDE_DO_NOT_EXPORT__")) guideOverlays.add(name);
    const projectItem = await item.getProjectItem();
    if (!projectItem) return;
    const id = String(projectItem.getId());
    if (seenProjectItems.has(id)) return;
    seenProjectItems.add(id);
    const mediaProjectItem = projectItem as ProjectItem & { isOffline?: () => Promise<boolean> };
    if (typeof mediaProjectItem.isOffline === "function" && await mediaProjectItem.isOffline()) {
      offlineMedia.add(name || "이름 없는 오프라인 미디어");
    }
  };

  const enqueue = (item: VideoClipTrackItem | AudioClipTrackItem): boolean => {
    if (itemsToInspect.length >= limit) {
      truncated = true;
      return false;
    }
    itemsToInspect.push(item);
    return true;
  };
  const videoTracks = Number(await sequence.getVideoTrackCount()) || 0;
  for (let index = 0; index < videoTracks && !truncated; index += 1) {
    const track = await sequence.getVideoTrack(index);
    const items = await getClipTrackItems(track);
    for (const item of items) {
      if (!enqueue(item)) break;
    }
  }
  const audioTracks = Number(await sequence.getAudioTrackCount()) || 0;
  for (let index = 0; index < audioTracks && !truncated; index += 1) {
    const track = await sequence.getAudioTrack(index);
    const items = await getClipTrackItems(track);
    for (const item of items) {
      if (!enqueue(item)) break;
    }
  }
  await forEachLimited(itemsToInspect, concurrency, inspect);
  return {
    offlineMedia: [...offlineMedia],
    guideOverlays: [...guideOverlays],
    scannedItems: itemsToInspect.length,
    truncated,
  };
}

export async function runSequenceQC(
  expectedWidth: number,
  expectedHeight: number,
  maxDuration: number,
): Promise<{ status: SequenceStatus; items: QCItem[] }> {
  const status = await readSequenceStatus(undefined, {
    includeSelection: false,
    includePlayerPosition: false,
  });
  return {
    status,
    items: validateShort({
      width: status.width,
      height: status.height,
      duration: status.effectiveDuration || status.sequenceEnd,
      captionTrackCount: status.captionTrackCount,
      videoTrackCount: status.videoTrackCount,
      audioTrackCount: status.audioTrackCount,
      expectedWidth,
      expectedHeight,
      maxDuration,
      name: status.sequenceName,
    }),
  };
}

async function uniqueSequenceName(project: Project, requested: string): Promise<string> {
  const base = sanitizeSequenceName(requested);
  const sequences = await project.getSequences();
  const names = new Set(sequences.map((sequence) => String(sequence.name ?? "").toLocaleLowerCase()));
  if (!names.has(base.toLocaleLowerCase())) {
    return base;
  }
  for (let index = 2; index <= 999; index += 1) {
    const suffix = ` ${index}`;
    const candidate = `${base.slice(0, 120 - suffix.length)}${suffix}`;
    if (!names.has(candidate.toLocaleLowerCase())) {
      return candidate;
    }
  }
  return `${base.slice(0, 100)} ${Date.now()}`;
}

async function renameSequence(project: Project, sequence: Sequence, requestedName: string): Promise<string> {
  const name = await uniqueSequenceName(project, requestedName);
  const projectItem = await sequence.getProjectItem();
  if (!projectItem || typeof projectItem.createSetNameAction !== "function") {
    return String(sequence.name ?? name);
  }
  if (!commitActionFactories(project, [() => projectItem.createSetNameAction(name)], "ShortFlow: 시퀀스 이름 변경")) {
    throw new ShortFlowError("RENAME_FAILED", "복제된 시퀀스의 이름을 변경하지 못했습니다.");
  }
  return name;
}

export async function cloneSequence(
  project: Project,
  source: Sequence,
  name: string,
  beforeCommit?: () => void | Promise<void>,
): Promise<Sequence> {
  const before = await project.getSequences();
  const beforeGuids = new Set(before.map((sequence) => guidKey(sequence.guid)));
  await beforeCommit?.();
  if (!commitActionFactories(project, [() => source.createCloneAction()], "ShortFlow: 원본 시퀀스 복제")) {
    throw new ShortFlowError("CLONE_FAILED", "원본 시퀀스를 복제하지 못했습니다.");
  }

  let clone: Sequence | null = null;
  for (let attempt = 0; attempt < 20 && !clone; attempt += 1) {
    if (attempt > 0) await wait(50);
    const sequences = await project.getSequences();
    clone = sequences.find((sequence) => !beforeGuids.has(guidKey(sequence.guid))) ?? null;
  }
  if (!clone) {
    const active = await project.getActiveSequence();
    if (active && guidKey(active.guid) !== guidKey(source.guid)) {
      clone = active;
    }
  }
  if (!clone) {
    throw new ShortFlowError("CLONE_NOT_FOUND", "복제 작업은 실행됐지만 새 시퀀스를 찾지 못했습니다.");
  }

  try {
    await renameSequence(project, clone, name);
    // openSequence may report false when the clone is already open; activation is authoritative.
    await project.openSequence(clone);
    if (!await project.setActiveSequence(clone)) {
      throw new ShortFlowError("ACTIVATE_CLONE_FAILED", "복제된 시퀀스를 활성화하지 못했습니다.");
    }
    return clone;
  } catch (error) {
    try {
      await removeKnownClonedSequenceFromProject(project, source, clone);
    } catch (cleanupError) {
      throw new ShortFlowError(
        "AUTOMATION_CLONE_CLEANUP_FAILED",
        `복제 시퀀스 준비 실패 후 정리하지 못했습니다. 원래 오류: ${errorMessage(error)} · 정리 오류: ${errorMessage(cleanupError)}`,
      );
    }
    throw error;
  }
}

async function setSequenceFrame(
  project: Project,
  sequence: Sequence,
  width: number,
  height: number,
): Promise<{ oldWidth: number; oldHeight: number; warnings: string[] }> {
  assertPositiveDimensions(width, height);
  const warnings: string[] = [];
  const currentFrame = await sequence.getFrameSize();
  const oldWidth = Number(currentFrame?.width) || width;
  const oldHeight = Number(currentFrame?.height) || height;
  const settings = await sequence.getSettings();
  const frameRect = await settings.getVideoFrameRect();
  frameRect.width = Math.round(width);
  frameRect.height = Math.round(height);
  const changed = await settings.setVideoFrameRect(frameRect);
  if (changed === false) {
    throw new ShortFlowError("FRAME_MUTATION_FAILED", "시퀀스 프레임 크기를 준비하지 못했습니다.");
  }

  try {
    const previewRect = await settings.getPreviewFrameRect();
    previewRect.width = Math.round(width);
    previewRect.height = Math.round(height);
    if (await settings.setPreviewFrameRect(previewRect) === false) {
      warnings.push("미리보기 코덱 프레임 크기는 유지되었습니다.");
    }
  } catch {
    warnings.push("미리보기 프레임 크기는 현재 코덱 설정 때문에 변경하지 못했습니다.");
  }

  try {
    const square = ppro.Constants.PixelAspectRatio.SQUARE;
    if (await settings.setVideoPixelAspectRatio(String(square)) === false) {
      warnings.push("픽셀 종횡비를 정사각 픽셀로 변경하지 못했습니다.");
    }
  } catch {
    warnings.push("픽셀 종횡비는 기존 값을 유지했습니다.");
  }
  try {
    await settings.setVideoFieldType(ppro.Constants.VideoFieldType.PROGRESSIVE);
  } catch {
    warnings.push("필드 순서는 기존 값을 유지했습니다.");
  }

  if (!commitActionFactories(project, [() => sequence.createSetSettingsAction(settings)], "ShortFlow: 숏폼 프레임 설정")) {
    throw new ShortFlowError("FRAME_COMMIT_FAILED", "숏폼 프레임 설정을 시퀀스에 적용하지 못했습니다.");
  }
  const verified = await sequence.getFrameSize();
  if (Number(verified?.width) !== Math.round(width) || Number(verified?.height) !== Math.round(height)) {
    throw new ShortFlowError("FRAME_VERIFY_FAILED", "적용 후 시퀀스 해상도 검증에 실패했습니다.");
  }
  return { oldWidth, oldHeight, warnings };
}

async function resolveSequenceRange(sequence: Sequence, options: CreateShortOptions): Promise<ResolvedTimeRange> {
  const sequenceEnd = await safeTime(sequence, "getEndTime", 0);
  if (options.explicitRange) {
    if (
      !Number.isFinite(options.explicitRange.start)
      || !Number.isFinite(options.explicitRange.end)
    ) {
      throw new ShortFlowError("INVALID_RANGE", "명시적 숏폼 구간은 유한한 초 단위 값이어야 합니다.");
    }
    const start = Math.max(0, Math.min(sequenceEnd, options.explicitRange.start));
    const requestedEnd = Math.max(start, Math.min(sequenceEnd, options.explicitRange.end));
    const end = Math.min(requestedEnd, start + options.maxDuration);
    return { start, end, duration: Math.max(0, end - start), usedFallback: false };
  }
  if (options.rangeMode === "selection") {
    const selection = await readSelectionRange(sequence);
    if (selection.start === null || selection.end === null || selection.end <= selection.start) {
      throw new ShortFlowError("NO_SELECTION_RANGE", "선택한 클립에서 유효한 시간 범위를 찾지 못했습니다.");
    }
    const end = Math.min(selection.end, selection.start + options.maxDuration, sequenceEnd);
    return {
      start: selection.start,
      end,
      duration: end - selection.start,
      usedFallback: false,
    };
  }
  const mode = options.rangeMode === "sequence" ? "full"
    : options.rangeMode === "playhead" ? "playhead"
      : "inout";
  return resolveTimeRange({
    mode,
    sequenceEnd,
    inPoint: await safeTime(sequence, "getInPoint", 0),
    outPoint: await safeTime(sequence, "getOutPoint", sequenceEnd),
    playhead: await safeTime(sequence, "getPlayerPosition", 0),
    maxDuration: options.maxDuration,
  });
}

function setSequenceRange(project: Project, sequence: Sequence, range: ResolvedTimeRange): void {
  if (!(range.duration > 0)) {
    throw new ShortFlowError("EMPTY_RANGE", "숏폼으로 만들 구간의 길이가 0초입니다.");
  }
  const start = ppro.TickTime.createWithSeconds(range.start);
  const end = ppro.TickTime.createWithSeconds(range.end);
  if (!commitActionFactories(
    project,
    [() => sequence.createSetInPointAction(start), () => sequence.createSetOutPointAction(end)],
    "ShortFlow: 숏폼 인/아웃 설정",
  )) {
    throw new ShortFlowError("RANGE_COMMIT_FAILED", "시퀀스 인/아웃 구간을 적용하지 못했습니다.");
  }
}

async function allVideoItems(sequence: Sequence, scope: ReframeScope): Promise<VideoClipTrackItem[]> {
  if (scope === "selected") {
    const selection = await readSelectionRange(sequence);
    const selected = selection.items.filter(isVideoTrackItem);
    if (selected.length === 0) {
      throw new ShortFlowError("NO_SELECTED_VIDEO", "리프레임할 비디오 클립을 선택해 주세요.");
    }
    return selected;
  }

  const count = Number(await sequence.getVideoTrackCount()) || 0;
  const items: VideoClipTrackItem[] = [];
  const trackLimit = scope === "primary" ? Math.min(1, count) : count;
  for (let trackIndex = 0; trackIndex < trackLimit; trackIndex += 1) {
    const track = await sequence.getVideoTrack(trackIndex);
    if (!track) continue;
    const trackItems = await getClipTrackItems(track);
    items.push(...trackItems.filter(isVideoTrackItem));
  }
  return items;
}

async function overlapsRange(item: VideoClipTrackItem, range: ResolvedTimeRange): Promise<boolean> {
  try {
    const start = tickTimeSeconds(await item.getStartTime(), Number.NaN);
    const end = tickTimeSeconds(await item.getEndTime(), Number.NaN);
    return Number.isFinite(start) && Number.isFinite(end) && start < range.end && end > range.start;
  } catch {
    return true;
  }
}

async function findMotionComponent(item: VideoClipTrackItem): Promise<Component | null> {
  const chain = await item.getComponentChain();
  if (!chain) return null;
  const count = Number(chain.getComponentCount()) || 0;
  for (let index = 0; index < count; index += 1) {
    const component = chain.getComponentAtIndex(index);
    if (!component) continue;
    const matchName = String(await component.getMatchName()).toLocaleLowerCase();
    const displayName = String(await component.getDisplayName()).toLocaleLowerCase();
    if (
      matchName.includes("motion")
      || displayName.includes("motion")
      || displayName.includes("모션")
      || displayName.includes("동작")
    ) {
      return component;
    }
  }
  return null;
}

async function motionParams(component: Component): Promise<{
  scale: ComponentParam | null;
  position: ComponentParam | null;
}> {
  const count = Number(component.getParamCount()) || 0;
  let scale: ComponentParam | null = null;
  let position: ComponentParam | null = null;
  for (let index = 0; index < count; index += 1) {
    const param = component.getParam(index);
    if (!param) continue;
    const name = String(param.displayName ?? "").toLocaleLowerCase();
    if (!position && (name.includes("position") || name.includes("위치"))) {
      position = param;
    }
    if (
      !scale
      && (
        name.includes("scale")
        || name.includes("스케일")
        || name.includes("비율")
        || name.includes("크기")
      )
      && !name.includes("width")
      && !name.includes("폭")
    ) {
      scale = param;
    }
  }
  if (!position && count > 0) {
    const candidate = component.getParam(0);
    const value = candidate ? keyframeValue(await candidate.getStartValue()) : null;
    if (centeredPosition(value, 1, 1)) {
      position = candidate;
    }
  }
  if (!scale && count > 1) {
    const candidate = component.getParam(1);
    const value = candidate ? keyframeValue(await candidate.getStartValue()) : null;
    if (Number.isFinite(Number(value))) {
      scale = candidate;
    }
  }
  return { scale, position };
}

async function buildReframeActions(
  item: VideoClipTrackItem,
  oldWidth: number,
  oldHeight: number,
  targetWidth: number,
  targetHeight: number,
  mode: ReframeMode,
  center: boolean,
): Promise<{ actions: ActionFactory[]; warning?: string }> {
  if (typeof item.isAdjustmentLayer === "function" && await item.isAdjustmentLayer()) {
    return { actions: [], warning: "조정 레이어는 건너뛰었습니다." };
  }
  const component = await findMotionComponent(item);
  if (!component) {
    return { actions: [], warning: "Motion 구성 요소를 찾지 못한 클립을 건너뛰었습니다." };
  }
  const params = await motionParams(component);
  const actions: ActionFactory[] = [];
  const warnings: string[] = [];

  if (mode !== "none" && params.scale) {
    if (params.scale.isTimeVarying()) {
      warnings.push("스케일 키프레임이 있는 클립은 기존 애니메이션을 보존했습니다.");
    } else {
      const current: Keyframe = await params.scale.getStartValue();
      const currentScale = Number(keyframeValue(current));
      if (!Number.isFinite(currentScale)) {
        warnings.push("스케일 값 형식을 인식하지 못한 클립이 있습니다.");
      } else {
        const nextScale = calculateRelativeScale(
          currentScale,
          oldWidth,
          oldHeight,
          targetWidth,
          targetHeight,
          mode,
        );
        actions.push(() => {
          const keyframe = params.scale!.createKeyframe(nextScale);
          return params.scale!.createSetValueAction(keyframe, true);
        });
      }
    }
  }

  if (center && params.position) {
    if (params.position.isTimeVarying()) {
      warnings.push("위치 키프레임이 있는 클립은 중앙 정렬하지 않았습니다.");
    } else {
      const current: Keyframe = await params.position.getStartValue();
      const centered = centeredPosition(keyframeValue(current), targetWidth, targetHeight);
      if (centered) {
        actions.push(() => {
          const point: PointF = ppro.PointF(centered.x, centered.y);
          const keyframe = params.position!.createKeyframe(point);
          return params.position!.createSetValueAction(keyframe, true);
        });
      } else {
        warnings.push("위치 값 형식을 인식하지 못한 클립이 있습니다.");
      }
    }
  }
  if (warnings.length > 0) {
    return { actions, warning: warnings.join(" ") };
  }
  return { actions };
}

export interface ClipMotionOptions {
  kind: MotionKind;
  direction: MotionDirection;
  easing: MotionEasing;
  durationSeconds: number;
  fade: boolean;
  scope: ReframeScope;
}

export interface ClipMotionResult {
  discovered: number;
  changed: number;
  warnings: string[];
}

async function findOpacityParam(item: VideoClipTrackItem): Promise<ComponentParam | null> {
  const chain = await item.getComponentChain();
  if (!chain) return null;
  const count = Number(chain.getComponentCount()) || 0;
  for (let index = 0; index < count; index += 1) {
    const component = chain.getComponentAtIndex(index);
    if (!component) continue;
    const displayName = String(await component.getDisplayName()).toLocaleLowerCase();
    const matchName = String(await component.getMatchName()).toLocaleLowerCase();
    if (!(matchName.includes("opacity") || displayName.includes("opacity") || displayName.includes("불투명"))) {
      continue;
    }
    const paramCount = Number(component.getParamCount()) || 0;
    for (let p = 0; p < paramCount; p += 1) {
      const param = component.getParam(p);
      if (!param) continue;
      const name = String(param.displayName ?? "").toLocaleLowerCase();
      if (paramCount === 1 || name.includes("opacity") || name.includes("불투명")) return param;
    }
    if (paramCount > 0) return component.getParam(0);
  }
  return null;
}

async function buildClipMotionActions(
  item: VideoClipTrackItem,
  options: ClipMotionOptions,
  frameWidth: number,
  frameHeight: number,
): Promise<{ actions: ActionFactory[]; warning?: string }> {
  const samples = computeMotionSamples(options.kind, options.easing, options.durationSeconds);
  if (samples.length === 0) return { actions: [], warning: "모션 길이가 올바르지 않습니다." };
  const component = await findMotionComponent(item);
  if (!component) return { actions: [], warning: "Motion 구성 요소를 찾지 못한 클립을 건너뛰었습니다." };
  const params = await motionParams(component);
  if (!params.position) return { actions: [], warning: "위치 파라미터를 찾지 못한 클립을 건너뛰었습니다." };
  const position = params.position;
  if (typeof position.areKeyframesSupported === "function" && !(await position.areKeyframesSupported())) {
    return { actions: [], warning: "위치 키프레임을 지원하지 않는 클립을 건너뛰었습니다." };
  }
  if (typeof position.isTimeVarying === "function" && position.isTimeVarying()) {
    // 이미 위치 키프레임이 있는 클립은 기존 애니메이션을 파괴하지 않도록 건너뛴다.
    return { actions: [], warning: "위치 키프레임이 이미 있는 클립은 기존 애니메이션을 보존했습니다." };
  }
  const restValue = keyframeValue(await position.getStartValue());
  if (typeof restValue !== "object" || restValue === null || !("x" in restValue) || !("y" in restValue)) {
    return { actions: [], warning: "위치 값 형식을 인식하지 못한 클립을 건너뛰었습니다." };
  }
  const restX = Number((restValue as { x: unknown }).x);
  const restY = Number((restValue as { y: unknown }).y);
  if (!Number.isFinite(restX) || !Number.isFinite(restY)) {
    return { actions: [], warning: "위치 값을 읽지 못한 클립을 건너뛰었습니다." };
  }
  const normalized = Math.abs(restX) <= 2 && Math.abs(restY) <= 2;
  const horizontal = options.direction === "left" || options.direction === "right";
  const slideAmount = normalized ? 1 : horizontal ? frameWidth : frameHeight;

  const actions: ActionFactory[] = [];
  for (const sample of samples) {
    const point = slidePosition(restX, restY, options.direction, sample.progress, slideAmount);
    actions.push(() => {
      const keyframe = position.createKeyframe(ppro.PointF(point.x, point.y));
      keyframe.position = ppro.TickTime.createWithSeconds(sample.timeSeconds);
      return position.createAddKeyframeAction(keyframe);
    });
  }

  if (options.fade) {
    const opacity = await findOpacityParam(item);
    const opacityHasKeyframes = opacity && typeof opacity.isTimeVarying === "function" && opacity.isTimeVarying();
    if (opacity && !opacityHasKeyframes && (typeof opacity.areKeyframesSupported !== "function" || (await opacity.areKeyframesSupported()))) {
      for (const sample of samples) {
        const value = motionOpacity(sample.progress);
        actions.push(() => {
          const keyframe = opacity.createKeyframe(value);
          keyframe.position = ppro.TickTime.createWithSeconds(sample.timeSeconds);
          return opacity.createAddKeyframeAction(keyframe);
        });
      }
    }
  }

  return { actions };
}

/** 선택 비디오 클립에 방향별 등장/퇴장 슬라이드(+선택적 페이드) 키프레임을 적용한다. */
export async function applyClipMotion(options: ClipMotionOptions): Promise<ClipMotionResult> {
  if (!(options.durationSeconds > 0)) {
    throw new ShortFlowError("INVALID_MOTION", "모션 길이는 0보다 커야 합니다.");
  }
  const { project, sequence } = await getActiveContext();
  let items: VideoClipTrackItem[];
  try {
    items = await allVideoItems(sequence, options.scope);
  } catch (error) {
    if (error instanceof ShortFlowError && error.code === "NO_SELECTED_VIDEO") {
      throw new ShortFlowError("NO_SELECTED_VIDEO", "모션을 적용할 비디오 클립을 선택해 주세요.");
    }
    throw error;
  }
  if (items.length === 0) {
    throw new ShortFlowError("NO_SELECTED_VIDEO", "모션을 적용할 비디오 클립을 선택해 주세요.");
  }
  const frame = await sequence.getFrameSize();
  const frameWidth = Math.round(Number(frame.width)) || 1920;
  const frameHeight = Math.round(Number(frame.height)) || 1080;
  const limited = items.slice(0, 200);
  const actions: ActionFactory[] = [];
  const warnings: string[] = [];
  let changed = 0;
  for (const item of limited) {
    try {
      const built = await buildClipMotionActions(item, options, frameWidth, frameHeight);
      if (built.actions.length > 0) {
        actions.push(...built.actions);
        changed += 1;
      }
      if (built.warning) warnings.push(built.warning);
    } catch (error) {
      warnings.push(`클립 모션 실패: ${errorMessage(error)}`);
    }
  }
  if (items.length > limited.length) {
    warnings.push(`안전 제한 때문에 ${items.length - limited.length}개 클립은 건너뛰었습니다.`);
  }
  if (actions.length > 0 && !commitActionFactories(project, actions, "ShortFlow: 클립 모션")) {
    throw new ShortFlowError("MOTION_COMMIT_FAILED", "클립 모션 작업을 적용하지 못했습니다.");
  }
  return { discovered: items.length, changed, warnings: [...new Set(warnings)] };
}

async function reframeSequence(
  project: Project,
  sequence: Sequence,
  range: ResolvedTimeRange,
  oldWidth: number,
  oldHeight: number,
  options: CreateShortOptions,
): Promise<ReframeResult> {
  if (options.reframeMode === "none" && !options.centerClips) {
    return { discovered: 0, changed: 0, skipped: 0, warningMessages: [] };
  }
  const candidates = await allVideoItems(sequence, options.scope);
  const items: VideoClipTrackItem[] = [];
  for (const item of candidates) {
    if (await overlapsRange(item, range)) items.push(item);
  }
  const limited = items.slice(0, 500);
  const actions: ActionFactory[] = [];
  const warnings: string[] = [];
  let changed = 0;
  for (const item of limited) {
    try {
      const result = await buildReframeActions(
        item,
        oldWidth,
        oldHeight,
        options.width,
        options.height,
        options.reframeMode,
        options.centerClips,
      );
      if (result.actions.length > 0) {
        actions.push(...result.actions);
        changed += 1;
      }
      if (result.warning) warnings.push(result.warning);
    } catch (error) {
      warnings.push(`클립 리프레임 실패: ${errorMessage(error)}`);
    }
  }
  if (items.length > limited.length) {
    warnings.push(`안전 제한 때문에 ${items.length - limited.length}개 클립은 건너뛰었습니다.`);
  }
  if (actions.length > 0 && !commitActionFactories(project, actions, "ShortFlow: 클립 리프레임")) {
    throw new ShortFlowError("REFRAME_COMMIT_FAILED", "클립 리프레임 작업을 적용하지 못했습니다.");
  }
  return {
    discovered: items.length,
    changed,
    skipped: items.length - changed,
    warningMessages: [...new Set(warnings)],
  };
}

async function createShortFromSource(
  project: Project,
  source: Sequence,
  options: CreateShortOptions,
): Promise<CreateShortResult> {
  assertPositiveDimensions(options.width, options.height);
  assertShortDuration(options.maxDuration);
  const sourceRange = await resolveSequenceRange(source, options);
  if (!(sourceRange.duration > 0)) {
    throw new ShortFlowError("EMPTY_RANGE", "선택한 숏폼 구간의 길이가 0초입니다.");
  }
  const clone = await cloneSequence(project, source, options.name);
  const frameResult = await setSequenceFrame(project, clone, options.width, options.height);
  setSequenceRange(project, clone, sourceRange);
  const reframe = await reframeSequence(
    project,
    clone,
    sourceRange,
    frameResult.oldWidth,
    frameResult.oldHeight,
    options,
  );
  return {
    sequence: clone,
    sequenceName: String(clone.name ?? sanitizeSequenceName(options.name)),
    width: options.width,
    height: options.height,
    range: sourceRange,
    reframe,
    warnings: [...frameResult.warnings, ...reframe.warningMessages],
  };
}

export async function createShort(options: CreateShortOptions): Promise<CreateShortResult> {
  const { project, sequence } = await getActiveContext();
  return createShortFromSource(project, sequence, options);
}

function isShortMarker(name: string, comments: string): boolean {
  const combined = `${name} ${comments}`.toLocaleLowerCase();
  return combined.includes("short") || combined.includes("숏폼") || combined.includes("#sf");
}

export async function scanShortMarkers(defaultDuration: number): Promise<MarkerSegment[]> {
  assertShortDuration(defaultDuration);
  const { sequence } = await getActiveContext();
  const sequenceEnd = await safeTime(sequence, "getEndTime", 0);
  const markerCollection = await ppro.Markers.getMarkers(sequence);
  const markers = markerCollection.getMarkers();
  const segments: MarkerSegment[] = [];
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    if (!marker) continue;
    const name = String(marker.getName());
    const comments = String(marker.getComments());
    if (!isShortMarker(name, comments)) continue;
    const segment = markerToSegment({
      name,
      comments,
      start: tickTimeSeconds(marker.getStart(), Number.NaN),
      duration: tickTimeSeconds(marker.getDuration(), 0),
      index,
    }, sequenceEnd, defaultDuration);
    if (segment) segments.push(segment);
  }
  return segments.sort((a, b) => a.start - b.start || a.index - b.index);
}

export async function createShortsFromMarkers(
  segments: MarkerSegment[],
  baseOptions: CreateShortOptions,
  onProgress?: (completed: number, total: number, name: string) => void,
): Promise<{ created: CreateShortResult[]; failures: Array<{ name: string; error: string }> }> {
  if (segments.length === 0) {
    throw new ShortFlowError("NO_MARKER_SEGMENTS", "일괄 생성할 숏폼 마커 구간이 없습니다.");
  }
  if (segments.length > 30) {
    throw new ShortFlowError("TOO_MANY_SEGMENTS", "한 번에 최대 30개 구간까지 생성할 수 있습니다.");
  }
  const { project, sequence: source } = await getActiveContext();
  const created: CreateShortResult[] = [];
  const failures: Array<{ name: string; error: string }> = [];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const name = sanitizeSequenceName(`${baseOptions.name}_${String(index + 1).padStart(2, "0")}_${segment.name}`);
    onProgress?.(index, segments.length, name);
    try {
      created.push(await createShortFromSource(project, source, {
        ...baseOptions,
        name,
        explicitRange: { start: segment.start, end: segment.end },
        scope: baseOptions.scope === "selected" ? "video" : baseOptions.scope,
      }));
    } catch (error) {
      failures.push({ name, error: errorMessage(error) });
    }
  }
  onProgress?.(segments.length, segments.length, "완료");
  if (created.length > 0) {
    await project.setActiveSequence(created.at(-1)!.sequence);
  }
  return { created, failures };
}

export async function addStoryMarkers(hookSeconds: number, ctaSeconds: number): Promise<number> {
  if (
    !Number.isFinite(hookSeconds)
    || !Number.isFinite(ctaSeconds)
    || hookSeconds < 0
    || ctaSeconds < 0
  ) {
    throw new ShortFlowError("INVALID_MARKER_DURATION", "훅과 CTA 길이는 0 이상의 유한한 숫자여야 합니다.");
  }
  const { project, sequence } = await getActiveContext();
  const sequenceEnd = await safeTime(sequence, "getEndTime", 0);
  const range = resolveTimeRange({
    mode: "inout",
    sequenceEnd,
    inPoint: await safeTime(sequence, "getInPoint", 0),
    outPoint: await safeTime(sequence, "getOutPoint", sequenceEnd),
  });
  if (!(range.duration > 0)) {
    throw new ShortFlowError("EMPTY_RANGE", "마커를 배치할 유효한 구간이 없습니다.");
  }
  const markerCollection = await ppro.Markers.getMarkers(sequence);
  const actions: ActionFactory[] = [];
  const commentMarkerType = ppro.Marker.MARKER_TYPE_COMMENT;
  const hookDuration = Math.min(Math.max(0, hookSeconds), range.duration);
  const ctaDuration = Math.min(Math.max(0, ctaSeconds), range.duration);
  if (hookDuration > 0) {
    actions.push(() => markerCollection.createAddMarkerAction(
      "HOOK",
      commentMarkerType,
      ppro.TickTime.createWithSeconds(range.start),
      ppro.TickTime.createWithSeconds(hookDuration),
      "첫 1~3초 안에 시선을 끄는 핵심 장면/문장을 배치하세요.",
    ));
  }
  if (ctaDuration > 0) {
    actions.push(() => markerCollection.createAddMarkerAction(
      "CTA",
      commentMarkerType,
      ppro.TickTime.createWithSeconds(Math.max(range.start, range.end - ctaDuration)),
      ppro.TickTime.createWithSeconds(ctaDuration),
      "구독·댓글·링크 등 한 가지 행동 요청만 명확하게 배치하세요.",
    ));
  }
  if (actions.length === 0) {
    throw new ShortFlowError("NO_MARKERS_TO_ADD", "훅 또는 CTA 길이를 0초보다 크게 설정해 주세요.");
  }
  if (!commitActionFactories(project, actions, "ShortFlow: HOOK/CTA 마커 추가")) {
    throw new ShortFlowError("MARKER_COMMIT_FAILED", "스토리 마커를 추가하지 못했습니다.");
  }
  return actions.length;
}

function assertAutomationRanges(
  ranges: readonly TimeRange[],
  label: string,
  sourceDuration: number,
): number {
  let previousEnd = 0;
  let total = 0;
  for (let index = 0; index < ranges.length; index += 1) {
    const item = ranges[index];
    if (
      !item || !Number.isFinite(item.start) || !Number.isFinite(item.end) || !Number.isFinite(item.duration) ||
      item.start < 0 || item.end <= item.start || item.end > sourceDuration ||
      Math.abs(item.duration - (item.end - item.start)) > 1e-6 ||
      (index > 0 && item.start < previousEnd - 1e-6)
    ) {
      throw new ShortFlowError("INVALID_AUTOMATION_PLAN", `${label} ${index + 1}번 시간 범위가 올바르지 않습니다.`);
    }
    previousEnd = item.end;
    total += item.duration;
  }
  return total;
}

export function assertAutomationPlan(plan: SilenceCutPlan, cues: readonly PunchCue[]): void {
  if (
    !plan || !Array.isArray(plan.cuts) || !Array.isArray(plan.keeps) ||
    !Array.isArray(plan.speech) || !Array.isArray(cues)
  ) {
    throw new ShortFlowError("INVALID_AUTOMATION_PLAN", "자동 편집안 데이터가 올바르지 않습니다.");
  }
  if (
    !Number.isFinite(plan.sourceDuration) || plan.sourceDuration <= 0 ||
    !Number.isFinite(plan.outputDuration) || plan.outputDuration < 0 ||
    !Number.isFinite(plan.removedDuration) || plan.removedDuration < 0 ||
    !Number.isFinite(plan.compressionRatio) || plan.compressionRatio < 0 || plan.compressionRatio > 1
  ) {
    throw new ShortFlowError("INVALID_AUTOMATION_PLAN", "자동 편집안 길이 요약이 올바르지 않습니다.");
  }
  const removed = assertAutomationRanges(plan.cuts, "컷", plan.sourceDuration);
  const kept = assertAutomationRanges(plan.keeps, "유지", plan.sourceDuration);
  assertAutomationRanges(plan.speech, "발화", plan.sourceDuration);
  if (plan.cuts.some((cut) => plan.speech.some((speech) => cut.start < speech.end && cut.end > speech.start))) {
    throw new ShortFlowError("INVALID_AUTOMATION_PLAN", "자동 컷이 보호해야 할 실제 발화 구간을 침범합니다.");
  }
  if (
    Math.abs(removed - plan.removedDuration) > 1e-6 ||
    Math.abs(kept - plan.outputDuration) > 1e-6 ||
    Math.abs(plan.removedDuration + plan.outputDuration - plan.sourceDuration) > 1e-6 ||
    Math.abs(plan.compressionRatio - plan.outputDuration / plan.sourceDuration) > 1e-6
  ) {
    throw new ShortFlowError("INVALID_AUTOMATION_PLAN", "자동 편집안의 컷·유지 길이 합계가 원본 길이와 일치하지 않습니다.");
  }
  const partition = [...plan.cuts, ...plan.keeps].sort((left, right) => left.start - right.start || left.end - right.end);
  let cursor = 0;
  for (const item of partition) {
    if (Math.abs(item.start - cursor) > 1e-6) {
      throw new ShortFlowError("INVALID_AUTOMATION_PLAN", "자동 편집안의 컷·유지 구간에 공백 또는 겹침이 있습니다.");
    }
    cursor = item.end;
  }
  if (Math.abs(cursor - plan.sourceDuration) > 1e-6) {
    throw new ShortFlowError("INVALID_AUTOMATION_PLAN", "자동 편집안의 컷·유지 구간이 원본 전체를 덮지 않습니다.");
  }
  let previousCueEnd = 0;
  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index];
    if (
      !cue || !Number.isFinite(cue.start) || !Number.isFinite(cue.end) || !Number.isFinite(cue.scale) ||
      cue.start < 0 || cue.end <= cue.start || cue.end > plan.sourceDuration ||
      cue.scale < 101 || cue.scale > 150 || typeof cue.reason !== "string" || typeof cue.text !== "string" ||
      (index > 0 && cue.start < previousCueEnd - 1e-6)
    ) {
      throw new ShortFlowError("INVALID_AUTOMATION_PLAN", `펀치인 ${index + 1}번 범위가 올바르지 않습니다.`);
    }
    previousCueEnd = cue.end;
  }
  try {
    assertAutomationMarkerBudget(plan.cuts.length, cues.length);
  } catch {
    throw new ShortFlowError(
      "TOO_MANY_AUTOMATION_MARKERS",
      `자동 편집 마커는 컷과 펀치인을 합쳐 한 번에 최대 ${MAX_AUTOMATION_MARKERS}개까지 추가할 수 있습니다.`,
    );
  }
}

async function addAutomationMarkersToSequence(
  project: Project,
  sequence: Sequence,
  plan: SilenceCutPlan,
  cues: readonly PunchCue[],
  beforeCommit?: () => Promise<void>,
): Promise<AutomationMarkerResult> {
  assertAutomationPlan(plan, cues);
  const markerCollection = await ppro.Markers.getMarkers(sequence);
  const markerType = ppro.Marker.MARKER_TYPE_COMMENT;
  const actions: ActionFactory[] = [];
  for (const [index, cut] of plan.cuts.entries()) {
    if (!Number.isFinite(cut.start) || !Number.isFinite(cut.duration) || cut.duration <= 0) continue;
    actions.push(() => markerCollection.createAddMarkerAction(
      `SF CUT ${String(index + 1).padStart(2, "0")}`,
      markerType,
      ppro.TickTime.createWithSeconds(Math.max(0, cut.start)),
      ppro.TickTime.createWithSeconds(cut.duration),
      `ShortFlow 무음 제거 추천 · ${cut.duration.toFixed(2)}초 · 적용 전 파형과 대사를 확인하세요.`,
    ));
  }
  const cutMarkers = actions.length;
  for (const [index, cue] of cues.entries()) {
    if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.end <= cue.start) continue;
    actions.push(() => markerCollection.createAddMarkerAction(
      `SF ZOOM ${String(index + 1).padStart(2, "0")}`,
      markerType,
      ppro.TickTime.createWithSeconds(Math.max(0, cue.start)),
      ppro.TickTime.createWithSeconds(cue.end - cue.start),
      `ShortFlow 펀치인 ${cue.scale.toFixed(0)}% · ${cue.reason} · ${cue.text.slice(0, 160)}`,
    ));
  }
  if (actions.length === 0) {
    throw new ShortFlowError("NO_AUTOMATION_MARKERS", "추가할 자동 편집 추천 마커가 없습니다.");
  }
  await beforeCommit?.();
  if (!commitActionFactories(project, actions, "ShortFlow: 자동 컷/펀치인 추천 마커")) {
    throw new ShortFlowError("AUTOMATION_MARKER_COMMIT_FAILED", "자동 편집 추천 마커를 추가하지 못했습니다.");
  }
  return { cutMarkers, punchMarkers: actions.length - cutMarkers };
}

/** Adds review markers only; it never changes clips or source media. */
export async function addAutomationMarkers(
  plan: SilenceCutPlan,
  cues: readonly PunchCue[],
  guard: AutomationMutationGuard = {},
): Promise<AutomationMarkerResult> {
  const { project, sequence, contextKey } = await getExpectedActiveContext(guard.sourceContextKey);
  return addAutomationMarkersToSequence(project, sequence, plan, cues, () => assertActiveContextKey(contextKey));
}

export interface PlannedPunchKeyframe {
  /** Clip-local time in seconds. */
  time: number;
  value: number;
}

/** Plans clip-local scale values without touching Premiere Host objects. */
export function planClipPunchKeyframes(
  itemStart: number,
  itemEnd: number,
  startValue: number,
  cues: readonly PunchCue[],
): PlannedPunchKeyframe[] {
  if (
    !Number.isFinite(itemStart) || !Number.isFinite(itemEnd) || itemEnd <= itemStart ||
    !Number.isFinite(startValue)
  ) {
    return [];
  }
  const clipDuration = itemEnd - itemStart;
  const keyframes = new Map<number, number>();
  for (const cue of cues.filter((candidate) => candidate.start < itemEnd && candidate.end > itemStart).slice(0, 50)) {
    const localStart = Math.max(0, cue.start - itemStart);
    const localEnd = Math.min(clipDuration, cue.end - itemStart);
    if (localEnd <= localStart) continue;
    const transition = Math.min(0.1, Math.max(0.03, (localEnd - localStart) / 4));
    const zoomScale = startValue * Math.max(1.01, Math.min(1.5, cue.scale / 100));

    if (localStart > 0) keyframes.set(Math.max(0, localStart - transition), startValue);
    keyframes.set(localStart, zoomScale);
    keyframes.set(localEnd, zoomScale);
    if (localEnd < clipDuration) keyframes.set(Math.min(clipDuration, localEnd + transition), startValue);
  }
  return [...keyframes.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([time, value]) => ({ time, value }));
}

export function punchApplicabilityWarning(
  cueCount: number,
  candidateClipCount: number,
  punchedClipCount: number,
): string | null {
  if (cueCount <= 0 || punchedClipCount > 0) return null;
  return candidateClipCount <= 0
    ? "펀치인 대상 비디오 클립이 없어 추천 마커만 유지했습니다."
    : "펀치인을 적용할 수 있는 비디오 클립이 없어 추천 마커만 유지했습니다.";
}

async function buildPunchInActions(
  item: VideoClipTrackItem,
  cues: readonly PunchCue[],
): Promise<{ actions: ActionFactory[]; changed: boolean; warning?: string }> {
  if (typeof item.isAdjustmentLayer === "function" && await item.isAdjustmentLayer()) {
    return { actions: [], changed: false, warning: "조정 레이어는 펀치인에서 제외했습니다." };
  }
  const itemStart = tickTimeSeconds(await item.getStartTime(), Number.NaN);
  const itemEnd = tickTimeSeconds(await item.getEndTime(), Number.NaN);
  if (!Number.isFinite(itemStart) || !Number.isFinite(itemEnd) || itemEnd <= itemStart) {
    return { actions: [], changed: false, warning: "클립 시간 범위를 읽지 못해 펀치인을 건너뛰었습니다." };
  }
  const matching = cues.filter((cue) => cue.start < itemEnd && cue.end > itemStart).slice(0, 50);
  if (matching.length === 0) return { actions: [], changed: false };
  const component = await findMotionComponent(item);
  if (!component) return { actions: [], changed: false, warning: "Motion 구성 요소가 없는 클립을 건너뛰었습니다." };
  const { scale } = await motionParams(component);
  if (!scale || !await scale.areKeyframesSupported()) {
    return { actions: [], changed: false, warning: "스케일 키프레임을 지원하지 않는 클립을 건너뛰었습니다." };
  }
  if (scale.isTimeVarying()) {
    return { actions: [], changed: false, warning: "기존 스케일 키프레임이 있는 클립은 보존했습니다." };
  }
  const startValue = Number(keyframeValue(await scale.getStartValue()));
  if (!Number.isFinite(startValue)) {
    return { actions: [], changed: false, warning: "기존 스케일 값을 읽지 못한 클립을 건너뛰었습니다." };
  }
  const keyframes = planClipPunchKeyframes(itemStart, itemEnd, startValue, matching);
  if (keyframes.length === 0) return { actions: [], changed: false };
  const actions: ActionFactory[] = [() => scale.createSetTimeVaryingAction(true)];
  for (const { time, value } of keyframes) {
    actions.push(() => {
      const keyframe = scale.createKeyframe(value);
      keyframe.position = ppro.TickTime.createWithSeconds(time);
      return scale.createAddKeyframeAction(keyframe);
    });
  }
  return { actions, changed: true };
}

/**
 * Creates a clone before any change, adds cut review markers, and applies punch-in keyframes.
 * Public Premiere UXP currently exposes no supported razor-at-time action, so silence regions
 * remain explicit review markers instead of silently using QE/private APIs.
 */
export async function applyAutomationPlan(
  plan: SilenceCutPlan,
  cues: readonly PunchCue[],
  hooks: AutomationApplyHooks = {},
): Promise<AutomationApplyResult> {
  assertAutomationPlan(plan, cues);
  const { project, sequence: source } = await getExpectedActiveContext(hooks.expectedContextKey);
  const sourceContextKey = premiereContextKey(project.guid, source.guid);
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const clone = await cloneSequence(
    project,
    source,
    `${String(source.name ?? "Sequence")}_ShortFlow_Auto_${timestamp}`,
    () => assertActiveContextKey(sourceContextKey),
  );
  const sourceGuid = guidKey(source.guid);
  let cloneGuid = "";
  try {
    cloneGuid = guidKey(clone.guid);
    if (!sourceGuid || !cloneGuid || sourceGuid === cloneGuid) {
      throw new ShortFlowError("INVALID_CLONE_ID", "자동 편집용 원본과 복제 시퀀스 식별자가 올바르지 않습니다.");
    }
    const cloneContextKey = premiereContextKey(project.guid, clone.guid);
    const sequenceName = await renameSequence(project, clone, `${String(source.name ?? "Sequence")}_ShortFlow_Auto_${timestamp}`);
    await project.setActiveSequence(clone);
    await assertActiveContextKey(cloneContextKey);
    await hooks.onClonePrepared?.({ sourceGuid, cloneGuid, sequenceName });
    const markerResult = await addAutomationMarkersToSequence(project, clone, plan, cues, () => assertActiveContextKey(cloneContextKey));
    const items = await allVideoItems(clone, "video");
    const actions: ActionFactory[] = [];
    const warnings: string[] = [];
    let punchedClips = 0;
    let skippedClips = 0;
    for (const item of items.slice(0, 500)) {
      try {
        const result = await buildPunchInActions(item, cues);
        actions.push(...result.actions);
        if (result.changed) punchedClips += 1;
        else if (result.warning) skippedClips += 1;
        if (result.warning) warnings.push(result.warning);
      } catch (error) {
        skippedClips += 1;
        warnings.push(`펀치인 적용 실패: ${errorMessage(error)}`);
      }
    }
    const applicabilityWarning = punchApplicabilityWarning(cues.length, items.length, punchedClips);
    if (applicabilityWarning) warnings.unshift(applicabilityWarning);
    await assertActiveContextKey(cloneContextKey);
    if (actions.length > 0 && !commitActionFactories(project, actions, "ShortFlow: 비파괴 펀치인 적용")) {
      warnings.push("펀치인 키프레임 트랜잭션이 거부되어 추천 마커만 유지했습니다.");
      punchedClips = 0;
    }
    if (plan.cuts.length > 0) {
      warnings.unshift("Premiere 공개 UXP API에는 시간 지점 Razor 액션이 없어 무음 구간은 복제 시퀀스의 SF CUT 검토 마커로 남겼습니다.");
    }
    return {
      ...markerResult,
      sequenceName,
      punchedClips,
      skippedClips,
      warnings: [...new Set(warnings)].slice(0, 30),
    };
  } catch (error) {
    try {
      await removeKnownClonedSequenceFromProject(project, source, clone);
    } catch (cleanupError) {
      throw new ShortFlowError(
        "AUTOMATION_CLONE_CLEANUP_FAILED",
        `자동 편집 실패 후 복제 시퀀스를 정리하지 못했습니다. 원래 오류: ${errorMessage(error)} · 정리 오류: ${errorMessage(cleanupError)}`,
      );
    }
    throw error;
  }
}

export function translateSafeZonePosition(
  value: unknown,
  deltaX: number,
  deltaY: number,
  frameWidth: number,
  frameHeight: number,
): SafeZoneTranslatedPoint | null {
  if (
    !value || typeof value !== "object" ||
    typeof deltaX !== "number" || !Number.isFinite(deltaX) ||
    typeof deltaY !== "number" || !Number.isFinite(deltaY) ||
    !Number.isFinite(frameWidth) || frameWidth <= 0 || !Number.isFinite(frameHeight) || frameHeight <= 0
  ) return null;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.x !== "number" || !Number.isFinite(candidate.x) || typeof candidate.y !== "number" || !Number.isFinite(candidate.y)) {
    return null;
  }
  const x = candidate.x;
  const y = candidate.y;
  const inUnitSquare = x >= 0 && x <= 1 && y >= 0 && y <= 1;
  const hasFraction = Math.abs(x - Math.round(x)) > 1e-9 || Math.abs(y - Math.round(y)) > 1e-9;
  if (inUnitSquare && !hasFraction) return null;
  const space = inUnitSquare ? "normalized" : "pixels";
  const nextX = x + (space === "normalized" ? deltaX : deltaX * frameWidth);
  const nextY = y + (space === "normalized" ? deltaY : deltaY * frameHeight);
  if (!Number.isFinite(nextX) || !Number.isFinite(nextY) || Math.abs(nextX) > frameWidth * 10 || Math.abs(nextY) > frameHeight * 10) {
    return null;
  }
  return { x: nextX, y: nextY, space };
}

export async function buildSafeZoneItemAlignmentActions(
  item: VideoClipTrackItem,
  alignment: SafeZoneAlignment,
  frame: { width: number; height: number },
  pointFactory: (x: number, y: number) => PointF = (x, y) => ppro.PointF(x, y),
): Promise<{ actions: ActionFactory[]; changed: boolean; warning?: string }> {
  const moveNeeded = Math.abs(alignment.deltaX) > 1e-9 || Math.abs(alignment.deltaY) > 1e-9;
  const scaleNeeded = alignment.scale < 1 - 1e-9;
  if (!moveNeeded && !scaleNeeded) return { actions: [], changed: false };
  try {
    if (typeof item.isAdjustmentLayer === "function" && await item.isAdjustmentLayer()) {
      return { actions: [], changed: false, warning: "조정 레이어는 Safe Zone 정렬에서 보존했습니다." };
    }
    const component = await findMotionComponent(item);
    if (!component) return { actions: [], changed: false, warning: "Motion 속성이 없는 선택 항목을 건너뛰었습니다." };
    const params = await motionParams(component);
    if (moveNeeded && !params.position) return { actions: [], changed: false, warning: "Motion 위치 속성이 없는 선택 항목을 건너뛰었습니다." };
    if (scaleNeeded && !params.scale) return { actions: [], changed: false, warning: "Motion 스케일 속성이 없는 선택 항목을 건너뛰었습니다." };
    if (moveNeeded && params.position?.isTimeVarying()) {
      return { actions: [], changed: false, warning: "기존 위치 키프레임이 있는 선택 항목은 보존했습니다." };
    }
    if (scaleNeeded && params.scale?.isTimeVarying()) {
      return { actions: [], changed: false, warning: "기존 스케일 키프레임이 있는 선택 항목은 보존했습니다." };
    }

    let nextPosition: SafeZoneTranslatedPoint | null = null;
    let nextScale = 0;
    if (moveNeeded && params.position) {
      nextPosition = translateSafeZonePosition(
        keyframeValue(await params.position.getStartValue()),
        alignment.deltaX,
        alignment.deltaY,
        frame.width,
        frame.height,
      );
      if (!nextPosition) return { actions: [], changed: false, warning: "Motion 위치 좌표 공간을 안전하게 판별하지 못해 선택 항목을 보존했습니다." };
    }
    if (scaleNeeded && params.scale) {
      const currentScale = keyframeValue(await params.scale.getStartValue());
      if (typeof currentScale !== "number" || !Number.isFinite(currentScale) || currentScale <= 0) {
        return { actions: [], changed: false, warning: "Motion 스케일 값을 안전하게 읽지 못해 선택 항목을 보존했습니다." };
      }
      nextScale = currentScale * alignment.scale;
      if (!Number.isFinite(nextScale) || nextScale <= 0) {
        return { actions: [], changed: false, warning: "Safe Zone 비례 축소 결과가 올바르지 않아 선택 항목을 보존했습니다." };
      }
    }

    const actions: ActionFactory[] = [];
    if (nextPosition && params.position) {
      actions.push(() => {
        const keyframe = params.position!.createKeyframe(pointFactory(nextPosition.x, nextPosition.y));
        return params.position!.createSetValueAction(keyframe, true);
      });
    }
    if (scaleNeeded && params.scale) {
      actions.push(() => {
        const keyframe = params.scale!.createKeyframe(nextScale);
        return params.scale!.createSetValueAction(keyframe, true);
      });
    }
    return { actions, changed: actions.length > 0 };
  } catch (error) {
    return { actions: [], changed: false, warning: `Motion 속성을 안전하게 읽지 못해 선택 항목을 보존했습니다: ${errorMessage(error)}` };
  }
}

/** Applies one relative delta and optional proportional scale in a single public UXP transaction. */
export async function alignSelectedVideoToSafeZone(
  input: SafeZoneAlignment,
  platform: SocialPlatform,
  role: "content" | "caption",
  customMargins?: Partial<SafeZoneMargins>,
): Promise<SafeZoneAlignResult> {
  let alignment: SafeZoneAlignment;
  try {
    alignment = assertSafeZoneAlignment(input, platform, role, customMargins);
  } catch (error) {
    throw new ShortFlowError("INVALID_SAFE_ZONE", errorMessage(error));
  }
  const { project, sequence, contextKey } = await getExpectedActiveContext();
  const selection = await readSelectionRange(sequence);
  const items = selection.items.filter(isVideoTrackItem).slice(0, 100);
  if (items.length === 0) {
    throw new ShortFlowError("NO_SELECTED_VIDEO", "Safe Zone에 정렬할 비디오 또는 그래픽 항목을 타임라인에서 선택해 주세요.");
  }
  const frame = await sequence.getFrameSize();
  if (!Number.isFinite(Number(frame.width)) || Number(frame.width) <= 0 || !Number.isFinite(Number(frame.height)) || Number(frame.height) <= 0) {
    throw new ShortFlowError("INVALID_FRAME_SIZE", "Safe Zone 정렬에 필요한 시퀀스 프레임 크기를 읽지 못했습니다.");
  }
  const actions: ActionFactory[] = [];
  const warnings: string[] = [];
  let changed = 0;
  let skipped = 0;
  for (const item of items) {
    const result = await buildSafeZoneItemAlignmentActions(item, alignment, {
      width: Number(frame.width),
      height: Number(frame.height),
    });
    actions.push(...result.actions);
    if (result.changed) changed += 1;
    else if (result.warning) {
      skipped += 1;
      warnings.push(result.warning);
    }
  }
  if (actions.length === 0) {
    return { selected: items.length, changed: 0, skipped, warnings: [...new Set(warnings)].slice(0, 20) };
  }
  await assertActiveContextKey(contextKey);
  if (!commitActionFactories(project, actions, "ShortFlow: Safe Zone 자동 정렬")) {
    throw new ShortFlowError("SAFE_ZONE_COMMIT_FAILED", "Safe Zone 위치 변경을 적용하지 못했습니다.");
  }
  return { selected: items.length, changed, skipped, warnings: [...new Set(warnings)].slice(0, 20) };
}

function unwrapPickerResult(result: any): any | null {
  return Array.isArray(result) ? result[0] ?? null : result ?? null;
}

async function persistEntry(entry: any): Promise<PersistentEntryResult> {
  const token = await uxp.storage.localFileSystem.createPersistentToken(entry);
  return {
    entry,
    token,
    name: String(entry.name ?? ""),
    nativePath: String(entry.nativePath ?? ""),
  };
}

export async function choosePersistentFile(types: string[]): Promise<PersistentEntryResult | null> {
  const result = unwrapPickerResult(await uxp.storage.localFileSystem.getFileForOpening({
    types,
    allowMultiple: false,
  }));
  return result ? persistEntry(result) : null;
}

export async function choosePersistentFolder(): Promise<PersistentEntryResult | null> {
  const result = await uxp.storage.localFileSystem.getFolder();
  return result ? persistEntry(result) : null;
}

export async function restorePersistentEntry(token: string): Promise<any | null> {
  if (!token) return null;
  try {
    return await uxp.storage.localFileSystem.getEntryForPersistentToken(token);
  } catch {
    return null;
  }
}

export async function insertMogrt(mogrtFile: any, trackNumber: number): Promise<number> {
  if (!mogrtFile?.nativePath) {
    throw new ShortFlowError("NO_MOGRT", "삽입할 MOGRT 파일을 먼저 선택해 주세요.");
  }
  const mogrtPath = String(mogrtFile.nativePath).trim();
  if (!/\.mogrt$/iu.test(mogrtPath)) {
    throw new ShortFlowError("INVALID_MOGRT", "선택한 파일이 .mogrt 모션 그래픽 템플릿이 아닙니다.");
  }
  const videoTrackIndex = zeroBasedTrackIndex(trackNumber, true);
  const { project, sequence } = await getActiveContext();
  const editor = ppro.SequenceEditor.getEditor(sequence);
  const position = await sequence.getPlayerPosition();
  let inserted: ReturnType<typeof editor.insertMogrtFromPath> = [];
  try {
    // Adobe's official sample performs the synchronous MOGRT insertion under lockedAccess,
    // without wrapping it in executeTransaction (this API does not return an Action).
    project.lockedAccess(() => {
      inserted = editor.insertMogrtFromPath(
        mogrtPath,
        position,
        videoTrackIndex,
        0,
      ) ?? [];
    });
  } catch (error) {
    throw new ShortFlowError(
      "MOGRT_INSERT_FAILED",
      `MOGRT 삽입 중 Premiere Pro 오류가 발생했습니다: ${errorMessage(error)}`,
    );
  }
  if (inserted.length === 0) {
    throw new ShortFlowError("MOGRT_INSERT_FAILED", "MOGRT를 현재 재생 위치에 삽입하지 못했습니다.");
  }
  return inserted.length;
}

export function joinNativePath(folderPath: string, filename: string): string {
  const rawFolder = folderPath.trim();
  const separator = rawFolder.includes("\\") ? "\\" : "/";
  const cleanFolder = /^[\\/]+$/u.test(rawFolder)
    ? separator
    : rawFolder.replace(/[\\/]+$/u, "");
  const cleanFilename = filename.trim().replace(/^[\\/]+/u, "");
  if (
    !cleanFolder ||
    !cleanFilename ||
    cleanFilename === "." ||
    cleanFilename === ".." ||
    /[\\/:\u0000-\u001f\u007f]/u.test(cleanFilename)
  ) {
    throw new ShortFlowError("INVALID_OUTPUT_PATH", "출력 폴더와 파일 이름이 필요합니다.");
  }
  return cleanFolder.endsWith(separator)
    ? `${cleanFolder}${cleanFilename}`
    : `${cleanFolder}${separator}${cleanFilename}`;
}

export function exportTimestamp(now = new Date()): string {
  const values = [
    now.getFullYear(),
    now.getMonth() + 1,
    now.getDate(),
    now.getHours(),
    now.getMinutes(),
    now.getSeconds(),
  ];
  return values.map((value, index) => index === 0 ? String(value) : String(value).padStart(2, "0"))
    .join("")
    .replace(/^(\d{8})(\d{6})$/u, "$1-$2");
}

export function buildExportFilename(
  sequenceName: unknown,
  extension: unknown,
  now = new Date(),
): string {
  const safeExtension = normalizeExportExtension(extension);
  const safeSequenceName = sanitizeFileName(String(sequenceName ?? "ShortFlow_Export"));
  return sanitizeFileName(`${safeSequenceName}_${exportTimestamp(now)}.${safeExtension}`);
}

export async function exportVideo(options: ExportVideoOptions): Promise<string> {
  if (!options.presetFile?.nativePath) {
    throw new ShortFlowError("NO_EXPORT_PRESET", "Adobe Media Encoder .epr 프리셋을 선택해 주세요.");
  }
  if (!options.outputFolder?.nativePath) {
    throw new ShortFlowError("NO_OUTPUT_FOLDER", "내보내기 폴더를 선택해 주세요.");
  }
  const { sequence } = await getActiveContext();
  const presetPath = String(options.presetFile.nativePath).trim();
  if (!/\.epr$/iu.test(presetPath)) {
    throw new ShortFlowError("INVALID_EXPORT_PRESET", "선택한 파일이 Adobe Media Encoder .epr 프리셋이 아닙니다.");
  }
  const extensionRaw = String(await ppro.EncoderManager.getExportFileExtension(sequence, presetPath) || "mp4");
  const filename = buildExportFilename(sequence.name, extensionRaw);
  const outputPath = joinNativePath(String(options.outputFolder.nativePath), filename);
  const manager = ppro.EncoderManager.getManager();
  if (!manager) {
    throw new ShortFlowError("ENCODER_UNAVAILABLE", "Adobe Media Encoder 관리자를 사용할 수 없습니다.");
  }
  if (options.mode === "queue" && manager.isAMEInstalled === false) {
    throw new ShortFlowError("AME_NOT_INSTALLED", "대기열 내보내기를 위해 Adobe Media Encoder를 설치해 주세요.");
  }
  const exportType = options.mode === "queue"
    ? ppro.Constants.ExportType.QUEUE_TO_AME
    : ppro.Constants.ExportType.IMMEDIATELY;
  const success = await manager.exportSequence(
    sequence,
    exportType,
    outputPath,
    presetPath,
    options.range === "entire",
  );
  if (!success) {
    throw new ShortFlowError("EXPORT_FAILED", "영상 내보내기 요청이 거부되었습니다. 프리셋과 출력 경로를 확인해 주세요.");
  }
  return outputPath;
}

export async function exportCover(outputFolder: any): Promise<string> {
  if (!outputFolder?.nativePath) {
    throw new ShortFlowError("NO_OUTPUT_FOLDER", "커버 이미지를 저장할 폴더를 선택해 주세요.");
  }
  const { sequence } = await getActiveContext();
  const position = await sequence.getPlayerPosition();
  const frame = await sequence.getFrameSize();
  const width = Math.round(Number(frame.width));
  const height = Math.round(Number(frame.height));
  if (!(width > 0) || !(height > 0)) {
    throw new ShortFlowError("INVALID_FRAME_SIZE", "현재 시퀀스의 프레임 크기를 확인하지 못했습니다.");
  }
  const filename = sanitizeFileName(`${sequence.name}_cover_${exportTimestamp()}.png`);
  const folderPath = String(outputFolder.nativePath);
  const success = await ppro.Exporter.exportSequenceFrame(
    sequence,
    position,
    filename,
    folderPath,
    width,
    height,
  );
  if (!success) {
    throw new ShortFlowError("COVER_EXPORT_FAILED", "현재 프레임 커버 이미지를 저장하지 못했습니다.");
  }
  return joinNativePath(folderPath, filename);
}

async function findImportedItem(
  bin: FolderItem,
  nativePath: string,
  beforeIds: ReadonlySet<string>,
): Promise<ProjectItem | null> {
  const items = await bin.getItems();
  let existingMatch: ProjectItem | null = null;
  for (const item of items) {
    try {
      const itemId = String(item.getId());
      const clip = ppro.ClipProjectItem.cast(item);
      const path = clip ? String(await clip.getMediaFilePath()) : "";
      if (!sameMediaPath(path, nativePath)) continue;
      if (!itemId || !beforeIds.has(itemId)) return item;
      existingMatch ??= item;
    } catch {
      // Bins and non-clip project items are intentionally ignored.
    }
  }
  return existingMatch;
}

async function getProjectImportBin(project: Project): Promise<{
  bin: FolderItem;
  targetBin: ProjectItem;
}> {
  try {
    const insertionItem = await project.getInsertionBin();
    const bin = ppro.FolderItem.cast(insertionItem);
    if (!bin || typeof bin.getItems !== "function") throw new Error("Insertion bin is unavailable.");
    return {
      bin,
      targetBin: insertionItem,
    };
  } catch {
    const root = await project.getRootItem();
    const bin = root;
    const targetBin = ppro.ProjectItem.cast(root);
    if (!bin || typeof bin.getItems !== "function" || !targetBin) {
      throw new ShortFlowError("PROJECT_BIN_UNAVAILABLE", "활성 프로젝트의 가져오기 bin을 확인하지 못했습니다.");
    }
    return { bin, targetBin };
  }
}

/** Imports generated files (notably SRT) into the active project bin only. */
export async function importFilesToProject(
  paths: readonly string[],
  expectedContext?: string,
): Promise<number> {
  if (!Array.isArray(paths)) {
    throw new ShortFlowError("NO_IMPORT_PATHS", "프로젝트로 가져올 파일 경로 배열이 필요합니다.");
  }
  const uniquePaths: string[] = [];
  const seen = new Set<string>();
  for (const value of paths) {
    const path = validatePremiereImportPath(value);
    const normalized = normalizePremierePath(path);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    uniquePaths.push(path);
  }
  if (uniquePaths.length === 0) {
    throw new ShortFlowError("NO_IMPORT_PATHS", "프로젝트로 가져올 유효한 파일 경로가 없습니다.");
  }
  if (uniquePaths.length > 100) {
    throw new ShortFlowError("TOO_MANY_IMPORTS", "한 번에 최대 100개 파일까지 프로젝트로 가져올 수 있습니다.");
  }

  const { project, contextKey } = await getExpectedActiveContext(expectedContext);
  const { bin, targetBin } = await getProjectImportBin(project);
  const pendingPaths: string[] = [];
  for (const path of uniquePaths) {
    const existing = await findImportedItem(bin, path, new Set<string>());
    if (!existing) pendingPaths.push(path);
  }
  if (pendingPaths.length === 0) return 0;
  await assertActiveContextKey(contextKey);
  const imported = await project.importFiles(pendingPaths, true, targetBin, false);
  if (!imported) {
    throw new ShortFlowError(
      "PROJECT_IMPORT_FAILED",
      "생성된 파일을 활성 프로젝트 bin으로 가져오지 못했습니다.",
    );
  }
  return pendingPaths.length;
}

export async function importAndInsertAsset(
  nativePath: string,
  options: InsertAssetOptions,
): Promise<void> {
  const preflight = prepareInsertAssetPreflight(nativePath, options);
  const { assetPath, videoTrackIndex, audioTrackIndex } = preflight;
  const duration = preflight.durationSeconds;
  const { project, sequence, contextKey } = await getExpectedActiveContext(preflight.expectedContextKey);
  const { bin, targetBin } = await getProjectImportBin(project);
  const beforeItems = await bin.getItems();
  const beforeIds = new Set<string>();
  for (const item of beforeItems) {
    beforeIds.add(String(item.getId()));
  }
  let projectItem = await findImportedItem(bin, assetPath, new Set<string>());
  if (!projectItem) {
    await assertActiveContextKey(contextKey);
    const imported = await project.importFiles([assetPath], true, targetBin, false);
    if (!imported) {
      throw new ShortFlowError("ASSET_IMPORT_FAILED", `${preflight.displayName} 파일을 프로젝트로 가져오지 못했습니다.`);
    }
    for (let attempt = 0; attempt < 10 && !projectItem; attempt += 1) {
      if (attempt > 0) await wait(50);
      projectItem = await findImportedItem(bin, assetPath, beforeIds);
    }
  }
  if (!projectItem) {
    throw new ShortFlowError("IMPORTED_ITEM_NOT_FOUND", "가져온 자산의 프로젝트 아이템을 찾지 못했습니다.");
  }
  await assertActiveContextKey(contextKey);
  const editor = ppro.SequenceEditor.getEditor(sequence);
  const insertionTime = await sequence.getPlayerPosition();
  let audioDuration: number | undefined;
  if (isAudioInsertAssetPath(assetPath)) {
    let clipProjectItem: ReturnType<typeof ppro.ClipProjectItem.cast>;
    let audioMediaType: typeof ppro.Constants.MediaType.AUDIO;
    try {
      clipProjectItem = ppro.ClipProjectItem.cast(projectItem);
      audioMediaType = ppro.Constants.MediaType.AUDIO;
    } catch {
      throw new ShortFlowError(
        "ASSET_AUDIO_DURATION_UNAVAILABLE",
        "가져온 오디오의 공개 Premiere API를 확인하지 못해 타임라인 삽입을 중단했습니다.",
      );
    }
    if (!clipProjectItem) {
      throw new ShortFlowError(
        "ASSET_AUDIO_DURATION_UNAVAILABLE",
        "가져온 파일을 오디오 프로젝트 항목으로 확인하지 못해 타임라인 삽입을 중단했습니다.",
      );
    }
    if (audioMediaType === undefined || audioMediaType === null) {
      throw new ShortFlowError(
        "ASSET_AUDIO_DURATION_UNAVAILABLE",
        "Premiere의 공개 오디오 미디어 형식 상수를 확인하지 못해 타임라인 삽입을 중단했습니다.",
      );
    }
    audioDuration = await audioProjectItemDurationSeconds(clipProjectItem, audioMediaType);
  }
  await commitTimelineInsertAfterPreflight(
    async () => {
      if (audioDuration !== undefined) {
        await assertAudioInsertRangeAvailable(
          sequence,
          audioTrackIndex,
          insertionTime,
          audioDuration,
          premiereClipTrackItemType(),
        );
      }
      await assertActiveContextKey(contextKey);
    },
    () => commitActionFactories(
      project,
      [() => editor.createInsertProjectItemAction(projectItem, insertionTime, videoTrackIndex, audioTrackIndex, true)],
      "ShortFlow: 음악/효과음 삽입",
    ),
  );
  if (duration !== undefined) {
    const insertedAt = tickTimeSeconds(insertionTime, 0);
    const projectItemId = String(projectItem.getId());
    let insertedItem: VideoClipTrackItem | null = null;
    for (let attempt = 0; attempt < 10 && !insertedItem; attempt += 1) {
      if (attempt > 0) await wait(50);
      const track = await sequence.getVideoTrack(videoTrackIndex);
      if (!track) continue;
      const candidates = (await getClipTrackItems(track)).filter(isVideoTrackItem);
      for (const candidate of candidates) {
        const start = tickTimeSeconds(await candidate.getStartTime(), Number.NaN);
        const candidateProjectItem = await candidate.getProjectItem();
        if (Math.abs(start - insertedAt) <= 0.05 && String(candidateProjectItem?.getId?.() ?? "") === projectItemId) {
          insertedItem = candidate;
          break;
        }
      }
    }
    if (!insertedItem) {
      throw new ShortFlowError("INSERTED_GUIDE_NOT_FOUND", "삽입된 가이드 항목을 찾지 못해 길이를 설정하지 못했습니다.");
    }
    await assertActiveContextKey(contextKey);
    if (!commitActionFactories(
      project,
      [() => insertedItem.createSetEndAction(ppro.TickTime.createWithSeconds(insertedAt + duration))],
      "ShortFlow: 가이드 오버레이 길이 설정",
    )) {
      throw new ShortFlowError("GUIDE_DURATION_FAILED", "가이드 오버레이 길이를 설정하지 못했습니다.");
    }
  }
}

export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "알 수 없는 오류");
  return raw
    .replace(/(authorization\s*[:=]\s*)bearer\s+[^\s,;"'}]+/giu, "$1Bearer [REDACTED]")
    .replace(/\bbearer\s+[a-z0-9._~+/-]{8,}/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk|sess)-[a-z0-9_-]{8,}\b/giu, "[REDACTED]")
    .replace(/("?(?:api[_-]?key|password|secret|token)"?\s*[:=]\s*["']?)[^\s,"'}]+/giu, "$1[REDACTED]")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .trim()
    .slice(0, 2_000);
}
