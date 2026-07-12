import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ASSET_LIBRARY_TOKEN_KEY,
  AssetLibrary,
  AssetLibraryError,
  applyAssetOrder,
  audioAssetCategoryRoot,
  createAssetDragPayload,
  parseAudioAssetDragPayload,
  parseAssetDragPayload,
  listAudioAssetCategories,
  reorderAssetIds,
  resolveAudioAssetDragTarget,
  type AssetItem,
  type AssetLibraryAdapter,
  classifyAsset,
  filterAssets,
  isSupportedAsset,
  normalizeAssetOrder,
  normalizeNativePath,
  sortAssets,
} from "../src/asset-library";

type MockEntry = {
  name: string;
  nativePath: string;
  isFile?: boolean;
  isFolder?: boolean;
  size?: number;
  dateModified?: Date;
  getEntries?: () => Promise<MockEntry[]>;
  createFolder?: (name: string) => Promise<MockEntry>;
  getMetadata?: () => Promise<Record<string, unknown>>;
  children?: MockEntry[];
};

function mockFile(
  name: string,
  nativePath: string,
  metadata: Record<string, unknown> = {},
): MockEntry {
  return {
    name,
    nativePath,
    isFile: true,
    isFolder: false,
    getMetadata: async () => metadata,
  };
}

function mockFolder(
  name: string,
  nativePath: string,
  children: MockEntry[] = [],
): MockEntry {
  const folder: MockEntry = {
    name,
    nativePath,
    isFile: false,
    isFolder: true,
    children,
  };
  folder.getEntries = async () => folder.children ?? [];
  folder.createFolder = async (childName: string) => {
    const path = `${nativePath.replace(/[\\/]$/u, "")}/${childName}`;
    const child = mockFolder(childName, path);
    folder.children?.push(child);
    return child;
  };
  return folder;
}

class MemoryStorage {
  readonly values = new Map<string, string>();
  removeError: unknown = null;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    if (this.removeError) throw this.removeError;
    this.values.delete(key);
  }
}

function createAdapter(
  root: MockEntry,
  storage = new MemoryStorage(),
): AssetLibraryAdapter {
  return {
    localFileSystem: {
      getFolder: async () => root,
      createPersistentToken: async () => "persistent-root-token",
      getEntryForPersistentToken: async () => root,
    },
    storage,
  };
}

function asset(
  name: string,
  kind: AssetItem["kind"],
  path = `/Library/${name}`,
  extras: Partial<AssetItem> = {},
): AssetItem {
  return {
    id: normalizeNativePath(path),
    name,
    nativePath: path,
    normalizedPath: normalizeNativePath(path),
    relativePath: name,
    folderPath: "/Library",
    extension: name.slice(name.lastIndexOf(".")).toLowerCase(),
    kind,
    ...extras,
  };
}

function assertLibraryError(
  error: unknown,
  code: AssetLibraryError["code"],
): boolean {
  assert.ok(error instanceof AssetLibraryError);
  assert.equal(error.code, code);
  assert.ok(error.message.trim().length > 0);
  return true;
}

describe("asset classification", () => {
  it("classifies supported audio, image, and video extensions case-insensitively", () => {
    assert.equal(classifyAsset("Music/HOOK.WAV"), "audio");
    assert.equal(classifyAsset("reference.final.JpEg"), "image");
    assert.equal(classifyAsset("clip.MXF"), "video");
    assert.equal(classifyAsset("camera.M2TS"), "video");
  });

  it("rejects folders, extensionless names, sidecars, and misleading suffixes", () => {
    for (const value of ["", "Music", ".mp4", "clip.mp4.txt", "notes.srt", "x.mp4/"]) {
      assert.equal(classifyAsset(value), null, value);
      assert.equal(isSupportedAsset(value), false, value);
    }
  });

  it("exposes isSupportedAsset as the boolean classification helper", () => {
    assert.equal(isSupportedAsset("voice.aiff"), true);
    assert.equal(isSupportedAsset("cover.webp"), true);
    assert.equal(isSupportedAsset("video.mov"), true);
  });
});

