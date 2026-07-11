export const DIAGNOSTICS_SCHEMA_VERSION = 1 as const;
export const TELEMETRY_SCHEMA_VERSION = 1 as const;
export const MINIMUM_PREMIERE_VERSION = "25.6.0";
export const TELEMETRY_STORAGE_KEY = "shortflow.telemetry.v1";
export const MAX_TELEMETRY_QUEUE = 100;
export const TELEMETRY_CONSENT_VERSION = 1;
export const TELEMETRY_QUEUE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export type DiagnosticStatus = "green" | "yellow" | "red";
export type CapabilityName =
  | "transcript"
  | "encoder"
  | "secureStorage"
  | "network"
  | "filesystem";

export interface HostInfo {
  readonly name: string;
  readonly version: string;
  readonly build?: string;
}

export interface UxpInfo {
  readonly version: string;
}

export interface OsInfo {
  readonly platform: string;
  readonly version?: string;
  readonly arch?: string;
}

export interface RuntimeInfo {
  readonly pluginVersion?: string;
  readonly locale?: string;
  readonly online?: boolean;
}

export interface CapabilityProbeResult {
  readonly available: boolean;
  readonly version?: string;
  readonly deprecated?: boolean;
  readonly detail?: string;
}

export type CapabilityProbeValue = boolean | CapabilityProbeResult;
export type MaybePromise<T> = T | Promise<T>;

export interface ApiProbeDefinition {
  readonly name: string;
  readonly value: unknown;
  readonly required?: boolean;
  readonly deprecated?: boolean;
  readonly replacement?: string;
}

export interface DiagnosticsAdapter {
  readonly getHostInfo?: () => MaybePromise<Partial<HostInfo> | null | undefined>;
  readonly getUxpInfo?: () => MaybePromise<Partial<UxpInfo> | null | undefined>;
  readonly getOsInfo?: () => MaybePromise<Partial<OsInfo> | null | undefined>;
  readonly getRuntimeInfo?: () => MaybePromise<Partial<RuntimeInfo> | null | undefined>;
  readonly capabilities?: Partial<Record<CapabilityName, () => MaybePromise<CapabilityProbeValue>>>;
  readonly apis?: readonly ApiProbeDefinition[];
}

export interface DiagnosticCheck {
  readonly id: string;
  readonly label: string;
  readonly status: DiagnosticStatus;
  readonly available: boolean;
  readonly required: boolean;
  readonly deprecated: boolean;
  readonly message: string;
  readonly version?: string;
  readonly replacement?: string;
}

export interface DiagnosticsReport {
  readonly schemaVersion: typeof DIAGNOSTICS_SCHEMA_VERSION;
  readonly generatedAt: number;
  readonly overall: DiagnosticStatus;
  readonly compatible: boolean;
  readonly minimumHostVersion: string;
  readonly host: Readonly<HostInfo>;
  readonly uxp: Readonly<UxpInfo>;
  readonly os: Readonly<OsInfo>;
  readonly runtime: Readonly<RuntimeInfo>;
  readonly checks: readonly DiagnosticCheck[];
}

export interface ApiGuardOptions {
  readonly required?: boolean;
  readonly deprecated?: boolean;
  readonly replacement?: string;
}

export interface ApiGuardResult<T> {
  readonly available: boolean;
  readonly deprecated: boolean;
  readonly status: DiagnosticStatus;
  readonly value: T | null;
  readonly check: DiagnosticCheck;
}

