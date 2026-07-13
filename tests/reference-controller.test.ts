// 레퍼런스 컨트롤러의 AI 프롬프트 보강(FR-06) 흐름을 검증하는 테스트
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_IMAGE_INPUTS,
  MAX_REFERENCE_PROMPT_ITEMS,
  REFERENCE_STORAGE_KEY,
  ReferenceLibrary,
  serializeReferences,
  type ReferenceFileEntry,
  type ReferenceItem,
  type ReferenceLibraryAdapter,
} from "../src/references";
import { ReferenceController } from "../src/reference-controller";

type FakeListener = (event: FakeEvent) => unknown;

class FakeEvent {
  defaultPrevented = false;
  key = "";
  dataTransfer: undefined;
  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

class FakeClassList {
  constructor(private readonly owner: FakeElement) {}
  private values(): Set<string> {
    return new Set(this.owner.className.split(/\s+/u).filter(Boolean));
  }
  add(...tokens: string[]): void {
    const values = this.values();
    tokens.forEach((token) => values.add(token));
    this.owner.className = [...values].join(" ");
  }
  remove(...tokens: string[]): void {
    const values = this.values();
    tokens.forEach((token) => values.delete(token));
    this.owner.className = [...values].join(" ");
  }
  contains(token: string): boolean {
    return this.values().has(token);
  }
  toggle(token: string, force?: boolean): boolean {
    const values = this.values();
    const enabled = force ?? !values.has(token);
    if (enabled) values.add(token);
    else values.delete(token);
    this.owner.className = [...values].join(" ");
    return enabled;
  }
}

class FakeElement {
  id = "";
  value = "";
  checked = false;
  disabled = false;
  hidden = false;
  title = "";
  textContent = "";
  className = "";
  type = "";
  src = "";
  alt = "";
  loading = "";
  controls = false;
  muted = false;
  preload = "";
  rows = 0;
  maxLength = 0;
  draggable = false;
  dataset: Record<string, string> = {};
  parentElement: FakeElement | null = null;
  readonly children: FakeElement[] = [];
  readonly classList = new FakeClassList(this);
  private readonly listeners = new Map<string, Set<FakeListener>>();
  private readonly attributes = new Map<string, string>();

  constructor(readonly tagName: string) {}

