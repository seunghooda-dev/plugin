import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  JOB_QUEUE_STORAGE_KEY,
  MAX_CACHE_ENTRIES,
  MAX_JOB_CONCURRENCY,
  JobQueue,
  JobQueueError,
  type JobExecutionResult,
  type JobExecutor,
  type JobQueueStorage,
  type JobRequest,
  deterministicHash,
  hashJobContent,
  redactJobError,
  stableCanonicalize,
} from "../src/job-queue";

class MemoryStorage implements JobQueueStorage {
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

function request(id: number | string, overrides: Partial<JobRequest> = {}): JobRequest {
  return {
    kind: "image",
    content: { id },
    ...overrides,
  };
}

function successExecutor(value: unknown = "ok"): JobExecutor {
  return async () => ({ value });
}

async function turn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitUntil(predicate: () => boolean, attempts = 50): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await turn();
  }
  assert.fail("condition was not reached");
}

function expectQueueCode(code: JobQueueError["code"]): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof JobQueueError);
    assert.equal(error.code, code);
    assert.ok(error.message.length > 0);
    return true;
  };
}

describe("stable canonical hash", () => {
  it("canonicalizes object keys independently of insertion order", () => {
    assert.equal(
      stableCanonicalize({ b: 2, a: 1 }),
      stableCanonicalize({ a: 1, b: 2 }),
    );
  });

  it("preserves array order", () => {
    assert.notEqual(stableCanonicalize([1, 2]), stableCanonicalize([2, 1]));
  });

  it("distinguishes primitive types and special numbers", () => {
    assert.notEqual(deterministicHash(1), deterministicHash("1"));
    assert.notEqual(deterministicHash(0), deterministicHash(-0));
    assert.notEqual(deterministicHash(Number.NaN), deterministicHash(null));
  });

  it("hashes typed-array contents deterministically", () => {
    assert.equal(
      deterministicHash(new Uint8Array([1, 2, 3])),
      deterministicHash(new Uint8Array([1, 2, 3])),
    );
    assert.notEqual(
      deterministicHash(new Uint8Array([1, 2, 3])),
      deterministicHash(new Uint8Array([1, 2, 4])),
    );
  });

  it("canonicalizes large binary inputs without expanding them into hex", () => {
    const canonical = stableCanonicalize(new Uint8Array(10 * 1024 * 1024));
    assert.ok(canonical.length < 100);
  });

  it("includes kind, content, and options in a job hash", () => {
    assert.equal(
      hashJobContent("image", { prompt: "x" }, { quality: "high" }),
      hashJobContent("image", { prompt: "x" }, { quality: "high" }),
    );
    assert.notEqual(
      hashJobContent("image", { prompt: "x" }, {}),
      hashJobContent("video", { prompt: "x" }, {}),
    );
  });

  it("returns a compact stable hexadecimal ID", () => {
    assert.match(deterministicHash({ hello: "세계" }), /^[0-9a-f]{16}$/u);
  });

  it("rejects circular content", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    assert.throws(() => deterministicHash(circular), expectQueueCode("INVALID_JOB"));
  });
});