export interface DiagnosticBundleInput {
  readonly report: DiagnosticsReport;
  readonly logs?: readonly unknown[];
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface AnonymousDiagnosticBundle {
  readonly schemaVersion: typeof DIAGNOSTICS_SCHEMA_VERSION;
  readonly generatedAt: number;
  readonly report: unknown;
  readonly logs: readonly unknown[];
  readonly context: Readonly<Record<string, unknown>>;
}

export type TelemetryEventName =
  | "plugin_started"
  | "diagnostic_completed"
  | "operation_succeeded"
  | "operation_failed"
  | "crash";

export interface TelemetryMetadata {
  readonly pluginVersion?: unknown;
  readonly hostVersion?: unknown;
  readonly status?: unknown;
  readonly operation?: unknown;
  readonly errorCode?: unknown;
  readonly durationMs?: unknown;
  readonly capability?: unknown;
  readonly [key: string]: unknown;
}

export interface TelemetryPayload {
  readonly schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  readonly eventId: string;
  readonly event: TelemetryEventName;
  readonly timestamp: number;
  readonly sessionId?: string;
  readonly pluginVersion?: string;
  readonly hostVersion?: string;
  readonly status?: DiagnosticStatus | "success" | "failure";
  readonly operation?: string;
  readonly errorCode?: string;
  readonly durationMs?: number;
  readonly capability?: CapabilityName;
}

export const TELEMETRY_PAYLOAD_ALLOWLIST = Object.freeze([
  "schemaVersion",
  "eventId",
  "event",
  "timestamp",
  "sessionId",
  "pluginVersion",
  "hostVersion",
  "status",
  "operation",
  "errorCode",
  "durationMs",
  "capability",
] as const);

export interface TelemetryQueueItem {
  readonly payload: TelemetryPayload;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly createdAt: number;
}

export interface TelemetryStorage {
  getItem(key: string): MaybePromise<string | null>;
  setItem(key: string, value: string): MaybePromise<void>;
  removeItem?(key: string): MaybePromise<void>;
}

/** Provider 경계만 정의하며 Sentry 또는 특정 벤더 SDK에 직접 의존하지 않습니다. */
export interface TelemetryProvider {
  send(payload: TelemetryPayload): Promise<void>;
}

export interface TelemetryAdapter {
  readonly storage: TelemetryStorage;
  readonly provider?: TelemetryProvider;
}

export interface TelemetryManagerOptions {
  readonly storageKey?: string;
  readonly sessionId?: string;
  readonly now?: () => number;
  readonly eventIdFactory?: (event: TelemetryEventName, sequence: number) => string;
  readonly maxQueue?: number;
  readonly maxAttempts?: number;
  readonly baseRetryDelayMs?: number;
  readonly queueTtlMs?: number;
}

export interface TelemetryFlushResult {
  readonly sent: number;
  readonly retried: number;
  readonly discarded: number;
  readonly pending: number;
}

interface TelemetryConsent {
  enabled: boolean;
  version: typeof TELEMETRY_CONSENT_VERSION;
  updatedAt: number;
}

interface StoredTelemetryState {
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION;
  consent: TelemetryConsent;
  queue: TelemetryQueueItem[];
}

type DiagnosticsErrorCode = "INVALID_API" | "INVALID_TELEMETRY" | "STORAGE_ERROR";

export class DiagnosticsError extends Error {
  override readonly name = "DiagnosticsError";
  readonly code: DiagnosticsErrorCode;
  readonly causeValue?: unknown;

  constructor(code: DiagnosticsErrorCode, message: string, causeValue?: unknown) {
    super(message);
    this.code = code;
    if (causeValue !== undefined) this.causeValue = causeValue;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const CAPABILITIES: ReadonlyArray<{
  name: CapabilityName;
  label: string;
  required: boolean;
  unavailableStatus: DiagnosticStatus;
}> = Object.freeze([
  { name: "transcript", label: "Transcript API", required: false, unavailableStatus: "yellow" },
  { name: "encoder", label: "Encoder API", required: true, unavailableStatus: "red" },
  { name: "secureStorage", label: "Secure Storage", required: true, unavailableStatus: "red" },
  { name: "network", label: "Network", required: false, unavailableStatus: "yellow" },
  { name: "filesystem", label: "Filesystem", required: true, unavailableStatus: "red" },
]);
const CAPABILITY_NAMES = new Set<CapabilityName>(CAPABILITIES.map((item) => item.name));
const EVENT_NAMES = new Set<TelemetryEventName>([
  "plugin_started",
  "diagnostic_completed",
  "operation_succeeded",
  "operation_failed",
  "crash",
]);
const STATUS_VALUES = new Set<TelemetryPayload["status"]>([
  "green",
  "yellow",
  "red",
  "success",
  "failure",
]);
const SAFE_IDENTIFIER = /^[a-z0-9][a-z0-9._:-]{0,127}$/iu;
const SENSITIVE_KEY = /(?:^|[_-])(?:api[_-]?key|authorization|password|passwd|secret|access[_-]?token|refresh[_-]?token|persistent[_-]?token|token|credential|cookie)(?:$|[_-])/iu;
const PATH_KEY = /(?:^|[_-])(?:path|nativepath|filepath|folder|directory|cwd|home)(?:$|[_-])/iu;
const USER_KEY = /(?:^|[_-])(?:user|username|account|email|owner)(?:$|[_-])/iu;
const CONTENT_KEY = /(?:transcript|script|prompt|captiontext|subtitletext|manuscript|원고)/iu;
const MEDIA_NAME_KEY = /(?:media|asset|project|sequence|clip|file)(?:name|title)/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, fallback: string, maximum = 160): string {
  if (typeof value !== "string") return fallback;
  const clean = value.replace(/[\u0000-\u001f\u007f]+/gu, " ").replace(/\s+/gu, " ").trim();
  return clean ? clean.slice(0, maximum) : fallback;
}

function optionalBoundedString(value: unknown, maximum = 160): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = boundedString(value, "", maximum);
  return clean || undefined;
}

function finiteTimestamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function statusRank(status: DiagnosticStatus): number {
  if (status === "red") return 3;
  if (status === "yellow") return 2;
  return 1;
}

function overallStatus(checks: readonly DiagnosticCheck[]): DiagnosticStatus {
  return checks.reduce<DiagnosticStatus>((worst, check) => (
    statusRank(check.status) > statusRank(worst) ? check.status : worst
  ), "green");
}

export function parseVersion(value: unknown): readonly number[] | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.\d+)?/u);
  if (!match) return null;
  const parts = [match[1], match[2] ?? "0", match[3] ?? "0"].map(Number);
  return parts.every((part) => Number.isSafeInteger(part) && part >= 0)
    ? Object.freeze(parts)
    : null;
}

