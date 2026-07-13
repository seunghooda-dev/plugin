import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_STT_INPUT_BYTES,
  STT_INPUT_TYPES,
  STT_OUTPUT_FOLDER_TOKEN_KEY,
  TTS_OUTPUT_FOLDER_TOKEN_KEY,
  SpeechFileError,
  SpeechFileManager,
  type SpeechFileAdapter,
  type SpeechFileEntry,
  type SpeechFolderEntry,
  type SpeechOutputFolder,
  type SpeechOutputFormat,
  type TranscriptFormat,
  type TtsAudioFormat,
  classifySttInput,
  safeSpeechFilename,
  speechBytes,
  sttMimeType,
  uniqueSpeechFilename,
  utf8ByteLength,
  validateSttBytes,
} from "../src/speech-files";

class MemoryStorage {
  readonly values = new Map<string, string>();
  reads = 0;
  writes = 0;
  removals = 0;
  getError: unknown = null;
  setError: unknown = null;
  removeError: unknown = null;

  getItem(key: string): string | null {
    this.reads += 1;
    if (this.getError) throw this.getError;
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.setError) throw this.setError;
    this.writes += 1;
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    if (this.removeError) throw this.removeError;
    this.removals += 1;
    this.values.delete(key);
  }
}

interface WriteCall {
  data: string | ArrayBuffer;
  options: { format?: unknown } | undefined;
}

interface MockFile extends SpeechFileEntry {
  name: string;
  nativePath: string;
  isFile: true;
  readValue: unknown;
  readCalls: Array<{ format?: unknown } | undefined>;
  writeCalls: WriteCall[];
  readError?: unknown;
  writeError?: unknown;
  declaredSize?: number;
}

function mockFile(
  name: string,
  readValue: unknown = Uint8Array.from([1, 2, 3]),
  nativePath = `C:\\Speech\\${name}`,
): MockFile {
  const file: MockFile = {
    name,
    nativePath,
    isFile: true,
    readValue,
    readCalls: [],
    writeCalls: [],
  };
  file.read = async (options) => {
    file.readCalls.push(options);
    if (file.readError) throw file.readError;
    return file.readValue;
  };
  file.write = async (data, options) => {
    if (file.writeError) throw file.writeError;
    file.writeCalls.push({ data, options });
    return typeof data === "string" ? data.length : data.byteLength;
  };
  return file;
}

class MockFolder implements SpeechFolderEntry {
  readonly isFolder = true as const;
  readonly children: Array<SpeechFileEntry | SpeechFolderEntry>;
  readonly created: MockFile[] = [];
  createCalls: string[] = [];
  getEntriesError: unknown = null;
  createError: unknown = null;
  raceCollisions = 0;

  constructor(
    readonly name = "Speech Output",
    readonly nativePath = "C:\\Speech Output",
    children: Array<SpeechFileEntry | SpeechFolderEntry> = [],
  ) {
    this.children = [...children];
  }

  async getEntries(): Promise<Array<SpeechFileEntry | SpeechFolderEntry>> {
    if (this.getEntriesError) throw this.getEntriesError;
    return [...this.children];
  }

  async createFile(name: string, options?: { overwrite?: boolean }): Promise<MockFile> {
    this.createCalls.push(name);
    if (this.createError) throw this.createError;
    if (this.raceCollisions > 0) {
      this.raceCollisions -= 1;
      throw new Error("file already exists");
    }
    const collision = this.children.some(
      (entry) => String(entry.name ?? "").toLocaleLowerCase() === name.toLocaleLowerCase(),
    );
    if (collision && options?.overwrite === false) {
      throw new Error("file already exists");
    }
    const file = mockFile(name, new Uint8Array(), `${this.nativePath}\\${name}`);
    this.children.push(file);
    this.created.push(file);
    return file;
  }
}

interface HarnessState {
  selection: SpeechFileEntry | SpeechFileEntry[] | null | undefined;
  selectedFolder: SpeechFolderEntry | null | undefined;
  pickerError: unknown;
  folderPickerError: unknown;
  tokenError: unknown;
  tokenCount: number;
  pickerOptions: unknown;
}

