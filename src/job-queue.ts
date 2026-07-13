export const JOB_QUEUE_STORAGE_KEY = "shortflow.aiJobQueue.v1";
export const MAX_JOB_CONCURRENCY = 3;
export const MAX_CACHE_ENTRIES = 100;
export const MAX_JOB_HISTORY = 500;

export type JobKind = "image" | "tts" | "stt" | "text" | "video";
export type JobState =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface JobRequest {
  kind: JobKind;
  content: unknown;
  options?: unknown;
  estimateUnits?: number;
  confirmRequired?: boolean;
  confirmed?: boolean;
  maxRetries?: number;
  cacheTtlMs?: number;
}

export interface JobCacheDescriptor {
  fileToken?: string;
  metadata?: unknown;
  ttlMs?: number;
}

export interface JobExecutionResult {
  value?: unknown;
  costUnits?: number;
  cache?: JobCacheDescriptor;
}

export interface JobContext {
  signal: AbortSignal;
  reportProgress(progress: number): void;
  attempt: number;
}

export type JobExecutor = (
  job: Readonly<JobSnapshot>,
  context: JobContext,
) => Promise<JobExecutionResult>;

export interface JobSnapshot {
  id: string;
  hash: string;
  kind: JobKind;
  content: unknown;
  options?: unknown;
  state: JobState;
  progress: number;
  attempt: number;
  maxRetries: number;
  estimateUnits: number;
  confirmRequired: boolean;
  confirmed: boolean;
  fromCache: boolean;
  recovered: boolean;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: unknown;
  error?: string;
}

export interface DailyBudget {
  requestLimit?: number;
  costLimitUnits?: number;
  confirmationThresholdUnits?: number;
}

export interface DailyUsage {
  day: string;
  requests: number;
  costUnits: number;
}

export interface JobQueueStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem?(key: string): void | Promise<void>;
}

export interface JobQueueOptions {
  concurrency?: number;
  maxRetries?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  defaultCacheTtlMs?: number;
  storage?: JobQueueStorage;
  storageKey?: string;
  budget?: DailyBudget;
  now?: () => number;
  random?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  isTransientError?: (error: unknown) => boolean;
}

export type JobQueueEventType =
  | "job-added"
  | "job-updated"
  | "job-deduplicated"
  | "cache-hit"
  | "paused"
  | "resumed"
  | "budget-updated"
  | "restored"
  | "persistence-error";

export interface JobQueueEvent {
  type: JobQueueEventType;
  timestamp: number;
  job?: JobSnapshot;
  message?: string;
}

export type JobQueueListener = (event: Readonly<JobQueueEvent>) => void;

export type QueueErrorCode =
  | "INVALID_JOB"
  | "JOB_NOT_FOUND"
  | "INVALID_STATE"
  | "QUEUE_FULL"
  | "BUDGET_EXCEEDED"
  | "CONFIRMATION_REQUIRED"
  | "CANCELLED"
  | "RESTORE_FAILED";

export class JobQueueError extends Error {
  override readonly name = "JobQueueError";
  readonly code: QueueErrorCode;

