import { importAndInsertAsset, importFilesToProject } from "./premiere";
import {
  SpeechApiClient,
  STT_MODELS,
  TTS_MODELS,
  TTS_VOICES,
  type SttModel,
  type SttRequest,
  type SttResult,
  type TtsFormat,
  type TtsModel,
  type TtsRequest,
  type TtsResult,
  type TtsVoice,
} from "./speech";
import {
  SpeechFileError,
  SpeechFileManager,
  createDefaultSpeechFileAdapter,
  type SpeechInputFile,
  type SpeechOutputFolder,
} from "./speech-files";
import type { PluginSettings } from "./settings";
import { bind, checkedOf, element, numberOf, setText, valueOf } from "./ui";

export interface SpeechControllerTranscript {
  name: string;
  duration: number;
  result: SttResult;
}

export interface SpeechControllerOptions {
  getSettings: () => PluginSettings;
  updateSettings: (patch: Partial<PluginSettings>) => void;
  onActivity?: (message: string) => void;
  onError?: (error: unknown, context: string) => void;
  onTranscript?: (transcript: SpeechControllerTranscript) => void;
  fileManager?: SpeechFileManager;
  createClient?: (settings: PluginSettings) => SpeechApiClient;
  runTts?: (request: TtsRequest) => Promise<TtsResult>;
  runStt?: (request: SttRequest) => Promise<SttResult>;
  now?: () => number;
}

const LEGACY_TTS_VOICES = new Set<TtsVoice>([
  "alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer",
]);

function isTtsModel(value: string): value is TtsModel {
  return TTS_MODELS.includes(value as TtsModel);
}

function isTtsVoice(value: string): value is TtsVoice {
  return TTS_VOICES.includes(value as TtsVoice);
}

function isTtsFormat(value: string): value is TtsFormat {
  return value === "wav" || value === "mp3" || value === "aac" || value === "flac";
}

function isSttModel(value: string): value is SttModel {
  return STT_MODELS.includes(value as SttModel);
}

function stamp(now: number): string {
  const date = new Date(now);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    "_",
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
  ].join("");
}

function stripExtension(filename: string): string {
  const clean = filename.trim();
  const dot = clean.lastIndexOf(".");
  return dot > 0 ? clean.slice(0, dot) : clean;
}

function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const combined = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    result += alphabet[(combined >> 18) & 63] ?? "";
    result += alphabet[(combined >> 12) & 63] ?? "";
    result += second === undefined ? "=" : alphabet[(combined >> 6) & 63] ?? "";
    result += third === undefined ? "=" : alphabet[combined & 63] ?? "";
  }
  return result;
}

function previewUrl(bytes: Uint8Array, mimeType: string): { url: string; revoke: boolean } {
  const Url = globalThis.URL as typeof URL | undefined;
  if (Url?.createObjectURL && typeof Blob === "function") {
    const blob = new Blob([bytes.slice().buffer], { type: mimeType });
    return { url: Url.createObjectURL(blob), revoke: true };
  }
  return { url: `data:${mimeType};base64,${bytesToBase64(bytes)}`, revoke: false };
}

function durationFromResult(result: SttResult): number {
  return result.segments.reduce((maximum, segment) => Math.max(maximum, segment.end), 0);
}

function outputMode(): "both" | "srt" | "text" {
  const value = valueOf("stt-output-format-select");
  return value === "srt" || value === "text" ? value : "both";
}

export class SpeechController {
  private readonly files: SpeechFileManager;
  private readonly now: () => number;
  private source: SpeechInputFile | null = null;
  private transcriptValue: SpeechControllerTranscript | null = null;
  private previewObjectUrl = "";
  private ttsRunning = false;
  private sttRunning = false;

  constructor(private readonly options: SpeechControllerOptions) {
    this.files = options.fileManager ?? new SpeechFileManager(createDefaultSpeechFileAdapter());
    this.now = options.now ?? (() => Date.now());
  }

  get transcript(): SpeechControllerTranscript | null {
    return this.transcriptValue
      ? { ...this.transcriptValue, result: {
        ...this.transcriptValue.result,
        segments: this.transcriptValue.result.segments.map((segment) => ({ ...segment })),
      } }
      : null;
  }

  async initialize(): Promise<void> {
    this.bindEvents();
    this.syncTtsIndicators();
    await Promise.all([this.restoreFolder("tts"), this.restoreFolder("stt")]);
  }

  dispose(): void {
    if (this.previewObjectUrl && globalThis.URL?.revokeObjectURL) {
      globalThis.URL.revokeObjectURL(this.previewObjectUrl);
    }
    this.previewObjectUrl = "";
  }

  private client(): SpeechApiClient {
    const settings = this.options.getSettings();
    return this.options.createClient?.(settings) ?? new SpeechApiClient({ endpoint: settings.aiEndpoint });
  }

