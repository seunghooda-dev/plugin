import {
  MAX_AUTOMATION_MARKERS,
  assertAutomationMarkerBudget,
  createAutomationAnalysisFingerprint,
  normalizeAutomationAnalysisSettings,
  planSilenceCuts,
  recommendPunchCues,
  type AutomationAnalysisSettings,
  type PunchCue,
  type SilenceCutPlan,
  type TimedSpeechSegment,
} from "./automation";
import {
  alignToSafeZone,
  assessSafeZone,
  normalizedRectToPixels,
  safeContentRect,
  safeZoneGuideLabel,
  type NormalizedRect,
  type SafeZoneAlignment,
  type SocialPlatform,
} from "./safe-zone";
import { bind, checkedOf, clearChildren, element, numberOf, optionalElement, valueOf } from "./ui";

export interface AutomationTranscript {
  name: string;
  duration: number;
  segments: readonly TimedSpeechSegment[];
}

export interface AutomationControllerOptions {
  getTranscript?: () => AutomationTranscript | null | Promise<AutomationTranscript | null>;
  getSourceContextKey?: () => string | null | undefined | Promise<string | null | undefined>;
  onActivity?: (message: string) => void;
  onError?: (error: unknown, context: string) => void;
  onAddMarkers?: (
    plan: SilenceCutPlan,
    cues: readonly PunchCue[],
    guard: AutomationAnalysisGuard,
  ) => void | Promise<void>;
  onApply?: (
    plan: SilenceCutPlan,
    cues: readonly PunchCue[],
    guard: AutomationAnalysisGuard,
  ) => void | Promise<void>;
  onCreateSafeOverlay?: (platform: SocialPlatform, role: "content" | "caption") => void | Promise<void>;
  onAlignSafeZone?: (
    alignment: SafeZoneAlignment,
    platform: SocialPlatform,
    role: "content" | "caption",
  ) => void | SafeZoneApplyResult | Promise<void | SafeZoneApplyResult>;
}

export interface SafeZoneApplyResult {
  selected: number;
  changed: number;
  skipped: number;
  warnings: readonly string[];
}

export interface AutomationAnalysisGuard {
  readonly fingerprint: string;
  readonly sourceContextKey: string;
}

const STALE_ANALYSIS_MESSAGE = "자동 편집 원고·설정 또는 활성 Premiere context가 변경되었습니다. 다시 분석해 주세요.";

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

function cloneTranscript(transcript: AutomationTranscript | null): AutomationTranscript | null {
  return transcript
    ? { ...transcript, segments: transcript.segments.map((segment) => ({ ...segment })) }
    : null;
}

function clonePlan(plan: SilenceCutPlan): SilenceCutPlan {
  return {
    ...plan,
    speech: plan.speech.map((item) => ({ ...item })),
    cuts: plan.cuts.map((item) => ({ ...item })),
    keeps: plan.keeps.map((item) => ({ ...item })),
    warnings: [...plan.warnings],
  };
}

function clonePunchCues(cues: readonly PunchCue[]): PunchCue[] {
  return cues.map((cue) => ({ ...cue }));
}

function sameTranscript(left: AutomationTranscript | null, right: AutomationTranscript | null): boolean {
  if (left === right) return true;
  if (!left || !right || left.name !== right.name || !Object.is(left.duration, right.duration)) return false;
  if (left.segments.length !== right.segments.length) return false;
  return left.segments.every((segment, index) => {
    const other = right.segments[index];
    return Boolean(
      other && Object.is(segment.start, other.start) && Object.is(segment.end, other.end) &&
      segment.text === other.text && segment.speaker === other.speaker,
    );
  });
}

function sameAnalysisSettings(left: AutomationAnalysisSettings, right: AutomationAnalysisSettings): boolean {
  return left.minSilence === right.minSilence && left.padding === right.padding &&
    left.trimLeading === right.trimLeading && left.trimTrailing === right.trimTrailing &&
    left.punchEnabled === right.punchEnabled && left.punchScale === right.punchScale &&
    left.punchCount === right.punchCount && left.keywords.length === right.keywords.length &&
    left.keywords.every((keyword, index) => keyword === right.keywords[index]);
}

