import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_SETTINGS,
  clearSettings,
  loadSettings,
  normalizeSettings,
  saveSettings,
} from "../src/settings";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number { return this.values.size; }
  clear(): void { this.values.clear(); }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string): void { this.values.delete(key); }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

describe("speech settings", () => {
  it("publishes production-safe TTS and STT defaults", () => {
    assert.equal(DEFAULT_SETTINGS.ttsModel, "gpt-4o-mini-tts");
    assert.equal(DEFAULT_SETTINGS.ttsVoice, "marin");
    assert.equal(DEFAULT_SETTINGS.ttsFormat, "wav");
    assert.equal(DEFAULT_SETTINGS.ttsSpeed, 1);
    assert.equal(DEFAULT_SETTINGS.sttModel, "gpt-4o-transcribe-diarize");
    assert.equal(DEFAULT_SETTINGS.sttLanguage, "ko");
    assert.equal(DEFAULT_SETTINGS.sttOutputFormat, "both");
    assert.equal(DEFAULT_SETTINGS.aiConsentAccepted, false);
  });

  it("clamps TTS speed and track inputs", () => {
    const low = normalizeSettings({ ttsSpeed: -5, ttsAudioTrack: 0 });
    const high = normalizeSettings({ ttsSpeed: 50, ttsAudioTrack: 500 });
    assert.equal(low.ttsSpeed, 0.25);
    assert.equal(low.ttsAudioTrack, 1);
    assert.equal(high.ttsSpeed, 4);
    assert.equal(high.ttsAudioTrack, 99);
  });

  it("rejects unknown speech enum values", () => {
    const normalized = normalizeSettings({
      ttsModel: "unknown",
      ttsFormat: "exe",
      sttModel: "unknown",
      sttOutputFormat: "unknown",
    });
    assert.equal(normalized.ttsModel, DEFAULT_SETTINGS.ttsModel);
    assert.equal(normalized.ttsFormat, DEFAULT_SETTINGS.ttsFormat);
    assert.equal(normalized.sttModel, DEFAULT_SETTINGS.sttModel);
    assert.equal(normalized.sttOutputFormat, DEFAULT_SETTINGS.sttOutputFormat);
  });

  it("persists AI transfer consent only when explicitly true", () => {
    assert.equal(normalizeSettings({ aiConsentAccepted: true }).aiConsentAccepted, true);
    assert.equal(normalizeSettings({ aiConsentAccepted: "true" as never }).aiConsentAccepted, false);
  });

  it("bounds persisted speech text metadata", () => {
    const normalized = normalizeSettings({
      ttsOutputToken: "t".repeat(10_000),
      ttsOutputName: "n".repeat(1_000),
      ttsVoice: "v".repeat(1_000),
      sttLanguage: "language-code-is-too-long",
    });
    assert.equal(normalized.ttsOutputToken.length, 4_096);
    assert.equal(normalized.ttsOutputName.length, 260);
    assert.equal(normalized.ttsVoice.length, 120);
    assert.equal(normalized.sttLanguage.length, 12);
  });
});

