import { PROFILES, formatDuration, type MarkerSegment, type QCItem } from "./src/core";
import {
  ASSET_DRAG_PAYLOAD_MIME,
  AssetLibrary,
  AssetLibraryError,
  createAssetDragPayload,
  createDefaultAssetLibraryAdapter,
  filterAssets,
  parseAssetDragPayload,
  type AssetItem,
} from "./src/asset-library";
import {
  addStoryMarkers,
  addAutomationMarkers,
  alignSelectedVideoToSafeZone,
  applyAutomationPlan,
  choosePersistentFile,
  choosePersistentFolder,
  createShort,
  createShortsFromMarkers,
  errorMessage,
  exportCover,
  exportVideo,
  importAndInsertAsset,
  insertMogrt,
  readSequenceStatus,
  readPlayerPositionSeconds,
  removeVerifiedClonedSequence,
  restorePersistentEntry,
  runSequenceQC,
  scanSequenceMediaQC,
  setSequencePlayerPosition,
  scanShortMarkers,
  type CreateShortOptions,
  type PersistentEntryResult,
  type SequenceStatus,
} from "./src/premiere";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type PluginSettings,
  type SequenceRangeMode,
} from "./src/settings";
import { ReferenceController } from "./src/reference-controller";
import {
  OpenAIImageClient,
  createDefaultOpenAIImageAdapter,
  type ImageEditPreset,
} from "./src/ai";
import {
  initializeThumbnailController,
  type ThumbnailController,
} from "./src/thumbnail-controller";
import { SpeechController } from "./src/speech-controller";
import { AutomationController } from "./src/automation-controller";
import { BrandKitController } from "./src/brand-kit-controller";
import { AIQueueController } from "./src/ai-queue-controller";
import { deterministicHash } from "./src/job-queue";
import { SpeechApiClient } from "./src/speech";
import { canvasToPngBytes } from "./src/thumbnail";
import {
  SAFE_ZONE_PROFILES,
  normalizedRectToPixels,
  safeContentRect,
  type SocialPlatform,
} from "./src/safe-zone";
import { FinalQCController } from "./src/final-qc-controller";
import type { FinalQCSnapshot } from "./src/final-qc";
import { SubtitleController, type SubtitleAiRequest } from "./src/subtitle-controller";
import { createSubtitleDocument } from "./src/subtitles";
import { OpenAITextClient, chunkSubtitleCues } from "./src/openai-text";
import { buildReferencePrompt, type ReferenceItem } from "./src/references";
import { RecoveryManager, type OperationJournalEntry } from "./src/recovery";
import {
  buildDiagnosticsReport,
  diagnosticBundleToJSON,
  type DiagnosticStatus,
  type DiagnosticsReport,
} from "./src/diagnostics";
import {
  ActivityLog,
  BusyState,
  bind,
  checkedOf,
  element,
  numberOf,
  optionalElement,
  renderEmptyState,
  setChecked,
  setText,
  setValue,
  setupTabs,
  toast,
  valueOf,
} from "./src/ui";

const { entrypoints } = require("uxp") as any;

const activity = new ActivityLog();
const busy = new BusyState();
let settings: PluginSettings = loadSettings();
let initialized = false;
let markerSegments: MarkerSegment[] = [];
let assets: AssetItem[] = [];
let selectedAssetId = "";
let assetLibrary: AssetLibrary | null = null;
let referenceController: ReferenceController | null = null;
let imageAIClient: OpenAIImageClient | null = null;
let speechController: SpeechController | null = null;
let automationController: AutomationController | null = null;
let thumbnailController: ThumbnailController | null = null;
let brandKitController: BrandKitController | null = null;
let aiQueueController: AIQueueController | null = null;
let finalQCController: FinalQCController | null = null;
let subtitleController: SubtitleController | null = null;
let subtitlePlayheadTimer: ReturnType<typeof setInterval> | null = null;
let recoveryManager: RecoveryManager | null = null;
let diagnosticsReport: DiagnosticsReport | null = null;

function reportError(error: unknown, context: string): void {
  const message = errorMessage(error);
  activity.add("error", `${context}: ${message}`);
  toast(message, "error", 5200);
}

function saveCurrentSettings(): void {
  settings = saveSettings(settings);
}

function updateSettings(patch: Partial<PluginSettings>): void {
  settings = saveSettings({ ...settings, ...patch });
}

function profileById(id: string) {
  return PROFILES.find((profile) => profile.id === id) ?? PROFILES[0]!;
}

function optionalNumberValue(id: string): number | undefined {
  const raw = valueOf(id).trim();
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function commaList(id: string): string[] {
  return valueOf(id).split(",").map((item) => item.trim()).filter(Boolean).slice(0, 500);
}

function finalQCPlatform(): SocialPlatform {
  const value = valueOf("final-qc-platform-select");
  return value === "instagram-reels" || value === "tiktok" ? value : "youtube-shorts";
}

async function buildFinalQCSnapshot(): Promise<FinalQCSnapshot> {
  const [status, media] = await Promise.all([readSequenceStatus(), scanSequenceMediaQC()]);
  if (media.truncated) activity.add("warning", `최종 QC 미디어 스캔이 ${media.scannedItems}개 안전 제한에서 중단됐습니다.`);
  let outputPath = "";
  if (settings.outputFolderToken) {
    try {
      const outputFolder = await restorePersistentEntry(settings.outputFolderToken);
      outputPath = String(outputFolder?.nativePath ?? "");
    } catch {
      outputPath = "";
    }
  }
  const platform = finalQCPlatform();
  const transcript = speechController?.transcript;
  const rect = {
    x: numberOf("safe-box-x-input", 20) / 100,
    y: numberOf("safe-box-y-input", 55) / 100,
    width: numberOf("safe-box-width-input", 60) / 100,
    height: numberOf("safe-box-height-input", 12) / 100,
  };
  const subtitleCues = subtitleController?.document.cues
    .filter((cue) => cue.enabled && !cue.hidden)
    .slice(0, 5_000);
  const captions = subtitleCues?.length
    ? subtitleCues.map((cue) => ({
      id: cue.cueId,
      text: cue.words.length
        ? cue.words.filter((word) => !word.hidden).map((word) => word.t).join(" ").trim()
        : cue.text,
      start: cue.start,
      end: cue.end,
      rect,
    }))
    : (transcript?.result.segments ?? []).slice(0, 5_000).map((segment, index) => ({
      id: `stt-${index + 1}`,
      text: segment.text,
      start: segment.start,
      end: segment.end,
      rect,
    }));
  const role = valueOf("safe-role-select");
  const audio: FinalQCSnapshot["audio"] = {
    ...(optionalNumberValue("final-qc-true-peak") !== undefined ? { truePeakDbtp: optionalNumberValue("final-qc-true-peak")! } : {}),
    ...(optionalNumberValue("final-qc-clipped-samples") !== undefined ? { clippedSampleCount: optionalNumberValue("final-qc-clipped-samples")! } : {}),
    ...(optionalNumberValue("final-qc-longest-silence") !== undefined ? { longestSilenceSeconds: optionalNumberValue("final-qc-longest-silence")! } : {}),
    ...(optionalNumberValue("final-qc-dialogue-lufs") !== undefined ? { dialogueLufs: optionalNumberValue("final-qc-dialogue-lufs")! } : {}),
    ...(optionalNumberValue("final-qc-bgm-lufs") !== undefined ? { bgmLufs: optionalNumberValue("final-qc-bgm-lufs")! } : {}),
  };
  return {
    platform,
    sequence: {
      name: status.sequenceName,
      width: status.width,
      height: status.height,
      duration: status.sequenceEnd,
      frameRate: status.frameRate,
      videoTrackCount: status.videoTrackCount,
      audioTrackCount: status.audioTrackCount,
    },
    captions,
    safeZoneElements: role === "content" ? [{ id: "safe-preview-element", label: "Safe Zone 검사 요소", rect }] : [],
    audio,
    media: {
      offlineMedia: media.offlineMedia,
      guideOverlays: media.guideOverlays,
      missingFonts: commaList("final-qc-missing-fonts"),
      missingAssets: commaList("final-qc-missing-assets"),
    },
    output: {
      fileName: valueOf("final-qc-output-name"),
      directoryPath: outputPath,
    },
  };
}

async function subtitleProjectKey(): Promise<string> {
  const status = await readSequenceStatus();
  return `project-${deterministicHash({ path: status.projectPath, sequence: status.sequenceGuid })}`;
}

async function readSrtFile(): Promise<string | null> {
  const uxpRoot = require("uxp") as any;
  const selected = await uxpRoot?.storage?.localFileSystem?.getFileForOpening?.({ types: ["srt"], allowMultiple: false });
  const file = Array.isArray(selected) ? selected[0] : selected;
  if (!file) return null;
  const value = await file.read({ format: uxpRoot?.storage?.formats?.utf8 });
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value as ArrayBufferView);
  throw new Error("SRT 파일을 텍스트로 읽지 못했습니다.");
}

