// 브랜드 키트 컨트롤러의 DOM 배선과 저장·적용·가져오기/내보내기 흐름을 검증하는 테스트
import assert from "node:assert/strict";
import Module from "node:module";
import { describe, it } from "node:test";

import {
  BrandKitError,
  BrandKitLibrary,
  DEFAULT_BRAND_KIT,
  type BrandKit,
  type BrandKitStorage,
  type BrandMogrtPreset,
} from "../src/brand-kit";
import { BrandKitController } from "../src/brand-kit-controller";

type FakeListener = (event: { type: string }) => unknown;

class FakeElement {
  id = "";
  value = "";
  checked = false;
  disabled = false;
  selected = false;
  textContent = "";
  parentElement: FakeElement | null = null;
  readonly children: FakeElement[] = [];
  private readonly listeners = new Map<string, Set<FakeListener>>();
  private readonly attributes = new Map<string, string>();

  constructor(readonly tagName: string) {}

  addEventListener(type: string, listener: FakeListener): void {
    const set = this.listeners.get(type) ?? new Set<FakeListener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
  }

  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  removeChild(node: FakeElement): FakeElement {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    node.parentElement = null;
    return node;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "id") this.id = value;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  dispatch(type: string): void {
    this.listeners.get(type)?.forEach((listener) => listener({ type }));
  }
}

class FakeDocument {
  private readonly byId = new Map<string, FakeElement>();

  register(id: string, tagName: string): FakeElement {
    const node = new FakeElement(tagName);
    node.id = id;
    this.byId.set(id, node);
    return node;
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }

  getElementById(id: string): FakeElement | null {
    return this.byId.get(id) ?? null;
  }
}

const BRAND_CONTROLS: ReadonlyArray<readonly [string, string]> = [
  ["brand-kit-select", "select"],
  ["brand-kit-new-btn", "button"],
  ["brand-kit-save-btn", "button"],
  ["brand-kit-duplicate-btn", "button"],
  ["brand-kit-delete-btn", "button"],
  ["brand-kit-apply-btn", "button"],
  ["brand-kit-import-btn", "button"],
  ["brand-kit-export-btn", "button"],
  ["brand-logo-btn", "button"],
  ["brand-kit-count", "span"],
  ["brand-logo-name", "span"],
  ["brand-active-name", "span"],
  ["brand-name-input", "input"],
  ["brand-font-input", "input"],
  ["brand-font-weight-input", "input"],
  ["brand-primary-color", "input"],
  ["brand-secondary-color", "input"],
  ["brand-accent-color", "input"],
  ["brand-caption-max-input", "input"],
  ["brand-caption-position-select", "select"],
  ["brand-caption-shadow-checkbox", "input"],
  ["brand-caption-highlight-checkbox", "input"],
  ["brand-thumb-layout-select", "select"],
  ["brand-thumb-background-color", "input"],
  ["brand-thumb-text-color", "input"],
  ["brand-thumb-brightness-input", "input"],
  ["brand-thumb-contrast-input", "input"],
  ["brand-thumb-saturation-input", "input"],
  ["brand-thumb-shadow-input", "input"],
  ["brand-thumb-glow-input", "input"],
  ["brand-thumb-shadow-color", "input"],
  ["brand-thumb-glow-color", "input"],
  ["brand-tts-model-select", "select"],
  ["brand-tts-voice-input", "input"],
  ["brand-tts-speed-input", "input"],
];

interface DomHandle {
  doc: FakeDocument;
  el(id: string): FakeElement;
  restore(): void;
}

function installDom(): DomHandle {
  const doc = new FakeDocument();
  for (const [id, tagName] of BRAND_CONTROLS) doc.register(id, tagName);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
  return {
    doc,
    el(id: string): FakeElement {
      const found = doc.getElementById(id);
      assert.ok(found, `테스트 DOM에 #${id} 요소가 등록되어야 합니다.`);
      return found;
    },
    restore(): void {
      if (descriptor) Object.defineProperty(globalThis, "document", descriptor);
      else delete (globalThis as { document?: unknown }).document;
    },
  };
}

