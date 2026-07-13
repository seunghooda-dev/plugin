import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeDuckingEnvelope, type DuckKeyframe } from "../src/audio-ducking";

function at(keyframes: readonly DuckKeyframe[], time: number): DuckKeyframe | undefined {
  return keyframes.find((keyframe) => Math.abs(keyframe.time - time) < 1e-3);
}

function isMonotonic(keyframes: readonly DuckKeyframe[]): boolean {
  for (let i = 1; i < keyframes.length; i += 1) {
    if (keyframes[i]!.time < keyframes[i - 1]!.time) return false;
  }
  return true;
}

describe("computeDuckingEnvelope", () => {
  it("ducks around a single mid-clip speech span with attack/release ramps", () => {
    const kf = computeDuckingEnvelope([{ start: 4, end: 6 }], { start: 0, end: 10 });
    assert.ok(isMonotonic(kf));
    assert.deepEqual(at(kf, 0), { time: 0, gainDb: 0 }); // 시작 base
    assert.deepEqual(at(kf, 3.85), { time: 3.85, gainDb: 0 }); // attack 시작(4-0.15)
    assert.deepEqual(at(kf, 4), { time: 4, gainDb: -12 }); // 발화 시작 = duck
    assert.deepEqual(at(kf, 6), { time: 6, gainDb: -12 }); // 발화 끝 = duck
    assert.deepEqual(at(kf, 6.4), { time: 6.4, gainDb: 0 }); // release 끝(6+0.4)
    assert.deepEqual(at(kf, 10), { time: 10, gainDb: 0 }); // 끝 base
    assert.equal(kf.filter((k) => k.gainDb === -12).length, 2);
  });

  it("returns no keyframes when there is no speech", () => {
    assert.deepEqual(computeDuckingEnvelope([], { start: 0, end: 10 }), []);
  });

  it("returns no keyframes for an invalid range", () => {
    assert.deepEqual(computeDuckingEnvelope([{ start: 1, end: 2 }], { start: 5, end: 5 }), []);
    assert.deepEqual(
      computeDuckingEnvelope([{ start: 1, end: 2 }], { start: NaN, end: 10 }),
      [],
    );
  });

  it("starts ducked when speech begins before the clip", () => {
    const kf = computeDuckingEnvelope([{ start: -1, end: 2 }], { start: 0, end: 10 });
    assert.equal(kf[0]?.time, 0);
    assert.equal(kf[0]?.gainDb, -12); // 클립 시작부터 duck
    assert.deepEqual(at(kf, 2), { time: 2, gainDb: -12 });
  });

  it("keeps two separate dips for spans far apart", () => {
    const kf = computeDuckingEnvelope(
      [{ start: 4, end: 6 }, { start: 10, end: 12 }],
      { start: 0, end: 20 },
    );
    assert.equal(kf.filter((k) => k.gainDb === -12).length, 4); // 두 개의 plateau
  });

  it("merges spans closer than the merge gap into one dip", () => {
    const kf = computeDuckingEnvelope(
      [{ start: 4, end: 6 }, { start: 6.3, end: 8 }],
      { start: 0, end: 20 },
    );
    assert.equal(kf.filter((k) => k.gainDb === -12).length, 2); // 하나의 plateau (4~8)
    assert.deepEqual(at(kf, 4), { time: 4, gainDb: -12 });
    assert.deepEqual(at(kf, 8), { time: 8, gainDb: -12 });
    assert.equal(at(kf, 6), undefined); // 합쳐져 중간 전이 없음
  });

  it("forces the duck level at or below the base level", () => {
    const kf = computeDuckingEnvelope([{ start: 4, end: 6 }], { start: 0, end: 10 }, {
      baseGainDb: -3,
      duckGainDb: 5, // base보다 높음 → base로 강제
    });
    const duckPoint = at(kf, 4);
    assert.ok(duckPoint && duckPoint.gainDb <= -3);
  });

  it("honors custom attack, release, and duck depth", () => {
    const kf = computeDuckingEnvelope([{ start: 5, end: 6 }], { start: 0, end: 10 }, {
      duckGainDb: -20,
      attackSeconds: 0.5,
      releaseSeconds: 1,
    });
    assert.deepEqual(at(kf, 4.5), { time: 4.5, gainDb: 0 }); // attack 0.5
    assert.deepEqual(at(kf, 5), { time: 5, gainDb: -20 });
    assert.deepEqual(at(kf, 7), { time: 7, gainDb: 0 }); // release 1 (6+1)
  });
});
