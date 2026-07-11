import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  INTERRUPTED_GUIDANCE,
  MANUAL_RESTORE_GUIDANCE,
  MAX_OPERATION_JOURNAL,
  ORIGINAL_PRESERVED_GUIDANCE,
  RECOVERY_SCHEMA_VERSION,
  RECOVERY_STORAGE_KEY,
  RecoveryError,
  RecoveryManager,
  type BeginOperationInput,
  type OperationJournalEntry,
  type RecoveryStorage,
  createPreviewDiff,
  redactRecoveryData,
  redactRecoveryError,
  validateCloneBeforeMutation,
  validateOperationId,
} from "../src/recovery";

class MemoryStorage implements RecoveryStorage {
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

function operation(
  id = "operation-001",
  overrides: Partial<BeginOperationInput> = {},
): BeginOperationInput {
  return {
    operationId: id,
    kind: "sequence-mutation",
    label: "숏폼 시퀀스 생성",
    beforeSummary: { sequence: "Original", clips: 3, width: 1920 },
    afterSummary: { sequence: "Clone", clips: 3, width: 1080 },
    clonePolicy: {
      sourceId: "sequence-original",
      cloneId: "sequence-clone",
      createdBeforeMutation: true,
      verified: true,
    },
    ...overrides,
  };
}

function expectCode(code: RecoveryError["code"]): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof RecoveryError);
    assert.equal(error.code, code);
    assert.ok(error.message.length > 0);
    return true;
  };
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

describe("preview diff and redaction", () => {
  it("summarizes changed fields before mutation", () => {
    const preview = createPreviewDiff(
      { name: "Original", settings: { width: 1920, height: 1080 } },
      { name: "Clone", settings: { width: 1080, height: 1920 } },
    );
    assert.deepEqual(
      preview.changes.map((change) => change.path),
      ["name", "settings.height", "settings.width"],
    );
    assert.equal(preview.truncated, false);
  });

  it("classifies added and removed fields", () => {
    const preview = createPreviewDiff({ old: 1, same: true }, { added: 2, same: true });
    assert.deepEqual(preview.changes, [
      { path: "added", type: "added", after: 2 },
      { path: "old", type: "removed", before: 1 },
    ]);
  });

  it("records an array replacement as one understandable change", () => {
    const preview = createPreviewDiff({ tracks: ["V1"] }, { tracks: ["V1", "V2"] });
    assert.deepEqual(preview.changes[0], {
      path: "tracks",
      type: "changed",
      before: ["V1"],
      after: ["V1", "V2"],
    });
  });

  it("redacts secrets from before, after, and changes", () => {
    const preview = createPreviewDiff(
      { apiKey: "sk-before-secret" },
      { apiKey: "sk-after-secret" },
    );
    const serialized = JSON.stringify(preview);
    assert.equal(serialized.includes("sk-before"), false);
    assert.equal(serialized.includes("sk-after"), false);
    assert.match(serialized, /\[REDACTED\]/u);
  });

  it("omits binary data from serializable recovery summaries", () => {
    assert.deepEqual(redactRecoveryData({ bytes: new Uint8Array([1, 2, 3]) }), {
      bytes: "[BINARY_OMITTED]",
    });
  });

  it("truncates pathological diffs at one hundred changes", () => {
    const before = Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`k${index}`, 0]));
    const after = Object.fromEntries(Array.from({ length: 120 }, (_, index) => [`k${index}`, 1]));
    const preview = createPreviewDiff(before, after);
    assert.equal(preview.changes.length, 100);
    assert.equal(preview.truncated, true);
  });

  it("redacts authorization headers and OpenAI-like keys in errors", () => {
    const result = redactRecoveryError(
      new Error("Authorization: Bearer sk-proj-abcdefghijk"),
    );
    assert.equal(result.includes("sk-proj"), false);
    assert.match(result, /\[REDACTED\]/u);
  });
});

