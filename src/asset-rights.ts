export const ASSET_RIGHTS_SCHEMA_VERSION = 1 as const;
export const ASSET_RIGHTS_STORAGE_KEY = "shortflow.assetRights.v1";
export const MAX_ASSET_RIGHTS_ITEMS = 10_000;
export const MAX_ASSET_RIGHTS_TEXT_LENGTH = 2_000;

export type MaybePromise<T> = T | Promise<T>;

export interface AssetRightsStorageAdapter {
  getItem(key: string): MaybePromise<string | null | undefined>;
  setItem(key: string, value: string): MaybePromise<void>;
  removeItem(key: string): MaybePromise<void>;
}

export type AssetRightsKind =
  | "music"
  | "sfx"
  | "image"
  | "video"
  | "ai-audio"
  | "ai-image"
  | "ai-video"
  | "other";

export type CommercialUseStatus = "allowed" | "forbidden" | "unknown";

export interface AssetRightsRecord {
  readonly assetId: string;
  readonly assetName: string;
  readonly kind: AssetRightsKind;
  readonly source: string;
  readonly license: string;
  readonly commercialUse: CommercialUseStatus;
  readonly expiresAt: string | null;
  readonly attribution: string;
  readonly notes: string;
  readonly updatedAt: number;
}

export interface AssetRightsInput {
  readonly assetId?: unknown;
  readonly assetName?: unknown;
  readonly kind?: unknown;
  readonly source?: unknown;
  readonly license?: unknown;
  readonly commercialUse?: unknown;
  readonly expiresAt?: unknown;
  readonly attribution?: unknown;
  readonly notes?: unknown;
  readonly updatedAt?: unknown;
}

export interface AssetRightsAssetLike {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly nativePath?: unknown;
  readonly normalizedPath?: unknown;
  readonly folderPath?: unknown;
  readonly kind?: unknown;
}

export interface AssetRightsReferenceLike {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly type?: unknown;
  readonly nativePath?: unknown;
  readonly source?: unknown;
  readonly notes?: unknown;
  readonly tags?: readonly unknown[] | unknown;
}

export interface AssetRightsTtsLike {
  readonly nativePath?: unknown;
  readonly name?: unknown;
  readonly model?: unknown;
  readonly voice?: unknown;
  readonly format?: unknown;
}

export type AssetRightsIssueLevel = "warning" | "error";

export interface AssetRightsIssue {
  readonly level: AssetRightsIssueLevel;
  readonly code: string;
  readonly assetId: string;
  readonly assetName: string;
  readonly message: string;
}

export interface AssetRightsReport {
  readonly schemaVersion: typeof ASSET_RIGHTS_SCHEMA_VERSION;
  readonly generatedAt: number;
  readonly assets: readonly AssetRightsRecord[];
  readonly issues: readonly AssetRightsIssue[];
  readonly counts: Record<AssetRightsIssueLevel, number>;
  readonly blocking: boolean;
  readonly attributionLines: readonly string[];
}

export type AssetRightsErrorCode =
  | "INVALID_RECORD"
  | "INPUT_TOO_LARGE"
  | "STORAGE_ERROR";

export class AssetRightsError extends Error {
  override readonly name = "AssetRightsError";
  readonly code: AssetRightsErrorCode;
  readonly originalError?: unknown;

