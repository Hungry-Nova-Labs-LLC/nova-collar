# Changelog

## 0.6.2 — Guided local chat models

- Offer a local chat download option during first launch, in Settings and in the model picker, with clear size and memory guidance for Qwen3.5 2B, 4B and 9B.
- Download pinned Apache 2.0 GGUF files from their publisher, resume cancelled downloads, verify exact sizes and hashes, and check local chat and tool compatibility before use. No separate server setup or model API key is required.
- Import compatible single-file text GGUF models into private storage without changing the original. Detect offloaded files, split models, embedding models and vision projectors before attempting to run them.
- Start a private local chat runtime on demand, keep downloaded models across updates, unload idle inference, and provide explicit switch, unload, remove and previous-connection controls. Preserve existing provider settings and require current work to finish before changing its model.
- Adapt named tool requests faithfully for the bundled runtime while retaining the existing streaming, permissions and verification requirements. Local model inference does not start Training Lab or training jobs.
- Retain Qwen, Unsloth and runtime attribution. Bundled local chat is first provided for Apple Silicon Macs; other platforms can continue using connected model servers.

## 0.6.1 — Guided local decision adviser

- Offer an optional free d1-Omni-2B adviser during setup and in Settings, with two clear initial choices and no model account, Python setup or terminal commands.
- Download the pinned Q8 model from the Hungry Nova Labs GitHub release with readable progress, cancellation, resumable partial downloads and exact byte/hash verification. Keep the model across app updates.
- Bundle the compatible local runtime on Apple Silicon; verify a real local sample decision before enabling the adviser. Stop owned model processes on cancellation and app exit, and unload idle inference. Other installer platforms are not newly validated by this release.
- Preserve the selected chat provider and existing profiles. Adviser suggestions remain untrusted and cannot grant permissions, execute actions, clear verification debt or declare completion.
- Retain Liquid AI’s model license and attribution. The model remains subject to the LFM Open License, including its commercial-use threshold.
- No training service or Training Lab is enabled by installing the adviser.

## 0.6.0 — Main application update

- Add recovery points, session-history retrieval, context inspection, and verification records. Restoring recorded files opens a new chat and keeps the original history available; it does not reverse external actions.
- Include project knowledge, source-analysis workers for JavaScript and TypeScript, provider progress, request budgeting, and interrupted-turn recovery.
- Discover the configured provider's current models, keep the selected model across refreshes, and exclude embedding-only gateway models from chat choices. Retire the fixed 4B/27B routing shortcut; fast and thinking roles remain explicit choices.
- Discover local Ollama, LM Studio, llama.cpp and OpenAI-compatible services on first launch. Preserve saved connections; connect one unambiguous chat model or offer all available chat models. Support endpoint-scoped local API keys, explicit key clearing, custom loopback ports and retries without automatic model downloads.
- Isolate malformed or stalled service responses, redact echoed credentials before error parsing, and save settings atomically so failed writes preserve the previous profile. Handle terminal events during shutdown without using a closed native terminal.
- Retain the main application's existing profile and conversations when replacing a preview installation.
- Use Hungry Nova Labs LLC release metadata and company repository URLs. Remove personal acknowledgments from the distributed interface and reject cloud-sync conflict copies in release inputs.
- Require an explicitly pinned signing identity for public Mac releases, including nested native dependencies and installer signing. Company signing is the default; associated-owner signing requires explicit local approval. Keep signing credentials and user profiles outside source and artifacts.
- Compile the native Mac helper for the declared minimum macOS version and check its deployment target with the real Swift compiler, so a build machine's newer OS does not silently raise the requirement.

Validation and platform coverage are recorded with each release. A source tree's platform support does not establish that an installer for that platform was built or tested.

## 0.4.0 — Wireshark MCP suite

