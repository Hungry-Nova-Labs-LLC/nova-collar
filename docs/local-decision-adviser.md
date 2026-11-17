# Free local decision adviser

After connecting your main chat model, Nova Collar offers an optional local
adviser. Select **Install free local adviser** to download and enable
Liquid AI’s d1-Omni-2B on your computer. The model download is about 1.85 GB;
supported builds include its small runtime. A model account or API key is not
needed for this local adviser.

The adviser suggests a next step after a check fails. Your selected chat model
continues doing the work. The suggestion is optional and can be wrong; a
suggestion never replaces a real check or grants permission to act.

Installation shows download progress, verifies the file, and runs one small
local check before enabling the adviser. **Cancel installation** stops setup.
If setup fails, the screen offers a retry. **Continue to chat** hides the
progress screen while installation continues.

Choose **Maybe later** to skip setup. Return through **Settings → local decision
adviser** whenever you want. Once installed, you can check the local adviser,
enable it, or turn it off. Turning it off keeps the download, and app updates
retain the model in your local profile. Your primary chat connection stays
selected. Installing or enabling the local adviser explicitly selects it over
any previously configured adviser; merely opening this screen does not change
that configuration.

The model has its own [LFM Open License](https://www.liquid.ai/lfm-license).
Commercial use is subject to its $10M annual-revenue threshold; downstream
users remain responsible for those terms. **Model license** opens the license
included with Nova Collar. No separate license checkbox is required to use the
setup screen.

The local option is shown only on supported computers. Other computers can
continue using their configured chat model without installing an adviser.

## Interface verification

`node scripts/test-decision-setup-ui.mjs` runs the production renderer, preload,
and IPC bridge with an isolated temporary profile and synthetic download/model
operations. It covers primary connection ordering, saved connections, deferral,
Settings re-entry, byte-based progress, cancellation/retry, background stage
updates, enable/disable, local checking, active-work/draft deferral, safe error
messages, and compact layout. It makes no model requests or model downloads.
The separate backend and packaged-app checks qualify the actual runtime.
