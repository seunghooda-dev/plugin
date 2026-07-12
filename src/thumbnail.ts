export type ThumbnailLayoutId =
  | "full"
  | "vertical"
  | "horizontal"
  | "hero-left"
  | "hero-top"
  | "grid";

export interface ThumbnailLayoutDefinition {
  readonly id: ThumbnailLayoutId;
  readonly count: 1 | 2 | 3 | 4;
  readonly label: string;
}

export const THUMBNAIL_LAYOUTS = Object.freeze([
  Object.freeze({ id: "full", count: 1, label: "전체" }),
  Object.freeze({ id: "vertical", count: 2, label: "좌우 분할" }),
  Object.freeze({ id: "horizontal", count: 2, label: "상하 분할" }),
  Object.freeze({ id: "hero-left", count: 3, label: "왼쪽 강조" }),
  Object.freeze({ id: "hero-top", count: 3, label: "상단 강조" }),
  Object.freeze({ id: "grid", count: 4, label: "4분할" }),
] as const) satisfies readonly ThumbnailLayoutDefinition[];

export interface ThumbnailAdjustments {
  readonly brightness: number;
  readonly contrast: number;
  readonly saturation: number;
}

export interface ThumbnailOverlay {
  readonly shadow: number;
  readonly glow: number;
  /** @deprecated 새 코드에서는 shadowColor/glowColor를 각각 사용하세요. */
  readonly color: string;
  readonly shadowColor: string;
  readonly glowColor: string;
}

