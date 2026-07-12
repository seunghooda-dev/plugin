#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = join(projectRoot, "release");
const failures = [];
const notices = [];
const MIN_CCX_BYTES = 1_024;
const MAX_CCX_BYTES = 500 * 1024 * 1024;
const MAX_ENTRY_BYTES = 250 * 1024 * 1024;
const REQUIRED_CCX_ROOT_FILES = new Set([
  "manifest.json",
  "index.html",
  "index.js",
  "styles.css",
  "icons/shortflow.svg",
]);
const FORBIDDEN_CCX_PATH = /(?:^|\/)(?:dist|src|tests|node_modules|release|\.git|\.github|coverage|\.test-build|\.ai-test-build|\.thumbnail-test-build|\.job-test-build|\.recovery-test-build|\.final-qc-test-build)(?:\/|$)/i;
const SENSITIVE_CCX_PATH = /(?:^|\/)(?:\.env(?:[._-][^/]*)?|credentials?(?:[._-][^/]*)?|secrets?(?:[._-][^/]*)?|\.(?:npmrc|netrc)|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:pem|key|p12|pfx))$/i;

function fail(message) {
  failures.push(message);
}

function notice(message) {
  notices.push(message);
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function readUInt16LE(buffer, offset) {
  if (offset + 2 > buffer.length) throw new Error("ZIP 구조가 잘렸습니다.");
  return buffer.readUInt16LE(offset);
}

function readUInt32LE(buffer, offset) {
  if (offset + 4 > buffer.length) throw new Error("ZIP 구조가 잘렸습니다.");
  return buffer.readUInt32LE(offset);
}

function findEndOfCentralDirectory(buffer) {
  const signature = 0x06054b50;
  const minimumSize = 22;
  const maxCommentSize = 0xffff;
  const start = Math.max(0, buffer.length - minimumSize - maxCommentSize);
  for (let offset = buffer.length - minimumSize; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== signature) continue;
    const commentLength = readUInt16LE(buffer, offset + 20);
    if (offset + minimumSize + commentLength === buffer.length) return offset;
  }
  return -1;
}

function normalizeZipPath(rawName) {
  return rawName.replace(/\\/g, "/");
}

function validateZipEntryPath(name) {
  if (!name || name.length > 512) {
    fail(`CCX 내부 경로가 비어 있거나 너무 깁니다: ${name || "(empty)"}`);
    return;
  }
  if (
    name.startsWith("/") ||
    name.startsWith("//") ||
    /^[a-z][a-z\d+.-]*:/i.test(name) ||
    /[\0\r\n]/.test(name) ||
    name.split("/").includes("..")
  ) {
    fail(`CCX 내부 경로가 안전하지 않습니다: ${name}`);
  }
  if (FORBIDDEN_CCX_PATH.test(name)) {
    fail(`CCX에 배포하면 안 되는 개발 경로가 포함됐습니다: ${name}`);
  }
  if (SENSITIVE_CCX_PATH.test(name)) {
    fail(`CCX에 민감 파일명이 포함됐습니다: ${name}`);
  }
  if (name.toLowerCase().endsWith(".map")) {
    fail(`내부 베타 CCX에는 source map을 포함하지 않습니다: ${name}`);
  }
}