describe("settings normalization", () => {
  it("returns pristine defaults for non-object payloads", () => {
    for (const payload of [null, undefined, 42, "settings", true, []]) {
      assert.deepEqual(normalizeSettings(payload), { ...DEFAULT_SETTINGS });
    }
  });

  it("rounds and clamps canvas dimensions to the supported range", () => {
    const rounded = normalizeSettings({ width: 1080.6, height: 1 });
    assert.equal(rounded.width, 1081);
    assert.equal(rounded.height, 16);
    assert.equal(normalizeSettings({ width: 1e9 }).width, 16384);
  });

  it("accepts numeric strings for numeric fields", () => {
    const normalized = normalizeSettings({ width: "2000.4", ttsSpeed: "2.5" });
    assert.equal(normalized.width, 2000);
    assert.equal(normalized.ttsSpeed, 2.5);
  });

  it("rejects unknown workflow enum values", () => {
    const normalized = normalizeSettings({
      rangeMode: "diagonal",
      reframeMode: "stretch",
      scope: 7,
      exportMode: "warp",
      exportRange: false,
    });
    assert.equal(normalized.rangeMode, DEFAULT_SETTINGS.rangeMode);
    assert.equal(normalized.reframeMode, DEFAULT_SETTINGS.reframeMode);
    assert.equal(normalized.scope, DEFAULT_SETTINGS.scope);
    assert.equal(normalized.exportMode, DEFAULT_SETTINGS.exportMode);
    assert.equal(normalized.exportRange, DEFAULT_SETTINGS.exportRange);
  });

  it("replaces non-string text fields with defaults and enforces length caps", () => {
    const normalized = normalizeSettings({
      profileId: 99,
      sequenceName: "시퀀스".repeat(100),
      presetToken: "p".repeat(10_000),
    });
    assert.equal(normalized.profileId, DEFAULT_SETTINGS.profileId);
    assert.equal(normalized.sequenceName.length, 120);
    assert.equal(normalized.presetToken.length, 4_096);
  });

  it("clamps hook, CTA, and MOGRT track inputs", () => {
    const normalized = normalizeSettings({ hookSeconds: -2, ctaSeconds: 99, mogrtTrack: 2.6 });
    assert.equal(normalized.hookSeconds, 0);
    assert.equal(normalized.ctaSeconds, 30);
    assert.equal(normalized.mogrtTrack, 3);
  });
});

describe("settings persistence", () => {
  it("round-trips normalized settings", () => {
    const storage = new MemoryStorage();
    const saved = saveSettings({
      ...DEFAULT_SETTINGS,
      ttsVoice: "cedar",
      ttsSpeed: 1.25,
      sttLanguage: "en",
    }, storage);
    assert.deepEqual(loadSettings(storage), saved);
  });

  it("does not create an API-key field in ordinary settings storage", () => {
    const storage = new MemoryStorage();
    saveSettings({ ...DEFAULT_SETTINGS }, storage);
    const serialized = storage.key(0) ? storage.getItem(storage.key(0)!) : "";
    assert.equal(serialized?.toLocaleLowerCase().includes("apikey"), false);
    assert.equal(serialized?.includes("sk-"), false);
  });

  it("pins legacy custom provider settings to the manifest-approved OpenAI origin", () => {
    const restored = normalizeSettings({
      aiProvider: "custom",
      aiEndpoint: "https://untrusted.example/v1",
    });
    assert.equal(restored.aiProvider, "openai");
    assert.equal(restored.aiEndpoint, DEFAULT_SETTINGS.aiEndpoint);
  });

  it("recovers from malformed JSON", () => {
    const storage = new MemoryStorage();
    storage.setItem("shortflow.settings.v1", "{broken");
    assert.deepEqual(loadSettings(storage), { ...DEFAULT_SETTINGS });
  });

  it("recovers from valid JSON that is not a settings object", () => {
    const storage = new MemoryStorage();
    storage.setItem("shortflow.settings.v1", "42");
    assert.deepEqual(loadSettings(storage), { ...DEFAULT_SETTINGS });
  });

  it("returns defaults when storage access throws", () => {
    class DeniedStorage extends MemoryStorage {
      override getItem(): string | null {
        throw new Error("storage denied");
      }
    }
    assert.deepEqual(loadSettings(new DeniedStorage()), { ...DEFAULT_SETTINGS });
  });

  it("persists a normalized record rather than the raw input", () => {
    const storage = new MemoryStorage();
    saveSettings({
      ...DEFAULT_SETTINGS,
      ttsSpeed: 99,
      rangeMode: "diagonal" as never,
    }, storage);
    const raw = storage.getItem("shortflow.settings.v1");
    assert.ok(raw);
    const persisted = JSON.parse(raw) as { ttsSpeed?: number; rangeMode?: string };
    assert.equal(persisted.ttsSpeed, 4);
    assert.equal(persisted.rangeMode, DEFAULT_SETTINGS.rangeMode);
  });

  it("clears only the plugin settings record", () => {
    const storage = new MemoryStorage();
    storage.setItem("unrelated", "keep");
    saveSettings({ ...DEFAULT_SETTINGS }, storage);
    clearSettings(storage);
    assert.equal(storage.getItem("shortflow.settings.v1"), null);
    assert.equal(storage.getItem("unrelated"), "keep");
  });
});
