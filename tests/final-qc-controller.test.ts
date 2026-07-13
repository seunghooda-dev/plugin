// 최종 QC 컨트롤러의 DOM 렌더링·waiver 승인·보고서 저장 흐름을 검증하는 테스트
import assert from "node:assert/strict";
import Module from "node:module";
import { describe, it } from "node:test";

import { createAssetRightsReport, normalizeAssetRightsRecord } from "../src/asset-rights";
import { FinalQCController } from "../src/final-qc-controller";
import type { FinalQCReport, FinalQCSnapshot } from "../src/final-qc";

type FakeListener = (event: unknown) => unknown;

class FakeElement {
  id = "";
  value = "";
  disabled = false;
  textContent = "";
  className = "";
  parentElement: FakeElement | null = null;
  readonly children: FakeElement[] = [];
  private readonly listeners = new Map<string, Set<FakeListener>>();
  private readonly attributes = new Map<string, string>();

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

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "id") this.id = value;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  emit(type: string): void {
    this.listeners.get(type)?.forEach((listener) => listener({}));
  }
}

class FakeDocument {
  private readonly elements = new Map<string, FakeElement>();

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }

  getElementById(id: string): FakeElement | null {
    return this.elements.get(id) ?? null;
  }

  add(id: string, tagName = "div"): FakeElement {
    const node = new FakeElement(tagName);
    node.id = id;
    this.elements.set(id, node);
    return node;
  }
}

function controllerDom(options: { withResults?: boolean } = {}): FakeDocument {
  const dom = new FakeDocument();
  dom.add("final-qc-run-btn", "button");
  dom.add("final-qc-waive-btn", "button").disabled = true;
  dom.add("final-qc-json-btn", "button").disabled = true;
  dom.add("final-qc-md-btn", "button").disabled = true;
  if (options.withResults !== false) dom.add("final-qc-results");
  dom.add("final-qc-gate", "span");
  dom.add("final-qc-summary", "p");
  dom.add("final-qc-waiver-code", "select");
  dom.add("final-qc-waiver-reason", "input");
  return dom;
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

type ModuleLoader = (request: string, parent: unknown, isMain: boolean) => unknown;
const moduleInternals = Module as unknown as { _load: ModuleLoader };

/** 컨트롤러 내부의 require("uxp")만 가로채고 나머지 모듈 로딩은 그대로 통과시킨다. */
async function withUxpModule<T>(uxpModule: unknown, task: () => Promise<T>): Promise<T> {
  const originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) =>
    request === "uxp" ? uxpModule : originalLoad.call(Module, request, parent, isMain);
  try {
    return await task();
  } finally {
    moduleInternals._load = originalLoad;
  }
}

interface UxpSaveHarness {
  uxp: unknown;
  saves: Array<{ name: string; options: unknown }>;
  writes: Array<{ data: string; format: unknown }>;
}

function uxpSaveHarness(pick: boolean): UxpSaveHarness {
  const saves: Array<{ name: string; options: unknown }> = [];
  const writes: Array<{ data: string; format: unknown }> = [];
  const uxp = {
    storage: {
      formats: { utf8: "utf8-format" },
      localFileSystem: {
        getFileForSaving: async (name: string, options: unknown) => {
          saves.push({ name, options });
          if (!pick) return null;
          return {
            name,
            write: async (data: string, writeOptions?: { format?: unknown }) => {
              writes.push({ data, format: writeOptions?.format });
            },
          };
        },
      },
    },
  };
  return { uxp, saves, writes };
}

