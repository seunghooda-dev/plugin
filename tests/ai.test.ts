import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AIClientError,
  DEFAULT_OPENAI_ENDPOINT,
  MAX_EDIT_IMAGE_BYTES,
  MAX_EDIT_RESPONSE_BYTES,
  OPENAI_API_KEY_STORAGE_KEY,
  OPENAI_IMAGE_MODEL,
  OpenAIImageClient,
  type OpenAIImageAdapter,
  type SecureStorageAdapter,
  buildEditPrompt,
  decodeBase64,
  redactSecret,
  validateEndpoint,
} from "../src/ai";

const API_KEY = "sk-test-super-secret-123456";
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

class MockSecureStorage implements SecureStorageAdapter {
  readonly values = new Map<string, Uint8Array>();

  setItem(key: string, value: Uint8Array): void {
    this.values.set(key, new Uint8Array(value));
  }

  getItem(key: string): Uint8Array | null {
    const value = this.values.get(key);
    return value ? new Uint8Array(value) : null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

class MockBlob {
  readonly parts: readonly unknown[];
  readonly type: string;

  constructor(parts: readonly unknown[] = [], options: { type?: string } = {}) {
    this.parts = parts;
    this.type = options.type ?? "";
  }
}

class MockFormData {
  readonly fields: Array<{ name: string; value: unknown; filename?: string }> = [];

  append(name: string, value: unknown, filename?: string): void {
    const field: { name: string; value: unknown; filename?: string } = { name, value };
    if (filename !== undefined) field.filename = filename;
    this.fields.push(field);
  }
}

type FetchCall = { url: string; init: Record<string, unknown> };

function mockResponse(
  status: number,
  payload: unknown = { data: [{ b64_json: "iVBORw0KGgo=" }] },
): Record<string, unknown> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
  };
}

function createAdapter(
  fetchImplementation: (url: string, init: Record<string, unknown>) => Promise<unknown> =
    async () => mockResponse(200),
): { adapter: OpenAIImageAdapter; storage: MockSecureStorage; calls: FetchCall[]; sleeps: number[] } {
  const storage = new MockSecureStorage();
  const calls: FetchCall[] = [];
  const sleeps: number[] = [];
  return {
    adapter: {
      secureStorage: storage,
      fetch: async (url: string, init: Record<string, unknown> = {}) => {
        calls.push({ url, init });
        return fetchImplementation(url, init);
      },
      FormData: MockFormData,
      Blob: MockBlob,
      sleep: async (milliseconds: number) => {
        sleeps.push(milliseconds);
      },
    },
    storage,
    calls,
    sleeps,
  };
}

function inputImage(
  overrides: Partial<{ bytes: Uint8Array; filename: string; mimeType: string }> = {},
) {
  return {
    bytes: new Uint8Array([1, 2, 3]),
    filename: "input.png",
    mimeType: "image/png",
    ...overrides,
  };
}

async function readyClient(
  fetchImplementation?: (url: string, init: Record<string, unknown>) => Promise<unknown>,
) {
  const context = createAdapter(fetchImplementation);
  const client = new OpenAIImageClient(context.adapter);
  await client.setApiKey(API_KEY);
  return { ...context, client };
}

function expectCode(code: AIClientError["code"]): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof AIClientError);
    assert.equal(error.code, code);
    assert.ok(error.message.length > 0);
    assert.equal(error.message.includes(API_KEY), false);
    return true;
  };
}

describe("OpenAI image constants", () => {
  it("uses only GPT Image 2", () => assert.equal(OPENAI_IMAGE_MODEL, "gpt-image-2"));
  it("uses the official v1 endpoint by default", () =>
    assert.equal(DEFAULT_OPENAI_ENDPOINT, "https://api.openai.com/v1"));
  it("shares the fixed secure-storage key", () =>
    assert.equal(OPENAI_API_KEY_STORAGE_KEY, "shortflow.openai.apiKey"));
});

