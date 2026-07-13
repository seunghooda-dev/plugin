// 시퀀스 QC 실행·숏폼 생성·마커 검색/일괄 생성·HOOK/CTA 스토리 마커 UI를 담당하는 패널 모듈
import { formatDuration, type MarkerSegment, type QCItem } from "./core";
import type { CreateShortOptions, CreateShortResult, SequenceStatus } from "./premiere";
import { element, renderEmptyState, setText, toast } from "./ui";

export interface MarkersQcPanelOptions {
  runBusy: <T>(message: string, task: () => Promise<T>) => Promise<T>;
  onActivity: (level: "info" | "success" | "warning" | "error", message: string) => void;
  /** 설정은 index.ts 소유 — UI 동기화 후 이 패널이 쓰는 필드만 돌려받는다. */
  syncSettings: () => {
    width: number;
    height: number;
    maxDuration: number;
    hookSeconds: number;
    ctaSeconds: number;
  };
  getCreateOptions: () => CreateShortOptions;
  renderStatus: (status: SequenceStatus) => void;
  refreshStatus: (silent: boolean) => Promise<unknown>;
  /** Premiere 작업은 src/premiere.ts 어댑터를 index.ts가 주입한다(타입만 import). */
  runSequenceQC: (width: number, height: number, maxDuration: number) => Promise<{ status: SequenceStatus; items: QCItem[] }>;
  createShort: (options: CreateShortOptions) => Promise<CreateShortResult>;
  scanShortMarkers: (defaultDuration: number) => Promise<MarkerSegment[]>;
  createShortsFromMarkers: (
    segments: MarkerSegment[],
    options: CreateShortOptions,
    onProgress: (completed: number, total: number, name: string) => void,
  ) => Promise<{ created: CreateShortResult[]; failures: Array<{ name: string; error: string }> }>;
  addStoryMarkers: (hookSeconds: number, ctaSeconds: number) => Promise<number>;
}

function qcIcon(level: QCItem["level"]): string {
  return level === "pass" ? "✓" : level === "warning" ? "!" : "×";
}

function renderQC(items: QCItem[]): void {
  const target = element<HTMLElement>("qc-results");
  target.className = "qc-result-list";
  target.replaceChildren();
  for (const result of items) {
    const item = document.createElement("div");
    item.className = `qc-result qc-${result.level}`;
    const icon = document.createElement("span");
    icon.className = "qc-result-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = qcIcon(result.level);
    const message = document.createElement("span");
    message.textContent = result.message;
    item.append(icon, message);
    target.append(item);
  }
  const badge = target.closest(".result-card")?.querySelector<HTMLElement>(".neutral-badge");
  if (badge) {
    const errors = items.filter((item) => item.level === "error").length;
    const warnings = items.filter((item) => item.level === "warning").length;
    badge.textContent = errors ? `오류 ${errors}` : warnings ? `경고 ${warnings}` : "통과";
    badge.className = `neutral-badge ${errors ? "badge-error" : warnings ? "badge-warning" : "badge-success"}`;
  }
}

function renderMarkers(segments: MarkerSegment[]): void {
  const target = element<HTMLElement>("marker-list");
  const button = element<HTMLButtonElement>("batch-create-btn");
  if (!segments.length) {
    renderEmptyState(target, "ShortFlow 마커가 없습니다", "마커 이름에 SHORT, 숏폼 또는 #SF를 포함해 주세요.");
    button.disabled = true;
    return;
  }
  target.replaceChildren();
  segments.forEach((segment, index) => {
    const label = document.createElement("label");
    label.className = "marker-item";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.dataset.segmentIndex = String(index);
    const copy = document.createElement("span");
    copy.className = "marker-copy";
    const title = document.createElement("strong");
    title.textContent = segment.name;
    const detail = document.createElement("small");
    detail.textContent = `${formatDuration(segment.start)} → ${formatDuration(segment.end)} · ${formatDuration(segment.duration)}`;
    copy.append(title, detail);
    label.append(checkbox, copy);
    target.append(label);
  });
  button.disabled = false;
}

