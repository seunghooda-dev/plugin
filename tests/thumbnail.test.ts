import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  THUMBNAIL_LAYOUTS,
  addLayer,
  buildCssFilter,
  calculateLayoutRects,
  canvasToImageBytes,
  canvasToPngBytes,
  createThumbnailState,
  inferThumbnailImageMime,
  removeLayer,
  renderThumbnail,
  renderThumbnailSvg,
  reorderLayers,
  setLayout,
  thumbnailBytesToDataUrl,
  updateAdjustments,
  updateBadgeOverlay,
  updateOverlay,
  updateTextOverlay,
  updateTransform,
  type CanvasBlobLike,
  type CanvasContextLike,
  type ThumbnailLayoutId,
} from "../src/thumbnail";

type DrawCall = {
  image: unknown;
  args: readonly number[];
  filter: string;
};

type StrokeCall = {
  args: readonly number[];
  shadowBlur: number;
  shadowColor: string;
  strokeStyle: unknown;
};

type TextCall = {
  text: string;
  x: number;
  y: number;
  maxWidth?: number;
  fillStyle: unknown;
  font: string;
  textAlign: CanvasTextAlign;
  shadowBlur: number;
  shadowColor: string;
};

class MockContext implements CanvasContextLike {
  readonly canvas = { width: 10, height: 10 };
  filter = "none";
  fillStyle: unknown = "";
  strokeStyle: unknown = "";
  lineWidth = 1;
  globalAlpha = 1;
  shadowBlur = 0;
  shadowColor = "transparent";
  shadowOffsetX = 0;
  shadowOffsetY = 0;
  font = "";
  textAlign: CanvasTextAlign = "start";
  textBaseline: CanvasTextBaseline = "alphabetic";
  imageSmoothingEnabled = false;
  imageSmoothingQuality: "low" | "medium" | "high" = "low";
  readonly drawCalls: DrawCall[] = [];
  readonly strokeCalls: StrokeCall[] = [];
  readonly textCalls: TextCall[] = [];
  readonly clearCalls: number[][] = [];
  readonly fillCalls: number[][] = [];
  readonly clipRects: number[][] = [];
  saveCount = 0;
  restoreCount = 0;

  save(): void {
    this.saveCount += 1;
  }

  restore(): void {
    this.restoreCount += 1;
  }

  clearRect(x: number, y: number, width: number, height: number): void {
    this.clearCalls.push([x, y, width, height]);
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    this.fillCalls.push([x, y, width, height]);
  }

  beginPath(): void {}

  rect(x: number, y: number, width: number, height: number): void {
    this.clipRects.push([x, y, width, height]);
  }

  clip(): void {}

  strokeRect(x: number, y: number, width: number, height: number): void {
    this.strokeCalls.push({
      args: [x, y, width, height],
      shadowBlur: this.shadowBlur,
      shadowColor: this.shadowColor,
      strokeStyle: this.strokeStyle,
    });
  }

  measureText(text: string): { width: number } {
    return { width: text.length * 10 };
  }

  fillText(text: string, x: number, y: number, maxWidth?: number): void {
    const call: TextCall = {
      text,
      x,
      y,
      fillStyle: this.fillStyle,
      font: this.font,
      textAlign: this.textAlign,
      shadowBlur: this.shadowBlur,
      shadowColor: this.shadowColor,
    };
    if (maxWidth !== undefined) {
      this.textCalls.push({ ...call, maxWidth });
      return;
    }
    this.textCalls.push(call);
  }

  drawImage(
    image: unknown,
    sourceX: number,
    sourceY: number,
    sourceWidth: number,
    sourceHeight: number,
    destinationX: number,
    destinationY: number,
    destinationWidth: number,
    destinationHeight: number,
  ): void {
    this.drawCalls.push({
      image,
      args: [
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        destinationX,
        destinationY,
        destinationWidth,
        destinationHeight,
      ],
      filter: this.filter,
    });
  }
}

function layerSources(...sources: string[]) {
  return sources.map((source) => ({ id: source, source }));
}

function makeBlob(bytes: readonly number[]): CanvasBlobLike {
  return {
    async arrayBuffer(): Promise<ArrayBuffer> {
      const buffer = new ArrayBuffer(bytes.length);
      new Uint8Array(buffer).set(bytes);
      return buffer;
    },
  };
}

describe("THUMBNAIL_LAYOUTS", () => {
  it("publishes all six production layouts", () => {
    assert.deepEqual(
      THUMBNAIL_LAYOUTS.map((layout) => layout.id),
      ["full", "vertical", "horizontal", "hero-left", "hero-top", "grid"],
    );
  });

  it("maps layouts to their intended cell counts", () => {
    assert.deepEqual(
      THUMBNAIL_LAYOUTS.map((layout) => layout.count),
      [1, 2, 2, 3, 3, 4],
    );
  });

  it("exposes non-empty user-facing labels", () => {
    for (const layout of THUMBNAIL_LAYOUTS) {
      assert.ok(layout.label.trim().length > 0);
    }
  });

  it("prevents accidental mutation of layout metadata", () => {
    assert.ok(Object.isFrozen(THUMBNAIL_LAYOUTS));
    assert.ok(THUMBNAIL_LAYOUTS.every((layout) => Object.isFrozen(layout)));
  });
});