  addEventListener(type: string, listener: FakeListener): void {
    const set = this.listeners.get(type) ?? new Set<FakeListener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: FakeListener): void {
    this.listeners.get(type)?.delete(listener);
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

  replaceChildren(...nodes: FakeElement[]): void {
    this.children.forEach((child) => { child.parentElement = null; });
    this.children.splice(0);
    this.append(...nodes);
  }

  remove(): void {
    if (!this.parentElement) return;
    const index = this.parentElement.children.indexOf(this);
    if (index >= 0) this.parentElement.children.splice(index, 1);
    this.parentElement = null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "id") this.id = value;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const found: FakeElement[] = [];
    const visit = (node: FakeElement): void => {
      for (const child of node.children) {
        if (matches(child, selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  dispatch(type: string, values: Partial<FakeEvent> = {}): FakeEvent {
    const event = Object.assign(new FakeEvent(), values);
    this.listeners.get(type)?.forEach((listener) => listener(event));
    return event;
  }
}

function matches(element: FakeElement, selector: string): boolean {
  if (selector.startsWith("#")) return element.id === selector.slice(1);
  if (selector.startsWith(".")) return element.classList.contains(selector.slice(1));
  return element.tagName.toLowerCase() === selector.toLowerCase();
}

class FakeDocument {
  private readonly byId = new Map<string, FakeElement>();

  register(id: string, tagName = "div"): FakeElement {
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

interface DomHandle {
  doc: FakeDocument;
  list: FakeElement;
  restore(): void;
}

function installDom(): DomHandle {
  const doc = new FakeDocument();
  const list = doc.register("reference-list");
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
  return {
    doc,
    list,
    restore(): void {
      if (descriptor) Object.defineProperty(globalThis, "document", descriptor);
      else delete (globalThis as { document?: unknown }).document;
    },
  };
}

function mockPngFile(name: string): ReferenceFileEntry {
  const nativePath = `C:\\References\\${name}`;
  return {
    name,
    nativePath,
    url: `file:///${nativePath.replace(/\\/gu, "/")}`,
    isFile: true,
    read: async () => Uint8Array.from([1, 2, 3]),
  } as unknown as ReferenceFileEntry;
}

function createSeededLibrary(): { library: ReferenceLibrary; seed: (notes: string) => Promise<void> } {
  const store = new Map<string, string>();
  const entriesByToken = new Map<string, ReferenceFileEntry>();
  let tokenCount = 0;
  const adapter: ReferenceLibraryAdapter = {
    localFileSystem: {
      getFileForOpening: async () => null,
      createPersistentToken: async (entry: ReferenceFileEntry) => {
        tokenCount += 1;
        const token = `token-${tokenCount}`;
        entriesByToken.set(token, entry);
        return token;
      },
      getEntryForPersistentToken: async (token: string) => {
        const entry = entriesByToken.get(token);
        if (!entry) throw new Error(`expired token: ${token}`);
        return entry;
      },
    },
    storage: {
      getItem: async (key: string) => store.get(key) ?? null,
      setItem: async (key: string, value: string) => { store.set(key, value); },
      removeItem: async (key: string) => { store.delete(key); },
    },
    binaryFormat: "binary-format",
  } as unknown as ReferenceLibraryAdapter;

  const library = new ReferenceLibrary(adapter, { idFactory: () => "ref-1", now: () => 1 });
  return {
    library,
    seed: async (notes: string) => {
      await library.addEntries([mockPngFile("hook.png")], notes, { source: "직접 제작", tags: "빨강" });
    },
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function notesEditor(list: FakeElement): FakeElement {
  const editor = list.querySelectorAll(".reference-notes-editor")[0];
  assert.ok(editor, "레퍼런스 카드에 활용 메모 편집기가 렌더링되어야 합니다.");
  return editor;
}

function enrichButton(list: FakeElement): FakeElement {
  const button = list.querySelectorAll(".reference-enrich-btn")[0];
  assert.ok(button, "레퍼런스 카드에 AI 보강 버튼이 렌더링되어야 합니다.");
  return button;
}

describe("ReferenceController AI 프롬프트 보강", () => {
  it("provider가 없으면 AI 보강 버튼을 비활성화한다", async () => {
    const dom = installDom();
    try {
      const { library, seed } = createSeededLibrary();
      await seed("원본 메모");
      const controller = new ReferenceController({ library });
      await controller.initialize();
      assert.equal(enrichButton(dom.list).disabled, true);
    } finally {
      dom.restore();
    }
  });

  it("provider가 있으면 버튼을 활성화하고 메모 텍스트로 보강 미리보기를 만든다", async () => {
    const dom = installDom();
    try {
      const { library, seed } = createSeededLibrary();
      await seed("원본 메모");
      const calls: string[] = [];
      const controller = new ReferenceController({
        library,
        enrichPromptProvider: async (prompt) => {
          calls.push(prompt);
          return "보강된 메모";
        },
      });
      await controller.initialize();

      const button = enrichButton(dom.list);
      assert.equal(button.disabled, false);
      notesEditor(dom.list).value = "원본 메모";
      button.dispatch("click");
      await flush();

      assert.deepEqual(calls, ["원본 메모"]);
      const preview = dom.list.querySelectorAll(".reference-enrich-preview")[0];
      assert.ok(preview, "보강 결과 미리보기가 나타나야 합니다.");
      assert.equal(preview.querySelectorAll("p")[0]?.textContent, "보강된 메모");
    } finally {
      dom.restore();
    }
  });

  it("활용 메모가 비어 있으면 provider를 호출하지 않고 오류를 알린다", async () => {
    const dom = installDom();
    try {
      const { library, seed } = createSeededLibrary();
      await seed("");
      let providerCalls = 0;
      const errors: string[] = [];
      const controller = new ReferenceController({
        library,
        enrichPromptProvider: async () => { providerCalls += 1; return "x"; },
        onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
      });
      await controller.initialize();

      notesEditor(dom.list).value = "   ";
      enrichButton(dom.list).dispatch("click");
      await flush();

      assert.equal(providerCalls, 0);
      assert.equal(dom.list.querySelectorAll(".reference-enrich-preview").length, 0);
      assert.match(errors[0] ?? "", /메모를 먼저 입력/u);
    } finally {
      dom.restore();
    }
  });

  it("적용을 누르면 보강 결과를 활용 메모로 저장한다", async () => {
    const dom = installDom();
    try {
      const { library, seed } = createSeededLibrary();
      await seed("원본 메모");
      const controller = new ReferenceController({
        library,
        enrichPromptProvider: async () => "보강된 메모",
      });
      await controller.initialize();

      notesEditor(dom.list).value = "원본 메모";
      enrichButton(dom.list).dispatch("click");
      await flush();

      const applyBtn = dom.list.querySelectorAll(".reference-enrich-apply-btn")[0];
      assert.ok(applyBtn, "적용 버튼이 있어야 합니다.");
      applyBtn.dispatch("click");
      await flush();

      assert.equal(library.items[0]?.notes, "보강된 메모");
    } finally {
      dom.restore();
    }
  });

  it("취소를 누르면 미리보기만 제거하고 활용 메모를 바꾸지 않는다", async () => {
    const dom = installDom();
    try {
      const { library, seed } = createSeededLibrary();
      await seed("원본 메모");
      const controller = new ReferenceController({
        library,
        enrichPromptProvider: async () => "보강된 메모",
      });
      await controller.initialize();

      notesEditor(dom.list).value = "원본 메모";
      enrichButton(dom.list).dispatch("click");
      await flush();

      const cancelBtn = dom.list.querySelectorAll(".reference-enrich-cancel-btn")[0];
      assert.ok(cancelBtn, "취소 버튼이 있어야 합니다.");
      cancelBtn.dispatch("click");
      await flush();

      assert.equal(dom.list.querySelectorAll(".reference-enrich-preview").length, 0);
      assert.equal(library.items[0]?.notes, "원본 메모");
    } finally {
      dom.restore();
    }
  });
});

function mockMediaFile(name: string): ReferenceFileEntry {
  const nativePath = `C:\\References\\${name}`;
  return {
    name,
    nativePath,
    url: `file:///${nativePath.replace(/\\/gu, "/")}`,
    isFile: true,
    read: async () => Uint8Array.from([1, 2, 3]),
  } as unknown as ReferenceFileEntry;
}

function createCardLibrary(): { library: ReferenceLibrary; store: Map<string, string> } {
  const store = new Map<string, string>();
  const entriesByToken = new Map<string, ReferenceFileEntry>();
  let tokenCount = 0;
  const adapter: ReferenceLibraryAdapter = {
    localFileSystem: {
      getFileForOpening: async () => null,
      createPersistentToken: async (entry: ReferenceFileEntry) => {
        tokenCount += 1;
        const token = `card-token-${tokenCount}`;
        entriesByToken.set(token, entry);
        return token;
      },
      getEntryForPersistentToken: async (token: string) => {
        const entry = entriesByToken.get(token);
        if (!entry) throw new Error(`expired token: ${token}`);
        return entry;
      },
    },
    storage: {
      getItem: async (key: string) => store.get(key) ?? null,
      setItem: async (key: string, value: string) => { store.set(key, value); },
      removeItem: async (key: string) => { store.delete(key); },
    },
    binaryFormat: "binary-format",
  } as unknown as ReferenceLibraryAdapter;
  const library = new ReferenceLibrary(adapter, {
    idFactory: (_entry, index) => `card-${index}`,
    now: () => 1,
  });
  return { library, store };
}

function aiCheckboxes(list: FakeElement): FakeElement[] {
  return list.querySelectorAll("input").filter((input) => input.type === "checkbox");
}

describe("ReferenceController 카드 상태와 AI 선택 상한", () => {
  it("만료된 레퍼런스 카드는 접근 만료를 표시하고 AI 선택을 감춘다", async () => {
    const dom = installDom();
    try {
      const { library, store } = createCardLibrary();
      const lost: ReferenceItem = {
        id: "lost-1",
        name: "gone.png",
        type: "image",
        url: "file:///C:/References/gone.png",
        nativePath: "C:\\References\\gone.png",
        token: "expired-token",
        notes: "",
        source: "",
        tags: [],
        createdAt: 1,
      };
      store.set(REFERENCE_STORAGE_KEY, serializeReferences([lost]));
      const controller = new ReferenceController({ library });
      await controller.initialize();

      assert.equal(controller.items[0]?.unavailable, true);
      const card = dom.list.querySelectorAll(".reference-card")[0];
      assert.ok(card, "만료된 항목도 카드로 렌더링되어야 합니다.");
      assert.ok(card.classList.contains("is-unavailable"));
      assert.equal(
        card.querySelectorAll(".reference-unavailable")[0]?.textContent,
        "파일 접근 만료",
      );
      assert.equal(card.querySelectorAll(".reference-ai-select").length, 0);
    } finally {
      dom.restore();
    }
  });

  it("이미지 AI 입력 선택은 최대 4개로 제한하고 체크를 되돌린다", async () => {
    const dom = installDom();
    try {
      const { library } = createCardLibrary();
      await library.addEntries(
        Array.from({ length: 5 }, (_value, index) => mockMediaFile(`image-${index}.png`)),
      );
      const errors: Array<{ message: string; context: string }> = [];
      const selections: Array<readonly string[]> = [];
      const controller = new ReferenceController({
        library,
        onError: (error, context) => errors.push({
          message: error instanceof Error ? error.message : String(error),
          context,
        }),
        onSelectionChange: (ids) => selections.push(ids),
      });
      await controller.initialize();

      const checkboxes = aiCheckboxes(dom.list);
      assert.equal(checkboxes.length, 5);
      for (const box of checkboxes.slice(0, MAX_IMAGE_INPUTS)) {
        box.checked = true;
        box.dispatch("change");
      }
      assert.equal(errors.length, 0);
      assert.equal(controller.selectedIds.length, MAX_IMAGE_INPUTS);

      const fifth = checkboxes[MAX_IMAGE_INPUTS]!;
      fifth.checked = true;
      fifth.dispatch("change");

      assert.equal(fifth.checked, false, "거부된 선택은 체크 상태를 되돌려야 합니다.");
      assert.equal(controller.selectedIds.length, MAX_IMAGE_INPUTS);
      assert.equal(errors[0]?.context, "AI 레퍼런스 선택 실패");
      assert.match(errors[0]?.message ?? "", /최대 4개/u);
      assert.equal(selections.length, MAX_IMAGE_INPUTS, "실패한 선택은 알림을 발생시키지 않습니다.");
    } finally {
      dom.restore();
    }
  });

  it("프롬프트 참고 선택은 전체 8개 상한을 넘지 못한다", async () => {
    const dom = installDom();
    try {
      const { library } = createCardLibrary();
      await library.addEntries(
        Array.from({ length: 9 }, (_value, index) => mockMediaFile(`clip-${index}.mp4`)),
      );
      const errors: string[] = [];
      const controller = new ReferenceController({
        library,
        onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
      });
      await controller.initialize();

      const checkboxes = aiCheckboxes(dom.list);
      assert.equal(checkboxes.length, 9);
      for (const box of checkboxes.slice(0, MAX_REFERENCE_PROMPT_ITEMS)) {
        box.checked = true;
        box.dispatch("change");
      }
      assert.equal(errors.length, 0);
      assert.equal(controller.selectedIds.length, MAX_REFERENCE_PROMPT_ITEMS);

      const ninth = checkboxes[MAX_REFERENCE_PROMPT_ITEMS]!;
      ninth.checked = true;
      ninth.dispatch("change");

      assert.equal(ninth.checked, false);
      assert.equal(controller.selectedIds.length, MAX_REFERENCE_PROMPT_ITEMS);
      assert.match(errors[0] ?? "", /최대 8개/u);
    } finally {
      dom.restore();
    }
  });
});

describe("ReferenceController AI 이미지 생성", () => {
  function registerGenControls(dom: DomHandle): void {
    dom.doc.register("reference-gen-prompt-input", "textarea");
    dom.doc.register("reference-gen-size-select", "select");
    dom.doc.register("reference-gen-btn", "button");
  }

  it("provider가 돌려준 파일 엔트리를 'AI 생성' 출처로 레퍼런스에 추가한다", async () => {
    const dom = installDom();
    registerGenControls(dom);
    try {
      const { library } = createSeededLibrary();
      const calls: Array<{ prompt: string; size: string }> = [];
      const controller = new ReferenceController({
        library,
        generatedImageProvider: async (prompt, size) => {
          calls.push({ prompt, size });
          return mockPngFile("ai-gen.png");
        },
      });
      await controller.initialize();

      const promptInput = dom.doc.getElementById("reference-gen-prompt-input")!;
      promptInput.value = "붉은 노을 실루엣";
      dom.doc.getElementById("reference-gen-size-select")!.value = "1536x1024";
      dom.doc.getElementById("reference-gen-btn")!.dispatch("click");
      await flush();

      assert.deepEqual(calls, [{ prompt: "붉은 노을 실루엣", size: "1536x1024" }]);
      assert.equal(controller.items.length, 1);
      assert.match(controller.items[0]?.source ?? "", /AI 생성/u);
      assert.equal(controller.items[0]?.type, "image");
      assert.equal(promptInput.value, "");
    } finally {
      dom.restore();
    }
  });

  it("프롬프트가 비어 있으면 provider를 호출하지 않고 오류를 알린다", async () => {
    const dom = installDom();
    registerGenControls(dom);
    try {
      const { library } = createSeededLibrary();
      let providerCalls = 0;
      const errors: string[] = [];
      const controller = new ReferenceController({
        library,
        generatedImageProvider: async () => {
          providerCalls += 1;
          return mockPngFile("x.png");
        },
        onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
      });
      await controller.initialize();

      dom.doc.getElementById("reference-gen-prompt-input")!.value = "   ";
      dom.doc.getElementById("reference-gen-btn")!.dispatch("click");
      await flush();

      assert.equal(providerCalls, 0);
      assert.equal(controller.items.length, 0);
      assert.match(errors[0] ?? "", /프롬프트/u);
    } finally {
      dom.restore();
    }
  });
});
