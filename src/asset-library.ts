/**
 * UXP 타입은 Premiere/UXP 버전에 따라 실제 런타임 모양과 선언이 달라질 수 있습니다.
 * any는 이 어댑터 경계에서만 허용하고, 나머지 자산 라이브러리는 명시적 타입으로 다룹니다.
 */
export type UxpEntry = any;

export type MaybePromise<T> = T | Promise<T>;

export interface UxpLocalFileSystemAdapter {
  getFolder(options?: any): Promise<any>;
  createPersistentToken(entry: any): Promise<string>;
  getEntryForPersistentToken(token: string): Promise<any>;
}

export interface KeyValueStorageAdapter {
  getItem(key: string): MaybePromise<any>;
  setItem(key: string, value: string): MaybePromise<any>;
  removeItem(key: string): MaybePromise<any>;
}

export interface UxpShellAdapter {
  openPath?(nativePath: string): MaybePromise<any>;
}

export interface AssetLibraryAdapter {
  localFileSystem: UxpLocalFileSystemAdapter;
  storage: KeyValueStorageAdapter;
  shell?: UxpShellAdapter;
}

export interface DefaultAdapterOptions {
  uxp?: any;
  storage?: any;
}

export type AssetKind = "audio" | "image" | "video";

export interface AssetItem {
  id: string;
  name: string;
  nativePath: string;
  normalizedPath: string;
  relativePath: string;
  folderPath: string;
  extension: string;
  kind: AssetKind;
  size?: number;
  modifiedAt?: number;
  entry?: any;
}

/** 드래그 앤 드롭 경계에서만 사용하는, token과 UXP entry를 제외한 안전한 식별 정보입니다. */
export interface AssetDragPayload {
  readonly version: 1;
  readonly id: string;
  readonly nativePath: string;
  readonly name: string;
  readonly kind: AssetKind;
}

export interface AssetFilterOptions {
  query?: string;
  kind?: AssetKind | "all";
  kinds?: readonly AssetKind[];
  folderPath?: string;
}

export type AudioAssetCategoryRoot = "music" | "sfx";

export interface AudioAssetCategory {
  readonly id: string;
  readonly label: string;
  readonly folderPath: string;
  readonly root: AudioAssetCategoryRoot;
  readonly count: number;
}

export type AssetSortKey =
  | "name"
  | "type"
  | "size"
  | "modified"
  | "modifiedAt"
  | "path";
export type AssetSortDirection = "asc" | "desc";

export interface AssetSortOptions {
  by?: AssetSortKey;
  direction?: AssetSortDirection;
}

export interface AssetLibraryOptions {
  storageKey?: string;
  maxDepth?: number;
  maxEntries?: number;
}

export interface AssetSyncOptions {
  maxDepth?: number;
  maxEntries?: number;
  signal?: { readonly aborted: boolean };
}

export interface AssetSyncStats {
  directoriesScanned: number;
  entriesVisited: number;
  supportedAssets: number;
  unsupportedFiles: number;
  duplicateFiles: number;
  deepestLevel: number;
  truncated: boolean;
}

export type AssetLibraryErrorCode =
  | "CANCELLED"
  | "PERMISSION_DENIED"
  | "TOKEN_EXPIRED"
  | "ROOT_NOT_SELECTED"
  | "INVALID_ROOT"
  | "UNSUPPORTED_API"
  | "FILESYSTEM_ERROR";

export class AssetLibraryError extends Error {
  override readonly name = "AssetLibraryError";
  readonly code: AssetLibraryErrorCode;
  readonly originalError?: unknown;

