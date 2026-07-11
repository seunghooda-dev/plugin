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

export interface ThumbnailLayer {
  readonly id: string;
  readonly source: string;
  readonly adjustments: ThumbnailAdjustments;
  readonly overlay: ThumbnailOverlay;
}

export interface ThumbnailState {
  readonly width: number;
  readonly height: number;
  readonly layout: ThumbnailLayoutId;
  readonly layers: readonly ThumbnailLayer[];
  readonly selectedLayerId: string | null;
  readonly backgroundColor: string;
}

export interface ThumbnailLayerInput {
  readonly id?: string;
  readonly source: string;
  readonly adjustments?: Partial<ThumbnailAdjustments>;
  readonly overlay?: Partial<ThumbnailOverlay>;
}

export interface CreateThumbnailStateOptions {
  readonly width?: number;
  readonly height?: number;
  readonly layout?: ThumbnailLayoutId;
  readonly layers?: readonly (ThumbnailLayerInput | string)[];
  readonly selectedLayerId?: string | null;
  readonly backgroundColor?: string;
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
  convertToBlob?: (options?: { type?: string }) => Promise<CanvasBlobLike | Uint8Array>;
  toBlob?: (
    callback: (blob: CanvasBlobLike | null) => void,
    type?: string,
  ) => void;
  toDataURL?: (type?: string) => string;
}

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

function drawSelectedOverlay(
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

    if (layer.id === state.selectedLayerId) {
      if (supportsSavedState) ctx.save?.();
      try {
        drawSelectedOverlay(ctx, target, layer.overlay);
      } finally {
        resetTransientCanvasState(ctx);
        if (supportsSavedState) ctx.restore?.();
      }
    }
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

function bytesFromDataUrl(dataUrl: string): Uint8Array {
  const match = /^data:image\/png;base64,([a-z0-9+/=\s]+)$/iu.exec(dataUrl);
  if (!match?.[1]) {
    throw new Error("Canvas가 유효한 PNG data URL을 반환하지 않았습니다.");
  }
  return decodeBase64(match[1]);
}

async function bytesFromBlob(blob: CanvasBlobLike | Uint8Array): Promise<Uint8Array> {
  if (blob instanceof Uint8Array) return blob.slice();
  if (!blob || typeof blob.arrayBuffer !== "function") {
    throw new Error("Canvas PNG Blob을 읽을 수 없습니다.");
  }
  return new Uint8Array(await blob.arrayBuffer());
}

function canvasBlob(canvas: PngCanvasLike): Promise<CanvasBlobLike> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob?.((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Canvas가 빈 PNG Blob을 반환했습니다."));
      }, "image/png");
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function assertPngBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength === 0) throw new Error("Canvas가 빈 PNG 데이터를 반환했습니다.");
  return bytes;
}

export async function canvasToPngBytes(canvas: PngCanvasLike): Promise<Uint8Array> {
  if (!canvas || typeof canvas !== "object") {
    throw new TypeError("PNG로 변환할 Canvas가 필요합니다.");
  }

  const failures: Error[] = [];
  if (typeof canvas.convertToBlob === "function") {
    try {
      const blob = await canvas.convertToBlob({ type: "image/png" });
      return assertPngBytes(await bytesFromBlob(blob));
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }

  if (typeof canvas.toBlob === "function") {
    try {
      return assertPngBytes(await bytesFromBlob(await canvasBlob(canvas)));
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }

  if (typeof canvas.toDataURL === "function") {
    try {
      return assertPngBytes(bytesFromDataUrl(canvas.toDataURL("image/png")));
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }

  const detail = failures[failures.length - 1]?.message;
  throw new Error(
    detail
      ? `Canvas PNG 변환에 실패했습니다: ${detail}`
      : "이 환경은 Canvas PNG 내보내기를 지원하지 않습니다.",
  );
}
