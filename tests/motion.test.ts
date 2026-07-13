import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  computeMotionSamples,
  directionOffset,
  easeProgress,
  motionOpacity,
  slidePosition,
  type MotionEasing,
} from "../src/motion";

describe("easeProgress", () => {
  it("maps endpoints 0->0 and 1->1 for every easing", () => {
    for (const easing of ["linear", "ease-out", "spring", "bounce"] as MotionEasing[]) {
      assert.equal(easeProgress(easing, 0), 0, easing);
      assert.equal(easeProgress(easing, 1), 1, easing);
    }
  });

  it("clamps out-of-range input", () => {
    assert.equal(easeProgress("linear", -0.5), 0);
    assert.equal(easeProgress("ease-out", 2), 1);
  });

  it("ease-out is monotonic and front-loaded", () => {
    assert.ok(easeProgress("ease-out", 0.5) > 0.5); // 앞쪽이 빠르다
    let prev = -1;
    for (let i = 0; i <= 10; i += 1) {
      const value = easeProgress("ease-out", i / 10);
      assert.ok(value >= prev, `not monotonic at ${i}`);
      prev = value;
    }
  });

  it("spring overshoots past 1 before settling", () => {
    let overshoot = false;
    for (let i = 1; i < 20; i += 1) {
      if (easeProgress("spring", i / 20) > 1.0001) overshoot = true;
    }
    assert.ok(overshoot, "spring should overshoot");
  });
});

describe("computeMotionSamples", () => {
  it("samples an 'in' motion from 0 to 1 over the duration", () => {
    const samples = computeMotionSamples("in", "linear", 1, 30);
    assert.ok(samples.length >= 2);
    assert.equal(samples[0]!.timeSeconds, 0);
    assert.equal(samples[0]!.progress, 0);
    assert.equal(samples[samples.length - 1]!.progress, 1);
    assert.ok(Math.abs(samples[samples.length - 1]!.timeSeconds - 1) < 1e-6);
    // 시각은 오름차순
    for (let i = 1; i < samples.length; i += 1) {
      assert.ok(samples[i]!.timeSeconds >= samples[i - 1]!.timeSeconds);
    }
  });

  it("reverses progress for an 'out' motion (1 -> 0)", () => {
    const samples = computeMotionSamples("out", "linear", 1, 30);
    assert.equal(samples[0]!.progress, 1);
    assert.equal(samples[samples.length - 1]!.progress, 0);
  });

  it("caps the sample count and returns empty for invalid duration", () => {
    assert.deepEqual(computeMotionSamples("in", "linear", 0, 30), []);
    assert.deepEqual(computeMotionSamples("in", "linear", 1, 0), []);
    assert.ok(computeMotionSamples("in", "spring", 100, 30).length <= 601);
  });
});

describe("directionOffset", () => {
  it("returns unit offsets per direction", () => {
    assert.deepEqual(directionOffset("left"), { x: -1, y: 0 });
    assert.deepEqual(directionOffset("right"), { x: 1, y: 0 });
    assert.deepEqual(directionOffset("top"), { x: 0, y: -1 });
    assert.deepEqual(directionOffset("bottom"), { x: 0, y: 1 });
  });
});

describe("slidePosition", () => {
  it("is at rest when progress is 1 and offscreen when progress is 0", () => {
    assert.deepEqual(slidePosition(0.5, 0.5, "left", 1), { x: 0.5, y: 0.5 });
    assert.deepEqual(slidePosition(0.5, 0.5, "left", 0), { x: -0.5, y: 0.5 });
    assert.deepEqual(slidePosition(0.5, 0.5, "bottom", 0), { x: 0.5, y: 1.5 });
  });

  it("overshoots past rest when spring progress exceeds 1", () => {
    const pos = slidePosition(0.5, 0.5, "left", 1.1); // progress>1
    assert.ok(pos.x > 0.5); // rest를 지나 반대쪽으로 오버슈트
  });
});

describe("motionOpacity", () => {
  it("maps progress to 0-100 and clamps overshoot", () => {
    assert.equal(motionOpacity(0), 0);
    assert.equal(motionOpacity(1), 100);
    assert.equal(motionOpacity(0.5), 50);
    assert.equal(motionOpacity(1.2), 100);
    assert.equal(motionOpacity(-0.1), 0);
  });
});
