import {
  planSilenceCuts,
  recommendPunchCues,
  type PunchCue,
  type SilenceCutPlan,
  type TimedSpeechSegment,
} from "./automation";
import {
  SAFE_ZONE_PROFILES,
  alignToSafeZone,
  assessSafeZone,
  normalizedRectToPixels,
  safeContentRect,
  type NormalizedRect,
  type SafeZoneAlignment,
  type SocialPlatform,
} from "./safe-zone";
import { bind, checkedOf, element, numberOf, optionalElement, valueOf } from "./ui";

export interface AutomationTranscript {
  name: string;
  duration: number;
  segments: readonly TimedSpeechSegment[];
}

export interface AutomationControllerOptions {
  getTranscript?: () => AutomationTranscript | null | Promise<AutomationTranscript | null>;
  onActivity?: (message: string) => void;
  onError?: (error: unknown, context: string) => void;
  onAddMarkers?: (plan: SilenceCutPlan, cues: readonly PunchCue[]) => void | Promise<void>;
  onApply?: (plan: SilenceCutPlan, cues: readonly PunchCue[]) => void | Promise<void>;
  onCreateSafeOverlay?: (platform: SocialPlatform, role: "content" | "caption") => void | Promise<void>;
  onAlignSafeZone?: (alignment: SafeZoneAlignment, platform: SocialPlatform, role: "content" | "caption") => void | Promise<void>;
}

