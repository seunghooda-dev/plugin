import type { ReframeMode } from "./core";

export type SequenceRangeMode = "sequence" | "inout" | "selection" | "playhead";
export type ReframeScope = "video" | "selected" | "primary";
export type ExportMode = "queue" | "immediate";
export type ExportRange = "entire" | "inout";

export interface PluginSettings {
  profileId: string;
  width: number;
  height: number;
  sequenceName: string;
  rangeMode: SequenceRangeMode;
  maxDuration: number;
  reframeMode: ReframeMode;
  scope: ReframeScope;
  centerClips: boolean;
  hookSeconds: number;
  ctaSeconds: number;
  mogrtTrack: number;
  exportMode: ExportMode;
  exportRange: ExportRange;
  presetToken: string;
  presetName: string;
  outputFolderToken: string;
  outputFolderName: string;
  mogrtToken: string;
  mogrtName: string;
  assetRootToken: string;
  assetRootName: string;
  aiProvider: "openai" | "custom";
  aiEndpoint: string;
  aiModel: string;
  aiConsentAccepted: boolean;
  ttsOutputToken: string;
  ttsOutputName: string;
  ttsModel: "gpt-4o-mini-tts" | "tts-1-hd" | "tts-1";
  ttsVoice: string;
  ttsFormat: "wav" | "mp3" | "aac" | "flac";
  ttsSpeed: number;
  ttsAudioTrack: number;
  sttOutputToken: string;
  sttOutputName: string;
  sttModel: "gpt-4o-transcribe-diarize" | "gpt-4o-transcribe" | "gpt-4o-mini-transcribe" | "whisper-1";
  sttLanguage: string;
  sttOutputFormat: "both" | "srt" | "text";
}

export const DEFAULT_SETTINGS: Readonly<PluginSettings> = Object.freeze({
  profileId: "youtube-shorts",
  width: 1080,
  height: 1920,
  sequenceName: "ShortFlow_9x16",
  rangeMode: "inout",
  maxDuration: 60,
  reframeMode: "fill",
  scope: "video",
  centerClips: true,
  hookSeconds: 3,
  ctaSeconds: 5,
  mogrtTrack: 2,
  exportMode: "queue",
  exportRange: "inout",
  presetToken: "",
  presetName: "",
  outputFolderToken: "",
  outputFolderName: "",
  mogrtToken: "",
  mogrtName: "",
  assetRootToken: "",
  assetRootName: "",
  aiProvider: "openai",
  aiEndpoint: "https://api.openai.com/v1",
  aiModel: "gpt-image-2",
  aiConsentAccepted: false,
  ttsOutputToken: "",
  ttsOutputName: "",
  ttsModel: "gpt-4o-mini-tts",
  ttsVoice: "marin",
  ttsFormat: "wav",
  ttsSpeed: 1,
  ttsAudioTrack: 2,
  sttOutputToken: "",
  sttOutputName: "",
  sttModel: "gpt-4o-transcribe-diarize",
  sttLanguage: "ko",
  sttOutputFormat: "both",
});

const SETTINGS_KEY = "shortflow.settings.v1";

function numberInRange(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function stringValue(value: unknown, fallback: string, max = 1024): string {
  return typeof value === "string" ? value.slice(0, max) : fallback;
}

function oneOf<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  return typeof value === "string" && choices.includes(value as T) ? value as T : fallback;
}