export interface ThumbnailTransform {
  readonly zoom: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

export type ThumbnailTextAlign = "left" | "center" | "right";

export interface ThumbnailTextOverlay {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly fontSize: number;
  readonly color: string;
  readonly shadow: number;
  readonly glow: number;
  readonly shadowColor: string;
  readonly glowColor: string;
  readonly align: ThumbnailTextAlign;
  readonly maxWidthRatio: number;
}

export interface ThumbnailBadgeOverlay {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly fontSize: number;
  readonly color: string;
  readonly backgroundColor: string;
  readonly paddingX: number;
  readonly paddingY: number;
  readonly radius: number;
  readonly visible: boolean;
}

export interface ThumbnailLayer {
  readonly id: string;
  readonly source: string;
  readonly adjustments: ThumbnailAdjustments;
  readonly overlay: ThumbnailOverlay;
  readonly transform: ThumbnailTransform;
}

export interface ThumbnailState {
  readonly width: number;
  readonly height: number;
  readonly layout: ThumbnailLayoutId;
  readonly layers: readonly ThumbnailLayer[];
  readonly selectedLayerId: string | null;
  readonly backgroundColor: string;
  readonly textOverlay: ThumbnailTextOverlay;
  readonly badgeOverlay: ThumbnailBadgeOverlay;
}

export interface ThumbnailLayerInput {
  readonly id?: string;
  readonly source: string;
  readonly adjustments?: Partial<ThumbnailAdjustments>;
  readonly overlay?: Partial<ThumbnailOverlay>;
  readonly transform?: Partial<ThumbnailTransform>;
}

export interface CreateThumbnailStateOptions {
  readonly width?: number;
  readonly height?: number;
  readonly layout?: ThumbnailLayoutId;
  readonly layers?: readonly (ThumbnailLayerInput | string)[];
  readonly selectedLayerId?: string | null;
  readonly backgroundColor?: string;
  readonly textOverlay?: Partial<ThumbnailTextOverlay>;
  readonly badgeOverlay?: Partial<ThumbnailBadgeOverlay>;
}

export interface LayoutRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CanvasImageLike {
  readonly naturalWidth?: number;
  readonly naturalHeight?: number;
  readonly videoWidth?: number;
  readonly videoHeight?: number;
  readonly width?: number;
  readonly height?: number;
}

export interface CanvasContextLike {
  readonly canvas?: {
    width: number;
    height: number;
  };
  filter?: string;
  fillStyle?: unknown;
  strokeStyle?: unknown;
  lineWidth?: number;
  globalAlpha?: number;
  shadowBlur?: number;
  shadowColor?: string;
  shadowOffsetX?: number;
  shadowOffsetY?: number;
  font?: string;
  textAlign?: CanvasTextAlign;
  textBaseline?: CanvasTextBaseline;
  imageSmoothingEnabled?: boolean;
  imageSmoothingQuality?: "low" | "medium" | "high";
  save?: () => void;
  restore?: () => void;
  clearRect?: (x: number, y: number, width: number, height: number) => void;
  fillRect?: (x: number, y: number, width: number, height: number) => void;
  beginPath?: () => void;
  rect?: (x: number, y: number, width: number, height: number) => void;
  clip?: () => void;
  strokeRect?: (x: number, y: number, width: number, height: number) => void;
  measureText?: (text: string) => { width: number };
  fillText?: (text: string, x: number, y: number, maxWidth?: number) => void;
  drawImage: (
    image: unknown,
    sourceX: number,
    sourceY: number,
    sourceWidth: number,
    sourceHeight: number,
    destinationX: number,
    destinationY: number,
    destinationWidth: number,
    destinationHeight: number,
  ) => void;
}

export type ThumbnailImageResolver = (
  source: string,
  layer: ThumbnailLayer,
) => CanvasImageLike | null | undefined | Promise<CanvasImageLike | null | undefined>;

export interface CanvasBlobLike {
  arrayBuffer: () => Promise<ArrayBuffer>;
}

export interface PngCanvasLike {
  convertToBlob?: (options?: { type?: string; quality?: number }) => Promise<CanvasBlobLike | Uint8Array>;
  toBlob?: (
    callback: (blob: CanvasBlobLike | null) => void,
    type?: string,
    quality?: number,
  ) => void;
  toDataURL?: (type?: string) => string;
}

export type ThumbnailExportFormat = "png" | "jpg";

export interface ThumbnailSvgOptions {
  readonly title?: string;
  readonly resolveImageHref?: (source: string, layer: ThumbnailLayer) => string;
}

export type ThumbnailImageMimeType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif"
  | "image/svg+xml";

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
const MAX_LAYERS = 4;
const DEFAULT_ADJUSTMENTS: ThumbnailAdjustments = Object.freeze({
  brightness: 100,
  contrast: 100,
  saturation: 100,
});
const DEFAULT_OVERLAY: ThumbnailOverlay = Object.freeze({
  shadow: 0,
  glow: 0,
  color: "#ffffff",
  shadowColor: "#000000",
  glowColor: "#8b5cf6",
});
const DEFAULT_TRANSFORM: ThumbnailTransform = Object.freeze({
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
});
const DEFAULT_TEXT_OVERLAY: ThumbnailTextOverlay = Object.freeze({
  text: "",
  x: 0.5,
  y: 0.84,
  fontSize: 78,
  color: "#ffffff",
  shadow: 18,
  glow: 0,
  shadowColor: "#000000",
  glowColor: "#8b5cf6",
  align: "center",
  maxWidthRatio: 0.9,
});
const DEFAULT_BADGE_OVERLAY: ThumbnailBadgeOverlay = Object.freeze({
  text: "",
  x: 0.08,
  y: 0.1,
  fontSize: 34,
  color: "#111111",
  backgroundColor: "#facc15",
  paddingX: 22,
  paddingY: 10,
  radius: 12,
  visible: true,
});
const SAFE_NAMED_COLORS = new Set([
  "black",
  "white",
  "red",
  "green",
  "blue",
  "yellow",
  "cyan",
  "magenta",
  "transparent",
]);

function isLayoutId(value: unknown): value is ThumbnailLayoutId {
  return THUMBNAIL_LAYOUTS.some((layout) => layout.id === value);
}

function layoutDefinition(layout: ThumbnailLayoutId): ThumbnailLayoutDefinition {
  const definition = THUMBNAIL_LAYOUTS.find((item) => item.id === layout);
  if (!definition) {
    throw new RangeError(`지원하지 않는 썸네일 레이아웃입니다: ${String(layout)}`);
  }
  return definition;
}

function defaultLayoutForCount(count: number): ThumbnailLayoutId {
  if (count <= 1) return "full";
  if (count === 2) return "vertical";
  if (count === 3) return "hero-left";
  return "grid";
}

function clampNumeric(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (typeof value !== "number" || Number.isNaN(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeDimension(value: number | undefined, fallback: number): number {
  const normalized = clampNumeric(value, 16, 16_384, fallback);
  return Math.round(normalized);
}

function formatCssNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(3).replace(/0+$/u, "").replace(/\.$/u, "");
}

function normalizeRgbFunction(value: string): string | null {
  const match = /^rgba?\(\s*([-+]?\d*\.?\d+)\s*,\s*([-+]?\d*\.?\d+)\s*,\s*([-+]?\d*\.?\d+)(?:\s*,\s*([-+]?\d*\.?\d+)\s*)?\)$/iu.exec(
    value,
  );
  if (!match) return null;

  const red = Math.round(clampNumeric(Number(match[1]), 0, 255, 0));
  const green = Math.round(clampNumeric(Number(match[2]), 0, 255, 0));
  const blue = Math.round(clampNumeric(Number(match[3]), 0, 255, 0));
  if (match[4] === undefined) return `rgb(${red}, ${green}, ${blue})`;

  const alpha = clampNumeric(Number(match[4]), 0, 1, 1);
  return `rgba(${red}, ${green}, ${blue}, ${formatCssNumber(alpha)})`;
}

function normalizeColor(value: string | undefined, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/u.test(normalized)) {
    return normalized;
  }
  if (SAFE_NAMED_COLORS.has(normalized)) return normalized;
  return normalizeRgbFunction(normalized) ?? fallback;
}

function normalizeAdjustments(
  patch: Partial<ThumbnailAdjustments> | undefined,
  base: ThumbnailAdjustments = DEFAULT_ADJUSTMENTS,
): ThumbnailAdjustments {
  return Object.freeze({
    brightness: clampNumeric(patch?.brightness, 0, 200, base.brightness),
    contrast: clampNumeric(patch?.contrast, 0, 200, base.contrast),
    saturation: clampNumeric(patch?.saturation, 0, 200, base.saturation),
  });
}

function normalizeOverlay(
  patch: Partial<ThumbnailOverlay> | undefined,
  base: ThumbnailOverlay = DEFAULT_OVERLAY,
): ThumbnailOverlay {
  const legacyColor = normalizeColor(patch?.color, base.color);
  const legacyWasProvided = patch?.color !== undefined;
  return Object.freeze({
    shadow: clampNumeric(patch?.shadow, 0, 100, base.shadow),
    glow: clampNumeric(patch?.glow, 0, 100, base.glow),
    color: legacyColor,
    shadowColor: normalizeColor(
      patch?.shadowColor,
      legacyWasProvided ? legacyColor : base.shadowColor,
    ),
    glowColor: normalizeColor(
      patch?.glowColor,
      legacyWasProvided ? legacyColor : base.glowColor,
    ),
  });
}

function normalizeTransform(
  patch: Partial<ThumbnailTransform> | undefined,
  base: ThumbnailTransform = DEFAULT_TRANSFORM,
): ThumbnailTransform {
  return Object.freeze({
    zoom: clampNumeric(patch?.zoom, 1, 4, base.zoom),
    offsetX: clampNumeric(patch?.offsetX, -1, 1, base.offsetX),
    offsetY: clampNumeric(patch?.offsetY, -1, 1, base.offsetY),
  });
}

function normalizeText(value: string | undefined, maximum: number): string {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/gu, " ").slice(0, maximum);
}

function normalizeTextAlign(value: unknown, fallback: ThumbnailTextAlign): ThumbnailTextAlign {
  return value === "left" || value === "center" || value === "right" ? value : fallback;
}

function normalizeTextOverlay(
  patch: Partial<ThumbnailTextOverlay> | undefined,
  base: ThumbnailTextOverlay = DEFAULT_TEXT_OVERLAY,
): ThumbnailTextOverlay {
  return Object.freeze({
    text: patch?.text === undefined ? base.text : normalizeText(patch.text, 120),
    x: clampNumeric(patch?.x, 0, 1, base.x),
    y: clampNumeric(patch?.y, 0, 1, base.y),
    fontSize: Math.round(clampNumeric(patch?.fontSize, 12, 180, base.fontSize)),
    color: normalizeColor(patch?.color, base.color),
    shadow: clampNumeric(patch?.shadow, 0, 100, base.shadow),
    glow: clampNumeric(patch?.glow, 0, 100, base.glow),
    shadowColor: normalizeColor(patch?.shadowColor, base.shadowColor),
    glowColor: normalizeColor(patch?.glowColor, base.glowColor),
    align: normalizeTextAlign(patch?.align, base.align),
    maxWidthRatio: clampNumeric(patch?.maxWidthRatio, 0.2, 1, base.maxWidthRatio),
  });
}

function normalizeBadgeOverlay(
  patch: Partial<ThumbnailBadgeOverlay> | undefined,
  base: ThumbnailBadgeOverlay = DEFAULT_BADGE_OVERLAY,
): ThumbnailBadgeOverlay {
  return Object.freeze({
    text: patch?.text === undefined ? base.text : normalizeText(patch.text, 60),
    x: clampNumeric(patch?.x, 0, 1, base.x),
    y: clampNumeric(patch?.y, 0, 1, base.y),
    fontSize: Math.round(clampNumeric(patch?.fontSize, 10, 96, base.fontSize)),
    color: normalizeColor(patch?.color, base.color),
    backgroundColor: normalizeColor(patch?.backgroundColor, base.backgroundColor),
    paddingX: Math.round(clampNumeric(patch?.paddingX, 0, 80, base.paddingX)),
    paddingY: Math.round(clampNumeric(patch?.paddingY, 0, 48, base.paddingY)),
    radius: Math.round(clampNumeric(patch?.radius, 0, 48, base.radius)),
    visible: typeof patch?.visible === "boolean" ? patch.visible : base.visible,
  });
}

function normalizeLayerId(value: string | undefined): string {
  const normalized = value
    ?.trim()
    .replace(/[^a-z0-9._-]+/giu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalized || "layer";
}

function uniqueLayerId(preferred: string | undefined, usedIds: ReadonlySet<string>): string {
  const base = normalizeLayerId(preferred);
  if (!usedIds.has(base)) return base;

  let suffix = 2;
  while (usedIds.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function normalizeLayer(
  input: ThumbnailLayerInput | string,
  usedIds: ReadonlySet<string>,
): ThumbnailLayer {
  const source = typeof input === "string" ? input : input.source;
  if (typeof source !== "string" || source.trim().length === 0) {
    throw new TypeError("썸네일 레이어의 source는 비어 있지 않은 문자열이어야 합니다.");
  }

  const preferredId = typeof input === "string" ? undefined : input.id;
  const id = uniqueLayerId(preferredId, usedIds);
  return Object.freeze({
    id,
    source: source.trim(),
    adjustments: normalizeAdjustments(
      typeof input === "string" ? undefined : input.adjustments,
    ),
    overlay: normalizeOverlay(typeof input === "string" ? undefined : input.overlay),
    transform: normalizeTransform(typeof input === "string" ? undefined : input.transform),
  });
}

function freezeState(state: ThumbnailState): ThumbnailState {
  return Object.freeze({
    ...state,
    layers: Object.freeze([...state.layers]),
  });
}

export function createThumbnailState(
  options: CreateThumbnailStateOptions = {},
): ThumbnailState {
  const inputs = options.layers ?? [];
  if (inputs.length > MAX_LAYERS) {
    throw new RangeError(`썸네일 레이어는 최대 ${MAX_LAYERS}개까지 추가할 수 있습니다.`);
  }

  const layers: ThumbnailLayer[] = [];
  const usedIds = new Set<string>();
  for (const input of inputs) {
    const layer = normalizeLayer(input, usedIds);
    layers.push(layer);
    usedIds.add(layer.id);
  }

  let layout = isLayoutId(options.layout)
    ? options.layout
    : defaultLayoutForCount(layers.length);
  if (layoutDefinition(layout).count < layers.length) {
    layout = defaultLayoutForCount(layers.length);
  }

  const requestedSelection = options.selectedLayerId;
  const selectedLayerId =
    requestedSelection === null
      ? null
      : layers.some((layer) => layer.id === requestedSelection)
        ? (requestedSelection ?? null)
        : (layers[0]?.id ?? null);

  return freezeState({
    width: normalizeDimension(options.width, DEFAULT_WIDTH),
    height: normalizeDimension(options.height, DEFAULT_HEIGHT),
    layout,
    layers,
    selectedLayerId,
    backgroundColor: normalizeColor(options.backgroundColor, "#111111"),
    textOverlay: normalizeTextOverlay(options.textOverlay),
    badgeOverlay: normalizeBadgeOverlay(options.badgeOverlay),
  });
}

export function setLayout(
  state: ThumbnailState,
  layout: ThumbnailLayoutId,
): ThumbnailState {
  if (!isLayoutId(layout)) {
    throw new RangeError(`지원하지 않는 썸네일 레이아웃입니다: ${String(layout)}`);
  }
  if (layoutDefinition(layout).count < state.layers.length) {
    throw new RangeError("선택한 레이아웃보다 현재 레이어 수가 많습니다.");
  }
  if (state.layout === layout) return state;
  return freezeState({ ...state, layout });
}

export function addLayer(
  state: ThumbnailState,
  input: ThumbnailLayerInput | string,
): ThumbnailState {
  if (state.layers.length >= MAX_LAYERS) {
    throw new RangeError(`썸네일 레이어는 최대 ${MAX_LAYERS}개까지 추가할 수 있습니다.`);
  }

  const usedIds = new Set(state.layers.map((layer) => layer.id));
  const layer = normalizeLayer(input, usedIds);
  const layers = [...state.layers, layer];
  const currentCapacity = layoutDefinition(state.layout).count;
  const layout =
    layers.length > currentCapacity ? defaultLayoutForCount(layers.length) : state.layout;

  return freezeState({ ...state, layers, layout, selectedLayerId: layer.id });
}

export function removeLayer(
  state: ThumbnailState,
  layerIdOrIndex: string | number,
): ThumbnailState {
  const index =
    typeof layerIdOrIndex === "number"
      ? layerIdOrIndex
      : state.layers.findIndex((layer) => layer.id === layerIdOrIndex);
  if (!Number.isInteger(index) || index < 0 || index >= state.layers.length) return state;

  const removed = state.layers[index];
  const layers = state.layers.filter((_layer, layerIndex) => layerIndex !== index);
  const selectedLayerId =
    removed?.id !== state.selectedLayerId
      ? state.selectedLayerId
      : (layers[Math.min(index, layers.length - 1)]?.id ?? null);
  const layout =
    layers.length === 0 || layoutDefinition(state.layout).count !== layers.length
      ? defaultLayoutForCount(layers.length)
      : state.layout;

  return freezeState({ ...state, layers, selectedLayerId, layout });
}

export function reorderLayers(
  state: ThumbnailState,
  fromIndex: number,
  toIndex: number,
): ThumbnailState {
  if (
    !Number.isInteger(fromIndex) ||
    !Number.isInteger(toIndex) ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= state.layers.length ||
    toIndex >= state.layers.length
  ) {
    throw new RangeError("레이어 순서 인덱스가 범위를 벗어났습니다.");
  }
  if (fromIndex === toIndex) return state;

  const layers = [...state.layers];
  const [moved] = layers.splice(fromIndex, 1);
  if (!moved) return state;
  layers.splice(toIndex, 0, moved);
  return freezeState({ ...state, layers });
}

export function updateAdjustments(
  state: ThumbnailState,
  patch: Partial<ThumbnailAdjustments>,
): ThumbnailState;
export function updateAdjustments(
  state: ThumbnailState,
  layerId: string,
  patch: Partial<ThumbnailAdjustments>,
): ThumbnailState;
export function updateAdjustments(
  state: ThumbnailState,
  layerIdOrPatch: string | Partial<ThumbnailAdjustments>,
  explicitPatch?: Partial<ThumbnailAdjustments>,
): ThumbnailState {
  const layerId =
    typeof layerIdOrPatch === "string" ? layerIdOrPatch : state.selectedLayerId;
  const patch = typeof layerIdOrPatch === "string" ? explicitPatch : layerIdOrPatch;
  if (!layerId || !patch) return state;

  let changed = false;
  const layers = state.layers.map((layer) => {
    if (layer.id !== layerId) return layer;
    const adjustments = normalizeAdjustments(patch, layer.adjustments);
    if (
      adjustments.brightness === layer.adjustments.brightness &&
      adjustments.contrast === layer.adjustments.contrast &&
      adjustments.saturation === layer.adjustments.saturation
    ) {
      return layer;
    }
    changed = true;
    return Object.freeze({ ...layer, adjustments });
  });

  return changed ? freezeState({ ...state, layers }) : state;
}

export function updateOverlay(
  state: ThumbnailState,
  patch: Partial<ThumbnailOverlay>,
): ThumbnailState;
export function updateOverlay(
  state: ThumbnailState,
  layerId: string,
  patch: Partial<ThumbnailOverlay>,
): ThumbnailState;
export function updateOverlay(
  state: ThumbnailState,
  layerIdOrPatch: string | Partial<ThumbnailOverlay>,
  explicitPatch?: Partial<ThumbnailOverlay>,
): ThumbnailState {
  const layerId =
    typeof layerIdOrPatch === "string" ? layerIdOrPatch : state.selectedLayerId;
  const patch = typeof layerIdOrPatch === "string" ? explicitPatch : layerIdOrPatch;
  if (!layerId || !patch) return state;

  let changed = false;
  const layers = state.layers.map((layer) => {
    if (layer.id !== layerId) return layer;
    const overlay = normalizeOverlay(patch, layer.overlay);
    if (
      overlay.shadow === layer.overlay.shadow &&
      overlay.glow === layer.overlay.glow &&
      overlay.color === layer.overlay.color &&
      overlay.shadowColor === layer.overlay.shadowColor &&
      overlay.glowColor === layer.overlay.glowColor
    ) {
      return layer;
    }
    changed = true;
    return Object.freeze({ ...layer, overlay });
  });

  return changed ? freezeState({ ...state, layers }) : state;
}

export function updateTransform(
  state: ThumbnailState,
  patch: Partial<ThumbnailTransform>,
): ThumbnailState;
export function updateTransform(
  state: ThumbnailState,
  layerId: string,
  patch: Partial<ThumbnailTransform>,
): ThumbnailState;
export function updateTransform(
  state: ThumbnailState,
  layerIdOrPatch: string | Partial<ThumbnailTransform>,
  explicitPatch?: Partial<ThumbnailTransform>,
): ThumbnailState {
  const layerId =
    typeof layerIdOrPatch === "string" ? layerIdOrPatch : state.selectedLayerId;
  const patch = typeof layerIdOrPatch === "string" ? explicitPatch : layerIdOrPatch;
  if (!layerId || !patch) return state;

  let changed = false;
  const layers = state.layers.map((layer) => {
    if (layer.id !== layerId) return layer;
    const transform = normalizeTransform(patch, layer.transform);
    if (
      transform.zoom === layer.transform.zoom &&
      transform.offsetX === layer.transform.offsetX &&
      transform.offsetY === layer.transform.offsetY
    ) {
      return layer;
    }
    changed = true;
    return Object.freeze({ ...layer, transform });
  });

  return changed ? freezeState({ ...state, layers }) : state;
}

export function updateTextOverlay(
  state: ThumbnailState,
  patch: Partial<ThumbnailTextOverlay>,
): ThumbnailState {
  const textOverlay = normalizeTextOverlay(patch, state.textOverlay);
  if (
    textOverlay.text === state.textOverlay.text &&
    textOverlay.x === state.textOverlay.x &&
    textOverlay.y === state.textOverlay.y &&
    textOverlay.fontSize === state.textOverlay.fontSize &&
    textOverlay.color === state.textOverlay.color &&
    textOverlay.shadow === state.textOverlay.shadow &&
    textOverlay.glow === state.textOverlay.glow &&
    textOverlay.shadowColor === state.textOverlay.shadowColor &&
    textOverlay.glowColor === state.textOverlay.glowColor &&
    textOverlay.align === state.textOverlay.align &&
    textOverlay.maxWidthRatio === state.textOverlay.maxWidthRatio
  ) {
    return state;
  }
  return freezeState({ ...state, textOverlay });
}

export function updateBadgeOverlay(
  state: ThumbnailState,
  patch: Partial<ThumbnailBadgeOverlay>,
): ThumbnailState {
  const badgeOverlay = normalizeBadgeOverlay(patch, state.badgeOverlay);
  if (
    badgeOverlay.text === state.badgeOverlay.text &&
    badgeOverlay.x === state.badgeOverlay.x &&
    badgeOverlay.y === state.badgeOverlay.y &&
    badgeOverlay.fontSize === state.badgeOverlay.fontSize &&
    badgeOverlay.color === state.badgeOverlay.color &&
    badgeOverlay.backgroundColor === state.badgeOverlay.backgroundColor &&
    badgeOverlay.paddingX === state.badgeOverlay.paddingX &&
    badgeOverlay.paddingY === state.badgeOverlay.paddingY &&
    badgeOverlay.radius === state.badgeOverlay.radius &&
    badgeOverlay.visible === state.badgeOverlay.visible
  ) {
    return state;
  }
  return freezeState({ ...state, badgeOverlay });
}

function rect(x: number, y: number, width: number, height: number): LayoutRect {
  return Object.freeze({ x, y, width, height });
}

export function calculateLayoutRects(
  width: number,
  height: number,
  count: number,
  requestedLayout: ThumbnailLayoutId,
): readonly LayoutRect[] {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return Object.freeze([]);
  }

  const normalizedWidth = Math.max(1, Math.floor(width));
  const normalizedHeight = Math.max(1, Math.floor(height));
  const normalizedCount = Number.isFinite(count)
    ? Math.min(MAX_LAYERS, Math.max(0, Math.floor(count)))
    : 0;
  if (normalizedCount === 0) return Object.freeze([]);

  let layout = isLayoutId(requestedLayout)
    ? requestedLayout
    : defaultLayoutForCount(normalizedCount);
  if (layoutDefinition(layout).count < normalizedCount) {
    layout = defaultLayoutForCount(normalizedCount);
  }

  const halfWidth = Math.floor(normalizedWidth / 2);
  const remainingWidth = normalizedWidth - halfWidth;
  const halfHeight = Math.floor(normalizedHeight / 2);
  const remainingHeight = normalizedHeight - halfHeight;
  const heroWidth = Math.floor((normalizedWidth * 2) / 3);
  const sideWidth = normalizedWidth - heroWidth;
  const heroHeight = Math.floor((normalizedHeight * 2) / 3);
  const bottomHeight = normalizedHeight - heroHeight;

  let rectangles: readonly LayoutRect[];
  switch (layout) {
    case "full":
      rectangles = [rect(0, 0, normalizedWidth, normalizedHeight)];
      break;
    case "vertical":
      rectangles = [
        rect(0, 0, halfWidth, normalizedHeight),
        rect(halfWidth, 0, remainingWidth, normalizedHeight),
      ];
      break;
    case "horizontal":
      rectangles = [
        rect(0, 0, normalizedWidth, halfHeight),
        rect(0, halfHeight, normalizedWidth, remainingHeight),
      ];
      break;
    case "hero-left":
      rectangles = [
        rect(0, 0, heroWidth, normalizedHeight),
        rect(heroWidth, 0, sideWidth, halfHeight),
        rect(heroWidth, halfHeight, sideWidth, remainingHeight),
      ];
      break;
    case "hero-top":
      rectangles = [
        rect(0, 0, normalizedWidth, heroHeight),
        rect(0, heroHeight, halfWidth, bottomHeight),
        rect(halfWidth, heroHeight, remainingWidth, bottomHeight),
      ];
      break;
    case "grid":
      rectangles = [
        rect(0, 0, halfWidth, halfHeight),
        rect(halfWidth, 0, remainingWidth, halfHeight),
        rect(0, halfHeight, halfWidth, remainingHeight),
        rect(halfWidth, halfHeight, remainingWidth, remainingHeight),
      ];
      break;
  }

  return Object.freeze(rectangles.slice(0, normalizedCount));
}

export function buildCssFilter(
  adjustments: Partial<ThumbnailAdjustments> = {},
): string {
  const normalized = normalizeAdjustments(adjustments);
  return [
    `brightness(${formatCssNumber(normalized.brightness)}%)`,
    `contrast(${formatCssNumber(normalized.contrast)}%)`,
    `saturate(${formatCssNumber(normalized.saturation)}%)`,
  ].join(" ");
}

function positiveImageDimension(...values: (number | undefined)[]): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return 0;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "\"": return "&quot;";
      case "'": return "&apos;";
      default: return character;
    }
  });
}

function svgNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return formatCssNumber(Math.round(value * 1000) / 1000);
}

function svgId(prefix: string, index: number): string {
  return `shortflow-${prefix}-${index}`;
}

function safeSvgHref(value: string): string {
  const trimmed = value.trim();
  const isDataImage = /^data:image\/(?:png|jpe?g|webp|gif|svg\+xml);/iu.test(trimmed);
  if (
    trimmed.length === 0 ||
    trimmed.length > (isDataImage ? 70_000_000 : 32_768) ||
    /[\u0000-\u001f\u007f]/u.test(trimmed)
  ) {
    throw new Error("SVG 이미지 경로가 유효하지 않습니다.");
  }
  if (/^(?:javascript|vbscript):/iu.test(trimmed)) {
    throw new Error("SVG 이미지 경로에 실행 가능한 scheme을 사용할 수 없습니다.");
  }
  if (/^data:/iu.test(trimmed) && !/^data:image\/(?:png|jpe?g|webp|gif|svg\+xml);/iu.test(trimmed)) {
    throw new Error("SVG에는 이미지 data URL만 포함할 수 있습니다.");
  }
  return trimmed;
}

function base64Encode(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const combined = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    output += alphabet[(combined >> 18) & 63] ?? "";
    output += alphabet[(combined >> 12) & 63] ?? "";
    output += second === undefined ? "=" : (alphabet[(combined >> 6) & 63] ?? "");
    output += third === undefined ? "=" : (alphabet[combined & 63] ?? "");
  }
  return output;
}