export function compareVersions(left: unknown, right: unknown): number | null {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  if (!leftParts || !rightParts) return null;
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

function freezeCheck(check: DiagnosticCheck): DiagnosticCheck {
  return Object.freeze(check);
}

export function guardApi<T>(
  name: string,
  value: T | null | undefined,
  options: ApiGuardOptions = {},
): ApiGuardResult<T> {
  const required = options.required ?? false;
  const deprecated = options.deprecated ?? false;
  const available = value !== null && value !== undefined && value !== false;
  const status: DiagnosticStatus = !available
    ? (required ? "red" : "yellow")
    : deprecated ? "yellow" : "green";
  const replacement = optionalBoundedString(options.replacement);
  const check: DiagnosticCheck = freezeCheck({
    id: `api:${boundedString(name, "unknown", 100)}`,
    label: boundedString(name, "Unknown API", 100),
    status,
    available,
    required,
    deprecated,
    message: !available
      ? `${name} API를 사용할 수 없습니다.`
      : deprecated
        ? `${name} API는 deprecated 상태입니다.${replacement ? ` ${replacement} 사용을 권장합니다.` : ""}`
        : `${name} API를 사용할 수 있습니다.`,
    ...(replacement ? { replacement } : {}),
  });
  return Object.freeze({ available, deprecated, status, value: available ? value : null, check });
}

export function requireAvailableApi<T>(guard: ApiGuardResult<T>): T {
  if (!guard.available || guard.value === null) {
    throw new DiagnosticsError("INVALID_API", guard.check.message);
  }
  return guard.value;
}

async function safeProbe<T>(probe: (() => MaybePromise<T>) | undefined): Promise<{
  ok: boolean;
  value?: T;
  error?: unknown;
}> {
  if (!probe) return { ok: false };
  try {
    return { ok: true, value: await probe() };
  } catch (error) {
    return { ok: false, error };
  }
}

function capabilityResult(value: CapabilityProbeValue | undefined): CapabilityProbeResult {
  if (typeof value === "boolean") return { available: value };
  if (!value || typeof value.available !== "boolean") return { available: false };
  const version = optionalBoundedString(value.version, 40);
  const detail = optionalBoundedString(value.detail, 240);
  return {
    available: value.available,
    ...(version ? { version } : {}),
    ...(value.deprecated === true ? { deprecated: true } : {}),
    ...(detail ? { detail } : {}),
  };
}

export async function buildDiagnosticsReport(
  adapter: DiagnosticsAdapter,
  now: () => number = () => Date.now(),
): Promise<DiagnosticsReport> {
  const generatedAt = finiteTimestamp(now(), Date.now());
  const hostProbe = await safeProbe(adapter.getHostInfo);
  const uxpProbe = await safeProbe(adapter.getUxpInfo);
  const osProbe = await safeProbe(adapter.getOsInfo);
  const runtimeProbe = await safeProbe(adapter.getRuntimeInfo);
  const hostRaw = hostProbe.ok && hostProbe.value ? hostProbe.value : {};
  const uxpRaw = uxpProbe.ok && uxpProbe.value ? uxpProbe.value : {};
  const osRaw = osProbe.ok && osProbe.value ? osProbe.value : {};
  const runtimeRaw = runtimeProbe.ok && runtimeProbe.value ? runtimeProbe.value : {};

  const hostBuild = optionalBoundedString(hostRaw.build, 80);
  const host: HostInfo = Object.freeze({
    name: boundedString(hostRaw.name, "Adobe Premiere Pro"),
    version: boundedString(hostRaw.version, "unknown", 40),
    ...(hostBuild ? { build: hostBuild } : {}),
  });
  const uxp: UxpInfo = Object.freeze({
    version: boundedString(uxpRaw.version, "unknown", 40),
  });
  const osVersion = optionalBoundedString(osRaw.version, 80);
  const osArch = optionalBoundedString(osRaw.arch, 40);
  const os: OsInfo = Object.freeze({
    platform: boundedString(osRaw.platform, "unknown", 80),
    ...(osVersion ? { version: osVersion } : {}),
    ...(osArch ? { arch: osArch } : {}),
  });
  const pluginVersion = optionalBoundedString(runtimeRaw.pluginVersion, 40);
  const locale = optionalBoundedString(runtimeRaw.locale, 40);
  const runtime: RuntimeInfo = Object.freeze({
    ...(pluginVersion ? { pluginVersion } : {}),
    ...(locale ? { locale } : {}),
    ...(typeof runtimeRaw.online === "boolean" ? { online: runtimeRaw.online } : {}),
  });

  const checks: DiagnosticCheck[] = [];
  const versionComparison = compareVersions(host.version, MINIMUM_PREMIERE_VERSION);
  checks.push(freezeCheck({
    id: "host-version",
    label: "Premiere Pro host",
    status: versionComparison === null ? "yellow" : versionComparison < 0 ? "red" : "green",
    available: hostProbe.ok,
    required: true,
    deprecated: false,
    version: host.version,
    message: versionComparison === null
      ? "Premiere Pro 버전을 확인할 수 없습니다."
      : versionComparison < 0
        ? `Premiere Pro ${MINIMUM_PREMIERE_VERSION} 이상이 필요합니다.`
        : `Premiere Pro ${host.version}은 지원 범위입니다.`,
  }));
  checks.push(freezeCheck({
    id: "uxp-runtime",
    label: "UXP runtime",
    status: parseVersion(uxp.version) ? "green" : "yellow",
    available: uxpProbe.ok,
    required: true,
    deprecated: false,
    version: uxp.version,
    message: parseVersion(uxp.version)
      ? `UXP ${uxp.version} 런타임을 확인했습니다.`
      : "UXP 런타임 버전을 확인할 수 없습니다.",
  }));
  checks.push(freezeCheck({
    id: "os-runtime",
    label: "Operating system",
    status: os.platform === "unknown" ? "yellow" : "green",
    available: osProbe.ok,
    required: false,
    deprecated: false,
    message: os.platform === "unknown" ? "운영체제 정보를 확인할 수 없습니다." : `${os.platform} 환경입니다.`,
  }));

  for (const definition of CAPABILITIES) {
    const probe = await safeProbe(adapter.capabilities?.[definition.name]);
    const result = capabilityResult(probe.value);
    const deprecated = result.deprecated === true;
    const status: DiagnosticStatus = !probe.ok || !result.available
      ? definition.unavailableStatus
      : deprecated ? "yellow" : "green";
    checks.push(freezeCheck({
      id: `capability:${definition.name}`,
      label: definition.label,
      status,
      available: probe.ok && result.available,
      required: definition.required,
      deprecated,
      message: !probe.ok
        ? `${definition.label} 확인에 실패했습니다.`
        : !result.available
          ? `${definition.label}를 사용할 수 없습니다.`
          : deprecated
            ? `${definition.label}가 deprecated API에 의존합니다.`
            : result.detail ?? `${definition.label}를 사용할 수 있습니다.`,
      ...(result.version ? { version: result.version } : {}),
    }));
  }

  for (const api of adapter.apis ?? []) {
    checks.push(guardApi(api.name, api.value, api).check);
  }
  const frozenChecks = Object.freeze(checks);
  const overall = overallStatus(frozenChecks);
  const compatible = versionComparison !== null && versionComparison >= 0 &&
    frozenChecks.every((check) => !check.required || check.status !== "red");
  return Object.freeze({
    schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    generatedAt,
    overall,
    compatible,
    minimumHostVersion: MINIMUM_PREMIERE_VERSION,
    host,
    uxp,
    os,
    runtime,
    checks: frozenChecks,
  });
}

function redactText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer <redacted>")
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/gu, "<redacted:api-key>")
    .replace(/\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/giu, "$1=<redacted>")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "<redacted:token>")
    .replace(/\b[A-Z]:\\(?:[^\s\\]+\\)*[^\s]*/giu, "<redacted:path>")
    .replace(/\\\\[^\s\\]+\\[^\s]*/gu, "<redacted:path>")
    .replace(/\bfile:\/{2,3}[^\s]+/giu, "<redacted:path>")
    .replace(/\/(?:Users|home)\/[^\s/]+(?:\/[^\s]*)?/gu, "<redacted:path>")
    .replace(/(?:^|\s)\/(?!\/)(?:[^\s/]+\/)+[^\s]*/gu, " <redacted:path>")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "<redacted:user>")
    .replace(/\b(?:user(?:name)?|account|owner)\s*[:=]\s*[^\s,;]+/giu, "$1=<redacted>")
    .replace(/(?:^|[\s"'([])[^\s"'()[\]]+\.(?:mp4|mov|mxf|avi|mkv|mp3|wav|aiff|m4a|png|jpe?g|webp|mogrt|prproj)\b/giu, "$1<redacted:media>")
    .slice(0, 8_000);
}

function redactionPlaceholder(key: string): string | null {
  if (SENSITIVE_KEY.test(key)) return "<redacted:secret>";
  if (PATH_KEY.test(key)) return "<redacted:path>";
  if (USER_KEY.test(key)) return "<redacted:user>";
  if (CONTENT_KEY.test(key)) return "<redacted:content>";
  if (MEDIA_NAME_KEY.test(key)) return "<redacted:media>";
  return null;
}

export function redactSensitive(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown, key = "", depth = 0): unknown => {
    const placeholder = redactionPlaceholder(key);
    if (placeholder) return placeholder;
    if (candidate === null || candidate === undefined) return candidate ?? null;
    if (typeof candidate === "string") return redactText(candidate);
    if (typeof candidate === "number") return Number.isFinite(candidate) ? candidate : null;
    if (typeof candidate === "boolean") return candidate;
    if (typeof candidate === "bigint") return candidate.toString();
    if (typeof candidate === "function" || typeof candidate === "symbol") return undefined;
    if (candidate instanceof ArrayBuffer || ArrayBuffer.isView(candidate)) return "<redacted:binary>";
    if (candidate instanceof Date) return Number.isFinite(candidate.getTime()) ? candidate.toISOString() : null;
    if (candidate instanceof Error) {
      return {
        name: boundedString(candidate.name, "Error", 80),
        message: redactText(candidate.message),
        ...(candidate.stack ? { stack: redactText(candidate.stack) } : {}),
      };
    }
    if (depth >= 8) return "<truncated:depth>";
    if (typeof candidate !== "object") return null;
    if (seen.has(candidate)) return "<redacted:circular>";
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      return candidate.slice(0, 100).map((item) => visit(item, key, depth + 1));
    }
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(candidate as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, 100)) {
      const redacted = visit(childValue, childKey, depth + 1);
      if (redacted !== undefined) output[childKey.slice(0, 120)] = redacted;
    }
    return output;
  };
  return visit(value);
}

