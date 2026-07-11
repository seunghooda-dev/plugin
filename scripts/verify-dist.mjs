#!/usr/bin/env node

import { access, lstat, readFile, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(projectRoot, "dist");
const failures = [];
const notices = [];
const MAX_DIST_FILES = 5_000;
const MAX_DIST_FILE_BYTES = 250 * 1024 * 1024;
const MAX_DIST_TOTAL_BYTES = 500 * 1024 * 1024;
const REQUIRED_NETWORK_DOMAINS = ["https://api.openai.com"];
const SENSITIVE_DISTRIBUTION_PATH = /(?:^|\/)(?:\.env(?:[._-][^/]*)?|credentials?(?:[._-][^/]*)?|secrets?(?:[._-][^/]*)?|\.(?:npmrc|netrc)|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:pem|key|p12|pfx))$/i;

function fail(message) {
  failures.push(message);
}

function notice(message) {
  notices.push(message);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function parseVersion(value) {
  if (!isNonEmptyString(value)) {
    return null;
  }

  const match = value.trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?(?:[-+].*)?$/);
  if (!match) {
    return null;
  }

  return match.slice(1, 4).map((part) => Number(part ?? 0));
}

function compareVersions(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }

  return 0;
}

async function validateDistTree() {
  let fileCount = 0;
  let totalBytes = 0;

  async function walk(directory, prefix = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      const entryStat = await lstat(absolutePath);
      if (entryStat.isSymbolicLink()) {
        fail(`dist에는 심볼릭 링크를 포함할 수 없습니다: ${relativePath}`);
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        fail(`dist에 지원하지 않는 파일 시스템 항목이 있습니다: ${relativePath}`);
        continue;
      }
      fileCount += 1;
      totalBytes += entryStat.size;
      if (fileCount > MAX_DIST_FILES) {
        fail(`dist 파일 수가 안전 한도 ${MAX_DIST_FILES.toLocaleString("ko-KR")}개를 초과했습니다.`);
        return;
      }
      if (entryStat.size > MAX_DIST_FILE_BYTES) {
        fail(`dist 단일 파일 크기가 250MB를 초과했습니다: ${relativePath}`);
      }
      if (SENSITIVE_DISTRIBUTION_PATH.test(relativePath.replaceAll("\\", "/"))) {
        fail(`dist에 배포하면 안 되는 민감 파일명이 있습니다: ${relativePath}`);
      }
    }
  }

  try {
    await walk(distRoot);
  } catch (error) {
    fail(`dist 파일 트리를 검사하지 못했습니다: ${error.message}`);
  }
  if (totalBytes > MAX_DIST_TOTAL_BYTES) {
    fail("dist 전체 크기가 안전 한도 500MB를 초과했습니다.");
  }
}

function resolveDistPath(relativePath, label) {
  if (!isNonEmptyString(relativePath)) {
    fail(`${label} 경로가 비어 있습니다.`);
    return null;
  }

  const normalizedPath = relativePath.replaceAll("\\", "/");
  if (
    isAbsolute(relativePath) ||
    normalizedPath.startsWith("/") ||
    /^[a-z][a-z\d+.-]*:/i.test(normalizedPath)
  ) {
    fail(`${label}은(는) dist 내부의 상대 경로여야 합니다: ${relativePath}`);
    return null;
  }

  const resolvedPath = resolve(distRoot, relativePath);
  const relativeToDist = relative(distRoot, resolvedPath);
  if (
    relativeToDist === "" ||
    relativeToDist === ".." ||
    relativeToDist.startsWith(`..${sep}`) ||
    isAbsolute(relativeToDist)
  ) {
    fail(`${label}이(가) dist 디렉터리를 벗어납니다: ${relativePath}`);
    return null;
  }

  return resolvedPath;
}

async function requireFile(relativePath, label = relativePath) {
  const absolutePath = resolveDistPath(relativePath, label);
  if (!absolutePath) {
    return false;
  }

  try {
    await access(absolutePath);
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) {
      fail(`${label}이(가) 파일이 아닙니다: ${relativePath}`);
      return false;
    }
    if (fileStat.size === 0) {
      fail(`${label} 파일이 비어 있습니다: ${relativePath}`);
      return false;
    }
    return true;
  } catch {
    fail(`${label} 파일을 찾을 수 없습니다: ${relativePath}`);
    return false;
  }
}

async function loadJson(relativePath, label) {
  const exists = await requireFile(relativePath, label);
  if (!exists) {
    return null;
  }

  try {
    return JSON.parse(await readFile(join(distRoot, relativePath), "utf8"));
  } catch (error) {
    fail(`${label} JSON을 읽을 수 없습니다: ${error.message}`);
    return null;
  }
}

