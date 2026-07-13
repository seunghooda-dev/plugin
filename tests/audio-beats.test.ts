import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { detectBeats } from "../src/audio-beats";

const SAMPLE_RATE = 44100;

// 지정 BPM로 클릭(짧은 감쇠 버스트)을 심은 모노 트랙. 첫 클릭 앞에 무음을 둬 상승 에지가 생기게 한다.
function clickTrack(bpm: number, seconds: number): Float32Array {
  const total = Math.floor(SAMPLE_RATE * seconds);
  const samples = new Float32Array(total);
  const period = Math.round((SAMPLE_RATE * 60) / bpm);
  for (let start = period; start < total; start += period) {
    for (let i = 0; i < 400 && start + i < total; i += 1) {
      samples[start + i] = Math.exp(-i / 80) * Math.sin((2 * Math.PI * 1200 * i) / SAMPLE_RATE);
    }
  }
  return samples;
}

describe("detectBeats", () => {
  it("estimates 120 BPM from a 120 BPM click track", () => {
    const result = detectBeats(clickTrack(120, 6), SAMPLE_RATE);
    assert.ok(Math.abs(result.bpm - 120) <= 5, `bpm=${result.bpm}`);
    assert.ok(result.beatTimes.length >= 8, `onsets=${result.beatTimes.length}`);
    // 온셋 간격이 대략 0.5초여야 한다.
    for (let i = 1; i < result.beatTimes.length; i += 1) {
      const gap = result.beatTimes[i]! - result.beatTimes[i - 1]!;
      assert.ok(Math.abs(gap - 0.5) <= 0.05, `gap=${gap}`);
    }
    // 시각은 오름차순.
    for (let i = 1; i < result.beatTimes.length; i += 1) {
      assert.ok(result.beatTimes[i]! > result.beatTimes[i - 1]!);
    }
  });

  it("estimates 100 BPM from a 100 BPM click track", () => {
    const result = detectBeats(clickTrack(100, 6), SAMPLE_RATE);
    assert.ok(Math.abs(result.bpm - 100) <= 5, `bpm=${result.bpm}`);
  });

  it("folds a fast 150 BPM track into the 60-180 range", () => {
    const result = detectBeats(clickTrack(150, 6), SAMPLE_RATE);
    assert.ok(result.bpm >= 60 && result.bpm <= 180, `bpm=${result.bpm}`);
    assert.ok(Math.abs(result.bpm - 150) <= 6, `bpm=${result.bpm}`);
  });

  it("returns no beats for pure silence", () => {
    const result = detectBeats(new Float32Array(SAMPLE_RATE * 3), SAMPLE_RATE);
    assert.equal(result.bpm, 0);
    assert.deepEqual(result.beatTimes, []);
  });

  it("reports an unclear tempo (bpm 0) when onsets are irregularly spaced", () => {
    // 간격이 제각각인 클릭 → 인터-온셋 변동계수가 커서 BPM 불명확(0).
    const times = [0.3, 0.5, 1.2, 1.35, 2.4, 3.9];
    const total = SAMPLE_RATE * 5;
    const samples = new Float32Array(total);
    for (const time of times) {
      const start = Math.round(time * SAMPLE_RATE);
      for (let i = 0; i < 400 && start + i < total; i += 1) {
        samples[start + i] = Math.exp(-i / 80) * Math.sin((2 * Math.PI * 1200 * i) / SAMPLE_RATE);
      }
    }
    const result = detectBeats(samples, SAMPLE_RATE);
    // 온셋 자체는 잡히되 규칙적 템포는 없어야 한다.
    assert.ok(result.beatTimes.length >= 4, `onsets=${result.beatTimes.length}`);
    assert.equal(result.bpm, 0);
  });

  it("returns a safe empty result for invalid input", () => {
    assert.deepEqual(detectBeats(new Float32Array(0), SAMPLE_RATE), { bpm: 0, beatTimes: [] });
    assert.deepEqual(detectBeats(clickTrack(120, 6), 0), { bpm: 0, beatTimes: [] });
    assert.deepEqual(detectBeats(new Float32Array(500), SAMPLE_RATE), { bpm: 0, beatTimes: [] });
    assert.deepEqual(detectBeats(undefined as unknown as Float32Array, SAMPLE_RATE), {
      bpm: 0,
      beatTimes: [],
    });
  });
});