export function normalizeDiagnosticBundle(
  input: DiagnosticBundleInput,
  now: () => number = () => Date.now(),
): AnonymousDiagnosticBundle {
  const report = redactSensitive(input.report);
  const logs = redactSensitive(input.logs ?? []);
  const context = redactSensitive(input.context ?? {});
  return Object.freeze({
    schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
    generatedAt: finiteTimestamp(now(), Date.now()),
    report,
    logs: Object.freeze(Array.isArray(logs) ? logs : []),
    context: Object.freeze(isRecord(context) ? context : {}),
  });
}

export function diagnosticBundleToJSON(
  input: DiagnosticBundleInput,
  now: () => number = () => Date.now(),
): string {
  return JSON.stringify(normalizeDiagnosticBundle(input, now), null, 2);
}

function safeIdentifier(value: unknown, maximum = 128): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim().slice(0, maximum);
  return SAFE_IDENTIFIER.test(clean) ? clean : undefined;
}

function safeVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim().slice(0, 40);
  return /^\d+(?:\.\d+){0,3}(?:[-+][a-z0-9.-]+)?$/iu.test(clean) ? clean : undefined;
}

export interface NormalizeTelemetryContext {
  readonly eventId: string;
  readonly timestamp: number;
  readonly sessionId?: string;
}

