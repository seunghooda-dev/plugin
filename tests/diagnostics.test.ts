import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DIAGNOSTICS_SCHEMA_VERSION,
  MAX_TELEMETRY_QUEUE,
  MINIMUM_PREMIERE_VERSION,
  TELEMETRY_CONSENT_VERSION,
  TELEMETRY_PAYLOAD_ALLOWLIST,
  TELEMETRY_SCHEMA_VERSION,
  TELEMETRY_STORAGE_KEY,
  DiagnosticsError,
  TelemetryManager,
  assertDiagnosticRedactionSelfCheck,
  buildDiagnosticsReport,
  compareVersions,
  createDefaultTelemetryAdapter,
  diagnosticBundleToJSON,
  diagnosticRedactionSelfCheck,
  guardApi,
  normalizeDiagnosticBundle,
  normalizeTelemetryPayload,
  parseVersion,
  readRuntimeMember,
  redactSensitive,
  requireAvailableApi,
  type DiagnosticsAdapter,
  type TelemetryPayload,
  type TelemetryProvider,
  type TelemetryStorage,
} from "../src/diagnostics";

describe("readRuntimeMember", () => {
  it("reads static Host APIs through function and class namespaces", () => {
    class Project {
      static getActiveProject(): string { return "project"; }
    }
    class SequenceEditor {
      static getEditor(): string { return "editor"; }
    }
    class EncoderManager {
      static getManager(): string { return "manager"; }
    }
    const hostModule = { Project, SequenceEditor, EncoderManager };
    const uxpModule = {
      storage: {
        secureStorage: { getItem: () => null },
        localFileSystem: { getDataFolder: () => null },
      },
    };

    assert.equal(readRuntimeMember(hostModule, "Project", "getActiveProject"), Project.getActiveProject);
    assert.equal(readRuntimeMember(hostModule, "SequenceEditor", "getEditor"), SequenceEditor.getEditor);
    assert.equal(readRuntimeMember(hostModule, "EncoderManager", "getManager"), EncoderManager.getManager);
    assert.equal(typeof readRuntimeMember(hostModule, "EncoderManager", "getManager"), "function");
    assert.equal(typeof readRuntimeMember(uxpModule, "storage", "secureStorage", "getItem"), "function");
    assert.equal(typeof readRuntimeMember(uxpModule, "storage", "localFileSystem", "getDataFolder"), "function");
  });

  it("returns undefined for missing, primitive, or throwing paths", () => {
    const throwing = Object.defineProperty({}, "broken", {
      get() { throw new Error("blocked getter"); },
    });
    assert.equal(readRuntimeMember(null, "Project"), undefined);
    assert.equal(readRuntimeMember({ Project: 1 }, "Project", "getActiveProject"), undefined);
    assert.equal(readRuntimeMember(throwing, "broken"), undefined);
  });
});

class MemoryStorage implements TelemetryStorage {
  readonly values = new Map<string, string>();
  writes = 0;
  removes = 0;
  failRead = false;
  failWrite = false;

  getItem(key: string): string | null {
    if (this.failRead) throw new Error("read failed");
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failWrite) throw new Error("write failed");
    this.writes += 1;
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    if (this.failWrite) throw new Error("remove failed");
    this.removes += 1;
    this.values.delete(key);
  }
}

class MockProvider implements TelemetryProvider {
  readonly sent: TelemetryPayload[] = [];
  failuresRemaining = 0;
  wait: Promise<void> | null = null;

  async send(payload: TelemetryPayload): Promise<void> {
    if (this.wait) await this.wait;
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error("provider unavailable");
    }
    this.sent.push(payload);
  }
}

function healthyAdapter(): DiagnosticsAdapter {
  return {
    getHostInfo: () => ({ name: "Adobe Premiere Pro", version: "25.6.0", build: "123" }),
    getUxpInfo: () => ({ version: "8.1.0" }),
    getOsInfo: () => ({ platform: "Windows", version: "11", arch: "x64" }),
    getRuntimeInfo: () => ({ pluginVersion: "1.0.0", locale: "ko-KR", online: true }),
    capabilities: {
      transcript: () => true,
      encoder: () => ({ available: true, version: "25.6" }),
      secureStorage: () => true,
      network: () => true,
      filesystem: () => true,
    },
  };
}

