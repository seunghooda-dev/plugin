import {
  JobQueue,
  JobQueueError,
  hashJobContent,
  type JobContext,
  type JobKind,
  type JobQueueStorage,
  type JobSnapshot,
} from "./job-queue";
import { bind, element, numberOf, optionalElement, setText } from "./ui";

export interface QueueRunOptions {
  estimateUnits?: number;
  cacheTtlMs?: number;
  maxRetries?: number;
  confirmRequired?: boolean;
}

export interface AIQueueControllerOptions {
  queue?: JobQueue;
  storage?: JobQueueStorage;
  onActivity?: (message: string) => void;
  onError?: (error: unknown, context: string) => void;
}

type RuntimeHandler = (context: JobContext) => Promise<unknown>;

function browserStorage(): JobQueueStorage | undefined {
  const storage = (globalThis as unknown as { localStorage?: JobQueueStorage }).localStorage;
  return storage;
}

function stateLabel(job: JobSnapshot): string {
  if (job.state === "queued" && job.confirmRequired && !job.confirmed) return "승인 대기";
  switch (job.state) {
    case "queued": return "대기";
    case "running": return `실행 ${Math.round(job.progress * 100)}%`;
    case "succeeded": return job.fromCache ? "캐시 완료" : "완료";
    case "failed": return "실패";
    case "cancelled": return "취소";
  }
}

function kindLabel(kind: JobKind): string {
  return { image: "이미지", tts: "TTS", stt: "STT", text: "텍스트", video: "영상" }[kind];
}

export class AIQueueController {
  readonly queue: JobQueue;
  private readonly handlers = new Map<string, RuntimeHandler>();
  private initialized = false;

  constructor(private readonly options: AIQueueControllerOptions = {}) {
    this.queue = options.queue ?? new JobQueue(
      async (job, context) => {
        const handler = this.handlers.get(job.hash);
        if (!handler) {
          throw new JobQueueError(
            "INVALID_JOB",
            job.recovered
              ? "재시작 전 입력 파일 권한이 없어 작업을 자동 재개할 수 없습니다. 원본을 다시 선택해 실행해 주세요."
              : "AI 작업 실행 핸들러를 찾지 못했습니다.",
          );
        }
        context.reportProgress(0.08);
        const value = await handler(context);
        context.reportProgress(1);
        return { value };
      },
      {
        ...((options.storage ?? browserStorage()) ? { storage: options.storage ?? browserStorage()! } : {}),
        concurrency: 2,
        budget: { requestLimit: 100, costLimitUnits: 100, confirmationThresholdUnits: 10 },
      },
    );
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.bindEvents();
    this.queue.subscribe((event) => {
      if (event.job && ["succeeded", "failed", "cancelled"].includes(event.job.state)) {
        this.handlers.delete(event.job.hash);
      }
      if (event.type === "persistence-error") this.options.onError?.(new Error(event.message), "AI 큐 저장 실패");
      this.render();
    });
    try {
      const recovered = await this.queue.restore();
      if (recovered > 0) this.options.onActivity?.(`중단된 AI 작업 ${recovered}개를 복구 대기열로 옮겼습니다.`);
    } catch (error) {
      this.options.onError?.(error, "AI 작업 큐 복구 실패");
    }
    this.syncControls();
    this.render();
  }

  async run<T>(
    kind: JobKind,
    descriptor: unknown,
    task: (context: JobContext) => Promise<T>,
    options: QueueRunOptions = {},
  ): Promise<T> {
    const requestOptions = { source: "shortflow", cacheVersion: 1 };
    const hash = hashJobContent(kind, descriptor, requestOptions);
    const active = this.queue.list().find((candidate) =>
      candidate.hash === hash && (candidate.state === "queued" || candidate.state === "running"));
    let job: JobSnapshot;
    if (active) {
      job = active;
    } else {
      const handler = task as RuntimeHandler;
      this.handlers.set(hash, handler);
      try {
        job = this.queue.enqueue({
          kind,
          content: descriptor,
          options: requestOptions,
          estimateUnits: options.estimateUnits ?? 1,
          cacheTtlMs: options.cacheTtlMs ?? 0,
          maxRetries: options.maxRetries ?? 2,
          confirmRequired: options.confirmRequired ?? false,
        });
      } catch (error) {
        if (this.handlers.get(hash) === handler) this.handlers.delete(hash);
        throw error;
      }
    }
    const result = await this.queue.waitFor(job.id);
    if (result.state === "succeeded") return result.result as T;
    if (result.state === "cancelled") throw new JobQueueError("CANCELLED", result.error ?? "AI 작업이 취소되었습니다.");
    throw new Error(result.error ?? "AI 작업이 실패했습니다.");
  }