function healthySnapshot(): FinalQCSnapshot {
  return {
    platform: "youtube-shorts",
    sequence: {
      name: "ShortFlow_Final",
      width: 1080,
      height: 1920,
      duration: 30,
      frameRate: 29.97,
      videoTrackCount: 1,
      audioTrackCount: 1,
    },
    captions: [
      {
        id: "caption-1",
        text: "안녕하세요",
        start: 0,
        end: 2,
        rect: { x: 0.12, y: 0.55, width: 0.55, height: 0.1 },
      },
    ],
    safeZoneElements: [],
    audio: {
      truePeakDbtp: -2,
      clippedSampleCount: 0,
      longestSilenceSeconds: 0.5,
      totalSilenceSeconds: 1,
      dialogueLufs: -16,
      bgmLufs: -24,
    },
    media: {
      offlineMedia: [],
      missingFonts: [],
      missingAssets: [],
      guideOverlays: [],
      rightsReport: createAssetRightsReport([
        normalizeAssetRightsRecord({
          assetId: "c:/assets/music/hook.wav",
          assetName: "hook.wav",
          kind: "music",
          source: "Artlist",
          license: "Creator Pro",
          commercialUse: "allowed",
          expiresAt: "2027-07-11",
          attribution: "Music: hook.wav, Artlist, Creator Pro",
          updatedAt: 1_750_000_000_000,
        }),
      ], 1_750_000_000_000),
    },
    output: {
      fileName: "ShortFlow_Final.mp4",
      directoryPath: "C:\\Exports",
      exists: false,
    },
  };
}

interface ControllerHarness {
  controller: FinalQCController;
  reports: FinalQCReport[];
  activities: string[];
  errors: Array<{ context: string; message: string }>;
  snapshotCalls: () => number;
}

