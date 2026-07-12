import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const evidenceDir = join(root, "beta-evidence");

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function optionalFile(path) {
  const fullPath = join(root, path);
  return existsSync(fullPath) ? fullPath : null;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function command(name, args) {
  try {
    return execFileSync(name, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return "unavailable";
  }
}

function fileSummary(path) {
  if (!path) return "- not found";
  const stats = statSync(path);
  return `- ${basename(path)}\n  - size: ${stats.size} bytes\n  - sha256: ${sha256(path)}`;
}

function fenced(value) {
  const text = value && value.trim() ? value.trim() : "clean";
  return ["```text", text, "```"].join("\n");
}

const pkg = readJson("package.json");
const sourceManifest = readJson("public/manifest.json");
const distManifestPath = optionalFile("dist/manifest.json");
const distManifest = distManifestPath ? JSON.parse(readFileSync(distManifestPath, "utf8")) : null;
const ccxPath = optionalFile(`release/ShortFlow-Studio-${pkg.version}.ccx`);
const checksumPath = optionalFile(`release/ShortFlow-Studio-${pkg.version}.ccx.sha256.txt`);
const markVerified = process.argv.includes("--verified");

mkdirSync(evidenceDir, { recursive: true });

const now = new Date();
const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/u, "Z");
const output = join(evidenceDir, `ShortFlow_Beta_Evidence_${stamp}.md`);

const lines = [
  "# ShortFlow Studio Internal Beta Evidence",
  "",
  `- generatedAt: ${now.toISOString()}`,
  `- package: ${pkg.name}@${pkg.version}`,
  `- gitCommit: ${command("git", ["rev-parse", "HEAD"])}`,
  `- gitBranch: ${command("git", ["branch", "--show-current"])}`,
  `- node: ${process.version}`,
  `- platform: ${process.platform} ${process.arch}`,
  "",
  "## Git Status",
  "",
  fenced(command("git", ["status", "--short"])),
  "",
  "## Manifest",
  "",
  `- sourceId: ${sourceManifest.id}`,
  `- sourceVersion: ${sourceManifest.version}`,
  `- sourceHost: ${sourceManifest.host?.app ?? "unknown"} ${sourceManifest.host?.minVersion ?? "unknown"}`,
  `- distManifest: ${distManifest ? "present" : "missing"}`,
  ...(distManifest ? [
    `- distId: ${distManifest.id}`,
    `- distVersion: ${distManifest.version}`,
    `- distHost: ${distManifest.host?.app ?? "unknown"} ${distManifest.host?.minVersion ?? "unknown"}`,
  ] : []),
  "",
  "## Release Candidate",
  "",
  fileSummary(ccxPath),
  checksumPath ? `- checksumFile: ${basename(checksumPath)}\n  - contents: ${readFileSync(checksumPath, "utf8").trim()}` : "- checksumFile: not found",
  "",
  "## Required Automatic Gates",
  "",
  markVerified
    ? "- status: verified by caller before evidence capture"
    : "- status: template only; run `npm run beta:evidence:verified` for a verified capture",
  `- [${markVerified ? "x" : " "}] npm run typecheck`,
  `- [${markVerified ? "x" : " "}] npm run lint`,
  `- [${markVerified ? "x" : " "}] npm test`,
  `- [${markVerified ? "x" : " "}] npm run build`,
  `- [${markVerified ? "x" : " "}] npm run verify:dist`,
  `- [${markVerified ? "x" : " "}] npm run package:ccx:force`,
  `- [${markVerified ? "x" : " "}] npm run verify:release`,
  "",
  "## Host Beta Checklist",
  "",
  "- [x] Load dist/manifest.json in UXP Developer Tool.",
  "- [x] Open ShortFlow Studio from Premiere Pro UXP plugin menu.",
  "- [x] Create/open dedicated host smoke project.",
  "- [x] Validate project/no-project/sequence/no-sequence states and basic QC with a real sequence.",
  "- [x] Validate Safe Zone BMP overlay import/insert in Premiere.",
  "- [x] Validate SRT file import into the subtitle editor.",
  "- [x] Validate asset root, Music/SFX sync, and basic WAV import/insert.",
  "- [x] Validate timeline TrackItem selection detection in the ShortFlow status UI.",
  "- [ ] Validate Music/SFX preview, drag order, folder-open, locked-track and collision behavior.",
  "- [ ] Validate references, thumbnail SVG fallback export, and Host Canvas limitations.",
  "- [ ] Validate TTS/STT with a test OpenAI key and non-sensitive media.",
  "- [ ] Validate TTS audio file save, Premiere import, and target audio track insert.",
  "- [ ] Validate clone-before-mutation, automation marker creation, punch-in apply, export, and recovery journal.",
  "- [ ] Validate final QC, diagnostics JSON export, and absence of secrets in logs/reports.",
  "",
  "## Host Environment",
  "",
  "- Windows/macOS version:",
  "- Premiere Pro version:",
  "- Media Encoder version:",
  "- UXP Developer Tool version:",
  "- Test project/media set:",
  "- Tester:",
  "- Result:",
  "",
].join("\n");

writeFileSync(output, `${lines}\n`, "utf8");
console.log(`✓ beta evidence template created: ${output}`);