async function writeSrtFile(srt: string, suggestedName: string): Promise<void> {
  const uxpRoot = require("uxp") as any;
  const file = await uxpRoot?.storage?.localFileSystem?.getFileForSaving?.(suggestedName, { types: ["srt"] });
  if (!file) return;
  await file.write(srt, { format: uxpRoot?.storage?.formats?.utf8 });
}

async function runSubtitleAI(request: SubtitleAiRequest): Promise<unknown> {
  const batches = chunkSubtitleCues(request.document.cues).length;
  const descriptor = {
    action: request.action,
    documentHash: deterministicHash(request.document),
    cueCount: request.document.cues.length,
    batchCount: batches,
    maxChars: request.maxChars,
    targetLanguageHash: deterministicHash(request.targetLanguage ?? ""),
    model: "gpt-5.4-mini",
  };
  const task = () => new OpenAITextClient({
    endpoint: settings.aiEndpoint,
    onProgress: (completed, total) => activity.add("info", `AI 자막 ${completed}/${total} 묶음 처리`),
  }).editSubtitles(request);
  return aiQueueController
    ? aiQueueController.run("text", descriptor, task, {
      estimateUnits: Math.max(1, batches),
      cacheTtlMs: 0,
      confirmRequired: batches > 10,
    })
    : task();
}

function startSubtitlePlayheadTracking(): void {
  if (subtitlePlayheadTimer !== null) return;
  subtitlePlayheadTimer = setInterval(() => {
    const controller = subtitleController;
    if (!controller || controller.document.cues.length === 0) return;
    void readPlayerPositionSeconds()
      .then((seconds) => controller.updatePlayhead(seconds))
      .catch(() => undefined);
  }, 350);
}

function stopSubtitlePlayheadTracking(): void {
  if (subtitlePlayheadTimer !== null) clearInterval(subtitlePlayheadTimer);
  subtitlePlayheadTimer = null;
}

function recoveryStatusLabel(status: OperationJournalEntry["status"]): string {
  return {
    running: "실행 중",
    committed: "완료",
    failed: "실패",
    "rolling-back": "복구 중",
    "rolled-back": "복구 완료",
    "rollback-failed": "복구 실패",
    interrupted: "중단됨",
  }[status];
}

function renderRecoveryJournal(): void {
  const target = optionalElement<HTMLElement>("recovery-list");
  if (!target) return;
  target.replaceChildren();
  const entries = recoveryManager?.list().sort((left, right) => right.createdAt - left.createdAt) ?? [];
  setText("recovery-count", `${entries.length} / 50`);
  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "action-note";
    empty.textContent = "기록된 비파괴 작업이 없습니다.";
    target.append(empty);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = `recovery-row is-${entry.status}`;
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = `${entry.label} · ${recoveryStatusLabel(entry.status)}`;
    const details = document.createElement("span");
    details.textContent = `${entry.preview.changes.length}개 변경 · 원본 ${entry.originalPreserved ? "보존" : "확인 필요"}${entry.error ? ` · ${entry.error}` : ""}`;
    const guidance = document.createElement("small");
    guidance.textContent = entry.recoveryGuidance;
    copy.append(title, details, guidance);
    row.append(copy);
    if (["committed", "failed", "interrupted", "rollback-failed"].includes(entry.status)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "danger-button small-button";
      button.textContent = "복제본 제거";
      button.addEventListener("click", () => void rollbackRecoveryEntry(entry));
      row.append(button);
    }
    target.append(row);
  }
}

async function rollbackRecoveryEntry(entry: OperationJournalEntry): Promise<void> {
  if (!recoveryManager) return;
  const confirmFn = (globalThis as unknown as { confirm?: (message: string) => boolean }).confirm;
  if (confirmFn && !confirmFn(`원본은 유지하고 복제 시퀀스만 제거합니다. 계속하시겠습니까?\n${entry.label}`)) return;
  try {
    await recoveryManager.rollback(entry.operationId, () => removeVerifiedClonedSequence(
      entry.clonePolicy.sourceId,
      entry.clonePolicy.cloneId,
    ));
    activity.add("success", `복제 시퀀스 복구 완료: ${entry.label}`);
    toast("원본을 유지하고 복제 시퀀스를 제거했습니다.", "success");
  } catch (error) {
    reportError(error, "복제 시퀀스 복구 실패");
  }
  renderRecoveryJournal();
}