export function normalizeSettings(value: unknown): PluginSettings {
  const input = value && typeof value === "object" ? value as Partial<PluginSettings> : {};
  return {
    profileId: stringValue(input.profileId, DEFAULT_SETTINGS.profileId, 64),
    width: Math.round(numberInRange(input.width, DEFAULT_SETTINGS.width, 16, 16384)),
    height: Math.round(numberInRange(input.height, DEFAULT_SETTINGS.height, 16, 16384)),
    sequenceName: stringValue(input.sequenceName, DEFAULT_SETTINGS.sequenceName, 120),
    rangeMode: oneOf(input.rangeMode, ["sequence", "inout", "selection", "playhead"], DEFAULT_SETTINGS.rangeMode),
    maxDuration: numberInRange(input.maxDuration, DEFAULT_SETTINGS.maxDuration, 1, 3600),
    reframeMode: oneOf(input.reframeMode, ["fill", "fit", "none"], DEFAULT_SETTINGS.reframeMode),
    scope: oneOf(input.scope, ["video", "selected", "primary"], DEFAULT_SETTINGS.scope),
    centerClips: typeof input.centerClips === "boolean" ? input.centerClips : DEFAULT_SETTINGS.centerClips,
    hookSeconds: numberInRange(input.hookSeconds, DEFAULT_SETTINGS.hookSeconds, 0, 30),
    ctaSeconds: numberInRange(input.ctaSeconds, DEFAULT_SETTINGS.ctaSeconds, 0, 30),
    mogrtTrack: Math.round(numberInRange(input.mogrtTrack, DEFAULT_SETTINGS.mogrtTrack, 1, 99)),
    exportMode: oneOf(input.exportMode, ["queue", "immediate"], DEFAULT_SETTINGS.exportMode),
    exportRange: oneOf(input.exportRange, ["entire", "inout"], DEFAULT_SETTINGS.exportRange),
    presetToken: stringValue(input.presetToken, "", 4096),
    presetName: stringValue(input.presetName, "", 260),
    outputFolderToken: stringValue(input.outputFolderToken, "", 4096),
    outputFolderName: stringValue(input.outputFolderName, "", 260),
    mogrtToken: stringValue(input.mogrtToken, "", 4096),
    mogrtName: stringValue(input.mogrtName, "", 260),
    assetRootToken: stringValue(input.assetRootToken, "", 4096),
    assetRootName: stringValue(input.assetRootName, "", 260),
    // 배포 manifest가 api.openai.com만 허용합니다. 이전 버전의 사용자 지정
    // 엔드포인트를 복원하면 키와 미디어가 의도하지 않은 origin으로 전송될 수 있으므로
    // 저장소에 남아 있는 레거시 값도 공식 OpenAI origin으로 정규화합니다.
    aiProvider: "openai",
    aiEndpoint: DEFAULT_SETTINGS.aiEndpoint,
    aiModel: stringValue(input.aiModel, DEFAULT_SETTINGS.aiModel, 128),
    aiConsentAccepted: input.aiConsentAccepted === true,
    ttsOutputToken: stringValue(input.ttsOutputToken, "", 4096),
    ttsOutputName: stringValue(input.ttsOutputName, "", 260),
    ttsModel: oneOf(input.ttsModel, ["gpt-4o-mini-tts", "tts-1-hd", "tts-1"], DEFAULT_SETTINGS.ttsModel),
    ttsVoice: stringValue(input.ttsVoice, DEFAULT_SETTINGS.ttsVoice, 120),
    ttsFormat: oneOf(input.ttsFormat, ["wav", "mp3", "aac", "flac"], DEFAULT_SETTINGS.ttsFormat),
    ttsSpeed: numberInRange(input.ttsSpeed, DEFAULT_SETTINGS.ttsSpeed, 0.25, 4),
    ttsAudioTrack: Math.round(numberInRange(input.ttsAudioTrack, DEFAULT_SETTINGS.ttsAudioTrack, 1, 99)),
    sttOutputToken: stringValue(input.sttOutputToken, "", 4096),
    sttOutputName: stringValue(input.sttOutputName, "", 260),
    sttModel: oneOf(
      input.sttModel,
      ["gpt-4o-transcribe-diarize", "gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"],
      DEFAULT_SETTINGS.sttModel,
    ),
    sttLanguage: stringValue(input.sttLanguage, DEFAULT_SETTINGS.sttLanguage, 12),
    sttOutputFormat: oneOf(input.sttOutputFormat, ["both", "srt", "text"], DEFAULT_SETTINGS.sttOutputFormat),
  };
}

export function loadSettings(storage: Storage = localStorage): PluginSettings {
  try {
    const raw = storage.getItem(SETTINGS_KEY);
    return raw ? normalizeSettings(JSON.parse(raw) as unknown) : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: PluginSettings, storage: Storage = localStorage): PluginSettings {
  const normalized = normalizeSettings(settings);
  storage.setItem(SETTINGS_KEY, JSON.stringify(normalized));
  return normalized;
}

export function clearSettings(storage: Storage = localStorage): void {
  storage.removeItem(SETTINGS_KEY);
}
