import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const ROOT = path.resolve(__dirname, "../..");

function readProjectFile(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

describe("internal beta release scripts contract", () => {
  it("exposes the expected verification and evidence commands", () => {
    const pkg = JSON.parse(readProjectFile("package.json")) as { scripts?: Record<string, string> };
    assert.equal(pkg.scripts?.["check"], "npm run typecheck && npm run lint && npm run build && npm test");
    assert.equal(pkg.scripts?.["verify:release"], "node scripts/verify-release.mjs");
    assert.equal(pkg.scripts?.["verify:speech"], "node scripts/verify-speech-live.mjs");
    assert.equal(pkg.scripts?.["verify:speech:live"], "node scripts/verify-speech-live.mjs --live");
    assert.equal(
      pkg.scripts?.["beta:evidence:verified"],
      "npm run check && npm run package:ccx:force && node scripts/collect-beta-evidence.mjs --verified",
    );
  });

  it("keeps the beta evidence template aligned with the current Host gates", () => {
    const source = readProjectFile("scripts/collect-beta-evidence.mjs");
    for (const required of [
      "- [x] Validate Safe Zone BMP overlay import/insert in Premiere.",
      "- [x] Validate SRT file import into the subtitle editor.",
      "- [x] Validate asset root, Music/SFX sync, and basic WAV import/insert.",
      "- [x] Validate timeline TrackItem selection detection in the ShortFlow status UI.",
      "- [ ] Validate TTS audio file save, Premiere import, and target audio track insert.",
      "- [ ] Validate clone-before-mutation, automation marker creation, punch-in apply, export, and recovery journal.",
      "- [ ] Validate final QC, diagnostics JSON export, and absence of secrets in logs/reports.",
    ]) {
      assert.match(source, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    }
  });

  it("keeps speech live verification opt-in, redacted, and outside git", () => {
    const source = readProjectFile("scripts/verify-speech-live.mjs");
    assert.match(source, /const live = process\.argv\.includes\("--live"\)/u);
    assert.match(source, /status: "skipped-live-api"/u);
    assert.match(source, /OPENAI_API_KEY/u);
    assert.match(source, /API keys, authorization headers, or raw audio bytes/u);
    assert.match(source, /speech-evidence/u);
    assert.match(source, /redact/u);
    assert.match(source, /TTS\/STT live smoke 검증 실패/u);
  });

  it("keeps generated evidence and release candidates out of git", () => {
    const ignore = readProjectFile(".gitignore");
    assert.match(ignore, /^release\/$/mu);
    assert.match(ignore, /^beta-evidence\/$/mu);
    assert.match(ignore, /^speech-evidence\/$/mu);
  });

  it("fails the test gate when compiled tests are missing", () => {
    const runner = readProjectFile("scripts/run-tests.mjs");
    assert.match(runner, /No compiled test files found in \.test-build\/tests\./u);
    assert.match(runner, /testFiles\.length === 0/u);
    assert.match(runner, /process\.exitCode = 1/u);
    assert.match(runner, /\["--test", \.\.\.testFiles\]/u);
  });

  it("keeps CCX candidates free of source, tests, secrets, and build caches", () => {
    const verifier = readProjectFile("scripts/verify-release.mjs");
    for (const forbidden of [
      "node_modules",
      "src",
      "tests",
      ".git",
      ".env",
      "secret",
      "credential",
      ".test-build",
    ]) {
      assert.match(verifier, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    }
  });
});