export function normalizeTelemetryPayload(
  event: TelemetryEventName,
  metadata: TelemetryMetadata,
  context: NormalizeTelemetryContext,
): TelemetryPayload {
  if (!EVENT_NAMES.has(event)) {
    throw new DiagnosticsError("INVALID_TELEMETRY", `허용되지 않은 telemetry event입니다: ${String(event)}`);
  }
  const eventId = safeIdentifier(context.eventId);
  if (!eventId) throw new DiagnosticsError("INVALID_TELEMETRY", "telemetry eventId가 올바르지 않습니다.");
  const sessionId = safeIdentifier(context.sessionId);
  const pluginVersion = safeVersion(metadata.pluginVersion);
  const hostVersion = safeVersion(metadata.hostVersion);
  const status = STATUS_VALUES.has(metadata.status as TelemetryPayload["status"])
    ? metadata.status as NonNullable<TelemetryPayload["status"]>
    : undefined;
  const operation = safeIdentifier(metadata.operation, 64);
  const errorCode = safeIdentifier(metadata.errorCode, 64);
  const duration = typeof metadata.durationMs === "number" && Number.isFinite(metadata.durationMs)
    ? Math.round(Math.min(86_400_000, Math.max(0, metadata.durationMs)))
    : undefined;
  const capability = CAPABILITY_NAMES.has(metadata.capability as CapabilityName)
    ? metadata.capability as CapabilityName
    : undefined;
  return Object.freeze({
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    eventId,
    event,
    timestamp: finiteTimestamp(context.timestamp, Date.now()),
    ...(sessionId ? { sessionId } : {}),
    ...(pluginVersion ? { pluginVersion } : {}),
    ...(hostVersion ? { hostVersion } : {}),
    ...(status ? { status } : {}),
    ...(operation ? { operation } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(duration !== undefined ? { durationMs: duration } : {}),
    ...(capability ? { capability } : {}),
  });
}

function validStoredPayload(value: unknown): TelemetryPayload | null {
  if (!isRecord(value) || !EVENT_NAMES.has(value.event as TelemetryEventName)) return null;
  if (value.schemaVersion !== TELEMETRY_SCHEMA_VERSION) return null;
  const eventId = safeIdentifier(value.eventId);
  if (!eventId || typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp)) return null;
  const storedSessionId = safeIdentifier(value.sessionId);
  try {
    return normalizeTelemetryPayload(
      value.event as TelemetryEventName,
      value,
      {
        eventId,
        timestamp: value.timestamp,
        ...(storedSessionId ? { sessionId: storedSessionId } : {}),
      },
    );
  } catch {
    return null;
  }
}

