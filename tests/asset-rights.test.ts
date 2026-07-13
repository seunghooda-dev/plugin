import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ASSET_RIGHTS_SCHEMA_VERSION,
  ASSET_RIGHTS_STORAGE_KEY,
  MAX_ASSET_RIGHTS_ITEMS,
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

describe("asset rights expiry evaluation", () => {
  const now = Date.parse("2025-06-15T00:00:00Z");

  function expiryCodes(expiresAt: unknown): string[] {
    return evaluateAssetRightsRecord(normalizeAssetRightsRecord(validInput({ expiresAt })), now)
      .map((item) => item.code);
  }

  it("raises no issues for a fully documented, far-future licensed asset", () => {
    assert.deepEqual(evaluateAssetRightsRecord(normalizeAssetRightsRecord(validInput()), now), []);
  });

  it("errors when the license expiry date is already in the past", () => {
    const issues = evaluateAssetRightsRecord(
      normalizeAssetRightsRecord(validInput({ expiresAt: "2025-06-01" })),
      now,
    );
    const expired = issues.find((item) => item.code === "rights-expired");
    assert.equal(expired?.level, "error");
    assert.deepEqual(issues.map((item) => item.code), ["rights-expired"]);
  });

  it("warns when the license expires within thirty days", () => {
    assert.deepEqual(expiryCodes("2025-06-20"), ["rights-expiry-soon"]);
  });

  it("stays silent when the expiry is more than thirty days away", () => {
    assert.deepEqual(expiryCodes("2030-01-01"), []);
  });

  it("warns instead of throwing when a stored expiry cannot be parsed", () => {
    const record = normalizeAssetRightsRecord(validInput({ expiresAt: "sometime next year" }));
    assert.equal(record.expiresAt, "sometime next year");
    assert.deepEqual(expiryCodes("sometime next year"), ["rights-expiry-invalid"]);
  });

  it("treats a blank expiry as no expiry constraint", () => {
    const record = normalizeAssetRightsRecord(validInput({ expiresAt: "   " }));
    assert.equal(record.expiresAt, null);
    assert.deepEqual(expiryCodes("   "), []);
  });
});

describe("asset rights field validation", () => {
  const now = Date.parse("2025-06-15T00:00:00Z");

  it("flags forbidden commercial use as a blocking error", () => {
    const issues = evaluateAssetRightsRecord(
      normalizeAssetRightsRecord(validInput({ commercialUse: "forbidden" })),
      now,
    );
    const forbidden = issues.find((item) => item.code === "rights-commercial-forbidden");
    assert.equal(forbidden?.level, "error");
  });

  it("collapses unknown or unrecognized commercial-use states to an unknown warning", () => {
    assert.equal(normalizeAssetRightsRecord(validInput({ commercialUse: "maybe" })).commercialUse, "unknown");
    const issues = evaluateAssetRightsRecord(
      normalizeAssetRightsRecord(validInput({ commercialUse: "maybe" })),
      now,
    );
    assert.equal(issues.some((item) => item.code === "rights-commercial-unknown"), true);
  });

  it("falls back to the 'other' kind for an unrecognized kind", () => {
    assert.equal(normalizeAssetRightsRecord(validInput({ kind: "banana" })).kind, "other");
  });

  it("requires a non-empty asset name", () => {
    assert.throws(
      () => normalizeAssetRightsRecord(validInput({ assetName: "   " })),
      expectRightsError("INVALID_RECORD"),
    );
  });

  it("warns on each missing provenance field without blocking export", () => {
    const record = normalizeAssetRightsRecord(validInput({ source: "", license: "", attribution: "" }));
    assert.deepEqual(
      evaluateAssetRightsRecord(record, now).map((item) => item.code),
      ["rights-source-missing", "rights-license-missing", "rights-attribution-missing"],
    );
    assert.equal(createAssetRightsReport([record], now).blocking, false);
  });

  it("rejects a placeholder record that lacks any stable identity", () => {
    assert.throws(() => createMissingAssetRightsRecord({}), expectRightsError("INVALID_RECORD"));
  });
});