function createHarness(): {
  adapter: SpeechFileAdapter;
  storage: MemoryStorage;
  state: HarnessState;
  entriesByToken: Map<string, SpeechFileEntry | SpeechFolderEntry>;
} {
  const storage = new MemoryStorage();
  const entriesByToken = new Map<string, SpeechFileEntry | SpeechFolderEntry>();
  const state: HarnessState = {
    selection: null,
    selectedFolder: null,
    pickerError: null,
    folderPickerError: null,
    tokenError: null,
    tokenCount: 0,
    pickerOptions: null,
  };
  const adapter: SpeechFileAdapter = {
    localFileSystem: {
      getFileForOpening: async (options) => {
        state.pickerOptions = options;
        if (state.pickerError) throw state.pickerError;
        return state.selection;
      },
      getFolder: async () => {
        if (state.folderPickerError) throw state.folderPickerError;
        return state.selectedFolder;
      },
      createPersistentToken: async (entry) => {
        if (state.tokenError) throw state.tokenError;
        state.tokenCount += 1;
        const token = `folder-token-${state.tokenCount}`;
        entriesByToken.set(token, entry);
        return token;
      },
      getEntryForPersistentToken: async (token) => {
        const entry = entriesByToken.get(token);
        if (!entry) throw new Error("persistent token expired");
        return entry;
      },
    },
    storage,
    binaryFormat: "binary-symbol",
    textFormat: "utf8-symbol",
  };
  return { adapter, storage, state, entriesByToken };
}

function assertSpeechError(error: unknown, code: SpeechFileError["code"]): boolean {
  assert.ok(error instanceof SpeechFileError);
  assert.equal(error.code, code);
  assert.ok(error.message.trim().length > 0);
  return true;
}

describe("STT input classification", () => {
  it("publishes exactly the required picker extensions", () => {
    assert.deepEqual([...STT_INPUT_TYPES], ["mp3", "mp4", "mpeg", "mpga", "m4a", "wav", "webm"]);
  });

  it("classifies every supported extension case-insensitively", () => {
    for (const type of STT_INPUT_TYPES) {
      assert.equal(classifySttInput(`voice.${type.toUpperCase()}`), type);
    }
  });

  it("rejects unsupported, hidden, and misleading suffixes", () => {
    for (const name of ["", "voice.aac", "voice.wav.exe", ".mp3", "folder/"]) {
      assert.equal(classifySttInput(name), null, name);
    }
  });

  it("maps MPEG-family extensions to audio/mpeg", () => {
    assert.equal(sttMimeType("mp3"), "audio/mpeg");
    assert.equal(sttMimeType("mpeg"), "audio/mpeg");
    assert.equal(sttMimeType("mpga"), "audio/mpeg");
  });

  it("maps container-specific MIME types", () => {
    assert.equal(sttMimeType("mp4"), "video/mp4");
    assert.equal(sttMimeType("m4a"), "audio/mp4");
    assert.equal(sttMimeType("wav"), "audio/wav");
    assert.equal(sttMimeType("webm"), "audio/webm");
  });
});

describe("binary conversion and 25MB boundary", () => {
  it("copies Uint8Array input", () => {
    const source = Uint8Array.from([1, 2, 3]);
    const result = speechBytes(source);
    assert.deepEqual([...result], [1, 2, 3]);
    assert.notEqual(result, source);
  });

  it("accepts ArrayBuffer, DataView, and numeric arrays", () => {
    assert.deepEqual([...speechBytes(Uint8Array.from([4, 5]).buffer)], [4, 5]);
    assert.deepEqual([...speechBytes(new DataView(Uint8Array.from([6, 7]).buffer))], [6, 7]);
    assert.deepEqual([...speechBytes([8, 9])], [8, 9]);
  });

  it("rejects strings and invalid numeric arrays", () => {
    assert.throws(() => speechBytes("abc"), (error) => assertSpeechError(error, "INVALID_ENTRY"));
    assert.throws(() => speechBytes([0, 256]), (error) => assertSpeechError(error, "INVALID_ENTRY"));
  });

  it("rejects a zero-byte STT payload", () => {
    assert.throws(
      () => validateSttBytes(new Uint8Array()),
      (error) => assertSpeechError(error, "EMPTY_FILE"),
    );
  });

  it("accepts an actual binary payload of exactly 25MiB", () => {
    const result = validateSttBytes(new ArrayBuffer(MAX_STT_INPUT_BYTES));
    assert.equal(result.byteLength, MAX_STT_INPUT_BYTES);
  });

  it("rejects one byte over the 25MiB limit", () => {
    assert.throws(
      () => validateSttBytes(new ArrayBuffer(MAX_STT_INPUT_BYTES + 1)),
      (error) => assertSpeechError(error, "FILE_TOO_LARGE"),
    );
  });
});

