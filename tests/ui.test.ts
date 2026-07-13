/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

// 공용 UI 유틸리티(src/ui.ts)의 리댁션·DOM 헬퍼·탭 라우팅·로그·토스트 동작을 검증하는 테스트
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
  ActivityLog,
  BusyState,
  bind,
  checkedOf,
  clearChildren,
  element,
  numberOf,
  optionalElement,
  redactUiError,
  renderEmptyState,
  setChecked,
  setText,
  setValue,
  setupTabs,
  toast,
  valueOf,
} from "../src/ui";

type FakeListener = (event: unknown) => unknown;

class FakeClassList {
  constructor(private readonly owner: FakeElement) {}

  private values(): Set<string> {
    return new Set(this.owner.className.split(/\s+/u).filter(Boolean));
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

function matches(candidate: FakeElement, selector: string): boolean {
  const pattern = /\.([\w-]+)|\[([\w-]+)\]/gu;
  let consumed = 0;
  for (const token of selector.matchAll(pattern)) {
    consumed += token[0].length;
    if (token[1] && !candidate.classList.contains(token[1])) return false;
    if (token[2]) {
      const dataKey = token[2].startsWith("data-") ? token[2].slice(5) : null;
      const present = dataKey === null
        ? candidate.getAttribute(token[2]) !== null
        : candidate.dataset[dataKey] !== undefined;
      if (!present) return false;
    }
  }
  return consumed === selector.length && consumed > 0;
}

class FakeElement {
  id = "";
  value = "";
  checked = false;
  hidden = false;
  textContent = "";
  className = "";
  tabIndex = 0;
  focusCalls = 0;
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

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
  }

  prepend(...nodes: FakeElement[]): void {
    for (const node of [...nodes].reverse()) {
      node.parentElement = this;
      this.children.unshift(node);
    }
  }

  remove(): void {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    const index = siblings.indexOf(this);
    if (index >= 0) siblings.splice(index, 1);
    this.parentElement = null;
  }

  removeChild(node: FakeElement): FakeElement {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    node.parentElement = null;
    return node;
  }

  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  get lastElementChild(): FakeElement | null {
    return this.children[this.children.length - 1] ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "id") this.id = value;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  focus(): void {
    this.focusCalls += 1;
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

  emit(type: string, event: unknown = {}): void {
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }
}

class FakeButtonElement extends FakeElement {
  constructor() {
    super("button");
  }
}

interface DocumentListener {
  type: string;
  listener: FakeListener;
  capture: boolean;
}

class FakeDocument {
  private readonly elements = new Map<string, FakeElement>();
  readonly roots: FakeElement[] = [];
  readonly documentListeners: DocumentListener[] = [];

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }

  getElementById(id: string): FakeElement | null {
    return this.elements.get(id) ?? null;
  }

  addEventListener(type: string, listener: FakeListener, capture = false): void {
    this.documentListeners.push({ type, listener, capture: capture === true });
  }

  dispatch(type: string, event: unknown): void {
    for (const entry of this.documentListeners) {
      if (entry.type === type) entry.listener(event);
    }
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const found: FakeElement[] = [];
    for (const root of this.roots) {
      if (matches(root, selector)) found.push(root);
      found.push(...root.querySelectorAll(selector));
    }
    return found;
  }

  add(id: string, tagName = "div"): FakeElement {
    const node = new FakeElement(tagName);
    node.id = id;
    this.elements.set(id, node);
    this.roots.push(node);
    return node;
  }

  addRoot(node: FakeElement): FakeElement {
    this.roots.push(node);
    return node;
  }
}

function installGlobals(values: Record<string, unknown>): () => void {
  const restores: Array<() => void> = [];
  for (const [name, value] of Object.entries(values)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    restores.push(() => {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    });
  }
  return () => {
    for (const restore of restores.reverse()) restore();
  };
}

async function withDom<T>(dom: FakeDocument, task: () => T | Promise<T>): Promise<T> {
  const restore = installGlobals({
    document: dom,
    Element: FakeElement,
    HTMLButtonElement: FakeButtonElement,
  });
  try {
    return await task();
  } finally {
    restore();
  }
}

async function withCapturedConsoleError<T>(
  task: (messages: string[]) => T | Promise<T>,
): Promise<T> {
  const original = console.error;
  const messages: string[] = [];
  console.error = (...args: unknown[]) => {
    messages.push(args.map((value) => String(value)).join(" "));
  };
  try {
    return await task(messages);
  } finally {
    console.error = original;
  }
}

interface TimerCall {
  callback: () => void;
  delay: number | undefined;
}

async function withCapturedTimers<T>(task: (calls: TimerCall[]) => T | Promise<T>): Promise<T> {
  const calls: TimerCall[] = [];
  const stub = (callback: () => void, delay?: number): number => {
    calls.push({ callback, delay });
    return calls.length;
  };
  const restore = installGlobals({ setTimeout: stub });
  try {
    return await task(calls);
  } finally {
    restore();
  }
}

interface FakeUiEvent {
  target: FakeElement | null;
  key: string;
  defaultPrevented: boolean;
  preventDefault(): void;
}

function fakeEvent(target: FakeElement | null, key = ""): FakeUiEvent {
  return {
    target,
    key,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("redactUiError", () => {
  it("removes bearer tokens and API-key-shaped values before console logging", () => {
    const secret = "sk-proj-abcdefghijk123456";
    const message = redactUiError(new Error(`Authorization: Bearer ${secret}`));
    assert.equal(message.includes(secret), false);
    assert.match(message, /REDACTED/u);
  });

  it("redacts authorization headers while keeping the field name readable", () => {
    const message = redactUiError(new Error("authorization=Bearer AbCdEf.1234_xyz~value"));
    assert.equal(message, "authorization=Bearer [REDACTED]");
  });

  it("redacts standalone bearer tokens without a header prefix", () => {
    const message = redactUiError(new Error("retry failed for bearer abcdef123456"));
    assert.equal(message, "retry failed for Bearer [REDACTED]");
  });

  it("redacts sk- and sess- prefixed keys anywhere in the message", () => {
    const message = redactUiError(
      new Error("keys sk-proj-abcdefgh123 and sess-ABCDEFGH_9876 leaked"),
    );
    assert.equal(message, "keys [REDACTED] and [REDACTED] leaked");
  });

  it("redacts key-value pairs for api keys, passwords, secrets, and tokens", () => {
    const message = redactUiError(new Error(
      '{"api_key": "value-a", "password": "hunter22"} secret=deep-value token: tok_12345',
    ));
    for (const leaked of ["value-a", "hunter22", "deep-value", "tok_12345"]) {
      assert.equal(message.includes(leaked), false, `누출된 값: ${leaked}`);
    }
    assert.match(message, /"api_key": "\[REDACTED\]/u);
    assert.match(message, /password/u);
  });

  it("collapses control characters into single spaces", () => {
    const parts = ["a", String.fromCharCode(0), String.fromCharCode(1), "b", String.fromCharCode(31), "c", String.fromCharCode(127), "d"];
    assert.equal(redactUiError(new Error(parts.join(""))), "a b c d");
  });

  it("caps redacted messages at 2000 characters", () => {
    assert.equal(redactUiError(new Error("x".repeat(5000))).length, 2000);
  });

  it("stringifies non-Error inputs and falls back for nullish values", () => {
    assert.equal(redactUiError(undefined), "알 수 없는 오류");
    assert.equal(redactUiError(null), "알 수 없는 오류");
    assert.equal(redactUiError("plain failure"), "plain failure");
    assert.equal(redactUiError(0), "0");
  });
});

describe("DOM helpers", () => {
  it("element returns the registered node and throws with the id when missing", async () => {
    const dom = new FakeDocument();
    const node = dom.add("known", "input");
    await withDom(dom, () => {
      assert.equal(element("known") as unknown, node);
      assert.throws(() => element("missing"), /필수 UI 요소를 찾지 못했습니다: #missing/u);
    });
  });

  it("optionalElement returns null instead of throwing for a missing node", async () => {
    const dom = new FakeDocument();
    const node = dom.add("known");
    await withDom(dom, () => {
      assert.equal(optionalElement("known") as unknown, node);
      assert.equal(optionalElement("missing"), null);
    });
  });

  it("valueOf and checkedOf read live control state and propagate missing-element errors", async () => {
    const dom = new FakeDocument();
    dom.add("field", "input").value = "안녕";
    dom.add("flag", "input").checked = true;
    await withDom(dom, () => {
      assert.equal(valueOf("field"), "안녕");
      assert.equal(checkedOf("flag"), true);
      assert.throws(() => valueOf("missing"), /#missing/u);
      assert.throws(() => checkedOf("missing"), /#missing/u);
    });
  });

  it("numberOf parses numeric text and falls back on non-finite input", async () => {
    const dom = new FakeDocument();
    dom.add("num", "input").value = "12.5";
    dom.add("text", "input").value = "abc";
    dom.add("infinite", "input").value = "Infinity";
    await withDom(dom, () => {
      assert.equal(numberOf("num", 7), 12.5);
      assert.equal(numberOf("text", 7), 7);
      assert.equal(numberOf("infinite", 7), 7);
    });
  });

  it("setText updates text and touches the title only when provided", async () => {
    const dom = new FakeDocument();
    const label = dom.add("label", "span");
    await withDom(dom, () => {
      setText("label", "본문");
      assert.equal(label.textContent, "본문");
      assert.equal(label.getAttribute("title"), null);
      setText("label", "본문", "툴팁");
      assert.equal(label.getAttribute("title"), "툴팁");
      assert.doesNotThrow(() => setText("missing", "무시"));
    });
  });

  it("setValue stringifies numbers and setChecked toggles, both ignoring missing nodes", async () => {
    const dom = new FakeDocument();
    const input = dom.add("field", "input");
    const box = dom.add("flag", "input");
    box.checked = true;
    await withDom(dom, () => {
      setValue("field", 42);
      assert.equal(input.value, "42");
      setChecked("flag", false);
      assert.equal(box.checked, false);
      assert.doesNotThrow(() => setValue("missing", "x"));
      assert.doesNotThrow(() => setChecked("missing", true));
    });
  });
});

describe("bind", () => {
  it("silently skips a missing element", async () => {
    await withDom(new FakeDocument(), () => {
      assert.doesNotThrow(() => bind("missing", "click", () => undefined));
    });
  });

  it("delivers the event object to the listener exactly once", async () => {
    const dom = new FakeDocument();
    const button = dom.add("action", "button");
    await withDom(dom, () => {
      const seen: unknown[] = [];
      bind("action", "click", (event) => { seen.push(event); });
      const event = fakeEvent(button);
      button.emit("click", event);
      assert.deepEqual(seen, [event]);
      assert.equal(button.listenerCount("click"), 1);
    });
  });

  it("logs a redacted message when a sync listener throws", async () => {
    const dom = new FakeDocument();
    const button = dom.add("action", "button");
    await withDom(dom, () => withCapturedConsoleError((messages) => {
      bind("action", "click", () => {
        throw new Error("sync failed: api_key=sk-live-abcdef123456");
      });
      assert.doesNotThrow(() => button.emit("click", fakeEvent(button)));
      assert.equal(messages.length, 1);
      assert.match(messages[0] ?? "", /\[REDACTED\]/u);
      assert.equal(messages[0]?.includes("sk-live-abcdef123456"), false);
    }));
  });

  it("logs a redacted message when an async listener rejects", async () => {
    const dom = new FakeDocument();
    const button = dom.add("action", "button");
    await withDom(dom, () => withCapturedConsoleError(async (messages) => {
      bind("action", "click", async () => {
        throw new Error("Authorization: Bearer sess-abcdefgh12345678");
      });
      button.emit("click", fakeEvent(button));
      await flush();
      assert.equal(messages.length, 1);
      assert.match(messages[0] ?? "", /\[REDACTED\]/u);
      assert.equal(messages[0]?.includes("sess-abcdefgh12345678"), false);
    }));
  });

  it("does not log for a listener that resolves", async () => {
    const dom = new FakeDocument();
    const button = dom.add("action", "button");
    await withDom(dom, () => withCapturedConsoleError(async (messages) => {
      bind("action", "click", async () => undefined);
      button.emit("click", fakeEvent(button));
      await flush();
      assert.equal(messages.length, 0);
    }));
  });
});

describe("setupTabs", () => {
  function makeTab(id: string): FakeButtonElement {
    const tab = new FakeButtonElement();
    tab.className = "nav-tab";
    tab.dataset.tab = id;
    return tab;
  }

  function makePanel(id: string): FakeElement {
    const panel = new FakeElement("section");
    panel.className = "workflow-panel";
    panel.dataset.panel = id;
    return panel;
  }

  const dom = new FakeDocument();
  const tabCut = makeTab("cut");
  const tabSubtitle = makeTab("subtitle");
  const tabExport = makeTab("export");
  const badge = new FakeElement("span");
  const outside = new FakeElement("div");
  const panelCut = makePanel("cut");
  const panelSubtitle = makePanel("subtitle");
  const panelExport = makePanel("export");
  const strayPanel = makePanel("unknown");
  let restoreDom = (): void => undefined;

  before(() => {
    tabSubtitle.className = "nav-tab is-active";
    tabExport.append(badge);
    const nav = new FakeElement("nav");
    nav.append(tabCut, tabSubtitle, tabExport);
    dom.addRoot(nav);
    dom.addRoot(outside);
    for (const panel of [panelCut, panelSubtitle, panelExport, strayPanel]) dom.addRoot(panel);
    restoreDom = installGlobals({
      document: dom,
      Element: FakeElement,
      HTMLButtonElement: FakeButtonElement,
    });
    setupTabs();
    setupTabs();
  });

  after(() => {
    restoreDom();
  });

  it("registers capture-phase document listeners exactly once", () => {
    assert.deepEqual(
      dom.documentListeners.map((entry) => [entry.type, entry.capture]),
      [["click", true], ["keydown", true]],
    );
  });

  it("activates the pre-marked tab during initialization", () => {
    assert.equal(tabSubtitle.getAttribute("aria-selected"), "true");
    assert.equal(tabSubtitle.tabIndex, 0);
    assert.equal(tabCut.getAttribute("aria-selected"), "false");
    assert.equal(tabCut.tabIndex, -1);
    assert.equal(panelSubtitle.hidden, false);
    assert.equal(panelSubtitle.classList.contains("is-active"), true);
    assert.equal(panelCut.hidden, true);
    assert.equal(panelExport.hidden, true);
    assert.equal(strayPanel.hidden, true);
    assert.equal(strayPanel.classList.contains("is-active"), false);
  });

  it("routes clicks from nested tab content to the owning tab without moving focus", () => {
    const event = fakeEvent(badge);
    dom.dispatch("click", event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(tabExport.classList.contains("is-active"), true);
    assert.equal(tabExport.getAttribute("aria-selected"), "true");
    assert.equal(tabSubtitle.classList.contains("is-active"), false);
    assert.equal(tabSubtitle.getAttribute("aria-selected"), "false");
    assert.equal(panelExport.hidden, false);
    assert.equal(panelSubtitle.hidden, true);
    assert.equal(tabExport.focusCalls, 0);
  });

  it("ignores clicks outside any tab and non-element targets", () => {
    const outsideClick = fakeEvent(outside);
    dom.dispatch("click", outsideClick);
    assert.equal(outsideClick.defaultPrevented, false);
    const nullClick = fakeEvent(null);
    dom.dispatch("click", nullClick);
    assert.equal(nullClick.defaultPrevented, false);
    assert.equal(tabExport.classList.contains("is-active"), true);
  });

  it("moves focus with arrow keys and wraps around at both edges", () => {
    const subtitleFocus = tabSubtitle.focusCalls;
    const right = fakeEvent(tabCut, "ArrowRight");
    dom.dispatch("keydown", right);
    assert.equal(right.defaultPrevented, true);
    assert.equal(tabSubtitle.classList.contains("is-active"), true);
    assert.equal(tabSubtitle.focusCalls, subtitleFocus + 1);
    assert.equal(panelSubtitle.hidden, false);

    const cutFocus = tabCut.focusCalls;
    dom.dispatch("keydown", fakeEvent(tabExport, "ArrowRight"));
    assert.equal(tabCut.classList.contains("is-active"), true);
    assert.equal(tabCut.focusCalls, cutFocus + 1);

    const exportFocus = tabExport.focusCalls;
    dom.dispatch("keydown", fakeEvent(tabCut, "ArrowLeft"));
    assert.equal(tabExport.classList.contains("is-active"), true);
    assert.equal(tabExport.focusCalls, exportFocus + 1);
  });

  it("jumps to the first and last tab with Home and End", () => {
    dom.dispatch("keydown", fakeEvent(tabSubtitle, "Home"));
    assert.equal(tabCut.classList.contains("is-active"), true);
    assert.equal(tabCut.tabIndex, 0);
    dom.dispatch("keydown", fakeEvent(tabSubtitle, "End"));
    assert.equal(tabExport.classList.contains("is-active"), true);
    assert.equal(tabCut.tabIndex, -1);
  });

  it("ignores unrelated keys and keyboard events outside the tabs", () => {
    const enter = fakeEvent(tabCut, "Enter");
    dom.dispatch("keydown", enter);
    assert.equal(enter.defaultPrevented, false);
    const arrowOutside = fakeEvent(outside, "ArrowRight");
    dom.dispatch("keydown", arrowOutside);
    assert.equal(arrowOutside.defaultPrevented, false);
    assert.equal(tabExport.classList.contains("is-active"), true);
  });
});

describe("ActivityLog", () => {
  it("prepends entries newest-first and drops the empty placeholder", async () => {
    const dom = new FakeDocument();
    const list = dom.add("log-list", "ol");
    const empty = new FakeElement("li");
    empty.className = "log-empty";
    list.append(empty);
    await withDom(dom, () => {
      const log = new ActivityLog();
      log.add("info", "first");
      log.add("error", "second");
      assert.equal(list.querySelectorAll(".log-empty").length, 0);
      assert.equal(list.children.length, 2);
      const [latest, oldest] = list.children;
      assert.equal(latest?.className, "log-entry log-error");
      assert.equal(latest?.children[0]?.tagName, "time");
      assert.match(latest?.children[0]?.textContent ?? "", /^\d{2}:\d{2}:\d{2}$/u);
      assert.equal(latest?.children[1]?.className, "log-level");
      assert.equal(latest?.children[1]?.textContent, "ERROR");
      assert.equal(latest?.children[2]?.className, "log-message");
      assert.equal(latest?.children[2]?.textContent, "second");
      assert.equal(oldest?.children[2]?.textContent, "first");
    });
  });

  it("caps the log at 200 entries by dropping the oldest", async () => {
    const dom = new FakeDocument();
    const list = dom.add("log-list", "ol");
    await withDom(dom, () => {
      const log = new ActivityLog();
      for (let index = 1; index <= 205; index += 1) log.add("info", `entry-${index}`);
      assert.equal(list.children.length, 200);
      assert.equal(list.children[0]?.children[2]?.textContent, "entry-205");
      assert.equal(list.lastElementChild?.children[2]?.textContent, "entry-6");
    });
  });

  it("clear resets the list to the empty placeholder", async () => {
    const dom = new FakeDocument();
    const list = dom.add("log-list", "ol");
    await withDom(dom, () => {
      const log = new ActivityLog();
      log.add("warning", "old");
      log.clear();
      assert.equal(list.children.length, 1);
      assert.equal(list.children[0]?.className, "log-empty");
      assert.equal(list.children[0]?.textContent, "기록된 작업이 없습니다.");
    });
  });

  it("stays inert when the target list is missing", async () => {
    await withDom(new FakeDocument(), () => {
      const log = new ActivityLog("absent-log");
      assert.doesNotThrow(() => log.add("info", "무시"));
      assert.doesNotThrow(() => log.clear());
    });
  });
});

describe("BusyState", () => {
  it("keeps the overlay visible until every nested task finishes", async () => {
    const dom = new FakeDocument();
    const overlay = dom.add("busy-overlay");
    overlay.hidden = true;
    const message = dom.add("busy-message", "p");
    await withDom(dom, () => {
      const busy = new BusyState();
      busy.show("컷 분석 중");
      assert.equal(overlay.hidden, false);
      assert.equal(message.textContent, "컷 분석 중");
      busy.show("자막 정리 중");
      assert.equal(message.textContent, "자막 정리 중");
      busy.hide();
      assert.equal(overlay.hidden, false);
      busy.hide();
      assert.equal(overlay.hidden, true);
    });
  });

  it("clamps extra hide calls so the next show still works", async () => {
    const dom = new FakeDocument();
    const overlay = dom.add("busy-overlay");
    overlay.hidden = true;
    dom.add("busy-message", "p");
    await withDom(dom, () => {
      const busy = new BusyState();
      busy.hide();
      busy.hide();
      busy.show("한 번");
      assert.equal(overlay.hidden, false);
      busy.hide();
      assert.equal(overlay.hidden, true);
    });
  });

  it("during resolves the task value and hides the overlay even on rejection", async () => {
    const dom = new FakeDocument();
    const overlay = dom.add("busy-overlay");
    overlay.hidden = true;
    dom.add("busy-message", "p");
    await withDom(dom, async () => {
      const busy = new BusyState();
      const result = await busy.during("작업", async () => {
        assert.equal(overlay.hidden, false);
        return 42;
      });
      assert.equal(result, 42);
      assert.equal(overlay.hidden, true);
      await assert.rejects(
        busy.during("실패 작업", async () => {
          throw new Error("boom");
        }),
        /boom/u,
      );
      assert.equal(overlay.hidden, true);
    });
  });

  it("operates without overlay elements", async () => {
    await withDom(new FakeDocument(), async () => {
      const busy = new BusyState();
      assert.doesNotThrow(() => busy.show("메시지"));
      assert.doesNotThrow(() => busy.hide());
      assert.equal(await busy.during("작업", async () => "ok"), "ok");
    });
  });
});

describe("toast", () => {
  it("appends a status toast and removes it after the default timeout", async () => {
    const dom = new FakeDocument();
    const region = dom.add("toast-region");
    await withDom(dom, () => withCapturedTimers((timers) => {
      toast("저장 완료");
      assert.equal(region.children.length, 1);
      const item = region.children[0];
      assert.equal(item?.className, "toast toast-info");
      assert.equal(item?.getAttribute("role"), "status");
      assert.equal(item?.textContent, "저장 완료");
      assert.equal(timers[0]?.delay, 3200);
      timers[0]?.callback();
      assert.equal(region.children.length, 0);
    }));
  });

  it("marks error toasts as alerts and honors a custom timeout", async () => {
    const dom = new FakeDocument();
    const region = dom.add("toast-region");
    await withDom(dom, () => withCapturedTimers((timers) => {
      toast("실패", "error", 500);
      assert.equal(region.children[0]?.className, "toast toast-error");
      assert.equal(region.children[0]?.getAttribute("role"), "alert");
      assert.equal(timers[0]?.delay, 500);
    }));
  });

  it("does nothing without a toast region", async () => {
    await withDom(new FakeDocument(), () => withCapturedTimers((timers) => {
      assert.doesNotThrow(() => toast("무시"));
      assert.equal(timers.length, 0);
    }));
  });
});

describe("clearChildren", () => {
  it("removes every child through removeChild when available", () => {
    const target = new FakeElement("div");
    target.append(new FakeElement("span"), new FakeElement("span"), new FakeElement("p"));
    clearChildren(target as unknown as HTMLElement);
    assert.equal(target.children.length, 0);
  });

  it("falls back to replaceChildren for hosts without removeChild", () => {
    const calls: string[] = [];
    const target = {
      removeChild: undefined,
      firstChild: null,
      replaceChildren: () => {
        calls.push("replaceChildren");
      },
    } as unknown as HTMLElement;
    clearChildren(target);
    assert.deepEqual(calls, ["replaceChildren"]);
  });
});

describe("renderEmptyState", () => {
  it("replaces stale children with an icon, title, and detail", async () => {
    const dom = new FakeDocument();
    const target = dom.add("panel");
    target.append(new FakeElement("div"), new FakeElement("div"));
    await withDom(dom, () => {
      renderEmptyState(target as unknown as HTMLElement, "비어 있음", "가이드 문구");
      assert.equal(target.children.length, 1);
      const wrapper = target.children[0];
      assert.equal(wrapper?.className, "empty-state compact-empty-state");
      assert.equal(wrapper?.children.length, 3);
      assert.equal(wrapper?.children[0]?.getAttribute("aria-hidden"), "true");
      assert.equal(wrapper?.children[0]?.textContent, "◇");
      assert.equal(wrapper?.children[1]?.tagName, "strong");
      assert.equal(wrapper?.children[1]?.textContent, "비어 있음");
      assert.equal(wrapper?.children[2]?.tagName, "p");
      assert.equal(wrapper?.children[2]?.textContent, "가이드 문구");
    });
  });

  it("omits the detail paragraph when detail is empty", async () => {
    const dom = new FakeDocument();
    const target = dom.add("panel");
    await withDom(dom, () => {
      renderEmptyState(target as unknown as HTMLElement, "제목만");
      assert.equal(target.children[0]?.children.length, 2);
    });
  });
});
