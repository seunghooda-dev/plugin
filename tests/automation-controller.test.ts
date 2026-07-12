import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PunchCue } from "../src/automation";
import { AutomationController, type AutomationTranscript } from "../src/automation-controller";

type Listener = (event: Event) => void;

class FakeClassList {
  constructor(private readonly owner: FakeElement) {}

  toggle(token: string, force?: boolean): boolean {
    const values = new Set(this.owner.className.split(/\s+/u).filter(Boolean));
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
  textContent = "";
  className = "";
  readonly children: FakeElement[] = [];
  readonly classList = new FakeClassList(this);
  private readonly listeners = new Map<string, Listener[]>();

  constructor(readonly tagName: string) {}

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...nodes);
  }

  querySelectorAll<T extends FakeElement>(selector: string): T[] {
    const matches: FakeElement[] = [];
    const visit = (element: FakeElement): void => {
      for (const child of element.children) {
        if (selector === child.tagName.toLowerCase()) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches as T[];
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ type } as Event);
  }
}

class FakeDocument {
  readonly elements = new Map<string, FakeElement>();

  getElementById(id: string): FakeElement | null {
    return this.elements.get(id) ?? null;
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }

  add(id: string, tagName = "input", value = "", checked = false): FakeElement {
    const element = new FakeElement(tagName);
    element.id = id;
    element.value = value;
    element.checked = checked;
    this.elements.set(id, element);
    return element;
  }
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

function controllerDom(): FakeDocument {
  const dom = new FakeDocument();
  dom.add("automation-stt-status", "p");
  dom.add("auto-analyze-btn", "button");
  dom.add("auto-markers-btn", "button").disabled = true;
  dom.add("auto-apply-btn", "button").disabled = true;
  dom.add("auto-min-silence-input", "input", "0.42");
  dom.add("auto-padding-input", "input", "0.08");
  dom.add("auto-punch-scale-input", "input", "112");
  dom.add("auto-punch-count-input", "input", "12");
  dom.add("auto-keywords-input", "input", "중요");
  dom.add("auto-trim-leading-checkbox", "input", "", true);
  dom.add("auto-trim-trailing-checkbox", "input", "", true);
  dom.add("auto-punch-checkbox", "input", "", true);
  const summary = dom.add("auto-plan-summary", "div");
  summary.append(new FakeElement("strong"), new FakeElement("strong"), new FakeElement("strong"));
  dom.add("auto-cut-list", "div");
  dom.add("safe-check-btn", "button");
  dom.add("safe-align-btn", "button");
  dom.add("safe-overlay-btn", "button");
  dom.add("safe-platform-select", "select", "youtube-shorts");
  dom.add("safe-role-select", "select", "content");
  dom.add("safe-box-x-input", "input", "20");
  dom.add("safe-box-y-input", "input", "55");
  dom.add("safe-box-width-input", "input", "60");
  dom.add("safe-box-height-input", "input", "12");
  dom.add("safe-zone-result", "div");
  return dom;
}

function transcript(name = "Transcript A"): AutomationTranscript {
  return {
    name,
    duration: 4,
    segments: [
      { start: 0.5, end: 1.2, text: "첫 번째 발화" },
      { start: 2.4, end: 3.2, text: "중요한 두 번째 발화!" },
    ],
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function waitUntil(predicate: () => boolean, attempts = 50): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await settle();
  }
  assert.fail("condition was not reached");
}

async function withFakeDocument<T>(dom: FakeDocument, task: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: dom });
  try {
    return await task();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "document", descriptor);
    else delete (globalThis as { document?: unknown }).document;
  }
}