describe("operation and clone policy validation", () => {
  it("accepts a stable safe operation ID", () => {
    assert.equal(validateOperationId("operation:short-001"), true);
    assert.equal(validateOperationId("short"), false);
    assert.equal(validateOperationId("operation with spaces"), false);
  });

  it("accepts a distinct pre-created verified clone", () => {
    assert.deepEqual(validateCloneBeforeMutation(operation().clonePolicy), {
      valid: true,
      reasons: [],
    });
  });

  it("rejects a missing clone", () => {
    const result = validateCloneBeforeMutation({
      sourceId: "source",
      cloneId: "",
      createdBeforeMutation: false,
      verified: false,
    });
    assert.equal(result.valid, false);
    assert.ok(result.reasons.length >= 3);
  });

  it("rejects mutating the original under a clone name", () => {
    const result = validateCloneBeforeMutation({
      sourceId: "same",
      cloneId: "same",
      createdBeforeMutation: true,
      verified: true,
    });
    assert.equal(result.valid, false);
    assert.match(result.reasons.join(" "), /같/u);
  });

  it("blocks begin before any journal entry when clone policy fails", () => {
    const manager = new RecoveryManager();
    assert.throws(
      () => manager.begin(operation("operation-001", {
        clonePolicy: {
          sourceId: "source",
          cloneId: "source",
          createdBeforeMutation: true,
          verified: true,
        },
      })),
      expectCode("CLONE_REQUIRED"),
    );
    assert.equal(manager.list().length, 0);
  });
});

describe("operation state machine", () => {
  it("begins with schema v1 and original-preservation evidence", () => {
    const manager = new RecoveryManager({ now: () => 100 });
    const entry = manager.begin(operation());
    assert.equal(entry.schemaVersion, RECOVERY_SCHEMA_VERSION);
    assert.equal(entry.operationId, "operation-001");
    assert.equal(entry.status, "running");
    assert.equal(entry.originalPreserved, true);
    assert.equal(entry.startedAt, 100);
    assert.equal(entry.recoveryGuidance, ORIGINAL_PRESERVED_GUIDANCE);
  });

  it("generates a valid stable ID when one is omitted", () => {
    const manager = new RecoveryManager({ now: () => 123 });
    const input = operation();
    delete input.operationId;
    const entry = manager.begin(input);
    assert.equal(validateOperationId(entry.operationId), true);
    assert.equal(manager.get(entry.operationId)?.operationId, entry.operationId);
  });

  it("commits only a running operation", () => {
    const manager = new RecoveryManager();
    const begun = manager.begin(operation());
    const committed = manager.commit(begun.operationId, { width: 1080 }, { sequenceId: "clone" });
    assert.equal(committed.status, "committed");
    assert.equal(committed.resultSummary && typeof committed.resultSummary, "object");
    assert.ok(committed.completedAt);
    assert.throws(() => manager.commit(begun.operationId), expectCode("INVALID_TRANSITION"));
    assert.throws(() => manager.fail(begun.operationId, "late"), expectCode("INVALID_TRANSITION"));
  });

  it("fails a running operation with a redacted error and restore guidance", () => {
    const manager = new RecoveryManager();
    const begun = manager.begin(operation());
    const failed = manager.fail(begun.operationId, "failed sk-proj-abcdefghijk");
    assert.equal(failed.status, "failed");
    assert.equal(failed.error?.includes("sk-proj"), false);
    assert.equal(failed.recoveryGuidance, ORIGINAL_PRESERVED_GUIDANCE);
  });

  it("rejects duplicate and malformed IDs", () => {
    const manager = new RecoveryManager();
    manager.begin(operation());
    assert.throws(() => manager.begin(operation()), expectCode("DUPLICATE_OPERATION"));
    assert.throws(
      () => manager.begin(operation("bad id")),
      expectCode("INVALID_OPERATION"),
    );
  });

  it("rejects operations that do not exist", async () => {
    const manager = new RecoveryManager();
    assert.throws(() => manager.commit("operation-missing"), expectCode("OPERATION_NOT_FOUND"));
    await assert.rejects(manager.rollback("operation-missing"), expectCode("OPERATION_NOT_FOUND"));
  });

  it("does not permit rollback while a mutation is still running", async () => {
    const manager = new RecoveryManager();
    const begun = manager.begin(operation());
    await assert.rejects(manager.rollback(begun.operationId), expectCode("INVALID_TRANSITION"));
  });
});

