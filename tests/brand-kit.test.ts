import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BRAND_KIT_SCHEMA_VERSION,
  BRAND_KIT_STORAGE_KEY,
  DEFAULT_BRAND_KIT,
  MAX_BRAND_KITS,
  BrandKitError,
  BrandKitLibrary,
  createDefaultBrandKitAdapter,
  normalizeBrandKit,
  validateBrandKit,
  type BrandKitInput,
  type BrandKitStorage,
} from "../src/brand-kit";

class MemoryStorage implements BrandKitStorage {
  readonly values = new Map<string, string>();
  writes = 0;
  removes = 0;
  failRead = false;
  failWrite = false;

  getItem(key: string): string | null {
    if (this.failRead) throw new Error("read denied");
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrite) throw new Error("write denied");
    this.writes += 1;
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.removes += 1;
    this.values.delete(key);
  }
}

function deterministicLibrary(
  storage = new MemoryStorage(),
  options: { maxKits?: number; storageKey?: string } = {},
): { library: BrandKitLibrary; storage: MemoryStorage } {
  let time = 1_700_000_000_000;
  const library = new BrandKitLibrary(
    { storage },
    {
      ...options,
      now: () => time++,
      idFactory: (_name, index) => `kit-${index + 1}`,
    },
  );
  return { library, storage };
}

function fullInput(overrides: BrandKitInput = {}): BrandKitInput {
  return {
    id: "studio-main",
    name: "스튜디오 메인",
    font: { family: "Noto Sans KR", weight: 800, fallback: "Arial, sans-serif" },
    colors: { primary: "#112233", secondary: "#445566", accent: "#abcdef" },
    logo: { token: "logo-token-123", name: "logo.png" },
    caption: { maxChars: 28, position: "center", shadow: true, highlight: true },
    thumbnail: {
      layout: "hero-left",
      backgroundColor: "#101010",
      textColor: "#fefefe",
      brightness: 110,
      contrast: 105,
      saturation: 120,
      shadow: 20,
      glow: 16,
      shadowColor: "#000000",
      glowColor: "#aa44ff",
    },
    tts: { model: "gpt-4o-mini-tts", voice: "marin", speed: 1.15 },
    mogrt: { token: "mogrt-token-456", name: "lower-third.mogrt", track: 3 },
    ...overrides,
  };
}

function codes(value: unknown): string[] {
  return validateBrandKit(value).map((item) => item.code);
}

describe("brand-kit constants and defaults", () => {
  it("uses a versioned v1 schema and production limit", () => {
    assert.equal(BRAND_KIT_SCHEMA_VERSION, 1);
    assert.equal(BRAND_KIT_STORAGE_KEY, "shortflow.brand-kits.v1");
    assert.equal(MAX_BRAND_KITS, 20);
  });

  it("provides complete default presets", () => {
    assert.equal(DEFAULT_BRAND_KIT.font.family, "Pretendard");
    assert.equal(DEFAULT_BRAND_KIT.colors.accent, "#8b5cf6");
    assert.equal(DEFAULT_BRAND_KIT.caption.maxChars, 24);
    assert.equal(DEFAULT_BRAND_KIT.thumbnail.layout, "full");
    assert.equal(DEFAULT_BRAND_KIT.tts.speed, 1);
    assert.equal(DEFAULT_BRAND_KIT.mogrt.track, 2);
  });

  it("does not embed a file capability in defaults", () => {
    assert.equal(DEFAULT_BRAND_KIT.logo.token, "");
    assert.equal(DEFAULT_BRAND_KIT.mogrt.token, "");
  });

  it("deep-freezes the default schema", () => {
    assert.ok(Object.isFrozen(DEFAULT_BRAND_KIT));
    assert.ok(Object.isFrozen(DEFAULT_BRAND_KIT.font));
    assert.ok(Object.isFrozen(DEFAULT_BRAND_KIT.thumbnail));
    assert.ok(Object.isFrozen(DEFAULT_BRAND_KIT.mogrt));
  });
});

