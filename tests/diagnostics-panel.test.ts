// 진단 패널의 idle/호환/비호환 렌더와 민감정보 제거 JSON 내보내기 흐름을 검증하는 테스트
import assert from "node:assert/strict";
import Module from "node:module";
import { describe, it } from "node:test";

import { createDiagnosticsPanel } from "../src/diagnostics-panel";
import { buildDiagnosticsReport, type DiagnosticsAdapter } from "../src/diagnostics";

type FakeListener = (event: unknown) => unknown;

class FakeElement {
  id = "";
  disabled = false;
  textContent = "";
  className = "";
  parentElement: FakeElement | null = null;
  readonly children: FakeElement[] = [];
  private readonly listeners = new Map<string, Set<FakeListener>>();

  constructor(readonly tagName: string) {}

  addEventListener(type: string, listener: FakeListener): void {
    const set = this.listeners.get(type) ?? new Set<FakeListener>();
    set.add(listener);
    this.listeners.set(type, set);
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

interface DiagnosticsDom {
  doc: FakeDocument;
  summary: FakeElement;
  list: FakeElement;
  exportButton: FakeElement;
  restore(): void;
}

function installDiagnosticsDom(): DiagnosticsDom {
  const doc = new FakeDocument();
  const summary = doc.register("diagnostics-summary", "p");
  const list = doc.register("diagnostics-list");
  const exportButton = doc.register("export-diagnostics-btn", "button");
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
  return {
    doc,
    summary,
    list,
    exportButton,
    restore(): void {
      if (descriptor) Object.defineProperty(globalThis, "document", descriptor);
      else delete (globalThis as { document?: unknown }).document;
    },
  };
}

type ModuleLoader = (request: string, parent: unknown, isMain: boolean) => unknown;
const moduleInternals = Module as unknown as { _load: ModuleLoader };

/** 패널 내부의 require("uxp")/require("premierepro")만 가로채고 나머지는 통과시킨다. */
async function withHostModules<T>(modules: Record<string, unknown>, task: () => Promise<T>): Promise<T> {
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) =>
    Object.prototype.hasOwnProperty.call(modules, request)
      ? modules[request]
      : originalLoad.call(Module, request, parent, isMain);
  try {
    return await task();
  } finally {
    moduleInternals._load = originalLoad;
  }
}

const present = (): void => undefined;

function healthyAdapter(overrides: Partial<DiagnosticsAdapter> = {}): DiagnosticsAdapter {
  return {
    getHostInfo: () => ({ name: "Adobe Premiere Pro", version: "26.3.0" }),
    getUxpInfo: () => ({ version: "8.0.0" }),
    getOsInfo: () => ({ platform: "Windows", version: "11", arch: "x64" }),
    getRuntimeInfo: () => ({ pluginVersion: "1.0.0", locale: "ko-KR", online: true }),
    capabilities: {
      transcript: () => ({ available: true }),
      encoder: () => ({ available: true }),
      secureStorage: () => ({ available: true }),
      network: () => ({ available: true }),
      filesystem: () => ({ available: true }),
    },
    apis: [
      { name: "Project.getActiveProject", value: present, required: true },
      { name: "SequenceEditor.getEditor", value: present, required: true },
      { name: "EncoderManager.getManager", value: present, required: true },
      { name: "secureStorage.getItem", value: present, required: true },
    ],
    ...overrides,
  };
}

interface HostHarness {
  modules: Record<string, unknown>;
  saves: Array<{ name: string; options: unknown }>;
  writes: Array<{ data: string; format: unknown }>;
}

function hostHarness(options: { file?: "default" | "none" } = {}): HostHarness {
  const saves: Array<{ name: string; options: unknown }> = [];
  const writes: Array<{ data: string; format: unknown }> = [];
  const file = options.file === "none"
    ? null
    : { write: async (data: string, writeOptions?: { format?: unknown }) => { writes.push({ data, format: writeOptions?.format }); } };
  const uxp = {
    host: { name: "Adobe Premiere Pro", version: "26.3.0", build: "42" },
    versions: { uxp: "8.0.0" },
    version: "8.0.0",
    os: { platform: "Windows", version: "11", architecture: "x64" },
    secureStorage: { getItem: present },
    storage: {
      formats: { utf8: "utf8-format" },
      secureStorage: { getItem: present },
      localFileSystem: {
        getDataFolder: present,
        getFileForSaving: async (name: string, pickerOptions: unknown) => {
          saves.push({ name, options: pickerOptions });
          return file;
        },
      },
    },
  };
  const premierepro = {
    Transcript: {},
    EncoderManager: { getManager: present },
    Project: { getActiveProject: present },
    SequenceEditor: { getEditor: present },
  };
  return { modules: { uxp, premierepro }, saves, writes };
}

function buildPanel(hooks: {
  onActivity?: (level: string, message: string) => void;
  getLocalContext?: () => Record<string, unknown>;
} = {}): ReturnType<typeof createDiagnosticsPanel> {
  return createDiagnosticsPanel({
    runBusy: (_message, task) => task(),
    onActivity: (level, message) => hooks.onActivity?.(level, message),
    getLocalContext: hooks.getLocalContext ?? (() => ({ workspace: "shorts" })),
  });
}

describe("createDiagnosticsPanel render", () => {
  it("보고서가 없으면 idle 요약과 내보내기 비활성화를 표시한다", () => {
    const dom = installDiagnosticsDom();
    try {
      const panel = buildPanel();
      panel.render(null);
      assert.equal(dom.summary.className, "diagnostics-summary is-idle");
      assert.equal(dom.summary.textContent, "아직 진단을 실행하지 않았습니다.");
      assert.equal(dom.list.children.length, 0);
      assert.equal(dom.exportButton.disabled, true);
    } finally {
      dom.restore();
    }
  });

  it("호환 보고서를 상태별 행과 요약으로 렌더링하고 내보내기를 활성화한다", async () => {
    const dom = installDiagnosticsDom();
    try {
      const report = await buildDiagnosticsReport(healthyAdapter(), () => 1);
      assert.equal(report.compatible, true);
      const panel = buildPanel();
      panel.render(report);

      assert.equal(dom.summary.className, "diagnostics-summary is-green");
      assert.equal(dom.summary.textContent, "호환성 정상 · Premiere 26.3.0 · UXP 8.0.0");
      assert.equal(dom.exportButton.disabled, false);
      assert.equal(dom.list.children.length, report.checks.length);

      const firstRow = dom.list.children[0];
      assert.ok(firstRow);
      assert.equal(firstRow.className, "diagnostic-row is-green");
      assert.equal(firstRow.children[0]?.textContent, "정상");
      assert.equal(firstRow.children[1]?.children[0]?.textContent, "Premiere Pro host");
    } finally {
      dom.restore();
    }
  });

  it("비호환 보고서는 차단 요약을 표시하되 내보내기는 활성화한다", async () => {
    const dom = installDiagnosticsDom();
    try {
      const report = await buildDiagnosticsReport(
        healthyAdapter({ getHostInfo: () => ({ name: "Adobe Premiere Pro", version: "24.0.0" }) }),
        () => 1,
      );
      assert.equal(report.compatible, false);
      const panel = buildPanel();
      panel.render(report);

      assert.equal(dom.summary.className, `diagnostics-summary is-${report.overall}`);
      assert.equal(dom.summary.textContent, "호환성 차단 · Premiere 25.6.0 이상과 필수 API를 확인해 주세요.");
      assert.equal(dom.exportButton.disabled, false);
      assert.equal(dom.list.children.length, report.checks.length);
    } finally {
      dom.restore();
    }
  });

  it("render(null) 반복은 export 버튼만 있고 summary/list가 없어도 안전하다", () => {
    const doc = new FakeDocument();
    const exportButton = doc.register("export-diagnostics-btn", "button");
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
    try {
      const panel = createDiagnosticsPanel({
        runBusy: (_message, task) => task(),
        onActivity: () => undefined,
        getLocalContext: () => ({}),
      });
      assert.doesNotThrow(() => panel.render(null));
      assert.equal(exportButton.disabled, true);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "document", descriptor);
      else delete (globalThis as { document?: unknown }).document;
    }
  });
});