describe("normalizeNativePath", () => {
  it("normalizes Windows separators, case, dot segments, and trailing slashes", () => {
    assert.equal(
      normalizeNativePath(" C:\\Users\\Editor\\Assets\\.\\Music\\..\\HOOK.WAV  "),
      "c:/users/editor/assets/hook.wav",
    );
    assert.equal(normalizeNativePath("C:/"), "c:/");
  });

  it("normalizes UNC paths while preserving their root", () => {
    assert.equal(
      normalizeNativePath("\\\\NAS\\Share\\References\\..\\VIDEO.MOV"),
      "//nas/share/video.mov",
    );
  });

  it("preserves POSIX case sensitivity and unresolved relative parents", () => {
    assert.equal(normalizeNativePath("/Users/Editor/../Media/Clip.MOV/"), "/Users/Media/Clip.MOV");
    assert.equal(normalizeNativePath("../../Media/clip.mov"), "../../Media/clip.mov");
    assert.equal(normalizeNativePath("   "), "");
  });
});

describe("asset drag payload", () => {
  it("serializes only path-derived metadata and round-trips a valid payload", () => {
    const source = asset("Hook.wav", "audio", "C:\\Assets\\Music\\Hook.wav", {
      entry: { capabilityToken: "must-not-leak" },
    });
    const serialized = createAssetDragPayload(source);
    assert.doesNotMatch(serialized, /capabilityToken|must-not-leak/u);
    assert.deepEqual(parseAssetDragPayload(serialized), {
      version: 1,
      id: "c:/assets/music/hook.wav",
      nativePath: "C:\\Assets\\Music\\Hook.wav",
      name: "Hook.wav",
      kind: "audio",
    });
  });

  it("rejects a malformed or path-forged payload", () => {
    assert.equal(parseAssetDragPayload("{broken"), null);
    assert.equal(parseAssetDragPayload(JSON.stringify({
      version: 1,
      id: "c:/assets/music/other.wav",
      nativePath: "C:/Assets/Music/hook.wav",
      name: "Hook.wav",
      kind: "audio",
    })), null);
  });

  it("accepts only audio payloads for the Music/SFX drop boundary", () => {
    const audio = createAssetDragPayload(asset("Hook.wav", "audio", "C:/Assets/Music/Hook.wav"));
    const image = createAssetDragPayload(asset("Cover.png", "image", "C:/Assets/References/Cover.png"));
    assert.equal(parseAudioAssetDragPayload(audio)?.kind, "audio");
    assert.equal(parseAudioAssetDragPayload(image), null);
  });

  it("resolves audio drops only against the current synced library snapshot", () => {
    const current = [
      asset("Hook.wav", "audio", "C:/Assets/Music/Hook.wav"),
      asset("Pop.wav", "audio", "C:/Assets/SFX/Pop.wav"),
      asset("Cover.png", "image", "C:/Assets/References/Cover.png"),
    ];
    assert.equal(
      resolveAudioAssetDragTarget(current, createAssetDragPayload(current[0]!))?.name,
      "Hook.wav",
    );
    assert.equal(
      resolveAudioAssetDragTarget(current, createAssetDragPayload(asset("Old.wav", "audio", "C:/Assets/Music/Old.wav"))),
      null,
    );
    assert.equal(
      resolveAudioAssetDragTarget(current, createAssetDragPayload(current[2]!)),
      null,
    );
  });

  it("rejects stale audio drops when the path no longer matches the synced asset id", () => {
    const current = [asset("Hook.wav", "audio", "D:/Assets/Music/Hook.wav", {
      id: "c:/assets/music/hook.wav",
      normalizedPath: "c:/assets/music/hook.wav",
    })];
    const stale = createAssetDragPayload(asset("Hook.wav", "audio", "C:/Assets/Music/Hook.wav"));
    assert.equal(resolveAudioAssetDragTarget(current, stale), null);
  });
});