describe("thumbnail state", () => {
  it("creates an empty 1280x720 state by default", () => {
    const state = createThumbnailState();
    assert.equal(state.width, 1280);
    assert.equal(state.height, 720);
    assert.equal(state.layout, "full");
    assert.deepEqual(state.layers, []);
    assert.equal(state.selectedLayerId, null);
  });

  it("normalizes dimensions to safe Canvas bounds", () => {
    const state = createThumbnailState({
      width: Number.POSITIVE_INFINITY,
      height: 0.4,
    });
    assert.equal(state.width, 16_384);
    assert.equal(state.height, 16);

    const fallback = createThumbnailState({ width: Number.NaN, height: Number.NaN });
    assert.equal(fallback.width, 1280);
    assert.equal(fallback.height, 720);
  });

  it("creates normalized layers and selects the first one", () => {
    const state = createThumbnailState({
      layers: [{ id: " hero cell ", source: "  asset://hero  " }],
    });
    assert.equal(state.layers[0]?.id, "hero-cell");
    assert.equal(state.layers[0]?.source, "asset://hero");
    assert.equal(state.selectedLayerId, "hero-cell");
    assert.deepEqual(state.layers[0]?.adjustments, {
      brightness: 100,
      contrast: 100,
      saturation: 100,
    });
  });

  it("deduplicates caller-provided layer ids", () => {
    const state = createThumbnailState({
      layers: [
        { id: "shot", source: "a" },
        { id: "shot", source: "b" },
        { id: "shot", source: "c" },
      ],
    });
    assert.deepEqual(
      state.layers.map((layer) => layer.id),
      ["shot", "shot-2", "shot-3"],
    );
  });

  it("respects a valid requested selection", () => {
    const state = createThumbnailState({
      layers: layerSources("a", "b"),
      selectedLayerId: "b",
    });
    assert.equal(state.selectedLayerId, "b");
  });

  it("allows selection to be explicitly cleared", () => {
    const state = createThumbnailState({
      layers: layerSources("a"),
      selectedLayerId: null,
    });
    assert.equal(state.selectedLayerId, null);
  });

  it("falls back from a layout that cannot contain the initial layers", () => {
    const state = createThumbnailState({
      layout: "full",
      layers: layerSources("a", "b", "c"),
    });
    assert.equal(state.layout, "hero-left");
  });

  it("rejects empty sources and more than four initial layers", () => {
    assert.throws(
      () => createThumbnailState({ layers: [{ source: "  " }] }),
      TypeError,
    );
    assert.throws(
      () => createThumbnailState({ layers: layerSources("a", "b", "c", "d", "e") }),
      RangeError,
    );
  });

  it("freezes state and nested layer records", () => {
    const state = createThumbnailState({ layers: layerSources("a") });
    assert.ok(Object.isFrozen(state));
    assert.ok(Object.isFrozen(state.layers));
    assert.ok(Object.isFrozen(state.layers[0]));
    assert.ok(Object.isFrozen(state.layers[0]?.adjustments));
    assert.ok(Object.isFrozen(state.layers[0]?.overlay));
    assert.ok(Object.isFrozen(state.layers[0]?.transform));
    assert.ok(Object.isFrozen(state.textOverlay));
    assert.ok(Object.isFrozen(state.badgeOverlay));
  });

  it("sanitizes the background color", () => {
    assert.equal(createThumbnailState({ backgroundColor: " #ABC " }).backgroundColor, "#abc");
    assert.equal(
      createThumbnailState({ backgroundColor: "url(javascript:alert(1))" }).backgroundColor,
      "#111111",
    );
  });
});

