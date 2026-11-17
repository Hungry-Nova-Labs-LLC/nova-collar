import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { buildMacControl } from "./build-mac-control.js";
const require = createRequire(import.meta.url);
const yaml = require("js-yaml");
const { finalizeMacRelease } = require("./finalize-mac-release.cjs");
const dir = await mkdtemp(join(tmpdir(), "nova-release-test-"));
try {
  const zip = randomBytes(40_000);
  const dmg = Buffer.concat([randomBytes(40_000), Buffer.from("notarization-ticket")]);
  await writeFile(join(dir, "app.zip"), zip);
  await writeFile(join(dir, "app.dmg"), dmg);
  await writeFile(join(dir, "latest-mac.yml"), yaml.dump({ version: "0.0.0", path: "app.dmg", sha512: "stale", files: [
    { url: "app.dmg", size: 40_000, sha512: "before-stapling" },
    { url: "app.zip", size: 0, sha512: "stale" },
  ] }));
  await finalizeMacRelease(dir);
  const manifest = yaml.load(await readFile(join(dir, "latest-mac.yml"), "utf8"));
  const hash = bytes => createHash("sha512").update(bytes).digest("base64");
  assert.equal(manifest.path, "app.zip");
  assert.equal(manifest.sha512, hash(zip));
  for (const [name, bytes] of [["app.zip", zip], ["app.dmg", dmg]]) {
    const entry = manifest.files.find(row => row.url === name);
    assert.equal(entry.sha512, hash(bytes));
    assert.equal(entry.size, bytes.length);
    const blockmap = JSON.parse(gunzipSync(await readFile(join(dir, name + ".blockmap"))));
    assert.equal(blockmap.files.flatMap(file => file.sizes).reduce((a, b) => a + b, 0), bytes.length);
  }
  for (const line of (await readFile(join(dir, "SHA256SUMS.txt"), "utf8")).trim().split("\n")) {
    const [expected, name] = line.split("  ");
    assert.equal(createHash("sha256").update(await readFile(join(dir, name))).digest("hex"), expected);
  }
  manifest.files[0].url = "../outside.dmg";
  await writeFile(join(dir, "latest-mac.yml"), yaml.dump(manifest));
  await assert.rejects(finalizeMacRelease(dir), /local ZIP or DMG/);
  console.log("release metadata follows final stapled bytes");
} finally { await rm(dir, { recursive: true, force: true }); }

if (process.platform === "darwin") {
  const nativeDir = await mkdtemp(join(tmpdir(), "nova-release-native-test-"));
  try {
    // Compile the real helper: checking arguments alone misses host-SDK defaults.
    assert.equal(buildMacControl({ outDir: nativeDir }), 0);
    const helper = join(nativeDir, "mac-control");
    const build = execFileSync("xcrun", ["vtool", "-show-build", helper], { encoding: "utf8", stdio: "pipe" });
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(build.match(/^\s*minos\s+(\S+)/m)?.[1], pkg.build.mac.minimumSystemVersion,
      "The compiled helper must support the installer's declared minimum macOS version.");
    const architecture = execFileSync("xcrun", ["lipo", "-archs", helper], { encoding: "utf8", stdio: "pipe" }).trim();
    assert.equal(architecture, process.arch === "arm64" ? "arm64" : "x86_64");
    console.log("native Mac helper matches declared minimum OS and architecture");
  } finally { await rm(nativeDir, { recursive: true, force: true }); }
}
