export const RECOVERY_SCHEMA_VERSION = 1 as const;
export const RECOVERY_STORAGE_KEY = "shortflow.recoveryJournal.v1";
export const MAX_OPERATION_JOURNAL = 50;

export const RECOVERY_CONFIRM_RESULT = "confirm" as const;

export async function confirmDestructiveRecovery(
  showModal: unknown,
  options: unknown,
): Promise<boolean> {
  if (typeof showModal !== "function") return false;
  try {
    const result = await (showModal as (value: unknown) => unknown)(options);
    return result === RECOVERY_CONFIRM_RESULT;
  } catch {
    return false;
  }
}

export type OperationStatus =
  | "running"
  | "committed"
  | "failed"
  | "rolling-back"
  | "rolled-back"
  | "rollback-failed"
  | "interrupted";

export type DiffChangeType = "added" | "removed" | "changed";

export interface PreviewDiffChange {
  path: string;
  type: DiffChangeType;
  before?: unknown;
  after?: unknown;
}

export interface OperationPreview {
  beforeSummary: unknown;
  afterSummary: unknown;
  changes: PreviewDiffChange[];
  truncated: boolean;
}

export interface CloneBeforeMutationPolicy {
  sourceId: string;
  cloneId: string;
  createdBeforeMutation: boolean;
  verified: boolean;
}

export interface ClonePolicyValidation {
  valid: boolean;
  reasons: string[];
}

export type ExternalEffectStatus =
  | "pending"
  | "rolled-back"
  | "rollback-failed";

export interface ExternalEffectRecord {
  effectId: string;
  label: string;
  status: ExternalEffectStatus;
  rollbackAvailable: boolean;
  error?: string;
}

export interface OperationJournalEntry {
  schemaVersion: typeof RECOVERY_SCHEMA_VERSION;
  operationId: string;
  kind: string;
  label: string;
  status: OperationStatus;
  preview: OperationPreview;
  clonePolicy: CloneBeforeMutationPolicy;
  originalPreserved: boolean;
  externalEffects: ExternalEffectRecord[];
  createdAt: number;
  updatedAt: number;
  startedAt: number;
  completedAt?: number;
  resultSummary?: unknown;
  error?: string;
  recoveryGuidance: string;
}

export interface BeginOperationInput {
  operationId?: string;
  kind: string;
  label?: string;
  beforeSummary: unknown;
  afterSummary: unknown;
  clonePolicy: CloneBeforeMutationPolicy;
}

export interface MutationOutcome {
  afterSummary?: unknown;
  resultSummary?: unknown;
}

export interface MutationContext {
  readonly operationId: string;
  readonly sourceId: string;
  readonly cloneId: string;
  registerExternalEffect(label: string, rollback: ExternalRollback): string;
  updatePreview(afterSummary: unknown): void;
}

export type ExternalRollback = () => void | Promise<void>;
export type MutationExecutor = (
  context: MutationContext,
) => MutationOutcome | void | Promise<MutationOutcome | void>;

export interface ExecuteOperationOptions {
  autoRollbackOnFailure?: boolean;
}

export interface RecoveryStorage {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem?(key: string): void | Promise<void>;
}

export interface RecoveryManagerOptions {
  storage?: RecoveryStorage;
  storageKey?: string;
  now?: () => number;
  idFactory?: (kind: string, timestamp: number, sequence: number) => string;
}

export type RecoveryEventType =
  | "began"
  | "committed"
  | "failed"
  | "rollback-started"
  | "rolled-back"
  | "rollback-failed"
  | "restored"
  | "persistence-error";

export interface RecoveryEvent {
  type: RecoveryEventType;
  timestamp: number;
  entry?: OperationJournalEntry;
  message?: string;
}

export type RecoveryListener = (event: Readonly<RecoveryEvent>) => void;

