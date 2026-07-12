#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = join(projectRoot, "speech-evidence");
const endpoint = "https://api.openai.com/v1";
const live = process.argv.includes("--live");
const timeoutMs = 120_000;
const ttsText = "숏플로우 음성 검증입니다.";
const ttsModel = "gpt-4o-mini-tts";
const ttsVoice = "marin";
const ttsFormat = "wav";
const sttModel = "gpt-4o-mini-transcribe";

function replaceControlCharacters(value) {
  return [...value].map((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 ? " " : character;
  }).join("");
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/u, "Z");
}

function redact(value) {
  return replaceControlCharacters(String(value ?? ""))
    .replace(/bearer\s+[^\s"']+/giu, "Bearer [REDACTED]")
    .replace(/\bsk-[a-z0-9_-]{8,}\b/giu, "[REDACTED]")
    .split("  ").join(" ")
    .slice(0, 500);
}

function validApiKey(value) {
  return typeof value === "string" && value.trim().length >= 20 && !/\s/u.test(value.trim());
}

function isWav(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 44) return false;
  const head = new TextDecoder("ascii").decode(bytes.slice(0, 12));
  return head.startsWith("RIFF") && head.includes("WAVE");
}

async function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function responseDetail(response, secret) {
  let detail = "";
  try {
    const payload = await response.json();
    detail = JSON.stringify(payload);
  } catch {
    try { detail = await response.text(); } catch { detail = ""; }
  }
  return redact(secret ? detail.split(secret).join("[REDACTED]") : detail);
}

async function synthesize(apiKey) {
  const response = await fetchWithTimeout(`${endpoint}/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: ttsModel,
      voice: ttsVoice,
      input: ttsText,
      response_format: ttsFormat,
      speed: 1,
      instructions: "또렷하고 자연스러운 한국어로 말합니다.",
    }),
  });
  if (!response.ok) {
    throw new Error(`TTS failed HTTP ${response.status}: ${await responseDetail(response, apiKey)}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function transcribe(apiKey, wavBytes) {
  const form = new FormData();
  form.append("file", new Blob([wavBytes], { type: "audio/wav" }), "shortflow-speech-smoke.wav");
  form.append("model", sttModel);
  form.append("language", "ko");
  form.append("response_format", "json");

  const response = await fetchWithTimeout(`${endpoint}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!response.ok) {
    throw new Error(`STT failed HTTP ${response.status}: ${await responseDetail(response, apiKey)}`);
  }
  const payload = await response.json();
  const text = typeof payload?.text === "string" ? payload.text.trim() : "";
  if (!text) throw new Error("STT returned an empty transcript.");
  return text;
}

async function writeEvidence(report) {
  await mkdir(evidenceRoot, { recursive: true });
  const fileName = `ShortFlow_Speech_Evidence_${timestamp()}.md`;
  const lines = [
    "# ShortFlow TTS/STT Evidence",
    "",
    `- mode: ${report.mode}`,
    `- generatedAt: ${report.generatedAt}`,
    `- endpoint: ${endpoint}`,
    `- ttsModel: ${ttsModel}`,
    `- ttsVoice: ${ttsVoice}`,
    `- ttsFormat: ${ttsFormat}`,
    `- sttModel: ${sttModel}`,
    `- ttsTextCharacters: ${ttsText.length}`,
    `- status: ${report.status}`,
    `- ttsBytes: ${report.ttsBytes ?? "n/a"}`,
    `- ttsWavHeaderValid: ${report.ttsWavHeaderValid ?? "n/a"}`,
    `- sttTranscript: ${report.sttTranscript ? redact(report.sttTranscript) : "n/a"}`,
    `- error: ${report.error ? redact(report.error) : "n/a"}`,
    "",
    "Notes:",
    "",
    "- This file intentionally does not include API keys, authorization headers, or raw audio bytes.",
    "- Keep this evidence outside Git. The `speech-evidence/` folder is ignored.",
  ];
  const path = join(evidenceRoot, fileName);
  await writeFile(path, `${lines.join("\n")}\n`, "utf8");
  return path;
}

async function main() {
  const generatedAt = new Date().toISOString();
  if (!live) {
    const evidencePath = await writeEvidence({
      mode: "dry-run",
      generatedAt,
      status: "skipped-live-api",
    });
    console.log("ℹ live API 호출 없이 dry-run 증거를 생성했습니다.");
    console.log(`  증거 파일: ${evidencePath}`);
    console.log("  실제 호출은 OPENAI_API_KEY를 설정한 뒤 `npm run verify:speech:live`로 실행합니다.");
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
  if (!validApiKey(apiKey)) {
    const evidencePath = await writeEvidence({
      mode: "live",
      generatedAt,
      status: "blocked",
      error: "OPENAI_API_KEY is missing or invalid.",
    });
    throw new Error(`OPENAI_API_KEY가 없거나 유효하지 않습니다. 증거 파일: ${evidencePath}`);
  }

  let report;
  try {
    const wavBytes = await synthesize(apiKey);
    const transcript = await transcribe(apiKey, wavBytes);
    report = {
      mode: "live",
      generatedAt,
      status: "pass",
      ttsBytes: wavBytes.byteLength,
      ttsWavHeaderValid: isWav(wavBytes),
      sttTranscript: transcript,
    };
    if (!report.ttsWavHeaderValid) {
      throw new Error("TTS response did not look like a WAV file.");
    }
  } catch (error) {
    report = {
      mode: "live",
      generatedAt,
      status: "fail",
      error: error instanceof Error ? error.message : String(error),
    };
    const evidencePath = await writeEvidence(report);
    throw new Error(`TTS/STT live smoke 검증 실패. 증거 파일: ${evidencePath}. ${redact(report.error)}`);
  }

  const evidencePath = await writeEvidence(report);
  console.log("✓ TTS/STT live smoke 검증을 통과했습니다.");
  console.log(`  TTS bytes: ${report.ttsBytes}`);
  console.log(`  STT transcript: ${redact(report.sttTranscript)}`);
  console.log(`  증거 파일: ${evidencePath}`);
}

main().catch((error) => {
  console.error(redact(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