function telemetryFixture(options: {
  maxQueue?: number;
  maxAttempts?: number;
  baseRetryDelayMs?: number;
  queueTtlMs?: number;
  provider?: MockProvider;
} = {}) {
  const storage = new MemoryStorage();
  const provider = options.provider ?? new MockProvider();
  let time = 1_000_000;
  let sequence = 0;
  const manager = new TelemetryManager(
    { storage, provider },
    {
      sessionId: "session:test",
      now: () => time,
      eventIdFactory: (event) => `evt:${event}:${++sequence}`,
      ...(options.maxQueue !== undefined ? { maxQueue: options.maxQueue } : {}),
      ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
      ...(options.baseRetryDelayMs !== undefined
        ? { baseRetryDelayMs: options.baseRetryDelayMs }
        : {}),
      ...(options.queueTtlMs !== undefined ? { queueTtlMs: options.queueTtlMs } : {}),
    },
  );
  return {
    manager,
    storage,
    provider,
    now: () => time,
    advance: (milliseconds: number) => { time += milliseconds; },
  };
}

describe("version compatibility", () => {
  it("publishes the required Premiere floor", () => {
    assert.equal(MINIMUM_PREMIERE_VERSION, "25.6.0");
    assert.equal(DIAGNOSTICS_SCHEMA_VERSION, 1);
  });

  it("parses two, three, and four component host versions", () => {
    assert.deepEqual(parseVersion("25.6"), [25, 6, 0]);
    assert.deepEqual(parseVersion("25.6.1"), [25, 6, 1]);
    assert.deepEqual(parseVersion("25.6.1.42 Beta"), [25, 6, 1]);
  });

  it("rejects malformed and non-string versions", () => {
    assert.equal(parseVersion("v25.6"), null);
    assert.equal(parseVersion(""), null);
    assert.equal(parseVersion(Number.NaN), null);
  });

  it("compares major, minor, and patch versions", () => {
    assert.equal(compareVersions("26.0", "25.6"), 1);
    assert.equal(compareVersions("25.7", "25.6"), 1);
    assert.equal(compareVersions("25.6.1", "25.6.0"), 1);
    assert.equal(compareVersions("25.6", "25.6.0"), 0);
    assert.equal(compareVersions("25.5.9", "25.6"), -1);
  });

  it("returns null when either comparison side is unknown", () => {
    assert.equal(compareVersions("unknown", "25.6"), null);
    assert.equal(compareVersions("25.6", null), null);
  });
});

describe("API availability and deprecation guards", () => {
  it("returns a green guard for an available API", () => {
    const api = { execute: () => true };
    const result = guardApi("Encoder", api, { required: true });
    assert.equal(result.available, true);
    assert.equal(result.status, "green");
    assert.equal(result.value, api);
    assert.equal(result.check.required, true);
  });

  it("returns red for a missing required API", () => {
    const result = guardApi("Filesystem", undefined, { required: true });
    assert.equal(result.available, false);
    assert.equal(result.status, "red");
    assert.equal(result.value, null);
  });

  it("returns yellow for a missing optional API or false feature flag", () => {
    assert.equal(guardApi("Transcript", null).status, "yellow");
    assert.equal(guardApi("Transcript", false).available, false);
  });

  it("marks an available deprecated API yellow and names its replacement", () => {
    const result = guardApi("LegacyEncoder", {}, {
      deprecated: true,
      replacement: "EncoderManager",
    });
    assert.equal(result.status, "yellow");
    assert.equal(result.check.deprecated, true);
    assert.equal(result.check.replacement, "EncoderManager");
    assert.match(result.check.message, /deprecated.*EncoderManager/u);
  });

  it("unwraps only available APIs", () => {
    const value = { ready: true };
    assert.equal(requireAvailableApi(guardApi("API", value)), value);
    assert.throws(
      () => requireAvailableApi(guardApi("API", null, { required: true })),
      (error: unknown) => error instanceof DiagnosticsError && error.code === "INVALID_API",
    );
  });
});