export type RecoveryErrorCode =
  | "INVALID_OPERATION"
  | "DUPLICATE_OPERATION"
  | "OPERATION_NOT_FOUND"
  | "INVALID_TRANSITION"
  | "CLONE_REQUIRED"
  | "JOURNAL_FULL"
  | "MUTATION_FAILED"
  | "ROLLBACK_FAILED"
  | "RESTORE_FAILED";

export class RecoveryError extends Error {
  override readonly name = "RecoveryError";
  readonly code: RecoveryErrorCode;
  readonly operationId?: string;

  constructor(code: RecoveryErrorCode, message: string, operationId?: string) {
    super(message);
    this.code = code;
    if (operationId !== undefined) this.operationId = operationId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

interface SerializedRecoveryState {
  schemaVersion: typeof RECOVERY_SCHEMA_VERSION;
  entries: OperationJournalEntry[];
}

interface RollbackRegistration {
  effectId: string;
  callback: ExternalRollback;
}

const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const SENSITIVE_KEY = /api.?key|authorization|bearer|password|secret|access.?token|refresh.?token/iu;
const BINARY_PLACEHOLDER = "[BINARY_OMITTED]";
const MAX_DIFF_CHANGES = 100;

export const ORIGINAL_PRESERVED_GUIDANCE =
  "원본은 변경하지 않고 검증된 복제본에서 작업했습니다. 실패한 복제본을 닫거나 제거한 뒤 원본을 다시 열어 확인해 주세요.";
export const INTERRUPTED_GUIDANCE =
  "Premiere Pro가 작업 중 종료되었습니다. 원본은 보존되어야 하며, 복제본과 외부 출력 파일을 확인한 뒤 롤백 또는 새 복제본에서 재시도해 주세요.";
export const MANUAL_RESTORE_GUIDANCE =
  "자동 롤백을 완료하지 못했습니다. 원본 프로젝트를 다시 열고 복제본을 제거한 뒤, 기록된 외부 파일이나 작업을 수동으로 정리해 주세요.";

function storageSafe(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return undefined;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return BINARY_PLACEHOLDER;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : "Invalid Date";

  const object = value as object;
  if (seen.has(object)) return "[CIRCULAR]";
  seen.add(object);
  try {
    if (Array.isArray(value)) return value.map((item) => storageSafe(item, seen));
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      output[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : storageSafe(item, seen);
    }
    return output;
  } finally {
    seen.delete(object);
  }
}

export function redactRecoveryData<T = unknown>(value: T): T {
  return storageSafe(value) as T;
}

export function redactRecoveryError(error: unknown): string {
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
    .replace(/("?(?:api[_-]?key|password|secret|access[_-]?token|refresh[_-]?token)"?\s*[:=]\s*["']?)[^\s,"'}]+/giu, "$1[REDACTED]")
    .slice(0, 2_000);
}

function areEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  try { return JSON.stringify(left) === JSON.stringify(right); } catch { return false; }
}

function collectChanges(
  before: unknown,
  after: unknown,
  path: string,
  changes: PreviewDiffChange[],
): boolean {
  if (areEqual(before, after)) return false;
  if (changes.length >= MAX_DIFF_CHANGES) return true;

  const beforeObject = before && typeof before === "object" && !Array.isArray(before);
  const afterObject = after && typeof after === "object" && !Array.isArray(after);
  if (beforeObject && afterObject) {
    const left = before as Record<string, unknown>;
    const right = after as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    let truncated = false;
    for (const key of keys) {
      if (changes.length >= MAX_DIFF_CHANGES) return true;
      const childPath = path ? `${path}.${key}` : key;
      if (!(key in left)) {
        changes.push({ path: childPath, type: "added", after: right[key] });
      } else if (!(key in right)) {
        changes.push({ path: childPath, type: "removed", before: left[key] });
      } else {
        truncated = collectChanges(left[key], right[key], childPath, changes) || truncated;
      }
    }
    return truncated;
  }

  const change: PreviewDiffChange = { path: path || "$", type: "changed" };
  if (before !== undefined) change.before = before;
  if (after !== undefined) change.after = after;
  changes.push(change);
  return false;
}

export function createPreviewDiff(beforeSummary: unknown, afterSummary: unknown): OperationPreview {
  const before = redactRecoveryData(beforeSummary);
  const after = redactRecoveryData(afterSummary);
  const changes: PreviewDiffChange[] = [];
  const truncated = collectChanges(before, after, "", changes);
  return { beforeSummary: before, afterSummary: after, changes, truncated };
}

export function validateOperationId(operationId: string): boolean {
  return typeof operationId === "string" && OPERATION_ID_PATTERN.test(operationId);
}

export function validateCloneBeforeMutation(
  policy: CloneBeforeMutationPolicy,
): ClonePolicyValidation {
  const reasons: string[] = [];
  const sourceId = typeof policy?.sourceId === "string" ? policy.sourceId.trim() : "";
  const cloneId = typeof policy?.cloneId === "string" ? policy.cloneId.trim() : "";
  if (!sourceId) reasons.push("원본 식별자가 없습니다.");
  if (!cloneId) reasons.push("복제본 식별자가 없습니다.");
  if (sourceId && cloneId && sourceId === cloneId) reasons.push("원본과 복제본 식별자가 같아 비파괴 작업을 보장할 수 없습니다.");
  if (policy?.createdBeforeMutation !== true) reasons.push("mutation 전에 복제본을 생성해야 합니다.");
  if (policy?.verified !== true) reasons.push("복제본 검증이 완료되지 않았습니다.");
  return { valid: reasons.length === 0, reasons };
}

function defaultIdFactory(kind: string, timestamp: number, sequence: number): string {
  const safeKind = kind.toLocaleLowerCase("en-US").replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "operation";
  return `op-${safeKind}-${timestamp.toString(36)}-${sequence.toString(36)}`;
}

function cloneEntry(entry: OperationJournalEntry): OperationJournalEntry {
  return {
    ...entry,
    preview: {
      ...entry.preview,
      changes: entry.preview.changes.map((change) => ({ ...change })),
    },
    clonePolicy: { ...entry.clonePolicy },
    externalEffects: entry.externalEffects.map((effect) => ({ ...effect })),
  };
}

function isRollbackState(status: OperationStatus): boolean {
  return status === "committed" || status === "failed" || status === "interrupted" || status === "rollback-failed";
}

function isTerminalForPruning(status: OperationStatus): boolean {
  return status === "committed" || status === "failed" || status === "rolled-back" || status === "rollback-failed" || status === "interrupted";
}

export class RecoveryManager {
  private readonly storage: RecoveryStorage | undefined;
  private readonly storageKey: string;
  private readonly now: () => number;
  private readonly idFactory: (kind: string, timestamp: number, sequence: number) => string;
  private readonly entries = new Map<string, OperationJournalEntry>();
  private readonly rollbacks = new Map<string, RollbackRegistration[]>();
  private readonly listeners = new Set<RecoveryListener>();
  private sequence = 0;
  private mutationTail: Promise<unknown> = Promise.resolve();
  private persistenceTail: Promise<void> = Promise.resolve();

  constructor(options: RecoveryManagerOptions = {}) {
    this.storage = options.storage;
    this.storageKey = options.storageKey?.trim() || RECOVERY_STORAGE_KEY;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? defaultIdFactory;
  }

  list(): OperationJournalEntry[] {
    return [...this.entries.values()].map(cloneEntry);
  }

  get(operationId: string): OperationJournalEntry | null {
    const entry = this.entries.get(operationId);
    return entry ? cloneEntry(entry) : null;
  }

  subscribe(listener: RecoveryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  preview(beforeSummary: unknown, afterSummary: unknown): OperationPreview {
    return createPreviewDiff(beforeSummary, afterSummary);
  }

  begin(input: BeginOperationInput): OperationJournalEntry {
    const kind = typeof input?.kind === "string" ? input.kind.trim() : "";
    if (!kind) throw new RecoveryError("INVALID_OPERATION", "작업 종류가 필요합니다.");
    const policyValidation = validateCloneBeforeMutation(input.clonePolicy);
    if (!policyValidation.valid) {
      throw new RecoveryError("CLONE_REQUIRED", `원본 복제 정책을 충족하지 못했습니다: ${policyValidation.reasons.join(" ")}`);
    }

    this.ensureJournalCapacity();
    const timestamp = this.now();
    const operationId = input.operationId ?? this.idFactory(kind, timestamp, ++this.sequence);
    if (!validateOperationId(operationId)) {
      throw new RecoveryError("INVALID_OPERATION", "operationId는 8~128자의 안전하고 안정적인 식별자여야 합니다.");
    }
    if (this.entries.has(operationId)) {
      throw new RecoveryError("DUPLICATE_OPERATION", "이미 존재하는 operationId입니다.", operationId);
    }

    const entry: OperationJournalEntry = {
      schemaVersion: RECOVERY_SCHEMA_VERSION,
      operationId,
      kind,
      label: input.label?.trim() || kind,
      status: "running",
      preview: createPreviewDiff(input.beforeSummary, input.afterSummary),
      clonePolicy: { ...input.clonePolicy },
      originalPreserved: true,
      externalEffects: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: timestamp,
      recoveryGuidance: ORIGINAL_PRESERVED_GUIDANCE,
    };
    this.entries.set(operationId, entry);
    this.emit("began", entry);
    this.persist();
    return cloneEntry(entry);
  }

  commit(operationId: string, afterSummary?: unknown, resultSummary?: unknown): OperationJournalEntry {
    const entry = this.requireStatus(operationId, "running", "commit");
    if (afterSummary !== undefined) entry.preview = createPreviewDiff(entry.preview.beforeSummary, afterSummary);
    if (resultSummary !== undefined) entry.resultSummary = redactRecoveryData(resultSummary);
    entry.status = "committed";
    entry.updatedAt = this.now();
    entry.completedAt = entry.updatedAt;
    entry.recoveryGuidance = ORIGINAL_PRESERVED_GUIDANCE;
    this.emit("committed", entry);
    this.persist();
    return cloneEntry(entry);
  }

  fail(operationId: string, error: unknown): OperationJournalEntry {
    const entry = this.requireStatus(operationId, "running", "fail");
    entry.status = "failed";
    entry.error = redactRecoveryError(error);
    entry.updatedAt = this.now();
    entry.completedAt = entry.updatedAt;
    entry.recoveryGuidance = ORIGINAL_PRESERVED_GUIDANCE;
    this.emit("failed", entry);
    this.persist();
    return cloneEntry(entry);
  }

  registerExternalEffect(
    operationId: string,
    label: string,
    rollback: ExternalRollback,
  ): string {
    const entry = this.entries.get(operationId);
    if (!entry) throw new RecoveryError("OPERATION_NOT_FOUND", "복구 작업을 찾을 수 없습니다.", operationId);
    if (entry.status !== "running") {
      throw new RecoveryError("INVALID_TRANSITION", "실행 중인 작업에만 외부 부작용 롤백을 등록할 수 있습니다.", operationId);
    }
    if (typeof rollback !== "function") throw new RecoveryError("INVALID_OPERATION", "롤백 콜백이 필요합니다.", operationId);
    const safeLabel = label.trim();
    if (!safeLabel) throw new RecoveryError("INVALID_OPERATION", "외부 부작용 이름이 필요합니다.", operationId);
    const registrations = this.rollbacks.get(operationId) ?? [];
    const effectId = `${operationId}:effect:${registrations.length + 1}`;
    registrations.push({ effectId, callback: rollback });
    this.rollbacks.set(operationId, registrations);
    entry.externalEffects.push({ effectId, label: safeLabel, status: "pending", rollbackAvailable: true });
    entry.updatedAt = this.now();
    this.persist();
    return effectId;
  }

  rollback(operationId: string, fallbackRollback?: ExternalRollback): Promise<OperationJournalEntry> {
    return this.serializeMutation(() => this.rollbackInternal(operationId, fallbackRollback));
  }

  execute(
    input: BeginOperationInput,
    mutation: MutationExecutor,
    options: ExecuteOperationOptions = {},
  ): Promise<OperationJournalEntry> {
    if (typeof mutation !== "function") {
      return Promise.reject(new RecoveryError("INVALID_OPERATION", "mutation 실행 함수가 필요합니다."));
    }
    return this.serializeMutation(async () => {
      const begun = this.begin(input);
      const operationId = begun.operationId;
      const context: MutationContext = {
        operationId,
        sourceId: begun.clonePolicy.sourceId,
        cloneId: begun.clonePolicy.cloneId,
        registerExternalEffect: (label, callback) => this.registerExternalEffect(operationId, label, callback),
        updatePreview: (afterSummary) => {
          const entry = this.requireStatus(operationId, "running", "preview update");
          entry.preview = createPreviewDiff(entry.preview.beforeSummary, afterSummary);
          entry.updatedAt = this.now();
          this.persist();
        },
      };
      try {
        const outcome = await mutation(context);
        return this.commit(operationId, outcome?.afterSummary, outcome?.resultSummary);
      } catch (error) {
        this.fail(operationId, error);
        if (options.autoRollbackOnFailure) {
          try { return await this.rollbackInternal(operationId); } catch { /* throw the safe mutation error below */ }
        }
        throw new RecoveryError(
          "MUTATION_FAILED",
          `복제본 작업이 실패했습니다. ${ORIGINAL_PRESERVED_GUIDANCE} 원인: ${redactRecoveryError(error)}`,
          operationId,
        );
      }
    });
  }

  async restore(): Promise<number> {
    if (!this.storage) return 0;
    try {
      const serialized = await this.storage.getItem(this.storageKey);
      if (!serialized) return 0;
      const state = JSON.parse(serialized) as SerializedRecoveryState;
      if (state.schemaVersion !== RECOVERY_SCHEMA_VERSION || !Array.isArray(state.entries)) {
        throw new Error("unsupported recovery schema");
      }
      this.entries.clear();
      this.rollbacks.clear();
      let interrupted = 0;
      const restored = state.entries.slice(-MAX_OPERATION_JOURNAL);
      for (const candidate of restored) {
        if (!candidate || candidate.schemaVersion !== RECOVERY_SCHEMA_VERSION || !validateOperationId(candidate.operationId)) continue;
        const entry = redactRecoveryData(candidate) as OperationJournalEntry;
        if (entry.status === "running" || entry.status === "rolling-back") {
          entry.status = "interrupted";
          entry.error = "이전 세션에서 작업이 완료되기 전에 중단되었습니다.";
          entry.updatedAt = this.now();
          entry.completedAt = entry.updatedAt;
          entry.recoveryGuidance = INTERRUPTED_GUIDANCE;
          interrupted += 1;
        }
        entry.externalEffects = (entry.externalEffects ?? []).map((effect) => ({
          ...effect,
          rollbackAvailable: false,
        }));
        this.entries.set(entry.operationId, entry);
        this.sequence += 1;
      }
      this.emit("restored", undefined, `${interrupted} operation(s) interrupted`);
      this.persist();
      return interrupted;
    } catch (error) {
      throw new RecoveryError("RESTORE_FAILED", `복구 저널을 읽지 못했습니다: ${redactRecoveryError(error)}`);
    }
  }

  async flushPersistence(): Promise<void> {
    await this.persistenceTail;
  }

  async waitForIdle(): Promise<void> {
    await this.mutationTail.catch(() => undefined);
  }

  private async rollbackInternal(
    operationId: string,
    fallbackRollback?: ExternalRollback,
  ): Promise<OperationJournalEntry> {
    const entry = this.entries.get(operationId);
    if (!entry) throw new RecoveryError("OPERATION_NOT_FOUND", "복구 작업을 찾을 수 없습니다.", operationId);
    if (!isRollbackState(entry.status)) {
      throw new RecoveryError("INVALID_TRANSITION", `${entry.status} 상태에서는 rollback을 시작할 수 없습니다.`, operationId);
    }
    entry.status = "rolling-back";
    entry.updatedAt = this.now();
    this.emit("rollback-started", entry);
    this.persist();

    const registrations = [...(this.rollbacks.get(operationId) ?? [])].reverse();
    const unavailableEffects = entry.externalEffects.filter((effect) =>
      effect.status === "pending" && !registrations.some((registration) => registration.effectId === effect.effectId),
    );
    const errors: string[] = [];
    for (const registration of registrations) {
      const effect = entry.externalEffects.find((candidate) => candidate.effectId === registration.effectId);
      if (!effect || effect.status === "rolled-back") continue;
      try {
        await registration.callback();
        effect.status = "rolled-back";
        effect.rollbackAvailable = true;
        delete effect.error;
      } catch (error) {
        const safeError = redactRecoveryError(error);
        effect.status = "rollback-failed";
        effect.error = safeError;
        errors.push(`${effect.label}: ${safeError}`);
      }
    }
    if (fallbackRollback) {
      try { await fallbackRollback(); } catch (error) { errors.push(redactRecoveryError(error)); }
    } else if (unavailableEffects.length > 0) {
      errors.push("이전 세션의 외부 롤백 콜백을 복구할 수 없습니다.");
    }

    entry.updatedAt = this.now();
    entry.completedAt = entry.updatedAt;
    if (errors.length > 0) {
      entry.status = "rollback-failed";
      entry.error = errors.join(" ");
      entry.recoveryGuidance = MANUAL_RESTORE_GUIDANCE;
      this.emit("rollback-failed", entry);
      this.persist();
      throw new RecoveryError(
        "ROLLBACK_FAILED",
        `외부 부작용 롤백을 완료하지 못했습니다. ${MANUAL_RESTORE_GUIDANCE} 원인: ${entry.error}`,
        operationId,
      );
    }

    entry.status = "rolled-back";
    entry.recoveryGuidance = ORIGINAL_PRESERVED_GUIDANCE;
    this.emit("rolled-back", entry);
    this.persist();
    return cloneEntry(entry);
  }

  private serializeMutation<T>(task: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(task, task);
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private requireStatus(
    operationId: string,
    expected: OperationStatus,
    action: string,
  ): OperationJournalEntry {
    const entry = this.entries.get(operationId);
    if (!entry) throw new RecoveryError("OPERATION_NOT_FOUND", "복구 작업을 찾을 수 없습니다.", operationId);
    if (entry.status !== expected) {
      throw new RecoveryError("INVALID_TRANSITION", `${entry.status} 상태에서는 ${action}할 수 없습니다.`, operationId);
    }
    return entry;
  }

  private ensureJournalCapacity(): void {
    while (this.entries.size >= MAX_OPERATION_JOURNAL) {
      const removable = [...this.entries.values()].find((entry) => isTerminalForPruning(entry.status));
      if (!removable) throw new RecoveryError("JOURNAL_FULL", "실행 중인 복구 작업이 많아 새 작업을 시작할 수 없습니다.");
      this.entries.delete(removable.operationId);
      this.rollbacks.delete(removable.operationId);
    }
  }

  private emit(type: RecoveryEventType, entry?: OperationJournalEntry, message?: string): void {
    const event: RecoveryEvent = { type, timestamp: this.now() };
    if (entry) event.entry = cloneEntry(entry);
    if (message) event.message = redactRecoveryError(message);
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* listener failures cannot stop recovery */ }
    }
  }

  private persist(): void {
    if (!this.storage) return;
    const storage = this.storage;
    const state: SerializedRecoveryState = {
      schemaVersion: RECOVERY_SCHEMA_VERSION,
      entries: this.list().map((entry) => redactRecoveryData(entry)),
    };
    this.persistenceTail = this.persistenceTail
      .then(() => storage.setItem(this.storageKey, JSON.stringify(state)))
      .catch((error) => this.emit("persistence-error", undefined, redactRecoveryError(error)));
  }
}
