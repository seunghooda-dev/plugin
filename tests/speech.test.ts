import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_STT_BYTES,
  MAX_TRANSCRIPT_CHARACTERS,
  MAX_TRANSCRIPT_SEGMENT_CHARACTERS,
  MAX_TRANSCRIPT_SRT_CHARACTERS,
  MAX_TTS_CHARACTERS,
  OPENAI_API_KEY_STORAGE_KEY,
  SpeechApiClient,
  SpeechApiError,
  readOpenAIApiKey,
  transcriptToSrt,
  validateSttResult,
  validateSpeechEndpoint,
  validateTtsResult,
  type SpeechFetch,
  type SpeechResponseLike,
} from "../src/speech";

function audioBytes(format: "wav" | "mp3" | "aac" | "flac"): Uint8Array {
  if (format === "wav") {
    const bytes = new Uint8Array(44);
    bytes.set([82, 73, 70, 70], 0); // RIFF
    bytes.set([36, 0, 0, 0], 4);
    bytes.set([87, 65, 86, 69], 8); // WAVE
    return bytes;
  }
  if (format === "flac") return Uint8Array.from([102, 76, 97, 67, 0, 0, 0, 0]); // fLaC
  if (format === "aac") return Uint8Array.from([0xff, 0xf1, 0x50, 0x80]);
  return Uint8Array.from([0xff, 0xfb, 0x90, 0x64]);
}

function response(options: {
  ok?: boolean;
  status?: number;
  bytes?: Uint8Array;
  payload?: unknown;
} = {}): SpeechResponseLike {
  const bytes = options.bytes ?? audioBytes("mp3");
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    async arrayBuffer() { return bytes.slice().buffer; },
    async json() { return options.payload ?? {}; },
    async text() { return JSON.stringify(options.payload ?? {}); },
  };
}

function clientWith(fetcher: SpeechFetch): SpeechApiClient {
  return new SpeechApiClient({
    fetcher,
    apiKeyProvider: async () => "sk-proj-this-is-a-valid-test-key-1234567890",
    timeoutMs: 5_000,
  });
}

describe("validateSpeechEndpoint", () => {
  it("normalizes the official endpoint", () => {
    assert.equal(validateSpeechEndpoint("https://api.openai.com/v1/"), "https://api.openai.com/v1");
  });

  it("permits a trusted custom HTTPS path", () => {
    assert.equal(validateSpeechEndpoint("https://ai.example.com/openai/v1"), "https://ai.example.com/openai/v1");
  });

  it("rejects HTTP, credentials, query strings, and private hosts", () => {
    for (const value of [
      "http://api.openai.com/v1",
      "https://user:pass@example.com/v1",
      "https://example.com/v1?key=secret",
      "https://localhost/v1",
      "https://127.0.0.1/v1",
      "https://10.1.2.3/v1",
      "https://192.168.0.5/v1",
      "https://metadata.service.internal/v1",
      "https://[::ffff:127.0.0.1]/v1",
      "https://[::ffff:10.0.0.1]/v1",
      "https://[fc00::1]/v1",
      "https://[fe80::1]/v1",
      "not-a-url",
    ]) {
      assert.throws(() => validateSpeechEndpoint(value), SpeechApiError);
    }
  });
});

describe("secure API key read", () => {
  it("decodes the common secureStorage key", async () => {
    let received = "";
    const key = await readOpenAIApiKey({
      async getItem(name) {
        received = name;
        return new TextEncoder().encode(" sk-test-key ");
      },
    });
    assert.equal(received, OPENAI_API_KEY_STORAGE_KEY);
    assert.equal(key, "sk-test-key");
  });

  it("returns an empty key when secure storage is unavailable", async () => {
    assert.equal(await readOpenAIApiKey({ async getItem() { throw new Error("missing"); } }), "");
  });
});