describe("createDiagnosticsPanel run/exportJson", () => {
  it("진단 실행 전 exportJson은 안내 오류로 거부한다", async () => {
    const dom = installDiagnosticsDom();
    try {
      const panel = buildPanel();
      await assert.rejects(panel.exportJson(), /먼저 시스템 진단을 실행해 주세요/u);
    } finally {
      dom.restore();
    }
  });

  it("run은 호스트 모듈로 호환 보고서를 만들고 exportJson은 민감정보를 제거한 JSON을 저장한다", async () => {
    const dom = installDiagnosticsDom();
    try {
      const activities: Array<[string, string]> = [];
      const panel = buildPanel({
        onActivity: (level, message) => { activities.push([level, message]); },
        getLocalContext: () => ({ workspace: "shorts" }),
      });
      const host = hostHarness();

      await withHostModules(host.modules, async () => {
        await panel.run();
        // 호환 보고서이므로 idle이 아닌 요약 + 내보내기 활성화 + 성공 활동이 남는다.
        // (os-runtime 색상은 런타임 navigator 유무에 따라 green/yellow로 갈릴 수 있다.)
        assert.match(dom.summary.className, /^diagnostics-summary is-(green|yellow)$/u);
        assert.equal(dom.exportButton.disabled, false);
        assert.ok(activities.some(([level, message]) =>
          level === "success" && /^시스템 진단 완료 · (정상|확인 필요) · \d+개 항목$/u.test(message)));

        await panel.exportJson();
      });

      assert.equal(host.saves.length, 1);
      assert.match(host.saves[0]?.name ?? "", /^ShortFlow_Diagnostics_\d{14}\.json$/u);
      assert.deepEqual(host.saves[0]?.options, { types: ["json"] });
      assert.equal(host.writes.length, 1);
      assert.equal(host.writes[0]?.format, "utf8-format");
      const parsed = JSON.parse(host.writes[0]?.data ?? "{}") as {
        schemaVersion?: number;
        context?: Record<string, unknown>;
      };
      assert.equal(parsed.schemaVersion, 1);
      assert.equal(parsed.context?.reportPurpose, "user-initiated-local-export");
      assert.ok(activities.some(([level, message]) =>
        level === "success" && message === "개인정보를 제거한 시스템 진단 JSON을 저장했습니다."));
    } finally {
      dom.restore();
    }
  });

  it("실행 후 파일 시스템이 없으면 self-check를 통과한 뒤 저장 단계에서 거부한다", async () => {
    const dom = installDiagnosticsDom();
    try {
      const panel = buildPanel();
      const host = hostHarness({ file: "none" });
      await withHostModules(host.modules, async () => {
        await panel.run();
        await assert.rejects(panel.exportJson(), /UXP 파일 시스템을 사용할 수 없습니다/u);
      });
      // picker는 호출되었지만(=self-check 통과 후 도달) 파일이 없어 write는 없다.
      assert.equal(host.saves.length, 1);
      assert.equal(host.writes.length, 0);
    } finally {
      dom.restore();
    }
  });
});
