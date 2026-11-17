# Free local decision adviser

Nova Collar can download Liquid AI's d1-Omni-2B Q8 model onto this computer and use it as an optional adviser after a failed coding command. It suggests one next-step category. It cannot execute a tool, grant permission, change the owner's scope or prove completion. Your selected chat model and the existing deterministic harness remain in charge. This is separate from the older optional Laya routing classifier.

In Settings, open **Local decision adviser** and choose **Install free local adviser**. The guided flow downloads the pinned model, verifies every byte with SHA-256, starts the bundled native runtime, and runs a small real decision check. Only after that check passes does the flow enable the local adviser. You can cancel, retry, check it again, disable it, or skip setup. A cancelled download resumes from its verified download identity on retry. Existing endpoint adviser settings remain unchanged until installation succeeds and local use is explicitly selected.

The initial supported package is Apple Silicon macOS. The small native runtime ships with the signed application; only the model downloads. Other platform builds need their own runtime qualification. No Python environment, Hugging Face account or API key is needed for the guided local download. The model is 1,846,241,184 bytes (about 1.72 GiB); leave this much free space plus 256 MiB. A successful installation stays under the normal Nova Collar profile in `decision-local/models`. App updates do not download the model again.

The pinned download is a public release asset in [Hungry Nova Labs' Nova Collar repository](https://github.com/Hungry-Nova-Labs-LLC/nova-collar/releases/tag/decision-models-1). The bundled `data/decision-assets.json` records its exact size, checksum and upstream revision. Each runtime binary/library is independently pinned in the runtime manifest. Installation promotes one complete verified regular file atomically; no model archive is extracted. Interrupted, mismatched and oversized downloads never become installed models. Public downloads carry no chat/provider credentials.

The app owns the local runtime and authenticates it with a temporary private token file. It binds only to a randomly selected loopback port, verifies its random model alias, and never borrows an already running model server. One decision runs at a time. The process unloads after two idle minutes; Stop cancels active advice and terminates its owned runtime when necessary. Quitting reaps the owned process and removes its token file. Unavailable advice is skipped; there is no silent endpoint fallback, automatic training, or change to chat routing.

The local provider uses native llama.cpp `/v1/systemone` typed decisions through the existing bounded decision transport. The gateway-only model routing field is omitted; original opaque action slots and validated probabilities are retained. The public failure-advice policy, source redaction, profile exclusion, per-turn limit, cancellation and completion authority are the same as for an explicitly configured endpoint adviser.

The model uses the **LFM Open License v1.0**, which is included in Settings and in `data/licenses/d1-Omni-LICENSE.txt`. It remains Liquid AI's model and license; Nova Collar's software license does not replace those terms. See [Liquid AI's license information](https://www.liquid.ai/lfm-license) and the included full terms for redistribution and commercial-use conditions.

Developer offline validation:

```sh
node --test scripts/test-decision-assets.mjs scripts/test-decision-local.mjs scripts/test-decision-adviser.mjs scripts/test-decision-service.mjs scripts/test-decision-adviser-production.mjs
```

Downloader tests use synthetic bytes. Lifecycle tests use a real owned local process that implements a tiny synthetic typed-decision server. They do not download model weights, run inference, use an owner profile or start any training service. Real native-runtime qualification is performed separately before packaging.