describe("buildDiagnosticsReport", () => {
  it("builds a green compatible report for Premiere 25.6", async () => {
    const report = await buildDiagnosticsReport(healthyAdapter(), () => 1234);
    assert.equal(report.generatedAt, 1234);
    assert.equal(report.overall, "green");
    assert.equal(report.compatible, true);
    assert.equal(report.host.version, "25.6.0");
    assert.equal(report.checks.length, 8);
  });

  it("accepts the version string exposed by the Premiere 26.3 UXP runtime", async () => {
    const adapter = healthyAdapter();
    const report = await buildDiagnosticsReport({
      ...adapter,
      getUxpInfo: () => ({ version: "uxp-9.3.0-local" }),
    });
    const runtime = report.checks.find((check) => check.id === "uxp-runtime");
    assert.equal(runtime?.status, "green");
    assert.equal(runtime?.version, "uxp-9.3.0-local");
    assert.equal(report.compatible, true);
  });

  it("marks an older host red and incompatible", async () => {
    const adapter = healthyAdapter();
    const report = await buildDiagnosticsReport({
      ...adapter,
      getHostInfo: () => ({ name: "Premiere Pro", version: "25.5.9" }),
    });
    assert.equal(report.overall, "red");
    assert.equal(report.compatible, false);
    assert.equal(report.checks.find((check) => check.id === "host-version")?.status, "red");
  });

  it("warns when the host version cannot be determined", async () => {
    const adapter = healthyAdapter();
    const report = await buildDiagnosticsReport({ ...adapter, getHostInfo: () => null });
    assert.equal(report.host.version, "unknown");
    assert.equal(report.checks[0]?.status, "yellow");
    assert.equal(report.compatible, false);
  });

  it("makes missing Encoder, secureStorage, and filesystem capabilities red", async () => {
    const adapter = healthyAdapter();
    const report = await buildDiagnosticsReport({
      ...adapter,
      capabilities: {
        ...adapter.capabilities,
        encoder: () => false,
        secureStorage: () => false,
        filesystem: () => false,
      },
    });
    for (const name of ["encoder", "secureStorage", "filesystem"]) {
      const check = report.checks.find((item) => item.id === `capability:${name}`);
      assert.equal(check?.status, "red");
      assert.equal(check?.required, true);
    }
    assert.equal(report.compatible, false);
  });

  it("makes missing Transcript and network capabilities yellow", async () => {
    const adapter = healthyAdapter();
    const report = await buildDiagnosticsReport({
      ...adapter,
      capabilities: {
        ...adapter.capabilities,
        transcript: () => false,
        network: () => false,
      },
    });
    assert.equal(report.overall, "yellow");
    assert.equal(report.compatible, true);
    assert.equal(report.checks.find((item) => item.id === "capability:transcript")?.required, false);
  });

  it("turns a thrown capability probe into a safe diagnostic result", async () => {
    const adapter = healthyAdapter();
    const report = await buildDiagnosticsReport({
      ...adapter,
      capabilities: {
        ...adapter.capabilities,
        encoder: () => { throw new Error("nativePath C:\\Users\\alice\\secret.mov"); },
      },
    });
    const check = report.checks.find((item) => item.id === "capability:encoder");
    assert.equal(check?.status, "red");
    assert.doesNotMatch(check?.message ?? "", /alice|secret\.mov/u);
  });

  it("marks a deprecated capability yellow", async () => {
    const adapter = healthyAdapter();
    const report = await buildDiagnosticsReport({
      ...adapter,
      capabilities: {
        ...adapter.capabilities,
        transcript: () => ({ available: true, deprecated: true }),
      },
    });
    const check = report.checks.find((item) => item.id === "capability:transcript");
    assert.equal(check?.available, true);
    assert.equal(check?.deprecated, true);
    assert.equal(check?.status, "yellow");
  });

  it("includes custom API guards without serializing API values", async () => {
    const report = await buildDiagnosticsReport({
      ...healthyAdapter(),
      apis: [
        { name: "NewAPI", value: () => true, required: true },
        { name: "OldAPI", value: {}, deprecated: true, replacement: "NewAPI" },
      ],
    });
    assert.equal(report.checks.length, 10);
    assert.equal(report.checks.find((item) => item.id === "api:OldAPI")?.status, "yellow");
    assert.doesNotMatch(JSON.stringify(report), /execute|function/u);
  });

  it("bounds untrusted host and runtime strings", async () => {
    const report = await buildDiagnosticsReport({
      ...healthyAdapter(),
      getHostInfo: () => ({ name: `Host\u0000${"x".repeat(500)}`, version: "25.6" }),
      getRuntimeInfo: () => ({ locale: "k".repeat(200), pluginVersion: "1.2.3" }),
    });
    assert.ok(report.host.name.length <= 160);
    assert.doesNotMatch(report.host.name, /\u0000/u);
    assert.ok((report.runtime.locale?.length ?? 0) <= 40);
  });

  it("freezes report, checks, and host metadata", async () => {
    const report = await buildDiagnosticsReport(healthyAdapter());
    assert.ok(Object.isFrozen(report));
    assert.ok(Object.isFrozen(report.checks));
    assert.ok(Object.isFrozen(report.checks[0]));
    assert.ok(Object.isFrozen(report.host));
  });
});

