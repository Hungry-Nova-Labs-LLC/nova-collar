# Nova Collar workspace upgrade

This main application build, 0.6.0, integrates the public workspace and runtime
changes based on GitHub commit `d129b9f` onto the official main source.
A locally installed build is distinct from a published GitHub installer.

## Source boundary

The private dev application is an archived reference. Its application code,
assets, dependencies, profiles, credentials, documents, indexes and model
configuration are not part of this public working tree. Proposed private
feature ports were withdrawn before this public-only checkpoint.

The desktop interface is newly authored against the public renderer and its
existing IPC bridge. The subsequent [Nova Tag integration](TAG-INTEGRATION.md) adds selected Tag
behavior to the public runtime. No private Collar feature code is used. The
window and profile changes are independently written for the public app.

## Desktop interface

- Desktop-sized window with persistent navigation and saved conversations.
- Visible working folder, context inspection and Cmd/Ctrl+K command search.
- Direct access to existing agents/tasks, work review, specifications and terminal.
- Stable text sizing, Graphite theme, geometric Nova monogram and a collapsible
  sidebar in narrow windows.
- Existing queued guidance, Stop/Continue, questions, approvals and terminal
  docking remain connected to the public runtime.
- Ears, animated eyes and companion-style decoration are removed. Existing
  internal storage keys and bridge identifiers remain compatible.

Animation Studio, private knowledge/embedding tools and private research
improvements are not included. Future additions will be implemented
separately in the public project.

## Verification and local review

`npm test` runs the public baseline and the new Tag-integration checks. Electron fixtures verify
real main/preload/agent and renderer flows without a real model or personal
profile. The newly authored `scripts/test-workspace-ui.mjs` checks chat
navigation, working folders, context, command search, terminal controls,
legacy folded-header compatibility and narrow-window layout. Screenshots use
sample conversations, not personal data.

```sh
NOVA_WORKSPACE_SCREENSHOTS=/absolute/output/folder \
  ./node_modules/.bin/electron scripts/test-workspace-ui.mjs
```

To review the source build with separate application and browser storage:

```sh
NOVAPUP_HOME=/absolute/private/preview-profile npm start
```

Public model and tool connections still require normal configuration.
Software analysis engines can be prepared through the public project's
existing `npm run analysis:prepare` workflow. The public launcher has no
connection to the archived private application.
