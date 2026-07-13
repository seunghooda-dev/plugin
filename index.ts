import { PROFILES, formatDuration } from "./src/core";
import { normalizeNativePath, type AssetItem } from "./src/asset-library";
import { createAssetBrowserPanel } from "./src/asset-browser-panel";
import { createMarkersQcPanel } from "./src/markers-qc-panel";
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
  readActiveContextKey,
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
  type ImageGenerateSize,
} from "./src/ai";
import {
  initializeThumbnailController,
  type ThumbnailAIInput,
  type ThumbnailController,
} from "./src/thumbnail-controller";
import { SpeechController } from "./src/speech-controller";
import { AutomationController } from "./src/automation-controller";
import { BrandKitController } from "./src/brand-kit-controller";
import { AIQueueController } from "./src/ai-queue-controller";
import { deterministicHash } from "./src/job-queue";
import { SpeechApiClient } from "./src/speech";
import {
  renderSafeZoneGuideBmp,
  safeZoneGuideLabel,
  type SocialPlatform,
} from "./src/safe-zone";
import { FinalQCController } from "./src/final-qc-controller";
import type { FinalQCSnapshot } from "./src/final-qc";
import {
  AssetRightsRegistry,
  createAssetRightsReport,
  createMissingAssetRightsRecord,
  createReferenceAssetRightsRecord,
  createTtsAssetRightsRecord,
  normalizeAssetRightsRecord,
  type AssetRightsInput,
  type AssetRightsRecord,
} from "./src/asset-rights";
import { SubtitleController, type SubtitleAiRequest, type SubtitleAnalysisRequest } from "./src/subtitle-controller";
import { resolveAutomationTranscript, subtitleDocumentToAutomationTranscript } from "./src/automation-transcript";
import { createSubtitleDocument } from "./src/subtitles";
import { OpenAITextClient, chunkSubtitleCues } from "./src/openai-text";
import {
  buildReferencePrompt,
  type ReferenceFileEntry,
  type ReferenceItem,
} from "./src/references";
import { RecoveryManager } from "./src/recovery";
import { createRecoveryPanel } from "./src/recovery-panel";
import { installTextEncodingPolyfill } from "./src/text-encoding";
import { createAiSettingsPanel } from "./src/ai-settings-panel";
import { createDiagnosticsPanel } from "./src/diagnostics-panel";
import {
  ActivityLog,
  BusyState,
  bind,
  checkedOf,
  numberOf,
  optionalElement,
  setChecked,
  setText,
  setValue,
  setupTabs,
  toast,
  valueOf,
} from "./src/ui";

const { entrypoints } = require("uxp") as any;
const ASSET_RIGHTS_EMPTY_STATUS = "선택한 음악·효과음·이미지·영상·AI 에셋의 권리 정보를 기록하면 최종 QC에 반영됩니다.";
const SESSION_FALLBACK_PROJECT_KEY = "session";

installTextEncodingPolyfill();

const activity = new ActivityLog();
const busy = new BusyState();
let settings: PluginSettings = loadSettings();
let initialized = false;
const sessionGeneratedAssetRightsIdsByProject = new Map<string, Set<string>>();
let assetRightsRegistry: AssetRightsRegistry | null = null;
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
let statusRefreshGeneration = 0;
let recoveryManager: RecoveryManager | null = null;

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

function ensureAssetRightsRegistry(): AssetRightsRegistry {
  if (!assetRightsRegistry) {
    assetRightsRegistry = new AssetRightsRegistry(localStorage);
  }
  return assetRightsRegistry;
}

function assetRightsFor(asset: AssetItem): AssetRightsRecord {
  return ensureAssetRightsRegistry().items.find((record) => record.assetId === asset.normalizedPath) ??
    createMissingAssetRightsRecord(asset);
}

function rememberSessionGeneratedAssetRights(assetId: string, projectKey = SESSION_FALLBACK_PROJECT_KEY): void {
  const key = projectKey.trim() || SESSION_FALLBACK_PROJECT_KEY;
  const ids = sessionGeneratedAssetRightsIdsByProject.get(key) ?? new Set<string>();
  ids.add(assetId);
  sessionGeneratedAssetRightsIdsByProject.set(key, ids);
}

