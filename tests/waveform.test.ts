import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeWaveformPeaks, renderWaveformSvg } from "../src/waveform";

describe("computeWaveformPeaks", () => {
  it("returns one normalized peak per bin", () => {
    const samples = new Float32Array([0, 0.25, -0.5, 0.1, 1, -0.2, 0.3, -0.4]);
    const peaks = computeWaveformPeaks(samples, 4);
    assert.equal(peaks.length, 4);
    // 최대 절대 진폭(1)이 정규화 기준 → 어떤 bin은 1.0.
    assert.ok(Math.max(...peaks) === 1);
    for (const value of peaks) assert.ok(value >= 0 && value <= 1);
  });

  it("normalizes a quiet signal so the loudest bin reaches 1", () => {
    const samples = new Float32Array([0.01, -0.02, 0.05, -0.03]);
    const peaks = computeWaveformPeaks(samples, 2);
    assert.ok(Math.abs(Math.max(...peaks) - 1) < 1e-6);
  });

  it("returns an empty array for invalid input", () => {
    assert.equal(computeWaveformPeaks(new Float32Array(0), 10).length, 0);
    assert.equal(computeWaveformPeaks(new Float32Array([1, 2]), 0).length, 0);
    assert.equal(computeWaveformPeaks(new Float32Array([1, 2]), 1.5).length, 0);
    assert.equal(computeWaveformPeaks(undefined as unknown as Float32Array, 4).length, 0);
  });
});

describe("renderWaveformSvg", () => {
  it("renders one rect per peak inside a viewBox", () => {
    const svg = renderWaveformSvg(new Float32Array([0.2, 0.8, 0.5]), { width: 300, height: 60 });
    assert.match(svg, /^<svg /u);
    assert.match(svg, /viewBox="0 0 300 60"/u);
    assert.equal((svg.match(/<rect /gu) ?? []).length, 3);
    assert.match(svg, /<\/svg>$/u);
  });

  it("returns an empty svg for empty peaks", () => {
    const svg = renderWaveformSvg(new Float32Array(0));
    assert.match(svg, /^<svg /u);
    assert.equal((svg.match(/<rect /gu) ?? []).length, 0);
  });

  it("rejects an unsafe color and falls back to currentColor", () => {
    const svg = renderWaveformSvg(new Float32Array([1]), { color: '"><script>alert(1)</script>' });
    assert.match(svg, /fill="currentColor"/u);
    assert.doesNotMatch(svg, /<script>/u);
  });

  it("accepts a hex color", () => {
    assert.match(renderWaveformSvg(new Float32Array([1]), { color: "#3af" }), /fill="#3af"/u);
  });
});
