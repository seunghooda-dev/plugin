// 클립 등장/퇴장 모션의 easing 곡선과 키프레임 샘플을 계산하는 순수 함수 (Premiere Host 비의존).
// Premiere 내장 보간은 Linear/Bezier뿐이라, spring/bounce는 촘촘한 샘플 키프레임으로 근사한다.

export type MotionEasing = "linear" | "ease-out" | "spring" | "bounce";
export type MotionDirection = "left" | "right" | "top" | "bottom";
export type MotionKind = "in" | "out";

export interface MotionSample {
  /** 모션 시작 기준 상대 시각(초). */
  readonly timeSeconds: number;
  /** eased 진행도. 0=시작 위치, 1=제자리. spring/bounce는 도중 1을 넘을 수 있다. */
  readonly progress: number;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** 정규화 시간 t(0..1)를 eased 진행도로 바꾼다. easeProgress(_,0)=0, easeProgress(_,1)=1. */
export function easeProgress(easing: MotionEasing, t: number): number {
  const x = clamp01(t);
  switch (easing) {
    case "linear":
      return x;
    case "ease-out":
      return 1 - (1 - x) ** 3;
    case "spring": {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      // 감쇠 진동 후 1로 수렴(under-damped).
      const omega = 8;
      const zeta = 0.35;
      const damped = omega * Math.sqrt(1 - zeta * zeta);
      return 1 - Math.exp(-zeta * omega * x) * (Math.cos(damped * x) + ((zeta * omega) / damped) * Math.sin(damped * x));
    }
    case "bounce": {
      // 표준 bounce-out.
      const n1 = 7.5625;
      const d1 = 2.75;
      let t2 = x;
      if (t2 < 1 / d1) return n1 * t2 * t2;
      if (t2 < 2 / d1) {
        t2 -= 1.5 / d1;
        return n1 * t2 * t2 + 0.75;
      }
      if (t2 < 2.5 / d1) {
        t2 -= 2.25 / d1;
        return n1 * t2 * t2 + 0.9375;
      }
      t2 -= 2.625 / d1;
      return n1 * t2 * t2 + 0.984375;
    }
    default:
      return x;
  }
}

/** 모션 길이를 fps로 샘플링해 (시각, 진행도) 배열을 만든다. "out"은 진행도를 뒤집는다(1→0). */
export function computeMotionSamples(
  kind: MotionKind,
  easing: MotionEasing,
  durationSeconds: number,
  fps = 30,
): MotionSample[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isFinite(fps) || fps <= 0) {
    return [];
  }
  const steps = Math.max(1, Math.min(600, Math.round(durationSeconds * fps)));
  const samples: MotionSample[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const eased = easeProgress(easing, t);
    const progress = kind === "out" ? 1 - eased : eased;
    samples.push({ timeSeconds: round(t * durationSeconds, 4), progress: round(progress, 5) });
  }
  return samples;
}

/** 방향별 시작 오프셋(정규화, 화면 폭/높이 배수). 슬라이드 인의 "화면 밖" 시작점. */
export function directionOffset(direction: MotionDirection): { x: number; y: number } {
  switch (direction) {
    case "left":
      return { x: -1, y: 0 };
    case "right":
      return { x: 1, y: 0 };
    case "top":
      return { x: 0, y: -1 };
    case "bottom":
      return { x: 0, y: 1 };
    default:
      return { x: 0, y: 0 };
  }
}