describe("strong diagnostic redaction", () => {
  it("redacts API keys, bearer values, JWTs, and named secrets", () => {
    const value = redactSensitive({
      apiKey: "sk-proj-abcdefghijklmnop",
      authorization: "Bearer abc.def.ghi",
      nested: "token=opaque-value and sk-1234567890",
      jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
    });
    const json = JSON.stringify(value);
    assert.doesNotMatch(json, /abcdefghijklmnop|abc\.def\.ghi|opaque-value|signature/u);
    assert.match(json, /redacted/u);
  });

  it("redacts persistent capability token keys including camelCase", () => {
    const json = JSON.stringify(redactSensitive({
      persistentToken: "capability-one",
      accessToken: "capability-two",
      refresh_token: "capability-three",
    }));
    assert.doesNotMatch(json, /capability-/u);
  });

  it("redacts Windows, UNC, file URL, macOS, Linux, and generic POSIX paths", () => {
    const input = [
      "C:\\Users\\alice\\Project\\secret.prproj",
      "\\\\server\\share\\private.mov",
      "file:///C:/Users/alice/private.png",
      "/Users/alice/Movies/private.mov",
      "/home/alice/media/private.mxf",
      "/mnt/private/media/file.wav",
    ].join(" | ");
    const output = String(redactSensitive(input));
    assert.doesNotMatch(output, /alice|server|private|secret\.prproj|\/mnt/u);
    assert.match(output, /redacted:path/u);
  });

  it("redacts explicit path and username fields even for relative values", () => {
    const result = redactSensitive({
      nativePath: "relative/private/file.mov",
      username: "seunghooda",
      owner_email: "person@example.com",
    }) as Record<string, unknown>;
    assert.equal(result.nativePath, "<redacted:path>");
    assert.equal(result.username, "<redacted:user>");
    assert.equal(result.owner_email, "<redacted:user>");
  });

  it("redacts scripts, transcripts, prompts, captions, and manuscripts by key", () => {
    const json = JSON.stringify(redactSensitive({
      transcript: "spoken private text",
      scriptText: "private script",
      prompt: "private prompt",
      captionText: "private subtitle",
      manuscript: "private manuscript",
    }));
    assert.doesNotMatch(
      json,
      /spoken private text|private script|private prompt|private subtitle|private manuscript/u,
    );
    assert.match(json, /redacted:content/u);
  });

  it("redacts project, sequence, clip, asset, file, and media names", () => {
    const json = JSON.stringify(redactSensitive({
      projectName: "Confidential Campaign",
      sequenceTitle: "Launch edit",
      clipName: "CEO interview.mov",
      assetName: "logo-secret.png",
      fileName: "voice.wav",
      mediaTitle: "private",
    }));
    assert.doesNotMatch(json, /Campaign|Launch|CEO|logo-secret|voice|private/u);
    assert.match(json, /redacted:media/u);
  });

  it("redacts media filenames embedded in free-form error messages", () => {
    const output = String(redactSensitive("Encoder failed for Client Interview Final.mxf at frame 2"));
    assert.doesNotMatch(output, /Client Interview Final\.mxf/u);
    assert.match(output, /redacted:media/u);
  });

  it("redacts email addresses embedded in strings", () => {
    assert.equal(
      redactSensitive("contact person@example.com now"),
      "contact <redacted:user> now",
    );
  });

  it("replaces binary values instead of enumerating bytes", () => {
    const result = redactSensitive({
      bytes: new Uint8Array([1, 2, 3]),
      buffer: new ArrayBuffer(4),
    }) as Record<string, unknown>;
    assert.equal(result.bytes, "<redacted:binary>");
    assert.equal(result.buffer, "<redacted:binary>");
  });

  it("handles errors without leaking paths or API keys", () => {
    const error = new Error("sk-1234567890 failed at C:\\Users\\alice\\secret.mov");
    error.stack = `Error: failure\n at C:\\Users\\alice\\plugin.js:1`;
    const json = JSON.stringify(redactSensitive(error));
    assert.doesNotMatch(json, /sk-123|alice|secret\.mov/u);
    assert.match(json, /redacted/u);
  });

  it("handles circular structures and truncates deep graphs safely", () => {
    const circular: Record<string, unknown> = { safe: true };
    circular.self = circular;
    let deep: Record<string, unknown> = {};
    const root = deep;
    for (let index = 0; index < 12; index += 1) {
      deep.next = {};
      deep = deep.next as Record<string, unknown>;
    }
    const json = JSON.stringify(redactSensitive({ circular, root }));
    assert.match(json, /redacted:circular/u);
    assert.match(json, /truncated:depth/u);
  });

  it("bounds arrays, object keys, and long strings", () => {
    const huge = Object.fromEntries(Array.from({ length: 150 }, (_value, index) => [`key${index}`, index]));
    const result = redactSensitive({ array: Array.from({ length: 150 }), huge, text: "x".repeat(20_000) }) as {
      array: unknown[];
      huge: Record<string, unknown>;
      text: string;
    };
    assert.equal(result.array.length, 100);
    assert.equal(Object.keys(result.huge).length, 100);
    assert.equal(result.text.length, 8_000);
  });
});