  private bindEvents(): void {
    bind("tts-text-input", "input", () => this.syncTtsIndicators());
    bind("tts-speed-input", "input", () => this.syncTtsIndicators());
    bind("tts-model-select", "change", () => {
      this.enforceVoiceCompatibility();
      this.persistControls();
    });
    for (const id of [
      "tts-voice-select", "tts-format-select", "tts-audio-track-input",
      "stt-model-select", "stt-language-input", "stt-output-format-select",
    ] as const) bind(id, "change", () => this.persistControls());

    bind("tts-output-btn", "click", () => this.guard(() => this.chooseFolder("tts"), "TTS 출력 폴더 선택 실패"));
    bind("stt-output-btn", "click", () => this.guard(() => this.chooseFolder("stt"), "STT 출력 폴더 선택 실패"));
    bind("stt-source-btn", "click", () => this.guard(() => this.chooseSttSource(), "STT 입력 파일 선택 실패"));
    bind("tts-generate-btn", "click", () => this.guard(() => this.generateTts(), "TTS 생성 실패"));
    bind("stt-run-btn", "click", () => this.guard(() => this.runStt(), "STT 변환 실패"));
    bind("stt-copy-btn", "click", () => this.guard(() => this.copyTranscript(), "원고 복사 실패"));
  }

  private async guard(task: () => void | Promise<void>, context: string): Promise<void> {
    try { await task(); } catch (error) {
      if (error instanceof SpeechFileError && error.code === "CANCELLED") return;
      this.options.onError?.(error, context);
    }
  }

  private persistControls(): void {
    const ttsModel = valueOf("tts-model-select");
    const ttsFormat = valueOf("tts-format-select");
    const sttModel = valueOf("stt-model-select");
    this.options.updateSettings({
      ...(isTtsModel(ttsModel) ? { ttsModel } : {}),
      ttsVoice: valueOf("tts-voice-select"),
      ...(isTtsFormat(ttsFormat) ? { ttsFormat } : {}),
      ttsSpeed: numberOf("tts-speed-input", 1),
      ttsAudioTrack: numberOf("tts-audio-track-input", 2),
      ...(isSttModel(sttModel) ? { sttModel } : {}),
      sttLanguage: valueOf("stt-language-input"),
      sttOutputFormat: outputMode(),
    });
  }

  private syncTtsIndicators(): void {
    setText("tts-character-count", String(element<HTMLTextAreaElement>("tts-text-input").value.length));
    setText("tts-speed-output", `${numberOf("tts-speed-input", 1).toFixed(2)}×`);
    this.persistControls();
  }

  private enforceVoiceCompatibility(): void {
    const model = valueOf("tts-model-select");
    const select = element<HTMLSelectElement>("tts-voice-select");
    if ((model === "tts-1" || model === "tts-1-hd") && !LEGACY_TTS_VOICES.has(select.value as TtsVoice)) {
      select.value = "coral";
      this.options.onActivity?.("선택한 TTS-1 모델에서 지원되는 Coral 목소리로 변경했습니다.");
    }
  }

  private async restoreFolder(kind: "tts" | "stt"): Promise<void> {
    try {
      const folder = await this.files.restoreOutputFolder(kind);
      this.showFolder(kind, folder);
    } catch (error) {
      this.showFolder(kind, null);
      if (!(error instanceof SpeechFileError && error.code === "TOKEN_EXPIRED")) throw error;
      this.options.onActivity?.(`${kind.toUpperCase()} 출력 폴더 권한이 만료되어 다시 선택해야 합니다.`);
    }
  }

  private showFolder(kind: "tts" | "stt", folder: SpeechOutputFolder | null): void {
    const name = folder?.name || "선택되지 않음";
    setText(`${kind}-output-name`, name, folder?.nativePath || name);
    this.options.updateSettings(kind === "tts"
      ? { ttsOutputName: folder?.name ?? "", ttsOutputToken: folder?.token ?? "" }
      : { sttOutputName: folder?.name ?? "", sttOutputToken: folder?.token ?? "" });
  }

  private async chooseFolder(kind: "tts" | "stt"): Promise<void> {
    const folder = await this.files.selectOutputFolder(kind);
    this.showFolder(kind, folder);
    this.options.onActivity?.(`${kind.toUpperCase()} 출력 폴더를 선택했습니다: ${folder.name}`);
  }

  private async ensureFolder(kind: "tts" | "stt"): Promise<void> {
    const restored = await this.files.restoreOutputFolder(kind);
    if (restored) {
      this.showFolder(kind, restored);
      return;
    }
    await this.chooseFolder(kind);
  }

  private async chooseSttSource(): Promise<void> {
    this.source = await this.files.selectSttInput();
    setText("stt-source-name", `${this.source.name} · ${(this.source.size / 1_048_576).toFixed(1)}MB`, this.source.nativePath);
    setText("stt-result-meta", "입력 파일이 준비되었습니다. 원고·자막 생성을 실행해 주세요.");
    this.options.onActivity?.(`STT 입력 선택: ${this.source.name}`);
  }