describe("queue basics and concurrency", () => {
  it("supports all five job kinds", async () => {
    const queue = new JobQueue(successExecutor());
    const jobs = (["image", "tts", "stt", "text", "video"] as const).map((kind, index) =>
      queue.enqueue({ kind, content: { index } }),
    );
    const done = await Promise.all(jobs.map((job) => queue.waitFor(job.id)));
    assert.deepEqual(done.map((job) => job.state), Array(5).fill("succeeded"));
  });

  it("drains without a global queueMicrotask (Premiere UXP runtime)", async () => {
    // Premiere 26.3 UXP has no queueMicrotask global; the queue must still drain.
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "queueMicrotask");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).queueMicrotask;
    try {
      const queue = new JobQueue(successExecutor("ok"));
      const job = queue.enqueue(request(1));
      const done = await queue.waitFor(job.id);
      assert.equal(done.state, "succeeded");
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "queueMicrotask", descriptor);
    }
  });

  it("defaults to one running job", async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let maximum = 0;
    const queue = new JobQueue(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return {};
    });
    const first = queue.enqueue(request(1));
    const second = queue.enqueue(request(2));
    await waitUntil(() => releases.length === 1);
    assert.equal(maximum, 1);
    releases.shift()?.();
    await waitUntil(() => releases.length === 1);
    releases.shift()?.();
    await Promise.all([queue.waitFor(first.id), queue.waitFor(second.id)]);
    assert.equal(maximum, 1);
  });

  it("runs up to the configured concurrency", async () => {
    const releases: Array<() => void> = [];
    let active = 0;
    let maximum = 0;
    const queue = new JobQueue(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return {};
    }, { concurrency: 2 });
    const jobs = [1, 2, 3].map((id) => queue.enqueue(request(id)));
    await waitUntil(() => releases.length === 2);
    assert.equal(maximum, 2);
    releases.splice(0).forEach((release) => release());
    await waitUntil(() => releases.length === 1);
    releases.shift()?.();
    await Promise.all(jobs.map((job) => queue.waitFor(job.id)));
  });

  it("caps concurrency at three", () => {
    const queue = new JobQueue(successExecutor(), { concurrency: 999 });
    assert.equal(queue.currentConcurrency, MAX_JOB_CONCURRENCY);
    assert.equal(queue.setConcurrency(999), 3);
    assert.equal(queue.setConcurrency(0), 1);
  });

  it("reports succeeded and failed terminal states", async () => {
    const success = new JobQueue(successExecutor("done"));
    const succeeded = await success.waitFor(success.enqueue(request(1)).id);
    assert.equal(succeeded.state, "succeeded");
    assert.equal(succeeded.result, "done");
    assert.equal(succeeded.progress, 1);

    const failure = new JobQueue(async () => { throw new Error("broken"); });
    const failed = await failure.waitFor(failure.enqueue(request(2)).id);
    assert.equal(failed.state, "failed");
    assert.equal(failed.error, "broken");
  });

  it("rejects invalid kinds and undefined content", () => {
    const queue = new JobQueue(successExecutor());
    assert.throws(
      () => queue.enqueue({ kind: "legacy" as never, content: {} }),
      expectQueueCode("INVALID_JOB"),
    );
    assert.throws(
      () => queue.enqueue({ kind: "image", content: undefined }),
      expectQueueCode("INVALID_JOB"),
    );
  });

  it("rejects waiting for an unknown job", async () => {
    const queue = new JobQueue(successExecutor());
    await assert.rejects(queue.waitFor("missing"), expectQueueCode("JOB_NOT_FOUND"));
  });
});