describe("filterAssets and sortAssets", () => {
  const items = [
    asset("Music 10.wav", "audio", "/Library/Music/Music 10.wav", {
      size: 100,
      modifiedAt: 10,
      folderPath: "/Library/Music",
    }),
    asset("Music 2.wav", "audio", "/Library/Music/Music 2.wav", {
      size: 200,
      modifiedAt: 30,
      folderPath: "/Library/Music",
    }),
    asset("서울 야경.jpg", "image", "/Library/References/Images/서울 야경.jpg", {
      size: 50,
      modifiedAt: 20,
      folderPath: "/Library/References/Images",
    }),
    asset("Intro.mov", "video", "/Library/References/Videos/Intro.mov", {
      size: 500,
      modifiedAt: 40,
      folderPath: "/Library/References/Videos",
    }),
  ];

  it("searches case-insensitively with every query token", () => {
    assert.deepEqual(
      filterAssets(items, "MUSIC 2").map((item) => item.name),
      ["Music 2.wav"],
    );
    assert.deepEqual(
      filterAssets(items, "서울 image").map((item) => item.name),
      ["서울 야경.jpg"],
    );
  });

  it("filters by kind and folder subtree without mutating the input", () => {
    const before = [...items];
    assert.deepEqual(
      filterAssets(items, { kinds: ["audio", "video"] }).map((item) => item.kind),
      ["audio", "audio", "video"],
    );
    assert.deepEqual(
      filterAssets(items, { folderPath: "/Library/References" }).map(
        (item) => item.name,
      ),
      ["서울 야경.jpg", "Intro.mov"],
    );
    assert.deepEqual(items, before);
  });

  it("naturally sorts names and supports descending numeric fields", () => {
    assert.deepEqual(
      sortAssets(items, "name").map((item) => item.name).slice(1, 3),
      ["Music 2.wav", "Music 10.wav"],
    );
    assert.deepEqual(
      sortAssets(items, { by: "modified", direction: "desc" }).map(
        (item) => item.modifiedAt,
      ),
      [40, 30, 20, 10],
    );
  });
});

describe("audio asset categories", () => {
  it("derives music and SFX folder categories with counts", () => {
    const items = [
      asset("intro.wav", "audio", "C:/Assets/Music/Intro/intro.wav", { folderPath: "Music/Intro" }),
      asset("loop.wav", "audio", "C:/Assets/Music/Intro/loop.wav", { folderPath: "Music/Intro" }),
      asset("whoosh.wav", "audio", "C:/Assets/SFX/Transitions/whoosh.wav", { folderPath: "SFX/Transitions" }),
      asset("cover.png", "image", "C:/Assets/References/cover.png", { folderPath: "References/Images" }),
      asset("voice.wav", "audio", "C:/Assets/Voice/voice.wav", { folderPath: "Voice" }),
    ];

    assert.deepEqual(
      listAudioAssetCategories(items).map((category) => [
        category.id,
        category.label,
        category.root,
        category.count,
      ]),
      [
        ["Music/Intro", "음악 / Intro", "music", 2],
        ["SFX/Transitions", "효과음 / Transitions", "sfx", 1],
      ],
    );
  });

  it("normalizes audio category roots case-insensitively", () => {
    assert.equal(audioAssetCategoryRoot("music/Chill"), "music");
    assert.equal(audioAssetCategoryRoot("SFX\\Hits"), "sfx");
    assert.equal(audioAssetCategoryRoot("References/Images"), null);
  });
});