describe("layout and layer reducers", () => {
  it("changes to a compatible layout without mutating the source state", () => {
    const before = createThumbnailState({ layers: layerSources("a", "b") });
    const after = setLayout(before, "horizontal");
    assert.equal(before.layout, "vertical");
    assert.equal(after.layout, "horizontal");
    assert.notEqual(after, before);
  });

  it("returns the same state when setting the active layout", () => {
    const state = createThumbnailState();
    assert.equal(setLayout(state, "full"), state);
  });

  it("rejects an undersized or unknown layout", () => {
    const state = createThumbnailState({ layers: layerSources("a", "b") });
    assert.throws(() => setLayout(state, "full"), RangeError);
    assert.throws(
      () => setLayout(state, "diagonal" as ThumbnailLayoutId),
      RangeError,
    );
  });

  it("adds a layer and selects it", () => {
    const before = createThumbnailState();
    const after = addLayer(before, { id: "hero", source: "asset://1" });
    assert.equal(before.layers.length, 0);
    assert.equal(after.layers.length, 1);
    assert.equal(after.selectedLayerId, "hero");
  });

  it("automatically expands the layout when a new layer needs another cell", () => {
    let state = addLayer(createThumbnailState(), { id: "a", source: "a" });
    state = addLayer(state, { id: "b", source: "b" });
    assert.equal(state.layout, "vertical");
    state = addLayer(state, { id: "c", source: "c" });
    assert.equal(state.layout, "hero-left");
    state = addLayer(state, { id: "d", source: "d" });
    assert.equal(state.layout, "grid");
  });

  it("preserves a larger explicitly selected layout while filling it", () => {
    let state = setLayout(createThumbnailState(), "grid");
    state = addLayer(state, "a");
    state = addLayer(state, "b");
    assert.equal(state.layout, "grid");
  });

  it("enforces the four-layer ceiling", () => {
    const state = createThumbnailState({ layers: layerSources("a", "b", "c", "d") });
    assert.throws(() => addLayer(state, "e"), /최대 4개/u);
    assert.equal(state.layers.length, 4);
  });

  it("removes a layer by id and selects its nearest neighbor", () => {
    const before = createThumbnailState({
      layers: layerSources("a", "b", "c"),
      selectedLayerId: "b",
    });
    const after = removeLayer(before, "b");
    assert.deepEqual(
      after.layers.map((layer) => layer.id),
      ["a", "c"],
    );
    assert.equal(after.selectedLayerId, "c");
    assert.equal(after.layout, "vertical");
  });

  it("removes a layer by index", () => {
    const state = createThumbnailState({ layers: layerSources("a", "b") });
    assert.deepEqual(
      removeLayer(state, 0).layers.map((layer) => layer.id),
      ["b"],
    );
  });

  it("ignores an unknown layer removal", () => {
    const state = createThumbnailState({ layers: layerSources("a") });
    assert.equal(removeLayer(state, "missing"), state);
    assert.equal(removeLayer(state, Number.NaN), state);
  });

  it("reorders layers immutably and preserves selection", () => {
    const before = createThumbnailState({
      layers: layerSources("a", "b", "c"),
      selectedLayerId: "b",
    });
    const after = reorderLayers(before, 0, 2);
    assert.deepEqual(
      after.layers.map((layer) => layer.id),
      ["b", "c", "a"],
    );
    assert.deepEqual(
      before.layers.map((layer) => layer.id),
      ["a", "b", "c"],
    );
    assert.equal(after.selectedLayerId, "b");
  });

  it("rejects invalid reorder indices and no-ops an identical index", () => {
    const state = createThumbnailState({ layers: layerSources("a", "b") });
    assert.throws(() => reorderLayers(state, -1, 0), RangeError);
    assert.throws(() => reorderLayers(state, 0, 2), RangeError);
    assert.throws(() => reorderLayers(state, 0.5, 1), RangeError);
    assert.equal(reorderLayers(state, 1, 1), state);
  });
});

describe("adjustments, overlay, and CSS filter", () => {
  it("updates the selected layer through the shorthand overload", () => {
    const before = createThumbnailState({ layers: layerSources("a") });
    const after = updateAdjustments(before, { brightness: 125.5 });
    assert.equal(after.layers[0]?.adjustments.brightness, 125.5);
    assert.equal(before.layers[0]?.adjustments.brightness, 100);
  });

  it("updates an explicit layer without touching its siblings", () => {
    const before = createThumbnailState({ layers: layerSources("a", "b") });
    const after = updateAdjustments(before, "b", { contrast: 75 });
    assert.equal(after.layers[0]?.adjustments.contrast, 100);
    assert.equal(after.layers[1]?.adjustments.contrast, 75);
  });

  it("clamps adjustment ranges and preserves values for NaN", () => {
    const state = createThumbnailState({ layers: layerSources("a") });
    const clamped = updateAdjustments(state, {
      brightness: -50,
      contrast: Number.POSITIVE_INFINITY,
      saturation: 999,
    });
    assert.deepEqual(clamped.layers[0]?.adjustments, {
      brightness: 0,
      contrast: 200,
      saturation: 200,
    });
    const ignored = updateAdjustments(clamped, { brightness: Number.NaN });
    assert.equal(ignored, clamped);
  });

  it("ignores updates when no layer is selected or the id is unknown", () => {
    const noSelection = createThumbnailState({
      layers: layerSources("a"),
      selectedLayerId: null,
    });
    assert.equal(updateAdjustments(noSelection, { brightness: 20 }), noSelection);
    assert.equal(updateAdjustments(noSelection, "missing", { brightness: 20 }), noSelection);
  });

  it("clamps shadow and glow for the selected layer", () => {
    const state = createThumbnailState({ layers: layerSources("a") });
    const updated = updateOverlay(state, { shadow: -1, glow: 1000 });
    assert.equal(updated.layers[0]?.overlay.shadow, 0);
    assert.equal(updated.layers[0]?.overlay.glow, 100);
  });

  it("normalizes safe overlay colors and clamps rgba channels", () => {
    let state = createThumbnailState({ layers: layerSources("a") });
    state = updateOverlay(state, { color: " #AbC123 " });
    assert.equal(state.layers[0]?.overlay.color, "#abc123");
    state = updateOverlay(state, { color: "rgba(300, -20, 42.4, 5)" });
    assert.equal(state.layers[0]?.overlay.color, "rgba(255, 0, 42, 1)");
  });

  it("keeps the previous color when input is unsafe", () => {
    const state = createThumbnailState({ layers: layerSources("a") });
    const colored = updateOverlay(state, { color: "#00ff88" });
    const unsafe = updateOverlay(colored, { color: "url(file:///secret)" });
    assert.equal(unsafe, colored);
    assert.equal(unsafe.layers[0]?.overlay.color, "#00ff88");
  });

  it("updates an explicit layer overlay only", () => {
    const state = createThumbnailState({ layers: layerSources("a", "b") });
    const updated = updateOverlay(state, "b", { glow: 20, color: "red" });
    assert.equal(updated.layers[0]?.overlay.glow, 0);
    assert.equal(updated.layers[1]?.overlay.glow, 20);
    assert.equal(updated.layers[1]?.overlay.color, "red");
  });

  it("keeps shadow and glow colors independently configurable", () => {
    const state = createThumbnailState({ layers: layerSources("a") });
    const updated = updateOverlay(state, {
      shadowColor: "#112233",
      glowColor: "#aabbcc",
    });
    assert.equal(updated.layers[0]?.overlay.shadowColor, "#112233");
    assert.equal(updated.layers[0]?.overlay.glowColor, "#aabbcc");
    assert.equal(updated.layers[0]?.overlay.color, "#ffffff");
  });

  it("builds a complete Canvas CSS filter", () => {
    assert.equal(
      buildCssFilter({ brightness: 120, contrast: 80, saturation: 135.5 }),
      "brightness(120%) contrast(80%) saturate(135.5%)",
    );
  });

  it("clamps CSS filter values and defaults invalid values", () => {
    assert.equal(
      buildCssFilter({
        brightness: -1,
        contrast: Number.NaN,
        saturation: Number.POSITIVE_INFINITY,
      }),
      "brightness(0%) contrast(100%) saturate(200%)",
    );
    assert.equal(
      buildCssFilter(),
      "brightness(100%) contrast(100%) saturate(100%)",
    );
    assert.equal(
      buildCssFilter({ brightness: "invalid" as never }),
      "brightness(100%) contrast(100%) saturate(100%)",
    );
  });
});

