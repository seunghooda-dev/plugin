// BGM 오디오의 템포(BPM)와 비트 그리드를 검출하는 순수 함수 (Web Audio·Premiere Host 비의존, 모노 PCM 입력).

export interface BeatDetectionResult {
  /** 추정 BPM. 규칙적 템포를 못 찾으면 0(불명확). */
  readonly bpm: number;
  /** 추정 템포의 비트 그리드 시각(초), 오름차순. bpm=0이면 빈 배열. */
  readonly beatTimes: number[];
}

const FRAME_SIZE = 1024;
const HOP = 512;
const MIN_BPM = 60;
const MAX_BPM = 180;
// 자기상관 피크가 평균의 이 배수 미만이면 비음악(노이즈·발화)으로 보고 BPM 불명확 처리.
const CONFIDENCE_RATIO = 4;

/**
 * 온셋 강도(에너지 플럭스) 엔벨로프의 자기상관으로 우세 템포를 찾는다. 중앙값-IOI 방식은
 * 서브비트 온셋이 많은 실제 음악에서 실패하므로 자기상관을 쓴다. 자동 컷이 아니라 사용자
 * 배치(마커·컷 정렬)의 근사 근거가 목표다.
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
  if (frameCount <= 8) return { bpm: 0, beatTimes: [] };

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

  // 양의 에너지 플럭스(온셋 강도) + 가장 강한 온셋 위치(그리드 위상 기준).
  const flux = new Float64Array(frameCount);
  let fluxMean = 0;
  let strongestFrame = 0;
  let strongestFlux = 0;
  for (let f = 1; f < frameCount; f += 1) {
    const delta = energy[f]! - energy[f - 1]!;
    const positive = delta > 0 ? delta : 0;
    flux[f] = positive;
    fluxMean += positive;
    if (positive > strongestFlux) {
      strongestFlux = positive;
      strongestFrame = f;
    }
  }
  fluxMean /= frameCount;
  if (strongestFlux <= 0) return { bpm: 0, beatTimes: [] };

  // 평균(DC) 제거 엔벨로프 — 자기상관이 지속 에너지가 아닌 변동에 반응하도록.
  const envelope = new Float64Array(frameCount);
  for (let f = 0; f < frameCount; f += 1) {
    const centered = flux[f]! - fluxMean;
    envelope[f] = centered > 0 ? centered : 0;
  }

  const frameTime = HOP / sampleRate;
  const bpm = estimateTempo(envelope, frameCount, frameTime);
  if (bpm <= 0) return { bpm: 0, beatTimes: [] };

  const duration = frameCount * frameTime;
  return { bpm, beatTimes: beatGrid(bpm, strongestFrame * frameTime, duration) };
}

function estimateTempo(envelope: Float64Array, frameCount: number, frameTime: number): number {
  const autocorrelation = (lag: number): number => {
    let sum = 0;
    for (let i = 0; i + lag < frameCount; i += 1) sum += envelope[i]! * envelope[i + lag]!;
    return sum / (frameCount - lag);
  };

  let bestBpm = 0;
  let bestScore = -1;
  let scoreSum = 0;
  let scoreCount = 0;
  // 0.5 BPM 간격으로 후보 lag의 자기상관을 본다.
  for (let bpmTenths = MIN_BPM * 10; bpmTenths <= MAX_BPM * 10; bpmTenths += 5) {
    const bpm = bpmTenths / 10;
    const lag = Math.round(60 / bpm / frameTime);
    if (lag < 2 || lag >= frameCount) continue;
    const score = autocorrelation(lag);
    scoreSum += score;
    scoreCount += 1;
    if (score > bestScore) {
      bestScore = score;
      bestBpm = bpm;
    }
  }

  if (scoreCount === 0 || bestScore <= 0) return 0;
  const average = scoreSum / scoreCount;
  if (average <= 0 || bestScore < average * CONFIDENCE_RATIO) return 0;
  return Math.round(bestBpm * 10) / 10;
}

function beatGrid(bpm: number, phaseAnchorSeconds: number, duration: number): number[] {
  const period = 60 / bpm;
  const phase = (((phaseAnchorSeconds % period) + period) % period);
  const grid: number[] = [];
  for (let time = phase; time <= duration + 1e-9; time += period) {
    grid.push(Math.round(time * 1000) / 1000);
  }
  return grid;
}