describe("transcriptToSrt", () => {
  it("formats milliseconds and speaker labels", () => {
    const srt = transcriptToSrt([
      { start: 0, end: 1.234, text: "안녕하세요", speaker: "A" },
      { start: 61.2, end: 62, text: "두 번째 줄" },
    ]);
    assert.equal(
      srt,
      "1\n00:00:00,000 --> 00:00:01,234\n[A] 안녕하세요\n\n2\n00:01:01,200 --> 00:01:02,000\n두 번째 줄\n",
    );
  });

  it("skips invalid and empty segments", () => {
    assert.equal(transcriptToSrt([
      { start: 1, end: 1, text: "same" },
      { start: 2, end: 3, text: "  " },
    ]), "");
  });

  it("sorts output deterministically and keeps speaker labels inside one SRT line", () => {
    const srt = transcriptToSrt([
      { start: 2, end: 3, text: "later", speaker: "A\n] injected" },
      { start: 0, end: 1, text: "first", speaker: "B" },
    ]);
    assert.match(srt, /^1\n00:00:00,000 --> 00:00:01,000\n\[B\] first/u);
    assert.match(srt, /\[A injected\] later/u);
    assert.doesNotMatch(srt, /\n\] injected/u);
  });
});

describe("injected speech result boundaries", () => {
  it("copies valid TTS bytes and rejects empty or MIME/extension mismatches", () => {
    const request = { text: "test", model: "tts-1", voice: "alloy", format: "mp3", speed: 1 } as const;
    const bytes = audioBytes("mp3");
    const result = validateTtsResult({ bytes, mimeType: "audio/mpeg", extension: "mp3", model: "tts-1", voice: "alloy" }, request);
    bytes[0] = 9;
    assert.notEqual(result.bytes[0], 9);
    assert.throws(
      () => validateTtsResult({ bytes: new Uint8Array(), mimeType: "audio/mpeg", extension: "mp3", model: "tts-1", voice: "alloy" }, request),
      /빈 음성/u,
    );
    assert.throws(
      () => validateTtsResult({ bytes: Uint8Array.from([1]), mimeType: "audio/wav", extension: "mp3", model: "tts-1", voice: "alloy" }, request),
      /MIME/u,
    );
    assert.throws(
      () => validateTtsResult({ bytes: audioBytes("wav"), mimeType: "audio/wav", extension: "wav", model: "tts-1", voice: "alloy" }, request),
      /요청한/u,
    );
  });

  it("rejects TTS bytes that do not match the requested audio container", () => {
    assert.throws(
      () => validateTtsResult({
        bytes: audioBytes("mp3"),
        mimeType: "audio/wav",
        extension: "wav",
        model: "gpt-4o-mini-tts",
        voice: "marin",
      }),
      /오디오 데이터/u,
    );
    for (const format of ["wav", "mp3", "aac", "flac"] as const) {
      assert.equal(validateTtsResult({
        bytes: audioBytes(format),
        mimeType: format === "wav" ? "audio/wav" : format === "aac" ? "audio/aac" : format === "flac" ? "audio/flac" : "audio/mpeg",
        extension: format,
        model: "gpt-4o-mini-tts",
        voice: "marin",
      }).extension, format);
    }
  });

  it("sorts and sanitizes STT segments before rebuilding SRT", () => {
    const result = validateSttResult({
      text: "원고",
      model: "whisper-1",
      srt: "untrusted order",
      segments: [
        { start: 2, end: 3, text: "later" },
        { start: "0", end: 1, text: "coerced" },
        { start: 0, end: 1, text: "first" },
      ],
    }, "whisper-1");
    assert.deepEqual(result.segments.map((segment) => segment.text), ["first", "later"]);
    assert.match(result.srt, /^1\n00:00:00,000 --> 00:00:01,000\nfirst/u);
  });

  it("rejects oversized transcript text and SRT before file output", () => {
    assert.throws(() => validateSttResult({
      text: "x".repeat(MAX_TRANSCRIPT_CHARACTERS + 1),
      model: "whisper-1",
      srt: "",
      segments: [],
    }, "whisper-1"), /원고 응답/u);
    assert.throws(() => validateSttResult({
      text: "ok",
      model: "whisper-1",
      srt: "x".repeat(MAX_TRANSCRIPT_SRT_CHARACTERS + 1),
      segments: [],
    }, "whisper-1"), /SRT 응답/u);
  });
});

