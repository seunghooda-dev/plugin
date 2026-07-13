import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  THUMBNAIL_OUTPUT_FOLDER_TOKEN_KEY,
  THUMBNAIL_STORAGE_KEY,
  ThumbnailController,
  type ThumbnailControllerAdapter,
  type ThumbnailFileEntry,
  type ThumbnailFolderEntry,
  type ThumbnailLocalFileSystem,
  type ThumbnailStorage,
} from "../src/thumbnail-controller";

type FakeListener = (event: FakeEvent) => unknown;

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

class FakeEvent {
  defaultPrevented = false;
  propagationStopped = false;
  key = "";
  clientX = 0;
  clientY = 0;
  dataTransfer: undefined;

  preventDefault(): void {
    this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.propagationStopped = true;
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
  tabIndex = 0;
  draggable = false;
  dataset: Record<string, string> = {};
  parentElement: FakeElement | null = null;
  readonly children: FakeElement[] = [];
  readonly classList = new FakeClassList(this);
  options: FakeElement[] = [];
  private readonly listeners = new Map<string, Set<FakeListener>>();
  private readonly attributes = new Map<string, string>();

  constructor(readonly tagName: string) {}

  addEventListener(type: string, listener: FakeListener): void {
    const listeners = this.listeners.get(type) ?? new Set<FakeListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
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

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  closest(selector: string): FakeElement | null {
    if (matches(this, selector)) return this;
    let current = this.parentElement;
    while (current) {
      if (matches(current, selector)) return current;
      current = current.parentElement;
    }
    return null;
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

  emit(type: string, values: Partial<FakeEvent> = {}): FakeEvent {
    const event = Object.assign(new FakeEvent(), values);
    this.listeners.get(type)?.forEach((listener) => listener(event));
    return event;
  }
}

interface FakeCanvasContext {
  canvas: FakeCanvas;
  drawImage(...args: unknown[]): void;
  fillText(...args: unknown[]): void;
  clearRect(...args: unknown[]): void;
  fillRect(...args: unknown[]): void;
  beginPath(): void;
  rect(...args: unknown[]): void;
  clip(): void;
  strokeRect(...args: unknown[]): void;
  measureText(text: string): { width: number };
  save(): void;
  restore(): void;
  [key: string]: unknown;
}

class FakeCanvas extends FakeElement {
  width = 1280;
  height = 720;
  readonly context: FakeCanvasContext;
  convertToBlob?: (options?: { type?: string; quality?: number }) => Promise<Uint8Array>;

  constructor(capable: boolean) {
    super("canvas");
    this.context = {
      canvas: this,
      drawImage: () => undefined,
      fillText: () => undefined,
      clearRect: () => undefined,
      fillRect: () => undefined,
      beginPath: () => undefined,
      rect: () => undefined,
      clip: () => undefined,
      strokeRect: () => undefined,
      measureText: (text) => ({ width: text.length * 10 }),
      save: () => undefined,
      restore: () => undefined,
      filter: "none",
      fillStyle: "#000000",
      strokeStyle: "#000000",
      lineWidth: 1,
      globalAlpha: 1,
      shadowBlur: 0,
      shadowColor: "transparent",
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      font: "",
      textAlign: "left",
      textBaseline: "middle",
      imageSmoothingEnabled: true,
      imageSmoothingQuality: "high",
    };
    if (capable) {
      this.convertToBlob = async (options) => options?.type === "image/jpeg"
        ? Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])
        : Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    }
  }

  getContext(type: string): FakeCanvasContext | null {
    return type === "2d" ? this.context : null;
  }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: 640, height: 360 };
  }
}

function matches(element: FakeElement, selector: string): boolean {
  if (selector.startsWith("#")) return element.id === selector.slice(1);
  if (selector.startsWith(".")) return element.classList.contains(selector.slice(1));
  const dataValue = /^\[data-value-for="([^"]+)"\]$/u.exec(selector);
  if (dataValue) return element.getAttribute("data-value-for") === dataValue[1];
  return element.tagName.toLowerCase() === selector.toLowerCase();
}