function seconds(value: number): string {
  const safe = Math.max(0, Number.isFinite(value) ? value : 0);
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${rest.toFixed(2).padStart(5, "0")}`;
}

function platformValue(): SocialPlatform {
  const value = valueOf("safe-platform-select");
  if (value === "youtube-shorts" || value === "instagram-reels" || value === "tiktok") return value;
  return "youtube-shorts";
}

function roleValue(): "content" | "caption" {
  return valueOf("safe-role-select") === "content" ? "content" : "caption";
}

function currentElementRect(): NormalizedRect {
  return {
    x: numberOf("safe-box-x-input", 20) / 100,
    y: numberOf("safe-box-y-input", 55) / 100,
    width: numberOf("safe-box-width-input", 60) / 100,
    height: numberOf("safe-box-height-input", 12) / 100,
  };
}

function setRange(id: string, value: number): void {
  element<HTMLInputElement>(id).value = String(Math.round(value * 100));
}

export class AutomationController {
  private transcript: AutomationTranscript | null = null;
  private planValue: SilenceCutPlan | null = null;
  private cuesValue: PunchCue[] = [];

  constructor(private readonly options: AutomationControllerOptions = {}) {}

  async initialize(): Promise<void> {
    this.bindEvents();
    this.syncRangeLabels();
    this.renderSafeZone();
    await this.refreshTranscriptStatus();
  }

  get plan(): SilenceCutPlan | null { return this.planValue; }
  get cues(): readonly PunchCue[] { return [...this.cuesValue]; }

  setTranscript(transcript: AutomationTranscript | null): void {
    this.transcript = transcript;
    this.renderTranscriptStatus();
  }

  private bindEvents(): void {
    bind("auto-analyze-btn", "click", () => this.guard(() => this.analyze(), "자동 편집 분석 실패"));
    bind("auto-markers-btn", "click", () => this.guard(() => this.addMarkers(), "추천 마커 추가 실패"));
    bind("auto-apply-btn", "click", () => this.guard(() => this.apply(), "자동 편집 적용 실패"));
    bind("safe-check-btn", "click", () => this.checkSafeZone());
    bind("safe-align-btn", "click", () => this.guard(() => this.alignSafeZone(), "Safe Zone 자동 정렬 실패"));
    bind("safe-overlay-btn", "click", () => this.guard(() => this.createSafeOverlay(), "Safe Zone 가이드 생성 실패"));
    for (const id of [
      "safe-platform-select", "safe-role-select", "safe-box-x-input", "safe-box-y-input",
      "safe-box-width-input", "safe-box-height-input",
    ] as const) {
      bind(id, id.includes("select") ? "change" : "input", () => {
        this.syncRangeLabels();
        this.renderSafeZone();
      });
    }
  }

  private async guard(task: () => void | Promise<void>, context: string): Promise<void> {
    try { await task(); } catch (error) { this.options.onError?.(error, context); }
  }

  private async refreshTranscriptStatus(): Promise<void> {
    if (this.options.getTranscript) this.transcript = await this.options.getTranscript();
    this.renderTranscriptStatus();
  }

  private renderTranscriptStatus(): void {
    const status = optionalElement<HTMLElement>("automation-stt-status");
    if (!status) return;
    status.textContent = this.transcript
      ? `${this.transcript.name} · ${this.transcript.segments.length}개 타임코드 · ${seconds(this.transcript.duration)}`
      : "먼저 TTS·STT 탭에서 화자 구분 또는 Whisper 자막을 생성해 주세요.";
  }

  private async analyze(): Promise<void> {
    await this.refreshTranscriptStatus();
    if (!this.transcript || this.transcript.segments.length === 0) {
      throw new Error("타임코드가 포함된 STT 결과가 없습니다. 화자 구분 또는 Whisper SRT로 먼저 변환해 주세요.");
    }
    this.planValue = planSilenceCuts(this.transcript.segments, this.transcript.duration, {
      minSilence: numberOf("auto-min-silence-input", 0.42),
      padding: numberOf("auto-padding-input", 0.08),
      trimLeading: checkedOf("auto-trim-leading-checkbox"),
      trimTrailing: checkedOf("auto-trim-trailing-checkbox"),
    });
    const keywords = valueOf("auto-keywords-input").split(",").map((value) => value.trim()).filter(Boolean);
    this.cuesValue = checkedOf("auto-punch-checkbox")
      ? recommendPunchCues(this.transcript.segments, this.transcript.duration, {
        scale: numberOf("auto-punch-scale-input", 112),
        maximumCues: numberOf("auto-punch-count-input", 12),
        keywords,
      })
      : [];
    this.renderPlan();
    this.options.onActivity?.(`자동 편집안 분석 완료 · 무음 컷 ${this.planValue.cuts.length}개 · 펀치인 ${this.cuesValue.length}개`);
  }

  private renderPlan(): void {
    if (!this.planValue) return;
    const summary = element<HTMLElement>("auto-plan-summary");
    const values = summary.querySelectorAll<HTMLElement>("strong");
    if (values[0]) values[0].textContent = `${this.planValue.removedDuration.toFixed(2)}초`;
    if (values[1]) values[1].textContent = seconds(this.planValue.outputDuration);
    if (values[2]) values[2].textContent = `${this.cuesValue.length}개`;

    const target = element<HTMLElement>("auto-cut-list");
    target.replaceChildren();
    const rows: Array<{ type: "CUT" | "ZOOM"; start: number; end: number; label: string }> = [
      ...this.planValue.cuts.map((cut) => ({ type: "CUT" as const, start: cut.start, end: cut.end, label: `무음 ${cut.duration.toFixed(2)}초 제거` })),
      ...this.cuesValue.map((cue) => ({ type: "ZOOM" as const, start: cue.start, end: cue.end, label: `${cue.scale}% · ${cue.reason}` })),
    ].sort((left, right) => left.start - right.start);
    if (rows.length === 0) {
      const empty = document.createElement("p");
      empty.className = "action-note";
      empty.textContent = this.planValue.warnings.join(" ") || "추천할 변경이 없습니다.";
      target.append(empty);
    } else {
      rows.forEach((row) => {
        const item = document.createElement("div");
        item.className = "automation-cut-item";
        const badge = document.createElement("strong");
        badge.textContent = row.type;
        const label = document.createElement("span");
        label.textContent = row.label;
        const time = document.createElement("time");
        time.textContent = `${seconds(row.start)}–${seconds(row.end)}`;
        item.append(badge, label, time);
        target.append(item);
      });
    }
    element<HTMLButtonElement>("auto-markers-btn").disabled = rows.length === 0;
    element<HTMLButtonElement>("auto-apply-btn").disabled = rows.length === 0;
  }

  private async addMarkers(): Promise<void> {
    if (!this.planValue) throw new Error("먼저 자동 편집안을 분석해 주세요.");
    if (!this.options.onAddMarkers) throw new Error("Premiere 추천 마커 기능이 연결되지 않았습니다.");
    await this.options.onAddMarkers(this.planValue, this.cuesValue);
  }

  private async apply(): Promise<void> {
    if (!this.planValue) throw new Error("먼저 자동 편집안을 분석해 주세요.");
    if (!this.options.onApply) throw new Error("Premiere 자동 편집 적용 기능이 연결되지 않았습니다.");
    await this.options.onApply(this.planValue, this.cuesValue);
  }

  private syncRangeLabels(): void {
    for (const [inputId, outputId] of [
      ["safe-box-x-input", "safe-box-x-output"],
      ["safe-box-y-input", "safe-box-y-output"],
      ["safe-box-width-input", "safe-box-width-output"],
      ["safe-box-height-input", "safe-box-height-output"],
    ] as const) {
      const output = optionalElement<HTMLOutputElement>(outputId);
      if (output) output.textContent = `${Math.round(numberOf(inputId, 0))}%`;
    }
  }

  private renderSafeZone(): void {
    const canvas = optionalElement<HTMLCanvasElement>("safe-zone-canvas");
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const platform = platformValue();
    const role = roleValue();
    const safe = normalizedRectToPixels(safeContentRect(platform, role), canvas.width, canvas.height);
    const elementRect = normalizedRectToPixels(currentElementRect(), canvas.width, canvas.height);
    const assessment = assessSafeZone(currentElementRect(), platform, role);

    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, "#20243a");
    gradient.addColorStop(1, "#0c0e16");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(255,82,109,.16)";
    ctx.fillRect(0, 0, canvas.width, safe.y);
    ctx.fillRect(0, safe.y + safe.height, canvas.width, canvas.height - safe.y - safe.height);
    ctx.fillRect(0, safe.y, safe.x, safe.height);
    ctx.fillRect(safe.x + safe.width, safe.y, canvas.width - safe.x - safe.width, safe.height);
    ctx.save();
    ctx.setLineDash([12, 8]);
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(71,215,172,.9)";
    ctx.strokeRect(safe.x, safe.y, safe.width, safe.height);
    ctx.restore();
    ctx.fillStyle = assessment.inside ? "rgba(71,215,172,.28)" : "rgba(255,107,122,.35)";
    ctx.strokeStyle = assessment.inside ? "#47d7ac" : "#ff6b7a";
    ctx.lineWidth = 4;
    ctx.fillRect(elementRect.x, elementRect.y, elementRect.width, elementRect.height);
    ctx.strokeRect(elementRect.x, elementRect.y, elementRect.width, elementRect.height);
    ctx.fillStyle = "rgba(255,255,255,.82)";
    ctx.font = "24px sans-serif";
    ctx.fillText(SAFE_ZONE_PROFILES[platform].label, 20, 38);
  }

  private checkSafeZone(): void {
    const assessment = assessSafeZone(currentElementRect(), platformValue(), roleValue());
    const target = element<HTMLElement>("safe-zone-result");
    target.classList.toggle("is-safe", assessment.inside);
    target.classList.toggle("is-warning", !assessment.inside);
    target.textContent = assessment.inside
      ? "안전 영역 안에 있습니다. 플랫폼 UI와 겹칠 가능성이 낮습니다."
      : `안전 영역 침범: 위 ${(assessment.overflow.top * 100).toFixed(1)}%, 오른쪽 ${(assessment.overflow.right * 100).toFixed(1)}%, 아래 ${(assessment.overflow.bottom * 100).toFixed(1)}%, 왼쪽 ${(assessment.overflow.left * 100).toFixed(1)}%.`;
    this.renderSafeZone();
  }

  private async alignSafeZone(): Promise<void> {
    const platform = platformValue();
    const role = roleValue();
    const alignment = alignToSafeZone(currentElementRect(), platform, role);
    setRange("safe-box-x-input", alignment.rect.x);
    setRange("safe-box-y-input", alignment.rect.y);
    setRange("safe-box-width-input", alignment.rect.width);
    setRange("safe-box-height-input", alignment.rect.height);
    this.syncRangeLabels();
    this.checkSafeZone();
    await this.options.onAlignSafeZone?.(alignment, platform, role);
    this.options.onActivity?.(alignment.changed ? "요소를 Safe Zone 안으로 자동 정렬했습니다." : "요소가 이미 Safe Zone 안에 있습니다.");
  }

  private async createSafeOverlay(): Promise<void> {
    if (!this.options.onCreateSafeOverlay) throw new Error("Premiere Safe Zone 가이드 생성 기능이 연결되지 않았습니다.");
    await this.options.onCreateSafeOverlay(platformValue(), roleValue());
  }
}
