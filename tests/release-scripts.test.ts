import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
      pkg.scripts?.["verify:speech:local"],
      "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-local-whisper.ps1",
    );
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
      "- [x] Validate clone-before-mutation, automation marker creation, and basic punch-in apply.",
      "- [x] Validate recovery journal persistence and committed entries after plugin reload.",
      "- [ ] Validate recovery rollback/removal only after explicit confirmation in a disposable project.",
      "- [x] Run Final QC in the real Host and record its blocking codes.",
      "- [ ] Resolve every Final QC blocking code before beta approval; waivers may apply only to eligible non-hard-block checks.",
      "- [x] Export diagnostics JSON and confirm the current fixture contains no API key",
      "- [ ] Exercise active redaction with synthetic sensitive values before external diagnostic sharing.",
      "checkpointChecklist: docs/BETA_RELEASE_CHECKLIST.md",
      "Approve the internal beta only when report.blocking === false",
      "PASS/WARNING/ERROR counts and the absence of a hard-block label are not substitutes.",
      "Do not run destructive Host smoke against a real user project; use a disposable project and clone-first flow.",
      '"status", "--porcelain=v1", "--untracked-files=all"',
      '"HEAD^{tree}"',
      "Verified beta evidence requires a clean committed worktree.",
    ]) {
      assert.match(source, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    }
  });

  it("rejects verified evidence capture from a dirty committed worktree without writing evidence", () => {
    const fixtureRoot = mkdtempSync(path.join(tmpdir(), "shortflow-beta-evidence-"));
    try {
      const scriptDir = path.join(fixtureRoot, "scripts");
      const publicDir = path.join(fixtureRoot, "public");
      mkdirSync(scriptDir, { recursive: true });
      mkdirSync(publicDir, { recursive: true });
      copyFileSync(
        path.join(ROOT, "scripts/collect-beta-evidence.mjs"),
        path.join(scriptDir, "collect-beta-evidence.mjs"),
      );
      writeFileSync(
        path.join(fixtureRoot, "package.json"),
        JSON.stringify({ name: "shortflow-release-contract-fixture", version: "0.0.0" }),
        "utf8",
      );
      writeFileSync(
        path.join(publicDir, "manifest.json"),
        JSON.stringify({ id: "shortflow.fixture", version: "0.0.0", host: { app: "PPRO", minVersion: "25.0.0" } }),
        "utf8",
      );

      execFileSync("git", ["init"], { cwd: fixtureRoot, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "shortflow-release-contract@example.invalid"], {
        cwd: fixtureRoot,
        stdio: "ignore",
      });
      execFileSync("git", ["config", "user.name", "ShortFlow Release Contract"], {
        cwd: fixtureRoot,
        stdio: "ignore",
      });
      execFileSync("git", ["add", "."], { cwd: fixtureRoot, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "test fixture baseline"], { cwd: fixtureRoot, stdio: "ignore" });

      writeFileSync(path.join(fixtureRoot, "dirty-marker.txt"), "uncommitted\n", "utf8");
      const result = spawnSync(
        process.execPath,
        [path.join(scriptDir, "collect-beta-evidence.mjs"), "--verified"],
        { cwd: fixtureRoot, encoding: "utf8" },
      );

      assert.notEqual(result.status, 0);
      assert.match(
        `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
        /Verified beta evidence requires a clean committed worktree/u,
      );
      assert.equal(existsSync(path.join(fixtureRoot, "beta-evidence")), false);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("documents the final internal beta checkpoint gate", () => {
    const checklist = readProjectFile("docs/BETA_RELEASE_CHECKLIST.md");
    for (const required of [
      "npm run typecheck",
      "npm run lint",
      "npm test",
      "npm run build",
      "npm run beta:evidence:verified",
      "최종 QC hard block",
      "권리 리포트",
      "진단 JSON",
      "GitHub push",
    ]) {
      assert.match(checklist, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    }

    const readme = readProjectFile("README.md");
    assert.match(readme, /docs\/BETA_RELEASE_CHECKLIST\.md/u);
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

  it("keeps local Whisper verification offline, timestamped, and outside the product provider", () => {
    const source = readProjectFile("scripts/verify-local-whisper.ps1");
    assert.match(source, /ShortFlowStudio\\whisper/u);
    assert.match(source, /--model_dir/u);
    assert.match(source, /--word_timestamps True/u);
    assert.match(source, /--output_format all/u);
    assert.match(source, /local-whisper-evidence/u);
    assert.match(source, /does not use an OpenAI API key or a network STT call/u);
    assert.match(source, /expectedKeywordMatches/u);
    assert.match(source, /expectedMatchCount -lt 2/u);
    assert.match(source, /function Test-FiniteNumber/u);
    assert.match(source, /\$timedSegments/u);
    assert.match(source, /UTF8Encoding\(\$false, \$true\)/u);
    assert.match(source, /word timestamp falls outside its segment range/u);
    assert.match(source, /Test-ContainsHangul/u);
    assert.match(source, /IsNullOrWhiteSpace/u);
    assert.match(source, /FromBase64String/u);
    assert.doesNotMatch(source, /OPENAI_API_KEY/u);
    assert.doesNotMatch(source, /[^\u0000-\u007f]/u);
  });

  it("keeps generated evidence and release candidates out of git", () => {
    const ignore = readProjectFile(".gitignore");
    assert.match(ignore, /^release\/$/mu);
    assert.match(ignore, /^beta-evidence\/$/mu);
    assert.match(ignore, /^speech-evidence\/$/mu);
    assert.match(ignore, /^local-whisper-evidence\/$/mu);
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