  constructor(code: QueueErrorCode, message: string) {
    super(message);
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface InternalJob extends JobSnapshot {
  cacheTtlMs: number;
  controller?: AbortController;
}

interface CacheEntry {
  hash: string;
  createdAt: number;
  lastAccessedAt: number;
  expiresAt: number;
  fileToken?: string;
  metadata?: unknown;
  value?: unknown;
}

interface Deferred {
  promise: Promise<JobSnapshot>;
  resolve: (job: JobSnapshot) => void;
}

interface SerializedState {
  version: 1;
  paused: boolean;
  jobs: JobSnapshot[];
  cache: Array<Omit<CacheEntry, "value">>;
  usage: DailyUsage;
  budget: DailyBudget;
}

const JOB_KINDS = new Set<JobKind>(["image", "tts", "stt", "text", "video"]);
const SENSITIVE_KEY = /api.?key|authorization|bearer|password|secret|token$/iu;
const PRIVATE_JOB_FIELD = /^(?:prompt|script(?:text)?|transcript(?:text)?|caption(?:text)?|subtitle(?:text)?|media(?:name|path)|file(?:name|path)|nativepath|projectname|sequencename|usertext|inputtext|text)$/iu;
const BINARY_PLACEHOLDER = "[BINARY_OMITTED]";
const CONTENT_PLACEHOLDER = "[CONTENT_OMITTED]";

interface StorageSafeOptions {
  allowFileToken?: boolean;
  redactJobFields?: boolean;
  redactStrings?: boolean;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteNonNegative(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function integerInRange(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? clamp(Math.floor(value), minimum, maximum)
    : fallback;
}

function canonicalValue(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "undefined": return "undefined";
    case "boolean": return value ? "bool:1" : "bool:0";
    case "string": return `string:${JSON.stringify(value.normalize("NFC"))}`;
    case "number":
      if (Number.isNaN(value)) return "number:NaN";
      if (value === Infinity) return "number:+Infinity";
      if (value === -Infinity) return "number:-Infinity";
      if (Object.is(value, -0)) return "number:-0";
      return `number:${value}`;
    case "bigint": return `bigint:${value.toString()}`;
    case "symbol": return `symbol:${String(value.description ?? "")}`;
    case "function": throw new JobQueueError("INVALID_JOB", "함수는 작업 해시 입력에 사용할 수 없습니다.");
  }

  const object = value as object;
  if (seen.has(object)) {
    throw new JobQueueError("INVALID_JOB", "순환 참조가 있는 작업 입력은 사용할 수 없습니다.");
  }
  seen.add(object);
  try {
    if (value instanceof Date) {
      const time = value.getTime();
      return `date:${Number.isFinite(time) ? value.toISOString() : "invalid"}`;
    }
    if (value instanceof ArrayBuffer) {
      return canonicalBytes(new Uint8Array(value));
    }
    if (ArrayBuffer.isView(value)) {
      const view = value as ArrayBufferView;
      return canonicalBytes(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    }
    if (Array.isArray(value)) {
      return `array:[${value.map((item) => canonicalValue(item, seen)).join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `object:{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key], seen)}`)
      .join(",")}}`;
  } finally {
    seen.delete(object);
  }
}

function canonicalBytes(bytes: Uint8Array): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (const byte of bytes) {
    left ^= byte;
    left = Math.imul(left, 0x01000193) >>> 0;
    right ^= byte + ((right << 6) >>> 0) + (right >>> 2);
    right = Math.imul(right, 0x85ebca6b) >>> 0;
  }
  return `bytes:${bytes.byteLength}:${left.toString(16).padStart(8, "0")}${right.toString(16).padStart(8, "0")}`;
}

export function stableCanonicalize(value: unknown): string {
  return canonicalValue(value, new Set());
}

/** Non-cryptographic, stable FNV-1a-derived hash used only for local de-duplication. */
export function deterministicHash(value: unknown): string {
  const input = new TextEncoder().encode(stableCanonicalize(value));
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (const byte of input) {
    left ^= byte;
    left = Math.imul(left, 0x01000193) >>> 0;
    right ^= byte + ((right << 6) >>> 0) + (right >>> 2);
    right = Math.imul(right, 0x85ebca6b) >>> 0;
  }
  return `${left.toString(16).padStart(8, "0")}${right.toString(16).padStart(8, "0")}`;
}

export function hashJobContent(kind: JobKind, content: unknown, options?: unknown): string {
  return deterministicHash({ kind, content, options });
}

export function redactJobError(error: unknown): string {
  let text: string;
  if (error instanceof Error) text = error.message;
  else if (typeof error === "string") text = error;
  else {
    try { text = JSON.stringify(error); } catch { text = String(error); }
  }
  return text
    .replace(/(authorization\s*[:=]\s*)bearer\s+[^\s,;"'}]+/giu, "$1Bearer [REDACTED]")
    .replace(/\bbearer\s+[a-z0-9._~+/-]{8,}/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk|sess)-[a-z0-9_-]{8,}\b/giu, "[REDACTED]")
    .replace(/("?(?:api[_-]?key|password|secret|token)"?\s*[:=]\s*["']?)[^\s,"'}]+/giu, "$1[REDACTED]")
    .slice(0, 2_000);
}

function storageSafe(
  value: unknown,
  seen = new Set<object>(),
  options: StorageSafeOptions = {},
): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return options.redactStrings ? CONTENT_PLACEHOLDER : value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return undefined;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return BINARY_PLACEHOLDER;
  if (value instanceof Date) return value.toISOString();
  const object = value as object;
  if (seen.has(object)) return "[CIRCULAR]";
  seen.add(object);
  try {
    if (Array.isArray(value)) return value.map((item) => storageSafe(item, seen, options));
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const canKeepFileToken = options.allowFileToken && key === "fileToken";
      if (SENSITIVE_KEY.test(key) && !canKeepFileToken) {
        result[key] = "[REDACTED]";
      } else if (options.redactJobFields && PRIVATE_JOB_FIELD.test(key)) {
        result[key] = CONTENT_PLACEHOLDER;
      } else {
        result[key] = storageSafe(item, seen, options);
      }
    }
    return result;
  } finally {
    seen.delete(object);
  }
}

function persistableJob(job: JobSnapshot): JobSnapshot {
  const persisted: JobSnapshot = { ...job };
  persisted.content = storageSafe(job.content, new Set(), {
    redactJobFields: true,
    redactStrings: true,
  });
  if (job.options !== undefined) {
    persisted.options = storageSafe(job.options, new Set(), {
      redactJobFields: true,
      redactStrings: true,
    });
  }
  if (job.result !== undefined) persisted.result = CONTENT_PLACEHOLDER;
  if (job.error !== undefined) persisted.error = redactJobError(job.error);
  return storageSafe(persisted) as JobSnapshot;
}

function containsStoragePlaceholder(value: unknown, seen = new Set<object>()): boolean {
  if (
    value === BINARY_PLACEHOLDER ||
    value === CONTENT_PLACEHOLDER ||
    value === "[REDACTED]" ||
    value === "[CIRCULAR]"
  ) return true;
  if (!value || typeof value !== "object") return false;
  const object = value as object;
  if (seen.has(object)) return true;
  seen.add(object);
  try {
    return Object.values(value as Record<string, unknown>)
      .some((item) => containsStoragePlaceholder(item, seen));
  } finally {
    seen.delete(object);
  }
}

function dayKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function defaultTransientError(error: unknown): boolean {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const status = Number(record.status ?? 0);
  if (status === 429 || (status >= 500 && status <= 599) || record.retryable === true) return true;
  const code = String(record.code ?? "");
  return /timeout|network|temporar|rate.?limit|econnreset|etimedout/iu.test(`${code} ${redactJobError(error)}`);
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new JobQueueError("CANCELLED", "작업이 취소되었습니다."));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new JobQueueError("CANCELLED", "작업이 취소되었습니다."));
    }, { once: true });
  });
}