describe("buildEditPrompt", () => {
  it("builds the basic preset", () => assert.match(buildEditPrompt("basic"), /preserving/iu));
  it("builds the vivid preset", () => assert.match(buildEditPrompt("vivid"), /vivid/iu));
  it("builds the upscale preset without claiming a new composition", () => {
    const prompt = buildEditPrompt("upscale");
    assert.match(prompt, /resolution/iu);
    assert.match(prompt, /without changing/iu);
  });
  it("builds the transparent background preset", () =>
    assert.match(buildEditPrompt("remove-bg"), /transparent background/iu));
  it("returns a trimmed freeform chat prompt", () =>
    assert.equal(buildEditPrompt("chat", "  파란 하늘로 바꿔 줘  "), "파란 하늘로 바꿔 줘"));
  it("appends a freeform instruction to a structured preset", () =>
    assert.match(buildEditPrompt("basic", "Keep the logo"), /User request: Keep the logo$/u));
  it("collapses unsafe prompt whitespace", () =>
    assert.equal(buildEditPrompt("chat", "one\n\t two"), "one two"));
  it("normalizes prompt text and strips control or tag delimiter characters", () =>
    assert.equal(buildEditPrompt("chat", " Ｈｅｒｏ\u0000 <keep> "), "Hero keep"));
  it("rejects an empty chat prompt", () =>
    assert.throws(() => buildEditPrompt("chat", "   "), expectCode("INVALID_INPUT")));
  it("rejects an unknown preset", () =>
    assert.throws(
      () => buildEditPrompt("legacy" as never, "test"),
      expectCode("INVALID_INPUT"),
    ));
  it("rejects an unbounded freeform prompt before allocating a request", () =>
    assert.throws(
      () => buildEditPrompt("chat", "x".repeat(4_097)),
      expectCode("INVALID_INPUT"),
    ));
});

describe("validateEndpoint", () => {
  it("normalizes trailing slashes", () =>
    assert.equal(validateEndpoint("https://api.openai.com/v1///"), DEFAULT_OPENAI_ENDPOINT));
  it("rejects a public HTTPS proxy to keep image requests on the official endpoint", () =>
    assert.throws(
      () => validateEndpoint("https://ai.example.com/openai/v1"),
      expectCode("INVALID_ENDPOINT"),
    ));
  it("rejects HTTP", () =>
    assert.throws(() => validateEndpoint("http://api.openai.com/v1"), expectCode("INVALID_ENDPOINT")));
  it("rejects malformed URLs", () =>
    assert.throws(() => validateEndpoint("not a url"), expectCode("INVALID_ENDPOINT")));
  it("rejects an empty URL", () =>
    assert.throws(() => validateEndpoint(" "), expectCode("INVALID_ENDPOINT")));
  it("rejects credentials embedded in the URL", () =>
    assert.throws(
      () => validateEndpoint("https://user:pass@example.com/v1"),
      expectCode("INVALID_ENDPOINT"),
    ));
  it("rejects query strings", () =>
    assert.throws(() => validateEndpoint("https://example.com/v1?a=1"), expectCode("INVALID_ENDPOINT")));
  it("rejects fragments", () =>
    assert.throws(() => validateEndpoint("https://example.com/v1#x"), expectCode("INVALID_ENDPOINT")));
  it("rejects localhost SSRF targets", () =>
    assert.throws(() => validateEndpoint("https://localhost/v1"), expectCode("INVALID_ENDPOINT")));
  it("rejects loopback IPv4 SSRF targets", () =>
    assert.throws(() => validateEndpoint("https://127.0.0.1/v1"), expectCode("INVALID_ENDPOINT")));
  it("rejects RFC1918 IPv4 SSRF targets", () => {
    for (const host of ["10.0.0.1", "172.16.0.1", "192.168.1.1"]) {
      assert.throws(() => validateEndpoint(`https://${host}/v1`), expectCode("INVALID_ENDPOINT"));
    }
  });
  it("rejects IPv6 loopback targets", () =>
    assert.throws(() => validateEndpoint("https://[::1]/v1"), expectCode("INVALID_ENDPOINT")));
  it("rejects IPv4-mapped IPv6 private targets", () => {
    for (const host of ["[::ffff:127.0.0.1]", "[::ffff:10.0.0.1]", "[::ffff:c0a8:101]"]) {
      assert.throws(() => validateEndpoint(`https://${host}/v1`), expectCode("INVALID_ENDPOINT"));
    }
  });
  it("rejects internal DNS suffixes", () =>
    assert.throws(
      () => validateEndpoint("https://metadata.service.internal/v1"),
      expectCode("INVALID_ENDPOINT"),
    ));
});

describe("redactSecret", () => {
  it("redacts an explicitly supplied secret", () =>
    assert.equal(redactSecret(`failed ${API_KEY}`, API_KEY), "failed [REDACTED]"));
  it("redacts Authorization Bearer headers", () =>
    assert.doesNotMatch(redactSecret(`Authorization: Bearer ${API_KEY}`), /sk-test/u));
  it("redacts OpenAI-like keys without an explicit secret", () =>
    assert.equal(redactSecret("key=sk-proj-abcdefghijk"), "key=[REDACTED]"));
  it("redacts JSON api_key fields", () =>
    assert.doesNotMatch(redactSecret('{"api_key":"very-secret-token"}'), /very-secret/u));
  it("redacts x-api-key headers", () =>
    assert.doesNotMatch(redactSecret(`x-api-key: ${API_KEY}`), /sk-test/u));
  it("accepts Error objects", () =>
    assert.equal(redactSecret(new Error(`boom ${API_KEY}`), API_KEY), "boom [REDACTED]"));
  it("removes control characters and caps redacted error text", () => {
    const redacted = redactSecret(`line1\nline2 ${API_KEY} ${"x".repeat(3_000)}`, API_KEY);
    assert.doesNotMatch(redacted, /[\u0000-\u001f\u007f]/u);
    assert.equal(redacted.includes(API_KEY), false);
    assert.equal(redacted.length, 2_000);
  });
});