class MemoryStorage implements BrandKitStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function testLibrary(storage = new MemoryStorage()): BrandKitLibrary {
  let time = 1_700_000_000_000;
  return new BrandKitLibrary(
    { storage },
    {
      now: () => time++,
      idFactory: (_name, index) => `kit-${index + 1}`,
    },
  );
}

interface ControllerHandle {
  controller: BrandKitController;
  library: BrandKitLibrary;
  activities: string[];
  errors: Array<{ error: unknown; context: string }>;
}

function createController(options: {
  library?: BrandKitLibrary;
  onApply?: (kit: BrandKit) => void | Promise<void>;
  getMogrtPreset?: () => BrandMogrtPreset;
} = {}): ControllerHandle {
  const library = options.library ?? testLibrary();
  const activities: string[] = [];
  const errors: Array<{ error: unknown; context: string }> = [];
  const controller = new BrandKitController({
    library,
    onActivity: (message) => { activities.push(message); },
    onError: (error, context) => { errors.push({ error, context }); },
    ...(options.onApply ? { onApply: options.onApply } : {}),
    ...(options.getMogrtPreset ? { getMogrtPreset: options.getMogrtPreset } : {}),
  });
  return { controller, library, activities, errors };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type ModuleLoader = (request: string, parent: unknown, isMain: boolean) => unknown;

/** 컨트롤러가 지연 호출하는 require("uxp")를 테스트 전용 모듈로 대체합니다. */
function withFakeUxpModule(uxpModule: unknown): () => void {
  const host = Module as unknown as { _load: ModuleLoader };
  const originalLoad = host._load;
  host._load = (request: string, parent: unknown, isMain: boolean): unknown =>
    request === "uxp" ? uxpModule : originalLoad.call(host, request, parent, isMain);
  return () => { host._load = originalLoad; };
}

interface FakeUxpFile {
  name?: string;
  nativePath?: string;
  read?: (options?: { format?: unknown }) => Promise<unknown>;
  write?: (data: string, options?: { format?: unknown }) => Promise<unknown>;
}

interface FakeUxpState {
  openFile: FakeUxpFile | FakeUxpFile[] | null;
  saveFile: FakeUxpFile | null;
  openOptions: unknown[];
  saveRequests: Array<{ name: string; options: unknown }>;
  tokens: string[];
}

function createUxpState(): FakeUxpState {
  return { openFile: null, saveFile: null, openOptions: [], saveRequests: [], tokens: [] };
}

function fakeUxp(state: FakeUxpState): unknown {
  return {
    storage: {
      formats: { utf8: "utf8-format" },
      localFileSystem: {
        getFileForOpening: async (options: unknown) => {
          state.openOptions.push(options);
          return state.openFile;
        },
        getFileForSaving: async (name: string, options: unknown) => {
          state.saveRequests.push({ name, options });
          return state.saveFile;
        },
        createPersistentToken: async (_entry: FakeUxpFile) => {
          const token = `logo-token-${state.tokens.length + 1}`;
          state.tokens.push(token);
          return token;
        },
      },
    },
  };
}

describe("BrandKitController 초기화와 렌더링", () => {
  it("저장소가 비어 있으면 기본 키트를 만들고 컨트롤에 기본값을 채운다", async () => {
    const dom = installDom();
    try {
      const { controller, library, activities } = createController();
      await controller.initialize();
      await flush();

      assert.equal(library.kits.length, 1);
      const kit = library.kits[0]!;
      assert.equal(kit.name, DEFAULT_BRAND_KIT.name);
      assert.equal(library.activeKitId, kit.id);
      assert.equal(controller.activeKit?.id, kit.id);

      const select = dom.el("brand-kit-select");
      assert.equal(select.children.length, 1);
      assert.equal(select.children[0]?.value, kit.id);
      assert.equal(select.children[0]?.textContent, kit.name);
      assert.equal(select.children[0]?.selected, true);

      assert.equal(dom.el("brand-kit-count").textContent, "1 / 20");
      assert.equal(dom.el("brand-font-input").value, "Pretendard");
      assert.equal(dom.el("brand-font-weight-input").value, "700");
      assert.equal(dom.el("brand-primary-color").value, "#ffffff");
      assert.equal(dom.el("brand-accent-color").value, "#8b5cf6");
      assert.equal(dom.el("brand-caption-max-input").value, "24");
      assert.equal(dom.el("brand-caption-position-select").value, "bottom");
      assert.equal(dom.el("brand-caption-shadow-checkbox").checked, true);
      assert.equal(dom.el("brand-caption-highlight-checkbox").checked, false);
      assert.equal(dom.el("brand-thumb-layout-select").value, "full");
      assert.equal(dom.el("brand-tts-model-select").value, "gpt-4o-mini-tts");
      assert.equal(dom.el("brand-logo-name").textContent, "선택되지 않음");
      assert.equal(dom.el("brand-active-name").textContent, DEFAULT_BRAND_KIT.name);
      assert.equal(dom.el("brand-kit-delete-btn").disabled, true);
      assert.equal(dom.el("brand-kit-duplicate-btn").disabled, false);
      assert.equal(dom.el("brand-kit-apply-btn").disabled, false);
      assert.deepEqual(activities, []);
    } finally {
      dom.restore();
    }
  });

  it("initialize를 다시 호출해도 이벤트와 키트를 중복 생성하지 않는다", async () => {
    const dom = installDom();
    try {
      const { controller, library } = createController();
      await controller.initialize();
      await controller.initialize();
      await flush();
      assert.equal(library.kits.length, 1);
      assert.equal(dom.el("brand-kit-select").children.length, 1);

      dom.el("brand-kit-new-btn").dispatch("click");
      await flush();
      assert.equal(library.kits.length, 2, "리스너가 중복 등록되면 클릭 한 번에 두 개가 생깁니다");
    } finally {
      dom.restore();
    }
  });

  it("저장된 키트와 활성 선택을 복원하고 기본 키트를 추가하지 않는다", async () => {
    const dom = installDom();
    try {
      const storage = new MemoryStorage();
      const seed = testLibrary(storage);
      await seed.create({ name: "채널 A", font: { family: "본고딕" } });
      const second = await seed.create({ name: "채널 B", colors: { accent: "#ff0000" } });
      await seed.setActive(second.id);

      const { controller, library } = createController({ library: testLibrary(storage) });
      await controller.initialize();
      await flush();

      assert.equal(library.kits.length, 2);
      assert.equal(library.activeKitId, second.id);
      assert.equal(dom.el("brand-kit-count").textContent, "2 / 20");
      assert.equal(dom.el("brand-name-input").value, "채널 B");
      assert.equal(dom.el("brand-accent-color").value, "#ff0000");
      assert.equal(dom.el("brand-kit-delete-btn").disabled, false);
    } finally {
      dom.restore();
    }
  });

  it("활성 키트가 비어 있으면 첫 번째 키트를 자동 활성화한다", async () => {
    const dom = installDom();
    try {
      const storage = new MemoryStorage();
      const seed = testLibrary(storage);
      const first = await seed.create({ name: "첫 키트" });
      await seed.create({ name: "둘째 키트" });
      await seed.setActive(null);

      const { controller, library } = createController({ library: testLibrary(storage) });
      await controller.initialize();
      await flush();

      assert.equal(library.activeKitId, first.id);
      assert.equal(dom.el("brand-active-name").textContent, "첫 키트");
    } finally {
      dom.restore();
    }
  });
});

describe("BrandKitController 키트 편집 흐름", () => {
  it("새 키트 버튼은 순번 이름의 키트를 만들어 활성화한다", async () => {
    const dom = installDom();
    try {
      const { controller, library, activities } = createController();
      await controller.initialize();
      await flush();

      dom.el("brand-kit-new-btn").dispatch("click");
      await flush();

      assert.equal(library.kits.length, 2);
      assert.equal(library.kits[1]?.name, "브랜드 키트 2");
      assert.equal(library.activeKitId, library.kits[1]?.id);
      assert.equal(dom.el("brand-kit-count").textContent, "2 / 20");
      assert.equal(dom.el("brand-kit-delete-btn").disabled, false);
      assert.equal(activities.at(-1), "브랜드 키트를 만들었습니다: 브랜드 키트 2");
    } finally {
      dom.restore();
    }
  });

  it("저장 버튼은 컨트롤 값을 정규화해 활성 키트에 반영한다", async () => {
    const dom = installDom();
    try {
      const { controller, library, activities, errors } = createController();
      await controller.initialize();
      await flush();

      dom.el("brand-name-input").value = "채널 브랜딩";
      dom.el("brand-font-input").value = "본고딕";
      dom.el("brand-font-weight-input").value = "800";
      dom.el("brand-primary-color").value = "#ABC";
      dom.el("brand-secondary-color").value = "red";
      dom.el("brand-accent-color").value = "#12ff34";
      dom.el("brand-caption-max-input").value = "500";
      dom.el("brand-caption-position-select").value = "center";
      dom.el("brand-caption-shadow-checkbox").checked = false;
      dom.el("brand-caption-highlight-checkbox").checked = true;
      dom.el("brand-thumb-layout-select").value = "grid";
      dom.el("brand-thumb-brightness-input").value = "150";
      dom.el("brand-tts-model-select").value = "evil-model";
      dom.el("brand-tts-voice-input").value = "cedar";
      dom.el("brand-tts-speed-input").value = "1.5";

      dom.el("brand-kit-save-btn").dispatch("click");
      await flush();

      assert.deepEqual(errors, []);
      const kit = library.activeKit;
      assert.ok(kit);
      assert.equal(kit.name, "채널 브랜딩");
      assert.equal(kit.font.family, "본고딕");
      assert.equal(kit.font.weight, 800);
      assert.equal(kit.colors.primary, "#aabbcc", "3자리 색상은 6자리로 확장되어야 합니다");
      assert.equal(kit.colors.secondary, DEFAULT_BRAND_KIT.colors.secondary, "잘못된 색상은 기본값으로 대체됩니다");
      assert.equal(kit.colors.accent, "#12ff34");
      assert.equal(kit.caption.maxChars, 80, "자막 길이는 상한으로 잘려야 합니다");
      assert.equal(kit.caption.position, "center");
      assert.equal(kit.caption.shadow, false);
      assert.equal(kit.caption.highlight, true);
      assert.equal(kit.thumbnail.layout, "grid");
      assert.equal(kit.thumbnail.brightness, 150);
      assert.equal(kit.tts.model, "gpt-4o-mini-tts", "허용되지 않은 TTS 모델은 기본값으로 대체됩니다");
      assert.equal(kit.tts.voice, "cedar");
      assert.equal(kit.tts.speed, 1.5);
      assert.deepEqual(kit.mogrt, { token: "", name: "", track: 2 });

      assert.equal(dom.el("brand-kit-select").children[0]?.textContent, "채널 브랜딩");
      assert.equal(dom.el("brand-active-name").textContent, "채널 브랜딩");
      assert.equal(activities.at(-1), "브랜드 키트를 저장했습니다: 채널 브랜딩");
    } finally {
      dom.restore();
    }
  });

  it("활성 키트가 없으면 저장이 onError로 검증 오류를 알린다", async () => {
    const dom = installDom();
    try {
      const { controller, library, errors } = createController();
      await controller.initialize();
      await flush();
      await library.setActive(null);

      dom.el("brand-kit-save-btn").dispatch("click");
      await flush();

      assert.equal(errors.length, 1);
      assert.equal(errors[0]?.context, "브랜드 키트 저장 실패");
      assert.match(messageOf(errors[0]?.error), /저장할 브랜드 키트를 선택/u);
    } finally {
      dom.restore();
    }
  });

  it("getMogrtPreset 옵션이 있으면 저장 시 MOGRT 프리셋을 포함한다", async () => {
    const dom = installDom();
    try {
      const { controller, library } = createController({
        getMogrtPreset: () => ({ token: "mogrt-token", name: "Lower Third.mogrt", track: 7 }),
      });
      await controller.initialize();
      await flush();

      dom.el("brand-kit-save-btn").dispatch("click");
      await flush();

      assert.deepEqual(library.activeKit?.mogrt, {
        token: "mogrt-token",
        name: "Lower Third.mogrt",
        track: 7,
      });
    } finally {
      dom.restore();
    }
  });

  it("복제 버튼은 복사본을 만들어 활성화한다", async () => {
    const dom = installDom();
    try {
      const { controller, library, activities } = createController();
      await controller.initialize();
      await flush();

      dom.el("brand-kit-duplicate-btn").dispatch("click");
      await flush();

      assert.equal(library.kits.length, 2);
      assert.equal(library.kits[1]?.name, "새 브랜드 키트 복사본");
      assert.equal(library.activeKitId, library.kits[1]?.id);
      assert.equal(activities.at(-1), "브랜드 키트를 복제했습니다: 새 브랜드 키트 복사본");
    } finally {
      dom.restore();
    }
  });

  it("삭제 버튼은 활성 키트를 지우고 남은 키트를 활성화한다", async () => {
    const dom = installDom();
    try {
      const { controller, library, activities } = createController();
      await controller.initialize();
      await flush();
      dom.el("brand-kit-new-btn").dispatch("click");
      await flush();

      dom.el("brand-kit-delete-btn").dispatch("click");
      await flush();

      assert.equal(library.kits.length, 1);
      assert.equal(library.activeKitId, library.kits[0]?.id);
      assert.equal(dom.el("brand-kit-count").textContent, "1 / 20");
      assert.equal(dom.el("brand-kit-delete-btn").disabled, true);
      assert.equal(activities.at(-1), "브랜드 키트를 삭제했습니다: 브랜드 키트 2");
    } finally {
      dom.restore();
    }
  });

  it("마지막 키트 삭제는 거부하고 onError로 알린다", async () => {
    const dom = installDom();
    try {
      const { controller, library, errors } = createController();
      await controller.initialize();
      await flush();

      dom.el("brand-kit-delete-btn").dispatch("click");
      await flush();

      assert.equal(library.kits.length, 1);
      assert.equal(errors[0]?.context, "브랜드 키트 삭제 실패");
      assert.match(messageOf(errors[0]?.error), /최소 한 개/u);
    } finally {
      dom.restore();
    }
  });

  it("셀렉트 변경은 활성 키트를 전환하고 컨트롤을 다시 채운다", async () => {
    const dom = installDom();
    try {
      const { controller, library } = createController();
      await controller.initialize();
      await flush();
      dom.el("brand-kit-new-btn").dispatch("click");
      await flush();
      const firstId = library.kits[0]?.id ?? "";
      assert.notEqual(library.activeKitId, firstId);

      dom.el("brand-kit-select").value = firstId;
      dom.el("brand-kit-select").dispatch("change");
      await flush();

      assert.equal(library.activeKitId, firstId);
      assert.equal(dom.el("brand-name-input").value, DEFAULT_BRAND_KIT.name);
      assert.equal(dom.el("brand-active-name").textContent, DEFAULT_BRAND_KIT.name);
    } finally {
      dom.restore();
    }
  });

  it("존재하지 않는 키트 선택은 NOT_FOUND 오류로 알린다", async () => {
    const dom = installDom();
    try {
      const { controller, errors } = createController();
      await controller.initialize();
      await flush();

      dom.el("brand-kit-select").value = "ghost-kit";
      dom.el("brand-kit-select").dispatch("change");
      await flush();

      assert.equal(errors[0]?.context, "브랜드 키트 선택 실패");
      assert.ok(errors[0]?.error instanceof BrandKitError);
      assert.equal((errors[0]?.error as BrandKitError).code, "NOT_FOUND");
    } finally {
      dom.restore();
    }
  });
});

describe("BrandKitController 20개 상한", () => {
  it("상한에서 생성과 복제가 실패해도 키트 수를 유지한다", async () => {
    const dom = installDom();
    try {
      const storage = new MemoryStorage();
      const seed = testLibrary(storage);
      for (let index = 0; index < 20; index += 1) {
        await seed.create({ name: `키트 ${index + 1}` });
      }

      const { controller, library, errors } = createController({ library: testLibrary(storage) });
      await controller.initialize();
      await flush();
      assert.equal(dom.el("brand-kit-count").textContent, "20 / 20");

      dom.el("brand-kit-new-btn").dispatch("click");
      await flush();
      assert.equal(errors[0]?.context, "브랜드 키트 생성 실패");
      assert.ok(errors[0]?.error instanceof BrandKitError);
      assert.equal((errors[0]?.error as BrandKitError).code, "LIMIT_EXCEEDED");

      dom.el("brand-kit-duplicate-btn").dispatch("click");
      await flush();
      assert.equal(errors[1]?.context, "브랜드 키트 복제 실패");
      assert.equal((errors[1]?.error as BrandKitError).code, "LIMIT_EXCEEDED");

      assert.equal(library.kits.length, 20);
      assert.equal(dom.el("brand-kit-count").textContent, "20 / 20");
    } finally {
      dom.restore();
    }
  });
});

describe("BrandKitController 적용 흐름", () => {
  it("적용 버튼은 현재 컨트롤 값을 저장한 뒤 onApply로 전달한다", async () => {
    const dom = installDom();
    try {
      const applied: BrandKit[] = [];
      const { controller, library, activities } = createController({
        onApply: (kit) => { applied.push(kit); },
      });
      await controller.initialize();
      await flush();

      dom.el("brand-name-input").value = "적용 키트";
      dom.el("brand-kit-apply-btn").dispatch("click");
      await flush();

      assert.equal(applied.length, 1);
      assert.equal(applied[0]?.name, "적용 키트");
      assert.equal(library.activeKit?.name, "적용 키트");
      assert.equal(activities.at(-1), "브랜드 키트를 현재 작업에 적용했습니다: 적용 키트");
    } finally {
      dom.restore();
    }
  });

  it("onApply 실패는 onError로 표면화된다", async () => {
    const dom = installDom();
    try {
      const { controller, errors } = createController({
        onApply: async () => { throw new Error("호스트 적용 실패"); },
      });
      await controller.initialize();
      await flush();

      dom.el("brand-kit-apply-btn").dispatch("click");
      await flush();

      assert.equal(errors.length, 1);
      assert.equal(errors[0]?.context, "브랜드 키트 적용 실패");
      assert.match(messageOf(errors[0]?.error), /호스트 적용 실패/u);
    } finally {
      dom.restore();
    }
  });
});

describe("BrandKitController 로고 선택과 JSON 가져오기/내보내기", () => {
  it("로고 선택은 persistent token을 만들어 저장 시 키트에 반영한다", async () => {
    const dom = installDom();
    const state = createUxpState();
    state.openFile = [{ name: "logo.png", nativePath: "C:\\Brand\\logo.png" }];
    const restoreUxp = withFakeUxpModule(fakeUxp(state));
    try {
      const { controller, library, errors } = createController();
      await controller.initialize();
      await flush();

      dom.el("brand-logo-btn").dispatch("click");
      await flush();

      assert.deepEqual(errors, []);
      assert.deepEqual(state.openOptions[0], {
        types: ["png", "jpg", "jpeg", "webp"],
        allowMultiple: false,
      });
      assert.equal(dom.el("brand-logo-name").textContent, "logo.png");
      assert.equal(dom.el("brand-logo-name").getAttribute("title"), "C:\\Brand\\logo.png");

      dom.el("brand-kit-save-btn").dispatch("click");
      await flush();
      assert.deepEqual(library.activeKit?.logo, { token: "logo-token-1", name: "logo.png" });
    } finally {
      restoreUxp();
      dom.restore();
    }
  });

  it("선택 창이 취소되면 로고·가져오기·내보내기가 아무 것도 바꾸지 않는다", async () => {
    const dom = installDom();
    const state = createUxpState();
    const restoreUxp = withFakeUxpModule(fakeUxp(state));
    try {
      const { controller, library, activities, errors } = createController();
      await controller.initialize();
      await flush();

      dom.el("brand-logo-btn").dispatch("click");
      dom.el("brand-kit-import-btn").dispatch("click");
      dom.el("brand-kit-export-btn").dispatch("click");
      await flush();

      assert.deepEqual(errors, []);
      assert.deepEqual(activities, []);
      assert.equal(dom.el("brand-logo-name").textContent, "선택되지 않음");
      assert.equal(library.kits.length, 1);
    } finally {
      restoreUxp();
      dom.restore();
    }
  });

  it("내보내기는 파일명을 정리하고 토큰 없는 JSON을 기록한다", async () => {
    const dom = installDom();
    const state = createUxpState();
    state.openFile = { name: "logo.png", nativePath: "C:\\Brand\\logo.png" };
    const writes: Array<{ data: string; options: unknown }> = [];
    state.saveFile = {
      name: "Team_Kit_2026_ShortFlow.json",
      write: async (data, options) => { writes.push({ data, options }); },
    };
    const restoreUxp = withFakeUxpModule(fakeUxp(state));
    try {
      const { controller, library, activities, errors } = createController();
      await controller.initialize();
      await flush();

      dom.el("brand-logo-btn").dispatch("click");
      await flush();
      dom.el("brand-name-input").value = "Team Kit 2026";
      dom.el("brand-kit-save-btn").dispatch("click");
      await flush();

      dom.el("brand-kit-export-btn").dispatch("click");
      await flush();

      assert.deepEqual(errors, []);
      assert.equal(state.saveRequests[0]?.name, "Team_Kit_2026_ShortFlow.json");
      assert.deepEqual(state.saveRequests[0]?.options, { types: ["json"] });
      assert.equal(writes.length, 1);
      assert.deepEqual(writes[0]?.options, { format: "utf8-format" });

      const parsed = JSON.parse(writes[0]?.data ?? "") as {
        schemaVersion: number;
        kits: Array<{ name: string; logo: { name?: string; token?: string } }>;
      };
      assert.equal(parsed.schemaVersion, 1);
      assert.equal(parsed.kits.length, 1);
      assert.equal(parsed.kits[0]?.name, "Team Kit 2026");
      assert.equal(parsed.kits[0]?.logo.name, "logo.png");
      assert.equal(parsed.kits[0]?.logo.token, undefined, "내보내기에 파일 토큰이 포함되면 안 됩니다");
      assert.equal(library.activeKit?.logo.token, "logo-token-1", "라이브러리 안의 토큰은 유지됩니다");
      assert.equal(activities.at(-1), "브랜드 키트 JSON을 저장했습니다: Team_Kit_2026_ShortFlow.json");
    } finally {
      restoreUxp();
      dom.restore();
    }
  });

  it("가져오기는 ID를 재생성하고 첫 키트를 활성화하며 토큰을 제외한다", async () => {
    const dom = installDom();
    const state = createUxpState();
    const json = JSON.stringify({
      schemaVersion: 1,
      exportedAt: 1,
      activeKitId: "imported-1",
      kits: [
        {
          id: "imported-1",
          name: "가져온 키트",
          colors: { accent: "#ff8800" },
          logo: { name: "logo.png", token: "stolen-capability" },
        },
        { id: "imported-2", name: "두 번째" },
      ],
    });
    const readOptions: unknown[] = [];
    state.openFile = {
      name: "kits.json",
      read: async (options) => { readOptions.push(options); return json; },
    };
    const restoreUxp = withFakeUxpModule(fakeUxp(state));
    try {
      const { controller, library, activities, errors } = createController();
      await controller.initialize();
      await flush();

      dom.el("brand-kit-import-btn").dispatch("click");
      await flush();

      assert.deepEqual(errors, []);
      assert.deepEqual(readOptions, [{ format: "utf8-format" }]);
      assert.equal(library.kits.length, 3);
      const imported = library.kits[1];
      assert.ok(imported);
      assert.notEqual(imported.id, "imported-1", "가져온 키트 ID는 재생성되어야 합니다");
      assert.equal(imported.name, "가져온 키트");
      assert.equal(imported.colors.accent, "#ff8800");
      assert.equal(imported.logo.name, "logo.png");
      assert.equal(imported.logo.token, "", "가져온 파일 토큰은 제거되어야 합니다");
      assert.equal(library.activeKitId, imported.id);
      assert.equal(dom.el("brand-name-input").value, "가져온 키트");
      assert.equal(
        activities.at(-1),
        "브랜드 키트 2개를 가져왔습니다. 파일 권한 토큰은 보안을 위해 제외됩니다.",
      );
    } finally {
      restoreUxp();
      dom.restore();
    }
  });

  it("바이너리로 읽힌 JSON도 텍스트로 해석해 가져온다", async () => {
    const dom = installDom();
    const state = createUxpState();
    const json = JSON.stringify({
      schemaVersion: 1,
      exportedAt: 1,
      activeKitId: null,
      kits: [{ id: "binary-kit", name: "바이너리 키트" }],
    });
    state.openFile = { name: "kits.json", read: async () => new TextEncoder().encode(json) };
    const restoreUxp = withFakeUxpModule(fakeUxp(state));
    try {
      const { controller, library, errors } = createController();
      await controller.initialize();
      await flush();

      dom.el("brand-kit-import-btn").dispatch("click");
      await flush();

      assert.deepEqual(errors, []);
      assert.equal(library.kits.length, 2);
      assert.equal(library.kits[1]?.name, "바이너리 키트");
    } finally {
      restoreUxp();
      dom.restore();
    }
  });

  it("텍스트로 읽을 수 없는 가져오기 결과는 onError로 알린다", async () => {
    const dom = installDom();
    const state = createUxpState();
    state.openFile = { name: "kits.json", read: async () => 42 };
    const restoreUxp = withFakeUxpModule(fakeUxp(state));
    try {
      const { controller, library, errors } = createController();
      await controller.initialize();
      await flush();

      dom.el("brand-kit-import-btn").dispatch("click");
      await flush();

      assert.equal(errors[0]?.context, "브랜드 키트 가져오기 실패");
      assert.match(messageOf(errors[0]?.error), /텍스트로 읽지 못했습니다/u);
      assert.equal(library.kits.length, 1);
    } finally {
      restoreUxp();
      dom.restore();
    }
  });

  it("손상된 JSON 가져오기는 BrandKitError를 표면화하고 상태를 보존한다", async () => {
    const dom = installDom();
    const state = createUxpState();
    state.openFile = { name: "kits.json", read: async () => "{broken" };
    const restoreUxp = withFakeUxpModule(fakeUxp(state));
    try {
      const { controller, library, errors } = createController();
      await controller.initialize();
      await flush();

      dom.el("brand-kit-import-btn").dispatch("click");
      await flush();

      assert.equal(errors[0]?.context, "브랜드 키트 가져오기 실패");
      assert.ok(errors[0]?.error instanceof BrandKitError);
      assert.equal((errors[0]?.error as BrandKitError).code, "INVALID_IMPORT");
      assert.equal(library.kits.length, 1);
    } finally {
      restoreUxp();
      dom.restore();
    }
  });

  it("UXP 파일 시스템이 없으면 가져오기가 onError로 알린다", async () => {
    const dom = installDom();
    const restoreUxp = withFakeUxpModule({ storage: {} });
    try {
      const { controller, errors } = createController();
      await controller.initialize();
      await flush();

      dom.el("brand-kit-import-btn").dispatch("click");
      await flush();

      assert.equal(errors[0]?.context, "브랜드 키트 가져오기 실패");
      assert.match(messageOf(errors[0]?.error), /UXP 파일 시스템을 사용할 수 없습니다/u);
    } finally {
      restoreUxp();
      dom.restore();
    }
  });
});
