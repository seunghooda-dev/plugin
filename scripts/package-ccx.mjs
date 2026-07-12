#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(projectRoot, "dist");
const releaseRoot = join(projectRoot, "release");
const forceOverwrite = process.argv.includes("--force");
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = 33;
const UTF8_FLAG = 0x0800;
const DEFLATE_METHOD = 8;

const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC32_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC32_TABLE[index] = value >>> 0;
}

function verifyDist() {
  const result = spawnSync(process.execPath, [join(projectRoot, "scripts", "verify-dist.mjs")], {
    cwd: projectRoot,
    stdio: "inherit"
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error("dist 검증에 실패하여 CCX 패키징을 중단했습니다.");
  }
}

async function readPackageVersion() {
  const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  const version = packageJson.version;

  if (typeof version !== "string" || !/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) {
    throw new Error(`package.json의 version을 파일명에 사용할 수 없습니다: ${JSON.stringify(version)}`);
  }

  return version;
}

async function ensureDistDirectory() {
  let distStat;
  try {
    distStat = await stat(distRoot);
  } catch {
    throw new Error("dist 디렉터리가 없습니다. 먼저 npm run build를 실행해 주세요.");
  }

  if (!distStat.isDirectory()) {
    throw new Error("dist 경로가 디렉터리가 아닙니다.");
  }
}

async function listArchiveFiles(directory = distRoot, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const files = [];

  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    const archivePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await listArchiveFiles(absolutePath, archivePath));
    } else if (entry.isFile()) {
      files.push({ absolutePath, archivePath });
    } else {
      throw new Error(`CCX에 지원하지 않는 파일 시스템 항목이 있습니다: ${archivePath}`);
    }
  }

  return files;
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function uint16(value) {
  const buffer = Buffer.allocUnsafe(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function uint32(value) {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function makeLocalHeader(file) {
  return Buffer.concat([
    uint32(0x04034b50),
    uint16(20),
    uint16(UTF8_FLAG),
    uint16(DEFLATE_METHOD),
    uint16(FIXED_DOS_TIME),
    uint16(FIXED_DOS_DATE),
    uint32(file.crc),
    uint32(file.compressed.length),
    uint32(file.source.length),
    uint16(file.name.length),
    uint16(0),
    file.name,
  ]);
}

function makeCentralHeader(file, localHeaderOffset) {
  return Buffer.concat([
    uint32(0x02014b50),
    uint16(20),
    uint16(20),
    uint16(UTF8_FLAG),
    uint16(DEFLATE_METHOD),
    uint16(FIXED_DOS_TIME),
    uint16(FIXED_DOS_DATE),
    uint32(file.crc),
    uint32(file.compressed.length),
    uint32(file.source.length),
    uint16(file.name.length),
    uint16(0),
    uint16(0),
    uint16(0),
    uint16(0),
    uint32(0o100644 << 16),
    uint32(localHeaderOffset),
    file.name,
  ]);
}

function makeEndOfCentralDirectory(fileCount, centralDirectorySize, centralDirectoryOffset) {
  return Buffer.concat([
    uint32(0x06054b50),
    uint16(0),
    uint16(0),
    uint16(fileCount),
    uint16(fileCount),
    uint32(centralDirectorySize),
    uint32(centralDirectoryOffset),
    uint16(0),
  ]);
}

async function createArchive(outputPath) {
  const archiveFiles = await listArchiveFiles();
  if (archiveFiles.length === 0) {
    throw new Error("dist에 패키징할 파일이 없습니다.");
  }
  if (archiveFiles.length > 0xffff) {
    throw new Error("ZIP64가 필요한 파일 수는 지원하지 않습니다.");
  }

  const preparedFiles = [];
  for (const file of archiveFiles) {
    const source = await readFile(file.absolutePath);
    const compressed = deflateRawSync(source, { level: 9 });
    if (source.length > 0xffffffff || compressed.length > 0xffffffff) {
      throw new Error(`ZIP64가 필요한 파일 크기는 지원하지 않습니다: ${file.archivePath}`);
    }
    preparedFiles.push({
      name: Buffer.from(file.archivePath, "utf8"),
      source,
      compressed,
      crc: crc32(source),
    });
  }

  const outputChunks = [];
  const centralDirectoryChunks = [];
  let offset = 0;
  for (const file of preparedFiles) {
    const localHeader = makeLocalHeader(file);
    outputChunks.push(localHeader, file.compressed);
    centralDirectoryChunks.push(makeCentralHeader(file, offset));
    offset += localHeader.length + file.compressed.length;
  }

  const centralDirectory = Buffer.concat(centralDirectoryChunks);
  const endOfCentralDirectory = makeEndOfCentralDirectory(
    preparedFiles.length,
    centralDirectory.length,
    offset,
  );
  const archive = Buffer.concat([...outputChunks, centralDirectory, endOfCentralDirectory]);

  try {
    await writeFile(outputPath, archive, { flag: "wx" });
  } catch (error) {
    await rm(outputPath, { force: true });
    throw error;
  }
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

async function main() {
  await ensureDistDirectory();
  verifyDist();

  const version = await readPackageVersion();
  const ccxFilename = `ShortFlow-Studio-${version}.ccx`;
  const ccxPath = join(releaseRoot, ccxFilename);
  const temporaryPath = `${ccxPath}.tmp`;
  const checksumPath = `${ccxPath}.sha256.txt`;

  await mkdir(releaseRoot, { recursive: true });
  await rm(temporaryPath, { force: true });
  await createArchive(temporaryPath);

  const nextChecksum = await sha256File(temporaryPath);
  if (await exists(ccxPath)) {
    const currentChecksum = await sha256File(ccxPath);
    if (currentChecksum === nextChecksum) {
      await rm(temporaryPath, { force: true });
      console.log("ℹ 동일한 CCX가 이미 있어 기존 파일을 유지합니다.");
    } else if (!forceOverwrite) {
      await rm(temporaryPath, { force: true });
      throw new Error(
        `기존 ${ccxFilename}의 내용이 다릅니다. 서명된 파일을 보호하기 위해 덮어쓰지 않았습니다. ` +
        "기존 파일을 보관/이동하거나 npm run package:ccx:force를 명시적으로 실행해 주세요."
      );
    } else {
      await rm(ccxPath, { force: true });
      await rename(temporaryPath, ccxPath);
    }
  } else {
    await rename(temporaryPath, ccxPath);
  }

  const checksum = await sha256File(ccxPath);
  await writeFile(checksumPath, `${checksum}  ${ccxFilename}\n`, "utf8");

  const archiveStat = await stat(ccxPath);
  console.log(`✓ CCX 생성: ${ccxPath}`);
  console.log(`  크기: ${archiveStat.size.toLocaleString("ko-KR")} bytes`);
  console.log(`  SHA-256: ${checksum}`);
  console.log(`  체크섬 파일: ${checksumPath}`);
  console.warn("⚠ 이 파일은 로컬 패키징 산출물입니다. Adobe 서명 또는 Marketplace 심사 완료를 의미하지 않습니다.");
}

main().catch((error) => {
  console.error("CCX 패키징에 실패했습니다.");
  console.error(error);
  process.exitCode = 1;
});
