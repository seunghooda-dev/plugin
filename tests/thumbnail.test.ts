import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  THUMBNAIL_LAYOUTS,
  addLayer,
  buildCssFilter,
  calculateLayoutRects,
  canvasToPngBytes,
  createThumbnailState,
  removeLayer,
  renderThumbnail,
  reorderLayers,
  setLayout,
  updateAdjustments,
  updateOverlay,
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
  imageSmoothingEnabled = false;
  imageSmoothingQuality: "low" | "medium" | "high" = "low";
  readonly drawCalls: DrawCall[] = [];
  readonly strokeCalls: StrokeCall[] = [];
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

  it("draws shadow and outer glow only for the selected cell", async () => {
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
    assert.equal(ctx.strokeCalls.length, 2);
    assert.deepEqual(ctx.strokeCalls.map((call) => call.args[0]), [101, 101]);
    assert.equal(ctx.strokeCalls[0]?.shadowBlur, 12);
    assert.equal(ctx.strokeCalls[0]?.shadowColor, "#123456");
    assert.equal(ctx.strokeCalls[1]?.shadowBlur, 18);
    assert.equal(ctx.strokeCalls[1]?.shadowColor, "#00ff88");
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
