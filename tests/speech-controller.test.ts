import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SpeechController,
  type SpeechControllerTranscript,
  type SpeechHostAdapter,
} from "../src/speech-controller";
import {
  SpeechFileError,
  type SpeechFileManager,
  type SpeechInputFile,
  type SpeechOutputFolder,
  type SpeechWriteResult,
  type TranscriptFormat,
  type TtsAudioFormat,
} from "../src/speech-files";
import type { SttRequest, SttResult, TtsRequest, TtsResult } from "../src/speech";
import { createSubtitleDocument, type SubtitleDocument } from "../src/subtitles";
import { DEFAULT_SETTINGS } from "../src/settings";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

class FakeElement {
  value = "";
  checked = false;
  disabled = false;
  hidden = false;
  textContent = "";
  title = "";
  src = "";
  loadCalls = 0;
  readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Array<(event: Event) => unknown>>();

  addEventListener(type: string, listener: (event: Event) => unknown): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "title") this.title = value;
  }

  load(): void {
    this.loadCalls += 1;
  }
}

class FakeDocument {
  readonly elements = new Map<string, FakeElement>();

  getElementById(id: string): FakeElement | null {
    return this.elements.get(id) ?? null;
  }

  add(id: string, value = ""): FakeElement {
    const item = new FakeElement();
    item.value = value;
    this.elements.set(id, item);
    return item;
  }
}

function speechDom(): FakeDocument {
  const dom = new FakeDocument();
  for (const [id, value] of [
    ["tts-text-input", "첫 TTS"],
    ["tts-speed-input", "1"],
    ["tts-model-select", "tts-1"],
    ["tts-voice-select", "alloy"],
    ["tts-format-select", "mp3"],
    ["tts-audio-track-input", "3"],
    ["tts-instructions-input", ""],
    ["stt-model-select", "whisper-1"],
    ["stt-language-input", "ko"],
    ["stt-output-format-select", "both"],
    ["stt-prompt-input", "용어"],
  ]) dom.add(id ?? "", value ?? "");
  for (const id of [
    "tts-insert-checkbox", "tts-generate-btn", "tts-output-btn", "tts-output-name",
    "tts-character-count", "tts-speed-output", "tts-audio-preview", "stt-import-checkbox",
    "stt-run-btn", "stt-copy-btn", "stt-output-btn", "stt-output-name", "stt-source-btn",
    "stt-source-name", "stt-result-output", "stt-result-meta",
  ]) dom.add(id);
  dom.getElementById("tts-insert-checkbox")!.checked = true;
  dom.getElementById("stt-import-checkbox")!.checked = true;
  dom.getElementById("stt-copy-btn")!.disabled = true;
  return dom;
}

function folder(kind: "tts" | "stt", name: string): SpeechOutputFolder {
  return {
    kind,
    name,
    nativePath: `C:\\${name}`,
    token: `${kind}-${name}`,
    entry: {
      name,
      nativePath: `C:\\${name}`,
      isFolder: true,
      async getEntries() { return []; },
      async createFile() { throw new Error("unused"); },
    },
  };
}

function source(name: string, marker: number): SpeechInputFile {
  const extension = "wav" as const;
  return {
    entry: { name, nativePath: `C:\\Input\\${name}`, isFile: true },
    name,
    nativePath: `C:\\Input\\${name}`,
    extension,
    mimeType: "audio/wav",
    bytes: Uint8Array.from([marker, marker + 1]),
    size: 2,
  };
}

class MockFiles {
  readonly selectedSources: Array<SpeechInputFile | Promise<SpeechInputFile>> = [];
  readonly ttsWrites: Array<{ name: string; format: TtsAudioFormat; folder: SpeechOutputFolder | undefined; bytes: number[] }> = [];
  readonly transcriptWrites: Array<{ text: string; name: string; format: TranscriptFormat; folder: SpeechOutputFolder | undefined }> = [];
  readonly restoreErrors = new Map<"tts" | "stt", unknown>();
  ttsFolder = folder("tts", "TTS-A");
  sttFolder = folder("stt", "STT-A");

  async restoreOutputFolder(kind: "tts" | "stt"): Promise<SpeechOutputFolder> {
    const restoreError = this.restoreErrors.get(kind);
    if (restoreError) throw restoreError;
    return kind === "tts" ? this.ttsFolder : this.sttFolder;
  }

  async selectOutputFolder(kind: "tts" | "stt"): Promise<SpeechOutputFolder> {
    return this.restoreOutputFolder(kind);
  }

  async selectSttInput(): Promise<SpeechInputFile> {
    const selected = await this.selectedSources.shift();
    if (!selected) throw new Error("missing test source");
    return { ...selected, bytes: selected.bytes.slice() };
  }