describe("normalizeBrandKit", () => {
  it("normalizes an empty input to a complete kit", () => {
    const kit = normalizeBrandKit({}, { now: 100, generatedId: "kit-empty" });
    assert.equal(kit.schemaVersion, 1);
    assert.equal(kit.id, "kit-empty");
    assert.equal(kit.name, "새 브랜드 키트");
    assert.equal(kit.createdAt, 100);
    assert.equal(kit.updatedAt, 100);
  });

  it("preserves valid values across every preset group", () => {
    const kit = normalizeBrandKit(fullInput(), { now: 1 });
    assert.equal(kit.id, "studio-main");
    assert.equal(kit.font.family, "Noto Sans KR");
    assert.equal(kit.colors.primary, "#112233");
    assert.equal(kit.logo.token, "logo-token-123");
    assert.equal(kit.caption.position, "center");
    assert.equal(kit.thumbnail.layout, "hero-left");
    assert.equal(kit.tts.voice, "marin");
    assert.equal(kit.mogrt.track, 3);
  });

  it("cleans control characters and clamps long names", () => {
    const kit = normalizeBrandKit({ name: `  ACME\u0000\n ${"x".repeat(100)}  ` }, {
      now: 1,
      generatedId: "kit-clean",
    });
    assert.doesNotMatch(kit.name, /[\u0000-\u001f]/u);
    assert.ok(kit.name.startsWith("ACME x"));
    assert.equal(kit.name.length, 80);
  });

  it("accepts Unicode font families and canonicalizes fallback spacing", () => {
    const kit = normalizeBrandKit({
      font: { family: "  본고딕  ", fallback: "Arial,  Helvetica , sans-serif" },
    }, { now: 1, generatedId: "kit-font" });
    assert.equal(kit.font.family, "본고딕");
    assert.equal(kit.font.fallback, "Arial, Helvetica, sans-serif");
  });

  it("rejects CSS injection in font fields", () => {
    const kit = normalizeBrandKit({
      font: {
        family: "Arial; background:url(file:///secret)",
        fallback: "Arial, sans-serif; color:red",
      },
    }, { now: 1, generatedId: "kit-font" });
    assert.equal(kit.font.family, DEFAULT_BRAND_KIT.font.family);
    assert.equal(kit.font.fallback, DEFAULT_BRAND_KIT.font.fallback);
  });

  it("clamps and rounds font weights to CSS 100 steps", () => {
    assert.equal(normalizeBrandKit({ font: { weight: 50 } }).font.weight, 100);
    assert.equal(normalizeBrandKit({ font: { weight: 749 } }).font.weight, 700);
    assert.equal(normalizeBrandKit({ font: { weight: 999 } }).font.weight, 900);
  });

  it("expands three-digit colors and lowercases valid colors", () => {
    const kit = normalizeBrandKit({
      colors: { primary: " #AbC ", secondary: "#DDEEFF", accent: "#123456" },
    });
    assert.deepEqual(kit.colors, {
      primary: "#aabbcc",
      secondary: "#ddeeff",
      accent: "#123456",
    });
  });

  it("falls back from named, alpha, and executable color strings", () => {
    const kit = normalizeBrandKit({
      colors: { primary: "red", secondary: "#000000ff", accent: "url(secret)" },
    });
    assert.deepEqual(kit.colors, DEFAULT_BRAND_KIT.colors);
  });

  it("stores valid logo token and filename together", () => {
    const kit = normalizeBrandKit({ logo: { token: "  opaque token ==  ", name: " logo.webp " } });
    assert.equal(kit.logo.token, "opaque token ==");
    assert.equal(kit.logo.name, "logo.webp");
  });

  it("drops orphaned, control-byte, and oversized persistent tokens", () => {
    assert.equal(normalizeBrandKit({ logo: { token: "token", name: "" } }).logo.token, "");
    assert.equal(normalizeBrandKit({ logo: { token: "bad\u0000token", name: "logo.png" } }).logo.token, "");
    assert.equal(normalizeBrandKit({ logo: { token: "x".repeat(5_000), name: "logo.png" } }).logo.token, "");
  });

  it("clamps caption length and defaults invalid position and booleans", () => {
    const kit = normalizeBrandKit({
      caption: { maxChars: 500, position: "side", shadow: "yes", highlight: 1 },
    });
    assert.equal(kit.caption.maxChars, 80);
    assert.equal(kit.caption.position, "bottom");
    assert.equal(kit.caption.shadow, true);
    assert.equal(kit.caption.highlight, false);
  });

  it("normalizes thumbnail layout, colors, and effect ranges", () => {
    const kit = normalizeBrandKit({
      thumbnail: {
        layout: "diagonal",
        backgroundColor: "nope",
        brightness: -10,
        contrast: 999,
        saturation: Number.NaN,
        shadow: -1,
        glow: 500,
      },
    });
    assert.equal(kit.thumbnail.layout, "full");
    assert.equal(kit.thumbnail.backgroundColor, "#111111");
    assert.equal(kit.thumbnail.brightness, 0);
    assert.equal(kit.thumbnail.contrast, 200);
    assert.equal(kit.thumbnail.saturation, 100);
    assert.equal(kit.thumbnail.shadow, 0);
    assert.equal(kit.thumbnail.glow, 100);
  });

  it("normalizes TTS model, voice, and speed", () => {
    const valid = normalizeBrandKit({ tts: { model: "tts-1-hd", voice: "cedar", speed: 4 } });
    assert.equal(valid.tts.model, "tts-1-hd");
    assert.equal(valid.tts.voice, "cedar");
    assert.equal(valid.tts.speed, 4);
    const invalid = normalizeBrandKit({ tts: { model: "shell", voice: "", speed: -20 } });
    assert.deepEqual(invalid.tts, { model: "gpt-4o-mini-tts", voice: "marin", speed: 0.25 });
  });

  it("requires a .mogrt name before retaining its capability token", () => {
    const good = normalizeBrandKit({ mogrt: { name: "Title.MOGRT", token: "opaque", track: 100 } });
    assert.equal(good.mogrt.name, "Title.MOGRT");
    assert.equal(good.mogrt.token, "opaque");
    assert.equal(good.mogrt.track, 99);
    const bad = normalizeBrandKit({ mogrt: { name: "payload.exe", token: "opaque", track: 0 } });
    assert.equal(bad.mogrt.name, "");
    assert.equal(bad.mogrt.token, "");
    assert.equal(bad.mogrt.track, 1);
  });

  it("supports explicit ID and timestamp authority", () => {
    const kit = normalizeBrandKit(
      { id: "attacker-id", createdAt: 500, updatedAt: 100 },
      { now: 1_000, forceId: "trusted-id" },
    );
    assert.equal(kit.id, "trusted-id");
    assert.equal(kit.createdAt, 500);
    assert.equal(kit.updatedAt, 500);
  });

  it("strips file capabilities for portable normalization", () => {
    const kit = normalizeBrandKit(fullInput(), { now: 1, stripTokens: true });
    assert.equal(kit.logo.name, "logo.png");
    assert.equal(kit.logo.token, "");
    assert.equal(kit.mogrt.name, "lower-third.mogrt");
    assert.equal(kit.mogrt.token, "");
  });

  it("deep-freezes every normalized nested preset", () => {
    const kit = normalizeBrandKit(fullInput());
    assert.ok(Object.isFrozen(kit));
    assert.ok(Object.isFrozen(kit.font));
    assert.ok(Object.isFrozen(kit.colors));
    assert.ok(Object.isFrozen(kit.logo));
    assert.ok(Object.isFrozen(kit.caption));
    assert.ok(Object.isFrozen(kit.thumbnail));
    assert.ok(Object.isFrozen(kit.tts));
    assert.ok(Object.isFrozen(kit.mogrt));
  });
});

