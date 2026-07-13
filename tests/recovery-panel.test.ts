// 복구 패널의 저널 렌더·상태 라벨·fail-closed 확인 모달과 롤백 시퀀스를 검증하는 테스트
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createRecoveryPanel } from "../src/recovery-panel";
import {
  RECOVERY_SCHEMA_VERSION,
  type OperationJournalEntry,
  type OperationStatus,
  type RecoveryManager,
} from "../src/recovery";

type FakeListener = (event: unknown) => unknown;

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
  disabled = false;
  type = "";
  textContent = "";
  className = "";
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

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "id") this.id = value;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
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

  dispatch(type: string): void {
    this.listeners.get(type)?.forEach((listener) => listener({}));
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

interface RecoveryDom {
  doc: FakeDocument;
  list: FakeElement;
  count: FakeElement;
  dialog: FakeElement;
  restore(): void;
}

function installRecoveryDom(): RecoveryDom {
  const doc = new FakeDocument();
  const list = doc.register("recovery-list");
  const count = doc.register("recovery-count", "span");
  const dialog = doc.register("recovery-confirm-dialog", "dialog");
  doc.register("recovery-confirm-label", "span");
  doc.register("recovery-confirm-approve-btn", "button");
  doc.register("recovery-confirm-cancel-btn", "button");
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
  return {
    doc,
    list,
    count,
    dialog,
    restore(): void {
      if (descriptor) Object.defineProperty(globalThis, "document", descriptor);
      else delete (globalThis as { document?: unknown }).document;
    },
  };
}

type ModalResult = "confirm" | "cancel";

/** 실제 UXP dialog.uxpShowModal을 모사하며 호출 횟수를 기록한다. */
function stubModal(dialog: FakeElement, behavior: ModalResult | "reject"): { calls(): number } {
  let calls = 0;
  const handle = dialog as unknown as { uxpShowModal: (options: unknown) => Promise<unknown> };
  handle.uxpShowModal = async () => {
    calls += 1;
    if (behavior === "reject") throw new Error("모달 표시 실패");
    return behavior;
  };
  return { calls: () => calls };
}

function entry(overrides: Partial<OperationJournalEntry> & { status: OperationStatus }): OperationJournalEntry {
  const base: OperationJournalEntry = {
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    operationId: "op-clone-abcd1234",
    kind: "clone",
    label: "테스트 작업",
    status: "committed",
    preview: { beforeSummary: {}, afterSummary: {}, changes: [], truncated: false },
    clonePolicy: { sourceId: "src-1", cloneId: "clone-1", createdBeforeMutation: true, verified: true },
    originalPreserved: true,
    externalEffects: [],
    createdAt: 1,
    updatedAt: 1,
    startedAt: 1,
    recoveryGuidance: "원본은 보존되었습니다.",
  };
  return { ...base, ...overrides };
}

interface ManagerStub {
  manager: RecoveryManager;
  rollbackCalls: string[];
}

function managerStub(
  entries: OperationJournalEntry[],
  rollback: (operationId: string, cb?: () => void | Promise<void>) => Promise<void>,
): ManagerStub {
  const rollbackCalls: string[] = [];
  const stub = {
    list: () => entries.map((item) => ({ ...item })),
    rollback: async (operationId: string, cb?: () => void | Promise<void>) => {
      rollbackCalls.push(operationId);
      await rollback(operationId, cb);
    },
  };
  return { manager: stub as unknown as RecoveryManager, rollbackCalls };
}

interface PanelHarness {
  render(): void;
  activities: Array<[string, string]>;
  errors: Array<{ context: string; message: string }>;
  removeCloneCalls: Array<[string, string]>;
}

function buildPanel(getManager: () => RecoveryManager | null): PanelHarness {
  const activities: Array<[string, string]> = [];
  const errors: Array<{ context: string; message: string }> = [];
  const removeCloneCalls: Array<[string, string]> = [];
  const panel = createRecoveryPanel({
    getManager,
    removeClone: async (sourceId, cloneId) => { removeCloneCalls.push([sourceId, cloneId]); },
    onActivity: (level, message) => { activities.push([level, message]); },
    onError: (error, context) => {
      errors.push({ context, message: error instanceof Error ? error.message : String(error) });
    },
  });
  return { render: panel.render, activities, errors, removeCloneCalls };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function rows(list: FakeElement): FakeElement[] {
  return list.children.filter((child) => child.classList.contains("recovery-row"));
}

describe("createRecoveryPanel 렌더링", () => {
  it("저널이 비어 있으면 안내 문구와 0 / 50 카운트를 표시한다", () => {
    const dom = installRecoveryDom();
    try {
      const { manager } = managerStub([], async () => undefined);
      const panel = buildPanel(() => manager);
      panel.render();

      assert.equal(dom.count.textContent, "0 / 50");
      assert.equal(dom.list.children.length, 1);
      const placeholder = dom.list.children[0];
      assert.equal(placeholder?.tagName, "p");
      assert.equal(placeholder?.className, "action-note");
      assert.equal(placeholder?.textContent, "기록된 비파괴 작업이 없습니다.");
    } finally {
      dom.restore();
    }
  });

  it("항목을 최신순으로 정렬하고 상태 라벨과 상세를 렌더링한다", () => {
    const dom = installRecoveryDom();
    try {
      const entries = [
        entry({ status: "committed", label: "완료작업", createdAt: 3, preview: { beforeSummary: {}, afterSummary: {}, changes: [{ path: "a", type: "changed" }], truncated: false } }),
        entry({ status: "running", label: "실행작업", createdAt: 5 }),
        entry({ status: "rolled-back", label: "복구작업", createdAt: 1, originalPreserved: false, error: "부분 실패" }),
      ];
      const { manager } = managerStub(entries, async () => undefined);
      const panel = buildPanel(() => manager);
      panel.render();

      assert.equal(dom.count.textContent, "3 / 50");
      const rowNodes = rows(dom.list);
      assert.equal(rowNodes.length, 3);
      // createdAt 내림차순: 실행작업(5) → 완료작업(3) → 복구작업(1)
      assert.equal(rowNodes[0]?.querySelectorAll("strong")[0]?.textContent, "실행작업 · 실행 중");
      assert.equal(rowNodes[0]?.className, "recovery-row is-running");
      assert.equal(rowNodes[1]?.querySelectorAll("strong")[0]?.textContent, "완료작업 · 완료");
      assert.equal(rowNodes[1]?.querySelectorAll("span")[0]?.textContent, "1개 변경 · 원본 보존");
      assert.equal(rowNodes[2]?.querySelectorAll("strong")[0]?.textContent, "복구작업 · 복구 완료");
      assert.equal(rowNodes[2]?.querySelectorAll("span")[0]?.textContent, "0개 변경 · 원본 확인 필요 · 부분 실패");
      assert.equal(rowNodes[1]?.querySelectorAll("small")[0]?.textContent, "원본은 보존되었습니다.");
    } finally {
      dom.restore();
    }
  });

  it("복제본 제거 버튼은 committed/failed/interrupted/rollback-failed 상태에만 노출한다", () => {
    const dom = installRecoveryDom();
    try {
      const statuses: OperationStatus[] = [
        "running",
        "committed",
        "failed",
        "rolling-back",
        "rolled-back",
        "rollback-failed",
        "interrupted",
      ];
      const entries = statuses.map((status, index) => entry({ status, label: status, createdAt: statuses.length - index }));
      const { manager } = managerStub(entries, async () => undefined);
      const panel = buildPanel(() => manager);
      panel.render();

      const withButton = new Set(["committed", "failed", "rollback-failed", "interrupted"]);
      for (const row of rows(dom.list)) {
        const status = row.className.replace("recovery-row is-", "");
        const buttons = row.querySelectorAll("button");
        assert.equal(buttons.length, withButton.has(status) ? 1 : 0, `상태 ${status} 버튼 노출 불일치`);
        if (buttons.length === 1) {
          assert.equal(buttons[0]?.textContent, "복제본 제거");
          assert.equal(buttons[0]?.className, "danger-button small-button");
        }
      }
    } finally {
      dom.restore();
    }
  });
});

describe("createRecoveryPanel 롤백 시퀀스", () => {
  function committedEntry(): OperationJournalEntry {
    return entry({ status: "committed", label: "썸네일 렌더", operationId: "op-clone-render01" });
  }

  it("확인 모달을 승인하면 removeClone과 성공 활동을 남긴다", async () => {
    const dom = installRecoveryDom();
    try {
      const { manager, rollbackCalls } = managerStub([committedEntry()], async (_operationId, cb) => { await cb?.(); });
      const panel = buildPanel(() => manager);
      const modal = stubModal(dom.dialog, "confirm");
      panel.render();

      rows(dom.list)[0]?.querySelectorAll("button")[0]?.dispatch("click");
      await flush();

      assert.equal(modal.calls(), 1);
      assert.deepEqual(rollbackCalls, ["op-clone-render01"]);
      assert.deepEqual(panel.removeCloneCalls, [["src-1", "clone-1"]]);
      assert.ok(panel.activities.some(([level, message]) => level === "success" && message === "복제 시퀀스 복구 완료: 썸네일 렌더"));
      assert.equal(panel.errors.length, 0);
      const label = dom.doc.getElementById("recovery-confirm-label");
      assert.equal(label?.textContent, "썸네일 렌더");
    } finally {
      dom.restore();
    }
  });

  it("확인을 취소하면 롤백 없이 경고를 남긴다 (fail-closed)", async () => {
    const dom = installRecoveryDom();
    try {
      const { manager, rollbackCalls } = managerStub([committedEntry()], async () => undefined);
      const panel = buildPanel(() => manager);
      stubModal(dom.dialog, "cancel");
      panel.render();

      rows(dom.list)[0]?.querySelectorAll("button")[0]?.dispatch("click");
      await flush();

      assert.equal(rollbackCalls.length, 0);
      assert.equal(panel.removeCloneCalls.length, 0);
      assert.ok(panel.activities.some(([level, message]) =>
        level === "warning" && message === "명시적 확인을 받지 못해 복제 시퀀스 제거를 취소했습니다."));
    } finally {
      dom.restore();
    }
  });

  it("모달 표시가 실패해도 fail-closed로 경고만 남긴다", async () => {
    const dom = installRecoveryDom();
    try {
      const { manager, rollbackCalls } = managerStub([committedEntry()], async () => undefined);
      const panel = buildPanel(() => manager);
      stubModal(dom.dialog, "reject");
      panel.render();

      rows(dom.list)[0]?.querySelectorAll("button")[0]?.dispatch("click");
      await flush();

      assert.equal(rollbackCalls.length, 0);
      assert.equal(panel.removeCloneCalls.length, 0);
      assert.ok(panel.activities.some(([level]) => level === "warning"));
      assert.equal(panel.errors.length, 0);
    } finally {
      dom.restore();
    }
  });

  it("롤백이 예외를 던지면 onError로 보고한다", async () => {
    const dom = installRecoveryDom();
    try {
      const { manager } = managerStub([committedEntry()], async () => { throw new Error("복구 실패 원인"); });
      const panel = buildPanel(() => manager);
      stubModal(dom.dialog, "confirm");
      panel.render();

      rows(dom.list)[0]?.querySelectorAll("button")[0]?.dispatch("click");
      await flush();

      assert.equal(panel.errors.length, 1);
      assert.equal(panel.errors[0]?.context, "복제 시퀀스 복구 실패");
      assert.match(panel.errors[0]?.message ?? "", /복구 실패 원인/u);
      assert.equal(panel.activities.some(([level]) => level === "success"), false);
    } finally {
      dom.restore();
    }
  });

  it("롤백이 진행 중이면 두 번째 클릭을 무시한다 (재진입 방지)", async () => {
    const dom = installRecoveryDom();
    try {
      const { manager, rollbackCalls } = managerStub([committedEntry()], async (_operationId, cb) => { await cb?.(); });
      const panel = buildPanel(() => manager);
      const modal = stubModal(dom.dialog, "confirm");
      panel.render();

      const button = rows(dom.list)[0]?.querySelectorAll("button")[0];
      assert.ok(button);
      button.dispatch("click");
      button.dispatch("click");
      await flush();

      assert.equal(modal.calls(), 1, "확인 모달은 한 번만 열려야 한다.");
      assert.deepEqual(rollbackCalls, ["op-clone-render01"]);
      assert.equal(panel.removeCloneCalls.length, 1);
    } finally {
      dom.restore();
    }
  });
});
