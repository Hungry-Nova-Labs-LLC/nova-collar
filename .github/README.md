# Company release checks

Hungry Nova Labs LLC builds, tests, and signs company releases on its own hardware. Publication does not require GitHub-hosted compute or uploading private profiles and signing keys to a workflow runner.

Before publishing a branch update, verify the repository's Actions settings prevent GitHub-hosted execution. The retained workflow definition describes earlier automation and does not establish current release validation.

Run the local checks and release verification described in [the release guide](../docs/releasing.md). Publish a reviewed verification receipt with the tested platform, commit, final artifact checksums, and notarization result.