function moduleMember(moduleValue: Record<string, unknown> | null, ...path: string[]): unknown {
  let current: unknown = moduleValue;
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function hostModule(moduleName: string): Record<string, unknown> | null {
  try {
    const value = require(moduleName) as unknown;
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function asDiagnosticString(value: unknown, fallback = "unknown"): string {
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    if (text) return text.slice(0, 80);
  }
  return fallback;
}

function diagnosticsStatusLabel(status: DiagnosticStatus): string {
  return status === "green" ? "정상" : status === "yellow" ? "확인 필요" : "차단";
}

function renderDiagnosticsReport(report: DiagnosticsReport | null): void {
  const summary = optionalElement<HTMLElement>("diagnostics-summary");
  const list = optionalElement<HTMLElement>("diagnostics-list");
  const exportButton = optionalElement<HTMLButtonElement>("export-diagnostics-btn");
  if (exportButton) exportButton.disabled = !report;
  if (!summary || !list) return;
  if (!report) {
    summary.className = "diagnostics-summary is-idle";
    summary.textContent = "아직 진단을 실행하지 않았습니다.";
    list.replaceChildren();
    return;
  }
  summary.className = `diagnostics-summary is-${report.overall}`;
  summary.textContent = report.compatible
    ? `호환성 ${diagnosticsStatusLabel(report.overall)} · Premiere ${report.host.version} · UXP ${report.uxp.version}`
    : `호환성 차단 · Premiere ${report.minimumHostVersion} 이상과 필수 API를 확인해 주세요.`;
  list.replaceChildren();
  for (const check of report.checks) {
    const row = document.createElement("div");
    row.className = `diagnostic-row is-${check.status}`;
    const state = document.createElement("span");
    state.className = "diagnostic-state";
    state.textContent = diagnosticsStatusLabel(check.status);
    const copy = document.createElement("div");
    const label = document.createElement("strong");
    label.textContent = check.label;
    const message = document.createElement("small");
    message.textContent = `${check.message}${check.version ? ` · ${check.version}` : ""}${check.replacement ? ` · 대체: ${check.replacement}` : ""}`;
    copy.append(label, message);
    row.append(state, copy);
    list.append(row);
  }
}

async function collectDiagnosticsReport(): Promise<DiagnosticsReport> {
  const uxpRoot = hostModule("uxp");
  const premiere = hostModule("premierepro");
  const secureStorage = moduleMember(uxpRoot, "secureStorage") ?? moduleMember(uxpRoot, "storage", "secureStorage");
  const filesystem = moduleMember(uxpRoot, "storage", "localFileSystem");
  const hostVersion = moduleMember(uxpRoot, "host", "version");
  const uxpVersion = moduleMember(uxpRoot, "versions", "uxp") ?? moduleMember(uxpRoot, "version");
  return buildDiagnosticsReport({
    getHostInfo: () => ({
      name: asDiagnosticString(moduleMember(uxpRoot, "host", "name"), "Adobe Premiere Pro"),
      version: asDiagnosticString(hostVersion),
      build: asDiagnosticString(moduleMember(uxpRoot, "host", "build"), ""),
    }),
    getUxpInfo: () => ({ version: asDiagnosticString(uxpVersion) }),
    getOsInfo: () => ({
      platform: asDiagnosticString(moduleMember(uxpRoot, "os", "platform"), navigator.platform || "unknown"),
      version: asDiagnosticString(moduleMember(uxpRoot, "os", "version"), ""),
      arch: asDiagnosticString(moduleMember(uxpRoot, "os", "architecture"), ""),
    }),
    getRuntimeInfo: () => ({ pluginVersion: "1.0.0", locale: navigator.language, online: navigator.onLine }),
    capabilities: {
      transcript: () => ({
        available: Boolean(moduleMember(premiere, "Transcript")),
        detail: "Transcript API 공개 여부를 확인했습니다.",
      }),
      encoder: () => ({
        available: typeof moduleMember(premiere, "EncoderManager", "getManager") === "function",
        detail: "EncoderManager 공개 API를 확인했습니다.",
      }),
      secureStorage: () => ({
        available: Boolean(secureStorage),
        detail: "UXP Secure Storage 사용 가능 여부를 확인했습니다.",
      }),
      network: () => ({ available: typeof fetch === "function", detail: "UXP 네트워크 런타임을 확인했습니다." }),
      filesystem: () => ({
        available: typeof moduleMember(filesystem as Record<string, unknown> | null, "getDataFolder") === "function",
        detail: "UXP Local File System 사용 가능 여부를 확인했습니다.",
      }),
    },
    apis: [
      { name: "Project.getActiveProject", value: moduleMember(premiere, "Project", "getActiveProject"), required: true },
      { name: "SequenceEditor.getEditor", value: moduleMember(premiere, "SequenceEditor", "getEditor"), required: true },
      { name: "EncoderManager.getManager", value: moduleMember(premiere, "EncoderManager", "getManager"), required: true },
      { name: "secureStorage.getItem", value: moduleMember(secureStorage as Record<string, unknown> | null, "getItem"), required: true },
    ],
  });
}

async function handleRunDiagnostics(): Promise<void> {
  const report = await busy.during("Premiere UXP 호환성을 진단하고 있습니다…", collectDiagnosticsReport);
  diagnosticsReport = report;
  renderDiagnosticsReport(report);
  activity.add(report.compatible ? "success" : "warning", `시스템 진단 완료 · ${diagnosticsStatusLabel(report.overall)} · ${report.checks.length}개 항목`);
  toast(
    report.compatible ? "시스템 진단을 완료했습니다." : "필수 호환성 항목을 확인해 주세요.",
    report.compatible ? "success" : "warning",
  );
}

async function handleExportDiagnostics(): Promise<void> {
  const report = diagnosticsReport;
  if (!report) throw new Error("먼저 시스템 진단을 실행해 주세요.");
  const uxpRoot = hostModule("uxp");
  const fileSystem = moduleMember(uxpRoot, "storage", "localFileSystem") as {
    getFileForSaving?: (name: string, options: { types: string[] }) => Promise<unknown>;
  } | undefined;
  const file = await fileSystem?.getFileForSaving?.(
    `ShortFlow_Diagnostics_${new Date().toISOString().replace(/[^\d]/gu, "").slice(0, 14)}.json`,
    { types: ["json"] },
  ) as { write?: (value: string, options?: unknown) => Promise<void> } | null | undefined;
  if (!file?.write) throw new Error("진단 JSON을 저장할 UXP 파일 시스템을 사용할 수 없습니다.");
  const payload = diagnosticBundleToJSON({
    report,
    context: { plugin: "shortflow-studio", reportPurpose: "user-initiated-local-export" },
  });
  await file.write(payload, { format: moduleMember(uxpRoot, "storage", "formats", "utf8") });
  activity.add("success", "개인정보를 제거한 시스템 진단 JSON을 저장했습니다.");
  toast("익명화된 진단 JSON을 저장했습니다.", "success");
}

function applySettingsToUI(): void {
  setValue("preset-select", settings.profileId);
  setValue("width-input", settings.width);
  setValue("height-input", settings.height);
  setValue("name-input", settings.sequenceName);
  setValue("range-select", settings.rangeMode);
  setValue("max-duration-input", settings.maxDuration);
  setValue("reframe-select", settings.reframeMode === "none" ? "keep" : settings.reframeMode);
  setValue("scope-select", settings.scope);
  setChecked("center-checkbox", settings.centerClips);
  setValue("hook-seconds-input", settings.hookSeconds);
  setValue("cta-seconds-input", settings.ctaSeconds);
  setValue("mogrt-track-input", settings.mogrtTrack);
  setValue("export-mode-select", settings.exportMode);
  setValue("export-range-select", settings.exportRange);
  setText("preset-name", settings.presetName || "선택되지 않음", settings.presetName);
  setText("output-name", settings.outputFolderName || "선택되지 않음", settings.outputFolderName);
  setText("mogrt-name", settings.mogrtName || "선택되지 않음", settings.mogrtName);
  setText("asset-root-name", settings.assetRootName || "선택되지 않음", settings.assetRootName);
  setValue("ai-provider-select", settings.aiProvider);
  setValue("ai-endpoint-input", settings.aiEndpoint);
  setValue("ai-model-input", settings.aiModel);
  setValue("tts-model-select", settings.ttsModel);
  setValue("tts-voice-select", settings.ttsVoice);
  setValue("tts-format-select", settings.ttsFormat);
  setValue("tts-speed-input", settings.ttsSpeed);
  setValue("tts-audio-track-input", settings.ttsAudioTrack);
  setText("tts-output-name", settings.ttsOutputName || "선택되지 않음", settings.ttsOutputName);
  setValue("stt-model-select", settings.sttModel);
  setValue("stt-language-input", settings.sttLanguage);
  setValue("stt-output-format-select", settings.sttOutputFormat);
  setText("stt-output-name", settings.sttOutputName || "선택되지 않음", settings.sttOutputName);
}

function rangeModeFromUI(raw: string): SequenceRangeMode {
  if (raw === "sequence" || raw === "selection" || raw === "playhead") return raw;
  return "inout";
}

function syncSettingsFromUI(): PluginSettings {
  const reframeRaw = valueOf("reframe-select");
  settings = {
    ...settings,
    profileId: valueOf("preset-select"),
    width: numberOf("width-input", settings.width),
    height: numberOf("height-input", settings.height),
    sequenceName: valueOf("name-input"),
    rangeMode: rangeModeFromUI(valueOf("range-select")),
    maxDuration: numberOf("max-duration-input", settings.maxDuration),
    reframeMode: reframeRaw === "keep" ? "none" : reframeRaw === "fit" ? "fit" : "fill",
    scope: valueOf("scope-select") === "selected"
      ? "selected"
      : valueOf("scope-select") === "primary" ? "primary" : "video",
    centerClips: reframeRaw === "scale-only" ? false : checkedOf("center-checkbox"),
    hookSeconds: numberOf("hook-seconds-input", settings.hookSeconds),
    ctaSeconds: numberOf("cta-seconds-input", settings.ctaSeconds),
    mogrtTrack: numberOf("mogrt-track-input", settings.mogrtTrack),
    exportMode: valueOf("export-mode-select") === "immediate" ? "immediate" : "queue",
    exportRange: valueOf("export-range-select") === "entire" ? "entire" : "inout",
    // UXP manifest가 허용한 공식 OpenAI origin만 사용합니다. readonly UI 값도
    // 신뢰하지 않아, 개발자 도구로 변조되어도 저장 설정에 반영되지 않게 합니다.
    aiProvider: "openai",
    aiEndpoint: DEFAULT_SETTINGS.aiEndpoint,
    aiModel: valueOf("ai-model-input") || DEFAULT_SETTINGS.aiModel,
    ttsModel: valueOf("tts-model-select") as PluginSettings["ttsModel"],
    ttsVoice: valueOf("tts-voice-select"),
    ttsFormat: valueOf("tts-format-select") as PluginSettings["ttsFormat"],
    ttsSpeed: numberOf("tts-speed-input", settings.ttsSpeed),
    ttsAudioTrack: numberOf("tts-audio-track-input", settings.ttsAudioTrack),
    sttModel: valueOf("stt-model-select") as PluginSettings["sttModel"],
    sttLanguage: valueOf("stt-language-input") || DEFAULT_SETTINGS.sttLanguage,
    sttOutputFormat: valueOf("stt-output-format-select") as PluginSettings["sttOutputFormat"],
  };
  saveCurrentSettings();
  return settings;
}

function createOptions(): CreateShortOptions {
  const current = syncSettingsFromUI();
  return {
    width: current.width,
    height: current.height,
    name: current.sequenceName,
    rangeMode: current.rangeMode,
    maxDuration: current.maxDuration,
    reframeMode: current.reframeMode,
    scope: current.scope,
    centerClips: current.centerClips,
  };
}

function renderStatus(status: SequenceStatus): void {
  setText("status-project", status.projectName, status.projectPath || status.projectName);
  setText("status-sequence", status.sequenceName, status.sequenceName);
  setText("status-frame", `${status.width} × ${status.height}`);
  setText("status-duration", formatDuration(status.effectiveDuration || status.sequenceEnd));
  const selection = status.selectedItemCount > 0
    ? `${status.selectedItemCount}개 선택 · ${formatDuration((status.selectedEnd ?? 0) - (status.selectedStart ?? 0))}`
    : "선택된 클립 없음";
  setText("status-selection", selection, selection);
}

async function refreshStatus(silent = false): Promise<SequenceStatus | null> {
  try {
    const status = await readSequenceStatus();
    renderStatus(status);
    if (!silent) activity.add("info", `활성 시퀀스 확인: ${status.sequenceName}`);
    return status;
  } catch (error) {
    setText("status-project", "Premiere 연결 필요");
    setText("status-sequence", "활성 시퀀스 없음");
    setText("status-frame", "—");
    setText("status-duration", "—");
    setText("status-selection", "—");
    if (!silent) reportError(error, "프로젝트 상태 확인 실패");
    return null;
  }
}

function qcIcon(level: QCItem["level"]): string {
  return level === "pass" ? "✓" : level === "warning" ? "!" : "×";
}

function renderQC(items: QCItem[]): void {
  const target = element<HTMLElement>("qc-results");
  target.className = "qc-result-list";
  target.replaceChildren();
  for (const result of items) {
    const item = document.createElement("div");
    item.className = `qc-result qc-${result.level}`;
    const icon = document.createElement("span");
    icon.className = "qc-result-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = qcIcon(result.level);
    const message = document.createElement("span");
    message.textContent = result.message;
    item.append(icon, message);
    target.append(item);
  }
  const badge = target.closest(".result-card")?.querySelector<HTMLElement>(".neutral-badge");
  if (badge) {
    const errors = items.filter((item) => item.level === "error").length;
    const warnings = items.filter((item) => item.level === "warning").length;
    badge.textContent = errors ? `오류 ${errors}` : warnings ? `경고 ${warnings}` : "통과";
    badge.className = `neutral-badge ${errors ? "badge-error" : warnings ? "badge-warning" : "badge-success"}`;
  }
}

async function handleQC(): Promise<void> {
  const current = syncSettingsFromUI();
  await busy.during("시퀀스 QC를 검사하고 있습니다…", async () => {
    const result = await runSequenceQC(current.width, current.height, current.maxDuration);
    renderQC(result.items);
    renderStatus(result.status);
    const errors = result.items.filter((item) => item.level === "error").length;
    const warnings = result.items.filter((item) => item.level === "warning").length;
    activity.add(errors ? "error" : warnings ? "warning" : "success", `QC 완료 · 오류 ${errors} · 경고 ${warnings}`);
    toast(errors ? "QC 오류를 확인해 주세요." : warnings ? "QC 경고가 있습니다." : "QC를 통과했습니다.", errors ? "error" : warnings ? "warning" : "success");
  });
}

async function handleCreateShort(): Promise<void> {
  const options = createOptions();
  await busy.during("원본을 복제하고 숏폼 시퀀스를 생성하고 있습니다…", async () => {
    const result = await createShort(options);
    activity.add("success", `${result.sequenceName} 생성 · ${result.width}×${result.height} · ${formatDuration(result.range.duration)}`);
    if (result.warnings.length) {
      activity.add("warning", result.warnings.join(" "));
    }
    toast("숏폼 시퀀스를 생성했습니다.", "success");
    await refreshStatus(true);
  });
}

function selectedMarkerSegments(): MarkerSegment[] {
  const checkboxes = document.querySelectorAll<HTMLInputElement>("#marker-list input[data-segment-index]");
  if (checkboxes.length === 0) return markerSegments;
  const indexes = new Set(
    [...checkboxes]
      .filter((checkbox) => checkbox.checked)
      .map((checkbox) => Number(checkbox.dataset.segmentIndex)),
  );
  return markerSegments.filter((_segment, index) => indexes.has(index));
}

function renderMarkers(segments: MarkerSegment[]): void {
  const target = element<HTMLElement>("marker-list");
  const button = element<HTMLButtonElement>("batch-create-btn");
  if (!segments.length) {
    renderEmptyState(target, "ShortFlow 마커가 없습니다", "마커 이름에 SHORT, 숏폼 또는 #SF를 포함해 주세요.");
    button.disabled = true;
    return;
  }
  target.replaceChildren();
  segments.forEach((segment, index) => {
    const label = document.createElement("label");
    label.className = "marker-item";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.segmentIndex = String(index);
    const copy = document.createElement("span");
    copy.className = "marker-copy";
    const title = document.createElement("strong");
    title.textContent = segment.name;
    const detail = document.createElement("small");
    detail.textContent = `${formatDuration(segment.start)} → ${formatDuration(segment.end)} · ${formatDuration(segment.duration)}`;
    copy.append(title, detail);
    label.append(checkbox, copy);
    target.append(label);
  });
  button.disabled = false;
}

async function handleScanMarkers(): Promise<void> {
  const current = syncSettingsFromUI();
  markerSegments = await busy.during("숏폼 마커를 검색하고 있습니다…", () => scanShortMarkers(current.maxDuration));
  renderMarkers(markerSegments);
  activity.add("info", `숏폼 마커 구간 ${markerSegments.length}개 검색`);
}

async function handleBatchCreate(): Promise<void> {
  const selected = selectedMarkerSegments();
  if (!selected.length) {
    toast("일괄 생성할 마커 구간을 선택해 주세요.", "warning");
    return;
  }
  const options = createOptions();
  const result = await busy.during(`${selected.length}개 마커 구간을 생성하고 있습니다…`, () =>
    createShortsFromMarkers(selected, options, (completed, total, name) => {
      setText("busy-message", `${completed}/${total} · ${name}`);
    }));
  activity.add("success", `마커 구간 일괄 생성 완료 · 성공 ${result.created.length} · 실패 ${result.failures.length}`);
  result.failures.forEach((failure) => activity.add("error", `${failure.name}: ${failure.error}`));
  toast(`${result.created.length}개 숏폼 시퀀스를 생성했습니다.`, result.failures.length ? "warning" : "success");
  await refreshStatus(true);
}

async function handleStoryMarkers(): Promise<void> {
  const current = syncSettingsFromUI();
  const count = await busy.during("HOOK/CTA 마커를 추가하고 있습니다…", () =>
    addStoryMarkers(current.hookSeconds, current.ctaSeconds));
  activity.add("success", `스토리 마커 ${count}개 추가`);
  toast("HOOK/CTA 마커를 추가했습니다.", "success");
}

function applyPersistentResult(
  kind: "preset" | "output" | "mogrt",
  result: PersistentEntryResult,
): void {
  if (kind === "preset") {
    settings.presetToken = result.token;
    settings.presetName = result.name;
    setText("preset-name", result.name, result.nativePath);
  } else if (kind === "output") {
    settings.outputFolderToken = result.token;
    settings.outputFolderName = result.name;
    setText("output-name", result.name, result.nativePath);
  } else {
    settings.mogrtToken = result.token;
    settings.mogrtName = result.name;
    setText("mogrt-name", result.name, result.nativePath);
  }
  saveCurrentSettings();
}

async function handleChoosePreset(): Promise<void> {
  const result = await choosePersistentFile(["epr"]);
  if (!result) return;
  applyPersistentResult("preset", result);
  activity.add("info", `내보내기 프리셋 선택: ${result.name}`);
}

async function handleChooseOutput(): Promise<void> {
  const result = await choosePersistentFolder();
  if (!result) return;
  applyPersistentResult("output", result);
  activity.add("info", `출력 폴더 선택: ${result.name}`);
}

async function handleChooseMogrt(): Promise<void> {
  const result = await choosePersistentFile(["mogrt"]);
  if (!result) return;
  applyPersistentResult("mogrt", result);
  activity.add("info", `MOGRT 선택: ${result.name}`);
}

async function requireStoredEntry(token: string, label: string): Promise<any> {
  const entry = await restorePersistentEntry(token);
  if (!entry) throw new Error(`${label} 접근 권한이 만료되었습니다. 다시 선택해 주세요.`);
  return entry;
}

async function handleInsertMogrt(): Promise<void> {
  syncSettingsFromUI();
  const file = await requireStoredEntry(settings.mogrtToken, "MOGRT 파일");
  const count = await busy.during("MOGRT를 삽입하고 있습니다…", () => insertMogrt(file, settings.mogrtTrack));
  activity.add("success", `${settings.mogrtName} 삽입 · 트랙 아이템 ${count}개`);
  toast("MOGRT를 현재 재생 위치에 삽입했습니다.", "success");
}

async function handleExportVideo(): Promise<void> {
  syncSettingsFromUI();
  if (!finalQCController) throw new Error("최종 QC 게이트가 초기화되지 않았습니다. 플러그인 패널을 다시 열어 주세요.");
  await finalQCController.ensureExportAllowed();
  const [presetFile, outputFolder] = await Promise.all([
    requireStoredEntry(settings.presetToken, "내보내기 프리셋"),
    requireStoredEntry(settings.outputFolderToken, "출력 폴더"),
  ]);
  const outputPath = await busy.during("영상을 내보내고 있습니다…", () => exportVideo({
    presetFile,
    outputFolder,
    mode: settings.exportMode,
    range: settings.exportRange,
  }));
  activity.add("success", `영상 내보내기 요청 완료: ${outputPath}`);
  toast(settings.exportMode === "queue" ? "Media Encoder 대기열에 추가했습니다." : "영상 내보내기를 완료했습니다.", "success");
}

async function handleExportCover(): Promise<void> {
  syncSettingsFromUI();
  const outputFolder = await requireStoredEntry(settings.outputFolderToken, "출력 폴더");
  const outputPath = await busy.during("현재 프레임을 PNG로 저장하고 있습니다…", () => exportCover(outputFolder));
  activity.add("success", `커버 이미지 저장: ${outputPath}`);
  toast("현재 프레임 커버를 저장했습니다.", "success");
}

function ensureAssetLibrary(): AssetLibrary {
  if (!assetLibrary) {
    assetLibrary = new AssetLibrary(createDefaultAssetLibraryAdapter());
  }
  return assetLibrary;
}

function setAssetRootUI(name: string, enabled: boolean): void {
  setText("asset-root-name", name || "선택되지 않음", name);
  const open = optionalElement<HTMLButtonElement>("open-asset-root-btn");
  if (open) open.disabled = !enabled;
}

async function initializeAssetLibrary(): Promise<void> {
  try {
    const library = ensureAssetLibrary();
    const root = await library.restoreRoot();
    if (root) {
      settings.assetRootName = String(root.name ?? settings.assetRootName);
      setAssetRootUI(settings.assetRootName, true);
    }
  } catch (error) {
    if (error instanceof AssetLibraryError && error.code === "TOKEN_EXPIRED") {
      settings.assetRootName = "";
      setAssetRootUI("", false);
      saveCurrentSettings();
      activity.add("warning", error.message);
      return;
    }
    activity.add("warning", `자산 라이브러리 복원 실패: ${errorMessage(error)}`);
  }
}

async function handleChooseAssetRoot(): Promise<void> {
  const root = await busy.during("자산 라이브러리 폴더를 준비하고 있습니다…", () => ensureAssetLibrary().selectRoot());
  settings.assetRootName = String(root.name ?? "자산 라이브러리");
  setAssetRootUI(settings.assetRootName, true);
  saveCurrentSettings();
  activity.add("success", `자산 루트 선택: ${settings.assetRootName}`);
  await handleSyncAssets();
}

async function handleOpenAssetRoot(): Promise<void> {
  await ensureAssetLibrary().openRootFolder();
  activity.add("info", "시스템 파일 탐색기에서 자산 폴더를 열었습니다.");
}

function filteredAudioAssets(): AssetItem[] {
  const query = valueOf("asset-search-input");
  const filter = valueOf("asset-type-select");
  return filterAssets(assets, { query, kind: "audio" }).filter((asset) => {
    const folder = asset.folderPath.toLocaleLowerCase();
    if (filter === "music") return folder === "music" || folder.startsWith("music/");
    if (filter === "sfx") return folder === "sfx" || folder.startsWith("sfx/");
    return true;
  });
}

function assetFromDragPayload(dataTransfer: DataTransfer | null): AssetItem | null {
  const payload = parseAssetDragPayload(dataTransfer?.getData(ASSET_DRAG_PAYLOAD_MIME));
  if (!payload) return null;
  return assets.find((candidate) => (
    candidate.kind === payload.kind &&
    candidate.normalizedPath === payload.id
  )) ?? null;
}

function renderAssets(): void {
  const target = element<HTMLElement>("asset-list");
  const visible = filteredAudioAssets();
  if (!visible.length) {
    renderEmptyState(target, "조건에 맞는 음악·효과음이 없습니다", "폴더에 WAV, MP3, AIFF 또는 M4A 파일을 넣고 동기화해 주세요.");
    return;
  }
  target.replaceChildren();
  for (const asset of visible) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = `asset-card draggable-card${asset.id === selectedAssetId ? " is-selected" : ""}`;
    card.draggable = true;
    card.dataset.assetId = asset.id;
    card.setAttribute("role", "listitem");
    card.setAttribute("aria-label", `${asset.name}, 현재 재생 위치에 삽입하려면 두 번 누르세요.`);
    const icon = document.createElement("span");
    icon.className = "asset-kind-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = asset.folderPath.toLocaleLowerCase().startsWith("music") ? "♪" : "SFX";
    const copy = document.createElement("span");
    copy.className = "asset-card-copy";
    const title = document.createElement("strong");
    title.textContent = asset.name;
    const path = document.createElement("small");
    path.textContent = asset.relativePath;
    copy.append(title, path);
    card.append(icon, copy);
    card.addEventListener("click", () => {
      selectedAssetId = asset.id;
      renderAssets();
    });
    card.addEventListener("dblclick", () => void handleInsertAsset(asset));
    card.addEventListener("dragstart", (event) => {
      selectedAssetId = asset.id;
      card.classList.add("is-dragging");
      try {
        event.dataTransfer?.setData(ASSET_DRAG_PAYLOAD_MIME, createAssetDragPayload(asset));
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
      } catch (error) {
        event.preventDefault();
        reportError(error, "자산 드래그 준비 실패");
      }
    });
    card.addEventListener("dragend", () => card.classList.remove("is-dragging"));
    target.append(card);
  }
}

async function handleSyncAssets(): Promise<void> {
  assets = await busy.during("음악·효과음 폴더를 동기화하고 있습니다…", () => ensureAssetLibrary().sync());
  renderAssets();
  const audioCount = assets.filter((asset) => asset.kind === "audio").length;
  const stats = ensureAssetLibrary().lastSyncStats;
  activity.add(stats.truncated ? "warning" : "success", `자산 동기화 완료 · 오디오 ${audioCount}개 · 전체 ${assets.length}개${stats.truncated ? " · 안전 제한 도달" : ""}`);
  toast(`음악·효과음 ${audioCount}개를 동기화했습니다.`, stats.truncated ? "warning" : "success");
}

async function handleInsertAsset(asset: AssetItem): Promise<void> {
  await busy.during(`${asset.name}을(를) 타임라인에 삽입하고 있습니다…`, () => importAndInsertAsset(asset.nativePath, {
    videoTrackIndex: Math.max(0, numberOf("asset-video-track-input", 1) - 1),
    audioTrackIndex: Math.max(0, numberOf("asset-audio-track-input", 2) - 1),
    displayName: asset.name,
  }));
  activity.add("success", `자산 삽입: ${asset.name}`);
  toast("현재 재생 위치에 자산을 삽입했습니다.", "success");
}

function setupAssetDropZone(): void {
  const zone = optionalElement<HTMLElement>("asset-drop-zone");
  if (!zone) return;
  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    zone.classList.add("is-drag-over");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("is-drag-over"));
  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    zone.classList.remove("is-drag-over");
    const asset = assetFromDragPayload(event.dataTransfer);
    if (!asset) {
      toast("드래그한 자산을 현재 라이브러리에서 검증하지 못했습니다.", "warning");
      return;
    }
    void handleInsertAsset(asset).catch((error) => reportError(error, "자산 삽입 실패"));
  });
  zone.addEventListener("click", () => {
    const asset = assets.find((candidate) => candidate.id === selectedAssetId);
    if (asset) void handleInsertAsset(asset).catch((error) => reportError(error, "자산 삽입 실패"));
    else toast("먼저 라이브러리에서 자산을 선택해 주세요.", "warning");
  });
  zone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") zone.click();
  });
}

