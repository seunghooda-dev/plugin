/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AIQueueController } from "../src/ai-queue-controller";
import {
  JOB_QUEUE_STORAGE_KEY,
  JobQueueError,
  type JobQueueStorage,
} from "../src/job-queue";

type FakeListener = (event: unknown) => unknown;

class FakeElement {
  id = "";
  value = "";
  textContent = "";
  className = "";
  type = "";
  private readonly listeners = new Map<string, Set<FakeListener>>();
  private readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];

  constructor(readonly tagName: string) {}

  addEventListener(type: string, listener: FakeListener): void {
    const listeners = this.listeners.get(type) ?? new Set<FakeListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children.splice(0);
    this.append(...nodes);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  emit(type: string): void {
    this.listeners.get(type)?.forEach((listener) => listener({}));
  }
}

class FakeDocument {
  private readonly elements = new Map<string, FakeElement>();

  add(id: string, tagName: string, value = ""): FakeElement {
    const node = new FakeElement(tagName);
    node.id = id;
    node.value = value;
    this.elements.set(id, node);
    return node;
  }

  getElementById(id: string): FakeElement | null {
    return this.elements.get(id) ?? null;
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }
}

function queueDom(): FakeDocument {
  const dom = new FakeDocument();
  dom.add("ai-queue-save-btn", "button");
  dom.add("ai-queue-pause-btn", "button");
  dom.add("ai-cache-clear-btn", "button");
  dom.add("ai-queue-concurrency-input", "input");
  dom.add("ai-request-limit-input", "input");
  dom.add("ai-cost-limit-input", "input");
  dom.add("ai-confirm-threshold-input", "input");
  dom.add("ai-queue-usage", "span");
  dom.add("ai-cache-count", "span");
  dom.add("ai-job-list", "div");
  return dom;
}

async function withDocument<T>(dom: FakeDocument, task: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: dom });
  try {
    return await task();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, "document", descriptor);
    else delete (globalThis as { document?: unknown }).document;
  }
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function waitUntil(predicate: () => boolean, attempts = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await settle();
  }
  assert.fail("condition was not reached");
}

function privateHandlers(controller: AIQueueController): Map<string, unknown> {
  return (controller as unknown as { handlers: Map<string, unknown> }).handlers;
}

class MemoryJobStorage implements JobQueueStorage {
  readonly values = new Map<string, string>();
  failRead = false;
  failWrite = false;

  getItem(key: string): string | null {
    if (this.failRead) throw new Error("storage read denied");
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrite) throw new Error("storage write denied");
    this.values.set(key, value);
  }
}

describe("AIQueueController run() dedupe and cache", () => {
  it("does not replace the executor of an already deduplicated active job", async () => {
    const controller = new AIQueueController();
    let firstCalls = 0;
    let secondCalls = 0;
    const first = controller.run("text", { id: 1 }, async () => {
      firstCalls += 1;
      return "first";
    });
    const second = controller.run("text", { id: 1 }, async () => {
      secondCalls += 1;
      return "second";
    });
    assert.equal(await first, "first");
    assert.equal(await second, "first");
    assert.equal(firstCalls, 1);
    assert.equal(secondCalls, 0);
  });

  it("runs descriptors with different content hashes independently", async () => {
    const controller = new AIQueueController();
    const first = controller.run("text", { id: 1 }, async () => "one");
    const second = controller.run("text", { id: 2 }, async () => "two");
    assert.equal(await first, "one");
    assert.equal(await second, "two");
    assert.equal(controller.queue.list().length, 2);
  });

  it("re-executes the same descriptor after the previous job completed", async () => {
    const controller = new AIQueueController();
    let calls = 0;
    const first = await controller.run("text", { id: "repeat" }, async () => {
      calls += 1;
      return `run-${calls}`;
    });
    const second = await controller.run("text", { id: "repeat" }, async () => {
      calls += 1;
      return `run-${calls}`;
    });
    assert.equal(first, "run-1");
    assert.equal(second, "run-2");
    assert.equal(calls, 2);
  });

  it("serves a repeated descriptor from cache without re-running the handler", async () => {
    const controller = new AIQueueController();
    let calls = 0;
    const first = await controller.run("image", { id: "cached" }, async () => {
      calls += 1;
      return "png-bytes";
    }, { cacheTtlMs: 60_000 });
    const second = await controller.run("image", { id: "cached" }, async () => {
      calls += 1;
      return "should-not-run";
    }, { cacheTtlMs: 60_000 });
    assert.equal(first, "png-bytes");
    assert.equal(second, "png-bytes");
    assert.equal(calls, 1);
    const cachedJob = controller.queue.list().find((job) => job.fromCache);
    assert.equal(cachedJob?.state, "succeeded");
    assert.equal(controller.queue.getCacheMetadata().length, 1);
  });
});