// Premiere 26.3 UXP 런타임에는 queueMicrotask 전역이 없어 드레인 스케줄이 즉시
// 예외로 실패했다(Host smoke에서 확인). 존재하면 사용하고, 없으면 Promise 마이크로태스크로 대체한다.
function scheduleMicrotask(callback: () => void): void {
  const queue = (globalThis as { queueMicrotask?: (task: () => void) => void }).queueMicrotask;
  if (typeof queue === "function") queue(callback);
  else void Promise.resolve().then(callback);
}

function deferred(): Deferred {
  let resolvePromise!: (job: JobSnapshot) => void;
  const promise = new Promise<JobSnapshot>((resolve) => { resolvePromise = resolve; });
  return { promise, resolve: resolvePromise };
}

export class JobQueue {
  private readonly executor: JobExecutor;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly isTransientError: (error: unknown) => boolean;
  private readonly storage: JobQueueStorage | undefined;
  private readonly storageKey: string;
  private readonly defaultMaxRetries: number;
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly defaultCacheTtlMs: number;
  private readonly jobs = new Map<string, InternalJob>();
  private readonly hashes = new Map<string, string>();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly listeners = new Set<JobQueueListener>();
  private readonly completions = new Map<string, Deferred>();
  private concurrency: number;
  private activeCount = 0;
  private paused = false;
  private sequence = 0;
  private drainScheduled = false;
  private persistence = Promise.resolve();
  private budget: DailyBudget;
  private usage: DailyUsage;

