import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ASSET_RIGHTS_SCHEMA_VERSION,
  ASSET_RIGHTS_STORAGE_KEY,
  AssetRightsError,
  AssetRightsRegistry,
  assetRightsReportToJSON,
  assetRightsReportToMarkdown,
  createMissingAssetRightsRecord,
  createReferenceAssetRightsRecord,
  createAssetRightsReport,
  createTtsAssetRightsRecord,
  evaluateAssetRightsRecord,
  inferAssetRightsKind,
  normalizeAssetRightsRecord,
  redactRightsText,
  type AssetRightsStorageAdapter,
} from "../src/asset-rights";

class MemoryStorage implements AssetRightsStorageAdapter {
  readonly values = new Map<string, string>();
  fail = false;

  getItem(key: string): string | null {
    if (this.fail) throw new Error("storage denied");
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.fail) throw new Error("storage denied");
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    if (this.fail) throw new Error("storage denied");
    this.values.delete(key);
  }
}

function validInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    assetId: "c:/assets/music/hook.wav",
    assetName: "hook.wav",
    kind: "music",
    source: "Artlist",
    license: "Creator Pro",
    commercialUse: "allowed",
    expiresAt: "2027-07-11",
    attribution: "Music: hook.wav, Artlist, Creator Pro",
    notes: "Campaign licensed",
    updatedAt: 1_783_728_000_000,
    ...overrides,
  };
}

function expectRightsError(code: AssetRightsError["code"]): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof AssetRightsError);
    assert.equal(error.code, code);
    assert.ok(error.message.length > 0);
    return true;
  };
}

describe("asset rights normalization", () => {
  it("normalizes supported fields and redacts secrets", () => {
    const record = normalizeAssetRightsRecord(validInput({
      kind: "AI-IMAGE",
      notes: "api_key=sk-secret-token source memo",
      expiresAt: "2027-01-05T10:20:30Z",
    }), 1_750_000_000_000);

    assert.equal(record.kind, "ai-image");
    assert.equal(record.expiresAt, "2027-01-05");
    assert.doesNotMatch(record.notes, /sk-secret-token/u);
  });

  it("requires stable asset identity", () => {
    assert.throws(
      () => normalizeAssetRightsRecord(validInput({ assetId: "" })),
      expectRightsError("INVALID_RECORD"),
    );
  });

  it("infers music, sfx, image, and video kinds from synced asset metadata", () => {
    assert.equal(inferAssetRightsKind({ kind: "audio", folderPath: "Music/BGM" }), "music");
    assert.equal(inferAssetRightsKind({ kind: "audio", folderPath: "SFX/Impacts" }), "sfx");
    assert.equal(inferAssetRightsKind({ kind: "image" }), "image");
    assert.equal(inferAssetRightsKind({ kind: "video" }), "video");
  });

  it("creates an incomplete placeholder record for synced assets without metadata", () => {
    const record = createMissingAssetRightsRecord({
      normalizedPath: "c:/assets/music/hook.wav",
      name: "hook.wav",
      kind: "audio",
      folderPath: "Music",
    }, 1_750_000_000_000);

    assert.equal(record.kind, "music");
    assert.equal(record.commercialUse, "unknown");
    assert.equal(record.source, "");
    assert.equal(evaluateAssetRightsRecord(record).some((item) => item.code === "rights-commercial-unknown"), true);
  });

  it("creates warning-oriented rights records from AI reference board metadata", () => {
    const record = createReferenceAssetRightsRecord({
      id: "ref-hero",
      name: "hero.png",
      type: "image",
      nativePath: "C:\\Refs\\hero.png",
      source: "직접 촬영",
      notes: "캠페인 메인 이미지",
      tags: ["강렬함", "red"],
    }, 1_750_000_000_000);

    assert.equal(record.assetId, "C:\\Refs\\hero.png");
    assert.equal(record.kind, "image");
    assert.equal(record.source, "직접 촬영");
    assert.equal(record.attribution, "직접 촬영");
    assert.equal(record.commercialUse, "unknown");
    assert.match(record.notes, /캠페인 메인 이미지/u);
    assert.match(record.notes, /강렬함, red/u);

    const issueCodes = evaluateAssetRightsRecord(record, 1_750_000_000_000).map((item) => item.code);
    assert.equal(issueCodes.includes("rights-commercial-unknown"), true);
    assert.equal(issueCodes.includes("rights-license-missing"), true);
  });

  it("maps video references to video rights records and redacts reference notes", () => {
    const record = createReferenceAssetRightsRecord({
      id: "ref-video",
      name: "mood.mov",
      type: "video",
      source: "Vendor",
      notes: "api_key=sk-secret-value",
      tags: "#mood, reference",
    }, 1_750_000_000_000);

    assert.equal(record.assetId, "ref-video");
    assert.equal(record.kind, "video");
    assert.doesNotMatch(record.notes, /sk-secret/u);
    assert.match(record.notes, /mood, reference/u);
  });

  it("creates AI audio rights records for generated TTS outputs", () => {
    const record = createTtsAssetRightsRecord({
      nativePath: "C:\\TTS\\voice.mp3",
      name: "voice.mp3",
      model: "tts-1",
      voice: "alloy",
      format: "mp3",
    }, 1_750_000_000_000);

    assert.equal(record.assetId, "C:\\TTS\\voice.mp3");
    assert.equal(record.assetName, "voice.mp3");
    assert.equal(record.kind, "ai-audio");
    assert.equal(record.source, "OpenAI TTS");
    assert.equal(record.commercialUse, "unknown");
    assert.match(record.notes, /모델: tts-1/u);
    assert.match(record.notes, /AI 생성 음성/u);
    assert.equal(
      evaluateAssetRightsRecord(record, 1_750_000_000_000).some((item) => item.code === "rights-commercial-unknown"),
      true,
    );
  });

  it("redacts bearer, api key, and session-shaped secrets", () => {
    const text = redactRightsText("Bearer token_value_123 api_key=sk-abc123456789 sess-abcdef123456");
    assert.doesNotMatch(text, /token_value|sk-abc|sess-abcdef/u);
  });
});