describe("pause, progress, confirmation, and cancellation", () => {
  it("pauses queued work and resumes it", async () => {
    let calls = 0;
    const queue = new JobQueue(async () => { calls += 1; return {}; });
    queue.pause();
    const job = queue.enqueue(request(1));
    await turn();
    assert.equal(calls, 0);
    assert.equal(queue.get(job.id)?.state, "queued");
    queue.resume();
    assert.equal((await queue.waitFor(job.id)).state, "succeeded");
  });

  it("reports and clamps progress", async () => {
    const progress: number[] = [];
    const queue = new JobQueue(async (_job, context) => {
      context.reportProgress(-1);
      context.reportProgress(0.4);
      context.reportProgress(2);
      return {};
    });
    queue.subscribe((event) => {
      if (event.job?.state === "running") progress.push(event.job.progress);
    });
    const done = await queue.waitFor(queue.enqueue(request(1)).id);
    assert.equal(done.progress, 1);
    assert.ok(progress.includes(0));
    assert.ok(progress.includes(0.4));
    assert.ok(progress.includes(1));
  });

  it("requires confirmation above the provider-unit threshold", async () => {
    let calls = 0;
    const queue = new JobQueue(async () => { calls += 1; return {}; }, {
      budget: { confirmationThresholdUnits: 5 },
    });
    const job = queue.enqueue(request(1, { estimateUnits: 6 }));
    await turn();
    assert.equal(calls, 0);
    assert.equal(queue.get(job.id)?.confirmRequired, true);
    assert.equal(queue.get(job.id)?.confirmed, false);
    queue.confirm(job.id);
    assert.equal((await queue.waitFor(job.id)).state, "succeeded");
  });

  it("supports an explicit confirmation requirement", async () => {
    const queue = new JobQueue(successExecutor());
    const job = queue.enqueue(request(1, { confirmRequired: true }));
    await turn();
    assert.equal(queue.get(job.id)?.state, "queued");
    queue.confirm(job.id);
    await queue.waitFor(job.id);
  });

  it("cancels queued work without executing it", async () => {
    let calls = 0;
    const queue = new JobQueue(async () => { calls += 1; return {}; });
    queue.pause();
    const job = queue.enqueue(request(1));
    assert.equal(queue.cancel(job.id), true);
    const done = await queue.waitFor(job.id);
    assert.equal(done.state, "cancelled");
    assert.equal(calls, 0);
    assert.equal(queue.cancel(job.id), false);
  });

  it("aborts a running executor through AbortSignal", async () => {
    let observedSignal: AbortSignal | undefined;
    const queue = new JobQueue(async (_job, context) => {
      observedSignal = context.signal;
      await new Promise<void>((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return {};
    });
    const job = queue.enqueue(request(1));
    await waitUntil(() => queue.get(job.id)?.state === "running");
    assert.equal(queue.cancel(job.id), true);
    const done = await queue.waitFor(job.id);
    assert.equal(observedSignal?.aborted, true);
    assert.equal(done.state, "cancelled");
  });

  it("settles cancellation even when a running executor ignores AbortSignal", async () => {
    const queue = new JobQueue(async () => new Promise<JobExecutionResult>(() => undefined));
    const job = queue.enqueue(request(1));
    await waitUntil(() => queue.get(job.id)?.state === "running");
    assert.equal(queue.cancel(job.id), true);
    const outcome = await Promise.race([
      queue.waitFor(job.id),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 25)),
    ]);
    assert.notEqual(outcome, "timeout");
    assert.equal(typeof outcome === "string" ? outcome : outcome.state, "cancelled");
  });
});

describe("transient retry", () => {
  it("uses exponential backoff with injected jitter", async () => {
    let calls = 0;
    const delays: number[] = [];
    const queue = new JobQueue(async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error("temporary"), { status: 503 });
      return {};
    }, {
      maxRetries: 2,
      baseRetryDelayMs: 100,
      random: () => 0.5,
      sleep: async (delay) => { delays.push(delay); },
    });
    const done = await queue.waitFor(queue.enqueue(request(1)).id);
    assert.equal(done.state, "succeeded");
    assert.equal(done.attempt, 3);
    assert.deepEqual(delays, [100, 200]);
  });

  it("retries status 429", async () => {
    let calls = 0;
    const queue = new JobQueue(async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("rate limited"), { status: 429 });
      return {};
    }, { sleep: async () => undefined });
    assert.equal((await queue.waitFor(queue.enqueue(request(1)).id)).state, "succeeded");
    assert.equal(calls, 2);
  });

  it("does not retry permanent failures", async () => {
    let calls = 0;
    const queue = new JobQueue(async () => {
      calls += 1;
      throw Object.assign(new Error("bad request"), { status: 400 });
    }, { sleep: async () => undefined });
    const done = await queue.waitFor(queue.enqueue(request(1)).id);
    assert.equal(done.state, "failed");
    assert.equal(calls, 1);
  });

  it("honors a per-job retry override", async () => {
    let calls = 0;
    const queue = new JobQueue(async () => {
      calls += 1;
      throw Object.assign(new Error("network timeout"), { retryable: true });
    }, { maxRetries: 5, sleep: async () => undefined });
    const done = await queue.waitFor(queue.enqueue(request(1, { maxRetries: 0 })).id);
    assert.equal(done.state, "failed");
    assert.equal(calls, 1);
  });

  it("cancels during retry sleep", async () => {
    let rejectSleep: ((error: Error) => void) | undefined;
    const queue = new JobQueue(async () => {
      throw Object.assign(new Error("temporary"), { status: 500 });
    }, {
      sleep: async (_delay, signal) => new Promise<void>((_resolve, reject) => {
        rejectSleep = reject;
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      }),
    });
    const job = queue.enqueue(request(1));
    await waitUntil(() => Boolean(rejectSleep));
    queue.cancel(job.id);
    assert.equal((await queue.waitFor(job.id)).state, "cancelled");
  });
});

