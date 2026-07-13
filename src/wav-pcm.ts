// WAV 파일 바이트에서 모노 Float32 PCM을 직접 파싱한다 (UXP에 Web Audio가 없어 디코더 대체 경로).

export interface WavPcm {
  /** 채널 평균으로 모노화한 Float32 PCM([-1, 1]). */
  readonly samples: Float32Array;
  readonly sampleRate: number;
  readonly channels: number;
}

export class WavParseError extends Error {
  override readonly name = "WavParseError";
}

function readFourCc(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/**
 * PCM(정수 8/16/24/32비트)·IEEE float(32/64비트) WAV을 지원한다. MP3/AAC 등 압축 포맷은
 * 이 파서로 열 수 없으므로 호출부가 확장자/포맷으로 걸러야 한다.
 */
export function parseWavPcm(bytes: Uint8Array): WavPcm {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 44) {
    throw new WavParseError("WAV 데이터가 너무 짧거나 올바르지 않습니다.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readFourCc(view, 0) !== "RIFF" || readFourCc(view, 8) !== "WAVE") {
    throw new WavParseError("RIFF/WAVE 헤더가 아닙니다. WAV 파일이 맞는지 확인해 주세요.");
  }

  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataSize = 0;

  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = readFourCc(view, offset);
    const chunkSize = view.getUint32(offset + 4, true);
    const bodyOffset = offset + 8;
    if (chunkId === "fmt ") {
      audioFormat = view.getUint16(bodyOffset, true);
      channels = view.getUint16(bodyOffset + 2, true);
      sampleRate = view.getUint32(bodyOffset + 4, true);
      bitsPerSample = view.getUint16(bodyOffset + 14, true);
    } else if (chunkId === "data") {
      dataOffset = bodyOffset;
      dataSize = Math.min(chunkSize, bytes.byteLength - bodyOffset);
    }
    // 청크는 2바이트 정렬 — 홀수 크기면 패딩 1바이트 건너뛴다.
    offset = bodyOffset + chunkSize + (chunkSize % 2);
  }

  if (channels <= 0 || sampleRate <= 0 || bitsPerSample <= 0) {
    throw new WavParseError("WAV fmt 청크를 찾지 못했거나 값이 올바르지 않습니다.");
  }
  if (dataOffset < 0 || dataSize <= 0) {
    throw new WavParseError("WAV data 청크를 찾지 못했습니다.");
  }

  const isFloat = audioFormat === 3;
  const bytesPerSample = bitsPerSample / 8;
  if (!Number.isInteger(bytesPerSample) || bytesPerSample < 1) {
    throw new WavParseError(`지원하지 않는 WAV 비트수(${bitsPerSample})입니다.`);
  }
  const readSample = sampleReader(view, isFloat, bitsPerSample);
  if (!readSample) {
    throw new WavParseError(`지원하지 않는 WAV 형식(format=${audioFormat}, bits=${bitsPerSample})입니다.`);
  }

  const frameBytes = bytesPerSample * channels;
  const frameCount = Math.floor(dataSize / frameBytes);
  const samples = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const base = dataOffset + frame * frameBytes;
    let sum = 0;
    for (let ch = 0; ch < channels; ch += 1) {
      sum += readSample(base + ch * bytesPerSample);
    }
    samples[frame] = sum / channels;
  }
  return { samples, sampleRate, channels };
}

function sampleReader(
  view: DataView,
  isFloat: boolean,
  bits: number,
): ((offset: number) => number) | null {
  if (isFloat) {
    if (bits === 32) return (o) => view.getFloat32(o, true);
    if (bits === 64) return (o) => view.getFloat64(o, true);
    return null;
  }
  if (bits === 8) return (o) => (view.getUint8(o) - 128) / 128; // 8비트는 unsigned
  if (bits === 16) return (o) => view.getInt16(o, true) / 32768;
  if (bits === 24) {
    return (o) => {
      const b0 = view.getUint8(o);
      const b1 = view.getUint8(o + 1);
      const b2 = view.getUint8(o + 2);
      let value = b0 | (b1 << 8) | (b2 << 16);
      if (value & 0x800000) value -= 0x1000000; // 부호 확장
      return value / 8388608;
    };
  }
  if (bits === 32) return (o) => view.getInt32(o, true) / 2147483648;
  return null;
}
