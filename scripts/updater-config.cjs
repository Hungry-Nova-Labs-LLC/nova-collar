// Keep directory builds updateable as well as DMG/ZIP builds. Only public,
// allowlisted values belong in this signed application resource.
const { existsSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const pkg = require("../package.json");

function writeUpdaterConfiguration(context) {
  if (context.electronPlatformName !== "darwin") return null;
  const { appInfo, config } = context.packager;
  const canonical = pkg.build.publish;
  const configured = config.publish;
  if (canonical.provider !== "github" || configured?.provider !== "github"
    || configured.owner !== canonical.owner || configured.repo !== canonical.repo) {
    throw new Error("The public updater must use the canonical company GitHub repository.");
  }
  const cacheName = appInfo.updaterCacheDirName;
  if (cacheName !== `${pkg.name.toLowerCase()}-updater`) {
    throw new Error("The public updater cache directory must use the application name.");
  }
  if (appInfo.productFilename !== pkg.build.productName) {
    throw new Error("Unexpected application name while writing updater metadata.");
  }
  const file = join(context.appOutDir, `${appInfo.productFilename}.app`, "Contents", "Resources", "app-update.yml");
  if (!existsSync(join(file, ".."))) throw new Error("Application Resources directory does not exist.");
  const metadata = {
    provider: "github", owner: canonical.owner, repo: canonical.repo,
    updaterCacheDirName: cacheName,
  };
  // JSON scalar quoting is YAML-compatible and prevents unescaped values from
  // introducing additional settings. No publish token, headers or host is copied.
  writeFileSync(file, Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n") + "\n");
  return file;
}

exports.writeUpdaterConfiguration = writeUpdaterConfiguration;