export function inferThumbnailImageMime(
  name: string,
  bytes?: Uint8Array,
): ThumbnailImageMimeType {
  const lower = name.trim().toLowerCase();
  if (/\.(?:jpe?g)$/u.test(lower)) return "image/jpeg";
  if (/\.webp$/u.test(lower)) return "image/webp";
  if (/\.gif$/u.test(lower)) return "image/gif";
  if (/\.svg$/u.test(lower)) return "image/svg+xml";
  if (/\.png$/u.test(lower)) return "image/png";
  if (bytes) {
    if (
      bytes.length >= 4 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47
    ) return "image/png";
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (
      bytes.length >= 12 &&
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    ) return "image/webp";
    if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  }
  return "image/png";
}

export function thumbnailBytesToDataUrl(
  bytes: Uint8Array,
  mimeType: ThumbnailImageMimeType = "image/png",
): string {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new Error("SVG fallback에 포함할 이미지 데이터가 비어 있습니다.");
  }
  return `data:${mimeType};base64,${base64Encode(bytes)}`;
}

function textAnchor(align: ThumbnailTextAlign): "start" | "middle" | "end" {
  if (align === "left") return "start";
  if (align === "right") return "end";
  return "middle";
}

function svgDropShadow(
  id: string,
  blur: number,
  color: string,
  offsetY: number,
): string {
  const deviation = Math.max(0.1, blur / 2.5);
  return [
    `<filter id="${id}" x="-25%" y="-25%" width="150%" height="150%">`,
    `<feDropShadow dx="0" dy="${svgNumber(offsetY)}" stdDeviation="${svgNumber(deviation)}" flood-color="${escapeXml(color)}" flood-opacity="0.9"/>`,
    "</filter>",
  ].join("");
}