describe("anonymous diagnostic bundle", () => {
  it("normalizes a versioned bundle with only approved top-level sections", async () => {
    const report = await buildDiagnosticsReport(healthyAdapter(), () => 100);
    const bundle = normalizeDiagnosticBundle({
      report,
      logs: [{ level: "error", message: "safe" }],
      context: { feature: "thumbnail" },
    }, () => 200);
    assert.deepEqual(Object.keys(bundle), ["schemaVersion", "generatedAt", "report", "logs", "context"]);
    assert.equal(bundle.generatedAt, 200);
    assert.equal(bundle.schemaVersion, 1);
  });

  it("redacts every bundle section", async () => {
    const report = await buildDiagnosticsReport(healthyAdapter());
    const json = diagnosticBundleToJSON({
      report,
      logs: [{ message: "sk-1234567890 at /Users/alice/private.mov" }],
      context: { apiKey: "secret", transcript: "private words" },
    });
    assert.doesNotMatch(json, /sk-123|alice|private\.mov|private words|"secret"/u);
    assert.match(json, /redacted/u);
  });

  it("produces parseable pretty JSON", async () => {
    const report = await buildDiagnosticsReport(healthyAdapter());
    const json = diagnosticBundleToJSON({ report }, () => 300);
    assert.equal((JSON.parse(json) as { generatedAt: number }).generatedAt, 300);
    assert.ok(json.includes("\n  \"schemaVersion\""));
  });

  it("freezes the bundle and top-level collections", async () => {
    const report = await buildDiagnosticsReport(healthyAdapter());
    const bundle = normalizeDiagnosticBundle({ report, logs: [], context: {} });
    assert.ok(Object.isFrozen(bundle));
    assert.ok(Object.isFrozen(bundle.logs));
    assert.ok(Object.isFrozen(bundle.context));
  });
});

describe("active diagnostic redaction self-check", () => {
  it("passes canaries through the production diagnostic JSON serializer", () => {
    assert.equal(diagnosticRedactionSelfCheck(), true);
    assert.doesNotThrow(() => assertDiagnosticRedactionSelfCheck());
  });

  it("fails closed when a serializer leaves synthetic sensitive values intact", () => {
    let unsafePayload = "";
    const passed = diagnosticRedactionSelfCheck((input) => {
      unsafePayload = JSON.stringify(input);
      return unsafePayload;
    });

    assert.equal(passed, false);
    assert.match(unsafePayload, /SFDiagCanaryBearer|SFDiagCanaryTranscript|sk-proj-SFDiagCanaryKey/u);
    assert.equal(JSON.stringify(passed).includes("SFDiagCanary"), false);
  });

  it("rejects marker-only or malformed output that did not serialize the self-check input", () => {
    const markerOnly = JSON.stringify({
      schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
      context: {},
      values: [
        "Bearer <redacted>",
        "<redacted:secret>",
        "<redacted:path>",
        "<redacted:user>",
        "<redacted:media>",
        "<redacted:content>",
      ],
    });
    assert.equal(diagnosticRedactionSelfCheck(() => markerOnly), false);
    assert.equal(diagnosticRedactionSelfCheck(() => "not-json"), false);
  });

  it("throws only a fixed safe error when serialization fails with canaries in the cause", () => {
    assert.throws(
      () => assertDiagnosticRedactionSelfCheck((input) => {
        throw new Error(`unsafe serializer: ${JSON.stringify(input.context)}`);
      }),
      (error: unknown) => {
        assert.ok(error instanceof DiagnosticsError);
        assert.equal(error.code, "REDACTION_SELF_CHECK_FAILED");
        assert.equal(error.causeValue, undefined);
        assert.doesNotMatch(error.message, /SFDiagCanary|sk-proj-|Bearer|@example/u);
        return true;
      },
    );
  });
});

