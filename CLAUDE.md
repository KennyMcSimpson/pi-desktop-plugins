# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.
`AGENTS.md` is the authoritative rule set; this file is the short version.

## Repository purpose

Distribution repository for PI-Desktop plugins: the published `catalog.json`, the `.piplug`
packages it references (`packages/`), the scripts that refresh and audit them (`scripts/`), Python
tests (`tests/`) and an optional standalone website (`website/`). The PI-Desktop client's default
catalog source is the plugin center, `https://plugins.aiuo.net/catalog.json`.

Plugin sources are **not** hosted here. The `plugins/` tree was removed; sources live in their
authors' repositories, and the plugin center packs, audits, records the SHA-256 and publishes every
version, then mirrors `catalog.json` + `packages/` to `AIUO-Net/pi-desktop-plugins`. Do not
recreate `plugins/`, do not add plugin sources, and do not merge pull requests that do. Authoring
questions belong to the host guide:
`https://github.com/vastsa/PI-Desktop/blob/main/docs/plugin-development.md`.

## Commands

Tooling is Python 3 (stdlib only) at the root; `website/` is a separate Next.js app using pnpm.

- **Security preflight (mandatory)**: `python3 scripts/security_audit.py --check-packages` — audits
  every `.piplug` in `packages/` (structure, manifest, filename/manifest agreement, permissions).
  Zero blockers is required; manual-review signals still need maintainer judgement. It also audits
  a plugin source directory you pass explicitly.
- **Refresh from the center**: `python3 scripts/sync_catalog.py [--dry-run]` — stages the center's
  catalog and packages in a temp directory, rejects an empty or shrinking-to-zero catalog, then
  replaces `catalog.json` + `packages/`.
- **Tests**: `python3 -m unittest discover -s tests -p 'test_*.py' -v`.
- **Website** (optional): `cd website && pnpm install --ignore-scripts && pnpm build`.
- No linter/formatter is configured.

`catalog.json` is generated output — never hand-edit it. `packages/*.piplug` are immutable published
artifacts — never repack, patch or rename one in place.

## Security review

Read `SECURITY.md`. No backdoors, hidden data exfiltration, credential theft, remote code loading,
unexplained obfuscation, persistence, permission-gate bypasses, or destructive behavior without
explicit user confirmation. The source review itself happens on the plugin center against the tagged
source and the packed artifact; this repository distributes what that review approved. Treat
filesystem writes/deletes, network, credentials, native binaries, shells/PTY, SSH, background
services, `agent.prompt.inject` and `desktop.control` as high risk.

## Commits

Conventional format, English, imperative, one logical change per commit:
`chore: drop the plugin source tree and source-only tooling`,
`docs: point plugin authoring at the plugin center`. Scope names the area (`catalog`,
`security-audit`, `website`, `docs`).
