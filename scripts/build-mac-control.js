import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(import.meta.dirname, "..");

export function buildMacControl({ platform = process.platform, arch = process.arch, outDir = join(root, "bin") } = {}) {
  if (platform !== "darwin") return 0;
  const targetArch = { arm64: "arm64", x64: "x86_64" }[arch];
  if (!targetArch) throw new Error("Unsupported Mac helper architecture.");
  const minimum = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).build?.mac?.minimumSystemVersion;
  if (typeof minimum !== "string" || !/^\d+\.\d+(?:\.\d+)?$/.test(minimum)) {
    throw new Error("Declare the Mac minimum system version before building its native helper.");
  }
  mkdirSync(outDir, { recursive: true });
  // The host SDK's default deployment version can exceed the installer's floor.
  // An explicit target also makes Swift check API availability for supported Macs.
  const result = spawnSync(
    "xcrun",
    ["swiftc", "-O", "-target", `${targetArch}-apple-macos${minimum}`, "-o", join(outDir, "mac-control"), join(root, "src/native/mac-control.swift")],
    { stdio: "inherit" },
  );
  return result.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = buildMacControl();
}