  constructor(executor: JobExecutor, options: JobQueueOptions = {}) {
    if (typeof executor !== "function") throw new JobQueueError("INVALID_JOB", "작업 실행기가 필요합니다.");
    this.executor = executor;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? defaultSleep;
    this.isTransientError = options.isTransientError ?? defaultTransientError;
    this.storage = options.storage;
    this.storageKey = options.storageKey?.trim() || JOB_QUEUE_STORAGE_KEY;
    this.concurrency = integerInRange(options.concurrency, 1, 1, MAX_JOB_CONCURRENCY);
    this.defaultMaxRetries = integerInRange(options.maxRetries, 2, 0, 10);
    this.baseRetryDelayMs = integerInRange(options.baseRetryDelayMs, 500, 0, 60_000);
    this.maxRetryDelayMs = integerInRange(options.maxRetryDelayMs, 30_000, this.baseRetryDelayMs, 300_000);
    this.defaultCacheTtlMs = integerInRange(options.defaultCacheTtlMs, 86_400_000, 0, 2_147_483_647);
    this.budget = this.normalizeBudget(options.budget ?? {});
    this.usage = { day: dayKey(this.now()), requests: 0, costUnits: 0 };
  }

  get isPaused(): boolean { return this.paused; }
  get currentConcurrency(): number { return this.concurrency; }
  get runningCount(): number { return this.activeCount; }

  list(): JobSnapshot[] {
    return [...this.jobs.values()].map((job) => this.snapshot(job));
  }

  get(id: string): JobSnapshot | null {
    const job = this.jobs.get(id);
    return job ? this.snapshot(job) : null;
  }

  subscribe(listener: JobQueueListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  enqueue(request: JobRequest): JobSnapshot {
    this.validateRequest(request);
    const hash = hashJobContent(request.kind, request.content, request.options);
    const existingId = this.hashes.get(hash);
    const existing = existingId ? this.jobs.get(existingId) : undefined;
    if (existing && (existing.state === "queued" || existing.state === "running")) {
      this.emit("job-deduplicated", existing);
      return this.snapshot(existing);
    }

    this.pruneJobHistory(MAX_JOB_HISTORY - 1);
    if (this.jobs.size >= MAX_JOB_HISTORY) {
      throw new JobQueueError(
        "QUEUE_FULL",
        `작업 큐에는 동시에 최대 ${MAX_JOB_HISTORY.toLocaleString("ko-KR")}개를 보관할 수 있습니다.`,
      );
    }

    const cached = this.readCache(hash);
    const timestamp = this.now();
    const estimateUnits = finiteNonNegative(request.estimateUnits);
    const threshold = this.budget.confirmationThresholdUnits;
    const confirmRequired = request.confirmRequired === true ||
      (threshold !== undefined && estimateUnits > threshold);
    const job: InternalJob = {
      id: `job-${timestamp.toString(36)}-${(++this.sequence).toString(36)}`,
      hash,
      kind: request.kind,
      content: request.content,
      state: cached ? "succeeded" : "queued",
      progress: cached ? 1 : 0,
      attempt: 0,
      maxRetries: integerInRange(request.maxRetries, this.defaultMaxRetries, 0, 10),
      estimateUnits,
      confirmRequired,
      confirmed: request.confirmed === true || !confirmRequired,
      fromCache: Boolean(cached),
      recovered: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      cacheTtlMs: integerInRange(request.cacheTtlMs, this.defaultCacheTtlMs, 0, 2_147_483_647),
    };
    if (request.options !== undefined) job.options = request.options;
    if (cached) {
      job.completedAt = timestamp;
      job.result = cached.value ?? this.cacheReference(cached);
    }
    this.jobs.set(job.id, job);
    this.hashes.set(hash, job.id);
    const completion = deferred();
    this.completions.set(job.id, completion);
    this.emit(cached ? "cache-hit" : "job-added", job);
    if (cached) completion.resolve(this.snapshot(job));
    this.persist();
    this.scheduleDrain();
    return this.snapshot(job);
  }

  waitFor(id: string): Promise<JobSnapshot> {
    const job = this.jobs.get(id);
    if (!job) return Promise.reject(new JobQueueError("JOB_NOT_FOUND", "작업을 찾을 수 없습니다."));
    if (this.isTerminal(job.state)) return Promise.resolve(this.snapshot(job));
    let completion = this.completions.get(id);
    if (!completion) {
      completion = deferred();
      this.completions.set(id, completion);
    }
    return completion.promise;
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || this.isTerminal(job.state)) return false;
    if (job.state === "queued") {
      this.transitionTerminal(job, "cancelled", new JobQueueError("CANCELLED", "사용자가 작업을 취소했습니다."));
    } else {
      job.controller?.abort();
      this.transitionTerminal(job, "cancelled", new JobQueueError("CANCELLED", "사용자가 작업을 취소했습니다."));
    }
    return true;
  }