  async writeTtsAudio(
    bytes: Uint8Array,
    name: string,
    format: TtsAudioFormat,
    outputFolder?: SpeechOutputFolder,
  ): Promise<SpeechWriteResult> {
    this.ttsWrites.push({ name, format, folder: outputFolder, bytes: [...bytes] });
    return {
      kind: "tts", format, entry: {}, name: `${name}.${format}`,
      nativePath: `${outputFolder?.nativePath ?? "C:\\TTS"}\\${name}.${format}`,
      size: bytes.byteLength,
    };
  }

  async writeTranscript(
    text: string,
    name: string,
    format: TranscriptFormat,
    outputFolder?: SpeechOutputFolder,
  ): Promise<SpeechWriteResult> {
    this.transcriptWrites.push({ text, name, format, folder: outputFolder });
    return {
      kind: "stt", format, entry: {}, name: `${name}.${format}`,
      nativePath: `${outputFolder?.nativePath ?? "C:\\STT"}\\${name}.${format}`,
      size: text.length,
    };
  }
}

class MockHost implements SpeechHostAdapter {
  readonly inserted: Array<{ path: string; options: Parameters<SpeechHostAdapter["importAndInsertAsset"]>[1] }> = [];
  readonly projectImports: Array<{ paths: string[]; expectedContextKey?: string }> = [];
  contextKey = "ctx-project-A";
  contextReads = 0;
  importError: unknown = null;
  insertError: unknown = null;
  projectImportAttempts = 0;

  async getContextKey(): Promise<string> {
    this.contextReads += 1;
    return this.contextKey;
  }

  async importAndInsertAsset(path: string, options: Parameters<SpeechHostAdapter["importAndInsertAsset"]>[1]): Promise<void> {
    if (this.insertError) throw this.insertError;
    this.inserted.push({ path, options: { ...options } });
  }

  async importFilesToProject(paths: readonly string[], expectedContextKey?: string): Promise<number> {
    this.projectImportAttempts += 1;
    if (this.importError) throw this.importError;
    this.projectImports.push({
      paths: [...paths],
      ...(expectedContextKey !== undefined ? { expectedContextKey } : {}),
    });
    return paths.length;
  }
}

type SpeechControllerInternals = {
  chooseFolder(kind: "tts" | "stt"): Promise<SpeechOutputFolder>;
  chooseSttSource(): Promise<void>;
  generateTts(): Promise<void>;
  runStt(): Promise<void>;
  copyTranscript(): Promise<void>;
};

function internals(controller: SpeechController): SpeechControllerInternals {
  return controller as unknown as SpeechControllerInternals;
}

function sttResult(name = "A"): SttResult {
  return {
    text: `${name} 원고`,
    segments: [
      { start: 2, end: 3, text: `${name} 두번째` },
      { start: 0, end: 1, text: `${name} 첫번째` },
    ],
    srt: "provider value is normalized",
    model: "whisper-1",
  };
}

function audioBytes(format: "wav" | "mp3" | "aac" | "flac"): Uint8Array {
  if (format === "wav") {
    const bytes = new Uint8Array(44);
    bytes.set([82, 73, 70, 70], 0); // RIFF
    bytes.set([36, 0, 0, 0], 4);
    bytes.set([87, 65, 86, 69], 8); // WAVE
    return bytes;
  }
  if (format === "flac") return Uint8Array.from([102, 76, 97, 67, 0, 0, 0, 0]); // fLaC
  if (format === "aac") return Uint8Array.from([0xff, 0xf1, 0x50, 0x80]);
  return Uint8Array.from([0xff, 0xfb, 0x90, 0x64]);
}

function ttsResult(format: "wav" | "mp3" | "aac" | "flac" = "mp3"): TtsResult {
  const mimeType = format === "wav" ? "audio/wav" : format === "aac" ? "audio/aac" : format === "flac" ? "audio/flac" : "audio/mpeg";
  return { bytes: audioBytes(format), mimeType, extension: format, model: "tts-1", voice: "alloy" };
}