class FakeDocument {
  readonly elements = new Map<string, FakeElement>();
  readonly roots: FakeElement[] = [];

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }

  getElementById(id: string): FakeElement | null {
    return this.elements.get(id) ?? null;
  }

  querySelector(selector: string): FakeElement | null {
    for (const root of this.roots) {
      if (matches(root, selector)) return root;
      const found = root.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  add(id: string, tagName = "input", value = ""): FakeElement {
    const node = new FakeElement(tagName);
    node.id = id;
    node.value = value;
    this.elements.set(id, node);
    this.roots.push(node);
    return node;
  }

  registerChild(id: string, node: FakeElement, parent: FakeElement): FakeElement {
    node.id = id;
    this.elements.set(id, node);
    parent.append(node);
    return node;
  }
}

function controllerDom(canvasCapable: boolean): { document: FakeDocument; canvas: FakeCanvas } {
  const document = new FakeDocument();
  document.add("thumbnail-source-btn", "button");
  const layout = document.add("thumbnail-layout-select", "select", "full");
  layout.options = ["full", "vertical", "horizontal", "hero-left", "hero-top", "grid"].map((value) => {
    const option = new FakeElement("option");
    option.value = value;
    return option;
  });
  document.add("thumb-export-btn", "button");
  document.add("thumb-export-svg-btn", "button");
  document.add("thumb-export-format-select", "select", "png");
  document.add("thumb-ai-run-btn", "button");
  document.add("thumb-ai-preset-select", "select", "basic");
  document.add("thumb-ai-prompt-input", "textarea", "");
  document.add("thumb-title-input", "input", "");
  document.add("thumb-title-color", "input", "#ffffff");
  document.add("thumb-title-size-input", "input", "72");
  document.add("thumb-badge-input", "input", "");
  document.add("thumb-badge-color", "input", "#ffffff");
  document.add("thumb-badge-background-color", "input", "#7c3aed");
  document.add("thumb-zoom-input", "input", "100");
  document.add("thumb-offset-x-input", "input", "0");
  document.add("thumb-offset-y-input", "input", "0");
  document.add("thumb-brightness-input", "input", "100");
  document.add("thumb-contrast-input", "input", "100");
  document.add("thumb-saturation-input", "input", "100");
  document.add("thumb-shadow-checkbox", "input");
  document.add("thumb-shadow-color", "input", "#000000");
  document.add("thumb-glow-checkbox", "input");
  document.add("thumb-glow-color", "input", "#8b5cf6");
  document.add("thumbnail-layer-list", "div");
  document.add("thumb-ai-history", "div");
  const shell = document.add("thumbnail-canvas-shell", "div");
  shell.className = "thumbnail-canvas-shell";
  const canvas = new FakeCanvas(canvasCapable);
  document.registerChild("thumbnail-canvas", canvas, shell);
  return { document, canvas };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

class MemoryStorage implements ThumbnailStorage {
  readonly values = new Map<string, string>();
  readonly writes: Array<{ key: string; value: string }> = [];
  nextWriteGate: Deferred<void> | null = null;

  getItem(key: string): unknown {
    return this.values.get(key);
  }

  setItem(key: string, value: string): void | Promise<void> {
    this.values.set(key, value);
    this.writes.push({ key, value });
    const gate = this.nextWriteGate;
    this.nextWriteGate = null;
    return gate?.promise;
  }
}

class FailingRemoveStorage extends MemoryStorage {
  removeCalls = 0;

  removeItem(): void {
    this.removeCalls += 1;
    throw new Error("remove denied");
  }
}

class ThrowingGetItemStorage extends MemoryStorage {
  throwOnKey: string | null = null;

  getItem(key: string): unknown {
    if (key === this.throwOnKey) throw new Error("token read denied");
    return super.getItem(key);
  }
}

interface WrittenFile {
  name: string;
  bytes: Uint8Array;
  format: unknown;
}

class OutputFolder implements ThumbnailFolderEntry {
  readonly name = "exports";
  readonly isFolder = true;
  readonly files: WrittenFile[] = [];
  createError: Error | null = null;
  writeError: Error | null = null;

  async createFile(name: string, options?: { overwrite?: boolean }): Promise<ThumbnailFileEntry> {
    const createError = this.createError;
    this.createError = null;
    if (createError) throw createError;
    if (options?.overwrite === false && this.files.some((file) => file.name === name)) {
      throw new Error(`duplicate output: ${name}`);
    }
    return {
      name,
      isFile: true,
      write: (data, writeOptions) => {
        const writeError = this.writeError;
        this.writeError = null;
        if (writeError) throw writeError;
        this.files.push({
          name,
          bytes: new Uint8Array(data.slice(0)),
          format: writeOptions?.format,
        });
      },
    };
  }
}

class FakeLocalFileSystem implements ThumbnailLocalFileSystem {
  selection: ThumbnailFileEntry | ThumbnailFileEntry[] | null = null;
  readonly entries = new Map<string, ThumbnailFileEntry | ThumbnailFolderEntry>();
  readonly output = new OutputFolder();
  folderGate: Deferred<ThumbnailFolderEntry | null> | null = null;
  getFolderCalls = 0;

  async getFileForOpening(): Promise<ThumbnailFileEntry | ThumbnailFileEntry[] | null> {
    return this.selection;
  }

  async createPersistentToken(entry: ThumbnailFileEntry | ThumbnailFolderEntry): Promise<string> {
    const token = `token:${String(entry.name)}`;
    this.entries.set(token, entry);
    return token;
  }

  async getEntryForPersistentToken(token: string): Promise<ThumbnailFileEntry | ThumbnailFolderEntry> {
    const entry = this.entries.get(token);
    if (!entry) throw new Error(`missing token: ${token}`);
    return entry;
  }

  async getFolder(): Promise<ThumbnailFolderEntry | null> {
    this.getFolderCalls += 1;
    return this.folderGate ? this.folderGate.promise : this.output;
  }
}

function sourceEntry(name: string): ThumbnailFileEntry {
  return {
    name,
    isFile: true,
    url: `file:///C:/media/${encodeURIComponent(name)}`,
    read: () => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]),
  };
}

function adapter(fileSystem: FakeLocalFileSystem, storage = new MemoryStorage()): ThumbnailControllerAdapter {
  return { localFileSystem: fileSystem, storage, binaryFormat: "binary" };
}

function loadedImage(): {
  src: string;
  complete: boolean;
  naturalWidth: number;
  naturalHeight: number;
  onload: (() => void) | null;
  onerror: ((event?: unknown) => void) | null;
} {
  return {
    src: "",
    complete: true,
    naturalWidth: 640,
    naturalHeight: 360,
    onload: null,
    onerror: null,
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function waitUntil(predicate: () => boolean, attempts = 100): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await settle();
  }
  assert.fail("condition was not reached");
}

async function withDocument<T>(document: FakeDocument, task: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  try {
    return await task();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "document", descriptor);
    else delete (globalThis as { document?: unknown }).document;
  }
}

function createController(
  dom: FakeDocument,
  fileSystem: FakeLocalFileSystem,
  storage: MemoryStorage,
  errors: string[] = [],
): ThumbnailController {
  void dom;
  return new ThumbnailController({
    adapter: adapter(fileSystem, storage),
    now: () => Date.UTC(2026, 6, 12, 1, 2, 3),
    imageFactory: loadedImage,
    onError: (error, context) => errors.push(`${context}: ${error instanceof Error ? error.message : String(error)}`),
  });
}