describe("decodeBase64", () => {
  it("decodes a padded payload", () =>
    assert.deepEqual([...decodeBase64("AQIDBA==")], [1, 2, 3, 4]));
  it("decodes an unpadded payload", () =>
    assert.deepEqual([...decodeBase64("AQID")], [1, 2, 3]));
  it("ignores transport whitespace", () =>
    assert.deepEqual([...decodeBase64("AQID\nBA==")], [1, 2, 3, 4]));
  it("rejects empty base64", () =>
    assert.throws(() => decodeBase64(""), expectCode("INVALID_RESPONSE")));
  it("rejects invalid alphabet characters", () =>
    assert.throws(() => decodeBase64("%%%="), expectCode("INVALID_RESPONSE")));
  it("rejects misplaced padding", () =>
    assert.throws(() => decodeBase64("A=ID"), expectCode("INVALID_RESPONSE")));
  it("rejects impossible base64 length", () =>
    assert.throws(() => decodeBase64("A"), expectCode("INVALID_RESPONSE")));
  it("rejects a payload that would decode past the 50MB response cap before allocating it", () => {
    const overCapLength = (Math.floor(MAX_EDIT_RESPONSE_BYTES / 3) + 1) * 4;
    assert.throws(
      () => decodeBase64("A".repeat(overCapLength)),
      (error: unknown) => {
        expectCode("INVALID_RESPONSE")(error);
        assert.match((error as Error).message, /50MB/u);
        return true;
      },
    );
  });
});

describe("secure API key storage", () => {
  it("stores UTF-8 bytes under the shared key", async () => {
    const { client, storage } = await readyClient();
    const stored = storage.values.get(OPENAI_API_KEY_STORAGE_KEY);
    assert.ok(stored instanceof Uint8Array);
    assert.equal(new TextDecoder().decode(stored), API_KEY);
    assert.equal(await client.getApiKey(), API_KEY);
  });
  it("trims a key before storing it", async () => {
    const { adapter } = createAdapter();
    const client = new OpenAIImageClient(adapter);
    await client.setApiKey(`  ${API_KEY}  `);
    assert.equal(await client.getApiKey(), API_KEY);
  });
  it("returns null when no key exists", async () => {
    const { adapter } = createAdapter();
    assert.equal(await new OpenAIImageClient(adapter).getApiKey(), null);
  });
  it("removes a saved key", async () => {
    const { client } = await readyClient();
    await client.removeApiKey();
    assert.equal(await client.getApiKey(), null);
  });
  it("rejects empty and newline-injected keys", async () => {
    const { adapter } = createAdapter();
    const client = new OpenAIImageClient(adapter);
    await assert.rejects(client.setApiKey(""), expectCode("INVALID_API_KEY"));
    await assert.rejects(client.setApiKey("sk-test\nAuthorization"), expectCode("INVALID_API_KEY"));
  });
  it("uses a caller-provided secure-storage key", async () => {
    const { adapter, storage } = createAdapter();
    const client = new OpenAIImageClient(adapter, { apiKeyStorageKey: "custom.key" });
    await client.setApiKey(API_KEY);
    assert.ok(storage.values.has("custom.key"));
  });
});