describe("telemetry payload allowlist", () => {
  it("publishes the exact sendable field allowlist", () => {
    assert.deepEqual(TELEMETRY_PAYLOAD_ALLOWLIST, [
      "schemaVersion",
      "eventId",
      "event",
      "timestamp",
      "sessionId",
      "pluginVersion",
      "hostVersion",
      "status",
      "operation",
      "errorCode",
      "durationMs",
      "capability",
    ]);
  });

  it("keeps only approved anonymous metadata", () => {
    const payload = normalizeTelemetryPayload("operation_failed", {
      pluginVersion: "1.2.3",
      hostVersion: "25.6.0",
      status: "failure",
      operation: "export_video",
      errorCode: "ENCODER_FAILED",
      durationMs: 123.4,
      capability: "encoder",
      apiKey: "sk-secret",
      path: "C:\\private.mov",
      transcript: "private words",
      message: "raw error",
    }, { eventId: "evt:test:1", timestamp: 10, sessionId: "session:test" });
    assert.deepEqual(Object.keys(payload), TELEMETRY_PAYLOAD_ALLOWLIST);
    const json = JSON.stringify(payload);
    assert.doesNotMatch(json, /sk-secret|private|raw error/u);
  });

  it("drops invalid optional metadata instead of coercing it", () => {
    const payload = normalizeTelemetryPayload("plugin_started", {
      pluginVersion: "latest",
      hostVersion: "C:\\secret",
      status: "unknown",
      operation: "contains spaces",
      errorCode: "bad/error",
      durationMs: Number.NaN,
      capability: "camera",
    }, { eventId: "evt:test", timestamp: 1 });
    assert.deepEqual(Object.keys(payload), ["schemaVersion", "eventId", "event", "timestamp"]);
  });

  it("clamps duration to one day and zero", () => {
    assert.equal(normalizeTelemetryPayload("operation_succeeded", { durationMs: -10 }, {
      eventId: "evt:1",
      timestamp: 1,
    }).durationMs, 0);
    assert.equal(normalizeTelemetryPayload("operation_succeeded", { durationMs: 999_999_999 }, {
      eventId: "evt:2",
      timestamp: 1,
    }).durationMs, 86_400_000);
  });

  it("rejects unknown events and unsafe event IDs", () => {
    assert.throws(
      () => normalizeTelemetryPayload("user_text" as never, {}, { eventId: "evt:1", timestamp: 1 }),
      DiagnosticsError,
    );
    assert.throws(
      () => normalizeTelemetryPayload("crash", {}, { eventId: "../../secret", timestamp: 1 }),
      DiagnosticsError,
    );
  });

  it("freezes normalized payloads", () => {
    assert.ok(Object.isFrozen(normalizeTelemetryPayload("crash", {}, {
      eventId: "evt:crash",
      timestamp: 1,
    })));
  });
});

describe("TelemetryManager consent and queue", () => {
  it("is OFF by default and does not enqueue before explicit opt-in", async () => {
    const { manager, storage } = telemetryFixture();
    await manager.initialize();
    assert.equal(manager.enabled, false);
    assert.equal(await manager.track("plugin_started"), null);
    assert.equal(manager.queue.length, 0);
    assert.equal(storage.writes, 0);
  });

  it("persists explicit opt-in with a consent version", async () => {
    const { manager, storage } = telemetryFixture();
    await manager.setOptIn(true);
    assert.equal(manager.enabled, true);
    const stored = JSON.parse(storage.values.get(TELEMETRY_STORAGE_KEY) ?? "") as {
      schemaVersion: number;
      consent: { enabled: boolean; version: number };
    };
    assert.equal(stored.schemaVersion, TELEMETRY_SCHEMA_VERSION);
    assert.equal(stored.consent.enabled, true);
    assert.equal(stored.consent.version, TELEMETRY_CONSENT_VERSION);
  });

  it("queues allowlisted events only after consent", async () => {
    const { manager } = telemetryFixture();
    await manager.setOptIn(true);
    const payload = await manager.track("operation_succeeded", {
      operation: "create_short",
      status: "success",
      apiKey: "sk-secret",
      prompt: "private",
    });
    assert.equal(payload?.operation, "create_short");
    assert.equal(manager.queue.length, 1);
    assert.doesNotMatch(JSON.stringify(manager.queue), /sk-secret|private/u);
  });

  it("opts out by deleting every queued event", async () => {
    const { manager } = telemetryFixture();
    await manager.setOptIn(true);
    await manager.track("plugin_started");
    await manager.setOptIn(false);
    assert.equal(manager.enabled, false);
    assert.equal(manager.queue.length, 0);
  });

  it("hard-caps the local queue at 100 and drops oldest events", async () => {
    const { manager } = telemetryFixture();
    await manager.setOptIn(true);
    for (let index = 0; index < MAX_TELEMETRY_QUEUE + 7; index += 1) {
      await manager.track("operation_succeeded", { operation: `op_${index}` });
    }
    assert.equal(manager.queue.length, MAX_TELEMETRY_QUEUE);
    assert.equal(manager.queue[0]?.payload.operation, "op_7");
    assert.equal(manager.queue.at(-1)?.payload.operation, "op_106");
  });

  it("supports a smaller queue limit for constrained runtimes", async () => {
    const { manager } = telemetryFixture({ maxQueue: 3 });
    await manager.setOptIn(true);
    for (let index = 0; index < 5; index += 1) {
      await manager.track("plugin_started", { operation: `op_${index}` });
    }
    assert.deepEqual(manager.queue.map((item) => item.payload.operation), ["op_2", "op_3", "op_4"]);
  });

  it("returns defensive frozen queue snapshots", async () => {
    const { manager } = telemetryFixture();
    await manager.setOptIn(true);
    await manager.track("plugin_started");
    const queue = manager.queue;
    assert.ok(Object.isFrozen(queue));
    assert.ok(Object.isFrozen(queue[0]));
    assert.ok(Object.isFrozen(queue[0]?.payload));
    assert.notEqual(manager.queue, queue);
  });

  it("rolls back consent and queue when storage persistence fails", async () => {
    const { manager, storage } = telemetryFixture();
    storage.failWrite = true;
    await assert.rejects(manager.setOptIn(true), (error: unknown) => (
      error instanceof DiagnosticsError && error.code === "STORAGE_ERROR"
    ));
    assert.equal(manager.enabled, false);
    storage.failWrite = false;
    await manager.setOptIn(true);
    storage.failWrite = true;
    await assert.rejects(manager.track("plugin_started"), DiagnosticsError);
    assert.equal(manager.queue.length, 0);
  });
});