function badgeWidth(overlay: ThumbnailBadgeOverlay): number {
  return Math.ceil((overlay.text.length * overlay.fontSize * 0.62) + overlay.paddingX * 2);
}

/**
 * Canvas API가 제한된 Premiere UXP Host에서 사용할 수 있는 순수 SVG fallback 렌더러입니다.
 * PNG/JPG 파일을 직접 생성하지는 않지만, 동일한 썸네일 상태를 외부/후속 rasterizer로 넘길 수 있는
 * deterministic 중간 산출물을 만듭니다.
 */
export function renderThumbnailSvg(
  state: ThumbnailState,
  options: ThumbnailSvgOptions = {},
): string {
  const title = (options.title ?? "ShortFlow thumbnail").trim() || "ShortFlow thumbnail";
  const resolveImageHref = options.resolveImageHref ?? ((source: string) => source);
  const rectangles = calculateLayoutRects(
    state.width,
    state.height,
    state.layers.length,
    state.layout,
  );

  const definitions: string[] = [];
  const body: string[] = [];
  body.push(`<rect width="100%" height="100%" fill="${escapeXml(state.backgroundColor)}"/>`);

  for (let index = 0; index < state.layers.length; index += 1) {
    const layer = state.layers[index];
    const target = rectangles[index];
    if (!layer || !target) continue;

    const clipId = svgId("clip", index);
    definitions.push(
      `<clipPath id="${clipId}"><rect x="${svgNumber(target.x)}" y="${svgNumber(target.y)}" width="${svgNumber(target.width)}" height="${svgNumber(target.height)}"/></clipPath>`,
    );

    const href = safeSvgHref(resolveImageHref(layer.source, layer));
    const centerX = target.x + target.width / 2;
    const centerY = target.y + target.height / 2;
    const translateX = layer.transform.offsetX * target.width * 0.18;
    const translateY = layer.transform.offsetY * target.height * 0.18;
    body.push([
      `<g clip-path="url(#${clipId})">`,
      `<image href="${escapeXml(href)}" x="${svgNumber(target.x)}" y="${svgNumber(target.y)}" width="${svgNumber(target.width)}" height="${svgNumber(target.height)}" preserveAspectRatio="xMidYMid slice" filter="${escapeXml(buildCssFilter(layer.adjustments))}" transform="translate(${svgNumber(centerX)} ${svgNumber(centerY)}) translate(${svgNumber(translateX)} ${svgNumber(translateY)}) scale(${svgNumber(layer.transform.zoom)}) translate(${svgNumber(-centerX)} ${svgNumber(-centerY)})"/>`,
      "</g>",
    ].join(""));

    if (layer.overlay.shadow > 0 || layer.overlay.glow > 0) {
      const filterId = svgId("layer-filter", index);
      const blur = Math.max(layer.overlay.shadow, layer.overlay.glow);
      const color = layer.overlay.glow > 0 ? layer.overlay.glowColor : layer.overlay.shadowColor;
      const offsetY = layer.overlay.shadow > 0 ? Math.max(1, layer.overlay.shadow / 4) : 0;
      definitions.push(svgDropShadow(filterId, blur, color, offsetY));
      body.push(`<rect x="${svgNumber(target.x + 1)}" y="${svgNumber(target.y + 1)}" width="${svgNumber(Math.max(0, target.width - 2))}" height="${svgNumber(Math.max(0, target.height - 2))}" fill="none" stroke="${escapeXml(color)}" stroke-width="2" opacity="0.88" filter="url(#${filterId})"/>`);
    }
  }

  const badge = state.badgeOverlay;
  if (badge.visible && badge.text.length > 0) {
    const x = Math.round(badge.x * state.width);
    const y = Math.round(badge.y * state.height);
    const width = badgeWidth(badge);
    const height = Math.ceil(badge.fontSize + badge.paddingY * 2);
    body.push(`<rect x="${svgNumber(x)}" y="${svgNumber(y)}" width="${svgNumber(width)}" height="${svgNumber(height)}" rx="${svgNumber(badge.radius)}" fill="${escapeXml(badge.backgroundColor)}"/>`);
    body.push(`<text x="${svgNumber(x + badge.paddingX)}" y="${svgNumber(y + height / 2)}" fill="${escapeXml(badge.color)}" font-family="sans-serif" font-size="${svgNumber(badge.fontSize)}" font-weight="700" dominant-baseline="middle">${escapeXml(badge.text)}</text>`);
  }

  const text = state.textOverlay;
  if (text.text.length > 0) {
    const filters: string[] = [];
    if (text.shadow > 0) {
      const id = "shortflow-title-shadow";
      definitions.push(svgDropShadow(id, text.shadow, text.shadowColor, Math.max(1, text.shadow / 5)));
      filters.push(`url(#${id})`);
    }
    if (text.glow > 0) {
      const id = "shortflow-title-glow";
      definitions.push(svgDropShadow(id, text.glow, text.glowColor, 0));
      filters.push(`url(#${id})`);
    }
    const filterAttribute = filters.length > 0 ? ` filter="${filters.join(" ")}"` : "";
    body.push(`<text x="${svgNumber(text.x * state.width)}" y="${svgNumber(text.y * state.height)}" fill="${escapeXml(text.color)}" font-family="sans-serif" font-size="${svgNumber(text.fontSize)}" font-weight="700" text-anchor="${textAnchor(text.align)}" dominant-baseline="middle"${filterAttribute}>${escapeXml(text.text)}</text>`);
  }

  const defs = definitions.length > 0 ? `<defs>${definitions.join("")}</defs>` : "";
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgNumber(state.width)}" height="${svgNumber(state.height)}" viewBox="0 0 ${svgNumber(state.width)} ${svgNumber(state.height)}" role="img" aria-label="${escapeXml(title)}">`,
    `<title>${escapeXml(title)}</title>`,
    defs,
    body.join(""),
    "</svg>",
  ].join("");
}