describe("thumbnail text and badge overlays", () => {
  it("normalizes title overlay text, size, position, and colors", () => {
    const state = createThumbnailState();
    const updated = updateTextOverlay(state, {
      text: `  ${"긴 제목 ".repeat(40)}  `,
      x: 2,
      y: -1,
      fontSize: 999,
      color: "#ABC",
      shadow: 999,
      glowColor: "url(file:///secret)",
      align: "right",
      maxWidthRatio: 9,
    });
    assert.equal(updated.textOverlay.text.length, 120);
    assert.equal(updated.textOverlay.x, 1);
    assert.equal(updated.textOverlay.y, 0);
    assert.equal(updated.textOverlay.fontSize, 180);
    assert.equal(updated.textOverlay.color, "#abc");
    assert.equal(updated.textOverlay.shadow, 100);
    assert.equal(updated.textOverlay.glowColor, "#8b5cf6");
    assert.equal(updated.textOverlay.align, "right");
    assert.equal(updated.textOverlay.maxWidthRatio, 1);
  });

  it("normalizes badge overlay text, colors, spacing, and visibility", () => {
    const state = createThumbnailState();
    const updated = updateBadgeOverlay(state, {
      text: "  Shorts   요약  ",
      fontSize: -20,
      backgroundColor: "#0F0",
      color: "white",
      paddingX: 999,
      paddingY: -1,
      radius: Number.POSITIVE_INFINITY,
      visible: false,
    });
    assert.equal(updated.badgeOverlay.text, "Shorts 요약");
    assert.equal(updated.badgeOverlay.fontSize, 10);
    assert.equal(updated.badgeOverlay.backgroundColor, "#0f0");
    assert.equal(updated.badgeOverlay.color, "white");
    assert.equal(updated.badgeOverlay.paddingX, 80);
    assert.equal(updated.badgeOverlay.paddingY, 0);
    assert.equal(updated.badgeOverlay.radius, 48);
    assert.equal(updated.badgeOverlay.visible, false);
  });
});

describe("thumbnail layer transform", () => {
  it("normalizes selected layer zoom and offsets", () => {
    const state = createThumbnailState({ layers: layerSources("a") });
    const updated = updateTransform(state, {
      zoom: 999,
      offsetX: -9,
      offsetY: 9,
    });
    assert.equal(updated.layers[0]?.transform.zoom, 4);
    assert.equal(updated.layers[0]?.transform.offsetX, -1);
    assert.equal(updated.layers[0]?.transform.offsetY, 1);
  });

  it("updates an explicit layer transform only", () => {
    const state = createThumbnailState({ layers: layerSources("a", "b") });
    const updated = updateTransform(state, "b", { zoom: 2, offsetX: 0.5 });
    assert.equal(updated.layers[0]?.transform.zoom, 1);
    assert.equal(updated.layers[1]?.transform.zoom, 2);
    assert.equal(updated.layers[1]?.transform.offsetX, 0.5);
  });
});