describe("editImage validation", () => {
  it("requires a stored API key", async () => {
    const { adapter } = createAdapter();
    const client = new OpenAIImageClient(adapter);
    await assert.rejects(
      client.editImage({ images: [inputImage()] }),
      expectCode("MISSING_API_KEY"),
    );
  });
  it("requires at least one input image", async () => {
    const { client } = await readyClient();
    await assert.rejects(client.editImage({ images: [] }), expectCode("INVALID_INPUT"));
  });
  it("allows at most four input images", async () => {
    const { client } = await readyClient();
    await assert.rejects(
      client.editImage({ images: Array.from({ length: 5 }, () => inputImage()) }),
      expectCode("INVALID_INPUT"),
    );
  });
  it("rejects an empty image", async () => {
    const { client } = await readyClient();
    await assert.rejects(
      client.editImage({ images: [inputImage({ bytes: new Uint8Array() })] }),
      expectCode("INVALID_INPUT"),
    );
  });
  it("rejects an image over 10MB", async () => {
    const { client } = await readyClient();
    await assert.rejects(
      client.editImage({
        images: [inputImage({ bytes: new Uint8Array(MAX_EDIT_IMAGE_BYTES + 1) })],
      }),
      expectCode("INVALID_INPUT"),
    );
  });
  it("accepts an image exactly 10MB", async () => {
    const { client } = await readyClient();
    const bytes = await client.editImage({
      images: [inputImage({ bytes: new Uint8Array(MAX_EDIT_IMAGE_BYTES) })],
    });
    assert.deepEqual([...bytes], PNG_SIGNATURE);
  });
  it("rejects unsupported MIME types", async () => {
    const { client } = await readyClient();
    await assert.rejects(
      client.editImage({ images: [inputImage({ mimeType: "image/gif" })] }),
      expectCode("INVALID_INPUT"),
    );
  });
  it("rejects a missing filename", async () => {
    const { client } = await readyClient();
    await assert.rejects(
      client.editImage({ images: [inputImage({ filename: "" })] }),
      expectCode("INVALID_INPUT"),
    );
  });
  it("rejects traversal, control bytes, and MIME-extension mismatches in filenames", async () => {
    const { client } = await readyClient();
    for (const image of [
      inputImage({ filename: "../private.png" }),
      inputImage({ filename: "bad\r\nname.png" }),
      inputImage({ filename: "photo.jpg", mimeType: "image/png" }),
    ]) {
      await assert.rejects(client.editImage({ images: [image] }), expectCode("INVALID_INPUT"));
    }
  });
});

describe("GPT Image 2 multipart request", () => {
  it("posts the exact GPT Image 2 edit fields", async () => {
    const { client, calls } = await readyClient();
    const result = await client.editImage({
      images: [inputImage(), inputImage({ filename: "second.webp", mimeType: "image/webp" })],
      preset: "vivid",
      prompt: "Keep the title",
    });
    assert.deepEqual([...result], PNG_SIGNATURE);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, `${DEFAULT_OPENAI_ENDPOINT}/images/edits`);
    assert.equal(calls[0]?.init.method, "POST");
    const form = calls[0]?.init.body as MockFormData;
    assert.equal(form.fields.find((field) => field.name === "model")?.value, "gpt-image-2");
    assert.equal(form.fields.find((field) => field.name === "size")?.value, "1536x1024");
    assert.equal(form.fields.find((field) => field.name === "quality")?.value, "high");
    assert.equal(form.fields.find((field) => field.name === "output_format")?.value, "png");
    assert.equal(form.fields.filter((field) => field.name === "image[]").length, 2);
  });
  it("sets transparent background only for remove-bg", async () => {
    const { client, calls } = await readyClient();
    await client.editImage({ images: [inputImage()], preset: "remove-bg" });
    const form = calls[0]?.init.body as MockFormData;
    assert.equal(form.fields.find((field) => field.name === "background")?.value, "transparent");
  });
  it("does not manually set multipart Content-Type", async () => {
    const { client, calls } = await readyClient();
    await client.editImage({ images: [inputImage()] });
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers["Content-Type"], undefined);
    assert.equal(headers.Authorization, `Bearer ${API_KEY}`);
  });
  it("returns the first PNG b64_json as Uint8Array", async () => {
    const { client } = await readyClient(async () =>
      mockResponse(200, { data: [{ b64_json: "iVBORw0KGgoAAQL/" }] }),
    );
    const value = await client.editImage({ images: [inputImage()] });
    assert.ok(value instanceof Uint8Array);
    assert.deepEqual([...value], [...PNG_SIGNATURE, 0, 1, 2, 255]);
  });
  it("rejects a non-PNG response even when b64_json is present", async () => {
    const { client } = await readyClient(async () =>
      mockResponse(200, { data: [{ b64_json: "AQID" }] }),
    );
    await assert.rejects(client.editImage({ images: [inputImage()] }), expectCode("INVALID_RESPONSE"));
  });
  it("exposes a finite response-size limit", () => {
    assert.ok(MAX_EDIT_RESPONSE_BYTES > MAX_EDIT_IMAGE_BYTES);
  });
  it("rejects a response without b64_json", async () => {
    const { client } = await readyClient(async () => mockResponse(200, { data: [{}] }));
    await assert.rejects(
      client.editImage({ images: [inputImage()] }),
      expectCode("INVALID_RESPONSE"),
    );
  });
  it("rejects an alternate endpoint at client construction", () => {
    const context = createAdapter();
    assert.throws(
      () => new OpenAIImageClient(context.adapter, { endpoint: "https://proxy.example.com/v1/" }),
      expectCode("INVALID_ENDPOINT"),
    );
  });
});