describe("asset custom order", () => {
  const items = [
    asset("a.wav", "audio", "C:/Assets/SFX/a.wav"),
    asset("b.wav", "audio", "C:/Assets/SFX/b.wav"),
    asset("c.wav", "audio", "C:/Assets/SFX/c.wav"),
  ];

  it("normalizes user order ids and drops duplicates or unknown ids", () => {
    assert.deepEqual(
      normalizeAssetOrder([
        " C:\\Assets\\SFX\\B.wav ",
        "c:/assets/sfx/b.wav",
        "C:/Assets/SFX/C.wav",
        "",
        "../outside.wav",
      ], items.map((item) => item.id)),
      ["c:/assets/sfx/b.wav", "c:/assets/sfx/c.wav"],
    );
  });

  it("applies custom order without mutating the source list", () => {
    const before = [...items];
    assert.deepEqual(
      applyAssetOrder(items, ["c:/assets/sfx/c.wav", "c:/assets/sfx/a.wav"]).map((item) => item.name),
      ["c.wav", "a.wav", "b.wav"],
    );
    assert.deepEqual(items, before);
  });

  it("moves a dragged id before the target inside the visible scope", () => {
    assert.deepEqual(
      reorderAssetIds(
        ["c:/assets/sfx/c.wav", "c:/assets/sfx/a.wav"],
        items.map((item) => item.id),
        "c:/assets/sfx/c.wav",
        "c:/assets/sfx/b.wav",
      ),
      ["c:/assets/sfx/a.wav", "c:/assets/sfx/c.wav", "c:/assets/sfx/b.wav"],
    );
  });
});

describe("AssetLibrary root persistence", () => {
  it("ensures the default folder tree and saves a persistent token", async () => {
    const root = mockFolder("Assets", "C:/Assets");
    const storage = new MemoryStorage();
    const library = new AssetLibrary(createAdapter(root, storage));

    assert.equal(await library.selectRoot(), root);
    assert.equal(storage.getItem(ASSET_LIBRARY_TOKEN_KEY), "persistent-root-token");

    const rootNames = root.children?.map((entry) => entry.name).sort();
    assert.deepEqual(rootNames, ["Exports", "Music", "References", "SFX", "Thumbnails"]);
    const references = root.children?.find((entry) => entry.name === "References");
    assert.deepEqual(
      references?.children?.map((entry) => entry.name).sort(),
      ["Images", "Videos"],
    );
  });

  it("treats a closed picker as cancellation and keeps the saved token", async () => {
    const storage = new MemoryStorage();
    storage.setItem(ASSET_LIBRARY_TOKEN_KEY, "existing-token");
    const adapter = createAdapter(mockFolder("Assets", "C:/Assets"), storage);
    adapter.localFileSystem.getFolder = async () => null;
    const library = new AssetLibrary(adapter);

    await assert.rejects(
      library.selectRoot(),
      (error: unknown) => assertLibraryError(error, "CANCELLED"),
    );
    assert.equal(storage.getItem(ASSET_LIBRARY_TOKEN_KEY), "existing-token");
  });

  it("restores a saved folder and removes an expired token", async () => {
    const root = mockFolder("Assets", "C:/Assets");
    const storage = new MemoryStorage();
    storage.setItem(ASSET_LIBRARY_TOKEN_KEY, "saved-token");
    const adapter = createAdapter(root, storage);
    const library = new AssetLibrary(adapter);
    assert.equal(await library.restoreRoot(), root);

    adapter.localFileSystem.getEntryForPersistentToken = async () => {
      throw new Error("Token expired");
    };
    const expiredLibrary = new AssetLibrary(adapter);
    await assert.rejects(
      expiredLibrary.restoreRoot(),
      (error: unknown) => assertLibraryError(error, "TOKEN_EXPIRED"),
    );
    assert.equal(storage.getItem(ASSET_LIBRARY_TOKEN_KEY), null);
  });

  it("maps folder permission failures to a helpful error", async () => {
    const root = mockFolder("Assets", "C:/Assets");
    root.getEntries = async () => {
      throw new Error("Permission denied");
    };
    const library = new AssetLibrary(createAdapter(root));

    await assert.rejects(
      library.selectRoot(),
      (error: unknown) => assertLibraryError(error, "PERMISSION_DENIED"),
    );
  });

  it("keeps the cached root when clearing its token fails", async () => {
    const root = mockFolder("Assets", "C:/Assets");
    const storage = new MemoryStorage();
    const library = new AssetLibrary(createAdapter(root, storage));
    await library.selectRoot();
    storage.removeError = new Error("storage denied");
    await assert.rejects(library.clearRoot(), AssetLibraryError);
    assert.equal(library.currentRoot, root);
  });
});