describe("TelemetryManager crash-safe restore", () => {
  it("restores explicit consent and queued events", async () => {
    const fixture = telemetryFixture();
    await fixture.manager.setOptIn(true);
    await fixture.manager.track("plugin_started", { pluginVersion: "1.0.0" });
    const restored = new TelemetryManager(
      { storage: fixture.storage, provider: fixture.provider },
      { now: fixture.now, sessionId: "session:test" },
    );
    await restored.initialize();
    assert.equal(restored.enabled, true);
    assert.equal(restored.queue.length, 1);
    assert.equal(restored.queue[0]?.payload.event, "plugin_started");
  });

  it("defaults OFF on malformed JSON or storage read failure", async () => {
    const storage = new MemoryStorage();
    storage.values.set(TELEMETRY_STORAGE_KEY, "{");
    const malformed = new TelemetryManager({ storage });
    await malformed.initialize();
    assert.equal(malformed.enabled, false);
    assert.equal(malformed.queue.length, 0);
    storage.failRead = true;
    const failed = new TelemetryManager({ storage });
    await failed.initialize();
    assert.equal(failed.enabled, false);
  });

  it("rejects stale or wrong-version consent", async () => {
    const storage = new MemoryStorage();
    storage.values.set(TELEMETRY_STORAGE_KEY, JSON.stringify({
      schemaVersion: 1,
      consent: { enabled: true, version: 999, updatedAt: 1 },
      queue: [],
    }));
    const manager = new TelemetryManager({ storage });
    await manager.initialize();
    assert.equal(manager.enabled, false);
  });

  it("discards malformed, secret-bearing, and expired restored queue items", async () => {
    const storage = new MemoryStorage();
    const now = 10_000;
    const valid = normalizeTelemetryPayload("plugin_started", {}, {
      eventId: "evt:valid",
      timestamp: now,
    });
    storage.values.set(TELEMETRY_STORAGE_KEY, JSON.stringify({
      schemaVersion: 1,
      consent: { enabled: true, version: 1, updatedAt: now },
      queue: [
        null,
        { payload: { ...valid, eventId: "../../bad", apiKey: "secret" }, attempts: 0, createdAt: now, nextAttemptAt: now },
        { payload: valid, attempts: 0, createdAt: 1, nextAttemptAt: 1 },
        { payload: valid, attempts: 0, createdAt: now, nextAttemptAt: now },
      ],
    }));
    const manager = new TelemetryManager({ storage }, { now: () => now, queueTtlMs: 1_000 });
    await manager.initialize();
    assert.equal(manager.queue.length, 1);
    assert.doesNotMatch(JSON.stringify(manager.queue), /apiKey|secret/u);
  });

  it("caps an oversized restored queue", async () => {
    const storage = new MemoryStorage();
    const now = 10_000;
    const queue = Array.from({ length: 130 }, (_value, index) => ({
      payload: normalizeTelemetryPayload("plugin_started", { operation: `op_${index}` }, {
        eventId: `evt:${index}`,
        timestamp: now,
      }),
      attempts: 0,
      createdAt: now,
      nextAttemptAt: now,
    }));
    storage.values.set(TELEMETRY_STORAGE_KEY, JSON.stringify({
      schemaVersion: 1,
      consent: { enabled: true, version: 1, updatedAt: now },
      queue,
    }));
    const manager = new TelemetryManager({ storage }, { now: () => now });
    await manager.initialize();
    assert.equal(manager.queue.length, 100);
    assert.equal(manager.queue[0]?.payload.operation, "op_30");
  });
});

