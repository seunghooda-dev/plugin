import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_STT_BYTES,
  MAX_TTS_CHARACTERS,
  OPENAI_API_KEY_STORAGE_KEY,
  SpeechApiClient,
  SpeechApiError,
  readOpenAIApiKey,
  transcriptToSrt,
  validateSpeechEndpoint,
  type SpeechFetch,
  type SpeechResponseLike,
} from "../src/speech";

function response(options: {
  ok?: boolean;
  status?: number;
  bytes?: Uint8Array;
  payload?: unknown;
} = {}): SpeechResponseLike {
  const bytes = options.bytes ?? new Uint8Array([1, 2, 3]);
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

describe("SpeechApiClient TTS", () => {
  it("sends official speech fields and returns audio bytes", async () => {
    let capturedUrl = "";
    let captured: RequestInit | undefined;
    const client = clientWith(async (url, init) => {
      capturedUrl = url;
      captured = init;
      return response({ bytes: new Uint8Array([9, 8, 7]) });
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
    assert.deepEqual([...result.bytes], [9, 8, 7]);
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