  confirm(id: string): JobSnapshot {
    const job = this.requireJob(id);
    if (job.state !== "queued") throw new JobQueueError("INVALID_STATE", "대기 중인 작업만 승인할 수 있습니다.");
    job.confirmed = true;
    job.updatedAt = this.now();
    this.emit("job-updated", job);
    this.persist();
    this.scheduleDrain();
    return this.snapshot(job);
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.emit("paused");
    this.persist();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.emit("resumed");
    this.persist();
    this.scheduleDrain();
  }

  setConcurrency(value: number): number {
    this.concurrency = integerInRange(value, this.concurrency, 1, MAX_JOB_CONCURRENCY);
    this.scheduleDrain();
    return this.concurrency;
  }

  setBudget(budget: DailyBudget): void {
    this.budget = this.normalizeBudget(budget);
    this.emit("budget-updated");
    this.persist();
    this.scheduleDrain();
  }

  getBudget(): Readonly<DailyBudget> { return { ...this.budget }; }

  getUsage(): Readonly<DailyUsage> {
    this.rollUsageDay();
    return { ...this.usage };
  }

  getCacheMetadata(): Array<Omit<CacheEntry, "value">> {
    this.pruneCache();
    return [...this.cache.values()].map(({ value: _value, ...metadata }) => ({ ...metadata }));
  }

  clearCache(): void {
    this.cache.clear();
    for (const [hash, id] of this.hashes) {
      const job = this.jobs.get(id);
      if (job?.state === "succeeded") this.hashes.delete(hash);
    }
    this.persist();
  }