describe("calculateLayoutRects", () => {
  it("calculates a full-frame cell", () => {
    assert.deepEqual(calculateLayoutRects(1280, 720, 1, "full"), [
      { x: 0, y: 0, width: 1280, height: 720 },
    ]);
  });

  it("splits vertical layouts without losing odd pixels", () => {
    assert.deepEqual(calculateLayoutRects(5, 4, 2, "vertical"), [
      { x: 0, y: 0, width: 2, height: 4 },
      { x: 2, y: 0, width: 3, height: 4 },
    ]);
  });

  it("splits horizontal layouts without losing odd pixels", () => {
    assert.deepEqual(calculateLayoutRects(4, 5, 2, "horizontal"), [
      { x: 0, y: 0, width: 4, height: 2 },
      { x: 0, y: 2, width: 4, height: 3 },
    ]);
  });

  it("calculates a two-thirds hero-left layout", () => {
    assert.deepEqual(calculateLayoutRects(1200, 720, 3, "hero-left"), [
      { x: 0, y: 0, width: 800, height: 720 },
      { x: 800, y: 0, width: 400, height: 360 },
      { x: 800, y: 360, width: 400, height: 360 },
    ]);
  });

  it("calculates a two-thirds hero-top layout", () => {
    assert.deepEqual(calculateLayoutRects(1200, 900, 3, "hero-top"), [
      { x: 0, y: 0, width: 1200, height: 600 },
      { x: 0, y: 600, width: 600, height: 300 },
      { x: 600, y: 600, width: 600, height: 300 },
    ]);
  });

  it("calculates a pixel-complete four-cell grid", () => {
    assert.deepEqual(calculateLayoutRects(5, 5, 4, "grid"), [
      { x: 0, y: 0, width: 2, height: 2 },
      { x: 2, y: 0, width: 3, height: 2 },
      { x: 0, y: 2, width: 2, height: 3 },
      { x: 2, y: 2, width: 3, height: 3 },
    ]);
  });

  it("returns only occupied cells from a larger layout", () => {
    assert.deepEqual(calculateLayoutRects(100, 100, 2, "grid"), [
      { x: 0, y: 0, width: 50, height: 50 },
      { x: 50, y: 0, width: 50, height: 50 },
    ]);
  });

  it("falls back when a requested layout has too few cells", () => {
    assert.deepEqual(
      calculateLayoutRects(100, 100, 2, "full"),
      calculateLayoutRects(100, 100, 2, "vertical"),
    );
  });

  it("clamps the cell count to four", () => {
    assert.equal(calculateLayoutRects(100, 100, 99, "grid").length, 4);
  });

  it("returns no cells for zero, NaN, or invalid dimensions", () => {
    assert.deepEqual(calculateLayoutRects(100, 100, 0, "full"), []);
    assert.deepEqual(calculateLayoutRects(100, 100, Number.NaN, "full"), []);
    assert.deepEqual(calculateLayoutRects(0, 100, 1, "full"), []);
    assert.deepEqual(calculateLayoutRects(100, Number.POSITIVE_INFINITY, 1, "full"), []);
  });

  it("floors fractional canvas dimensions", () => {
    assert.deepEqual(calculateLayoutRects(100.9, 50.8, 1, "full"), [
      { x: 0, y: 0, width: 100, height: 50 },
    ]);
  });

  it("freezes the returned collection and rectangles", () => {
    const rectangles = calculateLayoutRects(100, 100, 2, "vertical");
    assert.ok(Object.isFrozen(rectangles));
    assert.ok(rectangles.every((item) => Object.isFrozen(item)));
  });
});