describe("SpeechApiClient TTS", () => {
  it("sends official speech fields and returns audio bytes", async () => {
    let capturedUrl = "";
    let captured: RequestInit | undefined;
    const client = clientWith(async (url, init) => {
      capturedUrl = url;
      captured = init;
      return response({ bytes: audioBytes("wav") });
    });
    const result = await client.synthesize({
      text: "안녕하세요",
      model: "gpt-4o-mini-tts",
      voice: "marin",
      format: "wav",
      speed: 1.15,
      instructions: "따뜻하고 또렷하게",
    });
    assert.equal(capturedUrl, "https://api.openai.com/v1/audio/speech");
    const authorization = (captured?.headers as Record<string, string> | undefined)?.Authorization ?? "";
    assert.equal(authorization.startsWith("Bearer sk-"), true);
    assert.deepEqual(JSON.parse(String(captured?.body)), {
      model: "gpt-4o-mini-tts",
      voice: "marin",
      input: "안녕하세요",
      response_format: "wav",
      speed: 1.15,
      instructions: "따뜻하고 또렷하게",
    });
    assert.equal(result.bytes.byteLength, 44);
    assert.equal(result.mimeType, "audio/wav");
  });

  it("omits unsupported instructions for TTS-1", async () => {
    let body: Record<string, unknown> = {};
    const client = clientWith(async (_url, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return response();
    });
    await client.synthesize({
      text: "test",
      model: "tts-1",
      voice: "alloy",
      format: "mp3",
      speed: 1,
      instructions: "ignored",
    });
    assert.equal(Object.prototype.hasOwnProperty.call(body, "instructions"), false);
  });

  it("enforces character and speed limits before network access", async () => {
    let calls = 0;
    const client = clientWith(async () => { calls += 1; return response(); });
    await assert.rejects(() => client.synthesize({
      text: "가".repeat(MAX_TTS_CHARACTERS + 1),
      model: "gpt-4o-mini-tts",
      voice: "cedar",
      format: "wav",
      speed: 1,
    }), SpeechApiError);
    await assert.rejects(() => client.synthesize({
      text: "test",
      model: "gpt-4o-mini-tts",
      voice: "cedar",
      format: "wav",
      speed: 4.1,
    }), SpeechApiError);
    assert.equal(calls, 0);
  });

  it("never echoes an API key from an error response", async () => {
    const secret = "sk-proj-this-is-a-valid-test-key-1234567890";
    const client = clientWith(async () => response({
      ok: false,
      status: 401,
      payload: { error: { message: `Bearer ${secret} rejected` } },
    }));
    await assert.rejects(
      () => client.synthesize({ text: "test", model: "tts-1", voice: "alloy", format: "mp3", speed: 1 }),
      (error: unknown) => error instanceof SpeechApiError && !error.message.includes(secret),
    );
  });

  it("never echoes a non-OpenAI-shaped custom API key from network errors", async () => {
    const secret = "custom-secret-value-1234567890";
    const client = new SpeechApiClient({
      apiKeyProvider: async () => secret,
      fetcher: async () => { throw new Error(`socket failed for ${secret}`); },
      timeoutMs: 5_000,
    });
    await assert.rejects(
      () => client.synthesize({ text: "test", model: "tts-1", voice: "alloy", format: "mp3", speed: 1 }),
      (error: unknown) => error instanceof SpeechApiError && !error.message.includes(secret),
    );
  });

  it("rejects an empty audio response", async () => {
    const client = clientWith(async () => response({ bytes: new Uint8Array() }));
    await assert.rejects(
      () => client.synthesize({ text: "test", model: "tts-1", voice: "alloy", format: "mp3", speed: 1 }),
      /빈 음성/u,
    );
  });

  it("times out when fetch ignores AbortSignal", async () => {
    const client = new SpeechApiClient({
      apiKeyProvider: async () => "sk-proj-this-is-a-valid-test-key-1234567890",
      fetcher: async () => new Promise<SpeechResponseLike>(() => undefined),
      setTimer: (handler) => { handler(); return 1; },
      clearTimer: () => undefined,
    });
    await assert.rejects(
      () => client.synthesize({ text: "test", model: "tts-1", voice: "alloy", format: "mp3", speed: 1 }),
      (error: unknown) => error instanceof SpeechApiError && error.code === "TIMEOUT",
    );
  });

  it("honors an already-aborted caller signal before any TTS network access", async () => {
    let calls = 0;
    const aborter = new AbortController();
    aborter.abort();
    const client = clientWith(async () => { calls += 1; return response(); });
    await assert.rejects(
      () => client.synthesize({
        text: "test", model: "tts-1", voice: "alloy", format: "mp3", speed: 1, signal: aborter.signal,
      }),
      (error: unknown) => error instanceof SpeechApiError && error.code === "CANCELLED",
    );
    assert.equal(calls, 0);
  });
});