describe("retry, timeout, and safe errors", () => {
  it("retries a 429 response exactly once", async () => {
    let count = 0;
    const { client, calls, sleeps } = await readyClient(async () => {
      count += 1;
      return count === 1 ? mockResponse(429, "rate limited") : mockResponse(200);
    });
    await client.editImage({ images: [inputImage()] });
    assert.equal(calls.length, 2);
    assert.deepEqual(sleeps, [500]);
  });
  it("retries a 5xx response exactly once", async () => {
    let count = 0;
    const { client, calls } = await readyClient(async () => {
      count += 1;
      return count === 1 ? mockResponse(503, "busy") : mockResponse(200);
    });
    await client.editImage({ images: [inputImage()] });
    assert.equal(calls.length, 2);
  });
  it("does not retry a 400 response", async () => {
    const { client, calls } = await readyClient(async () => mockResponse(400, "bad request"));
    await assert.rejects(
      client.editImage({ images: [inputImage()] }),
      expectCode("API_ERROR"),
    );
    assert.equal(calls.length, 1);
  });
  it("stops after the one allowed retry", async () => {
    const { client, calls } = await readyClient(async () => mockResponse(500, "still down"));
    await assert.rejects(
      client.editImage({ images: [inputImage()] }),
      expectCode("API_ERROR"),
    );
    assert.equal(calls.length, 2);
  });
  it("redacts the API key from network errors", async () => {
    const { client } = await readyClient(async () => {
      throw new Error(`socket failed Authorization: Bearer ${API_KEY}`);
    });
    await assert.rejects(
      client.editImage({ images: [inputImage()] }),
      (error: unknown) => {
        expectCode("NETWORK_ERROR")(error);
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes("Authorization: Bearer [REDACTED]"), true);
        return true;
      },
    );
  });
  it("redacts the API key from API response bodies", async () => {
    const { client } = await readyClient(async () =>
      mockResponse(401, `Authorization: Bearer ${API_KEY}`),
    );
    await assert.rejects(
      client.editImage({ images: [inputImage()] }),
      (error: unknown) => {
        expectCode("API_ERROR")(error);
        assert.ok(error instanceof Error);
        assert.match(error.message, /\[REDACTED\]/u);
        return true;
      },
    );
  });
  it("aborts with a typed timeout when AbortController is available", async () => {
    class ImmediateAbortController {
      readonly signal = { aborted: false };
      abort(): void { this.signal.aborted = true; }
    }
    const context = createAdapter(async (_url, init) => {
      const signal = init.signal as { aborted?: boolean };
      if (signal?.aborted) throw new Error("AbortError");
      return mockResponse(200);
    });
    context.adapter.AbortController = ImmediateAbortController;
    context.adapter.setTimeout = (handler: () => void) => { handler(); return 1; };
    context.adapter.clearTimeout = () => undefined;
    const client = new OpenAIImageClient(context.adapter);
    await client.setApiKey(API_KEY);
    await assert.rejects(
      client.editImage({ images: [inputImage()], timeoutMs: 1 }),
      expectCode("TIMEOUT"),
    );
  });

  it("times out when fetch ignores AbortSignal", async () => {
    const context = createAdapter(async () => new Promise(() => undefined));
    context.adapter.setTimeout = (handler: () => void) => { handler(); return 1; };
    context.adapter.clearTimeout = () => undefined;
    const client = new OpenAIImageClient(context.adapter);
    await client.setApiKey(API_KEY);
    await assert.rejects(
      client.editImage({ images: [inputImage()], timeoutMs: 1 }),
      expectCode("TIMEOUT"),
    );
  });
});

describe("connection test", () => {
  it("retrieves the exact GPT Image 2 model without generating an image", async () => {
    const { client, calls } = await readyClient();
    assert.deepEqual(await client.testConnection(), { ok: true, model: "gpt-image-2" });
    assert.equal(calls[0]?.url, `${DEFAULT_OPENAI_ENDPOINT}/models/gpt-image-2`);
    assert.equal(calls[0]?.init.method, "GET");
  });
  it("requires a key before testing", async () => {
    const { adapter } = createAdapter();
    await assert.rejects(
      new OpenAIImageClient(adapter).testConnection(),
      expectCode("MISSING_API_KEY"),
    );
  });
  it("reports an authorization failure without exposing the key", async () => {
    const { client } = await readyClient(async () => mockResponse(401, { error: { message: API_KEY } }));
    await assert.rejects(client.testConnection(), expectCode("API_ERROR"));
  });
});