describe("AIQueueController confirmation and budget", () => {
  it("holds a confirmRequired job until the queue approves it", async () => {
    const controller = new AIQueueController();
    let calls = 0;
    const promise = controller.run("tts", { id: "confirm" }, async () => {
      calls += 1;
      return "approved";
    }, { confirmRequired: true });
    await settle();
    const job = controller.queue.list()[0];
    assert.ok(job);
    assert.equal(job.state, "queued");
    assert.equal(job.confirmRequired, true);
    assert.equal(job.confirmed, false);
    assert.equal(calls, 0);
    controller.queue.confirm(job.id);
    assert.equal(await promise, "approved");
    assert.equal(calls, 1);
  });

  it("auto-requires confirmation when estimateUnits exceed the 10-unit threshold", async () => {
    const controller = new AIQueueController();
    const promise = controller.run("image", { id: "expensive" }, async () => "done", {
      estimateUnits: 11,
    });
    await settle();
    const job = controller.queue.list()[0];
    assert.ok(job);
    assert.equal(job.confirmRequired, true);
    assert.equal(job.confirmed, false);
    controller.queue.confirm(job.id);
    assert.equal(await promise, "done");
  });

  it("fails a confirmed job that exceeds the daily cost budget without running it", async () => {
    const controller = new AIQueueController();
    let calls = 0;
    const promise = controller.run("video", { id: "over-budget" }, async () => {
      calls += 1;
      return "never";
    }, { estimateUnits: 150 });
    await settle();
    const job = controller.queue.list()[0];
    assert.ok(job);
    assert.equal(job.confirmRequired, true, "150 units must exceed the 10-unit threshold");
    controller.queue.confirm(job.id);
    await assert.rejects(promise, /비용 단위 한도/u);
    assert.equal(calls, 0);
  });
});

describe("AIQueueController cancel, retry, and failure surfacing", () => {
  it("rejects a joined run with CANCELLED and aborts the handler signal", async () => {
    const controller = new AIQueueController();
    let signal: AbortSignal | undefined;
    const promise = controller.run("video", { id: "cancel-me" }, async (context) => {
      signal = context.signal;
      await new Promise(() => undefined);
      return "never";
    });
    await waitUntil(() => controller.queue.list()[0]?.state === "running");
    const job = controller.queue.list()[0];
    assert.ok(job);
    assert.equal(controller.queue.cancel(job.id), true);
    await assert.rejects(promise, (error: unknown) => {
      assert.ok(error instanceof JobQueueError);
      assert.equal(error.code, "CANCELLED");
      return true;
    });
    assert.equal(signal?.aborted, true);
  });

  it("retries a transient failure and resolves on the second attempt", async () => {
    const controller = new AIQueueController();
    const attempts: number[] = [];
    const value = await controller.run("stt", { id: "retry" }, async (context) => {
      attempts.push(context.attempt);
      if (context.attempt === 1) {
        throw Object.assign(new Error("first attempt failed"), { retryable: true });
      }
      return "second-attempt";
    });
    assert.equal(value, "second-attempt");
    assert.deepEqual(attempts, [1, 2]);
  });

  it("surfaces a non-transient failure with secrets redacted from the message", async () => {
    const controller = new AIQueueController();
    await assert.rejects(
      controller.run("text", { id: "fail" }, async () => {
        throw new Error("boom apiKey=sk-verySecretKey12345 done");
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /\[REDACTED\]/u);
        assert.doesNotMatch(error.message, /sk-verySecretKey12345/u);
        return true;
      },
    );
  });

  it("removes the pending handler and enqueues nothing when enqueue rejects the job", async () => {
    const controller = new AIQueueController();
    let calls = 0;
    await assert.rejects(
      controller.run("text", undefined, async () => {
        calls += 1;
        return "never";
      }),
      (error: unknown) => {
        assert.ok(error instanceof JobQueueError);
        assert.equal(error.code, "INVALID_JOB");
        return true;
      },
    );
    assert.equal(calls, 0);
    assert.equal(controller.queue.list().length, 0);
    assert.equal(privateHandlers(controller).size, 0, "enqueue failure must not leak the handler");
  });
});