describe("SpeechApiClient STT", () => {
  it("requests diarized JSON and generates a timed SRT", async () => {
    let form: FormData | null = null;
    const client = clientWith(async (_url, init) => {
      form = init?.body as FormData;
      return response({ payload: {
        text: "첫 문장 두 번째 문장",
        segments: [
          { start: 0, end: 1.5, speaker: "speaker_0", text: "첫 문장" },
          { start: 1.5, end: 3, speaker: "speaker_1", text: "두 번째 문장" },
        ],
      } });
    });
    const result = await client.transcribe({
      bytes: new Uint8Array([1, 2]),
      filename: "voice.wav",
      mimeType: "audio/wav",
      model: "gpt-4o-transcribe-diarize",
      language: "ko",
      prompt: "ignored for diarization",
    });
    const submitted = form as unknown as FormData;
    assert.ok(submitted);
    assert.equal(submitted.get("model"), "gpt-4o-transcribe-diarize");
    assert.equal(submitted.get("response_format"), "diarized_json");
    assert.equal(submitted.get("chunking_strategy"), "auto");
    assert.equal(submitted.get("prompt"), null);
    assert.equal(result.segments.length, 2);
    assert.match(result.srt, /\[speaker_0\] 첫 문장/u);
  });

  it("requests Whisper segment timestamps", async () => {
    let form: FormData | null = null;
    const client = clientWith(async (_url, init) => {
      form = init?.body as FormData;
      return response({ payload: {
        text: "hello",
        segments: [{ start: 0, end: 1, text: "hello" }],
      } });
    });
    await client.transcribe({
      bytes: new Uint8Array([1]),
      filename: "voice.mp3",
      mimeType: "audio/mpeg",
      model: "whisper-1",
      prompt: "ShortFlow",
    });
    assert.equal(form!.get("response_format"), "verbose_json");
    assert.equal(form!.get("timestamp_granularities[]"), "segment");
    assert.equal(form!.get("prompt"), "ShortFlow");
  });

  it("accepts exactly 25MB and rejects one byte more", async () => {
    let calls = 0;
    const client = clientWith(async () => {
      calls += 1;
      return response({ payload: { text: "ok" } });
    });
    await client.transcribe({
      bytes: new Uint8Array(MAX_STT_BYTES),
      filename: "limit.wav",
      mimeType: "audio/wav",
      model: "gpt-4o-transcribe",
    });
    await assert.rejects(() => client.transcribe({
      bytes: new Uint8Array(MAX_STT_BYTES + 1),
      filename: "too-big.wav",
      mimeType: "audio/wav",
      model: "gpt-4o-transcribe",
    }), /25MB/u);
    assert.equal(calls, 1);
  });

  it("rejects malformed language and empty transcript responses", async () => {
    const client = clientWith(async () => response({ payload: { text: "" } }));
    await assert.rejects(() => client.transcribe({
      bytes: new Uint8Array([1]), filename: "a.wav", mimeType: "audio/wav",
      model: "gpt-4o-transcribe", language: "../../ko",
    }), /언어 코드/u);
    await assert.rejects(() => client.transcribe({
      bytes: new Uint8Array([1]), filename: "a.wav", mimeType: "audio/wav",
      model: "gpt-4o-transcribe", language: "ko",
    }), /빈 원고/u);
  });

  it("normalizes STT hints and rejects oversized hints before network access", async () => {
    let form: FormData | null = null;
    const client = clientWith(async (_url, init) => {
      form = init?.body as FormData;
      return response({ payload: { text: "ok" } });
    });
    await client.transcribe({
      bytes: new Uint8Array([1]), filename: "voice.wav", mimeType: "audio/wav",
      model: "gpt-4o-transcribe", prompt: "project\n terminology\u0000",
    });
    assert.ok(form);
    assert.equal((form as FormData).get("prompt"), "project terminology");

    let calls = 0;
    const limited = clientWith(async () => { calls += 1; return response({ payload: { text: "ok" } }); });
    await assert.rejects(() => limited.transcribe({
      bytes: new Uint8Array([1]), filename: "voice.wav", mimeType: "audio/wav",
      model: "gpt-4o-transcribe", prompt: "x".repeat(1_001),
    }), /1,000/u);
    assert.equal(calls, 0);
  });

  it("rejects traversal filenames and MIME-extension mismatches before network access", async () => {
    let calls = 0;
    const client = clientWith(async () => { calls += 1; return response({ payload: { text: "ok" } }); });
    for (const request of [
      { filename: "../private.wav", mimeType: "audio/wav" },
      { filename: "voice.wav", mimeType: "video/mp4" },
      { filename: "voice.exe", mimeType: "audio/wav" },
    ]) {
      await assert.rejects(() => client.transcribe({
        bytes: new Uint8Array([1]),
        model: "gpt-4o-transcribe",
        ...request,
      }), SpeechApiError);
    }
    assert.equal(calls, 0);
  });

  it("caps hostile transcript segment collections", async () => {
    const client = clientWith(async () => response({
      payload: {
        text: "ok",
        segments: Array.from({ length: 10_100 }, (_value, index) => ({
          start: index,
          end: index + 0.5,
          text: `segment ${index}`,
        })),
      },
    }));
    const result = await client.transcribe({
      bytes: new Uint8Array([1]),
      filename: "voice.wav",
      mimeType: "audio/wav",
      model: "gpt-4o-transcribe-diarize",
    });
    assert.equal(result.segments.length, 10_000);
  });
});

