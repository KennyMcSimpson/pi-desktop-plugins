# PI-Desktop Plugins

[中文版 / Chinese](./README.zh-CN.md)

The published plugin catalog and the installable `.piplug` packages for
[PI-Desktop](https://github.com/vastsa/PI-Desktop).

> **Plugin sources are not hosted here and pull requests that add them are no longer accepted.**
> Sources live in their authors' own repositories and every release goes through the plugin center
> — [plugins.aiuo.net](https://plugins.aiuo.net) — which is the client's default catalog source.
> The former `plugins/` tree was removed. To ship a plugin, read
> [Publish a plugin](#publish-a-plugin).

## Publish a plugin

### 1. Build it in your own repository

Start from a template inside the app: **Plugins → ⋯ → New plugin from template**
(`panel-basic`, `agent-tool-basic`, `skill-pack`, `full-demo`). From a PI-Desktop
checkout you can also use the devkit CLI:

```bash
pnpm --filter @pi-desktop/plugin-devkit... build
pnpm pi-plugin init panel-basic ../my.plugin-id
pnpm pi-plugin check ../my.plugin-id     # manifest, permissions, referenced files, size
pnpm pi-plugin pack ../my.plugin-id      # dist/my.plugin-id-0.1.0.piplug + SHA-256
```

Load the folder with **Plugins → Load dev plugin** while you work, and install the
packed `.piplug` with **Install plugin package** before you release it. The full
authoring contract (manifest schema, host API, permissions, security) is documented
in [`docs/plugin-development.md`](https://github.com/vastsa/PI-Desktop/blob/main/docs/plugin-development.md).

### 2. Publish on the plugin center

Both routes reach the same backend:

- **Console** — sign in at [plugins.aiuo.net](https://plugins.aiuo.net) → **My Plugins** →
  **Create plugin**: upload the package, bind the repository the plugin lives in, submit. Later
  versions are submitted from the plugin's own page.
- **AI client** — install the publishing skill and let an agent run the whole flow:

  ```text
  https://plugins.aiuo.net/skill.md
  ```

  The skill drives the MCP endpoint `https://plugins.aiuo.net/mcp` with a personal access token
  from [Console → Tokens](https://plugins.aiuo.net/console/publish/tokens), kept at
  `~/.pi-desktop/plugin-center.token`. It sends the fields of your local `manifest.json` plus the
  source files — `ui`, `contributes`, `activationEvents`, `fs` and `net` included, because
  anything a call omits is dropped and the installed plugin becomes invalid.

A release needs three things:

1. **A tagged source repository.** Push the plugin and tag the version (`v0.4.8`); the tag, or a
   commit SHA, becomes the `sourceRef` the source review reads.
2. **A bound repository.** The plugin is bound to one repository through the console's source
   binding (a GitHub App grant). That binding is what the review and the catalog's source pin
   follow, so it cannot be swapped afterwards without an operator.
3. **A version nobody published before**, with release notes. The center audits the source, an
   operator approves, and the version goes live with its SHA-256 and install counts.

Ids under `pi.` and `demo.` are a reserved namespace and need an operator to release.

## What this repository holds

| Path | Description |
|------|-------------|
| `catalog.json` | The catalog this repository serves |
| `packages/*.piplug` | The published packages that catalog references |
| `scripts/security_audit.py` | Fail-closed preflight over every `.piplug` |
| `scripts/sync_catalog.py` | Mirrors `catalog.json` + `packages/` from the plugin center |
| `tests/` | Python tests for those scripts |
| `website/` | Optional standalone marketplace website built from the catalog |

`plugins/` no longer exists. Plugin sources are not stored or reviewed here; the
plugin center builds, audits and publishes from each author's repository, and
mirrors the result to [AIUO-Net/pi-desktop-plugins](https://github.com/AIUO-Net/pi-desktop-plugins)
for the GitHub fallback channel.

## Available Plugins

The plugin center is the live list:
[plugins.aiuo.net](https://plugins.aiuo.net) serves the newest release of every plugin,
including the ones published from their authors' own repositories. The tables below
list what this catalog serves.

### Official (maintained by PI-Desktop team)

| Plugin | Description | Author |
|--------|-------------|--------|
| **pi.todo** | Lightweight todo app with four-quadrant matrix and simple list layouts, due reminders and AI tool integration | PI-Desktop |
| **pi.token-insights** | Token usage dashboard tracking PI-Desktop, Claude Code, Codex and other tools | PI-Desktop |
| **pi.gitlens** | GitLens-style local Git management docked in the work panel (human UI only, no agent tools) | PI-Desktop |
| **pi.ssh-manager** | Local-first SSH host management with AI remote command tool, transient panel passwords and no persisted credentials | PI-Desktop |
| **pi.terminal** | Interactive terminal docked in the work panel; multi-tab, cross-platform shell | PI-Desktop |
| **pi.session-orchestrator** | Coordinate real durable worker sessions from an Agent with bounded parallel execution, multi-round supervision and final-report acceptance | PI-Desktop |

### Community

| Plugin | Description | Author |
|--------|-------------|--------|
| **pi.scratch-calc** | Scratch calculator with multi-line history, percentage/power/π/e and dark mode | Tioit-Wang |
| **pi.super-domain-man** | Multi-platform DNS record management and SSL certificate monitoring/issuance | Tioit-Wang |
| **pi.markdown** | Local Markdown notes with WYSIWYG editing, table of contents, code highlighting, Mermaid / KaTeX | Tioit-Wang |
| **pi.clipboard-history** | Clipboard history capturing text during runtime, retained 30 days, one-click restore | Tioit-Wang |
| **pi.log-viewer** | Large log viewer with streaming pagination, live tail, search highlighting and multi-file tabs | Tioit-Wang |
| **pi.file-manager** | Project file manager in the right work panel: directory tree, syntax-highlighted editor, Markdown preview, media and CSV/JSON views, read-only SQLite browser, context-menu file operations, filename search | Tioit-Wang |
| **pi.bianqian** | Markdown desktop sticky notes: multi-note, live preview, task lists, highlighter and trash | ZY |
| **io.github.muzimu217.session-import** | Own repository: [muzimu217/pi-desktop-session-import](https://github.com/muzimu217/pi-desktop-session-import), published on the [plugin center](https://plugins.aiuo.net/) | muzimu217 |
| **io.github.muzimu217.deps-audit** | Dependency vulnerability audit: runs osv-scanner over the workspace, lists known OSV matches and lets the Agent propose a fix or upgrade | muzimu217 |
| **io.github.liushunqiu.pi-idea-git** | IDEA-style Git tool window: staged/unstaged change lists, hunk-level stage & revert, commit, branch switcher, graph log and stashes | liushunqiu |
| **pi.workspace-file-guard** | Keeps model-written test, log, cache and temp files off the system drive, Desktop and Downloads; junk stays in the project's Temp or scratch | xingleiwu |
| **pi.goal-x** | Persistent workspace goals, task evidence and host-owned completion audits | Goal X contributors |
| **pi.parchment** | Warm parchment global theme: cream paper background with a faint grid, ink user bubbles, paper assistant cards and monospace meta lines (styling only) | pkmcenter |
| **pi.obsidian-theme** | Deep blue-teal global theme tuned against a measured reference: a layered surface ladder, hierarchy from 1px hairlines rather than glow, a solid teal selection fill and a four-step text scale (styling only) | ily55421 |

Published on the plugin center from their authors' own repositories:

| Plugin | Description | Author |
|--------|-------------|--------|
| **cc.mcii.session-notify** | Watch every session's state changes and push titles and status to Feishu, DingTalk, WeCom, KOOK, ServerChan, Telegram or a generic webhook; message bodies are never read | LectWolf |
| **cc.mcii.session-usage** | `/usage` command showing the current session's input, output, cache reads, cache writes and hit rate | LectWolf |
| **cn.star.computer-use** | Codex-style computer use: let the Agent drive the desktop to finish simple tasks | TheFalreStar |
| **cn.star.grok-enhance** | Execution discipline for Grok plus Grep / Glob (and already-installed memory / skill_manage) activation on the first request of every turn | TheFalreStar |
| **cn.star.skill-learning** | Turns a finished task into a reusable SKILL, reviewing long sessions in the background instead of in the chat | TheFalreStar |
| **cn.star.user-profile** | Local user and machine profile with a character cap, injected into the system prompt each turn and written through the memory tool; no remote memory service | TheFalreStar |
| **io.github.catdford.color-picker** | Browse Tailwind / Material palettes, pick colors from an image with a pixel loupe, build schemes with harmony rules or AI, check WCAG contrast and color blindness, export CSS variables / Tailwind / JSON, or install the palette as a PI-Desktop theme | catdford |
| **local.pi-markdown** | Local Markdown notes with true WYSIWYG editing (Typora-style Milkdown Crepe), light/dark themes, outline, code highlighting, Mermaid and KaTeX, global search, Markdown/HTML/image export and a read-only `preview_file` agent tool | Tioit-Wang |
| **pi.theme.studio** | Theme studio: 5 built-in palettes, visual editing of all 56 `--ds-*` tokens and 7 window regions with fills, gradients, images, blur and radius, live preview, WCAG contrast checks and 4 agent tools for building themes from a prompt | Tioit-Wang |

### Templates

The former `demo.*` sources are gone from this repository — start new plugins from
the built-in templates in PI-Desktop (**Plugins → ⋯ → New plugin from template**).
Their published packages remain installable:

| Plugin | Description |
|--------|-------------|
| **demo.hello** | Minimal example: panel + command + tool registration |
| **demo.workspace-summary** | Practical template: scan workspace and generate a summary |
| **demo.workspace-notes** | High-risk capability demo: file read/write + network requests |

## Install Plugins

1. Open PI-Desktop → **Plugins**
2. Go to the **Marketplace** page
3. Click **Refresh** to load the latest catalog
4. Browse and install plugins

The default source is the plugin center:

```text
https://plugins.aiuo.net/catalog.json
```

The same page switches to the backup channels the client ships — the GitHub mirror
(`raw.githubusercontent.com/AIUO-Net/pi-desktop-plugins/main/catalog.json`) and the CNB mirror —
for networks where the center is unreachable.

## Refresh this catalog

`scripts/sync_catalog.py` mirrors the center's published catalog and packages into this
repository, fail-closed: it stages everything in a temp directory, rejects an empty or
shrinking-to-zero catalog, and only then replaces `catalog.json` and `packages/`.

```bash
python3 scripts/sync_catalog.py --dry-run   # report what would change
python3 scripts/sync_catalog.py             # replace catalog.json + packages/
python3 scripts/security_audit.py --check-packages
```

`catalog.json` is generated output — never hand-edit it.

## Plugin Structure

```text
<your-plugin-repository>/
├── manifest.json      # Required: plugin metadata
├── main.js            # Required: CJS entry, exports onLoad()/onUnload()
├── renderer/          # Optional: panel UI
│   ├── index.html
│   ├── style.css
│   └── script.js
├── README.md          # Recommended: shown in marketplace detail
└── skills/            # Optional: AI agent tool definitions
```

### Key manifest.json Fields

```json
{
  "schemaVersion": 1,
  "id": "my.plugin-id",
  "name": "My Plugin",
  "version": "0.1.0",
  "description": "What it does",
  "i18n": {
    "en": { "name": "My Plugin", "description": "What it does", "safetyNotes": "What it can reach" },
    "zh-CN": { "name": "我的插件", "description": "插件功能描述", "safetyNotes": "能访问什么" }
  },
  "author": "your-name",
  "main": "main.js",
  "categories": ["productivity"],
  "permissions": ["ui.panel"],
  "engines": { "piDesktop": ">=0.2.0" }
}
```

`i18n` must carry `en` and `zh-CN` with `name`, `description` and `safetyNotes`, and every
localized slot (`ui.title`, `contributes.views[].title`) needs both locales — a
half-translated title is rejected by the host and by the center's upload gate.

### Common Permissions

| Permission | Use |
|------------|-----|
| `ui.panel` | Open isolated panel |
| `ui.view` | Dock in the right work panel |
| `fs.read.workspace` | Read workspace files |
| `fs.write.workspace` | Modify workspace files |
| `clipboard.read` / `clipboard.write` | Clipboard access |
| `notify` | Local notifications |
| `net.fetch` | Outbound network requests |
| `shell.openExternal` | Open external links |
| `agent.tool.register` | Register AI agent tools |
| `agent.prompt.inject` | Inject skill prompts |
| `background.service` | Keep the plugin process resident |
| `usage.read` | Read aggregate local token usage |

> **Tip**: Request the minimum set of permissions. High-risk permissions prompt the user at install time.

## Security

Plugin review is a release gate and it happens on the plugin center, against the tagged
source and the packed artifact. See [SECURITY.md](./SECURITY.md) for the blocker list, risk
tiers, artifact checks and vulnerability reporting process. Every package in `packages/` must
pass:

```bash
python3 scripts/security_audit.py --check-packages
```

## Contributing

**This repository does not accept pull requests that add plugin sources.** Open one and it is
closed with a pointer to the plugin center, where the same review happens against your own
repository. See [CONTRIBUTING.md](./CONTRIBUTING.md).

Useful contributions here are about the distribution side: a wrong SHA-256, a broken
`.piplug`, a stale catalog entry, a website bug, or a documentation mistake.

## Packaging Constraints

- Package root must contain `manifest.json`
- No symlinks or path traversal
- Store-compressed `.piplug` format (an ordinary ZIP is rejected)
- Max package size: 50 MB, max 2,000 files
- Bundle your own dependencies — no host-side `npm install`

## License

MIT
