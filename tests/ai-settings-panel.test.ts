// AI 설정 패널의 연결 상태 배지, API 키 저장, 동의-우선 연결 테스트 흐름을 검증하는 테스트
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createAiSettingsPanel, setConnectionStatus } from "../src/ai-settings-panel";
import type { OpenAIImageClient } from "../src/ai";

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

class FakeElement {
  id = "";
  value = "";
  placeholder = "";
  textContent = "";
  className = "";
  dataset: Record<string, string> = {};
  parentElement: FakeElement | null = null;
  readonly children: FakeElement[] = [];
  readonly classList = new FakeClassList(this);

  constructor(readonly tagName: string) {}

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parentElement = this;
      this.children.push(node);
    }
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
}

function matches(element: FakeElement, selector: string): boolean {
  if (selector.endsWith(":last-child")) {
    const base = selector.slice(0, selector.length - ":last-child".length);
    const parent = element.parentElement;
    if (!parent || parent.children[parent.children.length - 1] !== element) return false;
    return base === "" || element.tagName.toLowerCase() === base.toLowerCase();
  }
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

interface AiSettingsDom {
  doc: FakeDocument;
  aiLabel: FakeElement;
  speechLabel: FakeElement;
  input: FakeElement;
  restore(): void;
}

function statusBadge(doc: FakeDocument, id: string): FakeElement {
  const el = doc.register(id, "div");
  el.append(doc.createElement("span"), doc.createElement("span"));
  const label = el.querySelector("span:last-child");
  assert.ok(label, "상태 배지에는 span:last-child 라벨이 필요하다.");
  return label;
}

function installDom(options: { withInput?: boolean } = {}): AiSettingsDom {
  const doc = new FakeDocument();
  const aiLabel = statusBadge(doc, "ai-status");
  const speechLabel = statusBadge(doc, "speech-status");
  // save/test가 element()에서 던지는 경로를 재현하려면 입력을 등록하지 않는다.
  const input = options.withInput === false
    ? new FakeElement("input")
    : doc.register("ai-api-key-input", "input");
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
  return {
    doc,
    aiLabel,
    speechLabel,
    input,
    restore(): void {
      if (descriptor) Object.defineProperty(globalThis, "document", descriptor);
      else delete (globalThis as { document?: unknown }).document;
    },
  };
}

interface ClientCalls {
  createClient: number;
  getApiKey: number;
  setApiKey: string[];
  testConnection: number;
}

interface ClientStub {
  createClient: () => OpenAIImageClient;
  calls: ClientCalls;
}

function stubClient(config: { initialKey?: string | null; failGetApiKey?: boolean } = {}): ClientStub {
  const calls: ClientCalls = { createClient: 0, getApiKey: 0, setApiKey: [], testConnection: 0 };
  let storedKey: string | null = config.initialKey ?? null;
  const client = {
    getApiKey: async (): Promise<string | null> => {
      calls.getApiKey += 1;
      if (config.failGetApiKey) throw new Error("보안 저장소를 읽지 못했습니다");
      return storedKey;
    },
    setApiKey: async (key: string): Promise<void> => {
      calls.setApiKey.push(key);
      storedKey = key.trim() || null;
    },
    testConnection: async (): Promise<{ ok: boolean; model: string }> => {
      calls.testConnection += 1;
      return { ok: true, model: "gpt-image-2" };
    },
  };
  return {
    createClient: () => { calls.createClient += 1; return client as unknown as OpenAIImageClient; },
    calls,
  };
}

interface PanelHarness {
  panel: ReturnType<typeof createAiSettingsPanel>;
  activities: Array<[string, string]>;
  errors: Array<{ context: string; message: string }>;
  consentCalls(): number;
}

function buildPanel(client: ClientStub, hooks: { consentThrows?: boolean } = {}): PanelHarness {
  const activities: Array<[string, string]> = [];
  const errors: Array<{ context: string; message: string }> = [];
  let consentCalls = 0;
  const panel = createAiSettingsPanel({
    createClient: client.createClient,
    ensureConsent: () => {
      consentCalls += 1;
      if (hooks.consentThrows) throw new Error("텔레메트리 동의가 필요합니다");
    },
    onActivity: (level, message) => { activities.push([level, message]); },
    onError: (error, context) => {
      errors.push({ context, message: error instanceof Error ? error.message : String(error) });
    },
  });
  return { panel, activities, errors, consentCalls: () => consentCalls };
}

describe("setConnectionStatus", () => {
  it("상태에 맞는 클래스·dataset·라벨을 토글한다", () => {
    const dom = installDom();
    try {
      const badge = dom.doc.getElementById("ai-status");
      assert.ok(badge);

      setConnectionStatus("ai-status", "connected", "연결됨");
      assert.equal(badge.classList.contains("is-connected"), true);
      assert.equal(badge.classList.contains("is-idle"), false);
      assert.equal(badge.classList.contains("is-error"), false);
      assert.equal(badge.dataset.status, "connected");
      assert.equal(dom.aiLabel.textContent, "연결됨");

      setConnectionStatus("ai-status", "error", "오류");
      assert.equal(badge.classList.contains("is-error"), true);
      assert.equal(badge.classList.contains("is-connected"), false);
      assert.equal(badge.dataset.status, "error");
      assert.equal(dom.aiLabel.textContent, "오류");

      setConnectionStatus("ai-status", "idle", "대기");
      assert.equal(badge.classList.contains("is-idle"), true);
      assert.equal(badge.classList.contains("is-error"), false);
      assert.equal(badge.dataset.status, "idle");
      assert.equal(dom.aiLabel.textContent, "대기");
    } finally {
      dom.restore();
    }
  });

  it("대상 요소가 없으면 조용히 무시한다", () => {
    const dom = installDom();
    try {
      assert.doesNotThrow(() => setConnectionStatus("ai-status", "connected", "무시되지 않음"));
      assert.doesNotThrow(() =>
        setConnectionStatus("speech-status", "idle", "존재하지만 라벨 갱신 안전"));
      // 등록되지 않은 id는 optionalElement가 null이라 아무 일도 하지 않는다.
      assert.doesNotThrow(() => {
        const doc = new FakeDocument();
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
        Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
        try {
          setConnectionStatus("ai-status", "connected", "no element");
        } finally {
          if (descriptor) Object.defineProperty(globalThis, "document", descriptor);
          else delete (globalThis as { document?: unknown }).document;
        }
      });
    } finally {
      dom.restore();
    }
  });
});

describe("createAiSettingsPanel initialize", () => {
  it("저장된 키가 있으면 connected 배지와 유지 placeholder를 표시한다", async () => {
    const dom = installDom();
    try {
      const client = stubClient({ initialKey: "sk-stored-key" });
      const { panel, errors } = buildPanel(client);
      await panel.initialize();

      assert.equal(dom.doc.getElementById("ai-status")?.dataset.status, "connected");
      assert.equal(dom.doc.getElementById("speech-status")?.dataset.status, "connected");
      assert.equal(dom.aiLabel.textContent, "API 키 저장됨");
      assert.equal(dom.speechLabel.textContent, "API 키 저장됨");
      assert.equal(dom.input.placeholder, "저장된 API 키 유지");
      assert.equal(errors.length, 0);
    } finally {
      dom.restore();
    }
  });

  it("저장된 키가 없으면 idle 배지와 입력 placeholder를 표시한다", async () => {
    const dom = installDom();
    try {
      const client = stubClient({ initialKey: null });
      const { panel } = buildPanel(client);
      await panel.initialize();

      assert.equal(dom.doc.getElementById("ai-status")?.dataset.status, "idle");
      assert.equal(dom.aiLabel.textContent, "API 키 필요");
      assert.equal(dom.speechLabel.textContent, "API 키 필요");
      assert.equal(dom.input.placeholder, "API 키 입력");
    } finally {
      dom.restore();
    }
  });

  it("키 조회 실패는 error 배지와 onError로 보고하고 던지지 않는다", async () => {
    const dom = installDom();
    try {
      const client = stubClient({ failGetApiKey: true });
      const { panel, errors } = buildPanel(client);
      await panel.initialize();

      assert.equal(dom.doc.getElementById("ai-status")?.dataset.status, "error");
      assert.equal(dom.doc.getElementById("speech-status")?.dataset.status, "error");
      assert.equal(dom.aiLabel.textContent, "AI 설정 오류");
      assert.equal(errors.length, 1);
      assert.equal(errors[0]?.context, "AI 설정 초기화 실패");
    } finally {
      dom.restore();
    }
  });
});

describe("createAiSettingsPanel save", () => {
  it("입력된 키를 저장하고 입력을 비운 뒤 저장됨 배지를 표시한다", async () => {
    const dom = installDom();
    try {
      const client = stubClient({ initialKey: null });
      const { panel, activities } = buildPanel(client);
      dom.input.value = "sk-new-key";
      await panel.save();

      assert.deepEqual(client.calls.setApiKey, ["sk-new-key"]);
      assert.equal(dom.input.value, "");
      assert.equal(dom.input.placeholder, "저장된 API 키 유지");
      assert.equal(dom.doc.getElementById("ai-status")?.dataset.status, "connected");
      assert.equal(dom.aiLabel.textContent, "설정 저장됨");
      assert.equal(dom.speechLabel.textContent, "AI 연결 준비됨");
      assert.ok(activities.some(([level, message]) =>
        level === "success" && message.startsWith("AI 연결 설정을 저장했습니다.")));
    } finally {
      dom.restore();
    }
  });

  it("빈 입력이고 저장된 키도 없으면 저장 호출 없이 idle 안내를 남긴다", async () => {
    const dom = installDom();
    try {
      const client = stubClient({ initialKey: null });
      const { panel } = buildPanel(client);
      dom.input.value = "   ";
      await panel.save();

      assert.equal(client.calls.setApiKey.length, 0);
      assert.equal(dom.doc.getElementById("ai-status")?.dataset.status, "idle");
      assert.equal(dom.aiLabel.textContent, "API 키 필요");
      assert.equal(dom.speechLabel.textContent, "AI 설정 필요");
      assert.equal(dom.input.placeholder, "API 키 입력");
    } finally {
      dom.restore();
    }
  });

  it("ai-api-key-input이 없어도 save가 던지지 않고 그대로 진행한다", async () => {
    const dom = installDom({ withInput: false });
    try {
      const client = stubClient({ initialKey: null });
      const { panel } = buildPanel(client);
      // UXP에서 빈 입력창 .value가 null이라 옛 element().value.trim()이 던지던 버그를 방지한다.
      await panel.save();
      assert.equal(client.calls.setApiKey.length, 0);
    } finally {
      dom.restore();
    }
  });
});

describe("createAiSettingsPanel test", () => {
  it("ensureConsent가 던지면 client 연결 테스트를 호출하지 않는다", async () => {
    const dom = installDom();
    try {
      const client = stubClient({ initialKey: "sk-any" });
      const built = buildPanel(client, { consentThrows: true });
      dom.input.value = "sk-typed";
      await assert.rejects(built.panel.test(), /동의/u);

      assert.equal(built.consentCalls(), 1);
      assert.equal(client.calls.testConnection, 0);
      assert.equal(client.calls.setApiKey.length, 0);
      assert.notEqual(dom.doc.getElementById("ai-status")?.dataset.status, "connected");
    } finally {
      dom.restore();
    }
  });

  it("동의 후 입력 키를 저장하고 연결 테스트를 통과하면 connected 배지를 표시한다", async () => {
    const dom = installDom();
    try {
      const client = stubClient({ initialKey: null });
      const { panel, activities, consentCalls } = buildPanel(client);
      dom.input.value = "sk-typed-key";
      await panel.test();

      assert.equal(consentCalls(), 1);
      assert.deepEqual(client.calls.setApiKey, ["sk-typed-key"]);
      assert.equal(client.calls.testConnection, 1);
      assert.equal(dom.input.value, "");
      assert.equal(dom.input.placeholder, "저장된 API 키 유지");
      assert.equal(dom.doc.getElementById("ai-status")?.dataset.status, "connected");
      assert.equal(dom.aiLabel.textContent, "GPT Image 2 연결됨");
      assert.equal(dom.speechLabel.textContent, "AI 연결 준비됨");
      assert.ok(activities.some(([level, message]) =>
        level === "success" && message === "OpenAI GPT Image 2 연결 테스트를 통과했습니다."));
    } finally {
      dom.restore();
    }
  });

  it("입력이 없어도 저장 호출 없이 연결 테스트를 수행한다", async () => {
    const dom = installDom();
    try {
      const client = stubClient({ initialKey: "sk-stored" });
      const { panel } = buildPanel(client);
      dom.input.value = "";
      await panel.test();

      assert.equal(client.calls.setApiKey.length, 0);
      assert.equal(client.calls.testConnection, 1);
      assert.equal(dom.doc.getElementById("ai-status")?.dataset.status, "connected");
      assert.equal(dom.aiLabel.textContent, "GPT Image 2 연결됨");
    } finally {
      dom.restore();
    }
  });
});
