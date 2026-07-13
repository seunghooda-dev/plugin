// 시스템 진단 실행·렌더와 민감정보 제거 JSON 내보내기 UI를 담당하는 패널 모듈
import {
  assertDiagnosticRedactionSelfCheck,
  buildDiagnosticsReport,
  diagnosticBundleToJSON,
  readRuntimeMember as moduleMember,
  type DiagnosticStatus,
  type DiagnosticsReport,
} from "./diagnostics";
import { optionalElement, toast } from "./ui";

export interface DiagnosticsPanelOptions {
  runBusy: <T>(message: string, task: () => Promise<T>) => Promise<T>;
  onActivity: (level: "success" | "warning", message: string) => void;
  /** settings·워크스페이스·복구 저널 요약은 index.ts 전역을 집계하므로 getter로 주입한다. */
  getLocalContext: () => Record<string, unknown>;
}

function hostModule(moduleName: string): Record<string, unknown> | null {
  try {
    const value = require(moduleName) as unknown;
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function asDiagnosticString(value: unknown, fallback = "unknown"): string {
  if (typeof value === "string" || typeof value === "number") {
    const text = String(value).trim();
    if (text) return text.slice(0, 80);
  }
  return fallback;
}

function diagnosticsStatusLabel(status: DiagnosticStatus): string {
  return status === "green" ? "정상" : status === "yellow" ? "확인 필요" : "차단";
}

async function collectDiagnosticsReport(): Promise<DiagnosticsReport> {
  const uxpRoot = hostModule("uxp");
  const premiere = hostModule("premierepro");
  const secureStorage = moduleMember(uxpRoot, "secureStorage") ?? moduleMember(uxpRoot, "storage", "secureStorage");
  const filesystem = moduleMember(uxpRoot, "storage", "localFileSystem");
  const hostVersion = moduleMember(uxpRoot, "host", "version");
  const uxpVersion = moduleMember(uxpRoot, "versions", "uxp") ?? moduleMember(uxpRoot, "version");
  return buildDiagnosticsReport({
    getHostInfo: () => ({
      name: asDiagnosticString(moduleMember(uxpRoot, "host", "name"), "Adobe Premiere Pro"),
      version: asDiagnosticString(hostVersion),
      build: asDiagnosticString(moduleMember(uxpRoot, "host", "build"), ""),
    }),
    getUxpInfo: () => ({ version: asDiagnosticString(uxpVersion) }),
    getOsInfo: () => ({
      platform: asDiagnosticString(moduleMember(uxpRoot, "os", "platform"), navigator.platform || "unknown"),
      version: asDiagnosticString(moduleMember(uxpRoot, "os", "version"), ""),
      arch: asDiagnosticString(moduleMember(uxpRoot, "os", "architecture"), ""),
    }),
    getRuntimeInfo: () => ({ pluginVersion: "1.0.0", locale: navigator.language, online: navigator.onLine }),
    capabilities: {
      transcript: () => ({
        available: Boolean(moduleMember(premiere, "Transcript")),
        detail: "Transcript API 공개 여부를 확인했습니다.",
      }),
      encoder: () => ({
        available: typeof moduleMember(premiere, "EncoderManager", "getManager") === "function",
        detail: "EncoderManager 공개 API를 확인했습니다.",
      }),
      secureStorage: () => ({
        available: Boolean(secureStorage),
        detail: "UXP Secure Storage 사용 가능 여부를 확인했습니다.",
      }),
      network: () => ({ available: typeof fetch === "function", detail: "UXP 네트워크 런타임을 확인했습니다." }),
      filesystem: () => ({
        available: typeof moduleMember(filesystem as Record<string, unknown> | null, "getDataFolder") === "function",
        detail: "UXP Local File System 사용 가능 여부를 확인했습니다.",
      }),
    },
    apis: [
      { name: "Project.getActiveProject", value: moduleMember(premiere, "Project", "getActiveProject"), required: true },
      { name: "SequenceEditor.getEditor", value: moduleMember(premiere, "SequenceEditor", "getEditor"), required: true },
      { name: "EncoderManager.getManager", value: moduleMember(premiere, "EncoderManager", "getManager"), required: true },
      { name: "secureStorage.getItem", value: moduleMember(secureStorage as Record<string, unknown> | null, "getItem"), required: true },
    ],
  });
}

export function createDiagnosticsPanel(options: DiagnosticsPanelOptions): {
  run(): Promise<void>;
  exportJson(): Promise<void>;
  render(report: DiagnosticsReport | null): void;
} {
  let diagnosticsReport: DiagnosticsReport | null = null;

  function render(report: DiagnosticsReport | null): void {
    const summary = optionalElement<HTMLElement>("diagnostics-summary");
    const list = optionalElement<HTMLElement>("diagnostics-list");
    const exportButton = optionalElement<HTMLButtonElement>("export-diagnostics-btn");
    if (exportButton) exportButton.disabled = !report;
    if (!summary || !list) return;
    if (!report) {
      summary.className = "diagnostics-summary is-idle";
      summary.textContent = "아직 진단을 실행하지 않았습니다.";
      list.replaceChildren();
      return;
    }
    summary.className = `diagnostics-summary is-${report.overall}`;
    summary.textContent = report.compatible
      ? `호환성 ${diagnosticsStatusLabel(report.overall)} · Premiere ${report.host.version} · UXP ${report.uxp.version}`
      : `호환성 차단 · Premiere ${report.minimumHostVersion} 이상과 필수 API를 확인해 주세요.`;
    list.replaceChildren();
    for (const check of report.checks) {
      const row = document.createElement("div");
      row.className = `diagnostic-row is-${check.status}`;
      const state = document.createElement("span");
      state.className = "diagnostic-state";
      state.textContent = diagnosticsStatusLabel(check.status);
      const copy = document.createElement("div");
      const label = document.createElement("strong");
      label.textContent = check.label;
      const message = document.createElement("small");
      message.textContent = `${check.message}${check.version ? ` · ${check.version}` : ""}${check.replacement ? ` · 대체: ${check.replacement}` : ""}`;
      copy.append(label, message);
      row.append(state, copy);
      list.append(row);
    }
  }

  async function run(): Promise<void> {
    const report = await options.runBusy("Premiere UXP 호환성을 진단하고 있습니다…", collectDiagnosticsReport);
    diagnosticsReport = report;
    render(report);
    options.onActivity(report.compatible ? "success" : "warning", `시스템 진단 완료 · ${diagnosticsStatusLabel(report.overall)} · ${report.checks.length}개 항목`);
    toast(
      report.compatible ? "시스템 진단을 완료했습니다." : "필수 호환성 항목을 확인해 주세요.",
      report.compatible ? "success" : "warning",
    );
  }

  async function exportJson(): Promise<void> {
    const report = diagnosticsReport;
    if (!report) throw new Error("먼저 시스템 진단을 실행해 주세요.");
    assertDiagnosticRedactionSelfCheck();
    const uxpRoot = hostModule("uxp");
    const fileSystem = moduleMember(uxpRoot, "storage", "localFileSystem") as {
      getFileForSaving?: (name: string, options: { types: string[] }) => Promise<unknown>;
    } | undefined;
    const file = await fileSystem?.getFileForSaving?.(
      `ShortFlow_Diagnostics_${new Date().toISOString().replace(/[^\d]/gu, "").slice(0, 14)}.json`,
      { types: ["json"] },
    ) as { write?: (value: string, options?: unknown) => Promise<void> } | null | undefined;
    if (!file?.write) throw new Error("진단 JSON을 저장할 UXP 파일 시스템을 사용할 수 없습니다.");
    const payload = diagnosticBundleToJSON({
      report,
      context: {
        ...options.getLocalContext(),
        reportPurpose: "user-initiated-local-export",
      },
    });
    await file.write(payload, { format: moduleMember(uxpRoot, "storage", "formats", "utf8") });
    options.onActivity("success", "개인정보를 제거한 시스템 진단 JSON을 저장했습니다.");
    toast("익명화된 진단 JSON을 저장했습니다.", "success");
  }

  return { run, exportJson, render };
}