function frozenQueueItem(item: TelemetryQueueItem): TelemetryQueueItem {
  return Object.freeze({ ...item, payload: Object.freeze({ ...item.payload }) });
}

function parseTelemetryState(
  raw: string | null,
  now: number,
  maxQueue: number,
  ttlMs: number,
): StoredTelemetryState | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== TELEMETRY_SCHEMA_VERSION) return null;
  const consentRaw = isRecord(parsed.consent) ? parsed.consent : {};
  const enabled = consentRaw.enabled === true && consentRaw.version === TELEMETRY_CONSENT_VERSION;
  const consent: TelemetryConsent = {
    enabled,
    version: TELEMETRY_CONSENT_VERSION,
    updatedAt: finiteTimestamp(consentRaw.updatedAt, 0),
  };
  const queue: TelemetryQueueItem[] = [];
  if (enabled && Array.isArray(parsed.queue)) {
    for (const candidate of parsed.queue.slice(-maxQueue)) {
      if (!isRecord(candidate)) continue;
      const payload = validStoredPayload(candidate.payload);
      const attempts = typeof candidate.attempts === "number" && Number.isInteger(candidate.attempts)
        ? candidate.attempts
        : -1;
      const createdAt = finiteTimestamp(candidate.createdAt, -1);
      const nextAttemptAt = finiteTimestamp(candidate.nextAttemptAt, createdAt);
      if (!payload || attempts < 0 || createdAt < 0 || now - createdAt > ttlMs) continue;
      queue.push(frozenQueueItem({ payload, attempts, createdAt, nextAttemptAt }));
    }
  }
  return { schemaVersion: TELEMETRY_SCHEMA_VERSION, consent, queue };
}