export class AutomationController {
  private transcript: AutomationTranscript | null = null;
  private planValue: SilenceCutPlan | null = null;
  private cuesValue: PunchCue[] = [];
  private transcriptRevision = 0;
  private settingsRevision = 0;
  private analysisGuardValue: AutomationAnalysisGuard | null = null;
  private invalidationMessage = "";
  private busyAction = "";

  constructor(private readonly options: AutomationControllerOptions = {}) {}

  async initialize(): Promise<void> {
    this.bindEvents();
    this.syncRangeLabels();
    this.renderSafeZone();
    await this.refreshTranscriptStatus();
  }

  get plan(): SilenceCutPlan | null { return this.planValue; }
  get cues(): readonly PunchCue[] { return [...this.cuesValue]; }
  get analysisGuard(): AutomationAnalysisGuard | null {
    return this.analysisGuardValue ? { ...this.analysisGuardValue } : null;
  }
  get isBusy(): boolean { return Boolean(this.busyAction); }

  setTranscript(transcript: AutomationTranscript | null): void {
    const next = cloneTranscript(transcript);
    if (!sameTranscript(this.transcript, next)) {
      const hadAnalysis = Boolean(this.planValue || this.analysisGuardValue);
      this.transcript = next;
      this.transcriptRevision += 1;
      this.invalidatePlan(
        "STT 결과가 변경되어 이전 자동 편집안을 사용할 수 없습니다. 다시 분석해 주세요.",
        hadAnalysis,
      );
    }
    this.renderTranscriptStatus();
  }