  constructor(code: AssetRightsErrorCode, message: string, originalError?: unknown) {
    super(message);
    this.code = code;
    if (originalError !== undefined) this.originalError = originalError;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const ASSET_KINDS = new Set<AssetRightsKind>([
  "music",
  "sfx",
  "image",
  "video",
  "ai-audio",
  "ai-image",
  "ai-video",
  "other",
]);

const COMMERCIAL_USE_STATUSES = new Set<CommercialUseStatus>([
  "allowed",
  "forbidden",
  "unknown",
]);

const SECRET_PATTERN = /authorization|bearer|password|secret|access.?token|refresh.?token|api.?key/iu;

export function redactRightsText(value: unknown): string {
  return String(value ?? "")
    .replace(/(authorization\s*[:=]\s*)bearer\s+[^\s,;"'}]+/giu, "$1Bearer [REDACTED]")
    .replace(/\bbearer\s+[a-z0-9._~+/-]{8,}/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk|sess)-[a-z0-9_-]{8,}\b/giu, "[REDACTED]")
    .replace(/((?:api[_-]?key|password|secret|access[_-]?token|refresh[_-]?token)\s*[:=]\s*)[^\s,;]+/giu, "$1[REDACTED]");
}

function cleanText(value: unknown, maxLength = MAX_ASSET_RIGHTS_TEXT_LENGTH): string {
  return redactRightsText(
    String(value ?? "")
      .replace(/\0/gu, "")
      .replace(/\s+/gu, " ")
      .trim(),
  ).slice(0, maxLength);
}

function scrubUnknown(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return redactRightsText(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return undefined;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return "[BINARY_OMITTED]";
  const object = value as object;
  if (seen.has(object)) return "[CIRCULAR]";
  seen.add(object);
  try {
    if (Array.isArray(value)) return value.map((item) => scrubUnknown(item, seen));
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SECRET_PATTERN.test(key) ? "[REDACTED]" : scrubUnknown(item, seen);
    }
    return output;
  } finally {
    seen.delete(object);
  }
}

function finiteTimestamp(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim()) {
    const time = Date.parse(value);
    if (Number.isFinite(time) && time > 0) return time;
  }
  return fallback;
}

function normalizeKind(value: unknown): AssetRightsKind {
  const kind = cleanText(value, 64).toLocaleLowerCase("en-US") as AssetRightsKind;
  return ASSET_KINDS.has(kind) ? kind : "other";
}

export function inferAssetRightsKind(asset: AssetRightsAssetLike): AssetRightsKind {
  const kind = cleanText(asset.kind, 64).toLocaleLowerCase("en-US");
  const folder = cleanText(asset.folderPath, 512).replace(/\\/gu, "/").toLocaleLowerCase("en-US");
  if (kind === "audio" && (folder === "music" || folder.startsWith("music/"))) return "music";
  if (kind === "audio" && (folder === "sfx" || folder.startsWith("sfx/"))) return "sfx";
  if (kind === "image") return "image";
  if (kind === "video") return "video";
  return "other";
}

export function createMissingAssetRightsRecord(
  asset: AssetRightsAssetLike,
  now = Date.now(),
): AssetRightsRecord {
  const assetId = cleanText(asset.normalizedPath || asset.id || asset.nativePath, 512);
  const assetName = cleanText(asset.name || asset.nativePath || assetId, 512);
  return normalizeAssetRightsRecord({
    assetId,
    assetName,
    kind: inferAssetRightsKind(asset),
    commercialUse: "unknown",
    updatedAt: now,
  }, now);
}

export function createReferenceAssetRightsRecord(
  reference: AssetRightsReferenceLike,
  now = Date.now(),
): AssetRightsRecord {
  const assetId = cleanText(reference.nativePath || reference.id, 512);
  const assetName = cleanText(reference.name || reference.nativePath || assetId, 512);
  const type = cleanText(reference.type, 64).toLocaleLowerCase("en-US");
  const tags = Array.isArray(reference.tags)
    ? reference.tags.map((item) => cleanText(item, 128)).filter(Boolean).slice(0, 16)
    : cleanText(reference.tags, 512).split(/[,#]/u).map((item) => cleanText(item, 128)).filter(Boolean).slice(0, 16);
  const notes = [
    cleanText(reference.notes),
    tags.length > 0 ? `태그: ${tags.join(", ")}` : "",
  ].filter(Boolean).join(" · ");
  const source = cleanText(reference.source);
  return normalizeAssetRightsRecord({
    assetId,
    assetName,
    kind: type === "video" ? "video" : "image",
    source,
    license: "",
    commercialUse: "unknown",
    attribution: source,
    notes,
    updatedAt: now,
  }, now);
}

export function createTtsAssetRightsRecord(
  output: AssetRightsTtsLike,
  now = Date.now(),
): AssetRightsRecord {
  const assetId = cleanText(output.nativePath, 512);
  const assetName = cleanText(output.name || output.nativePath || assetId, 512);
  const model = cleanText(output.model, 128);
  const voice = cleanText(output.voice, 128);
  const format = cleanText(output.format, 32);
  const descriptor = [
    model ? `모델: ${model}` : "",
    voice ? `목소리: ${voice}` : "",
    format ? `형식: ${format}` : "",
    "AI 생성 음성은 최종 콘텐츠에서 고지 필요",
  ].filter(Boolean).join(" · ");
  return normalizeAssetRightsRecord({
    assetId,
    assetName,
    kind: "ai-audio",
    source: "OpenAI TTS",
    license: "OpenAI API 생성 음성 · 프로젝트/정책 기준 확인 필요",
    commercialUse: "unknown",
    attribution: "AI generated voice",
    notes: descriptor,
    updatedAt: now,
  }, now);
}

function normalizeCommercialUse(value: unknown): CommercialUseStatus {
  const status = cleanText(value, 64).toLocaleLowerCase("en-US") as CommercialUseStatus;
  return COMMERCIAL_USE_STATUSES.has(status) ? status : "unknown";
}

function normalizeExpiry(value: unknown): string | null {
  const raw = cleanText(value, 128);
  if (!raw) return null;
  const time = Date.parse(raw);
  if (!Number.isFinite(time)) return raw;
  return new Date(time).toISOString().slice(0, 10);
}

export function normalizeAssetRightsRecord(
  input: AssetRightsInput,
  now = Date.now(),
): AssetRightsRecord {
  const assetId = cleanText(input.assetId, 512);
  const assetName = cleanText(input.assetName, 512);
  if (!assetId || !assetName) {
    throw new AssetRightsError(
      "INVALID_RECORD",
      "권리 정보에는 assetId와 assetName이 필요합니다.",
    );
  }
  return Object.freeze({
    assetId,
    assetName,
    kind: normalizeKind(input.kind),
    source: cleanText(input.source),
    license: cleanText(input.license),
    commercialUse: normalizeCommercialUse(input.commercialUse),
    expiresAt: normalizeExpiry(input.expiresAt),
    attribution: cleanText(input.attribution),
    notes: cleanText(input.notes),
    updatedAt: finiteTimestamp(input.updatedAt, now),
  });
}

function issue(
  level: AssetRightsIssueLevel,
  code: string,
  record: AssetRightsRecord,
  message: string,
): AssetRightsIssue {
  return Object.freeze({
    level,
    code,
    assetId: record.assetId,
    assetName: record.assetName,
    message: redactRightsText(message),
  });
}

function expiryStatus(record: AssetRightsRecord, now: number): "none" | "invalid" | "expired" | "soon" | "ok" {
  if (!record.expiresAt) return "none";
  const time = Date.parse(record.expiresAt);
  if (!Number.isFinite(time)) return "invalid";
  if (time < now) return "expired";
  return time - now <= 30 * 24 * 60 * 60 * 1_000 ? "soon" : "ok";
}

export function evaluateAssetRightsRecord(
  record: AssetRightsRecord,
  now = Date.now(),
): AssetRightsIssue[] {
  const issues: AssetRightsIssue[] = [];
  if (!record.source) {
    issues.push(issue("warning", "rights-source-missing", record, `${record.assetName}: 출처가 비어 있습니다.`));
  }
  if (!record.license) {
    issues.push(issue("warning", "rights-license-missing", record, `${record.assetName}: 라이선스 정보가 비어 있습니다.`));
  }
  if (record.commercialUse === "unknown") {
    issues.push(issue("warning", "rights-commercial-unknown", record, `${record.assetName}: 상업 사용 가능 여부가 확인되지 않았습니다.`));
  } else if (record.commercialUse === "forbidden") {
    issues.push(issue("error", "rights-commercial-forbidden", record, `${record.assetName}: 상업 사용이 금지된 에셋입니다.`));
  }
  if (!record.attribution) {
    issues.push(issue("warning", "rights-attribution-missing", record, `${record.assetName}: 출처 표기 문구가 없습니다.`));
  }

  const expiry = expiryStatus(record, now);
  if (expiry === "invalid") {
    issues.push(issue("warning", "rights-expiry-invalid", record, `${record.assetName}: 만료일 형식을 확인해야 합니다.`));
  } else if (expiry === "expired") {
    issues.push(issue("error", "rights-expired", record, `${record.assetName}: 라이선스 만료일이 지났습니다.`));
  } else if (expiry === "soon") {
    issues.push(issue("warning", "rights-expiry-soon", record, `${record.assetName}: 라이선스 만료가 30일 이내입니다.`));
  }
  return issues;
}

function uniqueByAssetId(records: readonly AssetRightsRecord[]): AssetRightsRecord[] {
  const output = new Map<string, AssetRightsRecord>();
  for (const record of records) output.set(record.assetId, record);
  return [...output.values()].sort((left, right) => left.assetName.localeCompare(right.assetName, "en", {
    numeric: true,
    sensitivity: "base",
  }));
}

export function createAssetRightsReport(
  records: readonly AssetRightsRecord[],
  now = Date.now(),
): AssetRightsReport {
  if (!Array.isArray(records)) {
    throw new AssetRightsError("INVALID_RECORD", "권리 정보 목록은 배열이어야 합니다.");
  }
  if (records.length > MAX_ASSET_RIGHTS_ITEMS) {
    throw new AssetRightsError("INPUT_TOO_LARGE", "권리 정보 개수가 안전 한도를 초과했습니다.");
  }
  const assets = uniqueByAssetId(records.map((record) => normalizeAssetRightsRecord(record, now)));
  const issues = assets.flatMap((record) => evaluateAssetRightsRecord(record, now));
  const counts: Record<AssetRightsIssueLevel, number> = { warning: 0, error: 0 };
  for (const item of issues) counts[item.level] += 1;
  const attributionLines = assets
    .filter((record) => record.attribution)
    .map((record) => record.attribution);
  return Object.freeze({
    schemaVersion: ASSET_RIGHTS_SCHEMA_VERSION,
    generatedAt: Number.isFinite(now) ? now : Date.now(),
    assets: Object.freeze(assets),
    issues: Object.freeze(issues),
    counts,
    blocking: counts.error > 0,
    attributionLines: Object.freeze([...new Set(attributionLines)]),
  });
}

export function assetRightsReportToJSON(report: AssetRightsReport): string {
  return JSON.stringify(scrubUnknown(report), null, 2);
}

function markdownCell(value: unknown): string {
  return redactRightsText(value).replace(/\|/gu, "\\|").replace(/[\r\n]+/gu, " ");
}

export function assetRightsReportToMarkdown(report: AssetRightsReport): string {
  const safe = scrubUnknown(report) as AssetRightsReport;
  const lines = [
    "# ShortFlow 에셋 권리 리포트",
    "",
    `- 게이트: **${safe.blocking ? "차단" : "통과"}**`,
    `- 에셋: ${safe.assets.length}개`,
    `- 오류: ${safe.counts.error}개`,
    `- 경고: ${safe.counts.warning}개`,
    "",
    "| 수준 | 코드 | 에셋 | 내용 |",
    "|---|---|---|---|",
  ];
  if (safe.issues.length === 0) {
    lines.push("| pass | rights-ok | 전체 | 권리 정보 문제가 없습니다. |");
  } else {
    for (const item of safe.issues) {
      lines.push(`| ${item.level} | ${markdownCell(item.code)} | ${markdownCell(item.assetName)} | ${markdownCell(item.message)} |`);
    }
  }
  if (safe.attributionLines.length > 0) {
    lines.push("", "## 출처 표기", "");
    for (const line of safe.attributionLines) lines.push(`- ${markdownCell(line)}`);
  }
  return `${lines.join("\n")}\n`;
}

export class AssetRightsRegistry {
  private readonly records = new Map<string, AssetRightsRecord>();

  constructor(
    private readonly storage: AssetRightsStorageAdapter,
    private readonly storageKey = ASSET_RIGHTS_STORAGE_KEY,
  ) {}

  get items(): readonly AssetRightsRecord[] {
    return uniqueByAssetId([...this.records.values()]);
  }

  async load(): Promise<readonly AssetRightsRecord[]> {
    let raw: string | null | undefined;
    try {
      raw = await this.storage.getItem(this.storageKey);
    } catch (error) {
      throw new AssetRightsError("STORAGE_ERROR", "저장된 권리 정보를 읽지 못했습니다.", error);
    }
    this.records.clear();
    if (!raw) return this.items;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new AssetRightsError("STORAGE_ERROR", "저장된 권리 정보 JSON이 손상되었습니다.", error);
    }
    const source = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { assets?: unknown })?.assets)
        ? (parsed as { assets: unknown[] }).assets
        : [];
    if (source.length > MAX_ASSET_RIGHTS_ITEMS) {
      throw new AssetRightsError("INPUT_TOO_LARGE", "저장된 권리 정보 개수가 안전 한도를 초과했습니다.");
    }
    for (const item of source) {
      const record = normalizeAssetRightsRecord(item as AssetRightsInput);
      this.records.set(record.assetId, record);
    }
    return this.items;
  }

  async save(): Promise<void> {
    const payload = JSON.stringify({
      schemaVersion: ASSET_RIGHTS_SCHEMA_VERSION,
      assets: this.items,
    });
    try {
      await this.storage.setItem(this.storageKey, payload);
    } catch (error) {
      throw new AssetRightsError("STORAGE_ERROR", "권리 정보를 저장하지 못했습니다.", error);
    }
  }

  async upsert(input: AssetRightsInput): Promise<AssetRightsRecord> {
    const existing = this.records.get(cleanText(input.assetId, 512));
    const record = normalizeAssetRightsRecord({
      ...existing,
      ...input,
    });
    this.records.set(record.assetId, record);
    await this.save();
    return record;
  }

  async remove(assetId: string): Promise<boolean> {
    const removed = this.records.delete(cleanText(assetId, 512));
    if (removed) await this.save();
    return removed;
  }

  report(now = Date.now()): AssetRightsReport {
    return createAssetRightsReport(this.items, now);
  }

  async clear(): Promise<void> {
    this.records.clear();
    try {
      await this.storage.removeItem(this.storageKey);
    } catch (error) {
      throw new AssetRightsError("STORAGE_ERROR", "권리 정보를 삭제하지 못했습니다.", error);
    }
  }
}