  async restore(): Promise<number> {
    if (!this.storage) return 0;
    let serialized: string | null;
    try {
      serialized = await this.storage.getItem(this.storageKey);
      if (!serialized) return 0;
      const state = JSON.parse(serialized) as SerializedState;
      if (state.version !== 1 || !Array.isArray(state.jobs) || !Array.isArray(state.cache)) {
        throw new Error("invalid queue state");
      }
      this.paused = Boolean(state.paused);
      this.budget = this.normalizeBudget(state.budget ?? {});
      this.usage = this.validUsage(state.usage) ? state.usage : this.usage;
      this.rollUsageDay();
      this.jobs.clear();
      this.hashes.clear();
      this.cache.clear();
      this.completions.clear();
      let recovered = 0;
      for (const saved of state.jobs.slice(-MAX_JOB_HISTORY)) {
        if (
          !saved ||
          !JOB_KINDS.has(saved.kind) ||
          typeof saved.id !== "string" ||
          !saved.id ||
          typeof saved.hash !== "string" ||
          !saved.hash ||
          !["queued", "running", "succeeded", "failed", "cancelled"].includes(saved.state)
        ) continue;
        const timestamp = this.now();
        const omittedInput = containsStoragePlaceholder(saved.content) ||
          containsStoragePlaceholder(saved.options);
        const cannotResume = omittedInput && (saved.state === "queued" || saved.state === "running");
        const job: InternalJob = {
          ...saved,
          state: cannotResume ? "cancelled" : saved.state === "running" ? "queued" : saved.state,
          recovered: saved.state === "running" || cannotResume || saved.recovered,
          updatedAt: saved.state === "running" || cannotResume ? timestamp : saved.updatedAt,
          cacheTtlMs: this.defaultCacheTtlMs,
        };
        delete job.controller;
        if (saved.state === "running") {
          delete job.startedAt;
          recovered += 1;
        }
        if (cannotResume) {
          job.completedAt = timestamp;
          job.error = "보안을 위해 저장하지 않은 작업 입력이 있어 자동 복구를 취소했습니다.";
        }
        this.jobs.set(job.id, job);
        if (!this.isTerminal(job.state) || job.state === "succeeded") this.hashes.set(job.hash, job.id);
        this.sequence += 1;
        if (!this.isTerminal(job.state)) this.completions.set(job.id, deferred());
      }
      for (const entry of state.cache) {
        if (entry && typeof entry.hash === "string" && entry.expiresAt > this.now()) {
          this.cache.set(entry.hash, { ...entry });
        }
      }
      this.enforceCacheLimit();
      this.emit("restored", undefined, `${recovered} running job(s) recovered`);
      this.persist();
      this.scheduleDrain();
      return recovered;
    } catch (error) {
      throw new JobQueueError("RESTORE_FAILED", `저장된 작업 큐를 복구하지 못했습니다: ${redactJobError(error)}`);
    }
  }

  async flushPersistence(): Promise<void> { await this.persistence; }

  private validateRequest(request: JobRequest): void {
    if (!request || !JOB_KINDS.has(request.kind)) throw new JobQueueError("INVALID_JOB", "지원하지 않는 AI 작업 종류입니다.");
    if (request.content === undefined) throw new JobQueueError("INVALID_JOB", "작업 내용이 필요합니다.");
    finiteNonNegative(request.estimateUnits);
    stableCanonicalize({ kind: request.kind, content: request.content, options: request.options });
  }

  private normalizeBudget(budget: DailyBudget): DailyBudget {
    const normalized: DailyBudget = {};
    if (budget.requestLimit !== undefined) normalized.requestLimit = integerInRange(budget.requestLimit, 0, 0, 1_000_000_000);
    if (budget.costLimitUnits !== undefined) normalized.costLimitUnits = finiteNonNegative(budget.costLimitUnits);
    if (budget.confirmationThresholdUnits !== undefined) normalized.confirmationThresholdUnits = finiteNonNegative(budget.confirmationThresholdUnits);
    return normalized;
  }

  private validUsage(usage: unknown): usage is DailyUsage {
    const value = usage as DailyUsage;
    return Boolean(value && typeof value.day === "string" && finiteNonNegative(value.requests) === value.requests && finiteNonNegative(value.costUnits) === value.costUnits);
  }

  private rollUsageDay(): void {
    const today = dayKey(this.now());
    if (this.usage.day !== today) this.usage = { day: today, requests: 0, costUnits: 0 };
  }

  private reserveBudget(estimateUnits: number): void {
    this.rollUsageDay();
    if (this.budget.requestLimit !== undefined && this.usage.requests + 1 > this.budget.requestLimit) {
      throw new JobQueueError("BUDGET_EXCEEDED", "오늘의 AI 요청 한도에 도달했습니다.");
    }
    if (this.budget.costLimitUnits !== undefined && this.usage.costUnits + estimateUnits > this.budget.costLimitUnits) {
      throw new JobQueueError("BUDGET_EXCEEDED", "오늘의 AI 비용 단위 한도를 초과합니다.");
    }
    this.usage.requests += 1;
    this.usage.costUnits += estimateUnits;
  }

  private adjustActualCost(estimateUnits: number, actualUnits: unknown): void {
    if (typeof actualUnits !== "number" || !Number.isFinite(actualUnits) || actualUnits < 0) return;
    this.usage.costUnits = Math.max(0, this.usage.costUnits + actualUnits - estimateUnits);
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    scheduleMicrotask(() => {
      this.drainScheduled = false;
      this.drain();
    });
  }

