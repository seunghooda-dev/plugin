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

  it("clears only the plugin settings record", () => {
    const storage = new MemoryStorage();
    storage.setItem("unrelated", "keep");
    saveSettings({ ...DEFAULT_SETTINGS }, storage);
    clearSettings(storage);
    assert.equal(storage.getItem("shortflow.settings.v1"), null);
    assert.equal(storage.getItem("unrelated"), "keep");
  });
});