describe("client construction and secure storage failure paths", () => {
  it("rejects an adapter without secureStorage or fetch", () => {
    assert.throws(() => new OpenAIImageClient(null as never), expectCode("UNSUPPORTED_RUNTIME"));
    assert.throws(
      () => new OpenAIImageClient({ secureStorage: new MockSecureStorage() } as never),
      expectCode("UNSUPPORTED_RUNTIME"),
    );
  });

  it("clamps invalid constructor timeouts to the 60-second default", () => {
    const { adapter } = createAdapter();
    assert.equal(new OpenAIImageClient(adapter).timeoutMs, 60_000);
    assert.equal(new OpenAIImageClient(adapter, { timeoutMs: -5 }).timeoutMs, 60_000);
    assert.equal(new OpenAIImageClient(adapter, { timeoutMs: Number.NaN }).timeoutMs, 60_000);
    assert.equal(new OpenAIImageClient(adapter, { timeoutMs: 1234.7 }).timeoutMs, 1234);
  });

  it("wraps secure storage write, read, and delete failures as UNSUPPORTED_RUNTIME", async () => {
    const failure = new Error(`storage denied for ${API_KEY}`);
    const { adapter } = createAdapter();
    const failing: OpenAIImageAdapter = {
      ...adapter,
      secureStorage: {
        setItem: () => { throw failure; },
        getItem: () => { throw failure; },
        removeItem: () => { throw failure; },
      },
    };
    const client = new OpenAIImageClient(failing);
    await assert.rejects(client.setApiKey(API_KEY), expectCode("UNSUPPORTED_RUNTIME"));
    await assert.rejects(client.getApiKey(), expectCode("UNSUPPORTED_RUNTIME"));
    await assert.rejects(client.removeApiKey(), expectCode("UNSUPPORTED_RUNTIME"));
  });

  it("rejects a corrupted stored key on read and treats blank storage as missing", async () => {
    const { adapter, storage } = createAdapter();
    const client = new OpenAIImageClient(adapter);
    storage.values.set(OPENAI_API_KEY_STORAGE_KEY, new TextEncoder().encode("bad"));
    await assert.rejects(client.getApiKey(), expectCode("INVALID_API_KEY"));
    storage.values.set(OPENAI_API_KEY_STORAGE_KEY, new TextEncoder().encode("   "));
    assert.equal(await client.getApiKey(), null);
  });
});

describe("generateImage text-to-image", () => {
  it("requires a stored API key", async () => {
    const { adapter } = createAdapter();
    const client = new OpenAIImageClient(adapter);
    await assert.rejects(
      client.generateImage({ prompt: "a red fox" }),
      expectCode("MISSING_API_KEY"),
    );
  });
  it("rejects an empty prompt", async () => {
    const { client } = await readyClient();
    await assert.rejects(client.generateImage({ prompt: "   " }), expectCode("INVALID_INPUT"));
  });
  it("rejects an over-length prompt", async () => {
    const { client } = await readyClient();
    await assert.rejects(
      client.generateImage({ prompt: "a".repeat(4_097) }),
      expectCode("INVALID_INPUT"),
    );
  });
  it("rejects an unsupported size", async () => {
    const { client } = await readyClient();
    await assert.rejects(
      client.generateImage({ prompt: "a red fox", size: "512x512" as never }),
      expectCode("INVALID_INPUT"),
    );
  });
  it("posts the exact generation fields as JSON and returns PNG bytes", async () => {
    const { client, calls } = await readyClient();
    const result = await client.generateImage({ prompt: "  a <red> fox  " });
    assert.deepEqual([...result], PNG_SIGNATURE);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, `${DEFAULT_OPENAI_ENDPOINT}/images/generations`);
    assert.equal(calls[0]?.init.method, "POST");
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(headers.Authorization, `Bearer ${API_KEY}`);
    const body = JSON.parse(calls[0]?.init.body as string) as Record<string, unknown>;
    assert.equal(body.model, OPENAI_IMAGE_MODEL);
    assert.equal(body.prompt, "a red fox"); // cleanPrompt strips angle brackets and trims
    assert.equal(body.size, "1024x1024"); // default
    assert.equal(body.output_format, "png");
    assert.equal(body.quality, "medium"); // 생성은 편집(high)보다 빠른 medium
    assert.equal(body.n, 1);
  });
  it("honors a provided size", async () => {
    const { client, calls } = await readyClient();
    await client.generateImage({ prompt: "a red fox", size: "1536x1024" });
    const body = JSON.parse(calls[0]?.init.body as string) as Record<string, unknown>;
    assert.equal(body.size, "1536x1024");
  });
  it("rejects a non-PNG response even when b64_json is present", async () => {
    const { client } = await readyClient(async () => mockResponse(200, { data: [{ b64_json: "AQID" }] }));
    await assert.rejects(client.generateImage({ prompt: "a red fox" }), expectCode("INVALID_RESPONSE"));
  });
  it("rejects a response without b64_json", async () => {
    const { client } = await readyClient(async () => mockResponse(200, { data: [{}] }));
    await assert.rejects(client.generateImage({ prompt: "a red fox" }), expectCode("INVALID_RESPONSE"));
  });
  it("surfaces an API error with the status", async () => {
    const { client } = await readyClient(async () => mockResponse(400, { error: { message: "bad prompt" } }));
    await assert.rejects(client.generateImage({ prompt: "a red fox" }), expectCode("API_ERROR"));
  });
});