function sessionGeneratedAssetRightsIds(projectKey = SESSION_FALLBACK_PROJECT_KEY): ReadonlySet<string> {
  return sessionGeneratedAssetRightsIdsByProject.get(projectKey.trim() || SESSION_FALLBACK_PROJECT_KEY) ?? new Set<string>();
}

function currentAssetRightsRecords(projectKey = SESSION_FALLBACK_PROJECT_KEY): AssetRightsRecord[] {
  const registry = ensureAssetRightsRegistry();
  const byId = new Map(registry.items.map((record) => [record.assetId, record]));
  const libraryRecords = assetBrowserPanel.getAssets()
    .filter((asset) => asset.kind === "audio" || asset.kind === "image" || asset.kind === "video")
    .map((asset) => byId.get(asset.normalizedPath) ?? createMissingAssetRightsRecord(asset));
  const referenceRecords = (referenceController?.items ?? [])
    .map((reference) => {
      try {
        const fallback = createReferenceAssetRightsRecord(reference);
        const nativePath = typeof reference.nativePath === "string" ? reference.nativePath : "";
        const normalizedReferenceId = nativePath ? normalizeNativePath(nativePath) : fallback.assetId;
        const registryRecord = byId.get(fallback.assetId) ?? byId.get(normalizedReferenceId);
        if (registryRecord) return registryRecord;
        return normalizedReferenceId === fallback.assetId
          ? fallback
          : normalizeAssetRightsRecord({ ...fallback, assetId: normalizedReferenceId }, fallback.updatedAt);
      } catch {
        return null;
      }
    })
    .filter((record): record is AssetRightsRecord => Boolean(record));
  const visibleRecords = [...libraryRecords, ...referenceRecords];
  const visibleIds = new Set(visibleRecords.map((record) => record.assetId));
  const sessionGeneratedIds = sessionGeneratedAssetRightsIds(projectKey);
  const registryOnlyRecords = registry.items.filter((record) => (
    !visibleIds.has(record.assetId) && sessionGeneratedIds.has(record.assetId)
  ));
  return [...visibleRecords, ...registryOnlyRecords];
}

function rightsInputFor(asset: AssetItem): AssetRightsInput {
  return {
    assetId: asset.normalizedPath,
    assetName: asset.name,
    kind: valueOf("asset-rights-kind-select"),
    source: valueOf("asset-rights-source-input"),
    license: valueOf("asset-rights-license-input"),
    commercialUse: valueOf("asset-rights-commercial-select"),
    expiresAt: valueOf("asset-rights-expiry-input"),
    attribution: valueOf("asset-rights-attribution-input"),
    notes: valueOf("asset-rights-notes-input"),
    updatedAt: Date.now(),
  };
}

function renderAssetRights(asset: AssetItem | null): void {
  const selected = Boolean(asset);
  for (const id of [
    "asset-rights-kind-select",
    "asset-rights-source-input",
    "asset-rights-license-input",
    "asset-rights-commercial-select",
    "asset-rights-expiry-input",
    "asset-rights-attribution-input",
    "asset-rights-notes-input",
    "asset-rights-save-btn",
  ]) {
    const field = optionalElement<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>(id);
    if (field) field.disabled = !selected;
  }
  if (!asset) {
    setText("asset-rights-selected-name", "에셋을 선택해 주세요");
    setValue("asset-rights-kind-select", "other");
    setValue("asset-rights-source-input", "");
    setValue("asset-rights-license-input", "");
    setValue("asset-rights-commercial-select", "unknown");
    setValue("asset-rights-expiry-input", "");
    setValue("asset-rights-attribution-input", "");
    setValue("asset-rights-notes-input", "");
    setText("asset-rights-status", ASSET_RIGHTS_EMPTY_STATUS);
    return;
  }

  const record = assetRightsFor(asset);
  setText("asset-rights-selected-name", asset.name, asset.nativePath);
  setValue("asset-rights-kind-select", record.kind);
  setValue("asset-rights-source-input", record.source);
  setValue("asset-rights-license-input", record.license);
  setValue("asset-rights-commercial-select", record.commercialUse);
  setValue("asset-rights-expiry-input", record.expiresAt ?? "");
  setValue("asset-rights-attribution-input", record.attribution);
  setValue("asset-rights-notes-input", record.notes);
  const issueCount = createAssetRightsReport([record]).issues.length;
  setText("asset-rights-status", issueCount === 0
    ? "권리 정보가 충분히 기록되었습니다."
    : `권리 정보 확인 필요 · 경고/오류 ${issueCount}개`);
}