describe("AssetLibrary sync", () => {
  it("recursively scans supported assets and de-duplicates normalized native paths", async () => {
    const duplicate = mockFile("HOOK.wav", "c:/assets/music/./hook.wav");
    const music = mockFolder("Music", "C:/Assets/Music", [
      mockFile("Hook.WAV", "C:\\Assets\\Music\\Hook.WAV", {
        size: 128,
        dateModified: new Date("2026-07-01T00:00:00Z"),
      }),
      duplicate,
      mockFile("notes.txt", "C:/Assets/Music/notes.txt"),
    ]);
    const image = mockFile("Cover.PNG", "C:/Assets/References/Images/Cover.PNG");
    const images = mockFolder("Images", "C:/Assets/References/Images", [image]);
    const references = mockFolder("References", "C:/Assets/References", [images]);
    const root = mockFolder("Assets", "C:/Assets", [music, references]);
    const library = new AssetLibrary(createAdapter(root));
    await library.selectRoot();

    const assets = await library.sync();
    assert.deepEqual(
      assets.map((item) => [item.name, item.kind]),
      [
        ["Cover.PNG", "image"],
        ["Hook.WAV", "audio"],
      ],
    );
    assert.equal(assets.find((item) => item.name === "Hook.WAV")?.size, 128);
    assert.equal(library.lastSyncStats.duplicateFiles, 1);
    assert.equal(library.lastSyncStats.unsupportedFiles, 1);
    assert.equal(library.lastSyncStats.truncated, false);
  });

  it("does not descend beyond depth five", async () => {
    const root = mockFolder("Assets", "C:/Assets");
    let parent = root;
    for (let depth = 1; depth <= 6; depth += 1) {
      const child = mockFolder(`L${depth}`, `${parent.nativePath}/L${depth}`);
      parent.children?.push(child);
      parent = child;
    }
    parent.children?.push(mockFile("too-deep.mp4", `${parent.nativePath}/too-deep.mp4`));
    const depthFive = root.children?.[0]?.children?.[0]?.children?.[0]?.children?.[0]?.children?.[0];
    assert.ok(depthFive);
    depthFive.children?.push(mockFile("allowed.mov", `${depthFive.nativePath}/allowed.mov`));

    const library = new AssetLibrary(createAdapter(root));
    await library.selectRoot();
    const assets = await library.sync();

    assert.equal(assets.some((item) => item.name === "allowed.mov"), true);
    assert.equal(assets.some((item) => item.name === "too-deep.mp4"), false);
    assert.equal(library.lastSyncStats.deepestLevel, 5);
  });

  it("hard-caps a sync at 5,000 visited entries", async () => {
    const files = Array.from({ length: 5_001 }, (_, index) =>
      mockFile(`clip-${index}.mp4`, `C:/Assets/clip-${index}.mp4`),
    );
    const root = mockFolder("Assets", "C:/Assets", files);
    const library = new AssetLibrary(createAdapter(root), { maxEntries: 99_999 });
    await library.selectRoot();

    const assets = await library.sync({ maxEntries: 99_999 });
    assert.ok(assets.length <= 5_000);
    assert.equal(library.lastSyncStats.entriesVisited, 5_000);
    assert.equal(library.lastSyncStats.truncated, true);
  });

  it("supports cancellation before scanning", async () => {
    const root = mockFolder("Assets", "C:/Assets");
    const library = new AssetLibrary(createAdapter(root));
    await library.selectRoot();

    await assert.rejects(
      library.sync({ signal: { aborted: true } }),
      (error: unknown) => assertLibraryError(error, "CANCELLED"),
    );
  });

  it("keeps an isolated last-successful cache and replaces it after missing files are removed", async () => {
    const clip = mockFile("hook.wav", "C:/Assets/Music/hook.wav");
    const root = mockFolder("Assets", "C:/Assets", [clip]);
    const library = new AssetLibrary(createAdapter(root));
    await library.selectRoot();
    const first = await library.sync();
    first[0]!.name = "mutated-by-ui.wav";
    assert.equal(library.lastSuccessfulAssets[0]?.name, "hook.wav");

    root.children = [];
    assert.deepEqual(await library.sync(), []);
    assert.deepEqual(library.lastSuccessfulAssets, []);

    root.getEntries = async () => { throw new Error("permission denied"); };
    await assert.rejects(library.sync(), AssetLibraryError);
    assert.deepEqual(library.lastSuccessfulAssets, []);
  });

  it("shares concurrent default syncs to avoid duplicate large-folder scans", async () => {
    const root = mockFolder("Assets", "C:/Assets", [mockFile("hook.wav", "C:/Assets/hook.wav")]);
    let scans = 0;
    const originalGetEntries = root.getEntries!;
    root.getEntries = async () => {
      scans += 1;
      return originalGetEntries();
    };
    const library = new AssetLibrary(createAdapter(root));
    await library.selectRoot();
    scans = 0;
    const [first, second] = await Promise.all([library.sync(), library.sync()]);
    assert.deepEqual(first.map((item) => item.id), second.map((item) => item.id));
    // 기본 폴더 존재 확인과 실제 루트 스캔은 한 번의 sync에서도 여러 번 root를 읽습니다.
    // 동시 호출이 합쳐졌다면 두 번 실행했을 때의 12회가 아니라 6회입니다.
    assert.equal(scans, 6);
  });
});