function setConnectionStatus(
  id: "ai-status" | "speech-status",
  status: "idle" | "connected" | "error",
  message: string,
): void {
  const target = optionalElement<HTMLElement>(id);
  if (!target) return;
  target.classList.toggle("is-idle", status === "idle");
  target.classList.toggle("is-connected", status === "connected");
  target.classList.toggle("is-error", status === "error");
  target.dataset.status = status;
  const label = target.querySelector<HTMLElement>("span:last-child");
  if (label) label.textContent = message;
}

function createImageAIClient(): OpenAIImageClient {
  const current = syncSettingsFromUI();
  imageAIClient = new OpenAIImageClient(createDefaultOpenAIImageAdapter(), {
    endpoint: current.aiEndpoint,
  });
  return imageAIClient;
}

async function initializeAISettings(): Promise<void> {
  try {
    const client = createImageAIClient();
    const storedKey = await client.getApiKey();
    const input = optionalElement<HTMLInputElement>("ai-api-key-input");
    if (input) input.placeholder = storedKey ? "저장된 API 키 유지" : "API 키 입력";
    const state = storedKey ? "connected" : "idle";
    const message = storedKey ? "API 키 저장됨" : "API 키 필요";
    setConnectionStatus("ai-status", state, message);
    setConnectionStatus("speech-status", state, message);
  } catch (error) {
    setConnectionStatus("ai-status", "error", "AI 설정 오류");
    setConnectionStatus("speech-status", "error", "AI 설정 오류");
    reportError(error, "AI 설정 초기화 실패");
  }
}