describe("ThumbnailController DOM/UXP integration harness", () => {
  it("persists a card selection on dispose and restores the same selected layer", async () => {
    const storage = new MemoryStorage();
    const fileSystem = new FakeLocalFileSystem();
    fileSystem.selection = [sourceEntry("first.png"), sourceEntry("second.png")];
    const firstDom = controllerDom(false).document;
    let selectedId = "";
    await withDocument(firstDom, async () => {
      const controller = createController(firstDom, fileSystem, storage);
      await controller.initialize();
      firstDom.getElementById("thumbnail-source-btn")!.emit("click");
      await waitUntil(() => controller.state.layers.length === 2);
      const layerList = firstDom.getElementById("thumbnail-layer-list")!;
      assert.equal(layerList.children.length, 2);
      layerList.children[1]!.emit("click");
      selectedId = controller.state.selectedLayerId ?? "";
      assert.equal(selectedId, controller.state.layers[1]?.id);
      await controller.dispose();
    });
    const saved = JSON.parse(storage.values.get(THUMBNAIL_STORAGE_KEY) ?? "{}") as { selectedLayerId?: string };
    assert.equal(saved.selectedLayerId, selectedId);

    const restoredDom = controllerDom(false).document;
    await withDocument(restoredDom, async () => {
      const restored = createController(restoredDom, fileSystem, storage);
      await restored.initialize();
      assert.equal(restored.state.layers.length, 2);
      assert.equal(restored.state.selectedLayerId, selectedId);
      const selectedCard = restoredDom.getElementById("thumbnail-layer-list")!.children[1];
      assert.equal(selectedCard?.getAttribute("aria-selected"), "true");
      await restored.dispose();
    });
  });

  it("blocks PNG and JPG export when the UXP Canvas lacks raster export APIs", async () => {
    const dom = controllerDom(false).document;
    const fileSystem = new FakeLocalFileSystem();
    const storage = new MemoryStorage();
    const errors: string[] = [];
    await withDocument(dom, async () => {
      const controller = createController(dom, fileSystem, storage, errors);
      await controller.initialize();
      const exportButton = dom.getElementById("thumb-export-btn")!;
      const format = dom.getElementById("thumb-export-format-select")!;
      assert.equal(exportButton.disabled, true);
      assert.match(exportButton.title, /PNG\/JPG 내보내기/u);
      for (const requested of ["png", "jpg"]) {
        format.value = requested;
        exportButton.emit("click");
        await waitUntil(() => errors.length >= (requested === "png" ? 1 : 2));
      }
      assert.match(errors[0] ?? "", /PNG 저장을 지원하지 않습니다/u);
      assert.match(errors[1] ?? "", /JPG 저장을 지원하지 않습니다/u);
      assert.equal(fileSystem.getFolderCalls, 0);
      await controller.dispose();
    });
  });

  it("saves an SVG fallback with embedded source bytes while Canvas export is unavailable", async () => {
    const dom = controllerDom(false).document;
    const fileSystem = new FakeLocalFileSystem();
    fileSystem.selection = sourceEntry("fallback.png");
    const storage = new MemoryStorage();
    await withDocument(dom, async () => {
      const controller = createController(dom, fileSystem, storage);
      await controller.initialize();
      dom.getElementById("thumbnail-source-btn")!.emit("click");
      await waitUntil(() => controller.state.layers.length === 1);
      dom.getElementById("thumb-export-svg-btn")!.emit("click");
      await waitUntil(() => fileSystem.output.files.length === 1);
      const output = fileSystem.output.files[0]!;
      assert.match(output.name, /\.svg$/u);
      assert.equal(output.format, "binary");
      const svg = new TextDecoder().decode(output.bytes);
      assert.match(svg, /^<\?xml[^]*<svg/u);
      assert.match(svg, /data:image\/png;base64,/u);
      assert.match(svg, /ShortFlow Studio thumbnail fallback/u);
      await controller.dispose();
    });
  });

  it("saves a 1280x720 SVG with no layers and reuses the persistent output folder", async () => {
    const fileSystem = new FakeLocalFileSystem();
    const storage = new MemoryStorage();
    const firstDom = controllerDom(false).document;
    await withDocument(firstDom, async () => {
      const controller = createController(firstDom, fileSystem, storage);
      await controller.initialize();
      firstDom.getElementById("thumb-export-svg-btn")!.emit("click");
      await waitUntil(() => fileSystem.output.files.length === 1);
      const svg = new TextDecoder().decode(fileSystem.output.files[0]!.bytes);
      assert.match(svg, /<svg[^>]+width="1280" height="720"[^>]+viewBox="0 0 1280 720"/u);
      assert.match(svg, /<rect width="100%" height="100%" fill="#111111"\/>/u);
      assert.doesNotMatch(svg, /<image\b/iu);
      assert.equal(storage.values.get(THUMBNAIL_OUTPUT_FOLDER_TOKEN_KEY), "token:exports");
      assert.equal(fileSystem.getFolderCalls, 1);
      await controller.dispose();
    });

    fileSystem.output.files.splice(0);
    const restoredDom = controllerDom(false).document;
    await withDocument(restoredDom, async () => {
      const controller = createController(restoredDom, fileSystem, storage);
      await controller.initialize();
      restoredDom.getElementById("thumb-export-svg-btn")!.emit("click");
      await waitUntil(() => fileSystem.output.files.length === 1);
      assert.equal(fileSystem.getFolderCalls, 1, "저장된 폴더 토큰은 picker를 다시 열지 않아야 합니다.");
      await controller.dispose();
    });
  });

  it("clears a restored output token after createFile fails and opens the picker only on the next export", async () => {
    const dom = controllerDom(false).document;
    const fileSystem = new FakeLocalFileSystem();
    const staleFolder = new OutputFolder();
    staleFolder.createError = new Error("create denied");
    fileSystem.entries.set("token:stale", staleFolder);
    const storage = new MemoryStorage();
    storage.values.set(THUMBNAIL_OUTPUT_FOLDER_TOKEN_KEY, "token:stale");
    const errors: string[] = [];
    await withDocument(dom, async () => {
      const controller = createController(dom, fileSystem, storage, errors);
      await controller.initialize();

      dom.getElementById("thumb-export-svg-btn")!.emit("click");
      await waitUntil(() => errors.length === 1);
      assert.match(errors[0] ?? "", /create denied/u);
      assert.equal(storage.values.get(THUMBNAIL_OUTPUT_FOLDER_TOKEN_KEY), "");
      assert.equal(fileSystem.getFolderCalls, 0, "실패한 호출에서 picker를 다시 열면 안 됩니다.");

      dom.getElementById("thumb-export-svg-btn")!.emit("click");
      await waitUntil(() => fileSystem.output.files.length === 1);
      assert.equal(fileSystem.getFolderCalls, 1);
      await controller.dispose();
    });
  });

  it("falls back to an empty token after removeItem and write fail, then reopens the picker", async () => {
    const dom = controllerDom(false).document;
    const fileSystem = new FakeLocalFileSystem();
    fileSystem.output.writeError = new Error("write denied");
    const storage = new FailingRemoveStorage();
    const errors: string[] = [];
    await withDocument(dom, async () => {
      const controller = createController(dom, fileSystem, storage, errors);
      await controller.initialize();

      dom.getElementById("thumb-export-svg-btn")!.emit("click");
      await waitUntil(() => errors.length === 1);
      assert.match(errors[0] ?? "", /write denied/u);
      assert.equal(storage.removeCalls, 1);
      assert.equal(storage.values.get(THUMBNAIL_OUTPUT_FOLDER_TOKEN_KEY), "");
      assert.equal(fileSystem.getFolderCalls, 1, "실패한 호출에서 picker를 다시 열면 안 됩니다.");

      dom.getElementById("thumb-export-svg-btn")!.emit("click");
      await waitUntil(() => fileSystem.output.files.length === 1);
      assert.equal(fileSystem.getFolderCalls, 2);
      await controller.dispose();
    });
  });

  it("prevents duplicate image exports while the first folder request is pending", async () => {
    const dom = controllerDom(true).document;
    const fileSystem = new FakeLocalFileSystem();
    const pendingFolder = deferred<ThumbnailFolderEntry | null>();
    fileSystem.folderGate = pendingFolder;
    const storage = new MemoryStorage();
    const errors: string[] = [];
    await withDocument(dom, async () => {
      const controller = createController(dom, fileSystem, storage, errors);
      await controller.initialize();
      const exportButton = dom.getElementById("thumb-export-btn")!;
      exportButton.emit("click");
      await waitUntil(() => fileSystem.getFolderCalls === 1);
      assert.equal(exportButton.disabled, true);
      exportButton.emit("click");
      await waitUntil(() => errors.some((message) => /이미 진행 중/u.test(message)));
      assert.equal(fileSystem.getFolderCalls, 1);
      pendingFolder.resolve(fileSystem.output);
      await waitUntil(() => fileSystem.output.files.length === 1 && exportButton.disabled === false);
      assert.equal(fileSystem.output.files.length, 1);
      assert.match(fileSystem.output.files[0]?.name ?? "", /\.png$/u);
      await controller.dispose();
    });
  });

  it("flushes a pending debounced autosave before dispose clears source state", async () => {
    const dom = controllerDom(false).document;
    const fileSystem = new FakeLocalFileSystem();
    fileSystem.selection = sourceEntry("flush.png");
    const storage = new MemoryStorage();
    await withDocument(dom, async () => {
      const controller = createController(dom, fileSystem, storage);
      await controller.initialize();
      dom.getElementById("thumbnail-source-btn")!.emit("click");
      await waitUntil(() => controller.state.layers.length === 1 && storage.writes.length >= 1);
      const initialWrites = storage.writes.length;
      const writeGate = deferred<void>();
      storage.nextWriteGate = writeGate;
      const title = dom.getElementById("thumb-title-input")!;
      title.value = "종료 직전 제목";
      title.emit("input");

      let disposed = false;
      const disposing = controller.dispose().then(() => { disposed = true; });
      await waitUntil(() => storage.writes.length === initialWrites + 1);
      assert.equal(disposed, false, "dispose는 비동기 저장 완료를 기다려야 합니다.");
      const savedBeforeResolve = JSON.parse(storage.values.get(THUMBNAIL_STORAGE_KEY) ?? "{}") as {
        textOverlay?: { text?: string };
        layers?: unknown[];
      };
      assert.equal(savedBeforeResolve.textOverlay?.text, "종료 직전 제목");
      assert.equal(savedBeforeResolve.layers?.length, 1);
      writeGate.resolve();
      await disposing;
      assert.equal(disposed, true);
    });
  });

  it("rejects a non-folder picker result for the SVG output location", async () => {
    const dom = controllerDom(false).document;
    const fileSystem = new FakeLocalFileSystem();
    const gate = deferred<ThumbnailFolderEntry | null>();
    fileSystem.folderGate = gate;
    const storage = new MemoryStorage();
    const errors: string[] = [];
    await withDocument(dom, async () => {
      const controller = createController(dom, fileSystem, storage, errors);
      await controller.initialize();
      dom.getElementById("thumb-export-svg-btn")!.emit("click");
      await waitUntil(() => fileSystem.getFolderCalls === 1);
      gate.resolve({ name: "picked-file", isFile: true } as unknown as ThumbnailFolderEntry);
      await waitUntil(() => errors.length === 1);
      assert.match(errors[0] ?? "", /파일이 아닌 폴더/u);
      assert.equal(fileSystem.output.files.length, 0);
      await controller.dispose();
    });
  });

  it("refuses to import more images than the four-layer ceiling allows", async () => {
    const dom = controllerDom(false).document;
    const fileSystem = new FakeLocalFileSystem();
    fileSystem.selection = [
      sourceEntry("1.png"),
      sourceEntry("2.png"),
      sourceEntry("3.png"),
      sourceEntry("4.png"),
      sourceEntry("5.png"),
    ];
    const storage = new MemoryStorage();
    const errors: string[] = [];
    await withDocument(dom, async () => {
      const controller = createController(dom, fileSystem, storage, errors);
      await controller.initialize();
      dom.getElementById("thumbnail-source-btn")!.emit("click");
      await waitUntil(() => errors.length === 1);
      assert.match(errors[0] ?? "", /이미지는 최대 4개/u);
      assert.equal(controller.state.layers.length, 0);
      await controller.dispose();
    });
  });

  it("applies brand defaults to the layout and every image layer", async () => {
    const dom = controllerDom(false).document;
    const fileSystem = new FakeLocalFileSystem();
    fileSystem.selection = [sourceEntry("a.png"), sourceEntry("b.png")];
    const storage = new MemoryStorage();
    await withDocument(dom, async () => {
      const controller = createController(dom, fileSystem, storage);
      await controller.initialize();
      dom.getElementById("thumbnail-source-btn")!.emit("click");
      await waitUntil(() => controller.state.layers.length === 2);
      await controller.applyBrandDefaults({
        layout: "horizontal",
        backgroundColor: "#123456",
        textColor: "#abcdef",
        brightness: 130,
        contrast: 80,
        saturation: 60,
        shadow: 40,
        glow: 15,
        shadowColor: "#010203",
        glowColor: "#040506",
      });
      assert.equal(controller.state.layout, "horizontal");
      assert.equal(controller.state.backgroundColor, "#123456");
      assert.equal(controller.state.textOverlay.color, "#abcdef");
      for (const layer of controller.state.layers) {
        assert.deepEqual(layer.adjustments, { brightness: 130, contrast: 80, saturation: 60 });
        assert.equal(layer.overlay.shadow, 40);
        assert.equal(layer.overlay.glow, 15);
        assert.equal(layer.overlay.shadowColor, "#010203");
        assert.equal(layer.overlay.glowColor, "#040506");
      }
      const saved = JSON.parse(storage.values.get(THUMBNAIL_STORAGE_KEY) ?? "{}") as {
        backgroundColor?: string;
        layout?: string;
      };
      assert.equal(saved.backgroundColor, "#123456");
      assert.equal(saved.layout, "horizontal");
      await controller.dispose();
    });
  });

  it("persists and restores per-layer adjustments, transform, and overlay", async () => {
    const fileSystem = new FakeLocalFileSystem();
    fileSystem.selection = sourceEntry("edit.png");
    const storage = new MemoryStorage();
    const firstDom = controllerDom(false).document;
    await withDocument(firstDom, async () => {
      const controller = createController(firstDom, fileSystem, storage);
      await controller.initialize();
      firstDom.getElementById("thumbnail-source-btn")!.emit("click");
      await waitUntil(() => controller.state.layers.length === 1);
      const brightness = firstDom.getElementById("thumb-brightness-input")!;
      brightness.value = "140";
      brightness.emit("input");
      const zoom = firstDom.getElementById("thumb-zoom-input")!;
      zoom.value = "220";
      zoom.emit("input");
      const shadow = firstDom.getElementById("thumb-shadow-checkbox")!;
      shadow.checked = true;
      shadow.emit("change");
      await waitUntil(() =>
        controller.state.layers[0]?.adjustments.brightness === 140 &&
        controller.state.layers[0]?.transform.zoom === 2.2 &&
        (controller.state.layers[0]?.overlay.shadow ?? 0) > 0);
      await controller.dispose();
    });

    const restoredDom = controllerDom(false).document;
    await withDocument(restoredDom, async () => {
      const restored = createController(restoredDom, fileSystem, storage);
      await restored.initialize();
      assert.equal(restored.state.layers.length, 1);
      const layer = restored.state.layers[0]!;
      assert.equal(layer.adjustments.brightness, 140);
      assert.equal(layer.transform.zoom, 2.2);
      assert.ok(layer.overlay.shadow > 0);
      await restored.dispose();
    });
  });

  it("selects the image under a canvas click using layout hit-testing", async () => {
    const built = controllerDom(false);
    const dom = built.document;
    const canvas = built.canvas;
    const fileSystem = new FakeLocalFileSystem();
    fileSystem.selection = [sourceEntry("left.png"), sourceEntry("right.png")];
    const storage = new MemoryStorage();
    await withDocument(dom, async () => {
      const controller = createController(dom, fileSystem, storage);
      await controller.initialize();
      dom.getElementById("thumbnail-source-btn")!.emit("click");
      await waitUntil(() => controller.state.layers.length === 2);
      canvas.emit("click", { clientX: 480, clientY: 100 });
      assert.equal(controller.state.selectedLayerId, controller.state.layers[1]?.id);
      canvas.emit("click", { clientX: 100, clientY: 100 });
      assert.equal(controller.state.selectedLayerId, controller.state.layers[0]?.id);
      await controller.dispose();
    });
  });

  it("re-opens the folder picker when the stored output token cannot be read", async () => {
    const dom = controllerDom(false).document;
    const fileSystem = new FakeLocalFileSystem();
    const storage = new ThrowingGetItemStorage();
    storage.throwOnKey = THUMBNAIL_OUTPUT_FOLDER_TOKEN_KEY;
    const activity: string[] = [];
    await withDocument(dom, async () => {
      const controller = new ThumbnailController({
        adapter: adapter(fileSystem, storage),
        now: () => Date.UTC(2026, 6, 12, 1, 2, 3),
        imageFactory: loadedImage,
        onActivity: (message) => activity.push(message),
      });
      await controller.initialize();
      dom.getElementById("thumb-export-svg-btn")!.emit("click");
      await waitUntil(() => fileSystem.output.files.length === 1);
      assert.equal(fileSystem.getFolderCalls, 1);
      assert.ok(activity.some((message) => /권한을 읽지 못해/u.test(message)));
      assert.equal(storage.values.get(THUMBNAIL_OUTPUT_FOLDER_TOKEN_KEY), "token:exports");
      await controller.dispose();
    });
  });
});