function validateManifest(manifest, packageJson) {
  const requiredKeys = [
    "manifestVersion",
    "id",
    "name",
    "version",
    "main",
    "host",
    "entrypoints",
    "icons"
  ];

  for (const key of requiredKeys) {
    if (!Object.hasOwn(manifest, key)) {
      fail(`manifest.json 필수 키가 없습니다: ${key}`);
    }
  }

  if (manifest.manifestVersion !== 5) {
    fail(`manifestVersion은 숫자 5여야 합니다. 현재 값: ${JSON.stringify(manifest.manifestVersion)}`);
  }

  for (const key of ["id", "name", "version", "main"]) {
    if (!isNonEmptyString(manifest[key])) {
      fail(`manifest.json의 ${key}은(는) 비어 있지 않은 문자열이어야 합니다.`);
    }
  }

  if (isNonEmptyString(manifest.id) && !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(manifest.id)) {
    fail("manifest.json의 id 형식이 올바르지 않습니다.");
  }

  if (manifest.main !== "index.html") {
    fail(`manifest.json의 main은 index.html이어야 합니다. 현재 값: ${JSON.stringify(manifest.main)}`);
  }

  if (packageJson && manifest.version !== packageJson.version) {
    fail(
      `manifest 버전(${manifest.version ?? "없음"})과 package.json 버전(${packageJson.version ?? "없음"})이 다릅니다.`
    );
  }

  if (!manifest.host || typeof manifest.host !== "object" || Array.isArray(manifest.host)) {
    fail("manifest.json의 host는 객체여야 합니다.");
  } else {
    if (manifest.host.app !== "premierepro") {
      fail(`host.app은 premierepro여야 합니다. 현재 값: ${JSON.stringify(manifest.host.app)}`);
    }

    const minimumHostVersion = [25, 6, 0];
    const hostVersion = parseVersion(manifest.host.minVersion);
    if (!hostVersion) {
      fail(
        `host.minVersion은 25.6.0 이상의 버전 문자열이어야 합니다. 현재 값: ${JSON.stringify(manifest.host.minVersion)}`
      );
    } else if (compareVersions(hostVersion, minimumHostVersion) < 0) {
      fail(`host.minVersion은 25.6.0 이상이어야 합니다. 현재 값: ${manifest.host.minVersion}`);
    }
  }

  if (!Array.isArray(manifest.entrypoints) || manifest.entrypoints.length === 0) {
    fail("manifest.json의 entrypoints는 하나 이상의 항목을 포함해야 합니다.");
  } else {
    for (const [index, entrypoint] of manifest.entrypoints.entries()) {
      if (!entrypoint || typeof entrypoint !== "object") {
        fail(`entrypoints[${index}]은 객체여야 합니다.`);
        continue;
      }
      if (!isNonEmptyString(entrypoint.id)) {
        fail(`entrypoints[${index}].id가 비어 있습니다.`);
      }
      if (entrypoint.type !== "panel") {
        fail(`entrypoints[${index}].type은 panel이어야 합니다.`);
      }
    }
  }

  if (!Array.isArray(manifest.icons) || manifest.icons.length === 0) {
    fail("manifest.json의 icons는 하나 이상의 아이콘을 포함해야 합니다.");
  }

  const permissions = manifest.requiredPermissions;
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) {
    fail("manifest.json의 requiredPermissions 객체가 없습니다.");
  } else {
    if (permissions.localFileSystem !== "request") {
      fail("requiredPermissions.localFileSystem은 request여야 합니다.");
    }
    const domains = permissions.network?.domains;
    if (!Array.isArray(domains) || domains.length === 0) {
      fail("AI 기능에 필요한 requiredPermissions.network.domains가 없습니다.");
    } else {
      if (JSON.stringify(domains) !== JSON.stringify(REQUIRED_NETWORK_DOMAINS)) {
        fail(`network domains는 OpenAI 공식 origin 하나만 허용합니다: ${JSON.stringify(REQUIRED_NETWORK_DOMAINS)}`);
      }
      for (const domain of domains) {
        try {
          const url = new URL(domain);
          if (
            url.protocol !== "https:" ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            url.pathname !== "/" ||
            domain.includes("*")
          ) {
            throw new Error("unsafe network domain");
          }
        } catch {
          fail(`network domain은 wildcard 없는 HTTPS origin이어야 합니다: ${JSON.stringify(domain)}`);
        }
      }
    }
  }
}