async function handleAISave(): Promise<void> {
  const client = createImageAIClient();
  const input = element<HTMLInputElement>("ai-api-key-input");
  if (input.value.trim()) {
    await client.setApiKey(input.value);
    input.value = "";
  }
  const hasKey = Boolean(await client.getApiKey());
  input.placeholder = hasKey ? "저장된 API 키 유지" : "API 키 입력";
  setConnectionStatus("ai-status", hasKey ? "connected" : "idle", hasKey ? "설정 저장됨" : "API 키 필요");
  setConnectionStatus("speech-status", hasKey ? "connected" : "idle", hasKey ? "AI 연결 준비됨" : "AI 설정 필요");
  activity.add("success", "AI 연결 설정을 저장했습니다. API 키는 UXP 보안 저장소에만 보관됩니다.");
  toast("AI 설정을 저장했습니다.", "success");
}

async function handleAITest(): Promise<void> {
  const client = createImageAIClient();
  const input = element<HTMLInputElement>("ai-api-key-input");
  if (input.value.trim()) {
    await client.setApiKey(input.value);
    input.value = "";
  }
  setConnectionStatus("ai-status", "idle", "연결 확인 중…");
  await client.testConnection();
  input.placeholder = "저장된 API 키 유지";
  setConnectionStatus("ai-status", "connected", "GPT Image 2 연결됨");
  setConnectionStatus("speech-status", "connected", "AI 연결 준비됨");
  activity.add("success", "OpenAI GPT Image 2 연결 테스트를 통과했습니다.");
  toast("AI 연결이 정상입니다.", "success");
}