describe("asset rights report", () => {
  it("passes a fully documented commercial asset and emits attribution", () => {
    const record = normalizeAssetRightsRecord(validInput());
    const report = createAssetRightsReport([record], 1_750_000_000_000);

    assert.equal(report.schemaVersion, ASSET_RIGHTS_SCHEMA_VERSION);
    assert.equal(report.blocking, false);
    assert.deepEqual(report.counts, { warning: 0, error: 0 });
    assert.deepEqual(report.attributionLines, ["Music: hook.wav, Artlist, Creator Pro"]);
  });

  it("blocks forbidden or expired assets and warns on incomplete metadata", () => {
    const forbidden = normalizeAssetRightsRecord(validInput({
      assetId: "ai-hero",
      assetName: "hero.png",
      kind: "ai-image",
      commercialUse: "forbidden",
      expiresAt: "2024-01-01",
      source: "",
      license: "",
      attribution: "",
    }));

    const issues = evaluateAssetRightsRecord(forbidden, 1_750_000_000_000);
    assert.deepEqual(
      issues.map((item) => item.code),
      [
        "rights-source-missing",
        "rights-license-missing",
        "rights-commercial-forbidden",
        "rights-attribution-missing",
        "rights-expired",
      ],
    );

    const report = createAssetRightsReport([forbidden], 1_750_000_000_000);
    assert.equal(report.blocking, true);
    assert.equal(report.counts.error, 2);
    assert.equal(report.counts.warning, 3);
  });

  it("deduplicates by asset id with last-write-wins semantics", () => {
    const first = normalizeAssetRightsRecord(validInput({ assetName: "A.wav" }));
    const second = normalizeAssetRightsRecord(validInput({ assetName: "B.wav" }));
    const report = createAssetRightsReport([first, second]);

    assert.equal(report.assets.length, 1);
    assert.equal(report.assets[0]?.assetName, "B.wav");
  });

  it("exports redacted JSON and Markdown reports", () => {
    const record = normalizeAssetRightsRecord(validInput({
      notes: "password=topsecret",
    }));
    const report = createAssetRightsReport([record]);

    assert.doesNotMatch(assetRightsReportToJSON(report), /topsecret/u);
    const markdown = assetRightsReportToMarkdown(report);
    assert.match(markdown, /ShortFlow 에셋 권리 리포트/u);
    assert.match(markdown, /출처 표기/u);
  });
});

describe("AssetRightsRegistry", () => {
  it("loads, upserts, reports, removes, and clears persisted rights records", async () => {
    const storage = new MemoryStorage();
    const registry = new AssetRightsRegistry(storage);

    assert.deepEqual(await registry.load(), []);
    await registry.upsert(validInput());
    await registry.upsert(validInput({ assetId: "c:/assets/sfx/pop.wav", assetName: "pop.wav", kind: "sfx" }));
    assert.equal(registry.items.length, 2);
    assert.equal(registry.report(1_750_000_000_000).blocking, false);

    const raw = storage.values.get(ASSET_RIGHTS_STORAGE_KEY);
    assert.ok(raw);
    const restored = new AssetRightsRegistry(storage);
    assert.equal((await restored.load()).length, 2);
    assert.equal(await restored.remove("c:/assets/sfx/pop.wav"), true);
    assert.equal(restored.items.length, 1);
    await restored.clear();
    assert.equal(storage.values.has(ASSET_RIGHTS_STORAGE_KEY), false);
  });

  it("maps storage failures to AssetRightsError", async () => {
    const storage = new MemoryStorage();
    storage.fail = true;
    const registry = new AssetRightsRegistry(storage);

    await assert.rejects(registry.load(), expectRightsError("STORAGE_ERROR"));
    await assert.rejects(registry.upsert(validInput()), expectRightsError("STORAGE_ERROR"));
  });
}
);