describe("operation journal cap", () => {
  it("keeps at most fifty entries and prunes the oldest terminal entry", () => {
    const manager = new RecoveryManager();
    const first = manager.begin(operation("operation-000"));
    manager.commit(first.operationId);
    for (let index = 1; index < MAX_OPERATION_JOURNAL; index += 1) {
      manager.begin(operation(`operation-${String(index).padStart(3, "0")}`));
    }
    manager.begin(operation("operation-050"));
    assert.equal(manager.list().length, MAX_OPERATION_JOURNAL);
    assert.equal(manager.get("operation-000"), null);
    assert.ok(manager.get("operation-050"));
  });

  it("refuses to evict running operations", () => {
    const manager = new RecoveryManager();
    for (let index = 0; index < MAX_OPERATION_JOURNAL; index += 1) {
      manager.begin(operation(`operation-${String(index).padStart(3, "0")}`));
    }
    assert.throws(
      () => manager.begin(operation("operation-050")),
      expectCode("JOURNAL_FULL"),
    );
  });
});

describe("external side-effect rollback", () => {
  it("runs registered callbacks in reverse order outside Premiere undo", async () => {
    const manager = new RecoveryManager();
    const begun = manager.begin(operation());
    const order: string[] = [];
    manager.registerExternalEffect(begun.operationId, "임시 파일", async () => { order.push("file"); });
    manager.registerExternalEffect(begun.operationId, "인코더 작업", async () => { order.push("encoder"); });
    manager.commit(begun.operationId);

    const rolledBack = await manager.rollback(begun.operationId);
    assert.deepEqual(order, ["encoder", "file"]);
    assert.equal(rolledBack.status, "rolled-back");
    assert.deepEqual(
      rolledBack.externalEffects.map((effect) => effect.status),
      ["rolled-back", "rolled-back"],
    );
  });

  it("supports rollback after a failed clone mutation", async () => {
    const manager = new RecoveryManager();
    const begun = manager.begin(operation());
    let cleaned = false;
    manager.registerExternalEffect(begun.operationId, "출력 파일", () => { cleaned = true; });
    manager.fail(begun.operationId, "mutation failed");
    assert.equal((await manager.rollback(begun.operationId)).status, "rolled-back");
    assert.equal(cleaned, true);
  });

  it("records callback failure and gives manual restore instructions", async () => {
    const manager = new RecoveryManager();
    const begun = manager.begin(operation());
    manager.registerExternalEffect(begun.operationId, "민감 파일", () => {
      throw new Error("remove failed sk-proj-abcdefghijk");
    });
    manager.commit(begun.operationId);
    await assert.rejects(manager.rollback(begun.operationId), expectCode("ROLLBACK_FAILED"));
    const failed = manager.get(begun.operationId);
    assert.equal(failed?.status, "rollback-failed");
    assert.equal(failed?.recoveryGuidance, MANUAL_RESTORE_GUIDANCE);
    assert.equal(failed?.error?.includes("sk-proj"), false);
  });

  it("prevents registering callbacks after commit", () => {
    const manager = new RecoveryManager();
    const begun = manager.begin(operation());
    manager.commit(begun.operationId);
    assert.throws(
      () => manager.registerExternalEffect(begun.operationId, "late", () => undefined),
      expectCode("INVALID_TRANSITION"),
    );
  });
});