function imagePreset(value: string): ImageEditPreset {
  if (["basic", "vivid", "upscale", "remove-bg", "chat"].includes(value)) {
    return value as ImageEditPreset;
  }
  throw new Error("지원하지 않는 AI 이미지 프리셋입니다.");
}

function selectedReferencePromptItems(selectedIds: readonly string[]): ReferenceItem[] {
  if (!referenceController || selectedIds.length === 0) return [];
  const idSet = new Set(selectedIds);
  return referenceController.items
    .filter((item) => item.type === "image" && !item.unavailable && idSet.has(item.id))
    .slice(0, 3)
    .map((item) => ({ ...item }));
}

async function handleThumbnailAI(
  pngBytes: Uint8Array,
  preset: string,
  prompt: string,
): Promise<{ bytes: Uint8Array; name: string }> {
  const client = imageAIClient ?? createImageAIClient();
  const images = [{ bytes: pngBytes, filename: "shortflow-thumbnail.png", mimeType: "image/png" }];
  const selectedReferences = referenceController
    ? await referenceController.getSelectedImageInputs()
    : [];
  if (selectedReferences.length > 3) {
    activity.add("warning", "현재 썸네일을 포함해 AI 입력은 최대 4개이므로 레퍼런스 3개만 사용합니다.");
  }
  const attachedReferences = selectedReferences.slice(0, 3);
  const promptReferences = selectedReferencePromptItems(attachedReferences.map((reference) => reference.id));
  const requestPrompt = promptReferences.length > 0
    ? buildReferencePrompt(promptReferences, prompt)
    : prompt;
  images.push(...attachedReferences.map((reference) => ({
    bytes: reference.bytes,
    filename: reference.name,
    mimeType: reference.mimeType,
  })));
  const request = { images, preset: imagePreset(preset), prompt: requestPrompt };
  const descriptor = {
    model: settings.aiModel,
    preset,
    promptHash: deterministicHash(requestPrompt),
    images: images.map((item) => ({
      name: item.filename,
      mimeType: item.mimeType,
      size: item.bytes.byteLength,
      digest: deterministicHash(item.bytes),
    })),
  };
  const bytes = aiQueueController
    ? await aiQueueController.run("image", descriptor, () => client.editImage(request), {
      estimateUnits: preset === "upscale" ? 6 : 4,
      cacheTtlMs: 0,
    })
    : await client.editImage(request);
  return { bytes, name: `GPT Image 2 · ${preset}` };
}