describe("AssetLibrary open folder", () => {
  it("uses shell.openPath when available", async () => {
    const root = mockFolder("Assets", "C:/Assets");
    const adapter = createAdapter(root);
    const opened: string[] = [];
    adapter.shell = {
      openPath: async (nativePath: string) => {
        opened.push(nativePath);
        return "";
      },
    };
    const library = new AssetLibrary(adapter);
    await library.selectRoot();
    await library.openRootFolder();
    assert.deepEqual(opened, ["C:/Assets"]);
  });

  it("opens a selected Music or SFX category folder by relative path", async () => {
    const sfx = mockFolder("SFX", "C:/Assets/SFX", [
      mockFolder("Transitions", "C:/Assets/SFX/Transitions"),
    ]);
    const root = mockFolder("Assets", "C:/Assets", [sfx]);
    const adapter = createAdapter(root);
    const opened: string[] = [];
    adapter.shell = {
      openPath: async (nativePath: string) => {
        opened.push(nativePath);
        return "";
      },
    };
    const library = new AssetLibrary(adapter);
    await library.selectRoot();

    await library.openRelativeFolder("sfx/transitions");

    assert.deepEqual(opened, ["C:/Assets/SFX/Transitions"]);
  });

  it("rejects missing or unsafe relative folders without opening the root", async () => {
    const root = mockFolder("Assets", "C:/Assets", [mockFolder("Music", "C:/Assets/Music")]);
    const adapter = createAdapter(root);
    const opened: string[] = [];
    adapter.shell = {
      openPath: async (nativePath: string) => {
        opened.push(nativePath);
        return "";
      },
    };
    const library = new AssetLibrary(adapter);
    await library.selectRoot();

    await assert.rejects(
      library.openRelativeFolder("Music/../Secrets"),
      (error: unknown) => assertLibraryError(error, "INVALID_ROOT"),
    );
    await assert.rejects(
      library.openRelativeFolder("SFX/Missing"),
      (error: unknown) => assertLibraryError(error, "INVALID_ROOT"),
    );
    assert.deepEqual(opened, []);
  });

  it("returns a friendly unsupported error when shell.openPath is unavailable", async () => {
    const root = mockFolder("Assets", "C:/Assets");
    const library = new AssetLibrary(createAdapter(root));
    await library.selectRoot();

    await assert.rejects(
      library.openRootFolder(),
      (error: unknown) => assertLibraryError(error, "UNSUPPORTED_API"),
    );
  });
});