describe("renderThumbnail", () => {
  it("sizes, clears, and paints the Canvas background", async () => {
    const ctx = new MockContext();
    const state = createThumbnailState({ width: 640, height: 360 });
    await renderThumbnail(ctx, state, () => null);
    assert.deepEqual(ctx.canvas, { width: 640, height: 360 });
    assert.deepEqual(ctx.clearCalls, [[0, 0, 640, 360]]);
    assert.deepEqual(ctx.fillCalls, [[0, 0, 640, 360]]);
    assert.equal(ctx.fillStyle, "#111111");
  });

  it("center-crops a wide image using cover semantics", async () => {
    const ctx = new MockContext();
    const state = createThumbnailState({
      width: 640,
      height: 720,
      layers: layerSources("wide"),
    });
    const image = { width: 1920, height: 1080 };
    await renderThumbnail(ctx, state, () => image);
    assert.equal(ctx.drawCalls.length, 1);
    assert.equal(ctx.drawCalls[0]?.image, image);
    assert.deepEqual(ctx.drawCalls[0]?.args, [480, 0, 960, 1080, 0, 0, 640, 720]);
  });

  it("center-crops a tall image using cover semantics", async () => {
    const ctx = new MockContext();
    const state = createThumbnailState({
      width: 1280,
      height: 360,
      layers: layerSources("tall"),
    });
    await renderThumbnail(ctx, state, () => ({ width: 1080, height: 1920 }));
    assert.deepEqual(ctx.drawCalls[0]?.args, [0, 808.125, 1080, 303.75, 0, 0, 1280, 360]);
  });

  it("draws layers in state order into their assigned cells", async () => {
    const ctx = new MockContext();
    const state = createThumbnailState({
      width: 100,
      height: 50,
      layers: layerSources("a", "b"),
    });
    const resolved: string[] = [];
    await renderThumbnail(ctx, state, (source) => {
      resolved.push(source);
      return { width: 100, height: 50 };
    });
    assert.deepEqual(resolved, ["a", "b"]);
    assert.deepEqual(
      ctx.drawCalls.map((call) => call.args.slice(4)),
      [
        [0, 0, 50, 50],
        [50, 0, 50, 50],
      ],
    );
  });

  it("applies each layer's CSS filter during its draw", async () => {
    const ctx = new MockContext();
    let state = createThumbnailState({ layers: layerSources("a") });
    state = updateAdjustments(state, { brightness: 120, contrast: 90, saturation: 80 });
    await renderThumbnail(ctx, state, () => ({ width: 1280, height: 720 }));
    assert.equal(
      ctx.drawCalls[0]?.filter,
      "brightness(120%) contrast(90%) saturate(80%)",
    );
    assert.equal(ctx.filter, "none");
  });

  it("applies selected layer zoom and crop offsets during image drawing", async () => {
    const ctx = new MockContext();
    let state = createThumbnailState({
      width: 100,
      height: 100,
      layers: layerSources("a"),
    });
    state = updateTransform(state, { zoom: 2, offsetX: 1, offsetY: -1 });
    await renderThumbnail(ctx, state, () => ({ width: 200, height: 200 }));
    assert.deepEqual(ctx.drawCalls[0]?.args, [100, 0, 100, 100, 0, 0, 100, 100]);
  });

  it("draws shadow and outer glow for every configured layer", async () => {
    const ctx = new MockContext();
    let state = createThumbnailState({
      width: 200,
      height: 100,
      layers: layerSources("a", "b"),
      selectedLayerId: "b",
    });
    state = updateOverlay(state, "a", { shadow: 10, glow: 10, color: "red" });
    state = updateOverlay(state, "b", {
      shadow: 12,
      glow: 18,
      shadowColor: "#123456",
      glowColor: "#00ff88",
    });
    await renderThumbnail(ctx, state, () => ({ width: 100, height: 100 }));
    assert.equal(ctx.strokeCalls.length, 4);
    assert.deepEqual(ctx.strokeCalls.map((call) => call.args[0]), [1, 1, 101, 101]);
    assert.equal(ctx.strokeCalls[0]?.shadowBlur, 10);
    assert.equal(ctx.strokeCalls[0]?.shadowColor, "red");
    assert.equal(ctx.strokeCalls[1]?.shadowBlur, 10);
    assert.equal(ctx.strokeCalls[1]?.shadowColor, "red");
    assert.equal(ctx.strokeCalls[2]?.shadowBlur, 12);
    assert.equal(ctx.strokeCalls[2]?.shadowColor, "#123456");
    assert.equal(ctx.strokeCalls[3]?.shadowBlur, 18);
    assert.equal(ctx.strokeCalls[3]?.shadowColor, "#00ff88");
  });

  it("draws badge and title overlays after image layers", async () => {
    const ctx = new MockContext();
    let state = createThumbnailState({
      width: 1000,
      height: 500,
      layers: layerSources("a"),
    });
    state = updateBadgeOverlay(state, {
      text: "핵심",
      x: 0.1,
      y: 0.2,
      backgroundColor: "#ffcc00",
      color: "#111111",
    });
    state = updateTextOverlay(state, {
      text: "바로 쓰는 숏폼",
      x: 0.5,
      y: 0.8,
      fontSize: 64,
      color: "#ffffff",
      shadow: 12,
    });
    await renderThumbnail(ctx, state, () => ({ width: 1280, height: 720 }));
    assert.equal(ctx.drawCalls.length, 1);
    assert.equal(ctx.textCalls.length, 2);
    assert.equal(ctx.textCalls[0]?.text, "핵심");
    assert.equal(ctx.textCalls[0]?.x, 122);
    assert.equal(ctx.textCalls[0]?.fillStyle, "#111111");
    assert.equal(ctx.fillCalls.at(-1)?.[0], 100);
    assert.equal(ctx.textCalls[1]?.text, "바로 쓰는 숏폼");
    assert.equal(ctx.textCalls[1]?.x, 500);
    assert.equal(ctx.textCalls[1]?.y, 400);
    assert.equal(ctx.textCalls[1]?.font, "700 64px sans-serif");
    assert.equal(ctx.textCalls[1]?.textAlign, "center");
    assert.equal(ctx.textCalls[1]?.shadowBlur, 12);
  });

  it("supports async image resolvers", async () => {
    const ctx = new MockContext();
    const state = createThumbnailState({ layers: layerSources("a") });
    await renderThumbnail(ctx, state, async () => ({ naturalWidth: 1280, naturalHeight: 720 }));
    assert.equal(ctx.drawCalls.length, 1);
  });

  it("fails clearly when an image is missing", async () => {
    const ctx = new MockContext();
    const state = createThumbnailState({ layers: layerSources("missing") });
    await assert.rejects(
      renderThumbnail(ctx, state, () => null),
      /missing.*이미지를 불러오지 못했습니다/u,
    );
  });

  it("fails clearly when image dimensions are unusable", async () => {
    const ctx = new MockContext();
    const state = createThumbnailState({ layers: layerSources("broken") });
    await assert.rejects(
      renderThumbnail(ctx, state, () => ({ width: 0, height: Number.NaN })),
      /크기를 확인할 수 없습니다/u,
    );
    assert.equal(ctx.saveCount, ctx.restoreCount);
  });

  it("guards optional browser Canvas features for UXP-like contexts", async () => {
    const calls: number[][] = [];
    const ctx: CanvasContextLike = {
      drawImage(
        _image,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        destinationX,
        destinationY,
        destinationWidth,
        destinationHeight,
      ) {
        calls.push([
          sourceX,
          sourceY,
          sourceWidth,
          sourceHeight,
          destinationX,
          destinationY,
          destinationWidth,
          destinationHeight,
        ]);
      },
    };
    const state = createThumbnailState({ layers: layerSources("a") });
    await renderThumbnail(ctx, state, () => ({ videoWidth: 1280, videoHeight: 720 }));
    assert.equal(calls.length, 1);
  });

  it("rejects an invalid context or resolver", async () => {
    const state = createThumbnailState();
    await assert.rejects(
      renderThumbnail({} as CanvasContextLike, state, () => null),
      TypeError,
    );
    await assert.rejects(
      renderThumbnail(new MockContext(), state, null as never),
      TypeError,
    );
  });
});