export function createMarkersQcPanel(options: MarkersQcPanelOptions): {
  runQC(): Promise<void>;
  createShort(): Promise<void>;
  scanMarkers(): Promise<void>;
  batchCreate(): Promise<void>;
  addStoryMarkers(): Promise<void>;
} {
  let markerSegments: MarkerSegment[] = [];

  function selectedMarkerSegments(): MarkerSegment[] {
    const checkboxes = document.querySelectorAll<HTMLInputElement>("#marker-list input[data-segment-index]");
    if (checkboxes.length === 0) return markerSegments;
    const indexes = new Set(
      [...checkboxes]
        .filter((checkbox) => checkbox.checked)
        .map((checkbox) => Number(checkbox.dataset.segmentIndex)),
    );
    return markerSegments.filter((_segment, index) => indexes.has(index));
  }

  async function runQC(): Promise<void> {
    const current = options.syncSettings();
    const startedAt = Date.now();
    await options.runBusy("시퀀스 QC를 검사하고 있습니다…", async () => {
      const result = await options.runSequenceQC(current.width, current.height, current.maxDuration);
      renderQC(result.items);
      options.renderStatus(result.status);
      const errors = result.items.filter((item) => item.level === "error").length;
      const warnings = result.items.filter((item) => item.level === "warning").length;
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      options.onActivity(
        errors ? "error" : warnings ? "warning" : "success",
        `QC 완료 · 오류 ${errors} · 경고 ${warnings} · ${elapsedMs.toLocaleString("ko-KR")}ms`,
      );
      toast(errors ? "QC 오류를 확인해 주세요." : warnings ? "QC 경고가 있습니다." : "QC를 통과했습니다.", errors ? "error" : warnings ? "warning" : "success");
    });
  }

  async function createShort(): Promise<void> {
    const createShortOptions = options.getCreateOptions();
    await options.runBusy("원본을 복제하고 숏폼 시퀀스를 생성하고 있습니다…", async () => {
      const result = await options.createShort(createShortOptions);
      options.onActivity("success", `${result.sequenceName} 생성 · ${result.width}×${result.height} · ${formatDuration(result.range.duration)}`);
      if (result.warnings.length) {
        options.onActivity("warning", result.warnings.join(" "));
      }
      toast("숏폼 시퀀스를 생성했습니다.", "success");
      await options.refreshStatus(true);
    });
  }

  async function scanMarkers(): Promise<void> {
    const current = options.syncSettings();
    markerSegments = await options.runBusy("숏폼 마커를 검색하고 있습니다…", () => options.scanShortMarkers(current.maxDuration));
    renderMarkers(markerSegments);
    options.onActivity("info", `숏폼 마커 구간 ${markerSegments.length}개 검색`);
  }

  async function batchCreate(): Promise<void> {
    const selected = selectedMarkerSegments();
    if (!selected.length) {
      toast("일괄 생성할 마커 구간을 선택해 주세요.", "warning");
      return;
    }
    const createShortOptions = options.getCreateOptions();
    const result = await options.runBusy(`${selected.length}개 마커 구간을 생성하고 있습니다…`, () =>
      options.createShortsFromMarkers(selected, createShortOptions, (completed, total, name) => {
        setText("busy-message", `${completed}/${total} · ${name}`);
      }));
    options.onActivity("success", `마커 구간 일괄 생성 완료 · 성공 ${result.created.length} · 실패 ${result.failures.length}`);
    result.failures.forEach((failure) => options.onActivity("error", `${failure.name}: ${failure.error}`));
    toast(`${result.created.length}개 숏폼 시퀀스를 생성했습니다.`, result.failures.length ? "warning" : "success");
    await options.refreshStatus(true);
  }

  async function addStoryMarkers(): Promise<void> {
    const current = options.syncSettings();
    const count = await options.runBusy("HOOK/CTA 마커를 추가하고 있습니다…", () =>
      options.addStoryMarkers(current.hookSeconds, current.ctaSeconds));
    options.onActivity("success", `스토리 마커 ${count}개 추가`);
    toast("HOOK/CTA 마커를 추가했습니다.", "success");
  }

  return { runQC, createShort, scanMarkers, batchCreate, addStoryMarkers };
}