class EmptyTokenFileSystem extends FakeLocalFileSystem {
  async createPersistentToken(): Promise<string> {
    return "   ";
  }
}

function readOnlyEntry(name: string, onRead: () => void): ThumbnailFileEntry {
  return {
    name,
    isFile: true,
    read: () => {
      onRead();
      return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    },
  };
}

function createControllerWithLog(
  fileSystem: FakeLocalFileSystem,
  storage: MemoryStorage,
  errors: string[] = [],
  activity: string[] = [],
): ThumbnailController {
  return new ThumbnailController({
    adapter: adapter(fileSystem, storage),
    now: () => Date.UTC(2026, 6, 12, 1, 2, 3),
    imageFactory: loadedImage,
    onError: (error, context) =>
      errors.push(`${context}: ${error instanceof Error ? error.message : String(error)}`),
    onActivity: (message) => activity.push(message),
  });
}

describe("ThumbnailController deeper layer, restore, and capability coverage", () => {
  it("maps numeric layout control values and reports unsupported ones", async () => {
    const dom = controllerDom(false).document;
    const fileSystem = new FakeLocalFileSystem();
    const storage = new MemoryStorage();
    const errors: string[] = [];
    await withDocument(dom, async () => {
      const controller = createController(dom, fileSystem, storage, errors);
      await controller.initialize();
      const select = dom.getElementById("thumbnail-layout-select")!;
      select.value = "2";
      select.emit("change");
      await waitUntil(() => controller.state.layout === "vertical" && select.value === "vertical");

      select.value = "nonsense";
      select.emit("change");
      await waitUntil(() => errors.length === 1);
      assert.match(errors[0] ?? "", /지원하지 않는 썸네일 분할 값/u);
      assert.equal(controller.state.layout, "vertical", "실패한 변경은 레이아웃을 유지해야 합니다.");
      assert.equal(select.value, "vertical", "실패 후 select는 실제 레이아웃으로 되돌아가야 합니다.");
      await controller.dispose();
    });
  });

  it("rejects a layout smaller than the current layer count and restores the control", async () => {
    const dom = controllerDom(false).document;
    const fileSystem = new FakeLocalFileSystem();
    fileSystem.selection = [sourceEntry("a.png"), sourceEntry("b.png"), sourceEntry("c.png")];
    const storage = new MemoryStorage();
    const errors: string[] = [];
    await withDocument(dom, async () => {
      const controller = createController(dom, fileSystem, storage, errors);
      await controller.initialize();
      dom.getElementById("thumbnail-source-btn")!.emit("click");
      await waitUntil(() => controller.state.layers.length === 3);
      assert.equal(controller.state.layout, "hero-left");
      const select = dom.getElementById("thumbnail-layout-select")!;
      select.value = "2";
      select.emit("change");
      await waitUntil(() => errors.length === 1);
      assert.match(errors[0] ?? "", /레이어 수가 많습니다/u);
      assert.equal(controller.state.layout, "hero-left");
      assert.equal(select.value, "hero-left");
      await controller.dispose();
    });
  });

  it("removes a layer through the card remove button and announces it", async () => {
    const dom = controllerDom(false).document;
    const fileSystem = new FakeLocalFileSystem();
    fileSystem.selection = [sourceEntry("keep.png"), sourceEntry("drop.png")];
    const storage = new MemoryStorage();
    const activity: string[] = [];
    await withDocument(dom, async () => {
      const controller = createControllerWithLog(fileSystem, storage, [], activity);
      await controller.initialize();
      dom.getElementById("thumbnail-source-btn")!.emit("click");
      await waitUntil(() => controller.state.layers.length === 2);
      const firstId = controller.state.layers[0]!.id;
      const layerList = dom.getElementById("thumbnail-layer-list")!;
      const removeButton = layerList.children[1]!.children[3]!;
      const removeEvent = removeButton.emit("click");
      assert.equal(removeEvent.propagationStopped, true, "삭제 클릭은 카드 선택으로 전파되면 안 됩니다.");
      await waitUntil(() => activity.some((message) => /레이어를 삭제했습니다/u.test(message)));
      assert.equal(controller.state.layers.length, 1);
      assert.equal(controller.state.layers[0]?.id, firstId);
      assert.equal(controller.state.selectedLayerId, firstId, "삭제 후 선택은 남은 레이어로 이동해야 합니다.");
      await controller.dispose();
    });
  });

  it("selects with Enter and deletes with Delete via card keyboard events", async () => {
    const dom = controllerDom(false).document;
    const fileSystem = new FakeLocalFileSystem();
    fileSystem.selection = [sourceEntry("one.png"), sourceEntry("two.png")];
    const storage = new MemoryStorage();
    await withDocument(dom, async () => {
      const controller = createController(dom, fileSystem, storage);
      await controller.initialize();
      dom.getElementById("thumbnail-source-btn")!.emit("click");
      await waitUntil(() => controller.state.layers.length === 2);
      const firstId = controller.state.layers[0]!.id;
      const secondId = controller.state.layers[1]!.id;
      assert.equal(controller.state.selectedLayerId, secondId, "가장 최근에 추가한 레이어가 선택됩니다.");

      const layerList = dom.getElementById("thumbnail-layer-list")!;
      const enterEvent = layerList.children[0]!.emit("keydown", { key: "Enter" });
      assert.equal(enterEvent.defaultPrevented, true);
      assert.equal(controller.state.selectedLayerId, firstId);

      const deleteEvent = layerList.children[0]!.emit("keydown", { key: "Delete" });
      assert.equal(deleteEvent.defaultPrevented, true);
      await waitUntil(() => controller.state.layers.length === 1);
      assert.equal(controller.state.layers[0]?.id, secondId);
      await controller.dispose();
    });
  });

  it("reorders layers through drag-and-drop and persists the new order", async () => {
    const dom = controllerDom(false).document;
    const fileSystem = new FakeLocalFileSystem();
    fileSystem.selection = [sourceEntry("a.png"), sourceEntry("b.png"), sourceEntry("c.png")];
    const storage = new MemoryStorage();
    await withDocument(dom, async () => {
      const controller = createController(dom, fileSystem, storage);
      await controller.initialize();
      dom.getElementById("thumbnail-source-btn")!.emit("click");
      await waitUntil(() => controller.state.layers.length === 3);
      const ids = controller.state.layers.map((layer) => layer.id);
      const layerList = dom.getElementById("thumbnail-layer-list")!;
      const expectedOrder = [ids[1], ids[2], ids[0]];
      layerList.children[0]!.emit("dragstart");
      layerList.children[2]!.emit("drop");
      const readSavedOrder = (): Array<string> => {
        const saved = JSON.parse(storage.values.get(THUMBNAIL_STORAGE_KEY) ?? "{}") as {
          layers?: Array<{ id: string }>;
        };
        return (saved.layers ?? []).map((entry) => entry.id);
      };
      await waitUntil(() => readSavedOrder().join(",") === expectedOrder.join(","));
      assert.deepEqual(controller.state.layers.map((layer) => layer.id), expectedOrder);
      assert.deepEqual(readSavedOrder(), expectedOrder);
      await controller.dispose();
    });
  });

  it("rejects a picked entry that is not a readable image file", async () => {
    const dom = controllerDom(false).document;
    const fileSystem = new FakeLocalFileSystem();
    fileSystem.selection = { name: "folder", isFile: false };
    const storage = new MemoryStorage();
    const errors: string[] = [];
    await withDocument(dom, async () => {
      const controller = createController(dom, fileSystem, storage, errors);
      await controller.initialize();
      dom.getElementById("thumbnail-source-btn")!.emit("click");
      await waitUntil(() => errors.length === 1);
      assert.match(errors[0] ?? "", /읽을 수 있는 이미지 파일이 아닙니다/u);
      assert.equal(controller.state.layers.length, 0);
      await controller.dispose();
    });
  });

  it("fails source import when a persistent token cannot be created", async () => {
    const dom = controllerDom(false).document;
    const fileSystem = new EmptyTokenFileSystem();
    fileSystem.selection = sourceEntry("locked.png");
    const storage = new MemoryStorage();
    const errors: string[] = [];
    await withDocument(dom, async () => {
      const controller = createController(dom, fileSystem, storage, errors);
      await controller.initialize();
      dom.getElementById("thumbnail-source-btn")!.emit("click");
      await waitUntil(() => errors.length === 1);
      assert.match(errors[0] ?? "", /영구 접근 권한을 만들지 못했습니다/u);
      assert.equal(controller.state.layers.length, 0);
      await controller.dispose();
    });
  });

  it("refuses a batch that exceeds the remaining layer capacity", async () => {
    const dom = controllerDom(false).document;
    const fileSystem = new FakeLocalFileSystem();
    fileSystem.selection = [sourceEntry("a.png"), sourceEntry("b.png"), sourceEntry("c.png")];
    const storage = new MemoryStorage();
    const errors: string[] = [];
    await withDocument(dom, async () => {
      const controller = createController(dom, fileSystem, storage, errors);
      await controller.initialize();
      dom.getElementById("thumbnail-source-btn")!.emit("click");
      await waitUntil(() => controller.state.layers.length === 3);
      fileSystem.selection = [sourceEntry("d.png"), sourceEntry("e.png")];
      dom.getElementById("thumbnail-source-btn")!.emit("click");
      await waitUntil(() => errors.length === 1);
      assert.match(errors[0] ?? "", /현재 1개를 더 추가할 수 있습니다/u);
      assert.equal(controller.state.layers.length, 3, "용량을 넘는 일괄 추가는 부분 반영되면 안 됩니다.");
      await controller.dispose();
    });
  });

  it("builds a preview URL by reading entries that expose no direct URL", async () => {
    const dom = controllerDom(false).document;
    const fileSystem = new FakeLocalFileSystem();
    let reads = 0;
    fileSystem.selection = readOnlyEntry("blob-only.png", () => {
      reads += 1;
    });
    const storage = new MemoryStorage();
    const errors: string[] = [];
    await withDocument(dom, async () => {
      const controller = createController(dom, fileSystem, storage, errors);
      await controller.initialize();
      dom.getElementById("thumbnail-source-btn")!.emit("click");
      await waitUntil(() => controller.state.layers.length === 1);
      assert.ok(reads >= 1, "직접 URL이 없으면 바이트를 읽어 미리보기 URL을 만들어야 합니다.");
      assert.deepEqual(errors, []);
      await controller.dispose();
    });
  });

  it("rejects an image entry lacking both a URL and a reader", async () => {
    const dom = controllerDom(false).document;
    const fileSystem = new FakeLocalFileSystem();
    fileSystem.selection = { name: "empty.png", isFile: true };
    const storage = new MemoryStorage();
    const errors: string[] = [];
    await withDocument(dom, async () => {
      const controller = createController(dom, fileSystem, storage, errors);
      await controller.initialize();
      dom.getElementById("thumbnail-source-btn")!.emit("click");
      await waitUntil(() => errors.length === 1);
      assert.match(errors[0] ?? "", /미리보기 URL을 만들 수 없습니다/u);
      assert.equal(controller.state.layers.length, 0);
      await controller.dispose();
    });
  });

  it("marks the canvas shell limited and shows a fallback notice only when export APIs are missing", async () => {
    const incapable = controllerDom(false).document;
    await withDocument(incapable, async () => {
      const controller = createController(incapable, new FakeLocalFileSystem(), new MemoryStorage());
      await controller.initialize();
      const shell = incapable.getElementById("thumbnail-canvas-shell")!;
      assert.ok(shell.classList.contains("is-limited"));
      const notice = shell.querySelector("#thumbnail-canvas-fallback-notice");
      assert.ok(notice);
      assert.match(notice!.textContent, /fallback 구현 후 활성화됩니다/u);
      assert.equal(incapable.getElementById("thumb-export-btn")!.disabled, true);
      assert.equal(incapable.getElementById("thumb-export-svg-btn")!.disabled, false);
      await controller.dispose();
    });

    const capable = controllerDom(true).document;
    await withDocument(capable, async () => {
      const controller = createController(capable, new FakeLocalFileSystem(), new MemoryStorage());
      await controller.initialize();
      const shell = capable.getElementById("thumbnail-canvas-shell")!;
      assert.equal(shell.classList.contains("is-limited"), false);
      assert.equal(shell.querySelector("#thumbnail-canvas-fallback-notice"), null);
      assert.equal(capable.getElementById("thumb-export-btn")!.disabled, false);
      await controller.dispose();
    });
  });

  it("blocks exporting after the controller is disposed", async () => {
    const dom = controllerDom(false).document;
    const fileSystem = new FakeLocalFileSystem();
    const storage = new MemoryStorage();
    const errors: string[] = [];
    await withDocument(dom, async () => {
      const controller = createController(dom, fileSystem, storage, errors);
      await controller.initialize();
      await controller.dispose();
      dom.getElementById("thumb-export-svg-btn")!.emit("click");
      await waitUntil(() => errors.length === 1);
      assert.match(errors[0] ?? "", /종료된 썸네일 편집기/u);
      assert.equal(fileSystem.output.files.length, 0);
    });
  });

  it("toggles badge visibility from title text and applies glow overlay to the selected layer", async () => {
    const dom = controllerDom(false).document;
    const fileSystem = new FakeLocalFileSystem();
    fileSystem.selection = sourceEntry("glow.png");
    const storage = new MemoryStorage();
    await withDocument(dom, async () => {
      const controller = createController(dom, fileSystem, storage);
      await controller.initialize();
      dom.getElementById("thumbnail-source-btn")!.emit("click");
      await waitUntil(() => controller.state.layers.length === 1);

      const badge = dom.getElementById("thumb-badge-input")!;
      badge.value = "NEW";
      badge.emit("input");
      await waitUntil(() => controller.state.badgeOverlay.text === "NEW");
      assert.equal(controller.state.badgeOverlay.visible, true);

      badge.value = "";
      badge.emit("input");
      await waitUntil(() => controller.state.badgeOverlay.visible === false);

      const glow = dom.getElementById("thumb-glow-checkbox")!;
      const glowColor = dom.getElementById("thumb-glow-color")!;
      glow.checked = true;
      glowColor.value = "#00ff88";
      glow.emit("change");
      await waitUntil(() => (controller.state.layers[0]?.overlay.glow ?? 0) > 0);
      assert.equal(controller.state.layers[0]?.overlay.glowColor, "#00ff88");
      assert.equal(controller.state.layers[0]?.overlay.shadow, 0);
      await controller.dispose();
    });
  });

  it("restores persisted edits and drops layers whose tokens no longer resolve", async () => {
    const storage = new MemoryStorage();
    storage.values.set(
      THUMBNAIL_STORAGE_KEY,
      JSON.stringify({
        version: 3,
        layout: "vertical",
        selectedLayerId: "ghost",
        backgroundColor: "#222222",
        textOverlay: { text: "복원 제목" },
        badgeOverlay: { text: "라벨" },
        layers: [
          {
            id: "keep",
            name: "keep.png",
            token: "tok-keep",
            createdAt: 5,
            adjustments: { brightness: 150 },
            transform: { zoom: 2 },
          },
          { id: "lost", name: "lost.png", token: "tok-missing", createdAt: 6 },
        ],
      }),
    );
    const fileSystem = new FakeLocalFileSystem();
    fileSystem.entries.set("tok-keep", sourceEntry("keep.png"));
    const errors: string[] = [];
    const dom = controllerDom(false).document;
    await withDocument(dom, async () => {
      const controller = createController(dom, fileSystem, storage, errors);
      await controller.initialize();
      assert.equal(controller.state.layers.length, 1);
      const layer = controller.state.layers[0]!;
      assert.equal(layer.id, "keep");
      assert.equal(layer.adjustments.brightness, 150);
      assert.equal(layer.transform.zoom, 2);
      assert.equal(controller.state.selectedLayerId, "keep", "복원할 수 없는 선택은 첫 레이어로 대체됩니다.");
      assert.equal(controller.state.layout, "vertical");
      assert.equal(controller.state.backgroundColor, "#222222");
      assert.equal(controller.state.textOverlay.text, "복원 제목");
      assert.equal(controller.state.badgeOverlay.text, "라벨");
      assert.ok(errors.some((message) => /접근 권한 복원 실패/u.test(message)));
      await controller.dispose();
    });
  });

  it("ignores malformed or unsupported stored payloads and starts fresh", async () => {
    const payloads = [
      "{ broken",
      "",
      JSON.stringify({ version: 9, layout: "full", layers: [] }),
      JSON.stringify({ version: 3, layout: "diagonal", layers: [] }),
      JSON.stringify({ version: 3, layout: "full", layers: "nope" }),
    ];
    for (const payload of payloads) {
      const storage = new MemoryStorage();
      storage.values.set(THUMBNAIL_STORAGE_KEY, payload);
      const fileSystem = new FakeLocalFileSystem();
      const dom = controllerDom(false).document;
      await withDocument(dom, async () => {
        const controller = createController(dom, fileSystem, storage);
        await controller.initialize();
        assert.equal(controller.state.layers.length, 0, `무시해야 하는 payload: ${payload}`);
        assert.equal(controller.state.layout, "full");
        await controller.dispose();
      });
    }
  });

  it("embeds the session URL in the SVG fallback when the token entry cannot be read", async () => {
    const dom = controllerDom(false).document;
    const fileSystem = new FakeLocalFileSystem();
    fileSystem.selection = sourceEntry("withurl.png");
    const storage = new MemoryStorage();
    await withDocument(dom, async () => {
      const controller = createController(dom, fileSystem, storage);
      await controller.initialize();
      dom.getElementById("thumbnail-source-btn")!.emit("click");
      await waitUntil(() => controller.state.layers.length === 1);
      // 영구 토큰이 읽기 권한을 잃은 항목으로 해석되는 상황을 재현합니다.
      fileSystem.entries.set("token:withurl.png", {
        name: "withurl.png",
        isFile: true,
        url: "file:///C:/media/withurl.png",
      });
      dom.getElementById("thumb-export-svg-btn")!.emit("click");
      await waitUntil(() => fileSystem.output.files.length === 1);
      const svg = new TextDecoder().decode(fileSystem.output.files[0]!.bytes);
      assert.match(svg, /href="file:\/\/\/C:\/media\/withurl\.png"/u);
      assert.doesNotMatch(svg, /data:image\//u);
      await controller.dispose();
    });
  });

  it("keeps AI retouch disabled when the run button is disabled", async () => {
    const dom = controllerDom(false).document;
    const fileSystem = new FakeLocalFileSystem();
    const storage = new MemoryStorage();
    const errors: string[] = [];
    await withDocument(dom, async () => {
      const controller = createController(dom, fileSystem, storage, errors);
      await controller.initialize();
      const aiButton = dom.getElementById("thumb-ai-run-btn")!;
      aiButton.disabled = true;
      aiButton.emit("click");
      await waitUntil(() => errors.length === 1);
      assert.match(errors[0] ?? "", /비활성화/u);
      await controller.dispose();
    });
  });
});