function harness(provide: () => FinalQCSnapshot | Promise<FinalQCSnapshot>): ControllerHarness {
  const reports: FinalQCReport[] = [];
  const activities: string[] = [];
  const errors: Array<{ context: string; message: string }> = [];
  let calls = 0;
  const controller = new FinalQCController({
    getSnapshot: async () => {
      calls += 1;
      return provide();
    },
    onReport: (report) => { reports.push(report); },
    onActivity: (message) => { activities.push(message); },
    onError: (error, context) => {
      errors.push({ context, message: error instanceof Error ? error.message : String(error) });
    },
  });
  return { controller, reports, activities, errors, snapshotCalls: () => calls };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function click(dom: FakeDocument, id: string): Promise<void> {
  const node = dom.getElementById(id);
  assert.ok(node, `테스트 DOM에 #${id} 요소가 필요합니다.`);
  node.emit("click");
  await flush();
}

function rowHeadings(dom: FakeDocument): string[] {
  const results = dom.getElementById("final-qc-results");
  assert.ok(results, "결과 컨테이너가 있어야 합니다.");
  return results.children.map((row) => row.children[1]?.children[0]?.textContent ?? "");
}

describe("FinalQCController DOM 통합", () => {
  it("run 버튼이 스냅샷을 평가해 결과 행과 통과 배지를 렌더링한다", async () => {
    const dom = controllerDom();
    await withDocument(dom, async () => {
      const built = harness(() => healthySnapshot());
      built.controller.initialize();
      const initialReport = built.controller.report;
      assert.equal(initialReport, null);
      await click(dom, "final-qc-run-btn");

      assert.equal(built.snapshotCalls(), 1);
      const report = built.controller.report;
      assert.ok(report, "실행 후에는 보고서가 있어야 합니다.");
      assert.equal(report.blocking, false);
      assert.equal(report.status, "pass");
      const results = dom.getElementById("final-qc-results");
      assert.ok(results);
      assert.equal(results.children.length, report.checks.length);
      assert.equal(results.children[0]?.className.startsWith("final-qc-row is-"), true);
      assert.equal(results.children[0]?.children[0]?.getAttribute("aria-hidden"), "true");
      const gate = dom.getElementById("final-qc-gate");
      assert.equal(gate?.textContent, "통과");
      assert.equal(gate?.className, "neutral-badge badge-success");
      assert.equal(
        dom.getElementById("final-qc-summary")?.textContent,
        `PASS ${report.counts.pass} · WARNING 0 · ERROR 0`,
      );
      assert.equal(dom.getElementById("final-qc-json-btn")?.disabled, false);
      assert.equal(dom.getElementById("final-qc-md-btn")?.disabled, false);
      assert.equal(dom.getElementById("final-qc-waive-btn")?.disabled, true);
      assert.equal(dom.getElementById("final-qc-waiver-code")?.children.length, 0);
      assert.equal(built.reports.length, 1);
      assert.equal(built.reports[0], report);
      assert.match(built.activities[0] ?? "", /최종 QC 통과 · 오류 0 · 경고 0/u);
      assert.equal(built.errors.length, 0);
    });
  });

  it("차단 보고서를 hard-block 표시와 waiver 후보 목록으로 렌더링한다", async () => {
    const dom = controllerDom();
    await withDocument(dom, async () => {
      const built = harness(() => {
        const snapshot = healthySnapshot();
        snapshot.sequence.frameRate = 12;
        snapshot.audio.truePeakDbtp = -0.5;
        snapshot.media.offlineMedia = ["clip.mov"];
        return snapshot;
      });
      built.controller.initialize();
      await click(dom, "final-qc-run-btn");

      const report = built.controller.report;
      assert.ok(report);
      assert.equal(report.blocking, true);
      assert.deepEqual(report.blockingCodes, ["frame-rate", "audio-true-peak", "offline-media"]);
      const gate = dom.getElementById("final-qc-gate");
      assert.equal(gate?.textContent, "내보내기 차단 · 3");
      assert.equal(gate?.className, "neutral-badge badge-error");

      const headings = rowHeadings(dom);
      const offlineIndex = headings.findIndex((text) => text.startsWith("offline-media"));
      assert.ok(offlineIndex >= 0, "offline-media 행이 렌더링되어야 합니다.");
      assert.match(headings[offlineIndex] ?? "", /· HARD BLOCK$/u);
      const offlineRow = dom.getElementById("final-qc-results")?.children[offlineIndex];
      assert.equal(offlineRow?.className, "final-qc-row is-error");
      assert.equal(offlineRow?.children[0]?.textContent, "×");

      const select = dom.getElementById("final-qc-waiver-code");
      assert.deepEqual(
        select?.children.map((option) => option.value),
        ["frame-rate", "audio-true-peak"],
        "hard-block 오류는 waiver 후보에서 제외되어야 합니다.",
      );
      assert.match(select?.children[0]?.textContent ?? "", /^frame-rate · /u);
      assert.equal(dom.getElementById("final-qc-waive-btn")?.disabled, false);
      assert.match(built.activities[0] ?? "", /최종 QC 차단 · 오류 3 · 경고 0/u);
    });
  });

  it("waiver 승인 후 재실행해 조건부 통과로 바뀌고 같은 코드는 교체된다", async () => {
    const dom = controllerDom();
    await withDocument(dom, async () => {
      const built = harness(() => {
        const snapshot = healthySnapshot();
        snapshot.sequence.frameRate = 12;
        return snapshot;
      });
      built.controller.initialize();
      await click(dom, "final-qc-run-btn");
      assert.equal(built.controller.report?.blocking, true);

      const select = dom.getElementById("final-qc-waiver-code");
      const reason = dom.getElementById("final-qc-waiver-reason");
      assert.ok(select && reason);
      select.value = "frame-rate";
      reason.value = "스톱모션 원본 유지";
      await click(dom, "final-qc-waive-btn");

      assert.equal(built.snapshotCalls(), 2);
      const waived = built.controller.report;
      assert.ok(waived);
      assert.equal(waived.blocking, false);
      assert.equal(waived.status, "warning");
      assert.deepEqual(waived.acceptedWaivers.map((item) => item.reason), ["스톱모션 원본 유지"]);
      const gate = dom.getElementById("final-qc-gate");
      assert.equal(gate?.textContent, "조건부 통과");
      assert.equal(gate?.className, "neutral-badge badge-warning");
      const headings = rowHeadings(dom);
      const frameRateIndex = headings.findIndex((text) => text.startsWith("frame-rate"));
      assert.ok(frameRateIndex >= 0);
      assert.match(headings[frameRateIndex] ?? "", /· WAIVED$/u);
      const frameRateRow = dom.getElementById("final-qc-results")?.children[frameRateIndex];
      assert.equal(frameRateRow?.className, "final-qc-row is-error is-waived");
      assert.equal(reason.value, "", "승인 후 사유 입력은 비워져야 합니다.");
      assert.equal(select.children.length, 0);
      assert.equal(dom.getElementById("final-qc-waive-btn")?.disabled, true);
      assert.match(built.activities[1] ?? "", /최종 QC 통과 · 오류 1 · 경고 0/u);

      select.value = "frame-rate";
      reason.value = "새로운 대체 사유";
      await click(dom, "final-qc-waive-btn");
      assert.equal(built.snapshotCalls(), 3);
      assert.deepEqual(
        built.controller.report?.acceptedWaivers.map((item) => item.reason),
        ["새로운 대체 사유"],
        "같은 코드 waiver는 최신 사유로 교체되어야 합니다.",
      );
      assert.equal(built.errors.length, 0);
    });
  });

  it("실행 전 waiver·저장 버튼 클릭은 안내 오류를 onError로 보고한다", async () => {
    const dom = controllerDom();
    await withDocument(dom, async () => {
      const built = harness(() => healthySnapshot());
      built.controller.initialize();
      await click(dom, "final-qc-waive-btn");
      await click(dom, "final-qc-json-btn");
      await click(dom, "final-qc-md-btn");

      assert.equal(built.snapshotCalls(), 0);
      assert.equal(built.controller.report, null);
      assert.deepEqual(built.errors.map((item) => item.context), [
        "QC 예외 승인 실패",
        "QC JSON 저장 실패",
        "QC Markdown 저장 실패",
      ]);
      assert.match(built.errors[0]?.message ?? "", /먼저 최종 QC를 실행/u);
      assert.match(built.errors[1]?.message ?? "", /저장할 최종 QC 보고서가 없습니다/u);
      assert.match(built.errors[2]?.message ?? "", /저장할 최종 QC 보고서가 없습니다/u);
    });
  });

  it("빈 waiver 코드와 짧은 사유는 재실행 없이 거부한다", async () => {
    const dom = controllerDom();
    await withDocument(dom, async () => {
      const built = harness(() => {
        const snapshot = healthySnapshot();
        snapshot.sequence.frameRate = 12;
        return snapshot;
      });
      built.controller.initialize();
      await click(dom, "final-qc-run-btn");
      const select = dom.getElementById("final-qc-waiver-code");
      const reason = dom.getElementById("final-qc-waiver-reason");
      assert.ok(select && reason);

      select.value = "";
      reason.value = "충분히 긴 사유입니다";
      await click(dom, "final-qc-waive-btn");
      assert.match(built.errors[0]?.message ?? "", /예외 승인 가능한 오류가 없습니다/u);

      select.value = "frame-rate";
      reason.value = "짧음";
      await click(dom, "final-qc-waive-btn");
      assert.match(built.errors[1]?.message ?? "", /5자 이상 입력/u);
      assert.equal(reason.value, "짧음", "거부된 사유 입력은 지워지지 않아야 합니다.");
      assert.equal(built.snapshotCalls(), 1);
      assert.equal(built.controller.report?.blocking, true);
    });
  });

  it("스냅샷 수집 실패는 onError로 보고되고 이전 보고서를 유지한다", async () => {
    const dom = controllerDom();
    await withDocument(dom, async () => {
      let failing = false;
      const built = harness(() => {
        if (failing) throw new Error("시퀀스 스냅샷 수집 실패");
        return healthySnapshot();
      });
      built.controller.initialize();
      await click(dom, "final-qc-run-btn");
      const firstReport = built.controller.report;
      assert.ok(firstReport);

      failing = true;
      await click(dom, "final-qc-run-btn");
      assert.equal(built.errors.length, 1);
      assert.equal(built.errors[0]?.context, "최종 QC 실행 실패");
      assert.match(built.errors[0]?.message ?? "", /스냅샷 수집 실패/u);
      assert.equal(built.controller.report, firstReport);
      assert.equal(built.reports.length, 1);
    });
  });

  it("ensureExportAllowed는 차단 시 차단 코드를 포함해 거부하고 통과 시 보고서를 돌려준다", async () => {
    const dom = controllerDom();
    await withDocument(dom, async () => {
      let broken = true;
      const built = harness(() => {
        const snapshot = healthySnapshot();
        if (broken) snapshot.media.offlineMedia = ["clip.mov"];
        return snapshot;
      });
      built.controller.initialize();
      await assert.rejects(
        built.controller.ensureExportAllowed(),
        /최종 QC가 내보내기를 차단했습니다: offline-media/u,
      );
      broken = false;
      const allowed = await built.controller.ensureExportAllowed();
      assert.equal(allowed.blocking, false);
      assert.equal(built.snapshotCalls(), 2);
      assert.equal(built.reports.length, 2);
    });
  });

  it("UXP 파일 저장으로 JSON·Markdown 보고서를 기록하고 활동을 남긴다", async () => {
    const dom = controllerDom();
    await withDocument(dom, async () => {
      const built = harness(() => healthySnapshot());
      built.controller.initialize();
      await click(dom, "final-qc-run-btn");
      const save = uxpSaveHarness(true);
      await withUxpModule(save.uxp, async () => {
        await click(dom, "final-qc-json-btn");
        await click(dom, "final-qc-md-btn");
      });

      assert.deepEqual(save.saves.map((item) => item.name), [
        "ShortFlow_Final_QC.json",
        "ShortFlow_Final_QC.md",
      ]);
      assert.deepEqual(save.saves[0]?.options, { types: ["json"] });
      assert.deepEqual(save.saves[1]?.options, { types: ["md"] });
      assert.equal(save.writes.length, 2);
      assert.equal(save.writes[0]?.format, "utf8-format");
      const parsed = JSON.parse(save.writes[0]?.data ?? "") as { schemaVersion?: number; blocking?: boolean };
      assert.equal(parsed.schemaVersion, 1);
      assert.equal(parsed.blocking, false);
      assert.match(save.writes[1]?.data ?? "", /^# ShortFlow 최종 QC/u);
      assert.match(built.activities[1] ?? "", /최종 QC JSON 보고서를 저장했습니다: ShortFlow_Final_QC\.json/u);
      assert.match(built.activities[2] ?? "", /최종 QC MD 보고서를 저장했습니다: ShortFlow_Final_QC\.md/u);
      assert.equal(built.errors.length, 0);
    });
  });

  it("저장 대화상자를 취소하면 파일 기록과 오류 없이 종료한다", async () => {
    const dom = controllerDom();
    await withDocument(dom, async () => {
      const built = harness(() => healthySnapshot());
      built.controller.initialize();
      await click(dom, "final-qc-run-btn");
      const save = uxpSaveHarness(false);
      await withUxpModule(save.uxp, async () => {
        await click(dom, "final-qc-json-btn");
      });
      assert.equal(save.saves.length, 1);
      assert.equal(save.writes.length, 0);
      assert.equal(built.errors.length, 0);
      assert.equal(built.activities.length, 1, "실행 활동만 남아야 합니다.");
    });
  });

  it("UXP 모듈이 없는 환경에서는 저장 실패가 onError로 전달된다", async () => {
    const dom = controllerDom();
    await withDocument(dom, async () => {
      const built = harness(() => healthySnapshot());
      built.controller.initialize();
      await click(dom, "final-qc-run-btn");
      await click(dom, "final-qc-json-btn");
      assert.equal(built.errors.length, 1);
      assert.equal(built.errors[0]?.context, "QC JSON 저장 실패");
      assert.match(built.errors[0]?.message ?? "", /uxp/iu);
    });
  });

  it("필수 결과 요소가 없으면 run이 거부되고 onReport가 호출되지 않는다", async () => {
    const dom = controllerDom({ withResults: false });
    await withDocument(dom, async () => {
      const built = harness(() => healthySnapshot());
      built.controller.initialize();
      await assert.rejects(built.controller.run(), /#final-qc-results/u);
      assert.equal(built.reports.length, 0);
    });
  });

  it("바인딩할 요소가 하나도 없어도 initialize는 조용히 통과한다", async () => {
    const dom = new FakeDocument();
    await withDocument(dom, async () => {
      const built = harness(() => healthySnapshot());
      built.controller.initialize();
      assert.equal(built.controller.report, null);
      assert.equal(built.errors.length, 0);
    });
  });
});