describe("validateBrandKit", () => {
  it("rejects non-object roots", () => {
    assert.deepEqual(codes(null), ["INVALID_OBJECT"]);
    assert.deepEqual(codes([]), ["INVALID_OBJECT"]);
  });

  it("accepts a fully normalized kit", () => {
    assert.deepEqual(validateBrandKit(normalizeBrandKit(fullInput())), []);
  });

  it("reports version, id, and name errors", () => {
    const result = codes({ schemaVersion: 99, id: "../bad", name: "" });
    assert.ok(result.includes("UNSUPPORTED_VERSION"));
    assert.ok(result.includes("INVALID_ID"));
    assert.ok(result.includes("INVALID_NAME"));
  });

  it("reports unsafe font declarations and nonstandard weight", () => {
    const result = validateBrandKit({
      font: { family: "Arial;url(x)", fallback: "Arial;color:red", weight: 750 },
    });
    assert.equal(result.filter((item) => item.code === "INVALID_FONT").length, 2);
    assert.ok(result.some((item) => item.code === "FONT_WEIGHT_ROUNDED" && item.level === "warning"));
  });

  it("reports every invalid brand color", () => {
    const result = validateBrandKit({
      colors: { primary: "red", secondary: "#12", accent: "#000000ff" },
    });
    assert.equal(result.filter((item) => item.code === "INVALID_COLOR").length, 3);
  });

  it("reports invalid and orphaned persistent tokens", () => {
    const invalid = codes({ logo: { token: "bad\u0000token", name: "logo.png" } });
    assert.ok(invalid.includes("INVALID_TOKEN"));
    const orphaned = codes({ logo: { token: "valid-token", name: "" } });
    assert.ok(orphaned.includes("TOKEN_WITHOUT_NAME"));
  });

  it("reports invalid MOGRT extension and track", () => {
    const result = codes({ mogrt: { name: "preset.exe", token: "token", track: 0 } });
    assert.ok(result.includes("INVALID_MOGRT"));
    assert.ok(result.includes("OUT_OF_RANGE"));
  });

  it("reports invalid caption fields", () => {
    const result = codes({
      caption: { maxChars: 2, position: "left", shadow: 1, highlight: "yes" },
    });
    assert.ok(result.includes("OUT_OF_RANGE"));
    assert.ok(result.includes("INVALID_POSITION"));
    assert.equal(result.filter((code) => code === "INVALID_BOOLEAN").length, 2);
  });

  it("reports invalid thumbnail layout, colors, and effect ranges", () => {
    const result = validateBrandKit({
      thumbnail: {
        layout: "diagonal",
        backgroundColor: "black",
        brightness: 201,
        glow: -1,
      },
    });
    assert.ok(result.some((item) => item.code === "INVALID_LAYOUT"));
    assert.ok(result.some((item) => item.code === "INVALID_COLOR"));
    assert.equal(result.filter((item) => item.code === "OUT_OF_RANGE").length, 2);
  });

  it("reports invalid TTS model, voice, and speed", () => {
    const result = codes({ tts: { model: "unknown", voice: "", speed: Number.POSITIVE_INFINITY } });
    assert.ok(result.includes("INVALID_TTS_MODEL"));
    assert.ok(result.includes("INVALID_VOICE"));
    assert.ok(result.includes("OUT_OF_RANGE"));
  });
});

