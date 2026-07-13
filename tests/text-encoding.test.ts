// installTextEncodingPolyfill의 UTF-8 인코딩/디코딩 왕복과 전역 비덮어쓰기를 검증하는 테스트
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { installTextEncodingPolyfill } from "../src/text-encoding";

interface PolyfilledEncoder {
  readonly encoding: string;
  encode(input?: string): Uint8Array;
  encodeInto(source: string, destination: Uint8Array): { read: number; written: number };
}

interface PolyfilledDecoder {
  readonly encoding: string;
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
  decode(input?: ArrayBuffer | ArrayBufferView | null): string;
}

type EncoderCtor = new () => PolyfilledEncoder;
type DecoderCtor = new () => PolyfilledDecoder;

interface CodecGlobals {
  TextEncoder?: unknown;
  TextDecoder?: unknown;
}

function codecRoot(): CodecGlobals {
  return globalThis as unknown as CodecGlobals;
}

function restoreDescriptor(descriptor: PropertyDescriptor | undefined, name: string): void {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else delete codecRoot()[name as keyof CodecGlobals];
}

/** 전역 TextEncoder/TextDecoder를 격리해 폴리필을 시험한 뒤 원래 전역을 복원한다. */
function withCodecSandbox(task: () => void): void {
  const encoderDescriptor = Object.getOwnPropertyDescriptor(globalThis, "TextEncoder");
  const decoderDescriptor = Object.getOwnPropertyDescriptor(globalThis, "TextDecoder");
  try {
    task();
  } finally {
    restoreDescriptor(encoderDescriptor, "TextEncoder");
    restoreDescriptor(decoderDescriptor, "TextDecoder");
  }
}

/** 전역을 undefined로 만들어 폴리필을 설치하고 새 인코더/디코더 인스턴스를 돌려준다. */
function installFreshCodec(): { encoder: PolyfilledEncoder; decoder: PolyfilledDecoder } {
  codecRoot().TextEncoder = undefined;
  codecRoot().TextDecoder = undefined;
  installTextEncodingPolyfill();
  const Encoder = codecRoot().TextEncoder as EncoderCtor;
  const Decoder = codecRoot().TextDecoder as DecoderCtor;
  return { encoder: new Encoder(), decoder: new Decoder() };
}

describe("installTextEncodingPolyfill 인코딩/디코딩 왕복", () => {
  it("ASCII·한글·2·3·4바이트 코드포인트를 손실 없이 왕복한다", () => {
    withCodecSandbox(() => {
      const { encoder, decoder } = installFreshCodec();
      assert.equal(encoder.encoding, "utf-8");
      assert.equal(decoder.encoding, "utf-8");
      assert.equal(decoder.fatal, false);
      assert.equal(decoder.ignoreBOM, false);

      const samples = [
        "",
        "Hello, world!",
        "안녕하세요, ShortFlow",
        "2바이트: café ¢ é ñ",
        "3바이트: 한글 € ₩ ✓",
        "4바이트: 😀🎬𝔘 surrogate",
        "혼합 A안B😀C€D",
      ];
      for (const sample of samples) {
        const bytes = encoder.encode(sample);
        assert.ok(bytes instanceof Uint8Array);
        assert.equal(decoder.decode(bytes), sample, `왕복 실패: ${sample}`);
      }
    });
  });

  it("알려진 코드포인트를 정확한 UTF-8 바이트로 인코딩한다", () => {
    withCodecSandbox(() => {
      const { encoder } = installFreshCodec();
      assert.deepEqual([...encoder.encode("A")], [0x41]);
      assert.deepEqual([...encoder.encode("¢")], [0xc2, 0xa2]);
      assert.deepEqual([...encoder.encode("€")], [0xe2, 0x82, 0xac]);
      assert.deepEqual([...encoder.encode("😀")], [0xf0, 0x9f, 0x98, 0x80]);
      assert.deepEqual([...encoder.encode()], []);
    });
  });

  it("encodeInto는 대상 버퍼에 기록하고 read/written을 보고한다", () => {
    withCodecSandbox(() => {
      const { encoder, decoder } = installFreshCodec();

      const roomy = new Uint8Array(16);
      const full = encoder.encodeInto("AB😀", roomy);
      // read는 구현상 소스의 UTF-16 코드 단위 수(이모지는 2)로 보고된다.
      assert.deepEqual(full, { read: 4, written: 6 });
      assert.deepEqual([...roomy.subarray(0, 6)], [0x41, 0x42, 0xf0, 0x9f, 0x98, 0x80]);
      assert.equal(decoder.decode(roomy.subarray(0, 6)), "AB😀");

      const tight = new Uint8Array(3);
      const truncated = encoder.encodeInto("A😀", tight);
      assert.deepEqual(truncated, { read: 3, written: 3 });
      assert.deepEqual([...tight], [0x41, 0xf0, 0x9f]);
    });
  });

  it("잘못되거나 잘린 바이트열은 U+FFFD로 대체한다", () => {
    withCodecSandbox(() => {
      const { decoder } = installFreshCodec();
      assert.equal(decoder.decode(), "");
      assert.equal(decoder.decode(null), "");
      assert.equal(decoder.decode(Uint8Array.from([])), "");

      // 단일 바이트 이상치는 하나의 대체 문자로 치환된다.
      assert.equal(decoder.decode(Uint8Array.from([0xff])), "�");
      assert.equal(decoder.decode(Uint8Array.from([0x80])), "�");
      assert.equal(decoder.decode(Uint8Array.from([0xc2])), "�");

      // 유효 접두부는 보존하고 잘못된 리드 바이트만 치환한다.
      assert.equal(decoder.decode(Uint8Array.from([0x41, 0xff])), "A�");

      // 잘린 멀티바이트 시퀀스는 대체 문자만 남긴다.
      assert.match(decoder.decode(Uint8Array.from([0xe2, 0x82])), /^�+$/u);
      assert.match(decoder.decode(Uint8Array.from([0xf0, 0x9f, 0x98])), /^�+$/u);
    });
  });

  it("이미 존재하는 전역 TextEncoder/TextDecoder를 덮어쓰지 않는다", () => {
    withCodecSandbox(() => {
      const SentinelEncoder = class {};
      const SentinelDecoder = class {};
      codecRoot().TextEncoder = SentinelEncoder;
      codecRoot().TextDecoder = SentinelDecoder;

      installTextEncodingPolyfill();

      assert.equal(codecRoot().TextEncoder, SentinelEncoder);
      assert.equal(codecRoot().TextDecoder, SentinelDecoder);
    });
  });

  it("한쪽 전역만 비어 있으면 그 쪽만 폴리필을 채운다", () => {
    withCodecSandbox(() => {
      const SentinelEncoder = class {};
      codecRoot().TextEncoder = SentinelEncoder;
      codecRoot().TextDecoder = undefined;

      installTextEncodingPolyfill();

      assert.equal(codecRoot().TextEncoder, SentinelEncoder, "존재하는 인코더는 유지되어야 한다.");
      const Decoder = codecRoot().TextDecoder as DecoderCtor;
      assert.equal(new Decoder().decode(Uint8Array.from([0xec, 0x95, 0x88])), "안");
    });
  });
});
