import {
  evaluateFinalQC,
  finalQCReportToJSON,
  finalQCReportToMarkdown,
  type FinalQCReport,
  type FinalQCSnapshot,
  type QCWaiver,
} from "./final-qc";
import { bind, element, setText } from "./ui";

interface ReportFile {
  name?: string;
  write(data: string, options?: { format?: unknown }): Promise<unknown>;
}

export interface FinalQCControllerOptions {
  getSnapshot: () => Promise<FinalQCSnapshot>;
  onActivity?: (message: string) => void;
  onError?: (error: unknown, context: string) => void;
  onReport?: (report: FinalQCReport) => void;
}

function icon(level: "pass" | "warning" | "error"): string {
  return level === "pass" ? "✓" : level === "warning" ? "!" : "×";
}

export class FinalQCController {
  private reportValue: FinalQCReport | null = null;
  private waivers: QCWaiver[] = [];

  constructor(private readonly options: FinalQCControllerOptions) {}

  get report(): FinalQCReport | null { return this.reportValue; }

  initialize(): void {
    bind("final-qc-run-btn", "click", () => this.guard(async () => { await this.run(); }, "최종 QC 실행 실패"));
    bind("final-qc-waive-btn", "click", () => this.guard(() => this.addWaiver(), "QC 예외 승인 실패"));
    bind("final-qc-json-btn", "click", () => this.guard(() => this.saveReport("json"), "QC JSON 저장 실패"));
    bind("final-qc-md-btn", "click", () => this.guard(() => this.saveReport("md"), "QC Markdown 저장 실패"));
  }

  async run(): Promise<FinalQCReport> {
    const report = evaluateFinalQC(await this.options.getSnapshot(), this.waivers);
    this.reportValue = report;
    this.render(report);
    this.options.onReport?.(report);
    this.options.onActivity?.(`최종 QC ${report.blocking ? "차단" : "통과"} · 오류 ${report.counts.error} · 경고 ${report.counts.warning}`);
    return report;
  }

  async ensureExportAllowed(): Promise<FinalQCReport> {
    const report = await this.run();
    if (report.blocking) {
      throw new Error(`최종 QC가 내보내기를 차단했습니다: ${report.blockingCodes.join(", ")}`);
    }
    return report;
  }

  private async guard(task: () => void | Promise<void>, context: string): Promise<void> {
    try { await task(); } catch (error) { this.options.onError?.(error, context); }
  }

  private render(report: FinalQCReport): void {
    const target = element<HTMLElement>("final-qc-results");
    target.replaceChildren();
    for (const check of report.checks) {
      const row = document.createElement("div");
      row.className = `final-qc-row is-${check.level}${check.waived ? " is-waived" : ""}`;
      const mark = document.createElement("span");
      mark.className = "final-qc-icon";
      mark.textContent = icon(check.level);
      mark.setAttribute("aria-hidden", "true");
      const copy = document.createElement("div");
      const heading = document.createElement("strong");
      heading.textContent = `${check.code} · ${check.category}${check.hardBlock ? " · HARD BLOCK" : check.waived ? " · WAIVED" : ""}`;
      const message = document.createElement("span");
      message.textContent = check.message;
      copy.append(heading, message);
      row.append(mark, copy);
      target.append(row);
    }
    const badge = element<HTMLElement>("final-qc-gate");
    badge.textContent = report.blocking ? `내보내기 차단 · ${report.blockingCodes.length}` : report.status === "warning" ? "조건부 통과" : "통과";
    badge.className = `neutral-badge ${report.blocking ? "badge-error" : report.status === "warning" ? "badge-warning" : "badge-success"}`;
    setText("final-qc-summary", `PASS ${report.counts.pass} · WARNING ${report.counts.warning} · ERROR ${report.counts.error}`);
    element<HTMLButtonElement>("final-qc-json-btn").disabled = false;
    element<HTMLButtonElement>("final-qc-md-btn").disabled = false;
    const select = element<HTMLSelectElement>("final-qc-waiver-code");
    select.replaceChildren();
    const waiverable = report.checks.filter((check) => check.level === "error" && !check.hardBlock && !check.waived);
    for (const check of waiverable) {
      const option = document.createElement("option");
      option.value = check.code;
      option.textContent = `${check.code} · ${check.message}`;
      select.append(option);
    }
    element<HTMLButtonElement>("final-qc-waive-btn").disabled = waiverable.length === 0;
  }

  private async addWaiver(): Promise<void> {
    if (!this.reportValue) throw new Error("먼저 최종 QC를 실행해 주세요.");
    const code = element<HTMLSelectElement>("final-qc-waiver-code").value;
    const reasonInput = element<HTMLInputElement>("final-qc-waiver-reason");
    const reason = reasonInput.value.trim();
    if (!code) throw new Error("예외 승인 가능한 오류가 없습니다.");
    if (reason.length < 5) throw new Error("예외 승인 사유를 5자 이상 입력해 주세요.");
    this.waivers = [...this.waivers.filter((waiver) => waiver.code !== code), { code, reason, createdAt: Date.now() }].slice(-200);
    reasonInput.value = "";
    await this.run();
  }

  private async saveReport(format: "json" | "md"): Promise<void> {
    if (!this.reportValue) throw new Error("저장할 최종 QC 보고서가 없습니다.");
    const uxp = require("uxp") as any;
    const fs = uxp?.storage?.localFileSystem;
    const file = await fs?.getFileForSaving?.(`ShortFlow_Final_QC.${format === "json" ? "json" : "md"}`, {
      types: [format === "json" ? "json" : "md"],
    }) as ReportFile | null | undefined;
    if (!file) return;
    const text = format === "json"
      ? finalQCReportToJSON(this.reportValue)
      : finalQCReportToMarkdown(this.reportValue);
    await file.write(text, { format: uxp?.storage?.formats?.utf8 });
    this.options.onActivity?.(`최종 QC ${format.toUpperCase()} 보고서를 저장했습니다: ${String(file.name ?? "보고서")}`);
  }
}