describe("de-duplication and cache", () => {
  it("deduplicates the same queued hash", () => {
    const queue = new JobQueue(successExecutor());
    queue.pause();
    const first = queue.enqueue({ kind: "text", content: { b: 2, a: 1 } });
    const duplicate = queue.enqueue({ kind: "text", content: { a: 1, b: 2 } });
    assert.equal(duplicate.id, first.id);
    assert.equal(queue.list().length, 1);
  });

  it("serves a completed hash from in-memory cache", async () => {
    let calls = 0;
    const queue = new JobQueue(async () => ({ value: ++calls }));
    const first = await queue.waitFor(queue.enqueue(request(1)).id);
    const cached = queue.enqueue(request(1));
    assert.notEqual(cached.id, first.id);
    assert.equal(cached.state, "succeeded");
    assert.equal(cached.fromCache, true);
    assert.equal(cached.result, 1);
    assert.equal(calls, 1);
  });

  it("expires cache entries by TTL", async () => {
    let now = Date.parse("2026-07-11T00:00:00Z");
    let calls = 0;
    const queue = new JobQueue(async () => ({ value: ++calls }), { now: () => now });
    await queue.waitFor(queue.enqueue(request(1, { cacheTtlMs: 10 })).id);
    now += 11;
    const second = queue.enqueue(request(1, { cacheTtlMs: 10 }));
    assert.equal(second.state, "queued");
    await queue.waitFor(second.id);
    assert.equal(calls, 2);
  });

  it("disables caching with a zero TTL", async () => {
    let calls = 0;
    const queue = new JobQueue(async () => ({ value: ++calls }));
    await queue.waitFor(queue.enqueue(request(1, { cacheTtlMs: 0 })).id);
    await queue.waitFor(queue.enqueue(request(1, { cacheTtlMs: 0 })).id);
    assert.equal(calls, 2);
  });

  it("enforces a 100-entry LRU cache cap", async () => {
    let clock = 0;
    const queue = new JobQueue(async () => ({}), { concurrency: 3, now: () => ++clock });
    const jobs = Array.from({ length: MAX_CACHE_ENTRIES + 1 }, (_, index) =>
      queue.enqueue(request(index)),
    );
    await Promise.all(jobs.map((job) => queue.waitFor(job.id)));
    assert.equal(queue.getCacheMetadata().length, MAX_CACHE_ENTRIES);
  });

  it("bounds completed job history", async () => {
    const queue = new JobQueue(successExecutor());
    for (let index = 0; index < 520; index += 1) {
      const job = queue.enqueue(request(index));
      await queue.waitFor(job.id);
    }
    assert.ok(queue.list().length <= 500);
  });

  it("clears cached successful hashes", async () => {
    let calls = 0;
    const queue = new JobQueue(async () => ({ value: ++calls }));
    await queue.waitFor(queue.enqueue(request(1)).id);
    queue.clearCache();
    await queue.waitFor(queue.enqueue(request(1)).id);
    assert.equal(calls, 2);
  });
});