function parseCentralDirectory(buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) {
    throw new Error("ZIP 중앙 디렉터리를 찾을 수 없습니다.");
  }

  const diskNumber = readUInt16LE(buffer, eocdOffset + 4);
  const centralDirectoryDisk = readUInt16LE(buffer, eocdOffset + 6);
  if (diskNumber !== 0 || centralDirectoryDisk !== 0) {
    throw new Error("분할 ZIP/CCX는 지원하지 않습니다.");
  }

  const entryCount = readUInt16LE(buffer, eocdOffset + 10);
  const centralDirectorySize = readUInt32LE(buffer, eocdOffset + 12);
  const centralDirectoryOffset = readUInt32LE(buffer, eocdOffset + 16);
  const centralDirectoryEnd = centralDirectoryOffset + centralDirectorySize;
  if (centralDirectoryOffset < 0 || centralDirectoryEnd > buffer.length || centralDirectoryOffset >= eocdOffset) {
    throw new Error("ZIP 중앙 디렉터리 위치가 올바르지 않습니다.");
  }

  const entries = [];
  let offset = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (readUInt32LE(buffer, offset) !== 0x02014b50) {
      throw new Error(`ZIP 중앙 디렉터리 엔트리 ${index + 1}의 signature가 올바르지 않습니다.`);
    }

    const flags = readUInt16LE(buffer, offset + 8);
    const compressionMethod = readUInt16LE(buffer, offset + 10);
    const compressedSize = readUInt32LE(buffer, offset + 20);
    const uncompressedSize = readUInt32LE(buffer, offset + 24);
    const fileNameLength = readUInt16LE(buffer, offset + 28);
    const extraLength = readUInt16LE(buffer, offset + 30);
    const commentLength = readUInt16LE(buffer, offset + 32);
    const localHeaderOffset = readUInt32LE(buffer, offset + 42);
    const nameStart = offset + 46;
    const nameEnd = nameStart + fileNameLength;
    if (nameEnd > buffer.length) {
      throw new Error("ZIP 파일명이 중앙 디렉터리 범위를 벗어났습니다.");
    }

    const rawName = buffer.toString(flags & 0x0800 ? "utf8" : "binary", nameStart, nameEnd);
    entries.push({
      name: normalizeZipPath(rawName),
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    offset = nameEnd + extraLength + commentLength;
  }

  if (offset !== centralDirectoryEnd) {
    throw new Error("ZIP 중앙 디렉터리 크기와 엔트리 길이가 일치하지 않습니다.");
  }

  return entries;
}

async function validateCcxArchive(ccxPath) {
  let buffer;
  try {
    buffer = await readFile(ccxPath);
  } catch (error) {
    fail(`CCX 내부 구조를 읽을 수 없습니다: ${error.message}`);
    return;
  }

  let entries;
  try {
    entries = parseCentralDirectory(buffer);
  } catch (error) {
    fail(`CCX ZIP 구조가 올바르지 않습니다: ${error.message}`);
    return;
  }

  if (entries.length === 0) {
    fail("CCX 내부에 파일이 없습니다.");
    return;
  }

  const names = new Set();
  for (const entry of entries) {
    validateZipEntryPath(entry.name);
    if (names.has(entry.name)) {
      fail(`CCX 내부 경로가 중복됐습니다: ${entry.name}`);
    }
    names.add(entry.name);
    if (entry.name.endsWith("/")) {
      fail(`CCX에는 명시적 디렉터리 엔트리를 넣지 않습니다: ${entry.name}`);
    }
    if (entry.uncompressedSize === 0) {
      fail(`CCX 내부 파일이 비어 있습니다: ${entry.name}`);
    }
    if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
      fail(`CCX 내부 단일 파일이 250MB를 초과했습니다: ${entry.name}`);
    }
    if (![0, 8].includes(entry.compressionMethod)) {
      fail(`CCX 내부 파일의 압축 방식이 지원 범위를 벗어났습니다: ${entry.name}`);
    }
    if (entry.localHeaderOffset >= buffer.length) {
      fail(`CCX 내부 파일의 local header 위치가 올바르지 않습니다: ${entry.name}`);
    }
  }

  for (const required of REQUIRED_CCX_ROOT_FILES) {
    if (!names.has(required)) {
      fail(`CCX 루트 필수 파일이 없습니다: ${required}`);
    }
  }
  if ([...names].some((name) => name.startsWith("dist/"))) {
    fail("CCX 루트에 dist/ 폴더가 들어가면 안 됩니다. dist 내용물이 루트에 있어야 합니다.");
  }

  notice(`CCX 내부 파일: ${entries.length.toLocaleString("ko-KR")}개`);
}

