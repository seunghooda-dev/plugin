// 레퍼런스 컨트롤러의 AI 프롬프트 보강(FR-06) 흐름을 검증하는 테스트
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ReferenceLibrary,
  type ReferenceFileEntry,
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