  private bindEvents(): void {
    bind("auto-analyze-btn", "click", () => this.runAutomation("자동 편집 분석", () => this.analyze(), "자동 편집 분석 실패"));
    bind("auto-markers-btn", "click", () => this.runAutomation("추천 마커 추가", () => this.addMarkers(), "추천 마커 추가 실패"));
    bind("auto-apply-btn", "click", () => this.runAutomation("자동 편집 적용", () => this.apply(), "자동 편집 적용 실패"));
    bind("safe-check-btn", "click", () => this.runAutomation("Safe Zone 확인", () => this.checkSafeZone(), "Safe Zone 확인 실패"));
    bind("safe-align-btn", "click", () => this.runAutomation("Safe Zone 자동 정렬", () => this.alignSafeZone(), "Safe Zone 자동 정렬 실패"));
    bind("safe-overlay-btn", "click", () => this.runAutomation("Safe Zone 가이드 생성", () => this.createSafeOverlay(), "Safe Zone 가이드 생성 실패"));
    for (const id of [
      "auto-min-silence-input", "auto-padding-input", "auto-punch-scale-input",
      "auto-punch-count-input", "auto-keywords-input", "auto-trim-leading-checkbox",
      "auto-trim-trailing-checkbox", "auto-punch-checkbox",
    ] as const) {
      bind(id, "input", () => this.handleAnalysisSettingChange());
      bind(id, "change", () => this.handleAnalysisSettingChange());
    }
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

  private async runAutomation(label: string, task: () => void | Promise<void>, context: string): Promise<void> {
    if (this.busyAction) {
      this.options.onError?.(new Error(`${this.busyAction} 작업이 이미 진행 중입니다.`), context);
      return;
    }
    this.busyAction = label;
    this.renderAutomationControls();
    try {
      await task();
    } catch (error) {
      this.options.onError?.(error, context);
    } finally {
      this.busyAction = "";
      this.renderAutomationControls();
    }
  }

  private async refreshTranscriptStatus(): Promise<void> {
    if (this.options.getTranscript) {
      const revision = this.transcriptRevision;
      const next = await this.options.getTranscript();
      if (revision === this.transcriptRevision) this.setTranscript(next);
    }
    this.renderTranscriptStatus();
  }

  private renderTranscriptStatus(): void {
    const status = optionalElement<HTMLElement>("automation-stt-status");
    if (!status) return;
    status.textContent = this.transcript
      ? `${this.transcript.name} · ${this.transcript.segments.length}개 타임코드 · ${seconds(this.transcript.duration)}`
      : "먼저 TTS·STT 탭에서 화자 구분 또는 Whisper 자막을 생성해 주세요.";
  }

  private readAnalysisSettings(): AutomationAnalysisSettings {
    return normalizeAutomationAnalysisSettings({
      minSilence: numberOf("auto-min-silence-input", 0.42),
      padding: numberOf("auto-padding-input", 0.08),
      trimLeading: checkedOf("auto-trim-leading-checkbox"),
      trimTrailing: checkedOf("auto-trim-trailing-checkbox"),
      punchEnabled: checkedOf("auto-punch-checkbox"),
      punchScale: numberOf("auto-punch-scale-input", 112),
      punchCount: numberOf("auto-punch-count-input", 12),
      keywords: valueOf("auto-keywords-input").split(","),
    });
  }

  private handleAnalysisSettingChange(): void {
    this.settingsRevision += 1;
    if (!this.planValue && !this.analysisGuardValue) return;
    this.invalidatePlan(
      "자동 편집 설정이 변경되어 이전 분석안을 사용할 수 없습니다. 다시 분석해 주세요.",
      true,
    );
  }

  private async readSourceContextKey(): Promise<string> {
    if (!this.options.getSourceContextKey) return "";
    const value = await this.options.getSourceContextKey();
    if (typeof value !== "string") {
      throw new Error("활성 Premiere 프로젝트·시퀀스 context를 확인하지 못했습니다. 다시 분석해 주세요.");
    }
    const clean = value.trim();
    if (!clean || clean.length > 512 || /[\u0000-\u001f\u007f]/u.test(clean)) {
      throw new Error("활성 Premiere 프로젝트·시퀀스 context key가 올바르지 않습니다. 다시 분석해 주세요.");
    }
    return clean;
  }

  private fingerprint(
    transcript: AutomationTranscript,
    settings: AutomationAnalysisSettings,
    sourceContextKey: string,
  ): string {
    return createAutomationAnalysisFingerprint({
      transcriptName: transcript.name,
      sourceDuration: transcript.duration,
      segments: transcript.segments,
      settings,
      sourceContextKey,
    });
  }

  private async analyze(): Promise<void> {
    await this.refreshTranscriptStatus();
    if (!this.transcript || this.transcript.segments.length === 0) {
      throw new Error("타임코드가 포함된 STT 결과가 없습니다. 화자 구분 또는 Whisper SRT로 먼저 변환해 주세요.");
    }
    const transcript = this.transcript;
    const transcriptRevision = this.transcriptRevision;
    const settingsRevision = this.settingsRevision;
    const settings = this.readAnalysisSettings();
    this.invalidatePlan("새 자동 편집안을 분석하고 있습니다.", false);
    const sourceContextKey = await this.readSourceContextKey();
    if (
      transcriptRevision !== this.transcriptRevision || settingsRevision !== this.settingsRevision ||
      this.transcript !== transcript || !sameAnalysisSettings(settings, this.readAnalysisSettings())
    ) {
      this.rejectStaleAnalysis();
    }
    const plan = planSilenceCuts(transcript.segments, transcript.duration, {
      minSilence: settings.minSilence,
      padding: settings.padding,
      trimLeading: settings.trimLeading,
      trimTrailing: settings.trimTrailing,
      maximumCuts: MAX_AUTOMATION_MARKERS,
    });
    const remainingMarkerBudget = MAX_AUTOMATION_MARKERS - plan.cuts.length;
    const cues = settings.punchEnabled && remainingMarkerBudget > 0
      ? recommendPunchCues(transcript.segments, transcript.duration, {
        scale: settings.punchScale,
        maximumCues: Math.min(settings.punchCount, remainingMarkerBudget),
        keywords: settings.keywords,
      })
      : [];
    assertAutomationMarkerBudget(plan.cuts.length, cues.length);
    this.planValue = plan;
    this.cuesValue = cues;
    this.analysisGuardValue = Object.freeze({
      fingerprint: this.fingerprint(transcript, settings, sourceContextKey),
      sourceContextKey,
    });
    this.invalidationMessage = "";
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
    clearChildren(target);
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
    this.renderAutomationControls();
  }

  private invalidatePlan(message: string, reanalysisRequired = false): void {
    this.planValue = null;
    this.cuesValue = [];
    this.analysisGuardValue = null;
    this.invalidationMessage = reanalysisRequired ? message : "";
    const summary = optionalElement<HTMLElement>("auto-plan-summary");
    const values = summary?.querySelectorAll<HTMLElement>("strong") ?? [];
    if (values[0]) values[0].textContent = "—";
    if (values[1]) values[1].textContent = "—";
    if (values[2]) values[2].textContent = "0개";
    const target = optionalElement<HTMLElement>("auto-cut-list");
    if (target) {
      clearChildren(target);
      const note = document.createElement("p");
      note.className = "action-note";
      note.textContent = message;
      target.append(note);
    }
    this.renderAutomationControls();
  }

  private rejectStaleAnalysis(message = STALE_ANALYSIS_MESSAGE): never {
    this.invalidatePlan(message, true);
    throw new Error(message);
  }

  private async requireCurrentAnalysis(): Promise<{
    plan: SilenceCutPlan;
    cues: readonly PunchCue[];
    guard: AutomationAnalysisGuard;
  }> {
    const plan = this.planValue;
    const guard = this.analysisGuardValue;
    if (!plan || !guard) {
      throw new Error(this.invalidationMessage || "먼저 자동 편집안을 분석해 주세요.");
    }
    const transcriptRevision = this.transcriptRevision;
    const transcript = this.transcript;
    if (
      this.planValue !== plan || this.analysisGuardValue !== guard ||
      transcriptRevision !== this.transcriptRevision || !transcript
    ) {
      this.rejectStaleAnalysis(this.invalidationMessage || STALE_ANALYSIS_MESSAGE);
    }
    const sourceContextKey = await this.readSourceContextKey();
    if (
      this.planValue !== plan || this.analysisGuardValue !== guard ||
      transcriptRevision !== this.transcriptRevision || this.transcript !== transcript
    ) {
      this.rejectStaleAnalysis(this.invalidationMessage || STALE_ANALYSIS_MESSAGE);
    }
    const fingerprint = this.fingerprint(transcript, this.readAnalysisSettings(), sourceContextKey);
    if (fingerprint !== guard.fingerprint || sourceContextKey !== guard.sourceContextKey) {
      this.rejectStaleAnalysis();
    }
    return {
      plan: clonePlan(plan),
      cues: clonePunchCues(this.cuesValue),
      guard: { ...guard },
    };
  }

  private renderAutomationControls(): void {
    const hasActions = Boolean(this.planValue && this.planValue.cuts.length + this.cuesValue.length > 0);
    const analyze = optionalElement<HTMLButtonElement>("auto-analyze-btn");
    const markers = optionalElement<HTMLButtonElement>("auto-markers-btn");
    const apply = optionalElement<HTMLButtonElement>("auto-apply-btn");
    const safeCheck = optionalElement<HTMLButtonElement>("safe-check-btn");
    const safeAlign = optionalElement<HTMLButtonElement>("safe-align-btn");
    const safeOverlay = optionalElement<HTMLButtonElement>("safe-overlay-btn");
    if (analyze) analyze.disabled = this.isBusy;
    if (markers) markers.disabled = this.isBusy || !hasActions;
    if (apply) apply.disabled = this.isBusy || !hasActions;
    if (safeCheck) safeCheck.disabled = this.isBusy;
    if (safeAlign) safeAlign.disabled = this.isBusy;
    if (safeOverlay) safeOverlay.disabled = this.isBusy;
  }

  private async addMarkers(): Promise<void> {
    if (!this.options.onAddMarkers) throw new Error("Premiere 추천 마커 기능이 연결되지 않았습니다.");
    const current = await this.requireCurrentAnalysis();
    await this.options.onAddMarkers(current.plan, current.cues, current.guard);
  }

  private async apply(): Promise<void> {
    if (!this.options.onApply) throw new Error("Premiere 자동 편집 적용 기능이 연결되지 않았습니다.");
    const current = await this.requireCurrentAnalysis();
    await this.options.onApply(current.plan, current.cues, current.guard);
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
    const supportsSavedState = typeof ctx.save === "function" && typeof ctx.restore === "function";
    if (supportsSavedState) ctx.save();
    if (typeof ctx.setLineDash === "function") ctx.setLineDash([12, 8]);
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(71,215,172,.9)";
    ctx.strokeRect(safe.x, safe.y, safe.width, safe.height);
    if (supportsSavedState) ctx.restore();
    ctx.fillStyle = assessment.inside ? "rgba(71,215,172,.28)" : "rgba(255,107,122,.35)";
    ctx.strokeStyle = assessment.inside ? "#47d7ac" : "#ff6b7a";
    ctx.lineWidth = 4;
    ctx.fillRect(elementRect.x, elementRect.y, elementRect.width, elementRect.height);
    ctx.strokeRect(elementRect.x, elementRect.y, elementRect.width, elementRect.height);
    if (typeof ctx.fillText === "function") {
      ctx.fillStyle = "rgba(255,255,255,.82)";
      ctx.font = "22px sans-serif";
      ctx.fillText(safeZoneGuideLabel(platform, role), 20, 38);
    }
  }

  private checkSafeZone(): void {
    const platform = platformValue();
    const role = roleValue();
    const assessment = assessSafeZone(currentElementRect(), platform, role);
    const guideLabel = safeZoneGuideLabel(platform, role);
    const target = element<HTMLElement>("safe-zone-result");
    target.classList.toggle("is-safe", assessment.inside);
    target.classList.toggle("is-warning", !assessment.inside);
    target.textContent = assessment.inside
      ? `${guideLabel}: 안전 영역 안에 있습니다. 플랫폼 UI와 겹칠 가능성이 낮습니다.`
      : `${guideLabel}: 안전 영역 침범 · 위 ${(assessment.overflow.top * 100).toFixed(1)}%, 오른쪽 ${(assessment.overflow.right * 100).toFixed(1)}%, 아래 ${(assessment.overflow.bottom * 100).toFixed(1)}%, 왼쪽 ${(assessment.overflow.left * 100).toFixed(1)}%.`;
    this.renderSafeZone();
  }

  private async alignSafeZone(): Promise<void> {
    const platform = platformValue();
    const role = roleValue();
    const alignment = alignToSafeZone(currentElementRect(), platform, role);
    let result: void | SafeZoneApplyResult = undefined;
    if (alignment.changed) result = await this.options.onAlignSafeZone?.(alignment, platform, role);
    setRange("safe-box-x-input", alignment.rect.x);
    setRange("safe-box-y-input", alignment.rect.y);
    setRange("safe-box-width-input", alignment.rect.width);
    setRange("safe-box-height-input", alignment.rect.height);
    this.syncRangeLabels();
    this.checkSafeZone();
    const guideLabel = safeZoneGuideLabel(platform, role);
    if (!alignment.changed) {
      this.options.onActivity?.(`${guideLabel}: 요소가 이미 Safe Zone 안에 있습니다.`);
    } else if (result) {
      this.options.onActivity?.(
        result.skipped > 0 || result.changed < result.selected
          ? `${guideLabel}: 부분 적용 · 선택 ${result.selected}개 · 변경 ${result.changed}개 · 보존/건너뜀 ${result.skipped}개`
          : `${guideLabel}: 선택 ${result.changed}개에 위치 이동${alignment.wasOversized ? "과 비례 축소" : ""}을 적용했습니다.`,
      );
    } else {
      this.options.onActivity?.(`${guideLabel}: Safe Zone 정렬 요청을 완료했습니다.`);
    }
  }

  private async createSafeOverlay(): Promise<void> {
    if (!this.options.onCreateSafeOverlay) throw new Error("Premiere Safe Zone 가이드 생성 기능이 연결되지 않았습니다.");
    const platform = platformValue();
    const role = roleValue();
    await this.options.onCreateSafeOverlay(platform, role);
    this.options.onActivity?.(`${safeZoneGuideLabel(platform, role)} 오버레이를 만들었습니다. 내보내기 전 반드시 삭제해 주세요.`);
  }
}
