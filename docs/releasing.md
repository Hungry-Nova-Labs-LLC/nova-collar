# Building a release

Use Node.js 22.12+ and a reviewed clean checkout on company-controlled hardware. Run `npm ci`, `npm test`, `node --test scripts/ghidra-review.test.mjs`, and `npm run test:app` before packaging. Update both package versions and the changelog. Build each platform from the same commit; never include a developer's `.novapup` folder or credentials. Stage releases outside cloud-synced directories and exclude duplicate conflict copies before committing or packaging.

## Company publication

Publish to `Hungry-Nova-Labs-LLC/nova-collar` using the company-owned Nova Collar GitHub App. Limit each installation token to this repository and the permissions needed for the operation. Use the App's verified bot identity for author and committer metadata; do not fall back to a personal publishing identity. Keep private keys outside the checkout, use restrictive local permissions, and do not put tokens in remotes, command arguments, logs, or release assets.

Company release checks run locally. Before updating the public branch, ensure that a push cannot start GitHub-hosted jobs. The existing workflow definition is not evidence that checks ran for a particular release. A release receipt must identify the actual local checks and platform scope.

Review the exact outgoing tree, its commit metadata, the extracted source archive, every application resource, and final installer/archive metadata. Review hidden and ignored inputs as well; a Git ignore rule is not a privacy boundary. Preserve required third-party license notices. Do not include family stories, private endpoints, credentials, developer paths, operational reports, chat histories, screenshots of private work, or signing-key material.

Scrubbing a new tree or release does not remove personal information already present in older public commits, releases, cached URLs, or outside copies. Resolve the intended treatment of that history before claiming that the repository has no personal provenance.

## Source releases

Keep the upstream copyright and license text,
`NOTICE`, analysis dependency locks, and build recipe in the public checkout.
Generate an attached source ZIP from the tagged commit with `git archive`, not
from the developer's working directory. This excludes ignored downloads, local
settings, investigation results, logs, and signing material. Scan both outgoing
commits and the extracted final ZIP for secrets and private identifiers.

Attach SHA-256 checksums and a reviewed verification summary identifying the
source commit, test scope, and tested engine platforms. Verify the uploaded
asset digests against local hashes. Hashes establish byte integrity, not an
independent security audit or reproducible compilation. Do not publish updater
manifests without their matching verified installers.

## Analysis bundle

Packaging invokes `scripts/prepare-analysis.mjs`, verifies the pinned downloads,
and retains licenses and source. See [software-analysis provenance](software-analysis.md#licenses-and-provenance).
Run `npm run test:analysis:live` against each intended platform's complete bundle
before claiming support. Check the packaged app as well as the development tree.
The 0.3.0 engine was verified on Apple Silicon; Windows, Linux, and Intel Mac
archive entries are build specifications, not validated release artifacts.

## Windows x64

Run `npm run release:win` on Windows. node-pty uses its bundled Node-API binaries. Smoke-test the installer, PowerShell terminal, model selection, and an approval allow/deny flow on disposable files. Publish the exe, zip, blockmap, and `latest.yml`. A Windows build without a Windows signing certificate may show an unknown-publisher prompt.

## Apple Silicon Mac

The complete Apple Silicon app requires macOS 13.5 or newer because of the bundled Node runtime. Install Xcode command-line tools, Python 3, and a Developer ID Application certificate with its private key. The default company signing policy requires the Hungry Nova Labs LLC organization identity.

Select the company identity explicitly using `HNL_APPLE_SIGNING_SHA1` and `HNL_APPLE_TEAM_ID`. The public release guard verifies the selected identity and team; selecting the first available Developer ID certificate is not sufficient. The same identity must sign the application, nested native code and archives, and DMG.

If the account owner explicitly approves using an associated owner's identity, set `HNL_APPLE_SIGNING_POLICY=associated-owner` and `HNL_APPLE_SIGNING_ENTITY` to that certificate's exact legal entity in private local configuration. Fingerprint and team pinning remain mandatory. This exception deliberately leaves the approved legal signer identity visible in the signature. Keep the actual entity, fingerprint, team, and credential configuration outside the checkout and public assets; do not silently fall back from the company policy.

Configure notarization through `APPLE_KEYCHAIN_PROFILE`, or `APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`, using the supported authentication modes in `scripts/notary.cjs`. Store Apple ID app-specific credentials through the interactive Keychain workflow; do not pass a password in process arguments. Keep credentials outside the repository and validate the company team's access before submission. API issuer is required for a team key; `APPLE_API_KEY_INDIVIDUAL=1` refers to an App Store Connect API-key authentication mode and does not make a personal Developer ID certificate suitable for company publication.

Run `npm run release` with the company identity selection and validated notarization credentials configured locally. The release command requires both; development packaging remains available separately. Built-in electron-builder notarization is disabled because explicit app and DMG hooks handle submission and stapling. The build strips native debug records, recursively signs native libraries inside dependency JARs, extension ZIPs, and Python wheels, notarizes/staples the app and DMG, then regenerates update blockmaps and checksums from the final bytes. The archive signing pass preserves member paths, permissions, licenses, and source; it refreshes wheel RECORD hashes and records changes in `analysis/MAC-PACKAGING-CHANGES.json`. It refuses to alter JARs with Java signatures rather than invalidating those signatures.

Inspect nested resources for stale developer signatures and metadata from reused build inputs, not just the outer application signature. Preserve quarantine and other security attributes. Before uploading Mac artifacts, verify the app with `codesign --verify --deep --strict`, `spctl --assess --type execute`, and `xcrun stapler validate`; validate the DMG ticket too. Reject a release containing an unapproved signing identity, even if notarization accepted it. An explicitly approved associated-owner identity may appear in its certificate and derived signature metadata; that exception does not permit personal stories, paths, credentials, or other unrelated personal data elsewhere in the artifact.

Publish the dmg, zip, blockmaps, and `latest-mac.yml` only after verification. Hashes in updater metadata must match the final uploaded artifacts, including the stapled DMG. Existing app settings stay in the user’s `.novapup` folder during an app update.

## Build paths and archive metadata

Native dependencies can embed the compiler's working directory even when the source tree is clean. Use a neutral build directory and inspect the packaged native binaries, including node-pty's `.node` files and `spawn-helper`, for developer home paths. On macOS, `xcrun strip -S` removes the debug path records found in the old node-pty binaries. Perform that step before signing, then test the packaged terminal. Modifying an already signed app requires fresh signing and notarization.

Optional model archives must use numeric owner/group 0, empty owner/group names, neutral timestamps, and relative paths. Keep only the model, tokenizer, and configuration files needed at runtime. Compare every file's SHA-256 before and after repacking, and inspect the final tar headers as well as its contents before upload. The neutral owner metadata does not change model weights.

The October 2026 cleanup replaced the Laya archive without changing any of its five content files, withdrew the old Mac downloads, and replaced a developer path in historical test fixtures. Existing branch and tag names remain, but commit IDs changed. Existing contributors should preserve any local work and start from a fresh clone before publishing more changes; merging an old clone can restore the removed history. GitHub's retained PR refs, cached URLs, and outside copies may still contain the older metadata.