async function createPremiereSafeZoneOverlay(
  platform: SocialPlatform,
  role: "content" | "caption",
): Promise<void> {
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = 1920;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Safe Zone PNG를 그릴 Canvas 2D 기능을 사용할 수 없습니다.");
  context.clearRect(0, 0, canvas.width, canvas.height);
  const safe = normalizedRectToPixels(safeContentRect(platform, role), canvas.width, canvas.height);
  context.fillStyle = "rgba(255, 60, 92, 0.16)";
  context.fillRect(0, 0, canvas.width, safe.y);
  context.fillRect(0, safe.y + safe.height, canvas.width, canvas.height - safe.y - safe.height);
  context.fillRect(0, safe.y, safe.x, safe.height);
  context.fillRect(safe.x + safe.width, safe.y, canvas.width - safe.x - safe.width, safe.height);
  context.save();
  context.setLineDash([24, 16]);
  context.lineWidth = 8;
  context.strokeStyle = "rgba(71, 215, 172, 0.95)";
  context.strokeRect(safe.x, safe.y, safe.width, safe.height);
  context.restore();
  context.font = "bold 38px sans-serif";
  context.fillStyle = "rgba(255,255,255,.95)";
  context.fillText(`SHORTFLOW GUIDE · ${SAFE_ZONE_PROFILES[platform].label} · ${role.toUpperCase()}`, 32, 58);
  context.font = "bold 26px sans-serif";
  context.fillStyle = "rgba(255,95,120,.95)";
  context.fillText("EXPORT 전에 이 가이드 클립을 삭제하세요", 32, 100);
  const bytes = await canvasToPngBytes(canvas);
  const uxpRoot = require("uxp") as any;
  const fileSystem = uxpRoot?.storage?.localFileSystem;
  const dataFolder = await fileSystem?.getDataFolder?.();
  if (!dataFolder?.createFile) throw new Error("Safe Zone 가이드를 저장할 UXP 데이터 폴더를 사용할 수 없습니다.");
  const filename = `__SHORTFLOW_SAFE_GUIDE_DO_NOT_EXPORT__${platform}_${role}.png`;
  const file = await dataFolder.createFile(filename, { overwrite: true });
  const binary = uxpRoot?.storage?.formats?.binary;
  await file.write(bytes.slice().buffer, { format: binary });
  const status = await readSequenceStatus();
  if (status.videoTrackCount >= 99) throw new Error("가이드용 비디오 트랙을 추가할 수 없습니다. 비디오 트랙 수를 줄여 주세요.");
  const duration = Math.max(0.1, status.sequenceEnd - status.playerPosition);
  await importAndInsertAsset(String(file.nativePath ?? ""), {
    videoTrackIndex: status.videoTrackCount,
    audioTrackIndex: 0,
    displayName: filename,
    durationSeconds: duration,
  });
  activity.add("warning", `Safe Zone 가이드를 최상단 트랙에 삽입했습니다. 내보내기 전 반드시 삭제하세요: ${filename}`);
  toast("Safe Zone 가이드를 삽입했습니다. 내보내기 전 삭제해 주세요.", "warning", 7000);
}

function guarded(handler: () => Promise<void>, context: string): () => Promise<void> {
  return async () => {
    try {
      await handler();
    } catch (error) {
      reportError(error, context);
    }
  };
}

function bindCoreEvents(): void {
  bind("refresh-btn", "click", guarded(() => refreshStatus().then(() => undefined), "상태 새로고침 실패"));
  bind("qc-btn", "click", guarded(handleQC, "QC 실패"));
  bind("create-short-btn", "click", guarded(handleCreateShort, "숏폼 생성 실패"));
  bind("scan-markers-btn", "click", guarded(handleScanMarkers, "마커 검색 실패"));
  bind("batch-create-btn", "click", guarded(handleBatchCreate, "일괄 생성 실패"));
  bind("add-story-markers-btn", "click", guarded(handleStoryMarkers, "스토리 마커 추가 실패"));
  bind("choose-preset-btn", "click", guarded(handleChoosePreset, "프리셋 선택 실패"));
  bind("choose-output-btn", "click", guarded(handleChooseOutput, "출력 폴더 선택 실패"));
  bind("choose-mogrt-btn", "click", guarded(handleChooseMogrt, "MOGRT 선택 실패"));
  bind("insert-mogrt-btn", "click", guarded(handleInsertMogrt, "MOGRT 삽입 실패"));
  bind("export-video-btn", "click", guarded(handleExportVideo, "영상 내보내기 실패"));
  bind("export-cover-btn", "click", guarded(handleExportCover, "커버 저장 실패"));
  bind("choose-asset-root-btn", "click", guarded(handleChooseAssetRoot, "자산 폴더 선택 실패"));
  bind("open-asset-root-btn", "click", guarded(handleOpenAssetRoot, "자산 폴더 열기 실패"));
  bind("sync-assets-btn", "click", guarded(handleSyncAssets, "자산 동기화 실패"));
  bind("asset-search-input", "input", () => renderAssets());
  bind("asset-type-select", "change", () => renderAssets());
  bind("ai-save-btn", "click", guarded(handleAISave, "AI 설정 저장 실패"));
  bind("ai-test-btn", "click", guarded(handleAITest, "AI 연결 테스트 실패"));
  bind("clear-log-btn", "click", () => activity.clear());
  bind("run-diagnostics-btn", "click", guarded(handleRunDiagnostics, "시스템 진단 실패"));
  bind("export-diagnostics-btn", "click", guarded(handleExportDiagnostics, "진단 JSON 저장 실패"));

  bind("preset-select", "change", () => {
    const id = valueOf("preset-select");
    if (id !== "custom") {
      const profile = profileById(id);
      setValue("width-input", profile.width);
      setValue("height-input", profile.height);
      setValue("max-duration-input", Math.min(profile.maxDuration, 600));
      setValue("name-input", `ShortFlow_${profile.width}x${profile.height}`);
    }
    syncSettingsFromUI();
  });

  for (const id of [
    "width-input", "height-input", "name-input", "range-select", "max-duration-input",
    "reframe-select", "scope-select", "center-checkbox", "hook-seconds-input", "cta-seconds-input",
    "mogrt-track-input", "export-mode-select", "export-range-select",
    "tts-model-select", "tts-voice-select", "tts-format-select", "tts-speed-input",
    "tts-audio-track-input", "stt-model-select", "stt-language-input", "stt-output-format-select",
    "ai-provider-select", "ai-endpoint-input", "ai-model-input",
  ]) {
    bind(id, "change", () => {
      syncSettingsFromUI();
    });
  }
  setupAssetDropZone();
}