function applyClip(ctx: CanvasContextLike, target: LayoutRect): void {
  if (ctx.beginPath && ctx.rect && ctx.clip) {
    ctx.beginPath();
    ctx.rect(target.x, target.y, target.width, target.height);
    ctx.clip();
  }
}

function resetTransientCanvasState(ctx: CanvasContextLike): void {
  if ("filter" in ctx) ctx.filter = "none";
  if ("globalAlpha" in ctx) ctx.globalAlpha = 1;
  if ("shadowBlur" in ctx) ctx.shadowBlur = 0;
  if ("shadowColor" in ctx) ctx.shadowColor = "rgba(0, 0, 0, 0)";
  if ("shadowOffsetX" in ctx) ctx.shadowOffsetX = 0;
  if ("shadowOffsetY" in ctx) ctx.shadowOffsetY = 0;
}

function drawTextOverlay(
  ctx: CanvasContextLike,
  state: ThumbnailState,
  overlay: ThumbnailTextOverlay,
): void {
  if (!ctx.fillText || overlay.text.length === 0) return;
  const x = overlay.x * state.width;
  const y = overlay.y * state.height;
  const maxWidth = Math.max(1, state.width * overlay.maxWidthRatio);
  if ("font" in ctx) ctx.font = `700 ${overlay.fontSize}px sans-serif`;
  if ("textAlign" in ctx) ctx.textAlign = overlay.align;
  if ("textBaseline" in ctx) ctx.textBaseline = "middle";
  if ("fillStyle" in ctx) ctx.fillStyle = overlay.color;

  if (overlay.shadow > 0) {
    if ("shadowColor" in ctx) ctx.shadowColor = overlay.shadowColor;
    if ("shadowBlur" in ctx) ctx.shadowBlur = overlay.shadow;
    if ("shadowOffsetX" in ctx) ctx.shadowOffsetX = 0;
    if ("shadowOffsetY" in ctx) ctx.shadowOffsetY = Math.max(1, overlay.shadow / 5);
  } else if (overlay.glow > 0) {
    if ("shadowColor" in ctx) ctx.shadowColor = overlay.glowColor;
    if ("shadowBlur" in ctx) ctx.shadowBlur = overlay.glow;
    if ("shadowOffsetX" in ctx) ctx.shadowOffsetX = 0;
    if ("shadowOffsetY" in ctx) ctx.shadowOffsetY = 0;
  }
  ctx.fillText(overlay.text, x, y, maxWidth);
  resetTransientCanvasState(ctx);
}