describe("AIQueueController DOM integration", () => {
  it("initialize syncs budget controls and renders the empty state", async () => {
    const dom = queueDom();
    await withDocument(dom, async () => {
      const controller = new AIQueueController();
      await controller.initialize();
      assert.equal(dom.getElementById("ai-queue-concurrency-input")?.value, "2");
      assert.equal(dom.getElementById("ai-request-limit-input")?.value, "100");
      assert.equal(dom.getElementById("ai-cost-limit-input")?.value, "100");
      assert.equal(dom.getElementById("ai-confirm-threshold-input")?.value, "10");
      assert.equal(dom.getElementById("ai-queue-usage")?.textContent, "0 / 100회 · 0.0 / 100단위");
      assert.equal(dom.getElementById("ai-cache-count")?.textContent, "0개");
      assert.equal(dom.getElementById("ai-queue-pause-btn")?.textContent, "큐 일시정지");
      const list = dom.getElementById("ai-job-list");
      assert.equal(list?.children.length, 1);
      assert.equal(list?.children[0]?.textContent, "대기 중이거나 최근 실행한 AI 작업이 없습니다.");
    });
  });

  it("applies the saved concurrency and budget and emits budget-updated", async () => {
    const dom = queueDom();
    await withDocument(dom, async () => {
      const activities: string[] = [];
      const controller = new AIQueueController({ onActivity: (message) => activities.push(message) });
      await controller.initialize();
      const events: string[] = [];
      controller.queue.subscribe((event) => events.push(event.type));
      dom.getElementById("ai-queue-concurrency-input")!.value = "3";
      dom.getElementById("ai-request-limit-input")!.value = "5";
      dom.getElementById("ai-cost-limit-input")!.value = "50";
      dom.getElementById("ai-confirm-threshold-input")!.value = "2";
      dom.getElementById("ai-queue-save-btn")!.emit("click");
      assert.equal(controller.queue.currentConcurrency, 3);
      assert.deepEqual(controller.queue.getBudget(), {
        requestLimit: 5,
        costLimitUnits: 50,
        confirmationThresholdUnits: 2,
      });
      assert.ok(events.includes("budget-updated"));
      assert.ok(activities.some((message) => message.includes("일일 한도를 저장")));
      assert.equal(dom.getElementById("ai-queue-usage")?.textContent, "0 / 5회 · 0.0 / 50단위");
    });
  });

  it("toggles queue pause state and button label from the pause control", async () => {
    const dom = queueDom();
    await withDocument(dom, async () => {
      const controller = new AIQueueController();
      await controller.initialize();
      const pause = dom.getElementById("ai-queue-pause-btn")!;
      pause.emit("click");
      assert.equal(controller.queue.isPaused, true);
      assert.equal(pause.textContent, "큐 재개");
      pause.emit("click");
      assert.equal(controller.queue.isPaused, false);
      assert.equal(pause.textContent, "큐 일시정지");
    });
  });

  it("renders an approval button for confirm-required jobs and approving runs the job", async () => {
    const dom = queueDom();
    await withDocument(dom, async () => {
      const controller = new AIQueueController();
      await controller.initialize();
      let calls = 0;
      const promise = controller.run("image", { id: "confirm-ui" }, async () => {
        calls += 1;
        return "approved";
      }, { confirmRequired: true });
      await settle();
      const row = dom.getElementById("ai-job-list")!.children[0];
      assert.ok(row);
      assert.equal(row.children[0]?.children[0]?.textContent, "이미지 · 승인 대기");
      const approve = row.children[1];
      assert.ok(approve);
      assert.equal(approve.textContent, "승인");
      assert.equal(calls, 0);
      approve.emit("click");
      assert.equal(await promise, "approved");
      assert.equal(calls, 1);
      assert.equal(privateHandlers(controller).size, 0, "terminal jobs must release their handler");
    });
  });

  it("renders a cancel button for a running job and cancelling rejects the run", async () => {
    const dom = queueDom();
    await withDocument(dom, async () => {
      const controller = new AIQueueController();
      await controller.initialize();
      const promise = controller.run("tts", { id: "cancel-ui" }, async () => {
        await new Promise(() => undefined);
        return "never";
      });
      await waitUntil(() => controller.queue.list()[0]?.state === "running");
      const row = dom.getElementById("ai-job-list")!.children[0];
      assert.ok(row);
      const cancel = row.children[1];
      assert.ok(cancel);
      assert.equal(cancel.textContent, "취소");
      cancel.emit("click");
      await assert.rejects(promise, (error: unknown) => {
        assert.ok(error instanceof JobQueueError);
        assert.equal(error.code, "CANCELLED");
        return true;
      });
      assert.equal(privateHandlers(controller).size, 0);
    });
  });

  it("moves a persisted running job to recovery and fails it with re-selection guidance", async () => {
    const dom = queueDom();
    const storage = new MemoryJobStorage();
    storage.values.set(JOB_QUEUE_STORAGE_KEY, JSON.stringify({
      version: 1,
      paused: false,
      jobs: [{
        id: "job-restored-1",
        hash: "cafe0123deadbeef",
        kind: "text",
        content: { id: 7 },
        state: "running",
        progress: 0.4,
        attempt: 1,
        maxRetries: 1,
        estimateUnits: 1,
        confirmRequired: false,
        confirmed: true,
        fromCache: false,
        recovered: false,
        createdAt: 1,
        updatedAt: 1,
        startedAt: 1,
      }],
      cache: [],
      usage: { day: "2026-07-13", requests: 0, costUnits: 0 },
      budget: {},
    }));
    await withDocument(dom, async () => {
      const activities: string[] = [];
      const controller = new AIQueueController({
        storage,
        onActivity: (message) => activities.push(message),
      });
      await controller.initialize();
      assert.ok(activities.some((message) => message.includes("중단된 AI 작업 1개를 복구 대기열로")));
      await waitUntil(() => controller.queue.get("job-restored-1")?.state === "failed");
      const job = controller.queue.get("job-restored-1");
      assert.equal(job?.recovered, true);
      assert.match(job?.error ?? "", /자동 재개할 수 없습니다.*다시 선택/u);
    });
  });

  it("reports restore failures through onError and keeps the queue usable", async () => {
    const dom = queueDom();
    const storage = new MemoryJobStorage();
    storage.failRead = true;
    await withDocument(dom, async () => {
      const errors: Array<{ error: unknown; context: string }> = [];
      const controller = new AIQueueController({
        storage,
        onError: (error, context) => errors.push({ error, context }),
      });
      await controller.initialize();
      assert.equal(errors.length, 1);
      assert.equal(errors[0]?.context, "AI 작업 큐 복구 실패");
      assert.ok(errors[0]?.error instanceof JobQueueError);
      storage.failRead = false;
      assert.equal(await controller.run("text", { id: "after-restore" }, async () => "ok"), "ok");
    });
  });

  it("surfaces persistence failures through onError as AI 큐 저장 실패", async () => {
    const dom = queueDom();
    const storage = new MemoryJobStorage();
    storage.failWrite = true;
    await withDocument(dom, async () => {
      const errors: string[] = [];
      const controller = new AIQueueController({
        storage,
        onError: (_error, context) => errors.push(context),
      });
      await controller.initialize();
      assert.equal(await controller.run("text", { id: "persist" }, async () => "ok"), "ok");
      await controller.queue.flushPersistence();
      assert.ok(errors.includes("AI 큐 저장 실패"));
    });
  });
});