describe("AutomationController transcript and busy safety", () => {
  it("invalidates a stale plan on transcript changes but keeps it for identical refreshes", async () => {
    const dom = controllerDom();
    let current = transcript();
    await withFakeDocument(dom, async () => {
      const controller = new AutomationController({ getTranscript: () => current });
      await controller.initialize();
      dom.getElementById("auto-analyze-btn")!.emit("click");
      await settle();
      assert.ok(controller.plan);
      assert.equal(dom.getElementById("auto-apply-btn")?.disabled, false);

      current = transcript("Transcript B");
      controller.setTranscript(current);
      assert.equal(controller.plan, null);
      assert.deepEqual(controller.cues, []);
      assert.equal(dom.getElementById("auto-markers-btn")?.disabled, true);
      assert.equal(dom.getElementById("auto-apply-btn")?.disabled, true);

      dom.getElementById("auto-analyze-btn")!.emit("click");
      await settle();
      const samePlan = controller.plan;
      controller.setTranscript({ ...current, segments: current.segments.map((segment) => ({ ...segment })) });
      assert.equal(controller.plan, samePlan);
      assert.equal(dom.getElementById("auto-apply-btn")?.disabled, false);
    });
  });

  it("binds the analyzed plan to effective cut and punch settings", async () => {
    const dom = controllerDom();
    const errors: string[] = [];
    let markerCalls = 0;
    await withFakeDocument(dom, async () => {
      const controller = new AutomationController({
        getTranscript: () => transcript(),
        getSourceContextKey: () => "ctx-project-A",
        onAddMarkers: () => { markerCalls += 1; },
        onError: (error, context) => errors.push(`${context}: ${error instanceof Error ? error.message : String(error)}`),
      });
      await controller.initialize();
      dom.getElementById("auto-analyze-btn")!.emit("click");
      await settle();
      assert.ok(controller.plan);
      assert.equal(controller.analysisGuard?.sourceContextKey, "ctx-project-A");

      const minSilence = dom.getElementById("auto-min-silence-input")!;
      minSilence.value = "0.8";
      minSilence.emit("input");
      assert.equal(controller.plan, null);
      assert.equal(controller.analysisGuard, null);
      assert.equal(dom.getElementById("auto-apply-btn")?.disabled, true);
      assert.match(dom.getElementById("auto-cut-list")?.children[0]?.textContent ?? "", /다시 분석/u);

      dom.getElementById("auto-markers-btn")!.emit("click");
      await settle();
      assert.equal(markerCalls, 0);
      assert.match(errors.at(-1) ?? "", /설정.*다시 분석/u);

      dom.getElementById("auto-analyze-btn")!.emit("click");
      await settle();
      assert.ok(controller.plan);
      dom.getElementById("auto-punch-scale-input")!.value = "125";
      dom.getElementById("auto-markers-btn")!.emit("click");
      await settle();
      assert.equal(markerCalls, 0);
      assert.equal(controller.plan, null);
      assert.match(errors.at(-1) ?? "", /context.*다시 분석/u);
    });
  });

  it("passes an opaque analysis guard and blocks a changed Premiere context", async () => {
    const dom = controllerDom();
    let contextKey = "ctx-project-A";
    let markerGuard = "";
    let applyCalls = 0;
    const errors: string[] = [];
    await withFakeDocument(dom, async () => {
      const controller = new AutomationController({
        getTranscript: () => transcript(),
        getSourceContextKey: () => contextKey,
        onAddMarkers: (_plan, _cues, guard) => { markerGuard = `${guard.sourceContextKey}:${guard.fingerprint}`; },
        onApply: () => { applyCalls += 1; },
        onError: (error, context) => errors.push(`${context}: ${error instanceof Error ? error.message : String(error)}`),
      });
      await controller.initialize();
      dom.getElementById("auto-analyze-btn")!.emit("click");
      await settle();
      const analyzed = controller.analysisGuard;
      assert.ok(analyzed);
      assert.match(analyzed?.fingerprint ?? "", /^auto_v1_/u);

      dom.getElementById("auto-markers-btn")!.emit("click");
      await settle();
      assert.equal(markerGuard, `ctx-project-A:${analyzed?.fingerprint}`);

      contextKey = "ctx-project-B";
      dom.getElementById("auto-apply-btn")!.emit("click");
      await settle();
      assert.equal(applyCalls, 0);
      assert.equal(controller.plan, null);
      assert.equal(controller.analysisGuard, null);
      assert.match(errors.at(-1) ?? "", /활성 Premiere context.*다시 분석/u);
    });
  });

  it("drops an apply when the transcript changes while context validation is pending", async () => {
    const dom = controllerDom();
    const pendingContext = deferred<string>();
    let contextReads = 0;
    let applyCalls = 0;
    const errors: string[] = [];
    await withFakeDocument(dom, async () => {
      const controller = new AutomationController({
        getTranscript: () => transcript(),
        getSourceContextKey: () => {
          contextReads += 1;
          return contextReads === 1 ? "ctx-project-A" : pendingContext.promise;
        },
        onApply: () => { applyCalls += 1; },
        onError: (error, context) => errors.push(`${context}: ${error instanceof Error ? error.message : String(error)}`),
      });
      await controller.initialize();
      dom.getElementById("auto-analyze-btn")!.emit("click");
      await settle();
      assert.ok(controller.plan);

      dom.getElementById("auto-apply-btn")!.emit("click");
      await waitUntil(() => contextReads === 2);
      assert.equal(controller.isBusy, true);
      controller.setTranscript(transcript("Transcript B"));
      pendingContext.resolve("ctx-project-A");
      await settle();
      assert.equal(applyCalls, 0);
      assert.equal(controller.plan, null);
      assert.equal(controller.isBusy, false);
      assert.match(errors.at(-1) ?? "", /STT.*다시 분석/u);
    });
  });

  it("does not mutate on context cancellation and allows a guarded retry", async () => {
    const dom = controllerDom();
    let cancelValidation = false;
    let markerCalls = 0;
    const errors: string[] = [];
    await withFakeDocument(dom, async () => {
      const controller = new AutomationController({
        getTranscript: () => transcript(),
        getSourceContextKey: () => cancelValidation
          ? Promise.reject(new Error("context validation cancelled"))
          : "ctx-project-A",
        onAddMarkers: () => { markerCalls += 1; },
        onError: (error, context) => errors.push(`${context}: ${error instanceof Error ? error.message : String(error)}`),
      });
      await controller.initialize();
      dom.getElementById("auto-analyze-btn")!.emit("click");
      await settle();
      const plan = controller.plan;
      cancelValidation = true;
      dom.getElementById("auto-markers-btn")!.emit("click");
      await settle();
      assert.equal(markerCalls, 0);
      assert.equal(controller.plan, plan);
      assert.equal(controller.isBusy, false);
      assert.match(errors.at(-1) ?? "", /cancelled/u);

      cancelValidation = false;
      dom.getElementById("auto-markers-btn")!.emit("click");
      await settle();
      assert.equal(markerCalls, 1);
      assert.equal(controller.plan, plan);
    });
  });

  it("does not discard an analyzed SRT fallback when a later transcript poll is temporarily empty", async () => {
    const dom = controllerDom();
    let current: AutomationTranscript | null = transcript("Subtitle fallback");
    let applyCalls = 0;
    await withFakeDocument(dom, async () => {
      const controller = new AutomationController({
        getTranscript: () => current,
        getSourceContextKey: () => "ctx-project-A",
        onApply: () => { applyCalls += 1; },
      });
      await controller.initialize();
      dom.getElementById("auto-analyze-btn")!.emit("click");
      await settle();
      assert.ok(controller.plan);
      assert.equal(dom.getElementById("auto-apply-btn")?.disabled, false);

      current = null;
      dom.getElementById("auto-apply-btn")!.emit("click");
      await settle();
      assert.equal(applyCalls, 1);
      assert.ok(controller.plan);
    });
  });

  it("passes host mutation callbacks isolated snapshots of the analyzed plan and cues", async () => {
    const dom = controllerDom();
    let receivedCutCount = 0;
    let receivedCueScale = 0;
    await withFakeDocument(dom, async () => {
      const controller = new AutomationController({
        getTranscript: () => transcript(),
        getSourceContextKey: () => "ctx-project-A",
        onAddMarkers: (plan, cues) => {
          receivedCutCount = plan.cuts.length;
          receivedCueScale = cues[0]?.scale ?? 0;
          plan.cuts.length = 0;
          plan.keeps.length = 0;
          (cues as PunchCue[]).forEach((cue) => {
            cue.scale = 150;
            cue.reason = "host mutation side effect";
          });
        },
      });
      await controller.initialize();
      dom.getElementById("auto-analyze-btn")!.emit("click");
      await settle();
      const storedCutCount = controller.plan?.cuts.length ?? 0;
      const storedKeepCount = controller.plan?.keeps.length ?? 0;
      const storedCueScale = controller.cues[0]?.scale ?? 0;
      assert.ok(storedCutCount > 0);
      assert.ok(storedKeepCount > 0);
      assert.ok(storedCueScale > 0);

      dom.getElementById("auto-markers-btn")!.emit("click");
      await settle();
      assert.equal(receivedCutCount, storedCutCount);
      assert.equal(receivedCueScale, storedCueScale);
      assert.equal(controller.plan?.cuts.length, storedCutCount);
      assert.equal(controller.plan?.keeps.length, storedKeepCount);
      assert.equal(controller.cues[0]?.scale, storedCueScale);
      assert.notEqual(controller.cues[0]?.reason, "host mutation side effect");
    });
  });

  it("drops an analysis if settings change while source context validation is pending", async () => {
    const dom = controllerDom();
    const pendingContext = deferred<string>();
    let contextReads = 0;
    const errors: string[] = [];
    await withFakeDocument(dom, async () => {
      const controller = new AutomationController({
        getTranscript: () => transcript(),
        getSourceContextKey: () => {
          contextReads += 1;
          return pendingContext.promise;
        },
        onError: (error, context) => errors.push(`${context}: ${error instanceof Error ? error.message : String(error)}`),
      });
      await controller.initialize();
      dom.getElementById("auto-analyze-btn")!.emit("click");
      await waitUntil(() => contextReads === 1);
      dom.getElementById("auto-padding-input")!.value = "0.25";
      dom.getElementById("auto-padding-input")!.emit("input");
      pendingContext.resolve("ctx-project-A");
      await settle();
      assert.equal(controller.plan, null);
      assert.equal(controller.analysisGuard, null);
      assert.equal(dom.getElementById("auto-apply-btn")?.disabled, true);
      assert.match(errors.at(-1) ?? "", /원고·설정.*context.*다시 분석/u);
    });
  });

  it("rejects malformed source context keys before host mutation callbacks run", async () => {
    const dom = controllerDom();
    let contextKey = "ctx-project-A";
    let markerCalls = 0;
    const errors: string[] = [];
    await withFakeDocument(dom, async () => {
      const controller = new AutomationController({
        getTranscript: () => transcript(),
        getSourceContextKey: () => contextKey,
        onAddMarkers: () => { markerCalls += 1; },
        onError: (error, context) => errors.push(`${context}: ${error instanceof Error ? error.message : String(error)}`),
      });
      await controller.initialize();
      dom.getElementById("auto-analyze-btn")!.emit("click");
      await settle();
      assert.ok(controller.plan);

      contextKey = "ctx-project-A\u0000bad";
      dom.getElementById("auto-markers-btn")!.emit("click");
      await settle();
      assert.equal(markerCalls, 0);
      assert.ok(controller.plan);
      assert.match(errors.at(-1) ?? "", /context key.*올바르지/u);
    });
  });

  it("blocks duplicate analyze, marker, and apply actions and restores controls after failure", async () => {
    const dom = controllerDom();
    const source = transcript();
    const analysisRead = deferred<AutomationTranscript | null>();
    const markerRun = deferred<void>();
    let applyRun = deferred<void>();
    let readPending = false;
    let markerCalls = 0;
    let applyCalls = 0;
    const errors: string[] = [];

    await withFakeDocument(dom, async () => {
      const controller = new AutomationController({
        getTranscript: () => readPending ? analysisRead.promise : source,
        onAddMarkers: () => {
          markerCalls += 1;
          return markerRun.promise;
        },
        onApply: () => {
          applyCalls += 1;
          return applyRun.promise;
        },
        onError: (error, context) => errors.push(`${context}: ${error instanceof Error ? error.message : String(error)}`),
      });
      await controller.initialize();

      readPending = true;
      dom.getElementById("auto-analyze-btn")!.emit("click");
      dom.getElementById("auto-analyze-btn")!.emit("click");
      assert.equal(controller.isBusy, true);
      assert.match(errors.at(-1) ?? "", /자동 편집 분석.*이미 진행 중/u);
      analysisRead.resolve(source);
      await settle();
      readPending = false;
      assert.ok(controller.plan);
      assert.equal(controller.isBusy, false);

      dom.getElementById("auto-markers-btn")!.emit("click");
      dom.getElementById("auto-markers-btn")!.emit("click");
      await waitUntil(() => markerCalls === 1);
      assert.equal(markerCalls, 1);
      markerRun.resolve();
      await settle();
      assert.equal(controller.isBusy, false);
      assert.equal(dom.getElementById("auto-markers-btn")?.disabled, false);

      dom.getElementById("auto-apply-btn")!.emit("click");
      dom.getElementById("auto-apply-btn")!.emit("click");
      await waitUntil(() => applyCalls === 1);
      assert.equal(applyCalls, 1);
      assert.equal(dom.getElementById("auto-apply-btn")?.disabled, true);
      applyRun.resolve();
      await settle();
      assert.equal(controller.isBusy, false);
      assert.equal(dom.getElementById("auto-apply-btn")?.disabled, false);

      applyRun = deferred<void>();
      dom.getElementById("auto-apply-btn")!.emit("click");
      applyRun.reject(new Error("clone failed"));
      await settle();
      assert.equal(controller.isBusy, false);
      assert.equal(dom.getElementById("auto-apply-btn")?.disabled, false);
      assert.match(errors.at(-1) ?? "", /자동 편집 적용 실패: clone failed/u);
    });
  });

  it("shares one operation gate with Safe Zone actions and reports partial alignment accurately", async () => {
    const dom = controllerDom();
    dom.getElementById("safe-box-x-input")!.value = "90";
    const overlay = deferred<void>();
    let overlayCalls = 0;
    let alignCalls = 0;
    const activities: string[] = [];
    const errors: string[] = [];
    await withFakeDocument(dom, async () => {
      const controller = new AutomationController({
        onCreateSafeOverlay: () => {
          overlayCalls += 1;
          return overlay.promise;
        },
        onAlignSafeZone: () => {
          alignCalls += 1;
          return { selected: 3, changed: 1, skipped: 2, warnings: ["keyed"] };
        },
        onActivity: (message) => activities.push(message),
        onError: (error, context) => errors.push(`${context}: ${error instanceof Error ? error.message : String(error)}`),
      });
      await controller.initialize();

      dom.getElementById("safe-overlay-btn")!.emit("click");
      dom.getElementById("safe-overlay-btn")!.emit("click");
      dom.getElementById("safe-align-btn")!.emit("click");
      assert.equal(overlayCalls, 1);
      assert.equal(alignCalls, 0);
      assert.equal(controller.isBusy, true);
      assert.equal(dom.getElementById("safe-check-btn")?.disabled, true);
      assert.match(errors.at(-1) ?? "", /이미 진행 중/u);
      overlay.resolve();
      await settle();
      assert.equal(controller.isBusy, false);
      assert.equal(dom.getElementById("safe-overlay-btn")?.disabled, false);
      assert.match(activities.at(-1) ?? "", /YouTube Shorts.*2026-conservative.*보수적 가이드.*내보내기 전.*삭제/u);

      dom.getElementById("safe-align-btn")!.emit("click");
      await settle();
      assert.equal(alignCalls, 1);
      assert.match(activities.at(-1) ?? "", /부분 적용.*선택 3개.*변경 1개.*건너뜀 2개/u);
    });
  });
});