describe("serialized mutation execution", () => {
  it("serializes concurrent clone mutations", async () => {
    const manager = new RecoveryManager();
    const order: string[] = [];
    const releases: Array<() => void> = [];
    const run = (id: string) => manager.execute(operation(id), async () => {
      order.push(`start:${id}`);
      await new Promise<void>((resolve) => releases.push(resolve));
      order.push(`end:${id}`);
      return { afterSummary: { id } };
    });
    const first = run("operation-101");
    const second = run("operation-102");
    await waitUntil(() => releases.length === 1);
    assert.deepEqual(order, ["start:operation-101"]);
    releases.shift()?.();
    await waitUntil(() => releases.length === 1);
    assert.deepEqual(order, ["start:operation-101", "end:operation-101", "start:operation-102"]);
    releases.shift()?.();
    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map((entry) => entry.status), ["committed", "committed"]);
  });

  it("passes only the verified clone target to mutation context", async () => {
    const manager = new RecoveryManager();
    let target = "";
    const result = await manager.execute(operation(), async (context) => {
      target = context.cloneId;
      context.updatePreview({ width: 1080, height: 1920 });
      return { resultSummary: { created: context.cloneId } };
    });
    assert.equal(target, "sequence-clone");
    assert.equal(result.status, "committed");
    assert.ok(result.preview.changes.length > 0);
  });

  it("fails safely and preserves the next serialized mutation", async () => {
    const manager = new RecoveryManager();
    const first = manager.execute(operation("operation-201"), async () => {
      throw new Error("failed sk-proj-abcdefghijk");
    });
    const second = manager.execute(operation("operation-202"), async () => ({ resultSummary: "ok" }));
    await assert.rejects(first, (error: unknown) => {
      expectCode("MUTATION_FAILED")(error);
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes("sk-proj"), false);
      assert.match(error.message, /원본/u);
      return true;
    });
    assert.equal((await second).status, "committed");
    assert.equal(manager.get("operation-201")?.status, "failed");
  });

  it("can automatically compensate external effects after failure", async () => {
    const manager = new RecoveryManager();
    let cleaned = false;
    const result = await manager.execute(operation(), async (context) => {
      context.registerExternalEffect("임시 파일", () => { cleaned = true; });
      throw new Error("mutation failed");
    }, { autoRollbackOnFailure: true });
    assert.equal(result.status, "rolled-back");
    assert.equal(cleaned, true);
  });
});

