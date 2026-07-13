// BGM 오디오의 비트 온셋과 BPM를 검출하는 순수 함수 (Web Audio·Premiere Host 비의존, 모노 PCM 입력)

export interface BeatDetectionResult {
  /** 추정 BPM. 신뢰도가 낮으면 0(불명확). */
  readonly bpm: number;
  /** 검출된 비트 온셋 시각(초), 오름차순. */
  readonly beatTimes: number[];
}

const FRAME_SIZE = 1024;
const HOP = 512;
const MIN_ONSET_GAP_SECONDS = 0.1;
const LOCAL_WINDOW = 10; // 에너지 플럭스 지역 평균 창(프레임)
const THRESHOLD_MULTIPLIER = 1.5; // 지역 평균 대비 온셋 판정 배수
const FLOOR_FRACTION = 0.1; // 전역 플럭스 최대 대비 최소 비율(잡음 억제)
const MAX_IOI_CV = 0.5; // 인터-온셋 간격 변동계수 상한(초과 시 BPM 불명확)

/**
 * 모노 PCM에서 에너지 플럭스 온셋을 찾고 인터-온셋 간격의 중앙값으로 BPM를 추정한다.
 * 자동 컷이 아니라 사용자 배치(마커·컷 정렬)의 근사 근거로 쓰는 것을 목표로 한다.
 */
export function detectBeats(samples: Float32Array, sampleRate: number): BeatDetectionResult {
  if (
    !(samples instanceof Float32Array) ||
    samples.length === 0 ||
    !Number.isFinite(sampleRate) ||
    sampleRate <= 0
  ) {
    return { bpm: 0, beatTimes: [] };
  }

  const frameCount = Math.floor((samples.length - FRAME_SIZE) / HOP) + 1;
  if (frameCount <= 1) return { bpm: 0, beatTimes: [] };

  const energy = new Float64Array(frameCount);
  for (let f = 0; f < frameCount; f += 1) {
    const start = f * HOP;
    let sum = 0;
    for (let i = 0; i < FRAME_SIZE; i += 1) {
      const value = samples[start + i] ?? 0;
      sum += value * value;
    }
    energy[f] = sum / FRAME_SIZE;
  }

  const flux = new Float64Array(frameCount);
  let globalPeak = 0;
  for (let f = 1; f < frameCount; f += 1) {
    const delta = energy[f]! - energy[f - 1]!;
    const positive = delta > 0 ? delta : 0;
    flux[f] = positive;
    if (positive > globalPeak) globalPeak = positive;
  }
  if (globalPeak <= 0) return { bpm: 0, beatTimes: [] };

  const frameTime = HOP / sampleRate;
  const minGapFrames = Math.max(1, Math.round(MIN_ONSET_GAP_SECONDS / frameTime));
  const floor = globalPeak * FLOOR_FRACTION;

  const onsetFrames: number[] = [];
  let lastOnset = Number.NEGATIVE_INFINITY;
  for (let f = 1; f < frameCount; f += 1) {
    const value = flux[f]!;
    if (value < floor) continue;

    let windowSum = 0;
    let windowCount = 0;
    for (let j = f - LOCAL_WINDOW; j <= f + LOCAL_WINDOW; j += 1) {
      if (j >= 0 && j < frameCount) {
        windowSum += flux[j]!;
        windowCount += 1;
      }
    }
    const localMean = windowCount > 0 ? windowSum / windowCount : 0;
    if (value <= localMean * THRESHOLD_MULTIPLIER) continue;

    const prev = f > 0 ? flux[f - 1]! : 0;
    const next = f + 1 < frameCount ? flux[f + 1]! : 0;
    if (value < prev || value < next) continue; // 지역 최대만

    if (f - lastOnset < minGapFrames) {
      // 최소 간격 안이면 더 강한 온셋으로 교체
      const lastIndex = onsetFrames.length - 1;
      if (lastIndex >= 0 && value > flux[onsetFrames[lastIndex]!]!) {
        onsetFrames[lastIndex] = f;
        lastOnset = f;
      }
      continue;
    }
    onsetFrames.push(f);
    lastOnset = f;
  }

  const beatTimes = onsetFrames.map((frame) => frame * frameTime);
  return { bpm: estimateBpm(beatTimes), beatTimes };
}

function estimateBpm(onsetTimes: readonly number[]): number {
  if (onsetTimes.length < 2) return 0;
  const intervals: number[] = [];
  for (let i = 1; i < onsetTimes.length; i += 1) {
    intervals.push(onsetTimes[i]! - onsetTimes[i - 1]!);
  }
  const sorted = [...intervals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  if (!Number.isFinite(median) || median <= 0) return 0;

  const mean = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
  const variance =
    intervals.reduce((sum, value) => sum + (value - mean) ** 2, 0) / intervals.length;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : Number.POSITIVE_INFINITY;
  if (cv > MAX_IOI_CV) return 0;

  let bpm = 60 / median;
  while (bpm < 60) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  return Math.round(bpm * 10) / 10;
}