function collectIconPaths(manifest) {
  const iconPaths = new Set();
  const iconGroups = [manifest.icons];

  if (Array.isArray(manifest.entrypoints)) {
    for (const entrypoint of manifest.entrypoints) {
      iconGroups.push(entrypoint?.icons);
    }
  }

  for (const icons of iconGroups) {
    if (!Array.isArray(icons)) {
      continue;
    }
    for (const icon of icons) {
      if (isNonEmptyString(icon?.path)) {
        iconPaths.add(icon.path);
      } else {
        fail("manifest.json의 모든 아이콘 항목에는 비어 있지 않은 path가 필요합니다.");
      }
    }
  }

  return [...iconPaths];
}

async function validateHtml() {
  const htmlPath = join(distRoot, "index.html");
  let html;
  try {
    html = await readFile(htmlPath, "utf8");
  } catch {
    return;
  }

  const styleReference = /<link\b[^>]*\bhref\s*=\s*["'](?:\.\/)?styles\.css(?:[?#][^"']*)?["'][^>]*>/i;
  const scriptReference = /<script\b[^>]*\bsrc\s*=\s*["'](?:\.\/)?index\.js(?:[?#][^"']*)?["'][^>]*>/i;

  if (!styleReference.test(html)) {
    fail("index.html에서 styles.css를 참조하지 않습니다.");
  }
  if (!scriptReference.test(html)) {
    fail("index.html에서 index.js를 참조하지 않습니다.");
  }
}

async function validateSourceMaps() {
  const jsPath = join(distRoot, "index.js");
  let source;
  try {
    source = await readFile(jsPath, "utf8");
  } catch {
    return;
  }

  const directives = [...source.matchAll(/[#@]\s*sourceMappingURL=([^\s*]+)/g)].map((match) => match[1]);
  if (directives.length === 0) {
    notice("index.js에 sourceMappingURL이 없습니다(소스맵은 선택 사항입니다). ");
    return;
  }

  for (const value of directives) {
    const sourceMapUrl = value.trim().replace(/^['"]|['"]$/g, "");
    if (sourceMapUrl.startsWith("data:")) {
      notice("index.js에서 인라인 sourceMappingURL을 확인했습니다.");
      continue;
    }

    if (/^[a-z][a-z\d+.-]*:/i.test(sourceMapUrl) || sourceMapUrl.startsWith("//")) {
      fail(`sourceMappingURL은 외부 URL이 아닌 로컬 상대 경로여야 합니다: ${sourceMapUrl}`);
      continue;
    }

    let decodedPath;
    try {
      decodedPath = decodeURIComponent(sourceMapUrl.split(/[?#]/, 1)[0]);
    } catch {
      fail(`sourceMappingURL의 URL 인코딩이 올바르지 않습니다: ${sourceMapUrl}`);
      continue;
    }

    await requireFile(decodedPath, "index.js source map");
  }
}

async function main() {
  let distStat;
  try {
    distStat = await stat(distRoot);
  } catch {
    fail("dist 디렉터리가 없습니다. 먼저 npm run build를 실행해 주세요.");
  }

  if (distStat && !distStat.isDirectory()) {
    fail("dist 경로가 디렉터리가 아닙니다.");
  }

  if (!distStat?.isDirectory()) {
    printResult();
    return;
  }

  const [manifest, packageJson] = await Promise.all([
    loadJson("manifest.json", "manifest.json"),
    (async () => {
      try {
        return JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
      } catch (error) {
        fail(`package.json을 읽을 수 없습니다: ${error.message}`);
        return null;
      }
    })()
  ]);

  await Promise.all([
    requireFile("index.html"),
    requireFile("index.js"),
    requireFile("styles.css")
  ]);
  await validateDistTree();

  if (manifest) {
    validateManifest(manifest, packageJson);
    const iconPaths = collectIconPaths(manifest);
    if (iconPaths.length === 0) {
      fail("검증할 아이콘 경로가 manifest.json에 없습니다.");
    } else {
      await Promise.all(iconPaths.map((iconPath) => requireFile(iconPath, "plugin icon")));
    }
  }

  await Promise.all([validateHtml(), validateSourceMaps()]);
  printResult();
}

function printResult() {
  for (const message of notices) {
    console.info(`ℹ ${message}`);
  }

  if (failures.length > 0) {
    console.error(`\n배포 산출물 검증 실패 (${failures.length}건)`);
    for (const message of failures) {
      console.error(`- ${message}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("✓ dist 배포 산출물 검증을 통과했습니다.");
}

main().catch((error) => {
  console.error("배포 산출물 검증 중 예상하지 못한 오류가 발생했습니다.");
  console.error(error);
  process.exitCode = 1;
});