const assetBrowserPanel = createAssetBrowserPanel({
  runBusy: (message, task) => busy.during(message, task),
  onActivity: (level, message) => activity.add(level, message),
  onError: reportError,
  formatError: errorMessage,
  getAssetRootName: () => settings.assetRootName,
  setAssetRootName: (name) => { settings.assetRootName = name; },
  persistSettings: saveCurrentSettings,
  ensureRightsRegistry: ensureAssetRightsRegistry,
  renderRights: renderAssetRights,
  insertToTimeline: importAndInsertAsset,
  previewInSourceMonitor: (asset) => previewAssetInPremiereSourceMonitor(asset),
});

async function previewAssetInPremiereSourceMonitor(asset: AssetItem): Promise<boolean> {
  const current = assetBrowserPanel.getAssets().find((candidate) =>
    candidate.id === asset.id &&
    candidate.normalizedPath === asset.normalizedPath &&
    candidate.nativePath === asset.nativePath);
  if (!current) throw new Error("현재 동기화된 오디오가 아닙니다. 음악·효과음 폴더를 다시 동기화해 주세요.");

  const premiere = require("premierepro") as any;
  const sourceMonitor = premiere?.SourceMonitor;
  if (typeof sourceMonitor?.openFilePath !== "function") {
    await assetBrowserPanel.openAssetFile(current);
    return false;
  }
  const opened = await sourceMonitor.openFilePath(current.nativePath);
  if (opened === false) throw new Error("Premiere 소스 모니터에서 오디오 파일을 열지 못했습니다.");
  if (typeof sourceMonitor.play !== "function") return false;
  try {
    return (await sourceMonitor.play(1)) !== false;
  } catch {
    return false;
  }
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
      rightsReport: createAssetRightsReport(currentAssetRightsRecords(subtitleProjectKeyFromStatus(status))),
    },
    output: {
      fileName: valueOf("final-qc-output-name"),
      directoryPath: outputPath,
    },
  };
}

function subtitleProjectKeyFromStatus(status: Pick<SequenceStatus, "projectPath" | "sequenceGuid">): string {
  return `project-${deterministicHash({ path: status.projectPath, sequence: status.sequenceGuid })}`;
}

async function subtitleProjectKey(): Promise<string> {
  try {
    return subtitleProjectKeyFromStatus(await readSequenceStatus());
  } catch {
    return SESSION_FALLBACK_PROJECT_KEY;
  }
}

async function readSrtFile(): Promise<string | null> {
  const uxpRoot = require("uxp") as any;
  const selected = await uxpRoot?.storage?.localFileSystem?.getFileForOpening?.({ types: ["srt", "json"], allowMultiple: false });
  const file = Array.isArray(selected) ? selected[0] : selected;
  if (!file) return null;
  const value = await file.read({ format: uxpRoot?.storage?.formats?.utf8 });
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value as ArrayBufferView);
  throw new Error("SRT/Whisper JSON 파일을 UTF-8 텍스트로 읽지 못했습니다.");
}

async function writeSrtFile(srt: string, suggestedName: string): Promise<void> {
  const uxpRoot = require("uxp") as any;
  const file = await uxpRoot?.storage?.localFileSystem?.getFileForSaving?.(suggestedName, { types: ["srt"] });
  if (!file) return;
  await file.write(srt, { format: uxpRoot?.storage?.formats?.utf8 });
}