function controllerHarness(options: {
  runTts?: (request: TtsRequest) => Promise<TtsResult>;
  runStt?: (request: SttRequest) => Promise<SttResult>;
  onTranscript?: (transcript: SpeechControllerTranscript) => void;
  onTtsOutput?: (output: SpeechWriteResult, request: TtsRequest, result: TtsResult) => void | Promise<void>;
  onSourceChange?: () => void;
  onWarning?: (message: string) => void;
  onActivity?: (message: string) => void;
  onError?: (error: unknown, context: string) => void;
  ensureAiConsent?: () => void | Promise<void>;
} = {}): { controller: SpeechController; dom: FakeDocument; files: MockFiles; host: MockHost } {
  const dom = speechDom();
  Object.defineProperty(globalThis, "document", { value: dom, configurable: true, writable: true });
  const files = new MockFiles();
  const host = new MockHost();
  const controller = new SpeechController({
    getSettings: () => ({ ...DEFAULT_SETTINGS }),
    updateSettings: () => undefined,
    fileManager: files as unknown as SpeechFileManager,
    hostAdapter: host,
    now: () => Date.UTC(2026, 6, 11, 1, 2, 3),
    ...(options.runTts ? { runTts: options.runTts } : {}),
    ...(options.runStt ? { runStt: options.runStt } : {}),
    ...(options.onTranscript ? { onTranscript: options.onTranscript } : {}),
    ...(options.onTtsOutput ? { onTtsOutput: options.onTtsOutput } : {}),
    ...(options.onSourceChange ? { onSourceChange: options.onSourceChange } : {}),
    ...(options.onWarning ? { onWarning: options.onWarning } : {}),
    ...(options.onActivity ? { onActivity: options.onActivity } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
    ...(options.ensureAiConsent ? { ensureAiConsent: options.ensureAiConsent } : {}),
  });
  return { controller, dom, files, host };
}

describe("SpeechController request snapshots and Mock Host", () => {
  it("keeps TTS request/output/insert/track settings fixed while controls change", async () => {
    const pending = deferred<TtsResult>();
    const requests: TtsRequest[] = [];
    const { controller, dom, files, host } = controllerHarness({
      runTts: (request) => { requests.push(request); return pending.promise; },
    });
    await controller.initialize();
    const originalUrl = globalThis.URL;
    const revoked: string[] = [];
    class FakeUrl {
      static createObjectURL(): string { return "blob:shortflow-preview"; }
      static revokeObjectURL(value: string): void { revoked.push(value); }
    }
    Object.defineProperty(globalThis, "URL", { value: FakeUrl, configurable: true, writable: true });
    try {
      const first = internals(controller).generateTts();
      const duplicate = internals(controller).generateTts();
      await settle();
      assert.equal(requests.length, 1);
      dom.getElementById("tts-format-select")!.value = "wav";
      dom.getElementById("tts-audio-track-input")!.value = "9";
      dom.getElementById("tts-insert-checkbox")!.checked = false;
      files.ttsFolder = folder("tts", "TTS-B");
      await internals(controller).chooseFolder("tts");
      pending.resolve(ttsResult("mp3"));
      await Promise.all([first, duplicate]);

      assert.equal(requests[0]?.format, "mp3");
      assert.equal(files.ttsWrites[0]?.folder?.name, "TTS-A");
      assert.equal(files.ttsWrites[0]?.format, "mp3");
      assert.equal(host.inserted.length, 1);
      assert.equal(host.inserted[0]?.options.audioTrackIndex, 2);
      assert.equal(host.inserted[0]?.options.expectedContextKey, "ctx-project-A");
      assert.match(host.inserted[0]?.path ?? "", /TTS-A.*\.mp3$/u);
      assert.equal(dom.getElementById("tts-audio-preview")?.src, "blob:shortflow-preview");
      assert.equal(dom.getElementById("tts-audio-preview")?.loadCalls, 1);
      assert.equal(dom.getElementById("tts-generate-btn")?.disabled, false);
      controller.dispose();
      assert.deepEqual(revoked, ["blob:shortflow-preview"]);
    } finally {
      Object.defineProperty(globalThis, "URL", { value: originalUrl, configurable: true, writable: true });
    }
  });

  it("does not validate an unused audio track when timeline insertion is disabled", async () => {
    const { controller, dom, files, host } = controllerHarness({ runTts: async () => ttsResult("mp3") });
    dom.getElementById("tts-insert-checkbox")!.checked = false;
    dom.getElementById("tts-audio-track-input")!.value = "not-a-track";
    await controller.initialize();
    await internals(controller).generateTts();
    assert.equal(files.ttsWrites.length, 1);
    assert.equal(host.inserted.length, 0);
    assert.equal(host.contextReads, 0);
  });

  it("reports generated TTS output for rights tracking before optional timeline insertion", async () => {
    const outputs: Array<{ name: string; nativePath: string; model: string; voice: string; extension: string }> = [];
    const { controller, dom, host } = controllerHarness({
      runTts: async () => ttsResult("mp3"),
      onTtsOutput: (output, request, result) => {
        outputs.push({
          name: output.name,
          nativePath: output.nativePath,
          model: result.model || request.model,
          voice: result.voice || request.voice,
          extension: result.extension,
        });
      },
    });
    dom.getElementById("tts-insert-checkbox")!.checked = true;
    await controller.initialize();
    await internals(controller).generateTts();
    assert.equal(outputs.length, 1);
    assert.match(outputs[0]?.name ?? "", /^ShortFlow_TTS_/u);
    assert.match(outputs[0]?.nativePath ?? "", /TTS-A.*\.mp3$/u);
    assert.equal(outputs[0]?.model, "tts-1");
    assert.equal(outputs[0]?.voice, "alloy");
    assert.equal(outputs[0]?.extension, "mp3");
    assert.equal(host.inserted.length, 1);
  });

  it("saves source A with its own name/settings and does not publish it after source B is selected", async () => {
    const pending = deferred<SttResult>();
    const requests: SttRequest[] = [];
    const published: SpeechControllerTranscript[] = [];
    const warnings: string[] = [];
    let sourceChanges = 0;
    const { controller, dom, files, host } = controllerHarness({
      runStt: (request) => { requests.push(request); return pending.promise; },
      onTranscript: (transcript) => published.push(transcript),
      onSourceChange: () => { sourceChanges += 1; },
      onWarning: (message) => warnings.push(message),
    });
    files.selectedSources.push(source("A.wav", 1), source("B.wav", 9));
    await controller.initialize();
    await internals(controller).chooseSttSource();
    const first = internals(controller).runStt();
    await Promise.resolve();
    const duplicate = internals(controller).runStt();
    await internals(controller).chooseSttSource();
    dom.getElementById("stt-output-format-select")!.value = "text";
    dom.getElementById("stt-import-checkbox")!.checked = false;
    files.sttFolder = folder("stt", "STT-B");
    await internals(controller).chooseFolder("stt");
    pending.resolve(sttResult("A"));
    await Promise.all([first, duplicate]);

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.filename, "A.wav");
    assert.deepEqual([...requests[0]!.bytes], [1, 2]);
    assert.deepEqual(files.transcriptWrites.map((write) => [write.name, write.format, write.folder?.name]), [
      ["A_ShortFlow", "txt", "STT-A"],
      ["A_ShortFlow", "srt", "STT-A"],
    ]);
    assert.equal(host.projectImports.length, 0);
    assert.equal(controller.transcript, null);
    assert.equal(published.length, 0);
    assert.equal(sourceChanges, 2);
    assert.ok(warnings.some((message) => message.includes("새 입력 선택")));
    assert.equal(dom.getElementById("stt-result-output")?.value, "");
    assert.match(dom.getElementById("stt-source-name")?.textContent ?? "", /B\.wav/u);
    assert.equal(dom.getElementById("stt-run-btn")?.disabled, false);
  });

  it("does not import or publish A while a B source picker is still pending", async () => {
    const stt = deferred<SttResult>();
    const picker = deferred<SpeechInputFile>();
    const published: SpeechControllerTranscript[] = [];
    const warnings: string[] = [];
    let sourceChanges = 0;
    const { controller, dom, files, host } = controllerHarness({
      runStt: () => stt.promise,
      onTranscript: (transcript) => published.push(transcript),
      onSourceChange: () => { sourceChanges += 1; },
      onWarning: (message) => warnings.push(message),
    });
    files.selectedSources.push(source("A.wav", 1), picker.promise);
    await controller.initialize();
    await internals(controller).chooseSttSource();
    const run = internals(controller).runStt();
    await settle();
    const chooseB = internals(controller).chooseSttSource();
    stt.resolve(sttResult("A"));
    await run;

    assert.equal(files.transcriptWrites.length, 2);
    assert.equal(host.projectImportAttempts, 0);
    assert.equal(published.length, 0);
    assert.equal(controller.transcript, null);
    assert.equal(dom.getElementById("stt-result-output")?.value, "");
    assert.ok(warnings.some((message) => message.includes("새 입력 선택")));

    picker.resolve(source("B.wav", 9));
    await chooseB;
    assert.equal(sourceChanges, 2);
    assert.match(dom.getElementById("stt-source-name")?.textContent ?? "", /B\.wav/u);
  });

  it("preserves the published transcript when a new picker is cancelled but suppresses work completed after picker start", async () => {
    const second = deferred<SttResult>();
    const picker = deferred<SpeechInputFile>();
    const published: SpeechControllerTranscript[] = [];
    let sourceChanges = 0;
    let calls = 0;
    const { controller, files, host } = controllerHarness({
      runStt: async () => {
        calls += 1;
        return calls === 1 ? sttResult("기존") : second.promise;
      },
      onTranscript: (transcript) => published.push(transcript),
      onSourceChange: () => { sourceChanges += 1; },
    });
    files.selectedSources.push(source("A.wav", 1));
    await controller.initialize();
    await internals(controller).chooseSttSource();
    await internals(controller).runStt();
    assert.equal(controller.transcript?.result.text, "기존 원고");

    files.selectedSources.push(picker.promise);
    const run = internals(controller).runStt();
    await settle();
    const choose = internals(controller).chooseSttSource();
    second.resolve(sttResult("늦은"));
    await run;
    picker.reject(new SpeechFileError("CANCELLED", "picker cancelled"));
    await assert.rejects(choose, (error) => error instanceof SpeechFileError && error.code === "CANCELLED");

    assert.equal(controller.transcript?.result.text, "기존 원고");
    assert.equal(published.length, 1);
    assert.equal(sourceChanges, 1);
    assert.equal(host.projectImportAttempts, 1);
  });

  it("keeps local TTS output and preview but skips insertion after project context changes", async () => {
    const pending = deferred<TtsResult>();
    const warnings: string[] = [];
    const { controller, dom, files, host } = controllerHarness({
      runTts: () => pending.promise,
      onWarning: (message) => warnings.push(message),
    });
    await controller.initialize();
    const run = internals(controller).generateTts();
    await settle();
    host.contextKey = "ctx-project-B";
    pending.resolve(ttsResult());
    await run;

    assert.equal(files.ttsWrites.length, 1);
    assert.equal(dom.getElementById("tts-audio-preview")?.loadCalls, 1);
    assert.equal(host.inserted.length, 0);
    assert.ok(warnings.some((message) => message.includes("프로젝트 또는 시퀀스")));
    controller.dispose();
  });

  it("keeps local STT files but skips SRT import and callback after project context changes", async () => {
    const pending = deferred<SttResult>();
    const published: SpeechControllerTranscript[] = [];
    const warnings: string[] = [];
    const { controller, dom, files, host } = controllerHarness({
      runStt: () => pending.promise,
      onTranscript: (transcript) => published.push(transcript),
      onWarning: (message) => warnings.push(message),
    });
    files.selectedSources.push(source("context.wav", 2));
    await controller.initialize();
    await internals(controller).chooseSttSource();
    const run = internals(controller).runStt();
    await settle();
    host.contextKey = "ctx-project-B";
    pending.resolve(sttResult("context"));
    await run;

    assert.equal(files.transcriptWrites.length, 2);
    assert.equal(host.projectImportAttempts, 0);
    assert.equal(published.length, 0);
    assert.equal(controller.transcript, null);
    assert.equal(dom.getElementById("stt-result-output")?.value, "");
    assert.ok(warnings.some((message) => message.includes("프로젝트 또는 시퀀스")));
  });

  it("continues publishing after an optional SRT project import failure", async () => {
    const published: SpeechControllerTranscript[] = [];
    const warnings: string[] = [];
    const { controller, dom, files, host } = controllerHarness({
      runStt: async () => sttResult("local"),
      onTranscript: (transcript) => published.push(transcript),
      onWarning: (message) => warnings.push(message),
    });
    host.importError = new Error("project import failed");
    files.selectedSources.push(source("local.wav", 2));
    await controller.initialize();
    await internals(controller).chooseSttSource();
    await internals(controller).runStt();

    assert.equal(files.transcriptWrites.length, 2);
    assert.equal(host.projectImportAttempts, 1);
    assert.equal(published.length, 1);
    assert.equal(controller.transcript?.result.text, "local 원고");
    assert.equal(dom.getElementById("stt-result-output")?.value, "local 원고");
    assert.doesNotMatch(dom.getElementById("stt-result-meta")?.textContent ?? "", /프로젝트 가져오기/u);
    assert.ok(warnings.some((message) => message.includes("가져오지 못했지만")));
  });

  it("publishes defensive transcript copies and connects SRT output to a subtitle document", async () => {
    let connected: SubtitleDocument | null = null;
    const { controller, files, host } = controllerHarness({
      runStt: async () => sttResult("검증"),
      onTranscript: (transcript) => {
        connected = createSubtitleDocument("project-A", transcript.result.segments.map((segment) => ({
          start: segment.start,
          end: segment.end,
          text: segment.text,
          enabled: true,
          hidden: false,
        })));
        transcript.result.segments[0]!.text = "외부 변조";
      },
    });
    files.selectedSources.push(source("document.wav", 3));
    await controller.initialize();
    await internals(controller).chooseSttSource();
    await internals(controller).runStt();

    assert.equal(host.projectImports.length, 1);
    assert.equal(host.projectImports[0]?.expectedContextKey, "ctx-project-A");
    assert.equal((connected as SubtitleDocument | null)?.cues.length, 2);
    assert.equal((connected as SubtitleDocument | null)?.cues[0]?.start, 0);
    const firstRead = controller.transcript;
    assert.equal(firstRead?.result.segments[0]?.text, "검증 첫번째");
    if (firstRead) firstRead.result.segments[0]!.text = "getter 변조";
    assert.equal(controller.transcript?.result.segments[0]?.text, "검증 첫번째");
  });
});