function videoFetch(options: {
  pollsUntilComplete?: number;
  failStatus?: boolean;
  neverComplete?: boolean;
  emptyContent?: boolean;
} = {}) {
  const { pollsUntilComplete = 1, failStatus = false, neverComplete = false, emptyContent = false } = options;
  let polls = 0;
  return async (url: string, init: Record<string, unknown>) => {
    const method = (init?.method as string) ?? "GET";
    if (url.endsWith("/videos") && method === "POST") {
      return mockResponse(200, { id: "video_abc123", status: "queued" });
    }
    if (/\/videos\/video_abc123$/u.test(url) && method === "GET") {
      polls += 1;
      if (failStatus) {
        return mockResponse(200, { id: "video_abc123", status: "failed", error: { message: "content policy" } });
      }
      if (neverComplete) return mockResponse(200, { id: "video_abc123", status: "in_progress", progress: 40 });
      return mockResponse(200, { id: "video_abc123", status: polls >= pollsUntilComplete ? "completed" : "in_progress" });
    }
    if (/\/videos\/video_abc123\/content/u.test(url)) {
      const bytes = emptyContent
        ? new Uint8Array(0)
        : new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 1, 2, 3]);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        text: async () => "",
      };
    }
    return mockResponse(404, { error: { message: "unexpected" } });
  };
}

describe("generateVideo (Sora)", () => {
  it("requires a stored API key", async () => {
    const { adapter } = createAdapter();
    const client = new OpenAIImageClient(adapter);
    await assert.rejects(client.generateVideo({ prompt: "a wave" }), expectCode("MISSING_API_KEY"));
  });
  it("rejects an empty prompt", async () => {
    const { client } = await readyClient(videoFetch());
    await assert.rejects(client.generateVideo({ prompt: "   " }), expectCode("INVALID_INPUT"));
  });
  it("rejects an unsupported size or seconds", async () => {
    const { client } = await readyClient(videoFetch());
    await assert.rejects(
      client.generateVideo({ prompt: "a wave", size: "9999x9999" as never }),
      expectCode("INVALID_INPUT"),
    );
    await assert.rejects(
      client.generateVideo({ prompt: "a wave", seconds: "99" as never }),
      expectCode("INVALID_INPUT"),
    );
  });
  it("creates, polls to completion, and downloads the MP4 bytes", async () => {
    const { client, calls } = await readyClient(videoFetch({ pollsUntilComplete: 2 }));
    const bytes = await client.generateVideo({ prompt: "  a calm ocean  " });
    assert.ok(bytes instanceof Uint8Array && bytes.byteLength > 0);
    const create = calls.find((c) => c.url.endsWith("/videos") && c.init.method === "POST");
    assert.ok(create);
    const body = JSON.parse(create!.init.body as string) as Record<string, unknown>;
    assert.equal(body.model, "sora-2");
    assert.equal(body.prompt, "a calm ocean");
    assert.equal(body.size, "1280x720"); // default
    assert.equal(body.seconds, "8"); // default
    assert.ok(calls.some((c) => /\/videos\/video_abc123$/u.test(c.url))); // polled
    assert.ok(calls.some((c) => /\/content/u.test(c.url))); // downloaded
  });
  it("honors size, seconds, and model", async () => {
    const { client, calls } = await readyClient(videoFetch());
    await client.generateVideo({ prompt: "a wave", size: "720x1280", seconds: "16", model: "sora-2-pro" });
    const body = JSON.parse(
      (calls.find((c) => c.init.method === "POST")!.init.body) as string,
    ) as Record<string, unknown>;
    assert.equal(body.size, "720x1280");
    assert.equal(body.seconds, "16");
    assert.equal(body.model, "sora-2-pro");
  });
  it("throws when the job fails", async () => {
    const { client } = await readyClient(videoFetch({ failStatus: true }));
    await assert.rejects(client.generateVideo({ prompt: "a wave" }), expectCode("API_ERROR"));
  });
  it("times out if the job never completes", async () => {
    const { client } = await readyClient(videoFetch({ neverComplete: true }));
    await assert.rejects(
      client.generateVideo({ prompt: "a wave", pollIntervalMs: 1000, pollTimeoutMs: 10000 }),
      expectCode("TIMEOUT"),
    );
  });
  it("rejects empty video content", async () => {
    const { client } = await readyClient(videoFetch({ emptyContent: true }));
    await assert.rejects(client.generateVideo({ prompt: "a wave" }), expectCode("INVALID_RESPONSE"));
  });
});