export function createDefaultTelemetryAdapter(
  provider?: TelemetryProvider,
  storage?: TelemetryStorage,
): TelemetryAdapter {
  const candidate = storage ?? (
    globalThis as unknown as { localStorage?: TelemetryStorage }
  ).localStorage;
  if (!candidate || typeof candidate.getItem !== "function" || typeof candidate.setItem !== "function") {
    throw new DiagnosticsError("STORAGE_ERROR", "UXP localStorage를 사용할 수 없습니다.");
  }
  return provider ? { storage: candidate, provider } : { storage: candidate };
}

export class TelemetryManager {
  private readonly storageKey: string;
  private readonly sessionId: string | undefined;
  private readonly now: () => number;
  private readonly eventIdFactory: (event: TelemetryEventName, sequence: number) => string;
  private readonly maxQueue: number;
  private readonly maxAttempts: number;
  private readonly baseRetryDelayMs: number;
  private readonly queueTtlMs: number;
  private enabledValue = false;
  private consentUpdatedAt = 0;
  private queueValue: TelemetryQueueItem[] = [];
  private sequence = 0;
  private mutationQueue: Promise<void> = Promise.resolve();
  private flushPromise: Promise<TelemetryFlushResult> | null = null;

  constructor(
    private readonly adapter: TelemetryAdapter,
    options: TelemetryManagerOptions = {},
  ) {
    this.storageKey = options.storageKey ?? TELEMETRY_STORAGE_KEY;
    this.sessionId = safeIdentifier(options.sessionId);
    this.now = options.now ?? (() => Date.now());
    this.eventIdFactory = options.eventIdFactory ?? (
      (event, sequence) => `evt:${event}:${this.now().toString(36)}:${sequence.toString(36)}`
    );
    this.maxQueue = clampInteger(options.maxQueue, MAX_TELEMETRY_QUEUE, 1, MAX_TELEMETRY_QUEUE);
    this.maxAttempts = clampInteger(options.maxAttempts, 5, 1, 10);
    this.baseRetryDelayMs = clampInteger(options.baseRetryDelayMs, 1_000, 1, 86_400_000);
    this.queueTtlMs = clampInteger(options.queueTtlMs, TELEMETRY_QUEUE_TTL_MS, 1_000, TELEMETRY_QUEUE_TTL_MS);
  }

  get enabled(): boolean {
    return this.enabledValue;
  }

  get queue(): readonly TelemetryQueueItem[] {
    return Object.freeze(this.queueValue.map((item) => frozenQueueItem(item)));
  }

  async initialize(): Promise<void> {
    let raw: string | null = null;
    try {
      raw = await this.adapter.storage.getItem(this.storageKey);
    } catch {
      this.enabledValue = false;
      this.consentUpdatedAt = 0;
      this.queueValue = [];
      return;
    }
    const restored = parseTelemetryState(
      raw,
      finiteTimestamp(this.now(), Date.now()),
      this.maxQueue,
      this.queueTtlMs,
    );
    this.enabledValue = restored?.consent.enabled ?? false;
    this.consentUpdatedAt = restored?.consent.updatedAt ?? 0;
    this.queueValue = restored?.queue ?? [];
    this.sequence = this.queueValue.length;
  }