function drawBadgeOverlay(
  ctx: CanvasContextLike,
  state: ThumbnailState,
  overlay: ThumbnailBadgeOverlay,
): void {
  if (!ctx.fillText || !ctx.fillRect || !overlay.visible || overlay.text.length === 0) return;
  if ("font" in ctx) ctx.font = `700 ${overlay.fontSize}px sans-serif`;
  if ("textAlign" in ctx) ctx.textAlign = "left";
  if ("textBaseline" in ctx) ctx.textBaseline = "middle";

  const measured = ctx.measureText?.(overlay.text).width;
  const textWidth = Number.isFinite(measured) && measured !== undefined
    ? measured
    : overlay.text.length * overlay.fontSize * 0.62;
  const width = Math.ceil(textWidth + overlay.paddingX * 2);
  const height = Math.ceil(overlay.fontSize + overlay.paddingY * 2);
  const x = Math.round(overlay.x * state.width);
  const y = Math.round(overlay.y * state.height);

  if ("fillStyle" in ctx) ctx.fillStyle = overlay.backgroundColor;
  ctx.fillRect(x, y, width, height);
  if ("fillStyle" in ctx) ctx.fillStyle = overlay.color;
  ctx.fillText(
    overlay.text,
    x + overlay.paddingX,
    y + height / 2,
    Math.max(1, width - overlay.paddingX * 2),
  );
  resetTransientCanvasState(ctx);
}

function drawCoverImage(
  ctx: CanvasContextLike,
  image: CanvasImageLike,
  target: LayoutRect,
  layer: ThumbnailLayer,
): void {
  const imageWidth = positiveImageDimension(
    image.naturalWidth,
    image.videoWidth,
    image.width,
  );
  const imageHeight = positiveImageDimension(
    image.naturalHeight,
    image.videoHeight,
    image.height,
  );
  if (imageWidth === 0 || imageHeight === 0) {
    throw new Error(`레이어 "${layer.id}" 이미지의 크기를 확인할 수 없습니다.`);
  }

  const sourceRatio = imageWidth / imageHeight;
  const targetRatio = target.width / target.height;
  let sourceX = 0;
  let sourceY = 0;
  let sourceWidth = imageWidth;
  let sourceHeight = imageHeight;

  if (sourceRatio > targetRatio) {
    sourceWidth = imageHeight * targetRatio;
    sourceX = (imageWidth - sourceWidth) / 2;
  } else if (sourceRatio < targetRatio) {
    sourceHeight = imageWidth / targetRatio;
    sourceY = (imageHeight - sourceHeight) / 2;
  }

  const zoomedWidth = sourceWidth / layer.transform.zoom;
  const zoomedHeight = sourceHeight / layer.transform.zoom;
  const maxShiftX = Math.max(0, (sourceWidth - zoomedWidth) / 2);
  const maxShiftY = Math.max(0, (sourceHeight - zoomedHeight) / 2);
  const centerX = sourceX + sourceWidth / 2 + layer.transform.offsetX * maxShiftX;
  const centerY = sourceY + sourceHeight / 2 + layer.transform.offsetY * maxShiftY;
  sourceWidth = zoomedWidth;
  sourceHeight = zoomedHeight;
  sourceX = Math.min(
    imageWidth - sourceWidth,
    Math.max(0, centerX - sourceWidth / 2),
  );
  sourceY = Math.min(
    imageHeight - sourceHeight,
    Math.max(0, centerY - sourceHeight / 2),
  );

  if ("filter" in ctx) ctx.filter = buildCssFilter(layer.adjustments);
  if ("imageSmoothingEnabled" in ctx) ctx.imageSmoothingEnabled = true;
  if ("imageSmoothingQuality" in ctx) ctx.imageSmoothingQuality = "high";
  applyClip(ctx, target);
  ctx.drawImage(
    image,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    target.x,
    target.y,
    target.width,
    target.height,
  );
}

function drawLayerOverlay(
  ctx: CanvasContextLike,
  target: LayoutRect,
  overlay: ThumbnailOverlay,
): void {
  if (!ctx.strokeRect || (overlay.shadow <= 0 && overlay.glow <= 0)) return;
  const inset = 1;
  const width = Math.max(0, target.width - inset * 2);
  const height = Math.max(0, target.height - inset * 2);

  if (overlay.shadow > 0) {
    if ("shadowColor" in ctx) ctx.shadowColor = overlay.shadowColor;
    if ("shadowBlur" in ctx) ctx.shadowBlur = overlay.shadow;
    if ("shadowOffsetX" in ctx) ctx.shadowOffsetX = 0;
    if ("shadowOffsetY" in ctx) ctx.shadowOffsetY = Math.max(1, overlay.shadow / 4);
    if ("strokeStyle" in ctx) ctx.strokeStyle = "rgba(0, 0, 0, 0.02)";
    if ("lineWidth" in ctx) ctx.lineWidth = 2;
    ctx.strokeRect(target.x + inset, target.y + inset, width, height);
    resetTransientCanvasState(ctx);
  }

  if (overlay.glow > 0) {
    if ("shadowColor" in ctx) ctx.shadowColor = overlay.glowColor;
    if ("shadowBlur" in ctx) ctx.shadowBlur = overlay.glow;
    if ("strokeStyle" in ctx) ctx.strokeStyle = overlay.glowColor;
    if ("lineWidth" in ctx) ctx.lineWidth = 2;
    if ("globalAlpha" in ctx) ctx.globalAlpha = 0.88;
    ctx.strokeRect(target.x + inset, target.y + inset, width, height);
    resetTransientCanvasState(ctx);
  }
}

