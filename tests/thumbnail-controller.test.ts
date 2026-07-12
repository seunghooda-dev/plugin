import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
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

interface WrittenFile {
  name: string;
  bytes: Uint8Array;
  format: unknown;
}

class OutputFolder implements ThumbnailFolderEntry {
  readonly files: WrittenFile[] = [];

  async createFile(name: string, options?: { overwrite?: boolean }): Promise<ThumbnailFileEntry> {
    if (options?.overwrite === false && this.files.some((file) => file.name === name)) {
      throw new Error(`duplicate output: ${name}`);
    }
    return {
      name,
      isFile: true,
      write: (data, writeOptions) => {
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
  readonly entries = new Map<string, ThumbnailFileEntry>();
  readonly output = new OutputFolder();
  folderGate: Deferred<ThumbnailFolderEntry | null> | null = null;
  getFolderCalls = 0;

  async getFileForOpening(): Promise<ThumbnailFileEntry | ThumbnailFileEntry[] | null> {
    return this.selection;
  }

  async createPersistentToken(entry: ThumbnailFileEntry): Promise<string> {
    const token = `token:${String(entry.name)}`;
    this.entries.set(token, entry);
    return token;
  }

  async getEntryForPersistentToken(token: string): Promise<ThumbnailFileEntry> {
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
});