async function bootstrap(): Promise<void> {
  if (initialized) return;
  initialized = true;
  applySettingsToUI();
  bindCoreEvents();
  renderDiagnosticsReport(null);
  await initializeAssetLibrary();
  try {
    referenceController = new ReferenceController({
      onActivity: (message) => activity.add("success", message),
      onError: (error, context) => reportError(error, context),
      onSelectionChange: (ids) => activity.add("info", `AI 이미지 레퍼런스 ${ids.length}개 선택`),
    });
    await referenceController.initialize();
  } catch (error) {
    referenceController = null;
    reportError(error, "레퍼런스 보드 초기화 실패");
  }
  await initializeAISettings();
  try {
    aiQueueController = new AIQueueController({
      onActivity: (message) => activity.add("success", message),
      onError: (error, context) => reportError(error, context),
    });
    await aiQueueController.initialize();
  } catch (error) {
    aiQueueController = null;
    reportError(error, "AI 작업 큐 초기화 실패");
  }
  try {
    thumbnailController = await initializeThumbnailController({
      onActivity: (message) => activity.add("success", message),
      onError: (error, context) => reportError(error, context),
      onAIRequest: handleThumbnailAI,
    });
  } catch (error) {
    thumbnailController = null;
    reportError(error, "썸네일 편집기 초기화 실패");
  }
  try {
    brandKitController = new BrandKitController({
      onActivity: (message) => activity.add("success", message),
      onError: (error, context) => reportError(error, context),
      getMogrtPreset: () => ({
        token: settings.mogrtToken,
        name: settings.mogrtName,
        track: settings.mogrtTrack,
      }),
      onApply: async (kit) => {
        updateSettings({
          ttsModel: kit.tts.model,
          ttsVoice: kit.tts.voice,
          ttsSpeed: kit.tts.speed,
          mogrtToken: kit.mogrt.token,
          mogrtName: kit.mogrt.name,
          mogrtTrack: kit.mogrt.track,
        });
        applySettingsToUI();
        await thumbnailController?.applyBrandDefaults(kit.thumbnail);
        setValue("subtitle-max-chars-input", kit.caption.maxChars);
        optionalElement<HTMLInputElement>("subtitle-max-chars-input")?.dispatchEvent(new Event("change"));
        document.dispatchEvent(new CustomEvent("shortflow:brand-kit-applied", { detail: kit }));
        toast(`브랜드 키트를 적용했습니다: ${kit.name}`, "success");
      },
    });
    await brandKitController.initialize();
  } catch (error) {
    brandKitController = null;
    reportError(error, "브랜드 키트 초기화 실패");
  }
  try {
    const browserStorage = (globalThis as unknown as { localStorage?: Storage }).localStorage;
    recoveryManager = new RecoveryManager(browserStorage ? { storage: browserStorage } : {});
    recoveryManager.subscribe((event) => {
      renderRecoveryJournal();
      if (event.type === "persistence-error") {
        activity.add("warning", event.message ?? "복구 기록을 저장하지 못했습니다.");
      }
    });
    const interrupted = await recoveryManager.restore();
    if (interrupted > 0) {
      activity.add("warning", `이전 세션에서 중단된 비파괴 작업 ${interrupted}개를 복구 목록에 표시했습니다.`);
      toast(`중단된 작업 ${interrupted}개를 확인해 주세요.`, "warning", 6200);
    }
    renderRecoveryJournal();
  } catch (error) {
    recoveryManager = null;
    reportError(error, "복구 기록 초기화 실패");
  }
  try {
    automationController = new AutomationController({
      getTranscript: () => {
        const transcript = speechController?.transcript;
        return transcript
          ? {
            name: transcript.name,
            duration: transcript.duration,
            segments: transcript.result.segments,
          }
          : null;
      },
      onActivity: (message) => activity.add("success", message),
      onError: (error, context) => reportError(error, context),
      onAddMarkers: async (plan, cues) => {
        const result = await addAutomationMarkers(plan, cues);
        activity.add("success", `Premiere 추천 마커 추가 · CUT ${result.cutMarkers}개 · ZOOM ${result.punchMarkers}개`);
        toast("자동 편집 추천 마커를 추가했습니다.", "success");
      },
      onApply: async (plan, cues) => {
        let operationId = "";
        try {
          const result = await applyAutomationPlan(plan, cues, {
            onClonePrepared: async ({ sourceGuid, cloneGuid, sequenceName }) => {
              if (!recoveryManager) return;
              try {
                const entry = recoveryManager.begin({
                  kind: "automation-plan",
                  label: `비파괴 자동 편집 · ${sequenceName}`,
                  beforeSummary: {
                    sequenceGuid: sourceGuid,
                    duration: plan.sourceDuration,
                    cutMarkers: 0,
                    punchCues: 0,
                  },
                  afterSummary: {
                    sequenceGuid: cloneGuid,
                    duration: plan.outputDuration,
                    cutMarkers: plan.cuts.length,
                    punchCues: cues.length,
                  },
                  clonePolicy: {
                    sourceId: sourceGuid,
                    cloneId: cloneGuid,
                    createdBeforeMutation: true,
                    verified: true,
                  },
                });
                operationId = entry.operationId;
              } catch (error) {
                await removeVerifiedClonedSequence(sourceGuid, cloneGuid).catch(() => undefined);
                throw error;
              }
            },
          });
          if (operationId) {
            recoveryManager?.commit(
              operationId,
              {
                sequenceName: result.sequenceName,
                duration: plan.outputDuration,
                cutMarkers: result.cutMarkers,
                punchCues: result.punchMarkers,
              },
              result,
            );
          }
          activity.add("success", `비파괴 자동 편집 시퀀스 생성: ${result.sequenceName} · 펀치인 클립 ${result.punchedClips}개`);
          for (const warning of result.warnings) activity.add("warning", warning);
          toast(`복제 시퀀스에 펀치인을 적용했습니다: ${result.sequenceName}`, result.warnings.length ? "warning" : "success", 6200);
          await refreshStatus(true);
        } catch (error) {
          if (operationId) {
            try { recoveryManager?.fail(operationId, error); } catch { /* journal already reached a terminal state */ }
          }
          throw error;
        } finally {
          renderRecoveryJournal();
        }
      },
      onCreateSafeOverlay: createPremiereSafeZoneOverlay,
      onAlignSafeZone: async (alignment) => {
        if (!alignment.changed) return;
        const result = await alignSelectedVideoToSafeZone(alignment.rect);
        activity.add("success", `Safe Zone 정렬 · 선택 ${result.selected}개 · 변경 ${result.changed}개 · 건너뜀 ${result.skipped}개`);
        for (const warning of result.warnings) activity.add("warning", warning);
      },
    });
    await automationController.initialize();
  } catch (error) {
    automationController = null;
    reportError(error, "자동 편집/Safe Zone 초기화 실패");
  }
  try {
    subtitleController = new SubtitleController({
      getProjectKey: subtitleProjectKey,
      onSeek: (seconds) => setSequencePlayerPosition(seconds),
      onImportSrt: readSrtFile,
      onExportSrt: writeSrtFile,
      aiProvider: runSubtitleAI,
      onActivity: (message) => activity.add("success", message),
      onError: (error, context) => reportError(error, context),
    });
    await subtitleController.initialize();
  } catch (error) {
    subtitleController = null;
    reportError(error, "자막 편집기 초기화 실패");
  }
  try {
    speechController = new SpeechController({
      getSettings: () => settings,
      updateSettings,
      onActivity: (message) => activity.add("success", message),
      onError: (error, context) => reportError(error, context),
      onTranscript: (transcript) => {
        automationController?.setTranscript({
          name: transcript.name,
          duration: transcript.duration,
          segments: transcript.result.segments,
        });
        if (subtitleController && transcript.result.segments.length > 0) {
          subtitleController.setDocument(createSubtitleDocument(
            subtitleController.projectKey,
            transcript.result.segments.map((segment, index) => ({
              cueId: `stt_${String(index + 1).padStart(5, "0")}_${deterministicHash({
                start: segment.start,
                end: segment.end,
                text: segment.text,
              })}`,
              start: segment.start,
              end: segment.end,
              text: segment.speaker ? `[${segment.speaker}] ${segment.text}` : segment.text,
              enabled: true,
              hidden: false,
            })),
          ));
        }
      },
      runTts: (request) => {
        const client = new SpeechApiClient({ endpoint: settings.aiEndpoint });
        if (!aiQueueController) return client.synthesize(request);
        return aiQueueController.run("tts", {
          model: request.model,
          voice: request.voice,
          format: request.format,
          speed: request.speed,
          textHash: deterministicHash(request.text),
          instructionsHash: deterministicHash(request.instructions ?? ""),
        }, () => client.synthesize(request), { estimateUnits: 1, cacheTtlMs: 0 });
      },
      runStt: (request) => {
        const client = new SpeechApiClient({ endpoint: settings.aiEndpoint });
        if (!aiQueueController) return client.transcribe(request);
        return aiQueueController.run("stt", {
          model: request.model,
          language: request.language ?? "",
          filenameHash: deterministicHash(request.filename),
          mediaSize: request.bytes.byteLength,
          mediaDigest: deterministicHash(request.bytes),
          promptHash: deterministicHash(request.prompt ?? ""),
        }, () => client.transcribe(request), { estimateUnits: 2, cacheTtlMs: 0 });
      },
    });
    await speechController.initialize();
  } catch (error) {
    speechController = null;
    reportError(error, "TTS/STT 초기화 실패");
  }
  try {
    finalQCController = new FinalQCController({
      getSnapshot: buildFinalQCSnapshot,
      onActivity: (message) => activity.add("info", message),
      onError: (error, context) => reportError(error, context),
      onReport: (report) => {
        toast(
          report.blocking ? "최종 QC 오류로 내보내기가 차단됩니다." : report.status === "warning" ? "최종 QC를 조건부 통과했습니다." : "최종 QC를 통과했습니다.",
          report.blocking ? "error" : report.status === "warning" ? "warning" : "success",
          5600,
        );
      },
    });
    finalQCController.initialize();
  } catch (error) {
    finalQCController = null;
    reportError(error, "최종 QC 게이트 초기화 실패");
  }
  await refreshStatus(true);
  activity.add("info", "ShortFlow Studio가 준비되었습니다.");
}

entrypoints.setup({
  panels: {
    shortflowPanel: {
      show() {
        void bootstrap()
          .then(() => startSubtitlePlayheadTracking())
          .catch((error) => reportError(error, "플러그인 초기화 실패"));
      },
      hide() {
        stopSubtitlePlayheadTracking();
      },
    },
  },
});

setupTabs();