- Add a local stdio MCP server and Wireshark pack for installed TShark/dumpcap and optional Nmap. No listening service or bundled network tools.
- Capture one exact local interface with time, packet, file and snapshot limits; cancel through Stop, turn cancellation or app shutdown. Keep saved captures and reports in the private app directory.
- Discover responding devices on a directly connected private IPv4 scope of at most 256 addresses using host discovery only.
- Analyze metadata for TCP symptoms, DNS errors, ARP mapping changes and expert warnings, with explicit coverage and uncertainty. Raw payloads and DNS names are excluded from model context; IP/MAC metadata can reach the selected model.
- Add capture import, packet pages, Wireshark opening, Settings controls and separate expandable tool cards showing arguments and results. Effects use exact-action approval.
- Test real MCP transport, synthetic TShark evidence, opt-in loopback capture/cancellation and Electron controls. Linux CI runs the offline TShark test.

This is a source release. The 0.3.1 notarized Mac installer remains available and does not contain this feature. No new platform installers or updater manifests are published here. Live device discovery and capture permissions must be checked on each deployment host.

## 0.3.1 — Notarized Apple Silicon distribution

- Publish a signed, notarized Mac installer and ZIP containing the current REA/Ghidra analysis bundle. Retain upstream source, licenses, and notices.
- Set the installer minimum to macOS 13.5, matching the bundled Node runtime.
- Submit the app once through the explicit notarization hook.
- Sign native macOS libraries inside dependency JARs, extension ZIPs, and Python wheels before signing the app. Preserve archive notices and update wheel integrity records.
- Strip native debug records before signing and reject native binaries that still contain the build user’s home path.
- Require notarization credentials and a Developer ID identity for public Mac builds. Development packaging remains available separately.
- Rebuild update blockmaps, sizes, and checksums after the DMG is stapled, so the updater verifies the final downloaded bytes. Add a regression test for this order.

This release provides Apple Silicon Mac binaries and source. Windows and Linux application CI remains covered; their analysis engine packages are not newly validated or published.

## 0.3.0 — Bundled REA and Ghidra analysis

- Add REA 6.4.0 and Ghidra 12.1.4 with pinned Node and Temurin runtimes. The app starts its own stdio MCP helper and headless Ghidra as needed; users do not manage a separate server.
- Add software-analysis tools for native programs, JavaScript, Electron/ASAR, comparisons, and saved evidence. Tool schemas are discovered from REA. Explicit execution and write operations use Collar's approval flow.
- Preserve the Ghidra projects pack for an existing desktop project with its compatible local bridge. Each headless investigation has a separate target and workspace, cancellation, retained reports, and automatic helper cleanup.
- Add Settings file selection and license access. Keep upstream licenses, copyright notices, dependency pins, native source, and complete Temurin source in generated bundles. The Mac decompiler and both GNU demanglers are built from unmodified upstream source.
- Preserve the 0.2.7 model discovery, conversation history, approvals, and terminal fixes.

Validation: 18 application suites, 8 Ghidra function-review tests, and Electron window/native-terminal checks passed locally. Twelve checks against the actual Apple Silicon app cover real REA/Ghidra analysis, GNU demanglers, cancellation, unchanged targets, and helper cleanup. See the release verification asset for exact provenance and CI results. Engine validation covers Apple Silicon only; archive specifications for other platforms are not evidence of tested packages.

This is a source release. No 0.3.0 installers or updater manifests are published. A public Mac installer still requires fresh signing, privacy inspection, and Apple notarization. Optional Android, firmware, browser, and commercial REA providers are not all included. A selected remote chat model receives analysis findings as normal tool context.

## 0.2.7 — Omarchy terminal output

- Preserve command output between shell control sequences on Omarchy and other terminals that use ST-terminated OSC records. The model's terminal reader now strips control codes without discarding the command's result.
- Cover BEL and ST terminators, terminal colors, and split PTY chunks. Use a cross-platform tool fixture in the engine tests.
- Add Linux regression and Electron smoke checks alongside Mac and Windows CI.

Validation: 16 automated suites and the Electron window, model picker, native terminal, approvals, and layout smoke test passed on Omarchy.

This is a source release.

## 0.2.6 — Model discovery and conversation reliability