describe("editImage input edge shapes", () => {
  it("rejects a non-array images payload", async () => {
    const { client } = await readyClient();
    await assert.rejects(
      client.editImage({ images: {} as never }),
      expectCode("INVALID_INPUT"),
    );
  });

  it("accepts uppercase extensions and the image/jpg MIME alias", async () => {
    const { client } = await readyClient();
    const bytes = await client.editImage({
      images: [inputImage({ filename: "PHOTO.JPG", mimeType: "image/jpg" })],
    });
    assert.deepEqual([...bytes], PNG_SIGNATURE);
  });

  it("accepts a 260-character filename and rejects 261 characters", async () => {
    const { client } = await readyClient();
    const bytes = await client.editImage({
      images: [inputImage({ filename: `${"a".repeat(256)}.png` })],
    });
    assert.deepEqual([...bytes], PNG_SIGNATURE);
    await assert.rejects(
      client.editImage({ images: [inputImage({ filename: `${"a".repeat(257)}.png` })] }),
      expectCode("INVALID_INPUT"),
    );
  });
});

describe("API error metadata, quota handling, and response guards", () => {
  it("surfaces an insufficient_quota 429 with status and retryable metadata after one retry", async () => {
    const { client, calls, sleeps } = await readyClient(async () =>
      mockResponse(429, { error: { code: "insufficient_quota", message: `quota exhausted ${API_KEY}` } }),
    );
    await assert.rejects(
      client.editImage({ images: [inputImage()] }),
      (error: unknown) => {
        expectCode("API_ERROR")(error);
        assert.ok(error instanceof AIClientError);
        assert.equal(error.status, 429);
        assert.equal(error.retryable, true);
        assert.match(error.message, /insufficient_quota/u);
        assert.match(error.message, /\[REDACTED\]/u);
        return true;
      },
    );
    assert.equal(calls.length, 2);
    assert.deepEqual(sleeps, [500]);
  });

  it("marks a 400 failure non-retryable with its status", async () => {
    const { client, calls } = await readyClient(async () => mockResponse(400, "bad request"));
    await assert.rejects(
      client.editImage({ images: [inputImage()] }),
      (error: unknown) => {
        expectCode("API_ERROR")(error);
        assert.ok(error instanceof AIClientError);
        assert.equal(error.status, 400);
        assert.equal(error.retryable, false);
        return true;
      },
    );
    assert.equal(calls.length, 1);
  });

  it("testConnection succeeds after a transient 5xx clears on retry", async () => {
    let count = 0;
    const { client, calls } = await readyClient(async () => {
      count += 1;
      return count === 1 ? mockResponse(503, "warming up") : mockResponse(200, {});
    });
    assert.deepEqual(await client.testConnection(), { ok: true, model: OPENAI_IMAGE_MODEL });
    assert.equal(calls.length, 2);
  });

  it("testConnection surfaces a non-OK status without retrying it", async () => {
    const { client, calls } = await readyClient(async () => mockResponse(404, "model missing"));
    await assert.rejects(
      client.testConnection(),
      (error: unknown) => {
        expectCode("API_ERROR")(error);
        assert.ok(error instanceof AIClientError);
        assert.equal(error.status, 404);
        assert.equal(error.retryable, false);
        return true;
      },
    );
    assert.equal(calls.length, 1);
  });

  it("marks timeout failures retryable", async () => {
    const context = createAdapter(async () => new Promise(() => undefined));
    context.adapter.setTimeout = (handler: () => void) => { handler(); return 1; };
    context.adapter.clearTimeout = () => undefined;
    const client = new OpenAIImageClient(context.adapter);
    await client.setApiKey(API_KEY);
    await assert.rejects(
      client.testConnection(1),
      (error: unknown) => {
        expectCode("TIMEOUT")(error);
        assert.ok(error instanceof AIClientError);
        assert.equal(error.retryable, true);
        return true;
      },
    );
  });

  it("rejects a success response whose JSON body cannot be parsed", async () => {
    const { client } = await readyClient(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new Error("unexpected end of JSON"); },
      text: async () => "",
    }));
    await assert.rejects(
      client.editImage({ images: [inputImage()] }),
      expectCode("INVALID_RESPONSE"),
    );
  });
});
