// 모노 PCM에서 파형 peaks를 계산하고 SVG로 렌더한다 (UXP에 Canvas·Web Audio가 없어 SVG로 그린다).

export interface WaveformSvgOptions {
  readonly width?: number;
  readonly height?: number;
  readonly color?: string;
}

/**
 * 샘플을 `bins`개 구간으로 나눠 각 구간의 최대 절대 진폭을 구하고 [0, 1]로 정규화한다.
 */
export function computeWaveformPeaks(samples: Float32Array, bins: number): Float32Array {
  if (
    !(samples instanceof Float32Array) ||
    samples.length === 0 ||
    !Number.isInteger(bins) ||
    bins <= 0
  ) {
    return new Float32Array(0);
  }
  const peaks = new Float32Array(bins);
  const perBin = samples.length / bins;
  let max = 0;
  for (let b = 0; b < bins; b += 1) {
    const start = Math.floor(b * perBin);
    const end = Math.min(samples.length, Math.floor((b + 1) * perBin));
    let peak = 0;
    for (let i = start; i < end; i += 1) {
      const amplitude = Math.abs(samples[i] ?? 0);
      if (amplitude > peak) peak = amplitude;
    }
    peaks[b] = peak;
    if (peak > max) max = peak;
  }
  if (max > 0) {
    for (let b = 0; b < bins; b += 1) peaks[b] = peaks[b]! / max;
  }
  return peaks;
}

// caller가 넘긴 색만 허용(SVG 주입 방지). hex 또는 currentColor만.
function safeColor(color: string | undefined): string {
  if (typeof color === "string" && /^(?:#[0-9a-fA-F]{3,8}|currentColor)$/u.test(color)) {
    return color;
  }
  return "currentColor";
}

/**
 * peaks를 세로 막대 SVG 문자열로 렌더한다. 입력은 숫자(peaks)와 검증된 색뿐이라 주입 위험이 없다.
 */
export function renderWaveformSvg(peaks: Float32Array, options: WaveformSvgOptions = {}): string {
  const width = Number.isFinite(options.width) && (options.width as number) > 0 ? Math.floor(options.width as number) : 600;
  const height = Number.isFinite(options.height) && (options.height as number) > 0 ? Math.floor(options.height as number) : 80;
  const color = safeColor(options.color);
  const bins = peaks instanceof Float32Array ? peaks.length : 0;
  const header = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="오디오 파형" fill="${color}">`;
  if (bins === 0) return `${header}</svg>`;

  const barWidth = width / bins;
  const drawWidth = Math.max(0.5, barWidth * 0.8);
  let bars = "";
  for (let i = 0; i < bins; i += 1) {
    const peak = Math.max(0, Math.min(1, peaks[i] ?? 0));
    const barHeight = Math.max(1, peak * (height - 2));
    const x = (i * barWidth).toFixed(2);
    const y = ((height - barHeight) / 2).toFixed(2);
    bars += `<rect x="${x}" y="${y}" width="${drawWidth.toFixed(2)}" height="${barHeight.toFixed(2)}" />`;
  }
  return `${header}${bars}</svg>`;
}