  setOptIn(enabled: boolean): Promise<void> {
    if (typeof enabled !== "boolean") {
      return Promise.reject(new DiagnosticsError("INVALID_TELEMETRY", "telemetry 동의 값은 boolean이어야 합니다."));
    }
    return this.enqueue(async () => {
      this.enabledValue = enabled;
      this.consentUpdatedAt = finiteTimestamp(this.now(), Date.now());
      if (!enabled) this.queueValue = [];
      await this.persist();
    });
  }

  track(
    event: TelemetryEventName,
    metadata: TelemetryMetadata = {},
  ): Promise<TelemetryPayload | null> {
    return this.enqueue(async () => {
      if (!this.enabledValue) return null;
      const timestamp = finiteTimestamp(this.now(), Date.now());
      this.sequence += 1;
      const payload = normalizeTelemetryPayload(event, metadata, {
        eventId: this.eventIdFactory(event, this.sequence),
        timestamp,
        ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      });
      const item = frozenQueueItem({
        payload,
        attempts: 0,
        nextAttemptAt: timestamp,
        createdAt: timestamp,
      });
      this.queueValue = [...this.queueValue, item].slice(-this.maxQueue);
      await this.persist();
      return payload;
    });
  }

  flush(): Promise<TelemetryFlushResult> {
    if (this.flushPromise) return this.flushPromise;
    this.flushPromise = this.enqueue(async () => this.flushInternal()).finally(() => {
      this.flushPromise = null;
    });
    return this.flushPromise;
  }

  clear(): Promise<void> {
    return this.enqueue(async () => {
      this.enabledValue = false;
      this.consentUpdatedAt = 0;
      this.queueValue = [];
      try {
        if (this.adapter.storage.removeItem) await this.adapter.storage.removeItem(this.storageKey);
        else await this.adapter.storage.setItem(this.storageKey, "");
      } catch (error) {
        throw new DiagnosticsError("STORAGE_ERROR", "telemetry 상태를 지우지 못했습니다.", error);
      }
    });
  }

  private async flushInternal(): Promise<TelemetryFlushResult> {
    if (!this.enabledValue || !this.adapter.provider) {
      return Object.freeze({ sent: 0, retried: 0, discarded: 0, pending: this.queueValue.length });
    }
    const now = finiteTimestamp(this.now(), Date.now());
    let sent = 0;
    let retried = 0;
    let discarded = 0;
    const remaining: TelemetryQueueItem[] = [];
    for (const item of this.queueValue) {
      if (now - item.createdAt > this.queueTtlMs) {
        discarded += 1;
        continue;
      }
      if (item.nextAttemptAt > now) {
        remaining.push(item);
        continue;
      }
      try {
        await this.adapter.provider.send(item.payload);
        sent += 1;
      } catch {
        const attempts = item.attempts + 1;
        if (attempts >= this.maxAttempts) {
          discarded += 1;
        } else {
          retried += 1;
          const delay = Math.min(
            86_400_000,
            this.baseRetryDelayMs * (2 ** Math.min(20, attempts - 1)),
          );
          remaining.push(frozenQueueItem({
            ...item,
            attempts,
            nextAttemptAt: now + delay,
          }));
        }
      }
    }
    this.queueValue = remaining;
    await this.persist();
    return Object.freeze({ sent, retried, discarded, pending: remaining.length });
  }

  private async persist(): Promise<void> {
    const state: StoredTelemetryState = {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      consent: {
        enabled: this.enabledValue,
        version: TELEMETRY_CONSENT_VERSION,
        updatedAt: this.consentUpdatedAt,
      },
      queue: this.queueValue,
    };
    try {
      await this.adapter.storage.setItem(this.storageKey, JSON.stringify(state));
    } catch (error) {
      throw new DiagnosticsError("STORAGE_ERROR", "telemetry 상태를 저장하지 못했습니다.", error);
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const runWithRollback = async (): Promise<T> => {
      const previousEnabled = this.enabledValue;
      const previousUpdatedAt = this.consentUpdatedAt;
      const previousQueue = this.queueValue;
      const previousSequence = this.sequence;
      try {
        return await operation();
      } catch (error) {
        this.enabledValue = previousEnabled;
        this.consentUpdatedAt = previousUpdatedAt;
        this.queueValue = previousQueue;
        this.sequence = previousSequence;
        throw error;
      }
    };
    const run = this.mutationQueue.then(runWithRollback, runWithRollback);
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }
}

function clampInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.floor(value)))
    : fallback;
}
