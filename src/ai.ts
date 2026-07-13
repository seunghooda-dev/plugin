export const OPENAI_API_KEY_STORAGE_KEY = "shortflow.openai.apiKey";
export const DEFAULT_OPENAI_ENDPOINT = "https://api.openai.com/v1";
export const OPENAI_IMAGE_MODEL = "gpt-image-2";
export const MAX_EDIT_IMAGES = 4;
export const MAX_EDIT_IMAGE_BYTES = 10 * 1024 * 1024;
/** GPT Image API의 PNG 응답을 메모리에 올리기 전에 적용하는 안전 상한입니다. */
export const MAX_EDIT_RESPONSE_BYTES = 50 * 1024 * 1024;
export const MAX_EDIT_PROMPT_CHARACTERS = 4_096;

export type ImageEditPreset =
  | "basic"
  | "vivid"
  | "upscale"
  | "remove-bg"
  | "chat";

export interface ImageEditInput {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
}

export interface ImageEditRequest {
  images: readonly ImageEditInput[];
  preset?: ImageEditPreset;
  prompt?: string;
  timeoutMs?: number;
}

export type ImageGenerateSize = "1024x1024" | "1536x1024" | "1024x1536";

export interface ImageGenerateRequest {
  prompt: string;
  size?: ImageGenerateSize;
  timeoutMs?: number;
}

export interface SecureStorageAdapter {
  setItem(key: string, value: Uint8Array): Promise<any> | any;
  getItem(key: string): Promise<any> | any;
  removeItem(key: string): Promise<any> | any;
}

export interface OpenAIImageAdapter {
  secureStorage: SecureStorageAdapter;
  fetch(input: string, init?: any): Promise<any>;
  FormData: new () => any;
  Blob: new (parts?: readonly any[], options?: any) => any;
  sleep(milliseconds: number): Promise<void>;
  AbortController?: new () => any;
  setTimeout?: (handler: () => void, milliseconds: number) => any;
  clearTimeout?: (handle: any) => void;
}

export interface OpenAIImageClientOptions {
  endpoint?: string;
  apiKeyStorageKey?: string;
  timeoutMs?: number;
}

export interface ConnectionTestResult {
  ok: true;
  model: typeof OPENAI_IMAGE_MODEL;
}

export type AIErrorCode =
  | "INVALID_API_KEY"
  | "MISSING_API_KEY"
  | "INVALID_ENDPOINT"
  | "INVALID_INPUT"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "API_ERROR"
  | "INVALID_RESPONSE"
  | "UNSUPPORTED_RUNTIME";