describe("SpeechApiClient TTS boundary hardening", () => {
  it("accepts exactly 4,096 script characters and both speed bounds", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const client = clientWith(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return response();
    });
    await client.synthesize({
      text: "가".repeat(MAX_TTS_CHARACTERS),
      model: "tts-1",
      voice: "alloy",
      format: "mp3",
      speed: 0.25,
    });
    await client.synthesize({ text: "끝", model: "tts-1", voice: "alloy", format: "mp3", speed: 4 });
    assert.equal(String(bodies[0]?.input).length, MAX_TTS_CHARACTERS);
    assert.equal(bodies[0]?.speed, 0.25);
    assert.equal(bodies[1]?.speed, 4);
  });

  it("rejects whitespace-only scripts and out-of-range or non-finite speeds before network access", async () => {
    let calls = 0;
    const client = clientWith(async () => { calls += 1; return response(); });
    await assert.rejects(
      () => client.synthesize({ text: "   ", model: "tts-1", voice: "alloy", format: "mp3", speed: 1 }),
      /입력해 주세요/u,
    );
    await assert.rejects(
      () => client.synthesize({ text: "test", model: "tts-1", voice: "alloy", format: "mp3", speed: 0.24 }),
      /0\.25배/u,
    );
    await assert.rejects(
      () => client.synthesize({ text: "test", model: "tts-1", voice: "alloy", format: "mp3", speed: Number.NaN }),
      /0\.25배/u,
    );
    assert.equal(calls, 0);
  });

  it("rejects over-limit gpt-4o-mini-tts instructions before network access", async () => {
    let calls = 0;
    const client = clientWith(async () => { calls += 1; return response(); });
    await assert.rejects(() => client.synthesize({
      text: "test",
      model: "gpt-4o-mini-tts",
      voice: "marin",
      format: "mp3",
      speed: 1,
      instructions: "가".repeat(MAX_TTS_CHARACTERS + 1),
    }), /말투 지시/u);
    assert.equal(calls, 0);
  });

  it("rejects an OK response whose bytes are not the requested audio container", async () => {
    const client = clientWith(async () => response({
      bytes: new TextEncoder().encode('{"error":"masked upstream failure"}'),
    }));
    await assert.rejects(
      () => client.synthesize({ text: "test", model: "tts-1", voice: "alloy", format: "mp3", speed: 1 }),
      /오디오 데이터/u,
    );
  });

  it("rejects short or whitespace-containing stored API keys before network access", async () => {
    for (const key of ["", "sk-short", "sk-proj-key with-space-0123456789"]) {
      let calls = 0;
      const client = new SpeechApiClient({
        apiKeyProvider: async () => key,
        fetcher: async () => { calls += 1; return response(); },
      });
      await assert.rejects(
        () => client.synthesize({ text: "test", model: "tts-1", voice: "alloy", format: "mp3", speed: 1 }),
        (error: unknown) => error instanceof SpeechApiError && error.code === "API_KEY_REQUIRED",
      );
      assert.equal(calls, 0);
    }
  });

  it("clamps configured timeouts into the 5s-180s window and clears the timer after success", async () => {
    const observed: number[] = [];
    const cleared: unknown[] = [];
    const build = (timeoutMs: number): SpeechApiClient => new SpeechApiClient({
      apiKeyProvider: async () => "sk-proj-this-is-a-valid-test-key-1234567890",
      fetcher: async () => response(),
      timeoutMs,
      setTimer: (_handler, milliseconds) => { observed.push(milliseconds); return `timer-${milliseconds}`; },
      clearTimer: (handle) => { cleared.push(handle); },
    });
    await build(1).synthesize({ text: "test", model: "tts-1", voice: "alloy", format: "mp3", speed: 1 });
    await build(999_999_999).synthesize({ text: "test", model: "tts-1", voice: "alloy", format: "mp3", speed: 1 });
    assert.deepEqual(observed, [5_000, 180_000]);
    assert.deepEqual(cleared, ["timer-5000", "timer-180000"]);
  });

  it("cancels a pending request on mid-flight abort and aborts the underlying fetch", async () => {
    let fetchSignal: AbortSignal | null | undefined;
    const aborter = new AbortController();
    const client = clientWith((_url, init) => {
      fetchSignal = init?.signal;
      return new Promise<SpeechResponseLike>(() => undefined);
    });
    const pending = client.synthesize({
      text: "test", model: "tts-1", voice: "alloy", format: "mp3", speed: 1, signal: aborter.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    aborter.abort();
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof SpeechApiError && error.code === "CANCELLED",
    );
    assert.equal(fetchSignal?.aborted, true);
  });

  it("redacts foreign API keys, bearer tokens, and control characters from server error details", async () => {
    const foreign = "sk-other_leaked_key_9876543210";
    const client = clientWith(async () => response({
      ok: false,
      status: 500,
      payload: { error: { message: `Bearer abc.def.ghi \u0001 ${foreign} ${"z".repeat(600)}` } },
    }));
    await assert.rejects(
      () => client.synthesize({ text: "test", model: "tts-1", voice: "alloy", format: "mp3", speed: 1 }),
      (error: unknown) => {
        assert.ok(error instanceof SpeechApiError);
        assert.equal(error.status, 500);
        assert.match(error.message, /HTTP 500/u);
        assert.equal(error.message.includes(foreign), false);
        assert.equal(error.message.includes("abc.def.ghi"), false);
        assert.equal(error.message.includes("\u0001"), false);
        assert.equal(error.message.includes("z".repeat(501)), false);
        return true;
      },
    );
  });
});