  private bindEvents(): void {
    bind("ai-queue-save-btn", "click", () => {
      this.queue.setConcurrency(numberOf("ai-queue-concurrency-input", 2));
      this.queue.setBudget({
        requestLimit: numberOf("ai-request-limit-input", 100),
        costLimitUnits: numberOf("ai-cost-limit-input", 100),
        confirmationThresholdUnits: numberOf("ai-confirm-threshold-input", 10),
      });
      this.options.onActivity?.("AI 큐 동시 실행 수와 일일 한도를 저장했습니다.");
      this.render();
    });
    bind("ai-queue-pause-btn", "click", () => {
      if (this.queue.isPaused) this.queue.resume(); else this.queue.pause();
      this.render();
    });
    bind("ai-cache-clear-btn", "click", () => {
      this.queue.clearCache();
      this.options.onActivity?.("AI 결과 메타 캐시를 지웠습니다.");
      this.render();
    });
  }

  private syncControls(): void {
    const budget = this.queue.getBudget();
    element<HTMLInputElement>("ai-queue-concurrency-input").value = String(this.queue.currentConcurrency);
    element<HTMLInputElement>("ai-request-limit-input").value = String(budget.requestLimit ?? 100);
    element<HTMLInputElement>("ai-cost-limit-input").value = String(budget.costLimitUnits ?? 100);
    element<HTMLInputElement>("ai-confirm-threshold-input").value = String(budget.confirmationThresholdUnits ?? 10);
  }

  private render(): void {
    const usage = this.queue.getUsage();
    const budget = this.queue.getBudget();
    setText("ai-queue-usage", `${usage.requests} / ${budget.requestLimit ?? "∞"}회 · ${usage.costUnits.toFixed(1)} / ${budget.costLimitUnits ?? "∞"}단위`);
    setText("ai-cache-count", `${this.queue.getCacheMetadata().length}개`);
    const pauseButton = optionalElement<HTMLButtonElement>("ai-queue-pause-btn");
    if (pauseButton) pauseButton.textContent = this.queue.isPaused ? "큐 재개" : "큐 일시정지";
    const target = element<HTMLElement>("ai-job-list");
    target.replaceChildren();
    const jobs = this.queue.list().sort((left, right) => right.createdAt - left.createdAt).slice(0, 30);
    if (jobs.length === 0) {
      const empty = document.createElement("p");
      empty.className = "action-note";
      empty.textContent = "대기 중이거나 최근 실행한 AI 작업이 없습니다.";
      target.append(empty);
      return;
    }
    for (const job of jobs) {
      const row = document.createElement("div");
      row.className = `ai-job-row is-${job.state}`;
      const copy = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = `${kindLabel(job.kind)} · ${stateLabel(job)}`;
      const meta = document.createElement("span");
      meta.textContent = job.error ? job.error.slice(0, 180) : `${job.attempt}/${job.maxRetries + 1}회 · 예상 ${job.estimateUnits.toFixed(1)}단위`;
      copy.append(title, meta);
      row.append(copy);
      if (job.state === "queued" && job.confirmRequired && !job.confirmed) {
        const approve = document.createElement("button");
        approve.className = "secondary-button small-button";
        approve.type = "button";
        approve.textContent = "승인";
        approve.addEventListener("click", () => this.queue.confirm(job.id));
        row.append(approve);
      } else if (job.state === "queued" || job.state === "running") {
        const cancel = document.createElement("button");
        cancel.className = "secondary-button small-button";
        cancel.type = "button";
        cancel.textContent = "취소";
        cancel.addEventListener("click", () => this.queue.cancel(job.id));
        row.append(cancel);
      }
      target.append(row);
    }
  }
}