export async function renderThumbnail(
  ctx: CanvasContextLike,
  state: ThumbnailState,
  imageResolver: ThumbnailImageResolver,
): Promise<void> {
  if (!ctx || typeof ctx.drawImage !== "function") {
    throw new TypeError("유효한 2D Canvas 컨텍스트가 필요합니다.");
  }
  if (typeof imageResolver !== "function") {
    throw new TypeError("썸네일 이미지 resolver가 필요합니다.");
  }

  if (ctx.canvas) {
    if (ctx.canvas.width !== state.width) ctx.canvas.width = state.width;
    if (ctx.canvas.height !== state.height) ctx.canvas.height = state.height;
  }
  ctx.clearRect?.(0, 0, state.width, state.height);
  if (ctx.fillRect) {
    if ("fillStyle" in ctx) ctx.fillStyle = state.backgroundColor;
    ctx.fillRect(0, 0, state.width, state.height);
  }

  const rectangles = calculateLayoutRects(
    state.width,
    state.height,
    state.layers.length,
    state.layout,
  );

  for (let index = 0; index < state.layers.length; index += 1) {
    const layer = state.layers[index];
    const target = rectangles[index];
    if (!layer || !target) continue;

    const image = await imageResolver(layer.source, layer);
    if (!image) {
      throw new Error(`레이어 "${layer.id}"의 이미지를 불러오지 못했습니다.`);
    }

    const supportsSavedState = Boolean(ctx.save && ctx.restore);
    if (supportsSavedState) ctx.save?.();
    try {
      drawCoverImage(ctx, image, target, layer);
    } finally {
      resetTransientCanvasState(ctx);
      if (supportsSavedState) ctx.restore?.();
    }

    if (supportsSavedState) ctx.save?.();
    try {
      drawLayerOverlay(ctx, target, layer.overlay);
    } finally {
      resetTransientCanvasState(ctx);
      if (supportsSavedState) ctx.restore?.();
    }
  }

  const supportsSavedState = Boolean(ctx.save && ctx.restore);
  if (supportsSavedState) ctx.save?.();
  try {
    drawBadgeOverlay(ctx, state, state.badgeOverlay);
  } finally {
    resetTransientCanvasState(ctx);
    if (supportsSavedState) ctx.restore?.();
  }

  if (supportsSavedState) ctx.save?.();
  try {
    drawTextOverlay(ctx, state, state.textOverlay);
  } finally {
    resetTransientCanvasState(ctx);
    if (supportsSavedState) ctx.restore?.();
  }
}

function decodeBase64(base64: string): Uint8Array {
  const normalized = base64.replace(/\s+/gu, "");
  if (
    normalized.length === 0 ||
    normalized.length % 4 === 1 ||
    !/^[a-z0-9+/]*={0,2}$/iu.test(normalized)
  ) {
    throw new Error("PNG data URL의 Base64 데이터가 올바르지 않습니다.");
  }

  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const output: number[] = [];
  for (let index = 0; index < normalized.length; index += 4) {
    const first = alphabet.indexOf(normalized[index] ?? "");
    const second = alphabet.indexOf(normalized[index + 1] ?? "");
    const thirdCharacter = normalized[index + 2] ?? "=";
    const fourthCharacter = normalized[index + 3] ?? "=";
    const third = thirdCharacter === "=" ? 0 : alphabet.indexOf(thirdCharacter);
    const fourth = fourthCharacter === "=" ? 0 : alphabet.indexOf(fourthCharacter);
    if (first < 0 || second < 0 || third < 0 || fourth < 0) {
      throw new Error("PNG data URL의 Base64 데이터가 올바르지 않습니다.");
    }

    const combined = (first << 18) | (second << 12) | (third << 6) | fourth;
    output.push((combined >> 16) & 0xff);
    if (thirdCharacter !== "=") output.push((combined >> 8) & 0xff);
    if (fourthCharacter !== "=") output.push(combined & 0xff);
  }
  return Uint8Array.from(output);
}

function exportMimeType(format: ThumbnailExportFormat): string {
  return format === "jpg" ? "image/jpeg" : "image/png";
}

function exportLabel(format: ThumbnailExportFormat): string {
  return format === "jpg" ? "JPG" : "PNG";
}

function normalizeExportFormat(format: ThumbnailExportFormat): ThumbnailExportFormat {
  return format === "jpg" ? "jpg" : "png";
}

function bytesFromDataUrl(dataUrl: string, format: ThumbnailExportFormat): Uint8Array {
  const mime = format === "jpg" ? "jpe?g" : "png";
  const match = new RegExp(`^data:image/${mime};base64,([a-z0-9+/=\\s]+)$`, "iu").exec(dataUrl);
  if (!match?.[1]) {
    throw new Error(`Canvas가 유효한 ${exportLabel(format)} data URL을 반환하지 않았습니다.`);
  }
  return decodeBase64(match[1]);
}

async function bytesFromBlob(blob: CanvasBlobLike | Uint8Array): Promise<Uint8Array> {
  if (blob instanceof Uint8Array) return blob.slice();
  if (!blob || typeof blob.arrayBuffer !== "function") {
    throw new Error("Canvas Blob을 읽을 수 없습니다.");
  }
  return new Uint8Array(await blob.arrayBuffer());
}

function canvasBlob(canvas: PngCanvasLike, format: ThumbnailExportFormat): Promise<CanvasBlobLike> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob?.((blob) => {
        if (blob) resolve(blob);
        else reject(new Error(`Canvas가 빈 ${exportLabel(format)} Blob을 반환했습니다.`));
      }, exportMimeType(format), format === "jpg" ? 0.92 : undefined);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function assertImageBytes(bytes: Uint8Array, format: ThumbnailExportFormat): Uint8Array {
  if (bytes.byteLength === 0) throw new Error(`Canvas가 빈 ${exportLabel(format)} 데이터를 반환했습니다.`);
  return bytes;
}

export async function canvasToImageBytes(
  canvas: PngCanvasLike,
  requestedFormat: ThumbnailExportFormat = "png",
): Promise<Uint8Array> {
  const format = normalizeExportFormat(requestedFormat);
  if (!canvas || typeof canvas !== "object") {
    throw new TypeError(`${exportLabel(format)}로 변환할 Canvas가 필요합니다.`);
  }

  const failures: Error[] = [];
  if (typeof canvas.convertToBlob === "function") {
    try {
      const blob = await canvas.convertToBlob({
        type: exportMimeType(format),
        ...(format === "jpg" ? { quality: 0.92 } : {}),
      });
      return assertImageBytes(await bytesFromBlob(blob), format);
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }

  if (typeof canvas.toBlob === "function") {
    try {
      return assertImageBytes(await bytesFromBlob(await canvasBlob(canvas, format)), format);
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }

  if (typeof canvas.toDataURL === "function") {
    try {
      return assertImageBytes(bytesFromDataUrl(canvas.toDataURL(exportMimeType(format)), format), format);
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }

  const detail = failures[failures.length - 1]?.message;
  throw new Error(
    detail
      ? `Canvas ${exportLabel(format)} 변환에 실패했습니다: ${detail}`
      : `이 환경은 Canvas ${exportLabel(format)} 내보내기를 지원하지 않습니다.`,
  );
}

export async function canvasToPngBytes(canvas: PngCanvasLike): Promise<Uint8Array> {
  return canvasToImageBytes(canvas, "png");
}