describe("SpeechApiClient STT format matrix and malformed responses", () => {
  it("accepts every documented extension and MIME pairing", async () => {
    let calls = 0;
    const client = clientWith(async () => { calls += 1; return response({ payload: { text: "ok" } }); });
    const pairs: Array<[string, string]> = [
      ["mp3", "audio/mpeg"],
      ["mpeg", "audio/mpeg"],
      ["mpga", "audio/mpeg"],
      ["mp4", "video/mp4"],
      ["m4a", "audio/mp4"],
      ["wav", "audio/wav"],
      ["webm", "audio/webm"],
    ];
    for (const [extension, mimeType] of pairs) {
      const result = await client.transcribe({
        bytes: new Uint8Array([1]),
        filename: `voice.${extension}`,
        mimeType,
        model: "gpt-4o-transcribe",
      });
      assert.equal(result.model, "gpt-4o-transcribe");
    }
    assert.equal(calls, pairs.length);
  });

  it("honors an already-aborted caller signal before any STT network access", async () => {
    let calls = 0;
    const aborter = new AbortController();
    aborter.abort();
    const client = clientWith(async () => { calls += 1; return response({ payload: { text: "ok" } }); });
    await assert.rejects(() => client.transcribe({
      bytes: new Uint8Array([1]),
      filename: "voice.wav",
      mimeType: "audio/wav",
      model: "gpt-4o-transcribe",
      signal: aborter.signal,
    }), (error: unknown) => error instanceof SpeechApiError && error.code === "CANCELLED");
    assert.equal(calls, 0);
  });

  it("lowercases and forwards a valid language tag", async () => {
    let form: FormData | null = null;
    const client = clientWith(async (_url, init) => {
      form = init?.body as FormData;
      return response({ payload: { text: "ok" } });
    });
    await client.transcribe({
      bytes: new Uint8Array([1]),
      filename: "voice.wav",
      mimeType: "audio/wav",
      model: "gpt-4o-transcribe",
      language: " KO-KR ",
    });
    assert.equal(form!.get("language"), "ko-kr");
  });

  it("rejects unparseable and non-object transcription payloads", async () => {
    const broken = clientWith(async () => ({
      ok: true,
      status: 200,
      async arrayBuffer() { return new ArrayBuffer(0); },
      async json(): Promise<unknown> { throw new Error("invalid json"); },
    }));
    await assert.rejects(() => broken.transcribe({
      bytes: new Uint8Array([1]), filename: "voice.wav", mimeType: "audio/wav", model: "whisper-1",
    }), /응답 형식/u);

    for (const payload of ["plain text", 42]) {
      const client = clientWith(async () => response({ payload }));
      await assert.rejects(() => client.transcribe({
        bytes: new Uint8Array([1]), filename: "voice.wav", mimeType: "audio/wav", model: "whisper-1",
      }), /응답 형식/u);
    }
  });

  it("filters malformed diarized segments and truncates hostile segment text and speaker labels", async () => {
    const client = clientWith(async () => response({
      payload: {
        text: "ok",
        segments: [
          { start: -1, end: 2, text: "negative start" },
          { start: 3, end: 3, text: "zero duration" },
          { start: 1, end: 2 },
          "not-a-segment",
          { start: 0, end: 1, text: "유".repeat(5_000), speaker: "spk\u0000[0]" },
        ],
      },
    }));
    const result = await client.transcribe({
      bytes: new Uint8Array([1]),
      filename: "voice.wav",
      mimeType: "audio/wav",
      model: "gpt-4o-transcribe-diarize",
    });
    assert.equal(result.segments.length, 1);
    assert.equal(result.segments[0]?.text.length, MAX_TRANSCRIPT_SEGMENT_CHARACTERS);
    assert.equal(result.segments[0]?.speaker, "spk 0");
  });

  it("never echoes an API key from an STT error response", async () => {
    const secret = "sk-proj-this-is-a-valid-test-key-1234567890";
    const client = clientWith(async () => response({
      ok: false,
      status: 401,
      payload: { error: { message: `key ${secret} rejected` } },
    }));
    await assert.rejects(
      () => client.transcribe({
        bytes: new Uint8Array([1]), filename: "voice.wav", mimeType: "audio/wav", model: "whisper-1",
      }),
      (error: unknown) => error instanceof SpeechApiError
        && error.status === 401
        && !error.message.includes(secret)
        && /API 키가 거부/u.test(error.message),
    );
  });
});

