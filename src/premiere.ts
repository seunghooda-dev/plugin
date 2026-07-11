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
import type { PunchCue, SilenceCutPlan } from "./automation";
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
  /** Optional still-image duration in seconds, used for removable guide overlays. */
  durationSeconds?: number;
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
  onClonePrepared?: (details: {
    sourceGuid: string;
    cloneGuid: string;
    sequenceName: string;
  }) => void | Promise<void>;
}

export interface SafeZoneAlignResult {
  selected: number;
  changed: number;
  skipped: number;
  warnings: string[];
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

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function commitActions(project: Project, actions: readonly Action[], undoLabel: string): boolean {
  if (actions.length === 0) {
    return true;
  }
  if (actions.some((action) => !action)) {
    return false;
  }
  let committed = false;
  let allAdded = true;
  try {
    project.lockedAccess(() => {
      committed = project.executeTransaction((compoundAction) => {
        for (const action of actions) {
          if (compoundAction.addAction(action) === false) {
            allAdded = false;
            throw new Error("Premiere rejected an action in the compound transaction.");
          }
        }
      }, undoLabel);
    });
  } catch {
    return false;
  }
  return Boolean(committed && allAdded);
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
  return {
    hostVersion: String(uxp.host?.version ?? "unknown"),
    uxpVersion: String(uxp.versions?.uxp ?? uxp.version ?? "unknown"),
  };
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

export async function setSequencePlayerPosition(seconds: number): Promise<void> {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86_400) {
    throw new ShortFlowError("INVALID_PLAYHEAD", "이동할 재생 위치가 올바르지 않습니다.");
  }
  const { sequence } = await getActiveContext();
  const moved = await sequence.setPlayerPosition(ppro.TickTime.createWithSeconds(seconds));
  if (!moved) throw new ShortFlowError("PLAYHEAD_MOVE_FAILED", "Premiere 재생 헤드를 이동하지 못했습니다.");
}

export async function removeVerifiedClonedSequence(sourceGuid: string, cloneGuid: string): Promise<void> {
  const sourceKey = sourceGuid.trim();
  const cloneKey = cloneGuid.trim();
  if (!sourceKey || !cloneKey || sourceKey === cloneKey) {
    throw new ShortFlowError("INVALID_CLONE_ID", "원본과 복제 시퀀스 식별자가 올바르지 않습니다.");
  }
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new ShortFlowError("NO_ACTIVE_PROJECT", "활성 Premiere Pro 프로젝트가 없습니다.");
  const sequences = await project.getSequences();
  const source = sequences.find((sequence) => guidKey(sequence.guid) === sourceKey);
  const clone = sequences.find((sequence) => guidKey(sequence.guid) === cloneKey);
  if (!source) throw new ShortFlowError("SOURCE_SEQUENCE_NOT_FOUND", "보존된 원본 시퀀스를 찾지 못했습니다.");
  if (!clone) return;
  await project.setActiveSequence(source);
  const item = await clone.getProjectItem();
  const parent = item.getParentBin();
  const action = parent.createRemoveItemAction(item);
  if (!commitActions(project, [action], "ShortFlow: 실패한 복제 시퀀스 제거")) {
    throw new ShortFlowError("CLONE_REMOVE_FAILED", "실패한 복제 시퀀스를 제거하지 못했습니다.");
  }
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

async function readSelectionRange(sequence: Sequence): Promise<{
  count: number;
  videoCount: number;
  start: number | null;
  end: number | null;
  items: Array<VideoClipTrackItem | AudioClipTrackItem>;
}> {
  try {
    const selection = await sequence.getSelection();
    const items = selection ? await selection.getTrackItems() : [];
    let start = Number.POSITIVE_INFINITY;
    let end = Number.NEGATIVE_INFINITY;
    let videoCount = 0;
    for (const item of items) {
      if (isVideoTrackItem(item)) {
        videoCount += 1;
      }
      if (typeof item?.getStartTime === "function" && typeof item?.getEndTime === "function") {
        const itemStart = tickTimeSeconds(await item.getStartTime(), Number.NaN);
        const itemEnd = tickTimeSeconds(await item.getEndTime(), Number.NaN);
        if (Number.isFinite(itemStart)) start = Math.min(start, itemStart);
        if (Number.isFinite(itemEnd)) end = Math.max(end, itemEnd);
      }
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

export async function readSequenceStatus(context?: PremiereContext): Promise<SequenceStatus> {
  const { project, sequence } = context ?? await getActiveContext();
  const frame = await sequence.getFrameSize();
  const sequenceEnd = await safeTime(sequence, "getEndTime", 0);
  const inPoint = await safeTime(sequence, "getInPoint", 0);
  const outPoint = await safeTime(sequence, "getOutPoint", sequenceEnd);
  const playerPosition = await safeTime(sequence, "getPlayerPosition", 0);
  const selection = await readSelectionRange(sequence);
  const effective = resolveTimeRange({
    mode: "inout",
    sequenceEnd,
    inPoint,
    outPoint,
  });
  const videoTrackCount = Number(await sequence.getVideoTrackCount()) || 0;
  const audioTrackCount = Number(await sequence.getAudioTrackCount()) || 0;
  const captionTrackCount = Number(await sequence.getCaptionTrackCount()) || 0;
  let frameRate = 0;
  try {
    frameRate = Number((await sequence.getSettings()).getVideoFrameRate().value) || 0;
  } catch {
    frameRate = 0;
  }

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

/** Scans timeline-backed project items without exposing native media paths. */
export async function scanSequenceMediaQC(maximumItems = 10_000): Promise<SequenceMediaQCStatus> {
  const { sequence } = await getActiveContext();
  const limit = Math.min(10_000, Math.max(1, Math.round(maximumItems)));
  const offlineMedia = new Set<string>();
  const guideOverlays = new Set<string>();
  const seenProjectItems = new Set<string>();
  let scannedItems = 0;
  let truncated = false;

  const inspect = async (item: VideoClipTrackItem | AudioClipTrackItem): Promise<void> => {
    if (scannedItems >= limit) {
      truncated = true;
      return;
    }
    scannedItems += 1;
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

  const videoTracks = Number(await sequence.getVideoTrackCount()) || 0;
  for (let index = 0; index < videoTracks && !truncated; index += 1) {
    const track = await sequence.getVideoTrack(index);
    const items = track?.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) ?? [];
    for (const item of items) {
      await inspect(item);
      if (truncated) break;
    }
  }
  const audioTracks = Number(await sequence.getAudioTrackCount()) || 0;
  for (let index = 0; index < audioTracks && !truncated; index += 1) {
    const track = await sequence.getAudioTrack(index);
    const items = track?.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) ?? [];
    for (const item of items) {
      await inspect(item);
      if (truncated) break;
    }
  }
  return {
    offlineMedia: [...offlineMedia],
    guideOverlays: [...guideOverlays],
    scannedItems,
    truncated,
  };
}

export async function runSequenceQC(
  expectedWidth: number,
  expectedHeight: number,
  maxDuration: number,
): Promise<{ status: SequenceStatus; items: QCItem[] }> {
  const status = await readSequenceStatus();
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
  if (!commitActions(project, [projectItem.createSetNameAction(name)], "ShortFlow: 시퀀스 이름 변경")) {
    throw new ShortFlowError("RENAME_FAILED", "복제된 시퀀스의 이름을 변경하지 못했습니다.");
  }
  return name;
}

async function cloneSequence(project: Project, source: Sequence, name: string): Promise<Sequence> {
  const before = await project.getSequences();
  const beforeGuids = new Set(before.map((sequence) => guidKey(sequence.guid)));
  if (!commitActions(project, [source.createCloneAction()], "ShortFlow: 원본 시퀀스 복제")) {
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

  await renameSequence(project, clone, name);
  // openSequence may report false when the clone is already open; activation is authoritative.
  await project.openSequence(clone);
  if (!await project.setActiveSequence(clone)) {
    throw new ShortFlowError("ACTIVATE_CLONE_FAILED", "복제된 시퀀스를 활성화하지 못했습니다.");
  }
  return clone;
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

  if (!commitActions(project, [sequence.createSetSettingsAction(settings)], "ShortFlow: 숏폼 프레임 설정")) {
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
  if (!commitActions(
    project,
    [sequence.createSetInPointAction(start), sequence.createSetOutPointAction(end)],
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
    const trackItems = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
    items.push(...trackItems);
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
): Promise<{ actions: Action[]; warning?: string }> {
  if (typeof item.isAdjustmentLayer === "function" && await item.isAdjustmentLayer()) {
    return { actions: [], warning: "조정 레이어는 건너뛰었습니다." };
  }
  const component = await findMotionComponent(item);
  if (!component) {
    return { actions: [], warning: "Motion 구성 요소를 찾지 못한 클립을 건너뛰었습니다." };
  }
  const params = await motionParams(component);
  const actions: Action[] = [];
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
        const keyframe = params.scale.createKeyframe(nextScale);
        actions.push(params.scale.createSetValueAction(keyframe, true));
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
        const point: PointF = ppro.PointF(centered.x, centered.y);
        const keyframe = params.position.createKeyframe(point);
        actions.push(params.position.createSetValueAction(keyframe, true));
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
  const actions: Action[] = [];
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
  if (actions.length > 0 && !commitActions(project, actions, "ShortFlow: 클립 리프레임")) {
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
  const actions: Action[] = [];
  const commentMarkerType = ppro.Marker.MARKER_TYPE_COMMENT;
  const hookDuration = Math.min(Math.max(0, hookSeconds), range.duration);
  const ctaDuration = Math.min(Math.max(0, ctaSeconds), range.duration);
  if (hookDuration > 0) {
    actions.push(markerCollection.createAddMarkerAction(
      "HOOK",
      commentMarkerType,
      ppro.TickTime.createWithSeconds(range.start),
      ppro.TickTime.createWithSeconds(hookDuration),
      "첫 1~3초 안에 시선을 끄는 핵심 장면/문장을 배치하세요.",
    ));
  }
  if (ctaDuration > 0) {
    actions.push(markerCollection.createAddMarkerAction(
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
  if (!commitActions(project, actions, "ShortFlow: HOOK/CTA 마커 추가")) {
    throw new ShortFlowError("MARKER_COMMIT_FAILED", "스토리 마커를 추가하지 못했습니다.");
  }
  return actions.length;
}

function assertAutomationPlan(plan: SilenceCutPlan, cues: readonly PunchCue[]): void {
  if (!plan || !Array.isArray(plan.cuts) || !Array.isArray(cues)) {
    throw new ShortFlowError("INVALID_AUTOMATION_PLAN", "자동 편집안 데이터가 올바르지 않습니다.");
  }
  if (plan.cuts.length + cues.length > 500) {
    throw new ShortFlowError("TOO_MANY_AUTOMATION_MARKERS", "자동 편집 마커는 한 번에 최대 500개까지 추가할 수 있습니다.");
  }
}

async function addAutomationMarkersToSequence(
  project: Project,
  sequence: Sequence,
  plan: SilenceCutPlan,
  cues: readonly PunchCue[],
): Promise<AutomationMarkerResult> {
  assertAutomationPlan(plan, cues);
  const markerCollection = await ppro.Markers.getMarkers(sequence);
  const markerType = ppro.Marker.MARKER_TYPE_COMMENT;
  const actions: Action[] = [];
  for (const [index, cut] of plan.cuts.entries()) {
    if (!Number.isFinite(cut.start) || !Number.isFinite(cut.duration) || cut.duration <= 0) continue;
    actions.push(markerCollection.createAddMarkerAction(
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
    actions.push(markerCollection.createAddMarkerAction(
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
  if (!commitActions(project, actions, "ShortFlow: 자동 컷/펀치인 추천 마커")) {
    throw new ShortFlowError("AUTOMATION_MARKER_COMMIT_FAILED", "자동 편집 추천 마커를 추가하지 못했습니다.");
  }
  return { cutMarkers, punchMarkers: actions.length - cutMarkers };
}

/** Adds review markers only; it never changes clips or source media. */
export async function addAutomationMarkers(
  plan: SilenceCutPlan,
  cues: readonly PunchCue[],
): Promise<AutomationMarkerResult> {
  const { project, sequence } = await getActiveContext();
  return addAutomationMarkersToSequence(project, sequence, plan, cues);
}

async function buildPunchInActions(
  item: VideoClipTrackItem,
  cues: readonly PunchCue[],
): Promise<{ actions: Action[]; changed: boolean; warning?: string }> {
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
  const clipDuration = itemEnd - itemStart;
  const keyframes = new Map<number, number>();
  for (const cue of matching) {
    const localStart = Math.max(0, cue.start - itemStart);
    const localEnd = Math.min(clipDuration, cue.end - itemStart);
    if (localEnd <= localStart) continue;
    const transition = Math.min(0.1, Math.max(0.03, (localEnd - localStart) / 4));
    const zoomScale = startValue * Math.max(1.01, Math.min(1.5, cue.scale / 100));
    keyframes.set(Math.max(0, localStart - transition), startValue);
    keyframes.set(localStart, zoomScale);
    keyframes.set(localEnd, zoomScale);
    keyframes.set(Math.min(clipDuration, localEnd + transition), startValue);
  }
  if (keyframes.size === 0) return { actions: [], changed: false };
  const actions: Action[] = [scale.createSetTimeVaryingAction(true)];
  for (const [time, value] of [...keyframes.entries()].sort((left, right) => left[0] - right[0])) {
    const keyframe = scale.createKeyframe(value);
    keyframe.position = ppro.TickTime.createWithSeconds(time);
    actions.push(scale.createAddKeyframeAction(keyframe));
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
  const { project, sequence: source } = await getActiveContext();
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const clone = await cloneSequence(project, source, `${String(source.name ?? "Sequence")}_ShortFlow_Auto_${timestamp}`);
  const sequenceName = await renameSequence(project, clone, `${String(source.name ?? "Sequence")}_ShortFlow_Auto_${timestamp}`);
  await project.setActiveSequence(clone);
  await hooks.onClonePrepared?.({
    sourceGuid: guidKey(source.guid),
    cloneGuid: guidKey(clone.guid),
    sequenceName,
  });
  const markerResult = await addAutomationMarkersToSequence(project, clone, plan, cues);
  const items = await allVideoItems(clone, "video");
  const actions: Action[] = [];
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
  if (actions.length > 0 && !commitActions(project, actions, "ShortFlow: 비파괴 펀치인 적용")) {
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
}

/** Aligns the center of selected video/MOGRT items to a normalized safe-zone rectangle. */
export async function alignSelectedVideoToSafeZone(rect: {
  x: number;
  y: number;
  width: number;
  height: number;
}): Promise<SafeZoneAlignResult> {
  const values = [rect.x, rect.y, rect.width, rect.height];
  if (values.some((value) => !Number.isFinite(value)) || rect.width <= 0 || rect.height <= 0) {
    throw new ShortFlowError("INVALID_SAFE_ZONE", "Safe Zone 정렬 좌표가 올바르지 않습니다.");
  }
  const { project, sequence } = await getActiveContext();
  const selection = await readSelectionRange(sequence);
  const items = selection.items.filter(isVideoTrackItem).slice(0, 100);
  if (items.length === 0) {
    throw new ShortFlowError("NO_SELECTED_VIDEO", "Safe Zone에 정렬할 비디오 또는 그래픽 항목을 타임라인에서 선택해 주세요.");
  }
  const frame = await sequence.getFrameSize();
  const centerX = Math.min(1, Math.max(0, rect.x + rect.width / 2));
  const centerY = Math.min(1, Math.max(0, rect.y + rect.height / 2));
  const actions: Action[] = [];
  const warnings: string[] = [];
  let changed = 0;
  let skipped = 0;
  for (const item of items) {
    try {
      const motion = await findMotionComponent(item);
      const position = motion ? (await motionParams(motion)).position : null;
      if (!position) {
        skipped += 1;
        warnings.push("Motion 위치 속성이 없는 선택 항목을 건너뛰었습니다.");
        continue;
      }
      if (position.isTimeVarying()) {
        skipped += 1;
        warnings.push("기존 위치 키프레임이 있는 선택 항목은 보존했습니다.");
        continue;
      }
      const current = keyframeValue(await position.getStartValue());
      const normalized = Boolean(
        current
        && typeof current === "object"
        && "x" in current
        && "y" in current
        && Math.abs(Number((current as { x: unknown }).x)) <= 2
        && Math.abs(Number((current as { y: unknown }).y)) <= 2,
      );
      const point = normalized
        ? ppro.PointF(centerX, centerY)
        : ppro.PointF(centerX * Number(frame.width), centerY * Number(frame.height));
      actions.push(position.createSetValueAction(position.createKeyframe(point), true));
      changed += 1;
    } catch (error) {
      skipped += 1;
      warnings.push(`Safe Zone 정렬 실패: ${errorMessage(error)}`);
    }
  }
  if (actions.length === 0) {
    throw new ShortFlowError("SAFE_ZONE_NOT_APPLIED", warnings[0] ?? "정렬할 수 있는 선택 항목이 없습니다.");
  }
  if (!commitActions(project, actions, "ShortFlow: Safe Zone 자동 정렬")) {
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

function timestamp(): string {
  const now = new Date();
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
  const extension = normalizeExportExtension(extensionRaw);
  const filename = sanitizeFileName(`${sequence.name}_${timestamp()}.${extension}`);
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
  const filename = sanitizeFileName(`${sequence.name}_cover_${timestamp()}.png`);
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
    const itemId = String(item.getId());
    try {
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
    return {
      bin: ppro.FolderItem.cast(insertionItem),
      targetBin: insertionItem,
    };
  } catch {
    const bin = await project.getRootItem();
    return { bin, targetBin: ppro.ProjectItem.cast(bin) };
  }
}

/** Imports generated files (notably SRT) into the active project bin only. */
export async function importFilesToProject(paths: readonly string[]): Promise<number> {
  if (!Array.isArray(paths)) {
    throw new ShortFlowError("NO_IMPORT_PATHS", "프로젝트로 가져올 파일 경로 배열이 필요합니다.");
  }
  const uniquePaths: string[] = [];
  const seen = new Set<string>();
  for (const value of paths) {
    const path = typeof value === "string" ? value.trim() : "";
    const normalized = normalizePremierePath(path);
    if (!path || !normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    uniquePaths.push(path);
  }
  if (uniquePaths.length === 0) {
    throw new ShortFlowError("NO_IMPORT_PATHS", "프로젝트로 가져올 유효한 파일 경로가 없습니다.");
  }
  if (uniquePaths.length > 100) {
    throw new ShortFlowError("TOO_MANY_IMPORTS", "한 번에 최대 100개 파일까지 프로젝트로 가져올 수 있습니다.");
  }

  const project = await ppro.Project.getActiveProject();
  if (!project) {
    throw new ShortFlowError("NO_ACTIVE_PROJECT", "파일을 가져올 활성 Premiere Pro 프로젝트가 없습니다.");
  }
  const { targetBin } = await getProjectImportBin(project);
  const imported = await project.importFiles(uniquePaths, true, targetBin, false);
  if (!imported) {
    throw new ShortFlowError(
      "PROJECT_IMPORT_FAILED",
      "생성된 파일을 활성 프로젝트 bin으로 가져오지 못했습니다.",
    );
  }
  return uniquePaths.length;
}

export async function importAndInsertAsset(
  nativePath: string,
  options: InsertAssetOptions,
): Promise<void> {
  const assetPath = nativePath.trim();
  if (!assetPath) {
    throw new ShortFlowError("NO_ASSET_PATH", "삽입할 자산 파일 경로가 없습니다.");
  }
  const videoTrackIndex = zeroBasedTrackIndex(options.videoTrackIndex);
  const audioTrackIndex = zeroBasedTrackIndex(options.audioTrackIndex);
  const { project, sequence } = await getActiveContext();
  const { bin, targetBin } = await getProjectImportBin(project);
  const beforeItems = await bin.getItems();
  const beforeIds = new Set<string>();
  for (const item of beforeItems) {
    beforeIds.add(String(item.getId()));
  }
  const imported = await project.importFiles([assetPath], true, targetBin, false);
  if (!imported) {
    throw new ShortFlowError("ASSET_IMPORT_FAILED", `${options.displayName ?? "자산"} 파일을 프로젝트로 가져오지 못했습니다.`);
  }
  let projectItem: ProjectItem | null = null;
  for (let attempt = 0; attempt < 10 && !projectItem; attempt += 1) {
    if (attempt > 0) await wait(50);
    projectItem = await findImportedItem(bin, assetPath, beforeIds);
  }
  if (!projectItem) {
    throw new ShortFlowError("IMPORTED_ITEM_NOT_FOUND", "가져온 자산의 프로젝트 아이템을 찾지 못했습니다.");
  }
  const editor = ppro.SequenceEditor.getEditor(sequence);
  const insertionTime = await sequence.getPlayerPosition();
  const action = editor.createInsertProjectItemAction(
    projectItem,
    insertionTime,
    videoTrackIndex,
    audioTrackIndex,
    true,
  );
  if (!commitActions(project, [action], "ShortFlow: 음악/효과음 삽입")) {
    throw new ShortFlowError("ASSET_INSERT_FAILED", "자산을 현재 재생 위치에 삽입하지 못했습니다.");
  }
  if (options.durationSeconds !== undefined) {
    const duration = Number(options.durationSeconds);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 86_400) {
      throw new ShortFlowError("INVALID_ASSET_DURATION", "가이드 오버레이 길이는 0초 초과 24시간 이하여야 합니다.");
    }
    const insertedAt = tickTimeSeconds(insertionTime, 0);
    const projectItemId = String(projectItem.getId());
    let insertedItem: VideoClipTrackItem | null = null;
    for (let attempt = 0; attempt < 10 && !insertedItem; attempt += 1) {
      if (attempt > 0) await wait(50);
      const track = await sequence.getVideoTrack(videoTrackIndex);
      if (!track) continue;
      const candidates = track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false);
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
    const endAction = insertedItem.createSetEndAction(ppro.TickTime.createWithSeconds(insertedAt + duration));
    if (!commitActions(project, [endAction], "ShortFlow: 가이드 오버레이 길이 설정")) {
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