describe("BrandKitLibrary CRUD and storage", () => {
  it("loads an empty store", async () => {
    const { library } = deterministicLibrary();
    assert.deepEqual(await library.load(), []);
    assert.equal(library.activeKit, null);
  });

  it("creates, activates, and persists the first kit", async () => {
    const { library, storage } = deterministicLibrary();
    const kit = await library.create({ name: "Alpha" });
    assert.equal(kit.id, "kit-1");
    assert.equal(library.activeKitId, kit.id);
    assert.equal(library.activeKit, kit);
    const stored = JSON.parse(storage.values.get(BRAND_KIT_STORAGE_KEY) ?? "") as { kits: unknown[] };
    assert.equal(stored.kits.length, 1);
  });

  it("keeps a stable id and creation time across updates", async () => {
    const { library } = deterministicLibrary();
    const created = await library.create(fullInput({ id: "stable-id" }));
    const updated = await library.update(created.id, { name: "Renamed" });
    assert.equal(updated.id, "stable-id");
    assert.equal(updated.createdAt, created.createdAt);
    assert.ok(updated.updatedAt > created.updatedAt);
  });

  it("deep-merges a nested update without losing other fields", async () => {
    const { library } = deterministicLibrary();
    const created = await library.create(fullInput());
    const updated = await library.update(created.id, {
      colors: { accent: "#ff0000" },
      thumbnail: { contrast: 140 },
    });
    assert.equal(updated.colors.primary, "#112233");
    assert.equal(updated.colors.accent, "#ff0000");
    assert.equal(updated.thumbnail.brightness, 110);
    assert.equal(updated.thumbnail.contrast, 140);
  });

  it("duplicates a kit with a new stable id while retaining local tokens", async () => {
    const { library } = deterministicLibrary();
    const source = await library.create(fullInput());
    const copy = await library.duplicate(source.id, "Campaign B");
    assert.notEqual(copy.id, source.id);
    assert.equal(copy.name, "Campaign B");
    assert.equal(copy.logo.token, source.logo.token);
    assert.equal(copy.mogrt.token, source.mogrt.token);
    assert.notEqual(copy.createdAt, source.createdAt);
  });

  it("defends against caller-supplied duplicate ids", async () => {
    const { library } = deterministicLibrary();
    const first = await library.create({ id: "same-id", name: "A" });
    const second = await library.create({ id: "same-id", name: "B" });
    assert.equal(first.id, "same-id");
    assert.equal(second.id, "same-id-2");
  });

  it("sets and clears the active kit", async () => {
    const { library } = deterministicLibrary();
    const first = await library.create({ name: "A" });
    const second = await library.create({ name: "B" });
    assert.equal((await library.setActive(second.id))?.id, second.id);
    assert.equal(library.activeKitId, second.id);
    assert.equal(await library.setActive(null), null);
    assert.equal(library.activeKitId, null);
    assert.notEqual(first.id, second.id);
  });

  it("clears active selection when removing the active kit", async () => {
    const { library } = deterministicLibrary();
    const kit = await library.create({ name: "A" });
    const removed = await library.remove(kit.id);
    assert.equal(removed.id, kit.id);
    assert.equal(library.activeKitId, null);
    assert.equal(library.get(kit.id), null);
  });

  it("throws typed NOT_FOUND errors for missing ids", async () => {
    const { library } = deterministicLibrary();
    for (const operation of [
      library.update("missing", {}),
      library.remove("missing"),
      library.duplicate("missing"),
      library.setActive("missing"),
    ]) {
      await assert.rejects(operation, (error: unknown) => (
        error instanceof BrandKitError && error.code === "NOT_FOUND"
      ));
    }
  });

  it("enforces the configured and absolute kit limit", async () => {
    const { library } = deterministicLibrary(new MemoryStorage(), { maxKits: 2 });
    await library.create({ name: "A" });
    await library.create({ name: "B" });
    await assert.rejects(
      library.create({ name: "C" }),
      (error: unknown) => error instanceof BrandKitError && error.code === "LIMIT_EXCEEDED",
    );
    assert.equal(library.kits.length, 2);
  });

  it("serializes concurrent mutations without duplicate ids", async () => {
    const { library } = deterministicLibrary();
    const created = await Promise.all(
      Array.from({ length: 12 }, (_value, index) => library.create({ name: `Kit ${index}` })),
    );
    assert.equal(new Set(created.map((kit) => kit.id)).size, 12);
    assert.equal(library.kits.length, 12);
  });

  it("restores active kit and persistent tokens from storage", async () => {
    const storage = new MemoryStorage();
    const first = deterministicLibrary(storage).library;
    const kit = await first.create(fullInput());
    await first.setActive(kit.id);
    const second = deterministicLibrary(storage).library;
    await second.load();
    assert.equal(second.activeKitId, kit.id);
    assert.equal(second.activeKit?.logo.token, "logo-token-123");
    assert.equal(second.activeKit?.mogrt.token, "mogrt-token-456");
  });

  it("skips duplicate ids in a tampered stored document", async () => {
    const storage = new MemoryStorage();
    const kit = normalizeBrandKit(fullInput(), { now: 1 });
    storage.values.set(BRAND_KIT_STORAGE_KEY, JSON.stringify({
      schemaVersion: 1,
      activeKitId: kit.id,
      kits: [kit, { ...kit, name: "Tampered duplicate" }],
    }));
    const { library } = deterministicLibrary(storage);
    await library.load();
    assert.equal(library.kits.length, 1);
    assert.equal(library.kits[0]?.name, "스튜디오 메인");
  });

  it("wraps storage read and write failures", async () => {
    const storage = new MemoryStorage();
    storage.failRead = true;
    const { library } = deterministicLibrary(storage);
    await assert.rejects(
      library.load(),
      (error: unknown) => error instanceof BrandKitError && error.code === "STORAGE_ERROR",
    );
    storage.failRead = false;
    storage.failWrite = true;
    await assert.rejects(
      library.create({ name: "A" }),
      (error: unknown) => error instanceof BrandKitError && error.code === "STORAGE_ERROR",
    );
    assert.equal(library.kits.length, 0, "failed persistence must roll back memory state");
    assert.equal(library.activeKitId, null);
  });

  it("clears persisted state through removeItem", async () => {
    const { library, storage } = deterministicLibrary();
    await library.create({ name: "A" });
    await library.clear();
    assert.equal(library.kits.length, 0);
    assert.equal(storage.values.has(BRAND_KIT_STORAGE_KEY), false);
    assert.equal(storage.removes, 1);
  });

  it("supports a custom storage key", async () => {
    const storage = new MemoryStorage();
    const { library } = deterministicLibrary(storage, { storageKey: "custom.brand" });
    await library.create({ name: "A" });
    assert.ok(storage.values.has("custom.brand"));
    assert.equal(storage.values.has(BRAND_KIT_STORAGE_KEY), false);
  });

  it("creates the default adapter from an explicit UXP-compatible storage", () => {
    const storage = new MemoryStorage();
    assert.equal(createDefaultBrandKitAdapter(storage).storage, storage);
  });
});