describe("TelemetryManager send, retry, and discard", () => {
  it("flushes queued events through the provider adapter", async () => {
    const { manager, provider } = telemetryFixture();
    await manager.setOptIn(true);
    await manager.track("plugin_started");
    await manager.track("diagnostic_completed", { status: "green" });
    const result = await manager.flush();
    assert.deepEqual(result, { sent: 2, retried: 0, discarded: 0, pending: 0 });
    assert.equal(provider.sent.length, 2);
    assert.equal(manager.queue.length, 0);
  });

  it("does not discard events when no provider is configured", async () => {
    const storage = new MemoryStorage();
    const manager = new TelemetryManager({ storage }, {
      now: () => 1,
      eventIdFactory: () => "evt:no-provider",
    });
    await manager.setOptIn(true);
    await manager.track("plugin_started");
    assert.deepEqual(await manager.flush(), { sent: 0, retried: 0, discarded: 0, pending: 1 });
  });

  it("backs off exponentially after provider failures", async () => {
    const { manager, provider, advance } = telemetryFixture({ baseRetryDelayMs: 100 });
    provider.failuresRemaining = 2;
    await manager.setOptIn(true);
    await manager.track("operation_failed");
    const first = await manager.flush();
    assert.equal(first.retried, 1);
    assert.equal(manager.queue[0]?.attempts, 1);
    assert.equal(manager.queue[0]?.nextAttemptAt, 1_000_100);
    assert.equal((await manager.flush()).pending, 1, "not-yet-due events must remain untouched");
    assert.equal(manager.queue[0]?.attempts, 1);
    advance(100);
    await manager.flush();
    assert.equal(manager.queue[0]?.attempts, 2);
    assert.equal(manager.queue[0]?.nextAttemptAt, 1_000_300);
  });

  it("sends a retry once its backoff expires", async () => {
    const { manager, provider, advance } = telemetryFixture({ baseRetryDelayMs: 10 });
    provider.failuresRemaining = 1;
    await manager.setOptIn(true);
    await manager.track("crash", { errorCode: "HOST_CRASH" });
    await manager.flush();
    advance(10);
    const result = await manager.flush();
    assert.equal(result.sent, 1);
    assert.equal(manager.queue.length, 0);
  });

  it("discards an event after the maximum attempt count", async () => {
    const { manager, provider, advance } = telemetryFixture({
      maxAttempts: 2,
      baseRetryDelayMs: 1,
    });
    provider.failuresRemaining = 10;
    await manager.setOptIn(true);
    await manager.track("crash");
    assert.equal((await manager.flush()).retried, 1);
    advance(1);
    const result = await manager.flush();
    assert.equal(result.discarded, 1);
    assert.equal(manager.queue.length, 0);
  });

  it("discards events that expire while queued", async () => {
    const { manager, advance } = telemetryFixture({ queueTtlMs: 1_000 });
    await manager.setOptIn(true);
    await manager.track("plugin_started");
    advance(1_001);
    const result = await manager.flush();
    assert.equal(result.discarded, 1);
    assert.equal(manager.queue.length, 0);
  });

  it("coalesces concurrent flush calls to avoid duplicate sends", async () => {
    const { manager, provider } = telemetryFixture();
    let release: (() => void) | undefined;
    provider.wait = new Promise<void>((resolve) => { release = resolve; });
    await manager.setOptIn(true);
    await manager.track("plugin_started");
    const first = manager.flush();
    const second = manager.flush();
    assert.equal(first, second);
    release?.();
    await Promise.all([first, second]);
    assert.equal(provider.sent.length, 1);
  });

  it("retains queue state when post-send persistence fails", async () => {
    const { manager, storage, provider } = telemetryFixture();
    await manager.setOptIn(true);
    await manager.track("plugin_started");
    storage.failWrite = true;
    await assert.rejects(manager.flush(), DiagnosticsError);
    assert.equal(manager.queue.length, 1);
    assert.equal(provider.sent.length, 1);
  });

  it("clears consent and storage explicitly", async () => {
    const { manager, storage } = telemetryFixture();
    await manager.setOptIn(true);
    await manager.track("plugin_started");
    await manager.clear();
    assert.equal(manager.enabled, false);
    assert.equal(manager.queue.length, 0);
    assert.equal(storage.values.has(TELEMETRY_STORAGE_KEY), false);
    assert.equal(storage.removes, 1);
  });

  it("rolls back an explicit clear when storage deletion fails", async () => {
    const { manager, storage } = telemetryFixture();
    await manager.setOptIn(true);
    await manager.track("plugin_started");
    storage.failWrite = true;
    await assert.rejects(
      manager.clear(),
      (error: unknown) => error instanceof DiagnosticsError && error.code === "STORAGE_ERROR",
    );
    assert.equal(manager.enabled, true);
    assert.equal(manager.queue.length, 1);
  });

  it("creates a vendor-neutral default adapter from explicit storage", () => {
    const storage = new MemoryStorage();
    const provider = new MockProvider();
    const adapter = createDefaultTelemetryAdapter(provider, storage);
    assert.equal(adapter.storage, storage);
    assert.equal(adapter.provider, provider);
  });
});
