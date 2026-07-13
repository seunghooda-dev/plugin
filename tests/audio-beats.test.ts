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

// 결정적 LCG 화이트 노이즈(비음악 — 규칙적 템포 없음).
function whiteNoise(seconds: number): Float32Array {
  const total = Math.floor(SAMPLE_RATE * seconds);
  const samples = new Float32Array(total);
  let seed = 12345;
  for (let i = 0; i < total; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    samples[i] = (seed / 0x7fffffff) * 2 - 1;
  }
  return samples;
}

describe("detectBeats", () => {
  it("estimates 120 BPM from a 120 BPM click track and returns a matching beat grid", () => {
    const result = detectBeats(clickTrack(120, 6), SAMPLE_RATE);
    assert.ok(Math.abs(result.bpm - 120) <= 4, `bpm=${result.bpm}`);
    assert.ok(result.beatTimes.length >= 8, `beats=${result.beatTimes.length}`);
    // 비트 그리드는 균등 간격(≈0.5초)이고 오름차순이어야 한다.
    for (let i = 1; i < result.beatTimes.length; i += 1) {
      const gap = result.beatTimes[i]! - result.beatTimes[i - 1]!;
      assert.ok(Math.abs(gap - 0.5) <= 0.05, `gap=${gap}`);
      assert.ok(result.beatTimes[i]! > result.beatTimes[i - 1]!);
    }
  });

  it("estimates 100 BPM from a 100 BPM click track", () => {
    const result = detectBeats(clickTrack(100, 6), SAMPLE_RATE);
    assert.ok(Math.abs(result.bpm - 100) <= 4, `bpm=${result.bpm}`);
  });

  it("keeps a fast tempo within the 60-180 range (octave-folding allowed)", () => {
    const bpm = detectBeats(clickTrack(150, 6), SAMPLE_RATE).bpm;
    assert.ok(bpm >= 60 && bpm <= 180, `bpm=${bpm}`);
    // 150 또는 그 옥타브(≈75) 중 하나로 나온다.
    assert.ok(Math.abs(bpm - 150) <= 6 || Math.abs(bpm - 75) <= 6, `bpm=${bpm}`);
  });

  it("returns no beats for pure silence", () => {
    const result = detectBeats(new Float32Array(SAMPLE_RATE * 3), SAMPLE_RATE);
    assert.equal(result.bpm, 0);
    assert.deepEqual(result.beatTimes, []);
  });

  it("reports an unclear tempo (bpm 0) for non-musical white noise", () => {
    const result = detectBeats(whiteNoise(6), SAMPLE_RATE);
    assert.equal(result.bpm, 0);
    assert.deepEqual(result.beatTimes, []);
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
