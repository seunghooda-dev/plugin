#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import archiver from "archiver";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(projectRoot, "dist");
const releaseRoot = join(projectRoot, "release");
const forceOverwrite = process.argv.includes("--force");
const FIXED_ARCHIVE_DATE = new Date("1980-01-01T00:00:00.000Z");

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

async function createArchive(outputPath) {
  const archiveFiles = await listArchiveFiles();
  if (archiveFiles.length === 0) {
    throw new Error("dist에 패키징할 파일이 없습니다.");
  }

  try {
    await new Promise((resolveArchive, rejectArchive) => {
      const output = createWriteStream(outputPath, { flags: "wx" });
      const archive = archiver("zip", { zlib: { level: 9 } });
      let settled = false;

      const rejectOnce = (error) => {
        if (!settled) {
          settled = true;
          archive.abort();
          output.destroy();
          rejectArchive(error);
        }
      };

      output.on("close", () => {
        if (!settled) {
          settled = true;
          resolveArchive();
        }
      });
      output.on("error", rejectOnce);
      archive.on("error", rejectOnce);
      archive.on("warning", (error) => {
        if (error.code === "ENOENT") {
          rejectOnce(error);
        } else {
          console.warn(`CCX 압축 경고: ${error.message}`);
        }
      });

      archive.pipe(output);

      // 고정 순서와 날짜로 추가해 같은 dist가 바이트 단위로 같은 CCX를 만들게 합니다.
      for (const file of archiveFiles) {
        archive.file(file.absolutePath, {
          name: file.archivePath,
          date: FIXED_ARCHIVE_DATE,
          mode: 0o644
        });
      }
      archive.finalize().catch(rejectOnce);
    });
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