describe("injected provider response validation", () => {
  it("rejects TTS responses with unknown models, voices, extensions, or non-record shapes", () => {
    const base = { bytes: audioBytes("mp3"), mimeType: "audio/mpeg", extension: "mp3", model: "tts-1", voice: "alloy" };
    assert.throws(() => validateTtsResult(null), /응답 형식/u);
    assert.throws(() => validateTtsResult([base]), /응답 형식/u);
    assert.throws(() => validateTtsResult({ ...base, model: "tts-hacked" }), /응답 모델/u);
    assert.throws(() => validateTtsResult({ ...base, voice: "unknown-voice" }), /목소리/u);
    assert.throws(() => validateTtsResult({ ...base, extension: "exe" }), /파일 형식/u);
  });

  it("rejects STT responses with mismatched models or non-string SRT fields", () => {
    const base = { text: "ok", segments: [], srt: "", model: "whisper-1" };
    assert.throws(() => validateSttResult({ ...base, model: "gpt-4o-transcribe" }, "whisper-1"), /일치하지/u);
    assert.throws(() => validateSttResult({ ...base, model: "gpt-fake" }), /일치하지/u);
    assert.throws(() => validateSttResult({ ...base, srt: 42 }, "whisper-1"), /SRT 응답 형식/u);
    assert.throws(() => validateSttResult("plain", "whisper-1"), /응답 형식/u);
  });

  it("rejects a rebuilt SRT that exceeds the output cap even when the raw srt field is small", () => {
    const segments = Array.from({ length: 1_300 }, (_value, index) => ({
      start: index,
      end: index + 0.5,
      text: "다".repeat(4_000),
    }));
    assert.throws(
      () => validateSttResult({ text: "ok", srt: "", segments, model: "whisper-1" }, "whisper-1"),
      /정규화된/u,
    );
  });
});
