// UXP 런타임에 TextEncoder/TextDecoder 전역이 없을 때를 위한 UTF-8 폴리필
function encodeUtf8(value: string): Uint8Array {
  const bytes: number[] = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0xfffd;
    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}

function decodeUtf8(input: ArrayBuffer | ArrayBufferView): string {
  const view = input instanceof ArrayBuffer
    ? new Uint8Array(input)
    : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  let output = "";
  for (let index = 0; index < view.length;) {
    const first = view[index++] ?? 0;
    if (first < 0x80) {
      output += String.fromCodePoint(first);
    } else if (first >= 0xc2 && first <= 0xdf && index < view.length) {
      const second = view[index++] ?? 0x80;
      output += String.fromCodePoint(((first & 0x1f) << 6) | (second & 0x3f));
    } else if (first >= 0xe0 && first <= 0xef && index + 1 < view.length) {
      const second = view[index++] ?? 0x80;
      const third = view[index++] ?? 0x80;
      output += String.fromCodePoint(((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f));
    } else if (first >= 0xf0 && first <= 0xf4 && index + 2 < view.length) {
      const second = view[index++] ?? 0x80;
      const third = view[index++] ?? 0x80;
      const fourth = view[index++] ?? 0x80;
      output += String.fromCodePoint(
        ((first & 0x07) << 18) |
        ((second & 0x3f) << 12) |
        ((third & 0x3f) << 6) |
        (fourth & 0x3f),
      );
    } else {
      output += "�";
    }
  }
  return output;
}

class ShortFlowTextEncoder {
  readonly encoding = "utf-8";

  encode(input = ""): Uint8Array {
    return encodeUtf8(String(input));
  }

  encodeInto(source: string, destination: Uint8Array): TextEncoderEncodeIntoResult {
    const encoded = this.encode(source);
    const written = Math.min(encoded.length, destination.length);
    destination.set(encoded.subarray(0, written));
    return { read: source.length, written };
  }
}

class ShortFlowTextDecoder {
  readonly encoding = "utf-8";
  readonly fatal = false;
  readonly ignoreBOM = false;

  decode(input?: ArrayBuffer | ArrayBufferView | null): string {
    if (!input) return "";
    return decodeUtf8(input);
  }
}

export function installTextEncodingPolyfill(): void {
  const root = globalThis as typeof globalThis & {
    TextEncoder?: typeof TextEncoder;
    TextDecoder?: typeof TextDecoder;
  };
  if (typeof root.TextEncoder === "undefined") {
    root.TextEncoder = ShortFlowTextEncoder as unknown as typeof TextEncoder;
  }
  if (typeof root.TextDecoder === "undefined") {
    root.TextDecoder = ShortFlowTextDecoder as unknown as typeof TextDecoder;
  }
}