describe("SpeechController stale/failure cleanup", () => {
  it("downgrades an internal context-change insert rejection but preserves other insert failures", async () => {
    const warnings: string[] = [];
    const contextHarness = controllerHarness({
      runTts: async () => ttsResult(),
      onWarning: (message) => warnings.push(message),
    });
    contextHarness.host.insertError = { code: "HOST_CONTEXT_CHANGED", message: "changed" };
    await contextHarness.controller.initialize();
    await internals(contextHarness.controller).generateTts();
    assert.equal(contextHarness.files.ttsWrites.length, 1);
    assert.equal(contextHarness.host.inserted.length, 0);
    assert.ok(warnings.some((message) => message.includes("타임라인 삽입")));
    contextHarness.controller.dispose();

    const failureHarness = controllerHarness({ runTts: async () => ttsResult() });
    failureHarness.host.insertError = new Error("insert rejected");
    await failureHarness.controller.initialize();
    await assert.rejects(() => internals(failureHarness.controller).generateTts(), /insert rejected/u);
    assert.equal(failureHarness.files.ttsWrites.length, 1);
    assert.equal(failureHarness.dom.getElementById("tts-generate-btn")?.disabled, false);
    failureHarness.controller.dispose();
  });

  it("revokes the previous preview object URL on replacement and the current URL on dispose", async () => {
    const { controller, dom } = controllerHarness({ runTts: async () => ttsResult() });
    dom.getElementById("tts-insert-checkbox")!.checked = false;
    await controller.initialize();
    const originalUrl = globalThis.URL;
    const revoked: string[] = [];
    let next = 0;
    class FakeUrl {
      static createObjectURL(): string { next += 1; return `blob:preview-${next}`; }
      static revokeObjectURL(value: string): void { revoked.push(value); }
    }
    Object.defineProperty(globalThis, "URL", { value: FakeUrl, configurable: true, writable: true });
    try {
      await internals(controller).generateTts();
      await internals(controller).generateTts();
      assert.deepEqual(revoked, ["blob:preview-1"]);
      assert.equal(dom.getElementById("tts-audio-preview")?.src, "blob:preview-2");
      controller.dispose();
      assert.deepEqual(revoked, ["blob:preview-1", "blob:preview-2"]);
    } finally {
      Object.defineProperty(globalThis, "URL", { value: originalUrl, configurable: true, writable: true });
    }
  });

  it("drops a late TTS result after dispose without file, preview, or host mutation", async () => {
    const pending = deferred<TtsResult>();
    const { controller, dom, files, host } = controllerHarness({ runTts: () => pending.promise });
    await controller.initialize();
    const run = internals(controller).generateTts();
    await Promise.resolve();
    controller.dispose();
    pending.resolve(ttsResult());
    await run;
    assert.equal(files.ttsWrites.length, 0);
    assert.equal(host.inserted.length, 0);
    assert.equal(dom.getElementById("tts-audio-preview")?.src, "");
    assert.equal(dom.getElementById("tts-generate-btn")?.disabled, false);
  });

  it("drops a late STT result after dispose and restores the run button", async () => {
    const pending = deferred<SttResult>();
    const published: SpeechControllerTranscript[] = [];
    const { controller, dom, files, host } = controllerHarness({
      runStt: () => pending.promise,
      onTranscript: (transcript) => published.push(transcript),
    });
    files.selectedSources.push(source("late.wav", 5));
    await controller.initialize();
    await internals(controller).chooseSttSource();
    const run = internals(controller).runStt();
    await Promise.resolve();
    controller.dispose();
    pending.resolve(sttResult("late"));
    await run;
    assert.equal(files.transcriptWrites.length, 0);
    assert.equal(host.projectImports.length, 0);
    assert.equal(published.length, 0);
    assert.equal(controller.transcript, null);
    assert.equal(dom.getElementById("stt-run-btn")?.disabled, false);
  });

  it("restores both buttons after provider failures", async () => {
    const { controller, dom, files } = controllerHarness({
      runTts: async () => { throw new Error("tts failed"); },
      runStt: async () => { throw new Error("stt failed"); },
    });
    files.selectedSources.push(source("failure.wav", 4));
    await controller.initialize();
    await internals(controller).chooseSttSource();
    await assert.rejects(() => internals(controller).generateTts(), /tts failed/u);
    await assert.rejects(() => internals(controller).runStt(), /stt failed/u);
    assert.equal(dom.getElementById("tts-generate-btn")?.disabled, false);
    assert.equal(dom.getElementById("stt-run-btn")?.disabled, false);
  });
});