  private async generateTts(): Promise<void> {
    if (this.ttsRunning) return;
    this.ttsRunning = true;
    const button = element<HTMLButtonElement>("tts-generate-btn");
    button.disabled = true;
    try {
      this.enforceVoiceCompatibility();
      this.persistControls();
      await this.ensureFolder("tts");
      const modelValue = valueOf("tts-model-select");
      const voiceValue = valueOf("tts-voice-select");
      const formatValue = valueOf("tts-format-select");
      if (!isTtsModel(modelValue) || !isTtsVoice(voiceValue) || !isTtsFormat(formatValue)) {
        throw new Error("TTS 모델, 목소리 또는 파일 형식 설정이 올바르지 않습니다.");
      }
      const request: TtsRequest = {
        text: valueOf("tts-text-input"),
        model: modelValue,
        voice: voiceValue,
        format: formatValue,
        speed: numberOf("tts-speed-input", 1),
        instructions: valueOf("tts-instructions-input"),
      };
      const result = await (this.options.runTts?.(request) ?? this.client().synthesize(request));
      const written = await this.files.writeTtsAudio(result.bytes, `ShortFlow_TTS_${stamp(this.now())}`, result.extension);
      this.setAudioPreview(result.bytes, result.mimeType);
      if (checkedOf("tts-insert-checkbox")) {
        await importAndInsertAsset(written.nativePath, {
          videoTrackIndex: 0,
          audioTrackIndex: Math.max(0, Math.round(numberOf("tts-audio-track-input", 2)) - 1),
          displayName: written.name,
        });
      }
      this.options.onActivity?.(`TTS 생성 완료: ${written.name}${checkedOf("tts-insert-checkbox") ? " · 타임라인 삽입" : ""}`);
    } finally {
      button.disabled = false;
      this.ttsRunning = false;
    }
  }

  private setAudioPreview(bytes: Uint8Array, mimeType: string): void {
    if (this.previewObjectUrl && globalThis.URL?.revokeObjectURL) globalThis.URL.revokeObjectURL(this.previewObjectUrl);
    const preview = previewUrl(bytes, mimeType);
    this.previewObjectUrl = preview.revoke ? preview.url : "";
    const audio = element<HTMLAudioElement>("tts-audio-preview");
    audio.src = preview.url;
    audio.hidden = false;
    audio.load();
  }

  private async runStt(): Promise<void> {
    if (this.sttRunning) return;
    if (!this.source) throw new Error("먼저 STT 음성·영상 파일을 선택해 주세요.");
    this.sttRunning = true;
    const button = element<HTMLButtonElement>("stt-run-btn");
    button.disabled = true;
    try {
      this.persistControls();
      await this.ensureFolder("stt");
      const modelValue = valueOf("stt-model-select");
      if (!isSttModel(modelValue)) throw new Error("STT 모델 설정이 올바르지 않습니다.");
      const request: SttRequest = {
        bytes: this.source.bytes,
        filename: this.source.name,
        mimeType: this.source.mimeType,
        model: modelValue,
        language: valueOf("stt-language-input"),
        prompt: valueOf("stt-prompt-input"),
      };
      const result = await (this.options.runStt?.(request) ?? this.client().transcribe(request));
      const basename = `${stripExtension(this.source.name)}_ShortFlow`;
      const mode = outputMode();
      const writtenPaths: string[] = [];
      if (mode === "both" || mode === "text") {
        const textFile = await this.files.writeTranscript(result.text, basename, "txt");
        writtenPaths.push(textFile.nativePath);
      }
      if (mode === "both" || mode === "srt") {
        if (!result.srt) {
          if (mode === "srt") throw new Error("선택한 STT 모델은 타임코드 SRT를 만들지 않습니다. 화자 구분 또는 Whisper SRT를 선택해 주세요.");
          this.options.onActivity?.("선택한 STT 모델에는 타임코드가 없어 TXT만 저장했습니다.");
        } else {
          const srtFile = await this.files.writeTranscript(result.srt, basename, "srt");
          writtenPaths.push(srtFile.nativePath);
          if (checkedOf("stt-import-checkbox")) await importFilesToProject([srtFile.nativePath]);
        }
      }
      element<HTMLTextAreaElement>("stt-result-output").value = result.text;
      element<HTMLButtonElement>("stt-copy-btn").disabled = false;
      setText("stt-result-meta", `${result.segments.length}개 타임코드 · ${writtenPaths.length}개 파일 저장${checkedOf("stt-import-checkbox") && result.srt ? " · SRT 프로젝트 가져오기" : ""}`);
      this.transcriptValue = {
        name: this.source.name,
        duration: durationFromResult(result),
        result,
      };
      this.options.onTranscript?.(this.transcriptValue);
      this.options.onActivity?.(`STT 완료: ${this.source.name} · ${result.segments.length}개 타임코드`);
    } finally {
      button.disabled = false;
      this.sttRunning = false;
    }
  }

  private async copyTranscript(): Promise<void> {
    const text = element<HTMLTextAreaElement>("stt-result-output").value;
    if (!text) throw new Error("복사할 STT 원고가 없습니다.");
    if (!navigator.clipboard?.writeText) throw new Error("이 UXP 환경은 클립보드 쓰기를 지원하지 않습니다.");
    await navigator.clipboard.writeText(text);
    this.options.onActivity?.("STT 원고를 클립보드에 복사했습니다.");
  }
}