- Preserve reasoning, tool-call IDs, arguments, and results across tool steps, later turns, and saved sessions. Keep complete tool/result groups when trimming history and retain image/audio attachments.
- Preserve reasoning during repair and verification steps. Give MiMo a concise function-tool contract while retaining authored personality and rules.
- Recognize verified document edits from matching write/read evidence, avoiding unnecessary retry loops while keeping checks for failed, stale, or unrelated reads.
- Include automatic provider model discovery, account-scoped catalog caching, advertised output limits, and chat-only model support introduced during 0.2.3 development.
- Replace personal identifiers in examples and remove personal profile links from release documentation.

Validation: 15 automated suites and Electron window checks cover model selection, tool history, saved sessions, terminal behavior, approvals, and document verification. Live MiMo tests exercised file creation, read-back, and a follow-up edit. These application fixes do not replace model-server configuration fixes; old conversations cannot recover reasoning that was never saved.

This is a source release. Existing platform installers remain available from earlier releases.

## 0.2.3 — Automatic model discovery

- Discover hosted models on launch, provider connection, and opening the picker. Keep the last successful catalog across restarts and show refresh errors without losing saved model selections.
- Scope catalogs to provider and account, display model descriptions, and accept newly published model IDs without an app update.
- Respect advertised output limits and omit tool parameters for chat-only models. Selecting one model clears older fast/thinking routing.
- Added streaming, file-read, catalog/routing regression coverage, and Electron picker checks. Short model probes do not establish sustained agent reliability.

## 0.2.2 — Windows support and shared reliability fixes

### Windows

- Add an x64 installer and zip, a native PowerShell terminal, and Windows implementations of host, network, and Docker commands.
- Use node-pty Node-API prebuilds so Windows packaging does not require Visual Studio.
- Quote paths containing spaces, apostrophes, and dollar signs correctly. Stop the full command process tree on timeout.
- Isolate command temporary files so cleanup cannot remove another program’s installer files. Avoid probing mapped network drives for local disk reports.
- Correct the optional Laya virtual-environment Python path on Windows.
- Hide Mac-only screen controls and report unsupported tools clearly.

### Model connections

- Select any installed Ollama or LM Studio model by its exact tag, including custom/red-team models.
- Selecting a local model clears prior fast/thinking roles while retaining hosted credentials for an explicit switch. No automatic cloud fallback from local mode.
- Refresh hosted model lists and show the actual model, endpoint, computer, and active roles. Remove stale hosted model suggestions.
- Offer the Hungry Nova 4B tool-worker + 27B planner/checker pairing. Bound smaller-model output and tool calls, and use the fast role for sub-agent tool work.

### Runtime

- Update Electron from 36.9.5 to the supported 43.7.7 series and refresh its cache dependency to resolve the dependency audit findings.

### Approval and verification on Mac and Windows

- Ask for one-time approval before risky commands, broad overwrites, emptying files, writes outside the working folder, and system-changing actions. Show the proposed action and file content before execution.
- Apply approval checks to chat tools, sub-agents, background tasks, and harness execution. Denial, cancellation, expiration, or a missing handler leaves the action unexecuted.
- Reject stale file approvals if the file changed while awaiting permission.
- Accept intentionally empty file content instead of treating it as a missing argument. Require matching write/read evidence for claims that a file was emptied.
- Hash complete tool arguments for repeat detection, repair incomplete arguments, and avoid premature success text before a tool runs.
- Fix streaming text replay, search-result evidence and error display, contradictory PASS labels, and harness backup/restore handling.

### Validation and scope

Windows 11 x64: installed and exercised with local Ollama, normal Qwen 27B and custom red-team tags, and the hosted 4B/27B option. Tested PowerShell, host facts, disk/ports/logs, quoted paths, errors/timeouts, temporary-file isolation, and allow/deny file-replacement dialogs. Docker CLI invocation was checked; container execution still requires a running engine and was not validated with the engine stopped.

Apple Silicon Mac: the same model, approval, streaming, and evidence changes are included. Native Mac screen control remains Mac-only. Windows 10 and Intel Mac builds are not part of the tested release matrix.

The next priorities are clear model identity, bounded small-model tool work, deterministic verification, and repeatable checks on both platforms before expanding autonomy.