  constructor(
    code: AssetLibraryErrorCode,
    message: string,
    originalError?: unknown,
  ) {
    super(message);
    this.code = code;
    if (originalError !== undefined) {
      this.originalError = originalError;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export const ASSET_LIBRARY_TOKEN_KEY = "shortflow.assetLibrary.rootToken";
export const MAX_ASSET_SYNC_DEPTH = 5;
export const MAX_ASSET_SYNC_ENTRIES = 5_000;
export const ASSET_DRAG_PAYLOAD_MIME = "application/x-shortflow-asset+json";
export const MAX_ASSET_DRAG_PAYLOAD_LENGTH = 8_192;
export const MAX_ASSET_CUSTOM_ORDER_ITEMS = 5_000;

/**
 * References는 컨테이너 폴더이며 Images/Videos는 그 아래에 생성합니다.
 */
export const DEFAULT_ASSET_FOLDERS = Object.freeze([
  "Music",
  "SFX",
  "References",
  "References/Images",
  "References/Videos",
  "Thumbnails",
  "Exports",
] as const);

const AUDIO_EXTENSIONS = new Set([
  ".aac",
  ".aif",
  ".aiff",
  ".flac",
  ".m4a",
  ".mp3",
  ".ogg",
  ".wav",
  ".wma",
]);

const IMAGE_EXTENSIONS = new Set([
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".psd",
  ".tif",
  ".tiff",
  ".webp",
]);

const VIDEO_EXTENSIONS = new Set([
  ".3gp",
  ".avi",
  ".m2ts",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".mts",
  ".mxf",
  ".webm",
  ".wmv",
]);

const collator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

function extensionOf(pathOrName: string): string {
  const cleanValue = pathOrName.trim().split(/[?#]/u, 1)[0] ?? "";
  const lastSlash = Math.max(cleanValue.lastIndexOf("/"), cleanValue.lastIndexOf("\\"));
  const filename = cleanValue.slice(lastSlash + 1);
  const lastDot = filename.lastIndexOf(".");

  if (lastDot <= 0 || lastDot === filename.length - 1) {
    return "";
  }

  return filename.slice(lastDot).toLocaleLowerCase("en-US");
}

export function classifyAsset(pathOrName: string): AssetKind | null {
  if (typeof pathOrName !== "string" || pathOrName.trim() === "") {
    return null;
  }

  const extension = extensionOf(pathOrName);
  if (AUDIO_EXTENSIONS.has(extension)) {
    return "audio";
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }
  if (VIDEO_EXTENSIONS.has(extension)) {
    return "video";
  }
  return null;
}

export function isSupportedAsset(pathOrName: string): boolean {
  return classifyAsset(pathOrName) !== null;
}

/**
 * 중복 검사용 정규화입니다. Windows 드라이브/UNC 경로만 소문자화하고,
 * 대소문자를 구분할 수 있는 POSIX 경로는 원래 대소문자를 유지합니다.
 */
export function normalizeNativePath(nativePath: string): string {
  if (typeof nativePath !== "string") {
    return "";
  }

  const unicodePath = nativePath.trim().normalize("NFC").replace(/\\/gu, "/");
  if (unicodePath === "") {
    return "";
  }

  const isUnc = unicodePath.startsWith("//");
  const driveMatch = unicodePath.match(/^([a-z]):(?:\/|$)/iu);
  const isAbsolutePosix = !isUnc && !driveMatch && unicodePath.startsWith("/");
  const drive = driveMatch?.[1]?.toLocaleLowerCase("en-US") ?? "";
  const contentStart = driveMatch ? driveMatch[0].length : isUnc ? 2 : isAbsolutePosix ? 1 : 0;
  const segments = unicodePath.slice(contentStart).split(/\/+/u);
  const normalizedSegments: string[] = [];

  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (
        normalizedSegments.length > 0 &&
        normalizedSegments[normalizedSegments.length - 1] !== ".."
      ) {
        normalizedSegments.pop();
      } else if (!driveMatch && !isUnc && !isAbsolutePosix) {
        normalizedSegments.push(segment);
      }
      continue;
    }
    normalizedSegments.push(segment);
  }

  let normalized: string;
  if (driveMatch) {
    normalized = `${drive}:/${normalizedSegments.join("/")}`;
  } else if (isUnc) {
    normalized = `//${normalizedSegments.join("/")}`;
  } else if (isAbsolutePosix) {
    normalized = `/${normalizedSegments.join("/")}`;
  } else {
    normalized = normalizedSegments.join("/");
  }

  if (normalized.length > 1 && normalized.endsWith("/") && !/^[a-z]:\/$/iu.test(normalized)) {
    normalized = normalized.slice(0, -1);
  }

  return driveMatch || isUnc ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function safeDragText(value: unknown, maximum: number): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length > 0 && text.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(text)
    ? text
    : "";
}

function isAssetKind(value: unknown): value is AssetKind {
  return value === "audio" || value === "image" || value === "video";
}

/** Serializes only the path-derived ID and insertion metadata; never a UXP entry or token. */
export function createAssetDragPayload(asset: AssetItem): string {
  const nativePath = safeDragText(asset?.nativePath, 4_096);
  const id = normalizeNativePath(safeDragText(asset?.normalizedPath, 4_096) || nativePath);
  const name = safeDragText(asset?.name, 512);
  if (!id || !nativePath || !name || !isAssetKind(asset?.kind)) {
    throw new TypeError("드래그할 자산의 경로 기반 식별 정보가 올바르지 않습니다.");
  }
  return JSON.stringify({ version: 1, id, nativePath, name, kind: asset.kind } satisfies AssetDragPayload);
}

/** Parses an untrusted browser drag payload and verifies that the ID still derives from its path. */
export function parseAssetDragPayload(serialized: unknown): AssetDragPayload | null {
  if (typeof serialized !== "string" || serialized.length === 0 || serialized.length > MAX_ASSET_DRAG_PAYLOAD_LENGTH) {
    return null;
  }
  try {
    const value = JSON.parse(serialized) as Record<string, unknown>;
    const nativePath = safeDragText(value.nativePath, 4_096);
    const id = safeDragText(value.id, 4_096);
    const name = safeDragText(value.name, 512);
    if (
      value.version !== 1 ||
      !nativePath ||
      !id ||
      !name ||
      !isAssetKind(value.kind) ||
      normalizeNativePath(id) !== normalizeNativePath(nativePath)
    ) {
      return null;
    }
    return Object.freeze({
      version: 1,
      id: normalizeNativePath(nativePath),
      nativePath,
      name,
      kind: value.kind,
    });
  } catch {
    return null;
  }
}

export function parseAudioAssetDragPayload(serialized: unknown): AssetDragPayload | null {
  const payload = parseAssetDragPayload(serialized);
  return payload?.kind === "audio" ? payload : null;
}

export function resolveAudioAssetDragTarget(
  assets: readonly AssetItem[],
  serialized: unknown,
): AssetItem | null {
  const payload = parseAudioAssetDragPayload(serialized);
  if (!payload) return null;
  const payloadId = normalizeNativePath(payload.id);
  return assets.find((candidate) => (
    candidate.kind === "audio" &&
    candidate.normalizedPath === payloadId &&
    normalizeNativePath(candidate.nativePath) === normalizeNativePath(payload.nativePath)
  )) ?? null;
}

function normalizedSearchValue(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().trim();
}

function normalizedRelativeFolder(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .normalize("NFC")
    .replace(/\\/gu, "/")
    .split("/").map((segment) => segment.trim()).filter(Boolean)
    .join("/");
}

export function audioAssetCategoryRoot(folderPath: string): AudioAssetCategoryRoot | null {
  const [root] = normalizedRelativeFolder(folderPath).split("/");
  const normalized = root?.toLocaleLowerCase("en-US");
  if (normalized === "music") return "music";
  if (normalized === "sfx") return "sfx";
  return null;
}

function audioCategoryLabel(folderPath: string): string {
  const normalized = normalizedRelativeFolder(folderPath);
  if (!normalized) return "기타 오디오";
  const segments = normalized.split("/");
  const root = segments[0]?.toLocaleLowerCase("en-US");
  if (root === "music") {
    return segments.length === 1 ? "음악" : `음악 / ${segments.slice(1).join(" / ")}`;
  }
  if (root === "sfx") {
    return segments.length === 1 ? "효과음" : `효과음 / ${segments.slice(1).join(" / ")}`;
  }
  return normalized;
}

export function listAudioAssetCategories(assets: readonly AssetItem[]): AudioAssetCategory[] {
  const byFolder = new Map<string, { folderPath: string; root: AudioAssetCategoryRoot; count: number }>();
  for (const asset of assets) {
    if (asset.kind !== "audio") continue;
    const folderPath = normalizedRelativeFolder(asset.folderPath);
    const root = audioAssetCategoryRoot(folderPath);
    if (!root || !folderPath) continue;
    const id = normalizeNativePath(folderPath);
    const current = byFolder.get(id);
    if (current) {
      current.count += 1;
    } else {
      byFolder.set(id, { folderPath, root, count: 1 });
    }
  }
  return [...byFolder.entries()]
    .map(([id, category]) => Object.freeze({
      id,
      label: audioCategoryLabel(category.folderPath),
      folderPath: category.folderPath,
      root: category.root,
      count: category.count,
    }))
    .sort((left, right) => {
      if (left.root !== right.root) return left.root === "music" ? -1 : 1;
      return collator.compare(left.folderPath, right.folderPath);
    });
}

export function filterAssets(
  assets: readonly AssetItem[],
  queryOrOptions: string | AssetFilterOptions = {},
): AssetItem[] {
  const options: AssetFilterOptions =
    typeof queryOrOptions === "string" ? { query: queryOrOptions } : queryOrOptions;
  const queryTokens = normalizedSearchValue(options.query ?? "")
    .split(/\s+/u)
    .filter(Boolean);
  const kinds = options.kinds
    ? new Set(options.kinds)
    : options.kind && options.kind !== "all"
      ? new Set([options.kind])
      : null;
  const requestedFolder = options.folderPath
    ? normalizeNativePath(options.folderPath)
    : "";

  return assets.filter((asset) => {
    if (kinds && !kinds.has(asset.kind)) {
      return false;
    }

    if (requestedFolder) {
      const assetFolder = normalizeNativePath(asset.folderPath);
      if (
        assetFolder !== requestedFolder &&
        !assetFolder.startsWith(`${requestedFolder}/`)
      ) {
        return false;
      }
    }

    if (queryTokens.length === 0) {
      return true;
    }

    const haystack = normalizedSearchValue(
      `${asset.name} ${asset.relativePath} ${asset.nativePath} ${asset.kind}`,
    );
    return queryTokens.every((token) => haystack.includes(token));
  });
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function sortAssets(
  assets: readonly AssetItem[],
  sortOrKey: AssetSortOptions | AssetSortKey = {},
  directionOverride?: AssetSortDirection,
): AssetItem[] {
  const options: AssetSortOptions =
    typeof sortOrKey === "string"
      ? { by: sortOrKey, direction: directionOverride ?? "asc" }
      : sortOrKey;
  const key = options.by ?? "name";
  const direction = options.direction ?? "asc";
  const multiplier = direction === "desc" ? -1 : 1;

  return assets
    .map((asset, index) => ({ asset, index }))
    .sort((left, right) => {
      let comparison = 0;
      switch (key) {
        case "size":
          comparison = finiteNumber(left.asset.size, -1) - finiteNumber(right.asset.size, -1);
          break;
        case "modified":
        case "modifiedAt":
          comparison =
            finiteNumber(left.asset.modifiedAt, -1) -
            finiteNumber(right.asset.modifiedAt, -1);
          break;
        case "type":
          comparison = collator.compare(left.asset.kind, right.asset.kind);
          if (comparison === 0) {
            comparison = collator.compare(left.asset.extension, right.asset.extension);
          }
          break;
        case "path":
          comparison = collator.compare(left.asset.normalizedPath, right.asset.normalizedPath);
          break;
        case "name":
          comparison = collator.compare(left.asset.name, right.asset.name);
          break;
      }

      if (comparison === 0) {
        comparison = collator.compare(left.asset.normalizedPath, right.asset.normalizedPath);
      }
      if (comparison === 0) {
        return left.index - right.index;
      }
      return comparison * multiplier;
    })
    .map(({ asset }) => asset);
}

export function normalizeAssetOrder(
  value: unknown,
  allowedIds?: readonly string[],
): string[] {
  const source = Array.isArray(value) ? value : [];
  const allowed = allowedIds ? new Set(allowedIds.map((id) => normalizeNativePath(id))) : null;
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of source) {
    const id = normalizeNativePath(String(item ?? ""));
    if (!id || seen.has(id) || (allowed && !allowed.has(id))) continue;
    seen.add(id);
    output.push(id);
    if (output.length >= MAX_ASSET_CUSTOM_ORDER_ITEMS) break;
  }
  return output;
}

export function applyAssetOrder(
  assets: readonly AssetItem[],
  order: readonly string[],
): AssetItem[] {
  const ranks = new Map<string, number>();
  for (const [index, id] of normalizeAssetOrder(order).entries()) {
    if (!ranks.has(id)) ranks.set(id, index);
  }
  return assets
    .map((asset, index) => ({ asset, index, rank: ranks.get(asset.normalizedPath) }))
    .sort((left, right) => {
      const leftRank = left.rank;
      const rightRank = right.rank;
      if (leftRank !== undefined && rightRank !== undefined && leftRank !== rightRank) {
        return leftRank - rightRank;
      }
      if (leftRank !== undefined) return -1;
      if (rightRank !== undefined) return 1;
      return left.index - right.index;
    })
    .map(({ asset }) => asset);
}

export function reorderAssetIds(
  existingOrder: readonly string[],
  visibleIds: readonly string[],
  draggedId: string,
  targetId: string,
): string[] {
  const visible = normalizeAssetOrder(visibleIds);
  const dragged = normalizeNativePath(draggedId);
  const target = normalizeNativePath(targetId);
  const from = visible.indexOf(dragged);
  const to = visible.indexOf(target);
  if (from < 0 || to < 0 || from === to) {
    return normalizeAssetOrder(existingOrder);
  }

  visible.splice(from, 1);
  visible.splice(to, 0, dragged);
  const visibleSet = new Set(visible);
  const rest = normalizeAssetOrder(existingOrder).filter((id) => !visibleSet.has(id));
  return normalizeAssetOrder([...visible, ...rest]);
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(0, Math.floor(value)));
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name} ${error.message}`.trim();
  }
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    return `${String(record.code ?? "")} ${String(record.message ?? "")}`.trim();
  }
  return String(error ?? "");
}

function isCancellation(error: unknown): boolean {
  return /abort|cancel|canceled|cancelled|dismiss|user.?closed/iu.test(errorText(error));
}

function isPermissionError(error: unknown): boolean {
  return /access|denied|forbidden|not.?allowed|permission|security|unauthor/iu.test(
    errorText(error),
  );
}

function filesystemError(error: unknown, message: string): AssetLibraryError {
  if (error instanceof AssetLibraryError) {
    return error;
  }
  if (isCancellation(error)) {
    return new AssetLibraryError("CANCELLED", "폴더 작업이 취소되었습니다.", error);
  }
  if (isPermissionError(error)) {
    return new AssetLibraryError(
      "PERMISSION_DENIED",
      "선택한 자산 폴더에 접근할 권한이 없습니다. 폴더 권한을 확인한 뒤 다시 선택해 주세요.",
      error,
    );
  }
  return new AssetLibraryError("FILESYSTEM_ERROR", message, error);
}

function isFolderEntry(entry: UxpEntry): boolean {
  return Boolean(
    entry &&
      (entry.isFolder === true ||
        (entry.isFile !== true && typeof entry.getEntries === "function")),
  );
}

function isFileEntry(entry: UxpEntry): boolean {
  return Boolean(entry && (entry.isFile === true || (!isFolderEntry(entry) && entry.name)));
}

function entryName(entry: UxpEntry): string {
  return typeof entry?.name === "string" ? entry.name : "";
}

function entryNativePath(entry: UxpEntry): string {
  return typeof entry?.nativePath === "string" ? entry.nativePath : "";
}

async function entryMetadata(entry: UxpEntry): Promise<Record<string, unknown>> {
  if (typeof entry?.getMetadata !== "function") {
    return {};
  }
  const metadata = await entry.getMetadata();
  return metadata && typeof metadata === "object"
    ? (metadata as Record<string, unknown>)
    : {};
}

function timestampOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : undefined;
  }
  return undefined;
}

function sizeOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function snapshotAssets(assets: readonly AssetItem[]): AssetItem[] {
  return assets.map((asset) => ({ ...asset }));
}

export function createDefaultAssetLibraryAdapter(
  options: DefaultAdapterOptions = {},
): AssetLibraryAdapter {
  let uxp = options.uxp;
  if (!uxp) {
    try {
      uxp = require("uxp");
    } catch (error) {
      throw new AssetLibraryError(
        "UNSUPPORTED_API",
        "UXP 파일 시스템을 사용할 수 없습니다. Premiere Pro의 UXP 패널에서 실행해 주세요.",
        error,
      );
    }
  }

  const localFileSystem = uxp?.storage?.localFileSystem;
  const storage = options.storage ?? (globalThis as any).localStorage;
  if (!localFileSystem || !storage) {
    throw new AssetLibraryError(
      "UNSUPPORTED_API",
      "UXP localFileSystem 또는 persistent token 저장소를 사용할 수 없습니다.",
    );
  }

  const adapter: AssetLibraryAdapter = { localFileSystem, storage };
  if (uxp.shell) {
    adapter.shell = uxp.shell;
  }
  return adapter;
}

export class AssetLibrary {
  readonly adapter: AssetLibraryAdapter;
  readonly storageKey: string;
  readonly maxDepth: number;
  readonly maxEntries: number;
  private rootEntry: UxpEntry | null = null;
  private cachedAssets: readonly AssetItem[] = [];
  private defaultSync: Promise<AssetItem[]> | null = null;
  private defaultSyncToken: object | null = null;
  private rootRevision = 0;
  private syncStats: AssetSyncStats = {
    directoriesScanned: 0,
    entriesVisited: 0,
    supportedAssets: 0,
    unsupportedFiles: 0,
    duplicateFiles: 0,
    deepestLevel: 0,
    truncated: false,
  };

  constructor(adapter: AssetLibraryAdapter, options: AssetLibraryOptions = {}) {
    if (!adapter?.localFileSystem || !adapter.storage) {
      throw new AssetLibraryError(
        "UNSUPPORTED_API",
        "자산 라이브러리에 localFileSystem과 저장소 어댑터가 필요합니다.",
      );
    }

    this.adapter = adapter;
    this.storageKey = options.storageKey?.trim() || ASSET_LIBRARY_TOKEN_KEY;
    this.maxDepth = boundedInteger(
      options.maxDepth,
      MAX_ASSET_SYNC_DEPTH,
      MAX_ASSET_SYNC_DEPTH,
    );
    this.maxEntries = boundedInteger(
      options.maxEntries,
      MAX_ASSET_SYNC_ENTRIES,
      MAX_ASSET_SYNC_ENTRIES,
    );
  }

  get currentRoot(): UxpEntry | null {
    return this.rootEntry;
  }

  get lastSyncStats(): AssetSyncStats {
    return { ...this.syncStats };
  }

  /** Returns the last successful scan. Failed/cancelled scans never invalidate this snapshot. */
  get lastSuccessfulAssets(): readonly AssetItem[] {
    return snapshotAssets(this.cachedAssets);
  }

  async selectRoot(): Promise<UxpEntry> {
    let folder: UxpEntry;
    try {
      folder = await this.adapter.localFileSystem.getFolder();
    } catch (error) {
      throw filesystemError(error, "자산 루트 폴더를 선택하지 못했습니다.");
    }

    if (!folder) {
      throw new AssetLibraryError(
        "CANCELLED",
        "자산 루트 폴더 선택이 취소되었습니다. 기존 설정은 변경되지 않았습니다.",
      );
    }
    if (!isFolderEntry(folder)) {
      throw new AssetLibraryError(
        "INVALID_ROOT",
        "자산 루트에는 파일이 아닌 폴더를 선택해 주세요.",
      );
    }

    await this.ensureDefaultFolders(folder);

    let token: string;
    try {
      token = await this.adapter.localFileSystem.createPersistentToken(folder);
      if (typeof token !== "string" || !token.trim()) {
        throw new Error("empty persistent token");
      }
      await this.adapter.storage.setItem(this.storageKey, token);
    } catch (error) {
      throw filesystemError(
        error,
        "자산 폴더 접근 토큰을 저장하지 못했습니다. 다시 선택해 주세요.",
      );
    }

    this.rootEntry = folder;
    this.invalidateCache();
    return folder;
  }

  async restoreRoot(): Promise<UxpEntry | null> {
    let tokenValue: unknown;
    try {
      tokenValue = await this.adapter.storage.getItem(this.storageKey);
    } catch (error) {
      throw filesystemError(error, "저장된 자산 폴더 설정을 읽지 못했습니다.");
    }

    if (tokenValue === null || tokenValue === undefined || tokenValue === "") {
      this.rootEntry = null;
      this.invalidateCache();
      return null;
    }

    const token = typeof tokenValue === "string" ? tokenValue.trim() : "";
    if (!token) {
      await this.removeStoredTokenSilently();
      throw new AssetLibraryError(
        "TOKEN_EXPIRED",
        "저장된 자산 폴더 토큰이 올바르지 않습니다. 폴더를 다시 선택해 주세요.",
      );
    }

    let folder: UxpEntry;
    try {
      folder = await this.adapter.localFileSystem.getEntryForPersistentToken(token);
    } catch (error) {
      this.rootEntry = null;
      this.invalidateCache();
      await this.removeStoredTokenSilently();
      throw new AssetLibraryError(
        "TOKEN_EXPIRED",
        "자산 폴더 권한이 만료되었거나 폴더가 이동되었습니다. 자산 루트 폴더를 다시 선택해 주세요.",
        error,
      );
    }

    if (!isFolderEntry(folder)) {
      this.rootEntry = null;
      this.invalidateCache();
      await this.removeStoredTokenSilently();
      throw new AssetLibraryError(
        "TOKEN_EXPIRED",
        "저장된 자산 폴더를 찾을 수 없습니다. 자산 루트 폴더를 다시 선택해 주세요.",
      );
    }

    await this.ensureDefaultFolders(folder);
    this.rootEntry = folder;
    this.invalidateCache();
    return folder;
  }

  async clearRoot(): Promise<void> {
    try {
      await this.adapter.storage.removeItem(this.storageKey);
    } catch (error) {
      throw filesystemError(error, "저장된 자산 폴더 설정을 지우지 못했습니다.");
    }
    this.rootEntry = null;
    this.invalidateCache();
  }

  async ensureDefaultFolders(root: UxpEntry = this.rootEntry): Promise<void> {
    if (!root || !isFolderEntry(root)) {
      throw new AssetLibraryError(
        "ROOT_NOT_SELECTED",
        "먼저 자산 루트 폴더를 선택해 주세요.",
      );
    }

    const cache = new Map<string, UxpEntry>();
    cache.set("", root);

    try {
      for (const folderPath of DEFAULT_ASSET_FOLDERS) {
        const segments = folderPath.split("/");
        let currentPath = "";
        let currentFolder = root;

        for (const segment of segments) {
          currentPath = currentPath ? `${currentPath}/${segment}` : segment;
          const cached = cache.get(currentPath);
          if (cached) {
            currentFolder = cached;
            continue;
          }

          const children = await currentFolder.getEntries();
          const entries = Array.from(children ?? []) as UxpEntry[];
          const existing =
            entries.find((entry) => entryName(entry) === segment) ??
            entries.find(
              (entry) =>
                entryName(entry).toLocaleLowerCase() === segment.toLocaleLowerCase(),
            );

          if (existing) {
            if (!isFolderEntry(existing)) {
              throw new AssetLibraryError(
                "INVALID_ROOT",
                `기본 폴더를 만들 수 없습니다. '${currentPath}' 위치에 같은 이름의 파일이 있습니다.`,
              );
            }
            currentFolder = existing;
          } else {
            if (typeof currentFolder.createFolder !== "function") {
              throw new AssetLibraryError(
                "UNSUPPORTED_API",
                "선택한 폴더에서 하위 폴더 생성 API를 사용할 수 없습니다.",
              );
            }
            currentFolder = await currentFolder.createFolder(segment);
          }

          cache.set(currentPath, currentFolder);
        }
      }
    } catch (error) {
      throw filesystemError(
        error,
        "자산 라이브러리의 기본 폴더 구조를 준비하지 못했습니다.",
      );
    }
  }

  async sync(options: AssetSyncOptions = {}): Promise<AssetItem[]> {
    const isDefaultSync =
      options.maxDepth === undefined &&
      options.maxEntries === undefined &&
      options.signal === undefined;
    if (isDefaultSync && this.defaultSync) {
      return this.defaultSync.then((assets) => snapshotAssets(assets));
    }

    const pending = this.syncInternal(options);
    if (isDefaultSync) {
      const token = {};
      const shared = pending.finally(() => {
        if (this.defaultSyncToken === token) {
          this.defaultSync = null;
          this.defaultSyncToken = null;
        }
      });
      this.defaultSync = shared;
      this.defaultSyncToken = token;
      return shared;
    }
    return pending;
  }

  private async syncInternal(options: AssetSyncOptions): Promise<AssetItem[]> {
    const root = await this.requireRoot();
    const rootRevision = this.rootRevision;
    await this.ensureDefaultFolders(root);

    const maxDepth = boundedInteger(options.maxDepth, this.maxDepth, this.maxDepth);
    const maxEntries = boundedInteger(options.maxEntries, this.maxEntries, this.maxEntries);
    const assets: AssetItem[] = [];
    const knownFiles = new Set<string>();
    const knownFolders = new Set<string>();
    const rootNativePath = entryNativePath(root);
    const stats: AssetSyncStats = {
      directoriesScanned: 0,
      entriesVisited: 0,
      supportedAssets: 0,
      unsupportedFiles: 0,
      duplicateFiles: 0,
      deepestLevel: 0,
      truncated: false,
    };

    const throwIfCancelled = (): void => {
      if (options.signal?.aborted) {
        throw new AssetLibraryError(
          "CANCELLED",
          "자산 라이브러리 동기화가 취소되었습니다.",
        );
      }
    };

    const scanFolder = async (
      folder: UxpEntry,
      depth: number,
      relativeFolder: string,
    ): Promise<void> => {
      throwIfCancelled();
      stats.deepestLevel = Math.max(stats.deepestLevel, depth);

      const folderKey = normalizeNativePath(entryNativePath(folder));
      if (folderKey && knownFolders.has(folderKey)) {
        return;
      }
      if (folderKey) {
        knownFolders.add(folderKey);
      }

      let rawEntries: unknown;
      try {
        rawEntries = await folder.getEntries();
      } catch (error) {
        throw filesystemError(
          error,
          `자산 폴더 '${relativeFolder || entryName(folder)}'을 읽지 못했습니다.`,
        );
      }

      stats.directoriesScanned += 1;
      const iterableEntries = (rawEntries ?? []) as Iterable<UxpEntry> | ArrayLike<UxpEntry>;
      const entries = Array.from(iterableEntries).sort((left, right) =>
        collator.compare(entryName(left), entryName(right)),
      );

      for (const entry of entries) {
        throwIfCancelled();
        if (stats.entriesVisited >= maxEntries) {
          stats.truncated = true;
          return;
        }
        stats.entriesVisited += 1;

        const name = entryName(entry);
        const relativePath = relativeFolder ? `${relativeFolder}/${name}` : name;
        if (isFolderEntry(entry)) {
          if (depth < maxDepth) {
            await scanFolder(entry, depth + 1, relativePath);
          }
          if (stats.truncated) {
            return;
          }
          continue;
        }

        if (!isFileEntry(entry)) {
          continue;
        }

        const kind = classifyAsset(name);
        if (!kind) {
          stats.unsupportedFiles += 1;
          continue;
        }

        const nativePath =
          entryNativePath(entry) ||
          `${rootNativePath.replace(/[\\/]$/u, "")}/${relativePath}`;
        const normalizedPath = normalizeNativePath(nativePath);
        if (!normalizedPath || knownFiles.has(normalizedPath)) {
          stats.duplicateFiles += 1;
          continue;
        }
        knownFiles.add(normalizedPath);

        let metadata: Record<string, unknown> = {};
        try {
          metadata = await entryMetadata(entry);
        } catch (error) {
          if (isPermissionError(error)) {
            throw filesystemError(error, `자산 '${relativePath}'의 정보를 읽지 못했습니다.`);
          }
        }

        const item: AssetItem = {
          id: normalizedPath,
          name,
          nativePath,
          normalizedPath,
          relativePath,
          folderPath: relativeFolder,
          extension: extensionOf(name),
          kind,
          entry,
        };
        const size = sizeOf(metadata.size ?? entry.size);
        const modifiedAt = timestampOf(
          metadata.dateModified ?? metadata.modifiedAt ?? entry.dateModified,
        );
        if (size !== undefined) {
          item.size = size;
        }
        if (modifiedAt !== undefined) {
          item.modifiedAt = modifiedAt;
        }

        assets.push(item);
        stats.supportedAssets += 1;
      }
    };

    try {
      await scanFolder(root, 0, "");
      this.syncStats = stats;
      const sorted = sortAssets(assets);
      if (rootRevision === this.rootRevision && root === this.rootEntry) {
        this.cachedAssets = snapshotAssets(sorted);
      }
      return snapshotAssets(sorted);
    } catch (error) {
      this.syncStats = stats;
      throw filesystemError(error, "자산 라이브러리를 동기화하지 못했습니다.");
    }
  }

  search(
    assets: readonly AssetItem[],
    queryOrOptions: string | AssetFilterOptions,
    sortOptions: AssetSortOptions = {},
  ): AssetItem[] {
    return sortAssets(filterAssets(assets, queryOrOptions), sortOptions);
  }

  async openRootFolder(): Promise<void> {
    const root = await this.requireRoot();
    await this.openFolder(root);
  }

  async openRelativeFolder(relativeFolderPath: string): Promise<void> {
    const folder = await this.resolveRelativeFolder(relativeFolderPath);
    await this.openFolder(folder);
  }

  async resolveRelativeFolder(relativeFolderPath: string): Promise<UxpEntry> {
    let current = await this.requireRoot();
    const normalized = normalizedRelativeFolder(relativeFolderPath);
    if (!normalized) {
      return current;
    }

    const segments = normalized.split("/");
    if (segments.some((segment) => segment === "." || segment === "..")) {
      throw new AssetLibraryError(
        "INVALID_ROOT",
        "열 폴더 경로가 올바르지 않습니다.",
      );
    }

    try {
      for (const segment of segments) {
        const children = await current.getEntries();
        const entries = Array.from(children ?? []) as UxpEntry[];
        const next = entries.find((entry) =>
          isFolderEntry(entry) &&
          entryName(entry).toLocaleLowerCase("en-US") === segment.toLocaleLowerCase("en-US"));
        if (!next) {
          throw new AssetLibraryError(
            "INVALID_ROOT",
            `자산 폴더 '${normalized}'을 찾을 수 없습니다. 동기화를 다시 실행해 주세요.`,
          );
        }
        current = next;
      }
    } catch (error) {
      throw filesystemError(error, `자산 폴더 '${normalized}'을 열 수 없습니다.`);
    }

    return current;
  }

  async openFolder(folder: UxpEntry): Promise<void> {
    const openPath = this.adapter.shell?.openPath;
    if (typeof openPath !== "function") {
      throw new AssetLibraryError(
        "UNSUPPORTED_API",
        "현재 Premiere Pro/UXP 환경에서는 시스템 파일 탐색기로 폴더 열기를 지원하지 않습니다.",
      );
    }

    const nativePath = entryNativePath(folder);
    if (!nativePath) {
      throw new AssetLibraryError(
        "INVALID_ROOT",
        "선택한 자산 폴더의 시스템 경로를 확인할 수 없습니다.",
      );
    }

    try {
      const result = await openPath.call(this.adapter.shell, nativePath);
      if (typeof result === "string" && result.trim()) {
        throw new Error(result);
      }
    } catch (error) {
      throw filesystemError(
        error,
        "시스템 파일 탐색기에서 자산 폴더를 열지 못했습니다.",
      );
    }
  }

  private async requireRoot(): Promise<UxpEntry> {
    if (this.rootEntry) {
      return this.rootEntry;
    }
    const restored = await this.restoreRoot();
    if (!restored) {
      throw new AssetLibraryError(
        "ROOT_NOT_SELECTED",
        "먼저 자산 루트 폴더를 선택해 주세요.",
      );
    }
    return restored;
  }

  private async removeStoredTokenSilently(): Promise<void> {
    try {
      await this.adapter.storage.removeItem(this.storageKey);
    } catch {
      // 만료된 토큰 정리 실패가 원래 복구 오류를 가리지 않도록 합니다.
    }
  }

  private invalidateCache(): void {
    this.rootRevision += 1;
    this.cachedAssets = [];
    this.defaultSync = null;
    this.defaultSyncToken = null;
  }
}