async function readPackageVersion() {
  try {
    const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
    const version = packageJson.version;
    if (typeof version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) {
      fail(`package.json version을 릴리스 파일명에 사용할 수 없습니다: ${JSON.stringify(version)}`);
      return null;
    }
    return version;
  } catch (error) {
    fail(`package.json을 읽을 수 없습니다: ${error.message}`);
    return null;
  }
}

async function validateNoTemporaryArtifacts() {
  let entries;
  try {
    entries = await readdir(releaseRoot, { withFileTypes: true });
  } catch {
    fail("release 디렉터리를 찾을 수 없습니다. 먼저 npm run package:ccx를 실행해 주세요.");
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile() && !entry.isDirectory()) {
      fail(`release에 지원하지 않는 파일 시스템 항목이 있습니다: ${entry.name}`);
    }
    if (entry.name.endsWith(".tmp")) {
      fail(`중단된 패키징 임시 파일이 남아 있습니다: ${entry.name}`);
    }
  }
}

async function validateReleaseCandidate(version) {
  const ccxFilename = `ShortFlow-Studio-${version}.ccx`;
  const ccxPath = join(releaseRoot, ccxFilename);
  const checksumPath = `${ccxPath}.sha256.txt`;

  if (!await exists(ccxPath)) {
    fail(`CCX 후보 파일이 없습니다: release/${ccxFilename}`);
    return;
  }
  if (!await exists(checksumPath)) {
    fail(`CCX 체크섬 파일이 없습니다: release/${ccxFilename}.sha256.txt`);
    return;
  }

  let ccxStat;
  try {
    ccxStat = await stat(ccxPath);
  } catch (error) {
    fail(`CCX 파일 정보를 읽을 수 없습니다: ${error.message}`);
    return;
  }

  if (!ccxStat.isFile()) {
    fail(`CCX 경로가 파일이 아닙니다: release/${ccxFilename}`);
  }
  if (ccxStat.size < MIN_CCX_BYTES) {
    fail(`CCX 파일 크기가 비정상적으로 작습니다: ${ccxStat.size} bytes`);
  }
  if (ccxStat.size > MAX_CCX_BYTES) {
    fail(`CCX 파일 크기가 500MB 안전 한도를 초과했습니다: ${ccxStat.size} bytes`);
  }

  const actualChecksum = await sha256File(ccxPath);
  let checksumText;
  try {
    checksumText = await readFile(checksumPath, "utf8");
  } catch (error) {
    fail(`체크섬 파일을 읽을 수 없습니다: ${error.message}`);
    return;
  }

  const expectedLine = `${actualChecksum}  ${ccxFilename}`;
  const normalizedText = checksumText.replace(/\r\n/g, "\n").trim();
  if (normalizedText !== expectedLine) {
    fail("체크섬 파일 내용이 실제 CCX SHA-256 또는 파일명과 일치하지 않습니다.");
  }

  notice(`CCX 후보: release/${ccxFilename}`);
  notice(`크기: ${ccxStat.size.toLocaleString("ko-KR")} bytes`);
  notice(`SHA-256: ${actualChecksum}`);
  await validateCcxArchive(ccxPath);
}

function printResult() {
  for (const message of notices) {
    console.info(`ℹ ${message}`);
  }

  if (failures.length > 0) {
    console.error(`\n릴리스 산출물 검증 실패 (${failures.length}건)`);
    for (const message of failures) {
      console.error(`- ${message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("✓ 릴리스 산출물 검증을 통과했습니다.");
}

async function main() {
  const version = await readPackageVersion();
  await validateNoTemporaryArtifacts();
  if (version) {
    await validateReleaseCandidate(version);
  }
  printResult();
}

main().catch((error) => {
  console.error("릴리스 산출물 검증 중 예상하지 못한 오류가 발생했습니다.");
  console.error(error);
  process.exitCode = 1;
});