export class AIClientError extends Error {
  override readonly name = "AIClientError";
  readonly code: AIErrorCode;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(
    code: AIErrorCode,
    message: string,
    options: { status?: number; retryable?: boolean } = {},
  ) {
    super(message);
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.status !== undefined) {
      this.status = options.status;
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const PRESET_PROMPTS: Record<Exclude<ImageEditPreset, "chat">, string> = {
  basic:
    "Edit the supplied image while preserving the original subject, identity, composition, and important details. Apply only the requested changes.",
  vivid:
    "Create a vivid, polished editorial treatment with richer color, clean contrast, and crisp detail while preserving the original subject and composition.",
  upscale:
    "Enhance perceived resolution, edge clarity, and fine detail. Remove compression artifacts without changing the subject, layout, text, or composition.",
  "remove-bg":
    "Remove the background completely and return only the clean foreground subject with accurate edges on a transparent background. Do not add a new background.",
};

function cleanPrompt(value: string | undefined): string {
  if (typeof value !== "string") return "";
  if (value.length > MAX_EDIT_PROMPT_CHARACTERS) {
    throw new AIClientError(
      "INVALID_INPUT",
      `이미지 편집 요청은 최대 ${MAX_EDIT_PROMPT_CHARACTERS.toLocaleString("ko-KR")}자입니다.`,
    );
  }
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/[<>]/gu, "")
    .trim()
    .replace(/\s+/gu, " ");
}

export function buildEditPrompt(
  preset: ImageEditPreset = "basic",
  freeformPrompt = "",
): string {
  const userPrompt = cleanPrompt(freeformPrompt);
  if (preset === "chat") {
    if (!userPrompt) {
      throw new AIClientError(
        "INVALID_INPUT",
        "자유 편집 요청을 입력해 주세요.",
      );
    }
    return userPrompt;
  }

  const presetPrompt = PRESET_PROMPTS[preset];
  if (!presetPrompt) {
    throw new AIClientError("INVALID_INPUT", "지원하지 않는 이미지 편집 프리셋입니다.");
  }
  return userPrompt ? `${presetPrompt} User request: ${userPrompt}` : presetPrompt;
}

const GENERATE_SIZES: readonly ImageGenerateSize[] = ["1024x1024", "1536x1024", "1024x1536"];

function normalizeGenerateSize(size: ImageGenerateSize | undefined): ImageGenerateSize {
  if (size === undefined) return "1024x1024";
  if (!GENERATE_SIZES.includes(size)) {
    throw new AIClientError(
      "INVALID_INPUT",
      "지원하는 이미지 크기(1024x1024, 1536x1024, 1024x1536)를 선택해 주세요.",
    );
  }
  return size;
}

function buildGeneratePrompt(prompt: string): string {
  const cleaned = cleanPrompt(prompt);
  if (!cleaned) {
    throw new AIClientError("INVALID_INPUT", "생성할 이미지를 설명하는 프롬프트를 입력해 주세요.");
  }
  return cleaned;
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/u.test(part))) {
    return false;
  }
  const octets = parts.map(Number);
  if (octets.some((value) => value < 0 || value > 255)) {
    return true;
  }
  const [a = 0, b = 0] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isUnsafeHostname(hostname: string): boolean {
  const host = hostname.toLocaleLowerCase("en-US").replace(/\.$/u, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "0" ||
    isPrivateIpv4(host)
  ) {
    return true;
  }
  if (host.includes(":")) {
    const compact = host.replace(/^\[|\]$/gu, "");
    return (
      compact === "::" ||
      compact === "::1" ||
      compact.startsWith("::ffff:") ||
      compact.startsWith("fc") ||
      compact.startsWith("fd") ||
      compact.startsWith("fe8") ||
      compact.startsWith("fe9") ||
      compact.startsWith("fea") ||
      compact.startsWith("feb")
    );
  }
  return false;
}

export function validateEndpoint(endpoint: string): string {
  if (typeof endpoint !== "string" || !endpoint.trim()) {
    throw new AIClientError("INVALID_ENDPOINT", "OpenAI API endpoint가 비어 있습니다.");
  }

  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch {
    throw new AIClientError("INVALID_ENDPOINT", "올바른 OpenAI API endpoint URL을 입력해 주세요.");
  }

  if (url.protocol !== "https:") {
    throw new AIClientError("INVALID_ENDPOINT", "OpenAI API endpoint는 HTTPS만 허용됩니다.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new AIClientError(
      "INVALID_ENDPOINT",
      "OpenAI API endpoint에는 인증 정보, 쿼리 또는 fragment를 포함할 수 없습니다.",
    );
  }
  if (!url.hostname || isUnsafeHostname(url.hostname)) {
    throw new AIClientError(
      "INVALID_ENDPOINT",
      "로컬 또는 사설 네트워크 endpoint는 보안을 위해 허용되지 않습니다.",
    );
  }

  const normalizedPath = url.pathname.replace(/\/+$/u, "");
  const normalizedEndpoint = `${url.origin}${normalizedPath}`;
  if (normalizedEndpoint !== DEFAULT_OPENAI_ENDPOINT) {
    throw new AIClientError(
      "INVALID_ENDPOINT",
      "이미지 편집은 보안을 위해 공식 OpenAI API endpoint(https://api.openai.com/v1)만 사용합니다.",
    );
  }
  return DEFAULT_OPENAI_ENDPOINT;
}

