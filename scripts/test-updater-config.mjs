import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { writeUpdaterConfiguration } = require("./updater-config.cjs");
const { AppUpdater } = require("electron-updater/out/AppUpdater.js");
const { createClient } = require("electron-updater/out/providerFactory.js");
const pkg = require("../package.json");

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "collar-updater-"));
  const resources = join(dir, "Nova Collar.app", "Contents", "Resources");
  mkdirSync(resources, { recursive: true });
  const context = { electronPlatformName: "darwin", appOutDir: dir, packager: {
    appInfo: { productFilename: "Nova Collar", updaterCacheDirName: "nova-collar-updater" },
    config: { publish: { ...pkg.build.publish, token: "DO_NOT_SHIP", private: true,
      host: "private.internal", requestHeaders: { authorization: "DO_NOT_SHIP" } } },
  } };
  return { dir, resources, context };
}

test("directory-build metadata loads through the actual updater and selects the public company provider", async () => {
  const { dir, resources, context } = fixture();
  try {
    const file = writeUpdaterConfiguration(context);
    assert.equal(file, join(resources, "app-update.yml"));
    const adapter = { version: pkg.version, isPackaged: true, appUpdateConfigPath: file };
    const updater = new AppUpdater(undefined, adapter);
    updater.logger = null;
    assert.equal(updater.isUpdaterActive(), true);
    const parsed = await updater.loadUpdateConfig();
    assert.deepEqual(parsed, { provider: "github", owner: "Hungry-Nova-Labs-LLC", repo: "nova-collar",
      updaterCacheDirName: "nova-collar-updater" });
    const provider = createClient(parsed, updater, { platform: "darwin", executor: null });
    assert.equal(provider.constructor.name, "GitHubProvider");
    assert.equal(provider.baseUrl.href, "https://github.com/");
    assert.equal(provider.options.owner, "Hungry-Nova-Labs-LLC");
    assert.equal(provider.options.repo, "nova-collar");
    assert(!/DO_NOT_SHIP|private\.internal|authorization|token|private:|host:/.test(readFileSync(file, "utf8")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("metadata refuses a different repository or a path-like cache directory before writing", () => {
  const { dir, resources, context } = fixture();
  try {
    context.packager.config.publish.owner = "personal-owner";
    assert.throws(() => writeUpdaterConfiguration(context), /canonical company/);
    context.packager.config.publish.owner = pkg.build.publish.owner;
    context.packager.appInfo.updaterCacheDirName = "../private-profile";
    assert.throws(() => writeUpdaterConfiguration(context), /cache directory/);
    assert.equal(existsSync(join(resources, "app-update.yml")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the macOS hook does not write macOS resources for other platforms", () => {
  assert.equal(writeUpdaterConfiguration({ electronPlatformName: "linux" }), null);
});
