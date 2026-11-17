# Nova Collar

Nova Collar is the desktop agent harness from Hungry Nova Labs LLC. One Electron window holds the conversation, a live terminal, and configured tools. It connects to a model server selected by the user.

## Install

**Current version: 0.6.1.** The [workspace notes](docs/WORKSPACE-UPGRADE.md) cover the new desktop layout, public-source boundaries, and local verification.

The [Nova Tag integration notes](docs/TAG-INTEGRATION.md) describe bounded capacity waiting, observed progress, exact local history recall and explicit model settings. The [completion notes](docs/AUTONOMOUS-COMPLETION.md) describe verification, loop control and latency fixes in this iteration.

**Public baseline.** Brings the [Hungry Nova Labs methodology](docs/HNL-METHODOLOGY.md) into the public harness: ordered saved guidance, deliberate questions, durable file/project verification, scoped repair lessons, bounded helpers, checkpoints and context budgeting. See the [implementation and limits](docs/PORTING-STATUS.md). Includes the [Wireshark MCP suite](docs/wireshark.md) for bounded traffic capture, local device discovery, anomaly evidence and opening captures in Wireshark, with visible tool calls and action approvals. Wireshark/TShark and optional Nmap are separately installed.

**The Mac app.** Download `Nova-Collar-0.6.1-arm64.zip` from [v0.6.1](https://github.com/Hungry-Nova-Labs-LLC/nova-collar/releases/tag/v0.6.1), open the archive, drag Nova Collar to Applications, and open it. The ZIP contains the signed app with its stapled notarization ticket and neutral archive metadata. It is for Apple Silicon Macs with a declared macOS 13.5 minimum and includes the analysis engines. Runtime tests ran on the current Mac; the macOS 13.5 deployment targets were checked by compilation and native metadata inspection. See the release's verification receipt for the tested package and limits. The obsolete v0.2.0 downloads remain withdrawn. Earlier Windows x64 builds remain available; see below.

To build it yourself from the checkout:

```bash
npm ci
npm run pack
```

The app lands at `dist/mac-arm64/Nova Collar.app`. Packaging downloads and verifies the pinned analysis engines and builds the Mac native helpers, so the first build needs network access and Xcode Command Line Tools. The complete app is about 1.9 GB. Drag it to `/Applications` and open it. This development build is not a notarized public installer.

**From source, with the CLI.** macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/Hungry-Nova-Labs-LLC/nova-collar/main/scripts/get-collar.sh | sh
```

Clone it and run `scripts/get-collar.sh` from the checkout, or run the one line above. Either way it lands in `~/NovaCollar`, installs the dependencies, and puts `nova-collar` and `np` on your PATH. First launch uses the connection discovery described below.

**Windows x64.** The previous packaged installer, `Nova-Collar-0.2.2-x64.exe`, is available from [v0.2.2](https://github.com/Hungry-Nova-Labs-LLC/nova-collar/releases/tag/v0.2.2). Run it and open Nova Collar from the Start menu. That installer was tested on Windows 11. Electron requires Windows 10 1809 or newer; Windows 10 has not been tested.

To build the Windows installer from source, use Node.js 22.12 or newer:

```powershell
npm ci
npm run release:win
```

The output is `dist/Nova-Collar-0.6.0-x64.exe`. The installer adds Nova Collar to the Start menu and desktop. The window terminal and host commands use Windows PowerShell. The Windows build uses node-pty’s bundled Node-API binaries, so Visual Studio is not required for that dependency. The 0.3.0 analysis bundle has been engine-tested only on Apple Silicon; Windows headless analysis is experimental upstream and the Windows package has not been validated for this release.

For local inference, install and start [Ollama for Windows](https://ollama.com/download/windows), then choose **On this computer (Ollama / LM Studio)**, scan, and select an installed model. Selecting a local model clears any previously configured fast/thinking roles so the whole turn stays local. The Hungry Nova endpoint and key remain saved for explicit model switching; there is no automatic cloud fallback. Local setup uses `http://127.0.0.1:11434/v1`. The model picker lists the models found on local servers at startup; use the local setup scan to refresh it. Select the exact installed tag shown by the local server. Model names are discovered, not downloaded automatically.

```bash
nova-collar install     # show this computer's memory, ask where answers come from
nova-collar update      # pull the program
nova-collar update laya # fetch the optional decider and set up its Python
```

`install` shows the memory on this computer and asks where answers should come from: a model you already have, an address you paste, or a smaller local model when the memory fits. The same questions are MCP tools, `install_scan` and `install_apply`, from `node scripts/install-mcp.mjs`.

## Main application and profiles

The main application uses `~/.novapup` for its configuration, chats and evidence,
the `novapup` Electron profile, and application identity
`com.hungrynova.novapup`. This retains the official main application's profile
location when upgrading. Source-run tests can use an explicit temporary
`NOVAPUP_HOME`; packaged applications retain the main profile. Never commit
connection settings or bundle a private profile in a release.

## First launch

Nova Collar checks running servers on this computer: Ollama, LM Studio,
llama.cpp and OpenAI-compatible services on the usual local ports. An explicit
loopback `OLLAMA_URL` or `OLLAMA_HOST` can provide a different port. Existing
saved model and provider settings take precedence.

With no saved connection, one available chat model is selected automatically.
If several are available but exactly one is already loaded, that model is used.
Otherwise the window lists the detected chat models for a choice. Embedding
models are excluded from chat selection. Discovery reads bounded model metadata;
it does not run inference, scan other machines, start applications or download
models automatically.

If a local server requires authentication, enter its API key in **Connect
manually**. That key stays in the private local profile and is used only for its
selected endpoint; a hosted provider's key is never borrowed for local access.
If nothing is found, start the model server and choose **Scan again**, enter a
local address and model ID, or choose another provider. Installing Ollama or
downloading a model requires an explicit action. Nova Collar does not read
Ollama's or LM Studio's private configuration files.

## Optional local adviser

After connecting your chat model, choose **Install free local adviser** to add
d1-Omni-2B, or **Maybe later** to continue. You can return through
**Settings → local decision adviser**. Nova downloads about 1.85 GB from the
Hungry Nova Labs GitHub release, verifies the complete file and checks a small
sample decision on your computer before turning the adviser on. There is no
separate model account, API key, Python setup or server command. Downloads show
progress and can be cancelled and resumed. The model stays installed across app
updates; turning the adviser off keeps it for later.

The bundled local runtime is currently offered on Apple Silicon Macs. Other
platforms show a clear unavailable message and can continue with their selected
chat provider. The adviser supplements your connected chat model: after a local
coding check fails, it can suggest a permitted next step. Its advice can be wrong.
The existing tool permissions, source checks and completion requirements remain
in force. The model unloads when idle and stops when Nova Collar quits.

The model is redistributed under the [LFM Open License](data/licenses/d1-Omni-LICENSE.txt).
Liquid AI permits [free model downloads](https://www.liquid.ai/lfm-license);
downstream commercial use remains subject to its $10 million annual-revenue
condition. Training Lab and model training are separate and are never enabled
by this installation.

## Keep working in the same conversation

Send guidance while a reply is running; each message is saved separately and
incorporated after the active model request or tool batch. Stop, errors and
restarts leave unconsumed messages paused. **Continue** or another deliberate
Send resumes them. An action that already started cannot be undone by steering.
One lead turn per profile prevents the window and CLI from racing.

When a detail is needed, a question panel offers unselected suggestions and a
separate text field. Choose or type an answer, then submit. Minimize preserves
the question draft; Stop cancels the wait. Question wording and silence are
never authorization. The CLI accepts busy guidance, `/continue`, and explicit
`/answer ["answer one", "answer two"]`; noninteractive runs state missing details
without waiting for a terminal answer.

`/checkpoints` lists file versions and uncovered paths. `/undo [id]` restores
covered files only if no subsequent edits conflict; it does not undo external
service actions. Declare shell mutations with `host_run.paths` before execution.
Project checks use a human-authored `.nova/checks.json` or existing manifest
commands. Missing checks and partial coverage remain unverified.

`/context` shows metadata from the actual last dispatched lead request after
compaction. `/context next` builds a fresh local preview. The assistant has the
same read-only `context_info` tool; Settings → context exposes both views.
Counts include tool schemas and reserved reply capacity, and distinguish full
instruction files, skill catalogs, bounded memory, and project references.
Snapshots keep counts and source paths, with no copied prompt/file/schema
bodies. Estimates are not provider billing. Instruction files load in full within
explicit limits; referenced files require a separate read.

Helpers receive a bounded packet with original/latest incorporated message
sources, timestamps and omission counts. Pending messages are excluded until
incorporated. Image evidence retains its actual source, and helper selection
metadata is saved with the tool receipt.

`/dependencies` reports dated local tool availability without model probes or
installation. `npm run evaluate:harness` emits a reproducible isolated fixture
report, with source/grader hashes. It measures harness behavior, not live model
quality or general coding parity.

## Pick a model

Nova Collar is model-agnostic, and the window makes the connection the first thing you do. Choose a provider, paste your key, and connect:

- **Hungry Nova Labs** — paste the key we gave you and connect. The picker discovers the account's current model IDs and capabilities automatically. Select one model for the whole turn, or explicitly select fast and thinking roles from that catalog. Retired fixed model pairs are not restored automatically.
- **OpenAI, OpenRouter, Groq** — your own key; the address is already filled in, and common model names are offered.
- **Custom (OpenAI-compatible)** — any https endpoint you paste, with your own key and model.

Hosted models refresh on launch, after connecting a provider, and when opening the model picker (at most once every five minutes). **Refresh available models** forces a new scan. The last successful catalog survives restarts and remains available during outages, with an error shown when a refresh fails. Catalogs are scoped to the provider and credential; keys are never stored in the catalog. Saved model and lane IDs remain selectable. Model descriptions appear on hover; models declaring no tool support are labeled **chat only**, and advertised output limits are respected. Discovering a model does not download it or guarantee its backend is online.
- **On this computer** — scan for a local server you already run (Ollama or LM Studio). No key needed.

The window saves the selected provider, model, and connection settings in the local profile.

**By hand, if you prefer.** The window writes your choice to `~/.novapup/env` (macOS and Linux) or `.novapup\env` in your user profile (Windows). You can edit it directly:

- `HNL_FAST_MODEL` / `HNL_FAST_URL` — the fast model works the harness on this computer.
- `HNL_THINK_MODEL` / `HNL_THINK_URL` — the thinking model forms the plan and checks what the work turned up.
- Leave both lanes blank and the one chat model does the whole turn. Give it two different models or endpoints and the split turns on.
- A lane can carry its own key with `HNL_FAST_KEY` / `HNL_THINK_KEY`. Leave those blank and the lane borrows the chat key, so a single key can drive both lanes.

Search is bring-your-own; Nova Collar does not ship web search, page extract, or docs search. On a Mac, to let the window see and drive the screen, grant it Accessibility and Screen Recording when macOS asks. Windows and Linux do not have that screen control.

## Approval before risky actions

Nova Collar asks before broad file replacements, emptying an existing file, writes outside the working folder, changes to standing instructions, shell commands that are not recognized as read-only, agent typing in the terminal, and actions that change remote applications or containers. The dialog shows the action, path or command, reason, and a content preview for file writes. Choose **Allow once** or **Deny**. Approval covers that one action; if the file changes while the dialog is open, the agent must read it again.

These checks also cover sub-agents, background work, and automatic harness execution. A denied request stops the current task. Requests expire after ten minutes, and contexts without an approval handler deny them. These are application-level checks, not an operating-system sandbox; approving a shell command authorizes the effects of that command. Small edits inside the working folder can proceed without a dialog.

## Release findings and development

[Release notes](CHANGELOG.md) record model discovery, conversation-history fixes, and the earlier Windows findings shared with Mac. Local and hosted connections stay explicit, the smaller model gets a bounded tool loop, and success claims must follow tool evidence. Windows has PowerShell, file, host, network, and Docker tools; native screen control remains Mac-only. Docker requires a running Docker engine.

For a source checkout, use Node.js 22.12 or newer, `npm ci`, then `npm test`. Tests isolate app settings in temporary folders and do not require a model server or GPU. Company release checks run on company-controlled hardware; each release records its actual platform coverage and Electron/native-terminal results. Public Mac builds require Xcode command-line tools, an explicitly pinned and approved Developer ID certificate, and validated notarization credentials; see [release instructions](docs/releasing.md).

## How a turn works

A turn can start with a small decision model called Laya. Laya does not write the reply. It scores one short choice about what the request needs: answer in words, look something up, work with files, use the terminal, check the network, use Docker, drive the Mac screen, work on code, or refuse.

Laya is optional. With it, the choice is sharper. Without it, the window still runs: an always-on structural check still refuses what should be refused, and a set of heuristics still routes the work. Installing Laya never becomes a thing the window depends on to answer.

From there the fast model works the harness and the thinking model plans and checks the result. Laya stands between them and picks the path. Plain answers come from the thinking model, and if either model stops answering, the other takes the turn. With one model configured, that model fills both roles.

The chat model then works a tool pack — a group of tools for one kind of work: the terminal, this system, the network, Docker, an incident, the Mac screen, or a remote computer. A locked pack takes priority over Laya's normal selection, but refusal takes priority over both. Requests to bypass the safety rules or dump real secrets are routed to refusal. A sub-agent handles a short tool loop inside a single pack.

### Laya, the decider

Laya is a task-routing classifier. It reads a request and picks the lane; it carries no private data of ours or yours. It starts from [`convaiinnovations/laya`](https://huggingface.co/convaiinnovations/laya) (Apache-2.0), which builds on Answer.AI's ModernBERT-large, and our checkpoint is trained only on Nova Collar's own job, loop, goal, and audit questions. That makes it safe to pass along with the app.

To add it:

```bash
nova-collar update laya
```

That downloads the checkpoint (about 1 GB) into a writable spot the app can reach, and sets up a small Python environment for it — PyTorch and a few companions from PyPI, a few hundred MB more on first run. After that the window finds the model on its own; point `NP_LAYA_MODEL` at a checkpoint if you keep one elsewhere. Nothing about Laya reaches out to the network.

### Software analysis, built in

Nova Collar includes REA, headless Ghidra, and the Node and Java runtimes they
need. Choose **Software analysis** in Work, or choose an app or file in Settings.
Ask what a program does, trace a feature, or compare two builds. JavaScript and
Electron inspection works without launching the target. Native queries start
headless Ghidra automatically. The app owns the helper processes; users do not
start a server or configure MCP.

Each investigation has an explicit target and session. Results and evidence are
saved in `~/.novapup/analysis`. Finished investigations close their helpers;
idle sessions close after ten minutes, and quitting Collar saves and closes
active sessions. Cancel stops the current request. Results distinguish evidence
from inference, and large responses can be read in pages. A selected remote
model receives tool findings just as it receives other chat context.

The **Ghidra projects** pack remains available for an existing desktop project.
It connects to the local Ghidra window at `127.0.0.1:8089` and preserves that
project workflow. Normal software investigations use the internal headless route.

Source builds run `npm run analysis:prepare` once. Packaging prepares and verifies
the pinned bundle automatically. macOS native decompiler builds need Xcode Command
Line Tools on the build machine; installed apps do not. See
[analysis packaging and verification](docs/software-analysis.md). Extra REA
providers such as Android/JADX and firmware extractors retain their own optional
requirements; bundling REA and Ghidra does not install every third-party engine.

### The terminal is a two-way door

The window has a live terminal. The agent can type into it and read it, so it can run a command where you can watch, and the chat shows what it typed. You can also talk back to the agent from that same terminal: `nova-collar "what you want"` runs a turn on the same chats as the window. When the agent changes its working directory, the terminal follows. It is meant for frictionless system work — you and the agent at one prompt.

### The pack

The bots are the pack. Each has a standing role, a voice, and one steer pack. Members on the same pack share explicit user corrections and evidence-linked repairs. A repair lesson requires the same scope, changed source and equal-or-stronger passing verification; an unrelated successful step teaches nothing. Laya drops a lesson that does not belong to that pack, or that was already taught.

The Pack is also where longer work goes, so the conversation keeps moving. You open the Pack and write a task — what needs doing, what done looks like, and who holds it — or you tell Nova Collar in the chat to take care of it. A task runs once, every minute, or every three minutes, until the goal is met. The board shows what is open, worked, and finished. Before a file is replaced, three older copies are kept. If you assigned the task, the Pack waits for you before it writes; if Nova Collar assigned it, the Pack keeps going until an overwrite or a delete, then waits. When the goal is met, the writeup lands in a chat named for that task.

It is good for work you can look at: a repeated check, a small patch, a reachability watch. I would not hand it a long coding job and walk away.

### Doing the work means checking the work

The difference I care about is between saying something worked and having a reason to say it worked.

- **Code.** The harness requires compilation, execution, and a checklist against what was asked before the agent may call the job passed.
- **Facts.** A claim has to come from something the agent actually read this turn. Otherwise it says it does not know.
- **Repeats.** On the second identical tool call, Laya judges whether to continue or stop. A third identical call is stopped. A terminal that is still moving is not the same as progress.

For longer work in the conversation, `/goal` followed by an outcome sets a standing goal; `/goal` shows it and `/goal clear` removes it. While a goal is open, a repeated tool call is skipped so the turn takes a different step instead of ending in "Stopped." Before Nova Collar brings an answer back, it writes down the claim it wants to make, asks the opposite, and tries to disprove the opposite with a tool result. If it cannot, it drops that path and tries another, or says the claim is not proven.

## License and thanks

Nova Collar is Apache-2.0, Copyright 2026 Hungry Nova Labs LLC. The full terms are in [`LICENSE`](LICENSE), the attribution is in [`NOTICE`](NOTICE), and the software credits open from the name in the window's corner.

The window stands on other people's work, and the duty their licenses ask is small: keep their notices with any real copy.

- **MIT.** Electron, xterm.js and its fit addon, node-pty, and qrcode make up the window and its terminal; electron-builder and @electron/rebuild package it. Thank you to the Electron contributors and GitHub, the xterm.js authors (SourceLair and Christopher Jeffrey), Christopher Jeffrey again for node-pty, and Ryan Day for qrcode.
- **BSD, inside Electron.** Electron ships Chromium; Chromium's notices travel with the Electron distribution.
- **Apache-2.0.** Laya starts from `convaiinnovations/laya`, which builds on Answer.AI's ModernBERT-large. Thank you to Convai Innovations and to Answer.AI. Our checkpoint is a modified copy; their license, a note that the weights changed, and their attribution travel with it.
- **Optional, from PyPI.** If you add Laya, its Python environment pulls PyTorch, transformers, safetensors, huggingface_hub, and numpy under their own licenses. None of these ship inside the window.
- **Ollama (MIT).** If setup installs it for a local model. Nova Collar does not ship Ollama inside the window.
- **REA (MIT).** [morluto/rea](https://github.com/morluto/rea) supplies the software-analysis MCP engine. Its original copyright and permission notice remain intact in the bundle and [REA license](runtime/analysis/licenses/REA-MIT.txt).
- **Ghidra (Apache-2.0 and component licenses).** [NationalSecurityAgency/ghidra](https://github.com/NationalSecurityAgency/ghidra) supplies native analysis. Its original source, notices, and GPL demangler source remain in the bundle. Node, Temurin, and the MCP SDK retain their own licenses; see [analysis provenance](docs/software-analysis.md#licenses-and-provenance).

## About Hungry Nova Labs

Nova Collar is developed and maintained by Hungry Nova Labs LLC. Company information is available at [hungrynovalabs.com](https://hungrynovalabs.com).