describe("canvasToPngBytes", () => {
  it("uses OffscreenCanvas convertToBlob when available", async () => {
    let requestedType = "";
    const bytes = await canvasToPngBytes({
      async convertToBlob(options) {
        requestedType = options?.type ?? "";
        return makeBlob([137, 80, 78, 71]);
      },
    });
    assert.equal(requestedType, "image/png");
    assert.deepEqual([...bytes], [137, 80, 78, 71]);
  });

  it("accepts Uint8Array output from a UXP convertToBlob shim", async () => {
    const original = Uint8Array.from([1, 2, 3]);
    const bytes = await canvasToPngBytes({
      async convertToBlob() {
        return original;
      },
    });
    assert.deepEqual([...bytes], [1, 2, 3]);
    assert.notEqual(bytes, original);
  });

  it("supports the HTMLCanvasElement toBlob callback", async () => {
    let requestedType = "";
    const bytes = await canvasToPngBytes({
      toBlob(callback, type) {
        requestedType = type ?? "";
        callback(makeBlob([9, 8, 7]));
      },
    });
    assert.equal(requestedType, "image/png");
    assert.deepEqual([...bytes], [9, 8, 7]);
  });

  it("decodes a PNG data URL without relying on Buffer or atob", async () => {
    let requestedType = "";
    const bytes = await canvasToPngBytes({
      toDataURL(type) {
        requestedType = type ?? "";
        return "data:image/png;base64,iVBORw==";
      },
    });
    assert.equal(requestedType, "image/png");
    assert.deepEqual([...bytes], [137, 80, 78, 71]);
  });

  it("falls through when a newer export API is unavailable at runtime", async () => {
    const bytes = await canvasToPngBytes({
      async convertToBlob() {
        throw new Error("not implemented");
      },
      toDataURL() {
        return "data:image/png;base64,AQID";
      },
    });
    assert.deepEqual([...bytes], [1, 2, 3]);
  });

  it("rejects null or empty Blob output", async () => {
    await assert.rejects(
      canvasToPngBytes({
        toBlob(callback) {
          callback(null);
        },
      }),
      /빈 PNG Blob/u,
    );
    await assert.rejects(
      canvasToPngBytes({
        async convertToBlob() {
          return new Uint8Array();
        },
      }),
      /빈 PNG 데이터/u,
    );
  });

  it("rejects malformed or non-PNG data URLs", async () => {
    await assert.rejects(
      canvasToPngBytes({ toDataURL: () => "data:text/plain;base64,AQID" }),
      /유효한 PNG data URL/u,
    );
    await assert.rejects(
      canvasToPngBytes({ toDataURL: () => "data:image/png;base64,%%%" }),
      /유효한 PNG data URL/u,
    );
  });

  it("rejects environments with no supported PNG export API", async () => {
    await assert.rejects(
      canvasToPngBytes({}),
      /Canvas PNG 내보내기를 지원하지 않습니다/u,
    );
    await assert.rejects(canvasToPngBytes(null as never), TypeError);
  });
});