describe("asset rights report guards", () => {
  const now = Date.parse("2025-06-15T00:00:00Z");

  it("rejects a non-array record set", () => {
    assert.throws(
      () => createAssetRightsReport(null as unknown as never[]),
      expectRightsError("INVALID_RECORD"),
    );
  });

  it("rejects a record set beyond the safety cap before normalizing anything", () => {
    assert.throws(
      () => createAssetRightsReport(new Array(MAX_ASSET_RIGHTS_ITEMS + 1) as never[]),
      expectRightsError("INPUT_TOO_LARGE"),
    );
  });

  it("deduplicates identical attribution lines across distinct assets", () => {
    const report = createAssetRightsReport([
      normalizeAssetRightsRecord(validInput({ assetId: "a", assetName: "a.wav", attribution: "Shared credit" })),
      normalizeAssetRightsRecord(validInput({ assetId: "b", assetName: "b.wav", attribution: "Shared credit" })),
    ], now);
    assert.equal(report.assets.length, 2);
    assert.deepEqual(report.attributionLines, ["Shared credit"]);
  });

  it("renders a passing markdown and JSON gate when there are no issues", () => {
    const report = createAssetRightsReport([normalizeAssetRightsRecord(validInput())], now);
    const markdown = assetRightsReportToMarkdown(report);
    assert.match(markdown, /게이트: \*\*통과\*\*/u);
    assert.match(markdown, /권리 정보 문제가 없습니다/u);
    const parsed = JSON.parse(assetRightsReportToJSON(report)) as {
      blocking: boolean;
      counts: { error: number; warning: number };
    };
    assert.equal(parsed.blocking, false);
    assert.deepEqual(parsed.counts, { error: 0, warning: 0 });
  });
});

describe("AssetRightsRegistry edge cases", () => {
  it("loads a bare persisted array as well as the wrapped document shape", async () => {
    const storage = new MemoryStorage();
    storage.values.set(ASSET_RIGHTS_STORAGE_KEY, JSON.stringify([validInput()]));
    const registry = new AssetRightsRegistry(storage);
    assert.equal((await registry.load()).length, 1);
  });

  it("treats a persisted document without an assets array as empty", async () => {
    const storage = new MemoryStorage();
    storage.values.set(ASSET_RIGHTS_STORAGE_KEY, JSON.stringify({ schemaVersion: 1 }));
    const registry = new AssetRightsRegistry(storage);
    assert.deepEqual(await registry.load(), []);
  });

  it("maps corrupted persisted JSON to a storage error", async () => {
    const storage = new MemoryStorage();
    storage.values.set(ASSET_RIGHTS_STORAGE_KEY, "{ not valid json");
    const registry = new AssetRightsRegistry(storage);
    await assert.rejects(registry.load(), expectRightsError("STORAGE_ERROR"));
  });

  it("surfaces a malformed persisted record as an invalid-record error", async () => {
    const storage = new MemoryStorage();
    storage.values.set(ASSET_RIGHTS_STORAGE_KEY, JSON.stringify({ assets: [{ assetId: "only-id" }] }));
    const registry = new AssetRightsRegistry(storage);
    await assert.rejects(registry.load(), expectRightsError("INVALID_RECORD"));
  });

  it("does not persist when removing an unknown asset id", async () => {
    const storage = new MemoryStorage();
    const registry = new AssetRightsRegistry(storage);
    assert.equal(await registry.remove("c:/assets/nope.wav"), false);
    assert.equal(storage.values.has(ASSET_RIGHTS_STORAGE_KEY), false);
  });

  it("merges a partial upsert onto the existing record", async () => {
    const storage = new MemoryStorage();
    const registry = new AssetRightsRegistry(storage);
    await registry.upsert(validInput());
    const merged = await registry.upsert({ assetId: validInput().assetId, notes: "renewed" });
    assert.equal(merged.notes, "renewed");
    assert.equal(merged.source, "Artlist");
    assert.equal(merged.commercialUse, "allowed");
    assert.equal(registry.items.length, 1);
  });

  it("maps a clear() storage failure to a storage error", async () => {
    const storage = new MemoryStorage();
    const registry = new AssetRightsRegistry(storage);
    await registry.upsert(validInput());
    storage.fail = true;
    await assert.rejects(registry.clear(), expectRightsError("STORAGE_ERROR"));
  });
});