export function redactSecret(value: unknown, secret?: string): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (value instanceof Error) {
    text = value.message;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }

  if (secret) {
    text = text.split(secret).join("[REDACTED]");
  }
  return text
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/((?:authorization|x-api-key)\s*[:=]\s*)bearer\s+[^\s,;"'}]+/giu, "$1Bearer [REDACTED]")
    .replace(/(x-api-key\s*[:=]\s*)[^\s,;"'}]+/giu, "$1[REDACTED]")
    .replace(/\bbearer\s+[a-z0-9._~+/-]{8,}/giu, "Bearer [REDACTED]")
    .replace(/\b(?:sk|sess)-[a-z0-9_-]{8,}\b/giu, "[REDACTED]")
    .replace(/("?(?:api[_-]?key|token)"?\s*[:=]\s*["']?)[^\s,"'}]+/giu, "$1[REDACTED]")
    .slice(0, 2_000);
}

export function decodeBase64(base64: string): Uint8Array {
  if (typeof base64 !== "string") {
    throw new AIClientError("INVALID_RESPONSE", "이미지 응답의 base64 데이터가 올바르지 않습니다.");
  }
  const clean = base64.replace(/\s+/gu, "");
  if (
    clean.length === 0 ||
    clean.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(clean) ||
    /=/.test(clean.slice(0, -2))
  ) {
    throw new AIClientError("INVALID_RESPONSE", "이미지 응답의 base64 데이터가 손상되었습니다.");
  }

  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const outputLength = Math.floor((clean.length * 3) / 4) -
    (clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0);
  if (outputLength > MAX_EDIT_RESPONSE_BYTES) {
    throw new AIClientError(
      "INVALID_RESPONSE",
      `OpenAI 이미지 응답은 ${Math.floor(MAX_EDIT_RESPONSE_BYTES / (1024 * 1024))}MB 이하여야 합니다.`,
    );
  }
  const output = new Uint8Array(outputLength);
  let outputIndex = 0;

  for (let index = 0; index < clean.length; index += 4) {
    const a = alphabet.indexOf(clean[index] ?? "");
    const b = alphabet.indexOf(clean[index + 1] ?? "");
    const c = clean[index + 2] === "=" ? 0 : alphabet.indexOf(clean[index + 2] ?? "");
    const d = clean[index + 3] === "=" ? 0 : alphabet.indexOf(clean[index + 3] ?? "");
    if (a < 0 || b < 0 || c < 0 || d < 0) {
      throw new AIClientError("INVALID_RESPONSE", "이미지 응답의 base64 데이터가 손상되었습니다.");
    }
    const bits = (a << 18) | (b << 12) | (c << 6) | d;
    if (outputIndex < output.length) output[outputIndex++] = (bits >> 16) & 0xff;
    if (outputIndex < output.length) output[outputIndex++] = (bits >> 8) & 0xff;
    if (outputIndex < output.length) output[outputIndex++] = bits & 0xff;
  }
  return output;
}

function assertPngResponse(bytes: Uint8Array): Uint8Array {
  const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    bytes.byteLength < pngSignature.length ||
    !pngSignature.every((value, index) => bytes[index] === value)
  ) {
    throw new AIClientError(
      "INVALID_RESPONSE",
      "OpenAI 이미지 응답이 요청한 PNG 형식이 아닙니다.",
    );
  }
  return bytes;
}

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decodeUtf8(value: unknown): string {
  if (value instanceof Uint8Array) {
    return new TextDecoder().decode(value);
  }
  if (value instanceof ArrayBuffer) {
    return new TextDecoder().decode(new Uint8Array(value));
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return new TextDecoder().decode(
      new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
    );
  }
  return typeof value === "string" ? value : "";
}

function validateApiKey(apiKey: string): string {
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!key || key.length < 8 || key.length > 512 || /[\r\n\0]/u.test(key)) {
    throw new AIClientError("INVALID_API_KEY", "올바른 OpenAI API key를 입력해 주세요.");
  }
  return key;
}

function validateImages(images: readonly ImageEditInput[]): void {
  if (!Array.isArray(images) || images.length === 0) {
    throw new AIClientError("INVALID_INPUT", "편집할 이미지를 한 개 이상 선택해 주세요.");
  }
  if (images.length > MAX_EDIT_IMAGES) {
    throw new AIClientError("INVALID_INPUT", `입력 이미지는 최대 ${MAX_EDIT_IMAGES}개까지 사용할 수 있습니다.`);
  }
  for (const [index, image] of images.entries()) {
    if (!(image?.bytes instanceof Uint8Array) || image.bytes.byteLength === 0) {
      throw new AIClientError("INVALID_INPUT", `${index + 1}번째 이미지 데이터가 비어 있습니다.`);
    }
    if (image.bytes.byteLength > MAX_EDIT_IMAGE_BYTES) {
      throw new AIClientError("INVALID_INPUT", `${index + 1}번째 이미지는 10MB 이하여야 합니다.`);
    }
    const filename = image.filename?.trim() ?? "";
    const mimeType = image.mimeType?.trim().toLocaleLowerCase("en-US") ?? "";
    const extension = filename.slice(filename.lastIndexOf(".") + 1).toLocaleLowerCase("en-US");
    const validMimeForExtension =
      (extension === "png" && mimeType === "image/png") ||
      ((extension === "jpg" || extension === "jpeg") &&
        (mimeType === "image/jpeg" || mimeType === "image/jpg")) ||
      (extension === "webp" && mimeType === "image/webp");
    if (
      !filename ||
      filename.length > 260 ||
      filename === "." ||
      filename === ".." ||
      /[\\/\u0000-\u001f\u007f]/u.test(filename) ||
      !validMimeForExtension
    ) {
      throw new AIClientError("INVALID_INPUT", `${index + 1}번째 이미지 형식은 PNG, JPEG 또는 WebP여야 합니다.`);
    }
  }
}

function responseStatus(response: any): number {
  return typeof response?.status === "number" ? response.status : 0;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

async function safeResponseBody(response: any): Promise<string> {
  try {
    if (typeof response?.text === "function") {
      return String(await response.text())
        .replace(/[\u0000-\u001f\u007f]/gu, " ")
        .slice(0, 2_000);
    }
  } catch {
    return "";
  }
  return "";
}

export class OpenAIImageClient {
  readonly adapter: OpenAIImageAdapter;
  readonly endpoint: string;
  readonly apiKeyStorageKey: string;
  readonly timeoutMs: number;

  constructor(adapter: OpenAIImageAdapter, options: OpenAIImageClientOptions = {}) {
    if (!adapter?.secureStorage || typeof adapter.fetch !== "function") {
      throw new AIClientError("UNSUPPORTED_RUNTIME", "OpenAI 클라이언트 어댑터가 올바르지 않습니다.");
    }
    this.adapter = adapter;
    this.endpoint = validateEndpoint(options.endpoint ?? DEFAULT_OPENAI_ENDPOINT);
    this.apiKeyStorageKey = options.apiKeyStorageKey?.trim() || OPENAI_API_KEY_STORAGE_KEY;
    this.timeoutMs = typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.floor(options.timeoutMs)
      : 60_000;
  }

  async setApiKey(apiKey: string): Promise<void> {
    const key = validateApiKey(apiKey);
    try {
      await this.adapter.secureStorage.setItem(this.apiKeyStorageKey, encodeUtf8(key));
    } catch {
      throw new AIClientError("UNSUPPORTED_RUNTIME", "보안 저장소에 API key를 저장하지 못했습니다.");
    }
  }

  async getApiKey(): Promise<string | null> {
    let stored: unknown;
    try {
      stored = await this.adapter.secureStorage.getItem(this.apiKeyStorageKey);
    } catch {
      throw new AIClientError("UNSUPPORTED_RUNTIME", "보안 저장소에서 API key를 읽지 못했습니다.");
    }
    if (stored === null || stored === undefined) return null;
    const key = decodeUtf8(stored).trim();
    if (!key) return null;
    return validateApiKey(key);
  }

  async removeApiKey(): Promise<void> {
    try {
      await this.adapter.secureStorage.removeItem(this.apiKeyStorageKey);
    } catch {
      throw new AIClientError("UNSUPPORTED_RUNTIME", "보안 저장소에서 API key를 삭제하지 못했습니다.");
    }
  }

  async testConnection(timeoutMs = 15_000): Promise<ConnectionTestResult> {
    const apiKey = await this.requireApiKey();
    const response = await this.fetchWithRetry(
      `${this.endpoint}/models/${OPENAI_IMAGE_MODEL}`,
      { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } },
      apiKey,
      timeoutMs,
    );
    if (!response?.ok) {
      await this.throwApiError(response, apiKey);
    }
    return { ok: true, model: OPENAI_IMAGE_MODEL };
  }

  async editImage(request: ImageEditRequest): Promise<Uint8Array> {
    validateImages(request.images);
    const apiKey = await this.requireApiKey();
    const preset = request.preset ?? "basic";
    const prompt = buildEditPrompt(preset, request.prompt);
    const form = new this.adapter.FormData();
    form.append("model", OPENAI_IMAGE_MODEL);
    form.append("prompt", prompt);
    for (const image of request.images) {
      const blob = new this.adapter.Blob([image.bytes], { type: image.mimeType });
      form.append("image[]", blob, image.filename.trim());
    }
    form.append("size", "1536x1024");
    form.append("quality", "high");
    form.append("output_format", "png");
    if (preset === "remove-bg") form.append("background", "transparent");

    const response = await this.fetchWithRetry(
      `${this.endpoint}/images/edits`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      },
      apiKey,
      request.timeoutMs ?? this.timeoutMs,
    );
    if (!response?.ok) {
      await this.throwApiError(response, apiKey);
    }

    let payload: any;
    try {
      payload = await response.json();
    } catch {
      throw new AIClientError("INVALID_RESPONSE", "OpenAI 이미지 응답을 JSON으로 읽지 못했습니다.");
    }
    const base64 = payload?.data?.[0]?.b64_json;
    if (typeof base64 !== "string") {
      throw new AIClientError("INVALID_RESPONSE", "OpenAI 응답에 b64_json 이미지가 없습니다.");
    }
    return assertPngResponse(decodeBase64(base64));
  }

  async generateImage(request: ImageGenerateRequest): Promise<Uint8Array> {
    const prompt = buildGeneratePrompt(request?.prompt);
    const size = normalizeGenerateSize(request?.size);
    const apiKey = await this.requireApiKey();
    const body = JSON.stringify({
      model: OPENAI_IMAGE_MODEL,
      prompt,
      size,
      // 생성은 편집(high)보다 낮은 medium으로 — 레퍼런스 용도에 충분하고 응답이 빨라 타임아웃 위험을 줄인다.
      quality: "medium",
      output_format: "png",
      n: 1,
    });

    const response = await this.fetchWithRetry(
      `${this.endpoint}/images/generations`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body,
      },
      apiKey,
      request?.timeoutMs ?? this.timeoutMs,
    );
    if (!response?.ok) {
      await this.throwApiError(response, apiKey);
    }

    let payload: any;
    try {
      payload = await response.json();
    } catch {
      throw new AIClientError("INVALID_RESPONSE", "OpenAI 이미지 응답을 JSON으로 읽지 못했습니다.");
    }
    const base64 = payload?.data?.[0]?.b64_json;
    if (typeof base64 !== "string") {
      throw new AIClientError("INVALID_RESPONSE", "OpenAI 응답에 b64_json 이미지가 없습니다.");
    }
    return assertPngResponse(decodeBase64(base64));
  }

  private async requireApiKey(): Promise<string> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new AIClientError("MISSING_API_KEY", "먼저 OpenAI API key를 저장해 주세요.");
    }
    return apiKey;
  }

  private async fetchWithRetry(
    url: string,
    init: any,
    apiKey: string,
    timeoutMs: number,
  ): Promise<any> {
    let response: any = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await this.fetchOnce(url, init, timeoutMs);
      } catch (error) {
        if (error instanceof AIClientError) throw error;
        const message = redactSecret(error, apiKey);
        throw new AIClientError("NETWORK_ERROR", `OpenAI API 연결에 실패했습니다: ${message}`);
      }
      if (!isRetryableStatus(responseStatus(response)) || attempt === 1) return response;
      await this.adapter.sleep(500);
    }
    return response;
  }

  private async fetchOnce(url: string, init: any, timeoutMs: number): Promise<any> {
    const AbortControllerCtor = this.adapter.AbortController ?? (globalThis as any).AbortController;
    const setTimer = this.adapter.setTimeout ?? (globalThis as any).setTimeout;
    const clearTimer = this.adapter.clearTimeout ?? (globalThis as any).clearTimeout;
    if (typeof setTimer !== "function" || timeoutMs <= 0) {
      return this.adapter.fetch(url, init);
    }

    const controller = AbortControllerCtor ? new AbortControllerCtor() : null;
    let timedOut = false;
    let timer: any;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimer(() => {
        timedOut = true;
        controller?.abort();
        reject(new AIClientError("TIMEOUT", "OpenAI API 요청 시간이 초과되었습니다.", { retryable: true }));
      }, timeoutMs);
    });
    try {
      const pendingResponse = Promise.resolve().then(() => this.adapter.fetch(
        url,
        controller ? { ...init, signal: controller.signal } : init,
      ));
      return await Promise.race([pendingResponse, timeout]);
    } catch (error) {
      if (
        timedOut ||
        controller?.signal?.aborted ||
        /abort|timeout/iu.test(String((error as any)?.message ?? error))
      ) {
        throw new AIClientError("TIMEOUT", "OpenAI API 요청 시간이 초과되었습니다.", { retryable: true });
      }
      throw error;
    } finally {
      if (typeof clearTimer === "function" && timer !== undefined) clearTimer(timer);
    }
  }

  private async throwApiError(response: any, apiKey: string): Promise<never> {
    const status = responseStatus(response);
    const body = redactSecret(await safeResponseBody(response), apiKey);
    const suffix = body ? `: ${body}` : "";
    const errorOptions: { status?: number; retryable: boolean } = {
      retryable: isRetryableStatus(status),
    };
    if (status) errorOptions.status = status;
    throw new AIClientError(
      "API_ERROR",
      `OpenAI API 요청이 실패했습니다 (${status || "unknown"})${suffix}`,
      errorOptions,
    );
  }
}

export function createDefaultOpenAIImageAdapter(): OpenAIImageAdapter {
  let uxp: any;
  try {
    uxp = require("uxp");
  } catch {
    throw new AIClientError("UNSUPPORTED_RUNTIME", "Premiere Pro UXP 환경에서 실행해 주세요.");
  }
  // SecureStorage is exported at the top level by the UXP module. The nested
  // fallback keeps compatibility with a few older host shims used in tests.
  const secureStorage = uxp?.secureStorage ?? uxp?.storage?.secureStorage;
  const fetchFn = (globalThis as any).fetch;
  const FormDataCtor = (globalThis as any).FormData;
  const BlobCtor = (globalThis as any).Blob;
  if (!secureStorage || !fetchFn || !FormDataCtor || !BlobCtor) {
    throw new AIClientError("UNSUPPORTED_RUNTIME", "UXP 보안 저장소 또는 네트워크 API를 사용할 수 없습니다.");
  }
  return {
    secureStorage,
    fetch: fetchFn.bind(globalThis),
    FormData: FormDataCtor,
    Blob: BlobCtor,
    sleep: (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  };
}