describe("SpeechController consent, validation, and callback edges", () => {
  it("blocks both TTS and STT providers when AI consent is rejected", async () => {
    let providerCalls = 0;
    let consentChecks = 0;
    const { controller, dom, files, host } = controllerHarness({
      runTts: async () => { providerCalls += 1; return ttsResult(); },
      runStt: async () => { providerCalls += 1; return sttResult(); },
      ensureAiConsent: () => { consentChecks += 1; throw new Error("AI 사용 동의가 거부되었습니다."); },
    });
    files.selectedSources.push(source("consent.wav", 1));
    await controller.initialize();
    await internals(controller).chooseSttSource();
    await assert.rejects(() => internals(controller).generateTts(), /동의/u);
    await assert.rejects(() => internals(controller).runStt(), /동의/u);
    assert.equal(consentChecks, 2);
    assert.equal(providerCalls, 0);
    assert.equal(files.ttsWrites.length, 0);
    assert.equal(files.transcriptWrites.length, 0);
    assert.equal(host.inserted.length, 0);
    assert.equal(dom.getElementById("tts-generate-btn")?.disabled, false);
    assert.equal(dom.getElementById("stt-run-btn")?.disabled, false);
  });

  it("re-validates injected TTS provider output and rejects a format mismatch without saving", async () => {
    const { controller, dom, files, host } = controllerHarness({
      runTts: async () => ttsResult("wav"),
    });
    await controller.initialize();
    await assert.rejects(() => internals(controller).generateTts(), /일치하지 않습니다/u);
    assert.equal(files.ttsWrites.length, 0);
    assert.equal(host.inserted.length, 0);
    assert.equal(dom.getElementById("tts-audio-preview")?.loadCalls, 0);
    assert.equal(dom.getElementById("tts-generate-btn")?.disabled, false);

    const malformed = controllerHarness({
      runTts: async () => null as unknown as TtsResult,
    });
    await malformed.controller.initialize();
    await assert.rejects(() => internals(malformed.controller).generateTts(), /형식이 올바르지/u);
    assert.equal(malformed.files.ttsWrites.length, 0);
  });

  it("re-validates injected STT provider output and rejects empty or mismatched transcripts without saving", async () => {
    const empty = controllerHarness({
      runStt: async () => ({ text: "", segments: [], srt: "", model: "whisper-1" }),
    });
    empty.files.selectedSources.push(source("empty.wav", 1));
    await empty.controller.initialize();
    await internals(empty.controller).chooseSttSource();
    await assert.rejects(() => internals(empty.controller).runStt(), /빈 원고/u);
    assert.equal(empty.files.transcriptWrites.length, 0);
    assert.equal(empty.controller.transcript, null);
    assert.equal(empty.dom.getElementById("stt-copy-btn")?.disabled, true);

    const mismatched = controllerHarness({
      runStt: async () => ({ ...sttResult("모델"), model: "gpt-4o-transcribe" }),
    });
    mismatched.files.selectedSources.push(source("model.wav", 2));
    await mismatched.controller.initialize();
    await internals(mismatched.controller).chooseSttSource();
    await assert.rejects(() => internals(mismatched.controller).runStt(), /일치하지/u);
    assert.equal(mismatched.files.transcriptWrites.length, 0);
  });

  it("coerces a next-gen voice to Coral for legacy TTS-1 models before building the request", async () => {
    const requests: TtsRequest[] = [];
    const activities: string[] = [];
    const { controller, dom } = controllerHarness({
      runTts: async (request) => { requests.push(request); return { ...ttsResult(), voice: "coral" }; },
      onActivity: (message) => activities.push(message),
    });
    dom.getElementById("tts-voice-select")!.value = "marin";
    dom.getElementById("tts-insert-checkbox")!.checked = false;
    await controller.initialize();
    await internals(controller).generateTts();
    assert.equal(requests[0]?.voice, "coral");
    assert.equal(dom.getElementById("tts-voice-select")?.value, "coral");
    assert.ok(activities.some((message) => message.includes("Coral")));
  });

  it("rejects out-of-range audio track numbers before calling the TTS provider", async () => {
    for (const track of ["0", "100"]) {
      let calls = 0;
      const { controller, dom } = controllerHarness({
        runTts: async () => { calls += 1; return ttsResult(); },
      });
      dom.getElementById("tts-audio-track-input")!.value = track;
      await controller.initialize();
      await assert.rejects(() => internals(controller).generateTts(), /1~99/u);
      assert.equal(calls, 0);
      assert.equal(dom.getElementById("tts-generate-btn")?.disabled, false);
    }
  });

  it("requires an STT source before running", async () => {
    const { controller, files } = controllerHarness({ runStt: async () => sttResult() });
    await controller.initialize();
    await assert.rejects(() => internals(controller).runStt(), /먼저 STT/u);
    assert.equal(files.transcriptWrites.length, 0);
  });

  it("fails SRT-only output when the model produced no timecodes and writes nothing", async () => {
    const { controller, dom, files, host } = controllerHarness({
      runStt: async () => ({ text: "타임코드 없음", segments: [], srt: "", model: "whisper-1" }),
    });
    files.selectedSources.push(source("plain.wav", 1));
    dom.getElementById("stt-output-format-select")!.value = "srt";
    await controller.initialize();
    await internals(controller).chooseSttSource();
    await assert.rejects(() => internals(controller).runStt(), /타임코드 SRT/u);
    assert.equal(files.transcriptWrites.length, 0);
    assert.equal(host.projectImportAttempts, 0);
    assert.equal(controller.transcript, null);
  });

  it("keeps TXT output and still publishes when both-mode output has no timecodes", async () => {
    const activities: string[] = [];
    const published: SpeechControllerTranscript[] = [];
    const { controller, dom, files, host } = controllerHarness({
      runStt: async () => ({ text: "타임코드 없음", segments: [], srt: "", model: "whisper-1" }),
      onActivity: (message) => activities.push(message),
      onTranscript: (transcript) => published.push(transcript),
    });
    files.selectedSources.push(source("plain.wav", 1));
    await controller.initialize();
    await internals(controller).chooseSttSource();
    await internals(controller).runStt();
    assert.deepEqual(files.transcriptWrites.map((write) => write.format), ["txt"]);
    assert.equal(host.projectImportAttempts, 0);
    assert.ok(activities.some((message) => message.includes("TXT만 저장")));
    assert.equal(published.length, 1);
    assert.equal(published[0]?.duration, 0);
    assert.match(dom.getElementById("stt-result-meta")?.textContent ?? "", /0개 타임코드 · 1개 파일 저장/u);
  });

  it("writes only TXT in text mode and never imports SRT even when import is checked", async () => {
    const published: SpeechControllerTranscript[] = [];
    const { controller, dom, files, host } = controllerHarness({
      runStt: async () => sttResult("텍스트"),
      onTranscript: (transcript) => published.push(transcript),
    });
    files.selectedSources.push(source("text-mode.wav", 1));
    dom.getElementById("stt-output-format-select")!.value = "text";
    await controller.initialize();
    await internals(controller).chooseSttSource();
    await internals(controller).runStt();
    assert.deepEqual(files.transcriptWrites.map((write) => write.format), ["txt"]);
    assert.equal(host.projectImportAttempts, 0);
    assert.equal(published.length, 1);
    assert.match(dom.getElementById("stt-result-meta")?.textContent ?? "", /2개 타임코드 · 1개 파일 저장/u);
  });

  it("treats a host context-change import rejection as a skip and keeps local files without publishing", async () => {
    const warnings: string[] = [];
    const published: SpeechControllerTranscript[] = [];
    const { controller, dom, files, host } = controllerHarness({
      runStt: async () => sttResult("컨텍스트"),
      onTranscript: (transcript) => published.push(transcript),
      onWarning: (message) => warnings.push(message),
    });
    host.importError = { code: "HOST_CONTEXT_CHANGED", message: "changed" };
    files.selectedSources.push(source("switch.wav", 3));
    await controller.initialize();
    await internals(controller).chooseSttSource();
    await internals(controller).runStt();
    assert.equal(files.transcriptWrites.length, 2);
    assert.equal(host.projectImportAttempts, 1);
    assert.equal(published.length, 0);
    assert.equal(controller.transcript, null);
    assert.equal(dom.getElementById("stt-result-output")?.value, "");
    assert.ok(warnings.some((message) => message.includes("context가 변경")));
  });

  it("skips timeline insertion when the rights-record callback fails after the file is saved", async () => {
    const { controller, dom, files, host } = controllerHarness({
      runTts: async () => ttsResult(),
      onTtsOutput: async () => { throw new Error("권리 기록 저장 실패"); },
    });
    await controller.initialize();
    await assert.rejects(() => internals(controller).generateTts(), /권리 기록/u);
    assert.equal(files.ttsWrites.length, 1);
    assert.equal(host.inserted.length, 0);
    assert.equal(dom.getElementById("tts-audio-preview")?.loadCalls, 1);
    assert.equal(dom.getElementById("tts-generate-btn")?.disabled, false);
  });

  it("copies the visible transcript through the clipboard and rejects empty or unsupported states", async () => {
    const activities: string[] = [];
    const { controller, dom } = controllerHarness({ onActivity: (message) => activities.push(message) });
    await controller.initialize();
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const written: string[] = [];
    try {
      Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true, writable: true });
      await assert.rejects(() => internals(controller).copyTranscript(), /복사할 STT 원고가 없습니다/u);
      dom.getElementById("stt-result-output")!.value = "복사할 원고";
      await assert.rejects(() => internals(controller).copyTranscript(), /클립보드 쓰기/u);
      Object.defineProperty(globalThis, "navigator", {
        value: { clipboard: { writeText: async (text: string) => { written.push(text); } } },
        configurable: true,
        writable: true,
      });
      await internals(controller).copyTranscript();
      assert.deepEqual(written, ["복사할 원고"]);
      assert.ok(activities.some((message) => message.includes("클립보드")));
    } finally {
      if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
      else Reflect.deleteProperty(globalThis, "navigator");
    }
  });

  it("refuses to initialize after dispose and reports folder restore problems during initialize", async () => {
    const disposedHarness = controllerHarness({});
    disposedHarness.controller.dispose();
    await assert.rejects(() => disposedHarness.controller.initialize(), /다시 초기화/u);

    const activities: string[] = [];
    const expired = controllerHarness({ onActivity: (message) => activities.push(message) });
    expired.files.restoreErrors.set("tts", new SpeechFileError("TOKEN_EXPIRED", "출력 폴더 권한이 만료되었습니다."));
    await expired.controller.initialize();
    assert.equal(expired.dom.getElementById("tts-output-name")?.textContent, "선택되지 않음");
    assert.equal(expired.dom.getElementById("stt-output-name")?.textContent, "STT-A");
    assert.ok(activities.some((message) => message.includes("TTS 출력 폴더 권한이 만료")));

    const contexts: string[] = [];
    const failing = controllerHarness({ onError: (_error, context) => contexts.push(context) });
    failing.files.restoreErrors.set("stt", new Error("storage boom"));
    await failing.controller.initialize();
    assert.deepEqual(contexts, ["STT 출력 폴더 복원 실패"]);
    assert.equal(failing.dom.getElementById("stt-output-name")?.textContent, "선택되지 않음");
  });
});