describe("daily provider-unit budgets", () => {
  it("enforces the daily request limit", async () => {
    const queue = new JobQueue(successExecutor(), { budget: { requestLimit: 1 } });
    const first = queue.enqueue(request(1));
    const second = queue.enqueue(request(2));
    assert.equal((await queue.waitFor(first.id)).state, "succeeded");
    const denied = await queue.waitFor(second.id);
    assert.equal(denied.state, "failed");
    assert.match(denied.error ?? "", /한도/u);
    assert.equal(queue.getUsage().requests, 1);
  });

  it("enforces the estimated cost-unit limit", async () => {
    const queue = new JobQueue(successExecutor(), { budget: { costLimitUnits: 5 } });
    const job = queue.enqueue(request(1, { estimateUnits: 6 }));
    const done = await queue.waitFor(job.id);
    assert.equal(done.state, "failed");
    assert.equal(queue.getUsage().costUnits, 0);
  });

  it("adjusts reserved estimate to actual provider units", async () => {
    const queue = new JobQueue(async () => ({ costUnits: 3 }), {
      budget: { costLimitUnits: 10 },
    });
    await queue.waitFor(queue.enqueue(request(1, { estimateUnits: 5 })).id);
    assert.equal(queue.getUsage().costUnits, 3);
  });

  it("counts retry attempts as provider requests", async () => {
    let calls = 0;
    const queue = new JobQueue(async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("busy"), { status: 503 });
      return {};
    }, { sleep: async () => undefined });
    await queue.waitFor(queue.enqueue(request(1)).id);
    assert.equal(queue.getUsage().requests, 2);
  });

  it("resets usage on the next UTC day", async () => {
    let now = Date.parse("2026-07-11T23:59:59Z");
    const queue = new JobQueue(successExecutor(), {
      now: () => now,
      budget: { requestLimit: 1 },
    });
    await queue.waitFor(queue.enqueue(request(1)).id);
    now = Date.parse("2026-07-12T00:00:01Z");
    const second = await queue.waitFor(queue.enqueue(request(2)).id);
    assert.equal(second.state, "succeeded");
    assert.equal(queue.getUsage().requests, 1);
  });
});