describe("UTF-8 text sizing without browser APIs", () => {
  it("counts ASCII, Korean, and emoji bytes", () => {
    assert.equal(utf8ByteLength("ABC"), 3);
    assert.equal(utf8ByteLength("한글"), 6);
    assert.equal(utf8ByteLength("😀"), 4);
  });

  it("matches Node TextEncoder for mixed subtitle text", () => {
    const value = "1\n00:00:00,000 --> 00:00:01,000\n안녕 😀\n";
    assert.equal(utf8ByteLength(value), new TextEncoder().encode(value).byteLength);
  });

  it("counts an unpaired surrogate as a UTF-8 replacement sequence", () => {
    assert.equal(utf8ByteLength("\ud800"), 3);
  });
});

describe("safe and collision-free output filenames", () => {
  it("adds the requested audio or text extension", () => {
    assert.equal(safeSpeechFilename("narration", "wav"), "narration.wav");
    assert.equal(safeSpeechFilename("captions", "srt"), "captions.srt");
  });

  it("replaces an existing extension instead of appending twice", () => {
    assert.equal(safeSpeechFilename("voice.mp3", "flac"), "voice.flac");
    assert.equal(safeSpeechFilename("captions.txt", "srt"), "captions.srt");
  });

  it("neutralizes traversal, separators, and Windows-invalid characters", () => {
    const filename = safeSpeechFilename("../../bad:<name>?", "mp3");
    assert.equal(filename.includes("/"), false);
    assert.equal(filename.includes("\\"), false);
    assert.equal(/[<>:"|?*]/u.test(filename), false);
    assert.ok(filename.endsWith(".mp3"));
  });

  it("protects Windows reserved device names", () => {
    assert.equal(safeSpeechFilename("CON", "txt"), "_CON.txt");
  });

  it("never exceeds 180 characters including the extension", () => {
    assert.equal(safeSpeechFilename("가".repeat(300), "flac").length, 180);
  });

  it("keeps the first collision-free name", () => {
    assert.equal(uniqueSpeechFilename("voice", "wav", ["other.wav"]), "voice.wav");
  });

  it("uses case-insensitive numbered suffixes for collisions", () => {
    assert.equal(
      uniqueSpeechFilename("Voice", "wav", ["voice.WAV", "Voice (2).wav"]),
      "Voice (3).wav",
    );
  });

  it("preserves the extension when truncating a colliding long name", () => {
    const requested = "a".repeat(176);
    const first = safeSpeechFilename(requested, "wav");
    const second = uniqueSpeechFilename(requested, "wav", [first]);
    assert.equal(second.length <= 180, true);
    assert.ok(second.endsWith(" (2).wav"));
  });
});

describe("SpeechFileManager STT picker", () => {
  it("uses the required file types and binary read format", async () => {
    const { adapter, state } = createHarness();
    const file = mockFile("interview.m4a", Uint8Array.from([1, 2, 3, 4]));
    state.selection = file;
    const result = await new SpeechFileManager(adapter).selectSttInput();
    const options = state.pickerOptions as { allowMultiple: boolean; types: string[] };
    assert.equal(options.allowMultiple, false);
    assert.deepEqual(options.types, [...STT_INPUT_TYPES]);
    assert.deepEqual(file.readCalls, [{ format: "binary-symbol" }]);
    assert.equal(result.mimeType, "audio/mp4");
    assert.equal(result.size, 4);
  });

  it("checks actual bytes rather than a declared metadata size", async () => {
    const { adapter, state } = createHarness();
    const file = mockFile("fake-small.wav", new ArrayBuffer(MAX_STT_INPUT_BYTES + 1));
    file.declaredSize = 1;
    state.selection = file;
    await assert.rejects(
      new SpeechFileManager(adapter).selectSttInput(),
      (error) => assertSpeechError(error, "FILE_TOO_LARGE"),
    );
  });

  it("reports a dismissed picker as cancellation", async () => {
    const { adapter } = createHarness();
    await assert.rejects(
      new SpeechFileManager(adapter).selectSttInput(),
      (error) => assertSpeechError(error, "CANCELLED"),
    );
  });

  it("maps a host cancellation exception", async () => {
    const { adapter, state } = createHarness();
    state.pickerError = new Error("User cancelled picker");
    await assert.rejects(
      new SpeechFileManager(adapter).selectSttInput(),
      (error) => assertSpeechError(error, "CANCELLED"),
    );
  });

  it("rejects unsupported files returned by a misbehaving picker", async () => {
    const { adapter, state } = createHarness();
    state.selection = mockFile("voice.aac");
    await assert.rejects(
      new SpeechFileManager(adapter).selectSttInput(),
      (error) => assertSpeechError(error, "UNSUPPORTED_FILE"),
    );
  });

  it("rejects folders and unreadable entries", async () => {
    const { adapter, state } = createHarness();
    state.selection = { name: "folder.wav", nativePath: "C:\\folder.wav", isFile: false };
    await assert.rejects(
      new SpeechFileManager(adapter).selectSttInput(),
      (error) => assertSpeechError(error, "INVALID_ENTRY"),
    );
  });

  it("maps binary read permission errors", async () => {
    const { adapter, state } = createHarness();
    const file = mockFile("voice.wav");
    file.readError = new Error("permission denied");
    state.selection = file;
    await assert.rejects(
      new SpeechFileManager(adapter).selectSttInput(),
      (error) => assertSpeechError(error, "PERMISSION_DENIED"),
    );
  });

  it("rejects an actually empty selected file", async () => {
    const { adapter, state } = createHarness();
    state.selection = mockFile("empty.mp3", new Uint8Array());
    await assert.rejects(
      new SpeechFileManager(adapter).selectSttInput(),
      (error) => assertSpeechError(error, "EMPTY_FILE"),
    );
  });
});

describe("persistent TTS and STT output folders", () => {
  it("persists TTS and STT folders under separate keys", async () => {
    const { adapter, storage, state } = createHarness();
    const manager = new SpeechFileManager(adapter);
    state.selectedFolder = new MockFolder("TTS", "C:\\TTS");
    await manager.selectOutputFolder("tts");
    state.selectedFolder = new MockFolder("STT", "C:\\STT");
    await manager.selectOutputFolder("stt");
    assert.equal(storage.values.get(TTS_OUTPUT_FOLDER_TOKEN_KEY), "folder-token-1");
    assert.equal(storage.values.get(STT_OUTPUT_FOLDER_TOKEN_KEY), "folder-token-2");
  });

  it("returns null when no folder token is stored", async () => {
    const { adapter } = createHarness();
    assert.equal(await new SpeechFileManager(adapter).restoreOutputFolder("tts"), null);
  });

  it("restores a valid persistent folder token", async () => {
    const { adapter, storage, entriesByToken } = createHarness();
    const folder = new MockFolder("Restored", "D:\\Restored");
    storage.values.set(TTS_OUTPUT_FOLDER_TOKEN_KEY, "saved-token");
    entriesByToken.set("saved-token", folder);
    const restored = await new SpeechFileManager(adapter).restoreOutputFolder("tts");
    assert.equal(restored?.entry, folder);
    assert.equal(restored?.nativePath, "D:\\Restored");
  });

  it("removes an expired token and reports a friendly error", async () => {
    const { adapter, storage } = createHarness();
    storage.values.set(STT_OUTPUT_FOLDER_TOKEN_KEY, "expired-token");
    await assert.rejects(
      new SpeechFileManager(adapter).restoreOutputFolder("stt"),
      (error) => assertSpeechError(error, "TOKEN_EXPIRED"),
    );
    assert.equal(storage.values.has(STT_OUTPUT_FOLDER_TOKEN_KEY), false);
    assert.equal(storage.removals, 1);
  });

  it("rejects a token that resolves to a file instead of a folder", async () => {
    const { adapter, storage, entriesByToken } = createHarness();
    storage.values.set(TTS_OUTPUT_FOLDER_TOKEN_KEY, "file-token");
    entriesByToken.set("file-token", mockFile("not-folder.wav"));
    await assert.rejects(
      new SpeechFileManager(adapter).restoreOutputFolder("tts"),
      (error) => assertSpeechError(error, "TOKEN_EXPIRED"),
    );
  });

  it("reports a dismissed output folder picker", async () => {
    const { adapter } = createHarness();
    await assert.rejects(
      new SpeechFileManager(adapter).selectOutputFolder("tts"),
      (error) => assertSpeechError(error, "CANCELLED"),
    );
  });

  it("maps folder picker permission errors", async () => {
    const { adapter, state } = createHarness();
    state.folderPickerError = new Error("access denied");
    await assert.rejects(
      new SpeechFileManager(adapter).selectOutputFolder("stt"),
      (error) => assertSpeechError(error, "PERMISSION_DENIED"),
    );
  });

  it("does not cache a folder when token storage fails", async () => {
    const { adapter, storage, state } = createHarness();
    state.selectedFolder = new MockFolder();
    storage.setError = new Error("quota");
    const manager = new SpeechFileManager(adapter);
    await assert.rejects(
      manager.selectOutputFolder("tts"),
      (error) => assertSpeechError(error, "STORAGE_ERROR"),
    );
    storage.setError = null;
    await assert.rejects(
      manager.writeTtsAudio([1], "voice", "wav"),
      (error) => assertSpeechError(error, "OUTPUT_FOLDER_NOT_SET"),
    );
  });

  it("clears a saved folder token and cache", async () => {
    const { adapter, storage, state } = createHarness();
    state.selectedFolder = new MockFolder();
    const manager = new SpeechFileManager(adapter);
    await manager.selectOutputFolder("tts");
    await manager.clearOutputFolder("tts");
    assert.equal(storage.removals, 1);
    await assert.rejects(
      manager.writeTtsAudio([1], "voice", "wav"),
      (error) => assertSpeechError(error, "OUTPUT_FOLDER_NOT_SET"),
    );
  });

  it("keeps the cached output folder when token removal fails", async () => {
    const { adapter, storage, state } = createHarness();
    const folder = new MockFolder();
    state.selectedFolder = folder;
    const manager = new SpeechFileManager(adapter);
    await manager.selectOutputFolder("tts");
    storage.removeError = new Error("storage denied");
    await assert.rejects(
      manager.clearOutputFolder("tts"),
      (error) => assertSpeechError(error, "STORAGE_ERROR"),
    );
    storage.removeError = null;
    const written = await manager.writeTtsAudio([1], "voice", "wav");
    assert.equal(written.name, "voice.wav");
  });
});

describe("collision-free binary and text writes", () => {
  it("writes to the captured output-folder snapshot after the current folder changes", async () => {
    const { adapter, state } = createHarness();
    const first = new MockFolder("First", "C:\\First");
    const second = new MockFolder("Second", "C:\\Second");
    const manager = new SpeechFileManager(adapter);
    state.selectedFolder = first;
    const snapshot = await manager.selectOutputFolder("tts");
    state.selectedFolder = second;
    await manager.selectOutputFolder("tts");
    const written = await manager.writeTtsAudio([1], "snapshot", "wav", snapshot);
    assert.equal(written.nativePath, "C:\\First\\snapshot.wav");
    assert.equal(first.created.length, 1);
    assert.equal(second.created.length, 0);
  });

  it("rejects a mismatched output-folder snapshot before creating a file", async () => {
    const { adapter } = createHarness();
    const manager = new SpeechFileManager(adapter);
    await assert.rejects(
      manager.writeTtsAudio([1], "voice", "wav", {
        kind: "stt",
        entry: new MockFolder("STT", "C:\\STT"),
        token: "token",
        name: "STT",
        nativePath: "C:\\STT",
      }),
      (error) => assertSpeechError(error, "INVALID_ENTRY"),
    );
  });

  it("writes WAV bytes with binary format and returns an importable native path", async () => {
    const { adapter, state } = createHarness();
    const folder = new MockFolder("TTS", "C:\\TTS");
    state.selectedFolder = folder;
    const manager = new SpeechFileManager(adapter);
    await manager.selectOutputFolder("tts");
    const result = await manager.writeTtsAudio([82, 73, 70, 70], "narration", "wav");
    assert.equal(result.name, "narration.wav");
    assert.equal(result.nativePath, "C:\\TTS\\narration.wav");
    assert.equal(result.size, 4);
    assert.ok(folder.created[0]?.writeCalls[0]?.data instanceof ArrayBuffer);
    assert.deepEqual(folder.created[0]?.writeCalls[0]?.options, { format: "binary-symbol" });
  });

  it("supports MP3, AAC, and FLAC binary outputs", async () => {
    const { adapter, state } = createHarness();
    const folder = new MockFolder();
    state.selectedFolder = folder;
    const manager = new SpeechFileManager(adapter);
    await manager.selectOutputFolder("tts");
    for (const format of ["mp3", "aac", "flac"] as const) {
      const result = await manager.writeTtsAudio([1, 2], `voice-${format}`, format);
      assert.ok(result.name.endsWith(`.${format}`));
      assert.equal(result.format, format);
    }
  });

  it("writes SRT exactly as UTF-8 text and reports encoded bytes", async () => {
    const { adapter, state } = createHarness();
    const folder = new MockFolder("STT", "C:\\STT");
    state.selectedFolder = folder;
    const manager = new SpeechFileManager(adapter);
    await manager.selectOutputFolder("stt");
    const srt = "1\n00:00:00,000 --> 00:00:01,000\n안녕하세요\n";
    const result = await manager.writeTranscript(srt, "captions", "srt");
    assert.equal(result.nativePath, "C:\\STT\\captions.srt");
    assert.equal(folder.created[0]?.writeCalls[0]?.data, srt);
    assert.deepEqual(folder.created[0]?.writeCalls[0]?.options, { format: "utf8-symbol" });
    assert.equal(result.size, new TextEncoder().encode(srt).byteLength);
  });

  it("writes TXT transcripts", async () => {
    const { adapter, state } = createHarness();
    state.selectedFolder = new MockFolder();
    const manager = new SpeechFileManager(adapter);
    await manager.selectOutputFolder("stt");
    assert.equal((await manager.writeTranscript("hello", "transcript", "txt")).name, "transcript.txt");
  });

  it("uses numbered names when a case-insensitive collision exists", async () => {
    const existing = mockFile("Voice.WAV");
    const { adapter, state } = createHarness();
    const folder = new MockFolder("TTS", "C:\\TTS", [existing]);
    state.selectedFolder = folder;
    const manager = new SpeechFileManager(adapter);
    await manager.selectOutputFolder("tts");
    assert.equal((await manager.writeTtsAudio([1], "voice", "wav")).name, "voice (2).wav");
  });

  it("retries a race-time createFile collision without overwriting", async () => {
    const { adapter, state } = createHarness();
    const folder = new MockFolder();
    folder.raceCollisions = 1;
    state.selectedFolder = folder;
    const manager = new SpeechFileManager(adapter);
    await manager.selectOutputFolder("tts");
    const result = await manager.writeTtsAudio([1], "voice", "mp3");
    assert.equal(result.name, "voice (2).mp3");
    assert.deepEqual(folder.createCalls, ["voice.mp3", "voice (2).mp3"]);
  });

  it("serializes concurrent writes so each receives a unique name", async () => {
    const { adapter, state } = createHarness();
    const folder = new MockFolder();
    state.selectedFolder = folder;
    const manager = new SpeechFileManager(adapter);
    await manager.selectOutputFolder("tts");
    const results = await Promise.all([
      manager.writeTtsAudio([1], "voice", "wav"),
      manager.writeTtsAudio([2], "voice", "wav"),
      manager.writeTtsAudio([3], "voice", "wav"),
    ]);
    assert.deepEqual(results.map((result) => result.name), [
      "voice.wav",
      "voice (2).wav",
      "voice (3).wav",
    ]);
  });

  it("restores a saved folder automatically before writing", async () => {
    const { adapter, storage, entriesByToken } = createHarness();
    const folder = new MockFolder("Saved", "D:\\Saved");
    storage.values.set(TTS_OUTPUT_FOLDER_TOKEN_KEY, "saved");
    entriesByToken.set("saved", folder);
    const result = await new SpeechFileManager(adapter).writeTtsAudio([1], "voice", "aac");
    assert.equal(result.nativePath, "D:\\Saved\\voice.aac");
  });

  it("rejects writes before an output folder is configured", async () => {
    const { adapter } = createHarness();
    await assert.rejects(
      new SpeechFileManager(adapter).writeTranscript("text", "captions", "srt"),
      (error) => assertSpeechError(error, "OUTPUT_FOLDER_NOT_SET"),
    );
  });

  it("rejects empty binary and text outputs", async () => {
    const { adapter } = createHarness();
    const manager = new SpeechFileManager(adapter);
    await assert.rejects(
      manager.writeTtsAudio([], "voice", "wav"),
      (error) => assertSpeechError(error, "EMPTY_FILE"),
    );
    await assert.rejects(
      manager.writeTranscript("", "captions", "srt"),
      (error) => assertSpeechError(error, "EMPTY_FILE"),
    );
  });

  it("maps output file creation and write permission errors", async () => {
    const { adapter, state } = createHarness();
    const folder = new MockFolder();
    state.selectedFolder = folder;
    const manager = new SpeechFileManager(adapter);
    await manager.selectOutputFolder("tts");
    folder.createError = new Error("permission denied");
    await assert.rejects(
      manager.writeTtsAudio([1], "voice", "wav"),
      (error) => assertSpeechError(error, "PERMISSION_DENIED"),
    );
  });

  it("maps folder enumeration permission errors", async () => {
    const { adapter, state } = createHarness();
    const folder = new MockFolder();
    state.selectedFolder = folder;
    const manager = new SpeechFileManager(adapter);
    await manager.selectOutputFolder("stt");
    folder.getEntriesError = new Error("access denied");
    await assert.rejects(
      manager.writeTranscript("text", "captions", "txt"),
      (error) => assertSpeechError(error, "PERMISSION_DENIED"),
    );
  });
});

describe("output format and filename edge cases", () => {
  it("strips query and fragment suffixes before classifying an STT path", () => {
    assert.equal(classifySttInput("voice.MP3#fragment"), "mp3");
    assert.equal(classifySttInput("C:\\media\\clip.wav?cache=1"), "wav");
  });

  it("normalizes dotted and uppercase output formats", () => {
    assert.equal(safeSpeechFilename("voice", " .WAV " as unknown as SpeechOutputFormat), "voice.wav");
  });

  it("rejects unsupported output formats with INVALID_FORMAT", () => {
    assert.throws(
      () => safeSpeechFilename("voice", "exe" as unknown as SpeechOutputFormat),
      (error) => assertSpeechError(error, "INVALID_FORMAT"),
    );
  });

  it("falls back to the shortflow stem when the requested name is only separators", () => {
    assert.equal(safeSpeechFilename("../..", "mp3"), "shortflow.mp3");
    assert.equal(safeSpeechFilename("////", "mp3"), "shortflow.mp3");
  });

  it("fails with INVALID_FILENAME when every numbered candidate collides", () => {
    const existing = [
      "voice.wav",
      ...Array.from({ length: 9_999 }, (_value, index) => `voice (${index + 2}).wav`),
    ];
    assert.throws(
      () => uniqueSpeechFilename("voice", "wav", existing),
      (error) => assertSpeechError(error, "INVALID_FILENAME"),
    );
  });
});

describe("SpeechFileManager write and restore edge cases", () => {
  it("rejects cross-kind output formats before touching any folder", async () => {
    const { adapter } = createHarness();
    const manager = new SpeechFileManager(adapter);
    await assert.rejects(
      manager.writeTtsAudio([1], "voice", "txt" as unknown as TtsAudioFormat),
      (error) => assertSpeechError(error, "INVALID_FORMAT"),
    );
    await assert.rejects(
      manager.writeTranscript("text", "captions", "wav" as unknown as TranscriptFormat),
      (error) => assertSpeechError(error, "INVALID_FORMAT"),
    );
  });

  it("maps a storage read failure during folder restore to STORAGE_ERROR", async () => {
    const { adapter, storage } = createHarness();
    storage.getError = new Error("storage io failure");
    await assert.rejects(
      new SpeechFileManager(adapter).restoreOutputFolder("tts"),
      (error) => assertSpeechError(error, "STORAGE_ERROR"),
    );
  });

  it("keeps the write queue alive after a failed write", async () => {
    const { adapter, state } = createHarness();
    const folder = new MockFolder();
    state.selectedFolder = folder;
    const manager = new SpeechFileManager(adapter);
    await manager.selectOutputFolder("tts");
    folder.getEntriesError = new Error("folder listing locked");
    await assert.rejects(
      manager.writeTtsAudio([1], "voice", "wav"),
      (error) => assertSpeechError(error, "FILESYSTEM_ERROR"),
    );
    folder.getEntriesError = null;
    assert.equal((await manager.writeTtsAudio([2], "voice", "wav")).name, "voice.wav");
  });

  it("counts subfolder names when avoiding output collisions", async () => {
    const { adapter, state } = createHarness();
    const occupied = new MockFolder("voice.wav", "C:\\Out\\voice.wav");
    const folder = new MockFolder("Out", "C:\\Out", [occupied]);
    state.selectedFolder = folder;
    const manager = new SpeechFileManager(adapter);
    await manager.selectOutputFolder("tts");
    assert.equal((await manager.writeTtsAudio([1], "voice", "wav")).name, "voice (2).wav");
  });

  it("fails with WRITE_FAILED when the created entry has no write function", async () => {
    const { adapter } = createHarness();
    const manager = new SpeechFileManager(adapter);
    const entryWithoutWrite: SpeechFileEntry = {
      name: "voice.wav",
      nativePath: "C:\\Out\\voice.wav",
      isFile: true,
    };
    const snapshot: SpeechOutputFolder = {
      kind: "tts",
      token: "snapshot-token",
      name: "Out",
      nativePath: "C:\\Out",
      entry: {
        name: "Out",
        nativePath: "C:\\Out",
        isFolder: true,
        async getEntries() { return []; },
        async createFile() { return entryWithoutWrite; },
      },
    };
    await assert.rejects(
      manager.writeTtsAudio([1], "voice", "wav", snapshot),
      (error) => assertSpeechError(error, "WRITE_FAILED"),
    );
  });

  it("maps a mid-write disk failure to FILESYSTEM_ERROR that names the file", async () => {
    const { adapter, state } = createHarness();
    const folder = new MockFolder();
    state.selectedFolder = folder;
    const manager = new SpeechFileManager(adapter);
    await manager.selectOutputFolder("stt");
    const original = folder.createFile.bind(folder);
    folder.createFile = async (name, options) => {
      const file = await original(name, options);
      file.writeError = new Error("disk full");
      return file;
    };
    await assert.rejects(
      manager.writeTranscript("text", "captions", "txt"),
      (error) => {
        assertSpeechError(error, "FILESYSTEM_ERROR");
        assert.match((error as SpeechFileError).message, /captions\.txt/u);
        return true;
      },
    );
  });

  it("clears folder tokens with the setItem fallback when storage lacks removeItem", async () => {
    const { adapter, storage, state } = createHarness();
    state.selectedFolder = new MockFolder();
    const values = storage.values;
    const manager = new SpeechFileManager({
      ...adapter,
      storage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
      },
    });
    await manager.selectOutputFolder("tts");
    assert.equal(values.get(TTS_OUTPUT_FOLDER_TOKEN_KEY), "folder-token-1");
    await manager.clearOutputFolder("tts");
    assert.equal(values.get(TTS_OUTPUT_FOLDER_TOKEN_KEY), "");
    assert.equal(await manager.restoreOutputFolder("tts"), null);
  });
});