  private drain(): void {
    if (this.paused) return;
    while (this.activeCount < this.concurrency) {
      const job = [...this.jobs.values()].find((candidate) => candidate.state === "queued" && candidate.confirmed);
      if (!job) return;
      this.activeCount += 1;
      job.state = "running";
      job.startedAt = this.now();
      job.updatedAt = job.startedAt;
      job.controller = new AbortController();
      this.emit("job-updated", job);
      this.persist();
      void this.run(job).finally(() => {
        this.activeCount -= 1;
        delete job.controller;
        this.scheduleDrain();
      });
    }
  }

  private async run(job: InternalJob): Promise<void> {
    const controller = job.controller;
    if (!controller) return;
    while (job.attempt <= job.maxRetries) {
      if (controller.signal.aborted) {
        this.transitionTerminal(job, "cancelled", new JobQueueError("CANCELLED", "사용자가 작업을 취소했습니다."));
        return;
      }
      job.attempt += 1;
      job.updatedAt = this.now();
      this.emit("job-updated", job);
      try {
        this.reserveBudget(job.estimateUnits);
        const result = await this.runExecutorWithAbort(job, controller);
        if (controller.signal.aborted) {
          this.transitionTerminal(job, "cancelled", new JobQueueError("CANCELLED", "사용자가 작업을 취소했습니다."));
          return;
        }
        this.adjustActualCost(job.estimateUnits, result?.costUnits);
        job.result = result?.value;
        job.progress = 1;
        this.storeCache(job, result);
        this.transitionTerminal(job, "succeeded");
        return;
      } catch (error) {
        if (controller.signal.aborted || (error instanceof JobQueueError && error.code === "CANCELLED")) {
          this.transitionTerminal(job, "cancelled", error);
          return;
        }
        const canRetry = this.isTransientError(error) && job.attempt <= job.maxRetries;
        if (!canRetry) {
          this.transitionTerminal(job, "failed", error);
          return;
        }
        const delay = this.retryDelay(job.attempt);
        try {
          await this.sleep(delay, controller.signal);
        } catch (sleepError) {
          this.transitionTerminal(job, "cancelled", sleepError);
          return;
        }
      }
    }
  }

  private retryDelay(attempt: number): number {
    const exponential = Math.min(this.maxRetryDelayMs, this.baseRetryDelayMs * (2 ** Math.max(0, attempt - 1)));
    const jitter = 0.5 + clamp(this.random(), 0, 1);
    return Math.min(this.maxRetryDelayMs, Math.round(exponential * jitter));
  }

  private reportProgress(job: InternalJob, progress: number): void {
    if (job.state !== "running" || !Number.isFinite(progress)) return;
    job.progress = clamp(progress, 0, 1);
    job.updatedAt = this.now();
    this.emit("job-updated", job);
  }

  private transitionTerminal(job: InternalJob, state: Extract<JobState, "succeeded" | "failed" | "cancelled">, error?: unknown): void {
    if (this.isTerminal(job.state)) return;
    job.state = state;
    job.updatedAt = this.now();
    job.completedAt = job.updatedAt;
    if (state !== "succeeded") {
      job.error = redactJobError(error);
      this.hashes.delete(job.hash);
    }
    this.emit("job-updated", job);
    const snapshot = this.snapshot(job);
    this.completions.get(job.id)?.resolve(snapshot);
    this.completions.delete(job.id);
    this.persist();
  }

