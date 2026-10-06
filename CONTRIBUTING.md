# Contributing to PI-Desktop plugins

This repository holds the published plugin catalog (`catalog.json`), the packages it
references (`packages/*.piplug`) and the tools that keep them honest. Plugin **sources are not
hosted here**: `plugins/` was removed, and pull requests that add plugin sources are closed.

Where plugins are submitted now:

```text
https://plugins.aiuo.net
```

The center is the client's default catalog source (`https://plugins.aiuo.net/catalog.json`). It
binds each plugin to the repository it lives in, audits the source and the artifact, serves the
`.piplug` packages and mirrors `catalog.json` + `packages/` to
[AIUO-Net/pi-desktop-plugins](https://github.com/AIUO-Net/pi-desktop-plugins) for the GitHub backup
channel.

## Submit a plugin to the plugin center

1. Build the plugin in **your own repository** — see [Before you publish](#before-you-publish).
2. Push it and tag the version (`v0.4.8`). The tag, or a commit SHA, becomes the `sourceRef` the
   source review reads.
3. Bind that repository to the plugin through the console's source binding (a GitHub App grant).
   The binding is what the review and the catalog's source pin follow, so it cannot be swapped
   afterwards without an operator.
4. Submit the version. Two routes reach the same backend:
   - **Console** — sign in at [plugins.aiuo.net](https://plugins.aiuo.net) → **My Plugins** →
     **Create plugin**, then submit later versions from the plugin's own page.
   - **AI client** — follow the publishing skill, `https://plugins.aiuo.net/skill.md`, which drives
     the MCP endpoint `https://plugins.aiuo.net/mcp` with a personal access token from
     [Console → Tokens](https://plugins.aiuo.net/console/publish/tokens).
5. The center audits the source, a maintainer approves, and the version goes live with its
   SHA-256 and install counts.

`pi.` and `demo.` are reserved namespaces and need an operator to release.

## Before you publish

Start from a built-in template: **Plugins → ⋯ → New plugin from template** (`panel-basic`,
`agent-tool-basic`, `skill-pack`, `full-demo`). From a PI-Desktop checkout you can use the devkit
CLI instead:

```bash
pnpm --filter @pi-desktop/plugin-devkit... build
pnpm pi-plugin init panel-basic ../my.plugin-id
pnpm pi-plugin check ../my.plugin-id     # manifest, permissions, referenced files, size
pnpm pi-plugin pack ../my.plugin-id      # dist/my.plugin-id-0.1.0.piplug + SHA-256
```

Then verify in the host: **Plugins → Load dev plugin** while developing, and
**Install plugin package** with the packed `.piplug` before you release. Confirm the command
palette entry, the panel, the agent tool (forced prefix `plugin_<id_safe>_<tool>`), and that
undeclared or ungranted permissions fail cleanly.

### Plugin layout

```text
<your-plugin-repository>/
  manifest.json      # required
  main.js            # required entry
  renderer/          # optional isolated panel UI
  README.md          # shown in marketplace detail
  skills/            # optional
```

### manifest.json minimum

```json
{
  "schemaVersion": 1,
  "id": "my.plugin-id",
  "name": "My Plugin",
  "version": "0.1.0",
  "description": "What it does",
  "i18n": {
    "en": {
      "name": "My Plugin",
      "description": "What it does",
      "safetyNotes": "Reads nothing outside its own panel."
    },
    "zh-CN": {
      "name": "我的插件",
      "description": "插件功能简介",
      "safetyNotes": "不读取面板之外的内容。"
    }
  },
  "author": "your-name",
  "main": "main.js",
  "permissions": ["ui.panel"],
  "engines": { "piDesktop": ">=0.2.0" }
}
```

`i18n` needs `en` and `zh-CN`, each with a non-empty `name`, `description` and `safetyNotes`.
Use BCP-47 locale keys; additional locales need no website change. The catalog falls back per
field — a half-finished block ships as mixed language rather than as an error, so finish it before
you submit.

### Recommended fields for marketplace quality

- `categories`: e.g. `["productivity", "official"]`
- `changelog`: short release notes for the current version
- `safetyNotes`: plain-language risk summary
- `ui.panel`: isolated panel html entry
- `contributes.commands` / `contributes.agentTools` / `contributes.settings`

### Panel title and host chrome compatibility

Every localized slot must carry both locales — a half-translated title is refused by the host:

```json
{
  "ui": {
    "panel": "renderer/index.html",
    "title": {
      "en": "My Plugin",
      "zh-CN": "我的插件"
    }
  }
}
```

Do not hard-code a replacement title when opening the panel from a command. Use
`pi.ui.openPanel()` without a `title` option so the host can resolve the localized manifest title.
PI-Desktop reserves exactly a 46px transparent drag band at the top of every panel and renders a
minimal three-button window-control capsule in the top-right corner. Normal-flow plugin content is
offset below the band automatically. Plugins own every other visible part of the panel, and must
not implement a second draggable window titlebar. A plugin element that is fixed or sticky to the
window edge must begin at `top: var(--pi-plugin-titlebar-height, 46px)`.

## Packaging rules

- Root of the package must contain `manifest.json`
- No symlinks, no path traversal
- Store-compressed `.piplug` — a package made with a generic ZIP tool is rejected
- Max 50 MB and 2,000 files
- Do not expect host-side `npm install` at install time; bundle dependencies yourself

## Permission policy

Request the minimum set:

| Permission | Use |
|---|---|
| `ui.panel` | Open isolated panel |
| `ui.view` | Dock in the right work panel |
| `fs.read.workspace` | Read project files |
| `fs.write.workspace` | Modify project files |
| `clipboard.read` / `clipboard.write` | Clipboard access |
| `notify` | Local notifications |
| `net.fetch` | Outbound network |
| `shell.openExternal` | Open external links |
| `agent.tool.register` | Expose tools to the agent |
| `agent.prompt.inject` | Inject skill prompts |
| `background.service` | Keep the plugin process resident |
| `usage.read` | Read aggregate local token usage without message content |

High-risk permissions are reviewed in the install UI. Auto-update will not silently expand
permissions.

## Security review gate

Read [SECURITY.md](./SECURITY.md) before submitting a plugin. Neither this repository nor the
plugin center accepts backdoors, hidden data collection or exfiltration, remote code loading,
unexplained obfuscation, hard-coded credentials, persistence, security-control changes, or
destructive operations without explicit user confirmation.

The release gate runs on the plugin center against the tagged source and the packed artifact. For
filesystem writes/deletes, network, credentials, native binaries, shell/PTY, SSH, background
services, prompt injection, or desktop control, include a capability/data-flow matrix,
negative-path tests, dependency provenance, and two independent maintainer approvals. A passing
script or test suite is not proof that a plugin has no backdoor.

## Contributing to this repository

Accepted here — everything about the distribution side:

- a `.piplug` in `packages/` that fails to install, has a wrong size or hash, or contains the wrong
  files
- a stale, wrong or missing entry in `catalog.json`
- a bug in `scripts/`, `tests/` or `website/`
- a documentation mistake

Not accepted here:

- pull requests that add plugin sources under `plugins/` — they are closed with a pointer to the
  plugin center, where the same review happens against your own repository
- hand-edited `catalog.json`: it is generated output

Local checks before opening a pull request:

```bash
python3 scripts/security_audit.py --check-packages
python3 -m unittest discover -s tests -p 'test_*.py' -v
python3 scripts/sync_catalog.py --dry-run
```

## Reference material

- Host authoring guide: [`docs/plugin-development.md`](https://github.com/vastsa/PI-Desktop/blob/main/docs/plugin-development.md)
- Example plugins: [PI-Desktop `examples/plugins`](https://github.com/vastsa/PI-Desktop/tree/main/examples/plugins)
- Plugin system specs: [PI-Desktop `docs/spec/07-plugins`](https://github.com/vastsa/PI-Desktop/tree/main/docs/spec/07-plugins)