async function runSubtitleAI(request: SubtitleAiRequest): Promise<unknown> {
  ensureAiConsent("AI 자막");
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

async function runSubtitleAnalysis(request: SubtitleAnalysisRequest): Promise<unknown> {
  ensureAiConsent("AI 자막 분석");
  const batches = chunkSubtitleCues(request.document.cues).length;
  const descriptor = {
    action: request.action,
    documentHash: deterministicHash(request.document),
    cueCount: request.document.cues.length,
    batchCount: batches,
    model: "gpt-5.4-mini",
  };
  const task = () => new OpenAITextClient({
    endpoint: settings.aiEndpoint,
    onProgress: (completed, total) => activity.add("info", `AI 자막 분석 ${completed}/${total} 묶음 처리`),
  }).analyzeSubtitles(request);
  return aiQueueController
    ? aiQueueController.run("text", descriptor, task, {
      estimateUnits: Math.max(1, batches),
      cacheTtlMs: 0,
      confirmRequired: batches > 10,
    })
    : task();
}

async function runPromptEnrich(prompt: string): Promise<string> {
  ensureAiConsent("AI 프롬프트 보강");
  const descriptor = {
    action: "prompt-enrich",
    promptHash: deterministicHash(prompt),
    model: "gpt-5.4-mini",
  };
  const task = () => new OpenAITextClient({ endpoint: settings.aiEndpoint }).enrichPrompt(prompt);
  return aiQueueController
    ? aiQueueController.run("text", descriptor, task, { estimateUnits: 1, cacheTtlMs: 0 })
    : task();
}

function startSubtitlePlayheadTracking(): void {
  if (subtitlePlayheadTimer !== null) return;
  subtitlePlayheadTimer = setInterval(() => {
    const controller = subtitleController;
    if (!controller || controller.cueCount === 0) return;
    void readPlayerPositionSeconds()
      .then((seconds) => controller.updatePlayhead(seconds))
      .catch(() => undefined);
  }, 350);
}

function stopSubtitlePlayheadTracking(): void {
  if (subtitlePlayheadTimer !== null) clearInterval(subtitlePlayheadTimer);
  subtitlePlayheadTimer = null;
}

const recoveryPanel = createRecoveryPanel({
  getManager: () => recoveryManager,
  removeClone: removeVerifiedClonedSequence,
  onActivity: (level, message) => activity.add(level, message),
  onError: reportError,
});

function localDiagnosticsContext(): Record<string, unknown> {
  const recoveryEntries = recoveryManager?.list() ?? [];
  const recoveryByStatus = recoveryEntries.reduce<Record<string, number>>((counts, entry) => {
    counts[entry.status] = (counts[entry.status] ?? 0) + 1;
    return counts;
  }, {});
  return {
    plugin: "shortflow-studio",
    reportPurpose: "user-initiated-local-export",
    settings: {
      profileId: settings.profileId,
      width: settings.width,
      height: settings.height,
      rangeMode: settings.rangeMode,
      reframeMode: settings.reframeMode,
      scope: settings.scope,
      exportMode: settings.exportMode,
      exportRange: settings.exportRange,
      ttsModel: settings.ttsModel,
      ttsFormat: settings.ttsFormat,
      ttsSpeed: settings.ttsSpeed,
      ttsAudioTrack: settings.ttsAudioTrack,
      sttModel: settings.sttModel,
      sttLanguage: settings.sttLanguage,
      sttOutputFormat: settings.sttOutputFormat,
      aiConsentAccepted: settings.aiConsentAccepted,
    },
    workspace: {
      assetCount: assetBrowserPanel.getAssets().length,
      audioAssetCount: assetBrowserPanel.getAssets().filter((asset) => asset.kind === "audio").length,
      selectedAsset: Boolean(assetBrowserPanel.getSelectedAssetId()),
      referenceCount: referenceController?.items.length ?? 0,
      thumbnailReady: Boolean(thumbnailController),
      subtitlesReady: Boolean(subtitleController),
      speechReady: Boolean(speechController),
    },
    recovery: {
      count: recoveryEntries.length,
      byStatus: recoveryByStatus,
      interruptedCount: recoveryByStatus.interrupted ?? 0,
      failedCount: (recoveryByStatus.failed ?? 0) + (recoveryByStatus["rollback-failed"] ?? 0),
    },
  };
}

const diagnosticsPanel = createDiagnosticsPanel({
  runBusy: (message, task) => busy.during(message, task),
  onActivity: (level, message) => activity.add(level, message),
  getLocalContext: localDiagnosticsContext,
});

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
  setChecked("ai-consent-checkbox", settings.aiConsentAccepted);
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
    aiConsentAccepted: checkedOf("ai-consent-checkbox"),
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

function ensureAiConsent(context: string): void {
  syncSettingsFromUI();
  if (!settings.aiConsentAccepted) {
    optionalElement<HTMLInputElement>("ai-consent-checkbox")?.focus();
    throw new Error(`${context} 실행 전 AI 전송·개인정보·권리·AI 음성 고지 동의가 필요합니다.`);
  }
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
  setText("status-playhead", formatDuration(status.playerPosition));
  const inOut = `${formatDuration(status.inPoint)} → ${formatDuration(status.outPoint)}`;
  setText("status-inout", inOut, inOut);
  const selection = status.selectedItemCount > 0
    ? `타임라인 ${status.selectedItemCount}개 선택 · ${formatDuration((status.selectedEnd ?? 0) - (status.selectedStart ?? 0))}`
    : "타임라인 선택 없음";
  setText("status-selection", selection, selection);
  setText("qc-status-sequence", status.sequenceName, status.sequenceName);
  setText("qc-status-frame", `${status.width} × ${status.height}`);
  setText("qc-status-duration", formatDuration(status.effectiveDuration || status.sequenceEnd));
  setText("qc-status-playhead", formatDuration(status.playerPosition));
  setText("qc-status-selection", selection, selection);
}

async function refreshStatus(silent = false): Promise<SequenceStatus | null> {
  const generation = ++statusRefreshGeneration;
  try {
    const status = await readSequenceStatus();
    if (generation !== statusRefreshGeneration) return status;
    renderStatus(status);
    const controller = subtitleController;
    const projectKey = subtitleProjectKeyFromStatus(status);
    if (controller && controller.projectKey !== projectKey) {
      try {
        await controller.loadProject(projectKey);
      } catch (error) {
        if (generation === statusRefreshGeneration) {
          if (silent) activity.add("error", `자막 프로젝트 동기화 실패: ${errorMessage(error)}`);
          else reportError(error, "자막 프로젝트 동기화 실패");
        }
      }
    }
    if (generation !== statusRefreshGeneration) return status;
    if (!silent) activity.add("info", `활성 시퀀스 확인: ${status.sequenceName}`);
    return status;
  } catch (error) {
    if (generation !== statusRefreshGeneration) return null;
    setText("status-project", "Premiere 연결 필요");
    setText("status-sequence", "활성 시퀀스 없음");
    setText("status-frame", "—");
    setText("status-duration", "—");
    setText("status-playhead", "—");
    setText("status-inout", "—");
    setText("status-selection", "—");
    setText("qc-status-sequence", "활성 시퀀스 없음");
    setText("qc-status-frame", "—");
    setText("qc-status-duration", "—");
    setText("qc-status-playhead", "—");
    setText("qc-status-selection", "—");
    if (!silent) reportError(error, "프로젝트 상태 확인 실패");
    return null;
  }
}

const markersQcPanel = createMarkersQcPanel({
  runBusy: (message, task) => busy.during(message, task),
  onActivity: (level, message) => activity.add(level, message),
  syncSettings: syncSettingsFromUI,
  getCreateOptions: createOptions,
  renderStatus,
  refreshStatus,
  runSequenceQC,
  createShort,
  scanShortMarkers,
  createShortsFromMarkers,
  addStoryMarkers,
});

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

async function handleSaveAssetRights(): Promise<void> {
  const asset = assetBrowserPanel.getSelectedAsset();
  if (!asset) throw new Error("권리 정보를 저장할 에셋을 먼저 선택해 주세요.");
  const record = await ensureAssetRightsRegistry().upsert(rightsInputFor(asset));
  renderAssetRights(asset);
  activity.add("success", `권리 정보 저장: ${record.assetName}`);
  toast("에셋 권리 정보를 저장했습니다.", "success");
}

function createImageAIClient(): OpenAIImageClient {
  const current = syncSettingsFromUI();
  imageAIClient = new OpenAIImageClient(createDefaultOpenAIImageAdapter(), {
    endpoint: current.aiEndpoint,
  });
  return imageAIClient;
}

const aiSettingsPanel = createAiSettingsPanel({
  createClient: createImageAIClient,
  ensureConsent: () => ensureAiConsent("AI 연결 테스트"),
  onActivity: (level, message) => activity.add(level, message),
  onError: reportError,
});

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
    .filter((item) => !item.unavailable && idSet.has(item.id))
    .slice(0, 8)
    .map((item) => ({ ...item }));
}