  private runExecutorWithAbort(
    job: InternalJob,
    controller: AbortController,
  ): Promise<JobExecutionResult> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (operation: () => void): void => {
        if (settled) return;
        settled = true;
        controller.signal.removeEventListener("abort", onAbort);
        operation();
      };
      const onAbort = (): void => settle(() => reject(
        new JobQueueError("CANCELLED", "사용자가 작업을 취소했습니다."),
      ));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      if (controller.signal.aborted) {
        onAbort();
        return;
      }
      void Promise.resolve().then(() => this.executor(this.snapshot(job), {
        signal: controller.signal,
        attempt: job.attempt,
        reportProgress: (progress) => this.reportProgress(job, progress),
      })).then(
        (result) => settle(() => resolve(result)),
        (error: unknown) => settle(() => reject(error)),
      );
    });
  }

  private storeCache(job: InternalJob, result: JobExecutionResult | undefined): void {
    const ttlMs = integerInRange(result?.cache?.ttlMs, job.cacheTtlMs, 0, 2_147_483_647);
    if (ttlMs <= 0) return;
    const timestamp = this.now();
    const entry: CacheEntry = {
      hash: job.hash,
      createdAt: timestamp,
      lastAccessedAt: timestamp,
      expiresAt: timestamp + ttlMs,
    };
    if (result?.value !== undefined) entry.value = result.value;
    if (result?.cache?.fileToken) entry.fileToken = result.cache.fileToken;
    if (result?.cache?.metadata !== undefined) entry.metadata = storageSafe(result.cache.metadata);
    this.cache.set(job.hash, entry);
    this.enforceCacheLimit();
  }

  private readCache(hash: string): CacheEntry | null {
    this.pruneCache();
    const entry = this.cache.get(hash);
    if (!entry) return null;
    entry.lastAccessedAt = this.now();
    return entry;
  }

  private pruneCache(): void {
    const timestamp = this.now();
    for (const [hash, entry] of this.cache) if (entry.expiresAt <= timestamp) this.cache.delete(hash);
  }

  private enforceCacheLimit(): void {
    this.pruneCache();
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      let oldest: CacheEntry | undefined;
      for (const entry of this.cache.values()) if (!oldest || entry.lastAccessedAt < oldest.lastAccessedAt) oldest = entry;
      if (!oldest) break;
      this.cache.delete(oldest.hash);
      const id = this.hashes.get(oldest.hash);
      if (id && this.jobs.get(id)?.state === "succeeded") this.hashes.delete(oldest.hash);
    }
  }

  private cacheReference(entry: CacheEntry): unknown {
    const reference: Record<string, unknown> = {};
    if (entry.fileToken) reference.fileToken = entry.fileToken;
    if (entry.metadata !== undefined) reference.metadata = entry.metadata;
    return reference;
  }

  private pruneJobHistory(targetSize = MAX_JOB_HISTORY): void {
    if (this.jobs.size <= targetSize) return;
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= targetSize) break;
      if (!this.isTerminal(job.state)) continue;
      this.jobs.delete(id);
      this.completions.delete(id);
      if (this.hashes.get(job.hash) === id) this.hashes.delete(job.hash);
    }
  }

  private snapshot(job: InternalJob): JobSnapshot {
    const snapshot = { ...job } as Partial<InternalJob>;
    delete snapshot.cacheTtlMs;
    delete snapshot.controller;
    return snapshot as JobSnapshot;
  }

  private requireJob(id: string): InternalJob {
    const job = this.jobs.get(id);
    if (!job) throw new JobQueueError("JOB_NOT_FOUND", "작업을 찾을 수 없습니다.");
    return job;
  }

  private isTerminal(state: JobState): boolean {
    return state === "succeeded" || state === "failed" || state === "cancelled";
  }

  private emit(type: JobQueueEventType, job?: InternalJob, message?: string): void {
    const event: JobQueueEvent = { type, timestamp: this.now() };
    if (job) event.job = this.snapshot(job);
    if (message) event.message = redactJobError(message);
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* subscriber failures must not stop the queue */ }
    }
  }

  private persist(): void {
    if (!this.storage) return;
    const storage = this.storage;
    const state: SerializedState = {
      version: 1,
      paused: this.paused,
      jobs: this.list().map(persistableJob),
      cache: this.getCacheMetadata().map((entry) =>
        storageSafe(entry, new Set(), { allowFileToken: true }) as Omit<CacheEntry, "value">),
      usage: { ...this.usage },
      budget: { ...this.budget },
    };
    this.persistence = this.persistence
      .then(() => storage.setItem(this.storageKey, JSON.stringify(state)))
      .catch((error) => { this.emit("persistence-error", undefined, redactJobError(error)); });
  }
}