describe("persistence and interrupted recovery", () => {
  it("persists schema v1 without binary data or secrets", async () => {
    const storage = new MemoryStorage();
    const manager = new RecoveryManager({ storage });
    const begun = manager.begin(operation("operation-301", {
      beforeSummary: {
        bytes: new Uint8Array([1, 2, 3]),
        authorization: "Bearer sk-private-secret",
      },
    }));
    manager.fail(begun.operationId, "apiKey=sk-private-secret");
    await manager.flushPersistence();
    const serialized = storage.getItem(RECOVERY_STORAGE_KEY) ?? "";
    assert.match(serialized, /"schemaVersion":1/u);
    assert.match(serialized, /\[BINARY_OMITTED\]/u);
    assert.match(serialized, /\[REDACTED\]/u);
    assert.equal(serialized.includes("sk-private"), false);
  });

  it("restores running work as interrupted instead of replaying mutation", async () => {
    const storage = new MemoryStorage();
    const source = new RecoveryManager({ storage });
    const begun = source.begin(operation("operation-401"));
    await source.flushPersistence();

    const restored = new RecoveryManager({ storage, now: () => 999 });
    assert.equal(await restored.restore(), 1);
    const entry = restored.get(begun.operationId);
    assert.equal(entry?.status, "interrupted");
    assert.equal(entry?.recoveryGuidance, INTERRUPTED_GUIDANCE);
    assert.equal(entry?.completedAt, 999);
  });

  it("also converts an interrupted rollback state safely", async () => {
    const storage = new MemoryStorage();
    const source = new RecoveryManager({ storage });
    source.begin(operation("operation-402"));
    await source.flushPersistence();
    const raw = storage.getItem(RECOVERY_STORAGE_KEY);
    assert.ok(raw);
    const state = JSON.parse(raw) as { entries: Array<{ status: string }> };
    assert.ok(state.entries[0]);
    state.entries[0].status = "rolling-back";
    storage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify(state));
    const restored = new RecoveryManager({ storage });
    assert.equal(await restored.restore(), 1);
    assert.equal(restored.get("operation-402")?.status, "interrupted");
  });

  it("marks restored external callbacks unavailable and accepts a fallback", async () => {
    const storage = new MemoryStorage();
    const source = new RecoveryManager({ storage });
    const begun = source.begin(operation("operation-403"));
    source.registerExternalEffect(begun.operationId, "외부 파일", () => undefined);
    source.commit(begun.operationId);
    await source.flushPersistence();

    const restored = new RecoveryManager({ storage });
    await restored.restore();
    assert.equal(restored.get(begun.operationId)?.externalEffects[0]?.rollbackAvailable, false);
    let fallback = false;
    const rolledBack = await restored.rollback(begun.operationId, () => { fallback = true; });
    assert.equal(rolledBack.status, "rolled-back");
    assert.equal(fallback, true);
  });

  it("requires manual restoration when callbacks were lost and no fallback exists", async () => {
    const storage = new MemoryStorage();
    const source = new RecoveryManager({ storage });
    const begun = source.begin(operation("operation-404"));
    source.registerExternalEffect(begun.operationId, "외부 파일", () => undefined);
    source.commit(begun.operationId);
    await source.flushPersistence();
    const restored = new RecoveryManager({ storage });
    await restored.restore();
    await assert.rejects(restored.rollback(begun.operationId), expectCode("ROLLBACK_FAILED"));
    assert.equal(restored.get(begun.operationId)?.recoveryGuidance, MANUAL_RESTORE_GUIDANCE);
  });

  it("rejects corrupt and unsupported serialized journals", async () => {
    const storage = new MemoryStorage();
    storage.setItem(RECOVERY_STORAGE_KEY, '{"apiKey":"sk-proj-abcdefghijk"');
    const manager = new RecoveryManager({ storage });
    await assert.rejects(manager.restore(), (error: unknown) => {
      expectCode("RESTORE_FAILED")(error);
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes("sk-proj"), false);
      return true;
    });
  });

  it("restores at most the newest fifty journal entries", async () => {
    const storage = new MemoryStorage();
    const templateManager = new RecoveryManager();
    const template = templateManager.begin(operation("operation-template"));
    templateManager.commit(template.operationId);
    const committed = templateManager.get(template.operationId);
    assert.ok(committed);
    const entries: OperationJournalEntry[] = Array.from({ length: 55 }, (_, index) => ({
      ...committed,
      operationId: `operation-${String(index).padStart(3, "0")}`,
    }));
    storage.setItem(RECOVERY_STORAGE_KEY, JSON.stringify({
      schemaVersion: RECOVERY_SCHEMA_VERSION,
      entries,
    }));
    const restored = new RecoveryManager({ storage });
    await restored.restore();
    assert.equal(restored.list().length, MAX_OPERATION_JOURNAL);
    assert.equal(restored.get("operation-004"), null);
    assert.ok(restored.get("operation-005"));
  });
});

describe("recovery events", () => {
  it("emits state transition events and allows unsubscribe", async () => {
    const manager = new RecoveryManager();
    const events: string[] = [];
    const unsubscribe = manager.subscribe((event) => events.push(event.type));
    const begun = manager.begin(operation());
    manager.commit(begun.operationId);
    await manager.rollback(begun.operationId);
    unsubscribe();
    assert.deepEqual(events, ["began", "committed", "rollback-started", "rolled-back"]);
  });

  it("isolates listener exceptions", () => {
    const manager = new RecoveryManager();
    manager.subscribe(() => { throw new Error("listener failed"); });
    assert.equal(manager.begin(operation()).status, "running");
  });

  it("emits redacted persistence failures without breaking the journal", async () => {
    const storage: RecoveryStorage = {
      getItem: () => null,
      setItem: async () => { throw new Error("failed sk-proj-abcdefghijk"); },
    };
    const manager = new RecoveryManager({ storage });
    const messages: string[] = [];
    manager.subscribe((event) => {
      if (event.type === "persistence-error") messages.push(event.message ?? "");
    });
    manager.begin(operation());
    await manager.flushPersistence();
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.includes("sk-proj"), false);
  });
});
