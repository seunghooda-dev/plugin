// 발화 구간 동안 BGM 볼륨을 낮추는 덕킹 엔벨로프(볼륨 키프레임)를 계산하는 순수 함수.

export interface SpeechSpan {
  /** 절대 시각(초). */
  readonly start: number;
  readonly end: number;
}

export interface DuckRange {
  /** BGM 클립이 놓인 절대 구간(초). */
  readonly start: number;
  readonly end: number;
}

export interface DuckOptions {
  readonly baseGainDb?: number; // 평상시 BGM 레벨(기본 0)
  readonly duckGainDb?: number; // 발화 중 낮출 레벨(기본 -12, base보다 낮아야 함)
  readonly attackSeconds?: number; // 발화 전 내려가는 램프(기본 0.15)
  readonly releaseSeconds?: number; // 발화 후 올라오는 램프(기본 0.4)
  readonly mergeGapSeconds?: number; // 이보다 가까운 발화 구간은 합쳐 펌핑을 막음(기본 0.6)
}

export interface DuckKeyframe {
  /** 절대 시각(초). */
  readonly time: number;
  readonly gainDb: number;
}

const DEFAULTS = {
  baseGainDb: 0,
  duckGainDb: -12,
  attackSeconds: 0.15,
  releaseSeconds: 0.4,
  mergeGapSeconds: 0.6,
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * 발화 구간을 클립 범위로 자르고 인접한 것을 합친 뒤, 각 구간에 attack/release 램프를 붙여
 * base↔duck 볼륨 키프레임을 만든다. 발화가 없으면 빈 배열(덕킹 불필요).
 */
export function computeDuckingEnvelope(
  speech: readonly SpeechSpan[],
  range: DuckRange,
  options: DuckOptions = {},
): DuckKeyframe[] {
  if (!range || !isFiniteNumber(range.start) || !isFiniteNumber(range.end) || range.end <= range.start) {
    return [];
  }
  const base = isFiniteNumber(options.baseGainDb) ? options.baseGainDb : DEFAULTS.baseGainDb;
  const duckRaw = isFiniteNumber(options.duckGainDb) ? options.duckGainDb : DEFAULTS.duckGainDb;
  const duck = Math.min(duckRaw, base); // duck은 base 이하로 강제
  const attack = Math.max(0, isFiniteNumber(options.attackSeconds) ? options.attackSeconds : DEFAULTS.attackSeconds);
  const release = Math.max(0, isFiniteNumber(options.releaseSeconds) ? options.releaseSeconds : DEFAULTS.releaseSeconds);
  const mergeGap = Math.max(0, isFiniteNumber(options.mergeGapSeconds) ? options.mergeGapSeconds : DEFAULTS.mergeGapSeconds);

  // 유효 구간만 클립 범위로 자르고 정렬
  const clipped = (Array.isArray(speech) ? speech : [])
    .filter((span) => span && isFiniteNumber(span.start) && isFiniteNumber(span.end) && span.end > span.start)
    .map((span) => ({
      start: Math.max(range.start, span.start),
      end: Math.min(range.end, span.end),
    }))
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start);

  if (clipped.length === 0) return [];

  // 인접/겹치는 구간 합치기
  const merged: Array<{ start: number; end: number }> = [];
  for (const span of clipped) {
    const last = merged[merged.length - 1];
    if (last && span.start - last.end < mergeGap) {
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ start: span.start, end: span.end });
    }
  }

  const points: DuckKeyframe[] = [{ time: range.start, gainDb: base }];
  for (const span of merged) {
    const duckStart = Math.max(range.start, span.start - attack);
    const duckEnd = Math.min(range.end, span.end + release);
    points.push({ time: duckStart, gainDb: base });
    points.push({ time: Math.max(range.start, span.start), gainDb: duck });
    points.push({ time: Math.min(range.end, span.end), gainDb: duck });
    points.push({ time: duckEnd, gainDb: base });
  }
  points.push({ time: range.end, gainDb: base });

  // 시각 정렬 후 동시각은 더 낮은(더 덕된) 값만 남긴다 — 경계에서 발화 우선.
  points.sort((a, b) => a.time - b.time);
  const deduped: DuckKeyframe[] = [];
  for (const point of points) {
    const last = deduped[deduped.length - 1];
    if (last && Math.abs(last.time - point.time) < 1e-4) {
      if (point.gainDb < last.gainDb) {
        deduped[deduped.length - 1] = { time: last.time, gainDb: point.gainDb };
      }
      continue;
    }
    deduped.push(point);
  }

  return deduped.map((point) => ({
    time: round(point.time, 3),
    gainDb: round(point.gainDb, 2),
  }));
}