describe("events, redaction, persistence, and restore", () => {
  it("subscribes and unsubscribes from immutable snapshots", async () => {
    const queue = new JobQueue(successExecutor());
    const events: string[] = [];
    const unsubscribe = queue.subscribe((event) => events.push(event.type));
    await queue.waitFor(queue.enqueue(request(1)).id);
    unsubscribe();
    queue.enqueue(request(2));
    assert.ok(events.includes("job-added"));
    assert.ok(events.includes("job-updated"));
    const count = events.length;
    await turn();
    assert.equal(events.length, count);
  });

  it("isolates subscriber exceptions", async () => {
    const queue = new JobQueue(successExecutor());
    queue.subscribe(() => { throw new Error("listener failed"); });
    assert.equal((await queue.waitFor(queue.enqueue(request(1)).id)).state, "succeeded");
  });

  it("redacts credentials from errors", () => {
    const secret = "sk-proj-abcdefghijk";
    const result = redactJobError(new Error(`Authorization: Bearer ${secret}`));
    assert.equal(result.includes(secret), false);
    assert.match(result, /\[REDACTED\]/u);
  });

  it("persists metadata and file tokens but never binary or secrets", async () => {
    const storage = new MemoryStorage();
    const queue = new JobQueue(async (): Promise<JobExecutionResult> => ({
      value: new Uint8Array([9, 8, 7]),
      cache: {
        fileToken: "persistent-file-token",
        metadata: { width: 1920, apiKey: "sk-private-secret" },
      },
    }), { storage });
    const job = queue.enqueue({
      kind: "image",
      content: { bytes: new Uint8Array([1, 2, 3]), authorization: "Bearer secret" },
    });
    await queue.waitFor(job.id);
    await queue.flushPersistence();
    const serialized = storage.getItem(JOB_QUEUE_STORAGE_KEY) ?? "";
    assert.match(serialized, /persistent-file-token/u);
    assert.match(serialized, /\[BINARY_OMITTED\]/u);
    assert.match(serialized, /\[REDACTED\]/u);
    assert.equal(serialized.includes("sk-private-secret"), false);
  });

  it("omits queued scripts, prompts, media names, and request tokens from persistence", async () => {
    const storage = new MemoryStorage();
    const queue = new JobQueue(successExecutor(), { storage });
    queue.pause();
    queue.enqueue({
      kind: "tts",
      content: {
        scriptText: "private spoken script",
        prompt: "private direction",
        mediaName: "confidential-client-cut.mov",
      },
      options: { fileToken: "request-only-file-token" },
    });
    await queue.flushPersistence();
    const serialized = storage.getItem(JOB_QUEUE_STORAGE_KEY) ?? "";
    for (const secret of [
      "private spoken script",
      "private direction",
      "confidential-client-cut.mov",
      "request-only-file-token",
    ]) {
      assert.equal(serialized.includes(secret), false);
    }
    assert.match(serialized, /\[(?:REDACTED|CONTENT_OMITTED)\]/u);
  });

  it("does not execute restored jobs whose required binary content was omitted", async () => {
    const sourceStorage = new MemoryStorage();
    const source = new JobQueue(successExecutor(), { storage: sourceStorage });
    source.pause();
    const original = source.enqueue({ kind: "image", content: new Uint8Array([1, 2, 3]) });
    await source.flushPersistence();

    let calls = 0;
    const restored = new JobQueue(async () => { calls += 1; return {}; }, { storage: sourceStorage });
    await restored.restore();
    restored.resume();
    const recovered = await restored.waitFor(original.id);
    assert.equal(recovered.state, "cancelled");
    assert.equal(calls, 0);
  });

  it("recovers serialized running jobs as queued", async () => {
    const sourceStorage = new MemoryStorage();
    const source = new JobQueue(async () => new Promise<JobExecutionResult>(() => undefined), {
      storage: sourceStorage,
    });
    const original = source.enqueue(request(1));
    await waitUntil(() => source.get(original.id)?.state === "running");
    await source.flushPersistence();

    const restoredStorage = new MemoryStorage();
    const raw = sourceStorage.getItem(JOB_QUEUE_STORAGE_KEY);
    assert.ok(raw);
    const state = JSON.parse(raw) as { paused: boolean };
    state.paused = true;
    restoredStorage.setItem(JOB_QUEUE_STORAGE_KEY, JSON.stringify(state));

    const restored = new JobQueue(successExecutor("recovered"), { storage: restoredStorage });
    assert.equal(await restored.restore(), 1);
    const queued = restored.get(original.id);
    assert.equal(queued?.state, "queued");
    assert.equal(queued?.recovered, true);
    restored.resume();
    assert.equal((await restored.waitFor(original.id)).state, "succeeded");
  });

  it("rejects corrupt serialized state with a safe error", async () => {
    const storage = new MemoryStorage();
    storage.setItem(JOB_QUEUE_STORAGE_KEY, "{not-json sk-proj-abcdefghijk");
    const queue = new JobQueue(successExecutor(), { storage });
    await assert.rejects(queue.restore(), (error: unknown) => {
      expectQueueCode("RESTORE_FAILED")(error);
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes("sk-proj"), false);
      return true;
    });
  });

  it("emits a redacted persistence-error event", async () => {
    const storage: JobQueueStorage = {
      getItem: () => null,
      setItem: async () => { throw new Error("failed sk-proj-abcdefghijk"); },
    };
    const queue = new JobQueue(successExecutor(), { storage });
    const messages: string[] = [];
    queue.subscribe((event) => {
      if (event.type === "persistence-error") messages.push(event.message ?? "");
    });
    await queue.waitFor(queue.enqueue(request(1)).id);
    await queue.flushPersistence();
    assert.equal(messages.length > 0, true);
    assert.equal(messages.some((message) => message.includes("sk-proj")), false);
  });
});
