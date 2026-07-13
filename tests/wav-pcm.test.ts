import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseWavPcm, WavParseError } from "../src/wav-pcm";
import { detectBeats } from "../src/audio-beats";

function writeStr(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

// channels: 채널별 Float 배열. format 1=int16, 3=float32.
function buildWav(channels: number[][], sampleRate: number, format: 1 | 3): Uint8Array {
  const channelCount = channels.length;
  const frames = channels[0]!.length;
  const bytesPerSample = format === 3 ? 4 : 2;
  const blockAlign = channelCount * bytesPerSample;
  const dataSize = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeStr(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(view, 8, "WAVE");
  writeStr(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeStr(view, 36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let f = 0; f < frames; f += 1) {
    for (let c = 0; c < channelCount; c += 1) {
      const value = Math.max(-1, Math.min(1, channels[c]![f]!));
      if (format === 3) {
        view.setFloat32(offset, value, true);
      } else {
        view.setInt16(offset, Math.round(value * 32767), true);
      }
      offset += bytesPerSample;
    }
  }
  return new Uint8Array(buffer);
}

// 정수 PCM(8/16/24/32비트) WAV 빌더. sampleReader의 미검증 분기를 확인하기 위한 것.
function buildWavInt(channel: number[], sampleRate: number, bits: 8 | 16 | 24 | 32): Uint8Array {
  const bytesPerSample = bits / 8;
  const dataSize = channel.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeStr(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(view, 8, "WAVE");
  writeStr(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, bits, true);
  writeStr(view, 36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (const raw of channel) {
    const v = Math.max(-1, Math.min(1, raw));
    if (bits === 8) view.setUint8(offset, Math.round(v * 127) + 128);
    else if (bits === 16) view.setInt16(offset, Math.round(v * 32767), true);
    else if (bits === 24) {
      const iv = Math.round(v * 8388607) & 0xffffff;
      view.setUint8(offset, iv & 0xff);
      view.setUint8(offset + 1, (iv >> 8) & 0xff);
      view.setUint8(offset + 2, (iv >> 16) & 0xff);
    } else view.setInt32(offset, Math.round(v * 2147483647), true);
    offset += bytesPerSample;
  }
  return new Uint8Array(buffer);
}

describe("parseWavPcm bit depths", () => {
  const input = [0, 0.5, -0.5, 0.75, -0.75];
  for (const bits of [8, 16, 24, 32] as const) {
    it(`round-trips ${bits}-bit integer PCM (incl. sign extension)`, () => {
      const result = parseWavPcm(buildWavInt(input, 44100, bits));
      assert.equal(result.samples.length, input.length);
      // 8비트는 매우 거칠어 허용오차를 크게.
      const tolerance = bits === 8 ? 0.02 : bits === 16 ? 1e-3 : 1e-4;
      for (let i = 0; i < input.length; i += 1) {
        assert.ok(
          Math.abs(result.samples[i]! - input[i]!) < tolerance,
          `${bits}-bit i=${i}: got ${result.samples[i]} expected ~${input[i]}`,
        );
      }
    });
  }

  it("parses 64-bit float PCM", () => {
    const channel = [0, 0.321, -0.654];
    const dataSize = channel.length * 8;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    writeStr(view, 0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeStr(view, 8, "WAVE");
    writeStr(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 3, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 44100, true);
    view.setUint32(28, 44100 * 8, true);
    view.setUint16(32, 8, true);
    view.setUint16(34, 64, true);
    writeStr(view, 36, "data");
    view.setUint32(40, dataSize, true);
    channel.forEach((v, i) => view.setFloat64(44 + i * 8, v, true));
    const result = parseWavPcm(new Uint8Array(buffer));
    // samples는 Float32Array라 float64 입력은 float32 정밀도로 저장된다.
    for (let i = 0; i < channel.length; i += 1) {
      assert.ok(Math.abs(result.samples[i]! - channel[i]!) < 1e-6);
    }
  });
});

describe("parseWavPcm", () => {
  it("round-trips a 16-bit mono WAV", () => {
    const input = [0, 0.5, -0.5, 0.25, -0.25];
    const wav = buildWav([input], 48000, 1);
    const result = parseWavPcm(wav);
    assert.equal(result.sampleRate, 48000);
    assert.equal(result.channels, 1);
    assert.equal(result.samples.length, input.length);
    for (let i = 0; i < input.length; i += 1) {
      assert.ok(Math.abs(result.samples[i]! - input[i]!) < 1e-3, `i=${i} got ${result.samples[i]}`);
    }
  });

  it("averages stereo channels to mono", () => {
    const wav = buildWav([[1, 0], [0, 1]], 44100, 1);
    const result = parseWavPcm(wav);
    assert.equal(result.channels, 2);
    assert.equal(result.samples.length, 2);
    assert.ok(Math.abs(result.samples[0]! - 0.5) < 1e-3);
    assert.ok(Math.abs(result.samples[1]! - 0.5) < 1e-3);
  });

  it("parses 32-bit float PCM exactly", () => {
    const input = [0, 0.123, -0.456, 0.789];
    const wav = buildWav([input], 22050, 3);
    const result = parseWavPcm(wav);
    assert.equal(result.sampleRate, 22050);
    for (let i = 0; i < input.length; i += 1) {
      assert.ok(Math.abs(result.samples[i]! - input[i]!) < 1e-6, `i=${i}`);
    }
  });

  it("detects tempo from a 120 BPM click WAV (wav-pcm → detectBeats)", () => {
    const sampleRate = 44100;
    const seconds = 6;
    const total = sampleRate * seconds;
    const channel = new Array<number>(total).fill(0);
    const period = Math.round((sampleRate * 60) / 120);
    for (let start = period; start < total; start += period) {
      for (let i = 0; i < 400 && start + i < total; i += 1) {
        channel[start + i] = Math.exp(-i / 80) * Math.sin((2 * Math.PI * 1200 * i) / sampleRate);
      }
    }
    const wav = buildWav([channel], sampleRate, 3);
    const pcm = parseWavPcm(wav);
    const beats = detectBeats(pcm.samples, pcm.sampleRate);
    assert.ok(Math.abs(beats.bpm - 120) <= 5, `bpm=${beats.bpm}`);
  });

  it("skips unrelated chunks before data", () => {
    // fmt + LIST + data 순서에서도 data를 찾아야 한다.
    const frames = 3;
    const dataSize = frames * 2;
    const listSize = 4;
    const buffer = new ArrayBuffer(12 + 8 + 16 + 8 + listSize + 8 + dataSize);
    const view = new DataView(buffer);
    writeStr(view, 0, "RIFF");
    view.setUint32(4, buffer.byteLength - 8, true);
    writeStr(view, 8, "WAVE");
    writeStr(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, 44100, true);
    view.setUint32(28, 44100 * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(view, 36, "LIST");
    view.setUint32(40, listSize, true);
    // LIST body(4바이트) 건너뜀
    const dataChunk = 44 + listSize;
    writeStr(view, dataChunk, "data");
    view.setUint32(dataChunk + 4, dataSize, true);
    view.setInt16(dataChunk + 8, 16384, true);
    view.setInt16(dataChunk + 10, -16384, true);
    view.setInt16(dataChunk + 12, 32767, true);
    const result = parseWavPcm(new Uint8Array(buffer));
    assert.equal(result.samples.length, 3);
    assert.ok(Math.abs(result.samples[0]! - 0.5) < 1e-3);
  });

  it("throws a clear error for non-WAV or truncated input", () => {
    assert.throws(() => parseWavPcm(new Uint8Array(10)), WavParseError);
    const notWav = new Uint8Array(48);
    assert.throws(() => parseWavPcm(notWav), WavParseError);
  });
});