async function handleThumbnailAI(
  input: ThumbnailAIInput,
  preset: string,
  prompt: string,
): Promise<{ bytes: Uint8Array; name: string }> {
  ensureAiConsent("썸네일 AI");
  const client = imageAIClient ?? createImageAIClient();
  const images = [{ bytes: input.bytes, filename: input.filename, mimeType: input.mimeType }];
  const selectedReferences = referenceController
    ? await referenceController.getSelectedImageInputs()
    : [];
  if (selectedReferences.length > 3) {
    activity.add("warning", "현재 썸네일을 포함해 AI 입력은 최대 4개이므로 레퍼런스 3개만 사용합니다.");
  }
  const attachedReferences = selectedReferences.slice(0, 3);
  const promptReferences = selectedReferencePromptItems(referenceController?.selectedIds ?? []);
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

function imageGenerateSize(value: string): ImageGenerateSize | undefined {
  return value === "1024x1024" || value === "1536x1024" || value === "1024x1536"
    ? value
    : undefined;
}

// 생성 바이트를 플러그인 데이터 폴더에 PNG로 쓰고, 레퍼런스 라이브러리가 토큰화할 수 있는 파일 엔트리를 돌려준다.
async function writeGeneratedReferenceFile(bytes: Uint8Array): Promise<ReferenceFileEntry> {
  let uxp: any;
  try {
    uxp = require("uxp");
  } catch {
    throw new Error("Premiere Pro UXP 환경에서 실행해 주세요.");
  }
  const storage = uxp?.storage;
  const fileSystem = storage?.localFileSystem;
  if (!fileSystem || typeof fileSystem.getDataFolder !== "function") {
    throw new Error("UXP 데이터 폴더 API를 사용할 수 없어 생성 이미지를 저장하지 못했습니다.");
  }
  const folder = await fileSystem.getDataFolder();
  const file = await folder.createFile(`ai-gen-${Date.now()}.png`, { overwrite: true });
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  await file.write(buffer, { format: storage?.formats?.binary });
  return file as ReferenceFileEntry;
}

async function runReferenceImageGen(prompt: string, size: string): Promise<ReferenceFileEntry> {
  ensureAiConsent("AI 이미지 생성");
  const client = imageAIClient ?? createImageAIClient();
  const genSize = imageGenerateSize(size);
  // gpt-image-2 생성은 수십 초가 걸릴 수 있어 기본 60초 타임아웃으로는 부족하다 — 넉넉히 준다.
  const request = genSize
    ? { prompt, size: genSize, timeoutMs: 120_000 }
    : { prompt, timeoutMs: 120_000 };
  const descriptor = {
    model: settings.aiModel,
    kind: "generate",
    size: genSize ?? "1024x1024",
    promptHash: deterministicHash(prompt),
  };
  const bytes = aiQueueController
    ? await aiQueueController.run("image", descriptor, () => client.generateImage(request), {
      estimateUnits: 5,
      cacheTtlMs: 0,
      maxRetries: 1,
    })
    : await client.generateImage(request);
  return writeGeneratedReferenceFile(bytes);
}

async function createPremiereSafeZoneOverlay(
  platform: SocialPlatform,
  role: "content" | "caption",
): Promise<void> {
  const expectedContextKey = await readActiveContextKey();
  const guideLabel = safeZoneGuideLabel(platform, role);
  const guide = renderSafeZoneGuideBmp({
    width: 1080,
    height: 1920,
    platform,
    role,
    includeRemovalWarning: true,
  });
  const uxpRoot = require("uxp") as any;
  const fileSystem = uxpRoot?.storage?.localFileSystem;
  const dataFolder = await fileSystem?.getDataFolder?.();
  if (!dataFolder?.createFile) throw new Error("Safe Zone 가이드를 저장할 UXP 데이터 폴더를 사용할 수 없습니다.");
  const filename = `__SHORTFLOW_SAFE_GUIDE_DO_NOT_EXPORT__${guide.suggestedFileName}`;
  const file = await dataFolder.createFile(filename, { overwrite: true });
  const binary = uxpRoot?.storage?.formats?.binary;
  const bytes = guide.bytes;
  await file.write(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { format: binary });
  const status = await readSequenceStatus(undefined, { expectedContextKey });
  if (status.videoTrackCount >= 99) throw new Error("가이드용 비디오 트랙을 추가할 수 없습니다. 비디오 트랙 수를 줄여 주세요.");
  const duration = Math.max(0.1, status.sequenceEnd - status.playerPosition);
  await importAndInsertAsset(String(file.nativePath ?? ""), {
    videoTrackIndex: status.videoTrackCount,
    audioTrackIndex: 0,
    displayName: filename,
    durationSeconds: duration,
    expectedContextKey,
  });
  activity.add("warning", `${guideLabel} 오버레이를 최상단 트랙에 삽입했습니다. 내보내기 전 반드시 삭제하세요: ${filename}`);
  toast(`${guideLabel} 오버레이를 삽입했습니다. 내보내기 전 삭제해 주세요.`, "warning", 7000);
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
  bind("qc-btn", "click", guarded(() => markersQcPanel.runQC(), "QC 실패"));
  bind("create-short-btn", "click", guarded(() => markersQcPanel.createShort(), "숏폼 생성 실패"));
  bind("scan-markers-btn", "click", guarded(() => markersQcPanel.scanMarkers(), "마커 검색 실패"));
  bind("batch-create-btn", "click", guarded(() => markersQcPanel.batchCreate(), "일괄 생성 실패"));
  bind("add-story-markers-btn", "click", guarded(() => markersQcPanel.addStoryMarkers(), "스토리 마커 추가 실패"));
  bind("choose-preset-btn", "click", guarded(handleChoosePreset, "프리셋 선택 실패"));
  bind("choose-output-btn", "click", guarded(handleChooseOutput, "출력 폴더 선택 실패"));
  bind("choose-mogrt-btn", "click", guarded(handleChooseMogrt, "MOGRT 선택 실패"));
  bind("insert-mogrt-btn", "click", guarded(handleInsertMogrt, "MOGRT 삽입 실패"));
  bind("export-video-btn", "click", guarded(handleExportVideo, "영상 내보내기 실패"));
  bind("export-cover-btn", "click", guarded(handleExportCover, "커버 저장 실패"));
  bind("choose-asset-root-btn", "click", guarded(() => assetBrowserPanel.chooseRoot(), "자산 폴더 선택 실패"));
  bind("open-asset-root-btn", "click", guarded(() => assetBrowserPanel.openRoot(), "자산 폴더 열기 실패"));
  bind("sync-assets-btn", "click", guarded(() => assetBrowserPanel.sync(), "자산 동기화 실패"));
  bind("asset-search-input", "input", () => assetBrowserPanel.render());
  bind("asset-type-select", "change", () => assetBrowserPanel.render());
  bind("asset-category-select", "change", () => assetBrowserPanel.render());
  bind("open-asset-category-btn", "click", guarded(() => assetBrowserPanel.openCategory(), "선택 폴더 열기 실패"));
  bind("asset-rights-save-btn", "click", guarded(handleSaveAssetRights, "에셋 권리 정보 저장 실패"));
  bind("ai-save-btn", "click", guarded(() => aiSettingsPanel.save(), "AI 설정 저장 실패"));
  bind("ai-test-btn", "click", guarded(() => aiSettingsPanel.test(), "AI 연결 테스트 실패"));
  bind("clear-log-btn", "click", () => activity.clear());
  bind("run-diagnostics-btn", "click", guarded(() => diagnosticsPanel.run(), "시스템 진단 실패"));
  bind("export-diagnostics-btn", "click", guarded(() => diagnosticsPanel.exportJson(), "진단 JSON 저장 실패"));

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
  assetBrowserPanel.setupDropZone();
}

async function bootstrap(): Promise<void> {
  if (initialized) return;
  initialized = true;
  applySettingsToUI();
  bindCoreEvents();
  diagnosticsPanel.render(null);
  await assetBrowserPanel.initialize();
  renderAssetRights(null);
  try {
    referenceController = new ReferenceController({
      onActivity: (message) => activity.add("success", message),
      onError: (error, context) => reportError(error, context),
      onSelectionChange: (ids) => activity.add("info", `AI 참고 레퍼런스 ${ids.length}개 선택`),
      enrichPromptProvider: runPromptEnrich,
      generatedImageProvider: runReferenceImageGen,
    });
    await referenceController.initialize();
  } catch (error) {
    referenceController = null;
    reportError(error, "레퍼런스 보드 초기화 실패");
  }
  await aiSettingsPanel.initialize();
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
      recoveryPanel.render();
      if (event.type === "persistence-error") {
        activity.add("warning", event.message ?? "복구 기록을 저장하지 못했습니다.");
      }
    });
    const interrupted = await recoveryManager.restore();
    if (interrupted > 0) {
      activity.add("warning", `이전 세션에서 중단된 비파괴 작업 ${interrupted}개를 복구 목록에 표시했습니다.`);
      toast(`중단된 작업 ${interrupted}개를 확인해 주세요.`, "warning", 6200);
    }
    recoveryPanel.render();
  } catch (error) {
    recoveryManager = null;
    reportError(error, "복구 기록 초기화 실패");
  }
  try {
    automationController = new AutomationController({
      getTranscript: () => {
        return resolveAutomationTranscript(speechController?.transcript, subtitleController?.document);
      },
      onActivity: (message) => activity.add("success", message),
      onError: (error, context) => reportError(error, context),
      getSourceContextKey: readActiveContextKey,
      onAddMarkers: async (plan, cues, guard) => {
        const result = await addAutomationMarkers(plan, cues, guard);
        activity.add("success", `Premiere 추천 마커 추가 · CUT ${result.cutMarkers}개 · ZOOM ${result.punchMarkers}개`);
        toast("자동 편집 추천 마커를 추가했습니다.", "success");
      },
      onApply: async (plan, cues, guard) => {
        let operationId = "";
        try {
          const result = await applyAutomationPlan(plan, cues, {
            expectedContextKey: guard.sourceContextKey,
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
          recoveryPanel.render();
        }
      },
      onCreateSafeOverlay: createPremiereSafeZoneOverlay,
      onAlignSafeZone: async (alignment, platform, role) => {
        if (!alignment.changed) return;
        const result = await alignSelectedVideoToSafeZone(alignment, platform, role);
        activity.add(
          result.skipped === 0 && result.changed === result.selected ? "success" : "warning",
          `${safeZoneGuideLabel(platform, role)} 정렬 · 선택 ${result.selected}개 · 변경 ${result.changed}개 · 보존/건너뜀 ${result.skipped}개`,
        );
        for (const warning of result.warnings) activity.add("warning", warning);
        return result;
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
      analysisProvider: runSubtitleAnalysis,
      onChange: (document) => {
        automationController?.setTranscript(subtitleDocumentToAutomationTranscript(document));
      },
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
      onWarning: (message) => activity.add("warning", message),
      onError: (error, context) => reportError(error, context),
      onSourceChange: () => {
        automationController?.setTranscript(null);
      },
      onTtsOutput: async (output, request, result) => {
        try {
          const record = createTtsAssetRightsRecord({
            nativePath: output.nativePath,
            name: output.name,
            model: result.model || request.model,
            voice: result.voice || request.voice,
            format: result.extension || request.format,
          });
          const saved = await ensureAssetRightsRegistry().upsert(record);
          const projectKey = await subtitleProjectKey().catch(() => SESSION_FALLBACK_PROJECT_KEY);
          rememberSessionGeneratedAssetRights(saved.assetId, projectKey);
          activity.add("info", `AI 음성 권리 정보 자동 기록: ${saved.assetName}`);
        } catch (error) {
          activity.add("warning", `AI 음성 권리 정보 자동 기록 실패: ${errorMessage(error)}`);
        }
      },
      onTranscript: (transcript) => {
        if (!subtitleController) {
          automationController?.setTranscript(resolveAutomationTranscript(transcript, null));
        }
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
          ), true);
        }
      },
      ensureAiConsent: () => ensureAiConsent("TTS/STT"),
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

function whenDocumentReady(task: () => void): void {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", task, { once: true });
    return;
  }
  task();
}

function startPanel(): void {
  whenDocumentReady(() => {
    setupTabs();
    void bootstrap()
      .then(() => startSubtitlePlayheadTracking())
      .catch((error) => reportError(error, "플러그인 초기화 실패"));
  });
}

function destroyPanel(): void {
  stopSubtitlePlayheadTracking();
  assetBrowserPanel.clearPreview();
  const controller = thumbnailController;
  thumbnailController = null;
  if (controller) {
    void controller.dispose().catch((error) => reportError(error, "썸네일 편집기 종료 저장 실패"));
  }
}

entrypoints.setup({
  panels: {
    shortflowPanel: {
      show() {
        startPanel();
      },
      hide() {
        stopSubtitlePlayheadTracking();
        assetBrowserPanel.clearPreview();
      },
      destroy() {
        destroyPanel();
      },
    },
  },
});

startPanel();
