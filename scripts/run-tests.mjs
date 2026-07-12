import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";

async function collectTestFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectTestFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".test.js")) {
      files.push(fullPath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

const testFiles = await collectTestFiles(join(process.cwd(), ".test-build", "tests"));

if (testFiles.length === 0) {
  console.error("No compiled test files found in .test-build/tests.");
  process.exitCode = 1;
} else {
  const child = spawn(process.execPath, ["--test", ...testFiles], { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (signal) {
      console.error(`Test runner terminated by signal ${signal}.`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = code ?? 1;
  });
}