describe("brand-kit JSON import and export", () => {
  it("exports a versioned, readable JSON document", async () => {
    const { library } = deterministicLibrary();
    await library.create(fullInput());
    const json = library.exportJSON();
    const parsed = JSON.parse(json) as { schemaVersion: number; kits: unknown[] };
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.kits.length, 1);
    assert.ok(json.includes("\n  \"schemaVersion\""));
  });

  it("excludes persistent capabilities, secrets, binary, and entry objects", async () => {
    const { library } = deterministicLibrary();
    await library.create({
      ...fullInput(),
      secret: "api-secret",
      binary: [1, 2, 3],
      entry: { nativePath: "C:/private/logo.png" },
    } as BrandKitInput);
    const parsed = JSON.parse(library.exportJSON()) as {
      kits: Array<Record<string, unknown> & {
        logo: { token?: string };
        mogrt: { token?: string };
      }>;
    };
    const exported = parsed.kits[0]!;
    assert.equal(exported.logo.token, undefined);
    assert.equal(exported.mogrt.token, undefined);
    assert.equal(exported.secret, undefined);
    assert.equal(exported.binary, undefined);
    assert.equal(exported.entry, undefined);
    assert.equal(library.kits[0]?.logo.token, "logo-token-123");
  });

  it("exports a selected subset and clears unrelated active id", async () => {
    const { library } = deterministicLibrary();
    const first = await library.create({ name: "A" });
    const second = await library.create({ name: "B" });
    await library.setActive(first.id);
    const parsed = JSON.parse(library.exportJSON([second.id])) as {
      activeKitId: string | null;
      kits: Array<{ id: string }>;
    };
    assert.equal(parsed.activeKitId, null);
    assert.deepEqual(parsed.kits.map((kit) => kit.id), [second.id]);
  });

  it("rejects an unknown export id", () => {
    const { library } = deterministicLibrary();
    assert.throws(
      () => library.exportJSON(["missing"]),
      (error: unknown) => error instanceof BrandKitError && error.code === "NOT_FOUND",
    );
  });

  it("round-trips portable presets while stripping tokens", async () => {
    const source = deterministicLibrary().library;
    const original = await source.create(fullInput());
    const target = deterministicLibrary().library;
    const [imported] = await target.importJSON(source.exportJSON());
    assert.ok(imported);
    assert.equal(imported.id, original.id);
    assert.equal(imported.font.family, original.font.family);
    assert.equal(imported.thumbnail.layout, original.thumbnail.layout);
    assert.equal(imported.logo.name, original.logo.name);
    assert.equal(imported.logo.token, "");
    assert.equal(imported.mogrt.token, "");
  });

  it("ignores malicious token fields in imported JSON", async () => {
    const { library } = deterministicLibrary();
    const json = JSON.stringify({
      schemaVersion: 1,
      exportedAt: 1,
      activeKitId: "safe-id",
      kits: [{
        id: "safe-id",
        name: "Imported",
        logo: { name: "logo.png", token: "stolen-capability" },
        mogrt: { name: "title.mogrt", token: "stolen-capability", track: 2 },
      }],
    });
    const [kit] = await library.importJSON(json);
    assert.equal(kit?.logo.token, "");
    assert.equal(kit?.mogrt.token, "");
  });

  it("remaps duplicate ids without overwriting existing kits", async () => {
    const { library } = deterministicLibrary();
    await library.create({ id: "same-id", name: "Existing" });
    const imported = await library.importJSON(JSON.stringify({
      schemaVersion: 1,
      exportedAt: 1,
      activeKitId: "same-id",
      kits: [
        { id: "same-id", name: "Imported A" },
        { id: "same-id", name: "Imported B" },
      ],
    }));
    assert.deepEqual(imported.map((kit) => kit.id), ["same-id-2", "same-id-3"]);
    assert.equal(new Set(library.kits.map((kit) => kit.id)).size, 3);
  });

  it("generates safe ids for malformed imported ids", async () => {
    const { library } = deterministicLibrary();
    const [kit] = await library.importJSON(JSON.stringify({
      schemaVersion: 1,
      exportedAt: 1,
      activeKitId: null,
      kits: [{ id: "../../bad", name: "Bad Id" }],
    }));
    assert.match(kit?.id ?? "", /^[a-z0-9][a-z0-9_-]{2,63}$/u);
    assert.doesNotMatch(kit?.id ?? "", /\.\.|\//u);
  });

  it("can regenerate every id when preserveIds is false", async () => {
    const { library } = deterministicLibrary();
    const [kit] = await library.importJSON(JSON.stringify({
      schemaVersion: 1,
      exportedAt: 1,
      activeKitId: "original-id",
      kits: [{ id: "original-id", name: "Imported" }],
    }), { preserveIds: false });
    assert.equal(kit?.id, "kit-1");
    assert.equal(library.activeKitId, "kit-1");
  });

  it("replaces current kits atomically when requested", async () => {
    const { library } = deterministicLibrary();
    await library.create({ name: "Old" });
    const [fresh] = await library.importJSON(JSON.stringify({
      schemaVersion: 1,
      exportedAt: 1,
      activeKitId: "fresh-id",
      kits: [{ id: "fresh-id", name: "Fresh" }],
    }), { replace: true });
    assert.equal(library.kits.length, 1);
    assert.equal(library.kits[0]?.name, "Fresh");
    assert.equal(library.activeKitId, fresh?.id ?? null);
  });

  it("rejects an over-limit import without partial mutation", async () => {
    const { library } = deterministicLibrary(new MemoryStorage(), { maxKits: 2 });
    const existing = await library.create({ name: "Existing" });
    const json = JSON.stringify({
      schemaVersion: 1,
      exportedAt: 1,
      activeKitId: null,
      kits: [{ name: "A" }, { name: "B" }],
    });
    await assert.rejects(
      library.importJSON(json),
      (error: unknown) => error instanceof BrandKitError && error.code === "LIMIT_EXCEEDED",
    );
    assert.deepEqual(library.kits.map((kit) => kit.id), [existing.id]);
  });

  it("rejects invalid JSON and document shapes", async () => {
    const { library } = deterministicLibrary();
    for (const json of ["{", "[]", JSON.stringify({ schemaVersion: 1 })]) {
      await assert.rejects(
        library.importJSON(json),
        (error: unknown) => error instanceof BrandKitError && error.code === "INVALID_IMPORT",
      );
    }
  });

  it("rejects unsupported schema versions", async () => {
    const { library } = deterministicLibrary();
    await assert.rejects(
      library.importJSON(JSON.stringify({ schemaVersion: 999, kits: [] })),
      (error: unknown) => error instanceof BrandKitError && error.code === "UNSUPPORTED_VERSION",
    );
  });

  it("rejects non-object kit entries without mutation", async () => {
    const { library } = deterministicLibrary();
    await assert.rejects(
      library.importJSON(JSON.stringify({ schemaVersion: 1, kits: [null] })),
      (error: unknown) => error instanceof BrandKitError && error.code === "INVALID_INPUT",
    );
    assert.equal(library.kits.length, 0);
  });

  it("rejects JSON larger than the import safety limit", async () => {
    const { library } = deterministicLibrary();
    const huge = JSON.stringify({ schemaVersion: 1, kits: [], padding: "x".repeat(2_000_100) });
    await assert.rejects(
      library.importJSON(huge),
      (error: unknown) => error instanceof BrandKitError && error.code === "IMPORT_TOO_LARGE",
    );
  });
});