describe("canvasToImageBytes", () => {
  it("exports JPG bytes through convertToBlob with a JPEG MIME type and quality", async () => {
    let requestedType = "";
    let requestedQuality = 0;
    const bytes = await canvasToImageBytes({
      async convertToBlob(options) {
        requestedType = options?.type ?? "";
        requestedQuality = options?.quality ?? 0;
        return makeBlob([255, 216, 255, 217]);
      },
    }, "jpg");
    assert.equal(requestedType, "image/jpeg");
    assert.equal(requestedQuality, 0.92);
    assert.deepEqual([...bytes], [255, 216, 255, 217]);
  });

  it("exports JPG bytes through toBlob and data URL fallbacks", async () => {
    let toBlobType = "";
    let toBlobQuality = 0;
    const blobBytes = await canvasToImageBytes({
      toBlob(callback, type, quality) {
        toBlobType = type ?? "";
        toBlobQuality = quality ?? 0;
        callback(makeBlob([4, 5, 6]));
      },
    }, "jpg");
    assert.equal(toBlobType, "image/jpeg");
    assert.equal(toBlobQuality, 0.92);
    assert.deepEqual([...blobBytes], [4, 5, 6]);

    const dataUrlBytes = await canvasToImageBytes({
      toDataURL(type) {
        assert.equal(type, "image/jpeg");
        return "data:image/jpeg;base64,/9j/2Q==";
      },
    }, "jpg");
    assert.deepEqual([...dataUrlBytes], [255, 216, 255, 217]);
  });

  it("rejects unsupported JPG export environments with format-specific messages", async () => {
    await assert.rejects(
      canvasToImageBytes({}, "jpg"),
      /Canvas JPG 내보내기를 지원하지 않습니다/u,
    );
    await assert.rejects(
      canvasToImageBytes({ toDataURL: () => "data:image/png;base64,AQID" }, "jpg"),
      /유효한 JPG data URL/u,
    );
  });
});

describe("renderThumbnailSvg", () => {
  it("creates portable image data URLs for SVG fallback exports", () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);

    assert.equal(inferThumbnailImageMime("cover", bytes), "image/png");
    assert.equal(inferThumbnailImageMime("cover.JPG"), "image/jpeg");
    assert.equal(inferThumbnailImageMime("cover.webp"), "image/webp");
    assert.equal(thumbnailBytesToDataUrl(bytes, inferThumbnailImageMime("cover.png", bytes)), "data:image/png;base64,iVBORw==");
  });

  it("sniffs image mime types when file names are missing extensions", () => {
    assert.equal(inferThumbnailImageMime("unknown", Uint8Array.from([0xff, 0xd8, 0xff, 0xd9])), "image/jpeg");
    assert.equal(
      inferThumbnailImageMime("unknown", Uint8Array.from([
        0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
      ])),
      "image/webp",
    );
    assert.equal(inferThumbnailImageMime("unknown", Uint8Array.from([0x47, 0x49, 0x46, 0x38])), "image/gif");
  });

  it("renders a deterministic SVG fallback with layout, text, badge, and effects", () => {
    const state = createThumbnailState({
      layout: "grid",
      backgroundColor: "#101010",
      layers: [
        {
          id: "one",
          source: "one",
          adjustments: { brightness: 120, contrast: 90, saturation: 150 },
          overlay: { shadow: 12, glow: 0, shadowColor: "#000000" },
          transform: { zoom: 1.4, offsetX: 0.5, offsetY: -0.25 },
        },
        "two",
        "three",
        "four",
      ],
      textOverlay: { text: "조회수 <상승> & 테스트", color: "#ffffff", shadow: 10 },
      badgeOverlay: { text: "HOT & SAFE", visible: true },
    });

    const svg = renderThumbnailSvg(state, {
      title: "ShortFlow <fallback>",
      resolveImageHref(source) {
        return `file:///C:/assets/${source}.png`;
      },
    });

    assert.match(svg, /^<\?xml version="1\.0" encoding="UTF-8"\?>/u);
    assert.match(svg, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1280" height="720"/u);
    assert.match(svg, /<title>ShortFlow &lt;fallback&gt;<\/title>/u);
    assert.match(svg, /clipPath id="shortflow-clip-3"/u);
    assert.match(svg, /href="file:\/\/\/C:\/assets\/one\.png"/u);
    assert.match(svg, /brightness\(120%\) contrast\(90%\) saturate\(150%\)/u);
    assert.match(svg, /scale\(1\.4\)/u);
    assert.match(svg, /HOT &amp; SAFE/u);
    assert.match(svg, /조회수 &lt;상승&gt; &amp; 테스트/u);
    assert.doesNotMatch(svg, /<script/iu);
  });

  it("rejects executable or non-image SVG hrefs before generating a fallback file", () => {
    const state = createThumbnailState({ layers: ["unsafe"] });

    assert.throws(
      () => renderThumbnailSvg(state, { resolveImageHref: () => "javascript:alert(1)" }),
      /실행 가능한 scheme/u,
    );
    assert.throws(
      () => renderThumbnailSvg(state, { resolveImageHref: () => "data:text/html;base64,PHNjcmlwdA==" }),
      /이미지 data URL/u,
    );
  });
});
