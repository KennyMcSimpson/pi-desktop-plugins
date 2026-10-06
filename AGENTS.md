# AGENTS.md

Mandatory rules for AI coding agents working in this repository.

## Language

Use English for code, identifiers, comments, commits, specifications, and
documentation. When the user writes in another language, reply in that language.

## Repository Purpose

Distribution repository for PI-Desktop plugins: the published `catalog.json`, the
`.piplug` packages it references, the scripts that audit and refresh them, and an
optional standalone website. The PI-Desktop client's default catalog source is the
plugin center, `https://plugins.aiuo.net/catalog.json`.

Plugin **sources are not hosted here**. The former `plugins/` tree was removed:
sources live in their authors' repositories, and the plugin center —
[plugins.aiuo.net](https://plugins.aiuo.net) — packs, audits, records SHA-256 and
publishes every version from a bound source repository. It then mirrors
`catalog.json` + `packages/` to `AIUO-Net/pi-desktop-plugins` for the GitHub backup
channel.

Consequences for agents:

- Do not recreate `plugins/`, and do not add plugin source trees anywhere in this
  repository.
- Do not accept a pull request that adds plugin sources; see
  [GitHub Pull Request Handling](#github-pull-request-handling).
- Authoring questions (manifest schema, host API, permissions, templates, packing)
  are answered by the host documentation, not by this repository:
  [`docs/plugin-development.md`](https://github.com/vastsa/PI-Desktop/blob/main/docs/plugin-development.md).

## Commands

No package.json / npm at the repository root. Tooling is Python 3 (stdlib only).
`website/` is a separate Next.js app with its own `pnpm` setup.

| Action | Command |
|---|---|
| Security preflight (mandatory) | `python3 scripts/security_audit.py --check-packages` |
| Refresh catalog + packages from the center | `python3 scripts/sync_catalog.py [--dry-run]` |
| Run all tests | `python3 -m unittest discover -s tests -p 'test_*.py' -v` |
| Run one test | `python3 -m unittest tests.test_security_audit -v` |
| Audit an external source tree (optional) | `python3 scripts/security_audit.py /path/to/plugin-dir` |
| Website build (optional) | `cd website && pnpm install --ignore-scripts && pnpm build` |

No linter/formatter is configured.

## Catalog And Packages

- `catalog.json` is generated output. **Never hand-edit it.** Refresh it with
  `scripts/sync_catalog.py`, which stages the center's catalog and packages in a temp
  directory, rejects an empty or shrinking-to-zero catalog, and only then replaces
  `catalog.json` + `packages/`.
- `packages/*.piplug` are immutable published artifacts. Never repack, patch or
  rename one in place; the preflight fails when a package's filename, manifest or
  contents disagree.
- The catalog keeps a single `versions` entry per plugin and its `shasum` must match
  the package bytes.
- A `.piplug` is a store-compressed zip; a generic zip is rejected by the installer.

## Security Review (Mandatory)

Read [SECURITY.md](SECURITY.md) before touching anything under `packages/` or
`catalog.json`. Plugins run with user-local privileges; never approve a backdoor,
hidden data exfiltration, credential theft, remote code loading, unexplained
obfuscation, persistence, security-control changes, or destructive behavior without
explicit user confirmation.

- Run `python3 scripts/security_audit.py --check-packages` and resolve every
  blocker. The script is a fail-closed preflight over every shipped package; its
  manual-review signals do not constitute approval.
- Source review is performed by the plugin center against the tagged source and the
  packed artifact. This repository only distributes what that review approved.
- High-risk capabilities (filesystem writes/deletes, network, credentials, native
  code, shell/PTY, SSH, background services, prompt injection, desktop control)
  require two independent maintainer reviews, negative-path tests and a recorded
  capability/data-flow review.
- Any change to a package's permissions, contributions or file set must be
  re-published through the center; never hand-carried into `packages/`.

## Plugin Manifest Reference

Needed when auditing a package or reviewing a catalog entry. Every `manifest.json`
**must** include:

- `schemaVersion`, `id`, `name`, `version`, `description`
- `i18n` with at least `en` and `zh-CN`, each carrying a non-empty `name`,
  `description` and `safetyNotes`
- `author`
- `main` — always `main.js`
- `permissions` — minimal set
- `engines.piDesktop` — minimum host version

Recommended: `ui.title` as `{"en": ..., "zh-CN": ...}` (a half-translated title is
refused by the host), `categories`, `changelog`, `contributes.commands` /
`contributes.agentTools` / `contributes.settings`.

Permission table and the 46px panel drag-band contract live in
[CONTRIBUTING.md](CONTRIBUTING.md); the normative contract is the host's
[`docs/spec/07-plugins`](https://github.com/vastsa/PI-Desktop/tree/main/docs/spec/07-plugins).

Agent tools are exposed with the forced prefix `plugin_<id_safe>_<tool>`.

## Tests

`tests/test_*.py` use `unittest` and cover the repository's own scripts:

- `test_security_audit.py` — static blockers, manifest/package checks and a shipped
  package passing the preflight. Fixtures must be created in temp directories.
- `test_sync_catalog.py` — catalog validation, staging and fail-closed rollback.

There are no plugin source tests here any more; plugin tests live with the plugin,
in its own repository.

## Commit Format

```text
type(scope): description
```

Allowed types:

```text
feat fix docs test chore refactor perf build ci
```

Scope is the affected area, for example `catalog`, `security-audit`, `website`,
`docs`. Requirements: English only, concise and imperative, one logical change per
commit.

## GitHub Issue Handling

When the user provides a GitHub issue URL (or an unambiguous issue number for this
repository), treat it as an intake gate. Do not start implementation until the
reported problem has been independently verified.

1. Fetch the issue (title, body, labels, comments, and state).
2. Decide whether the claim is real against this repository:
   - a package/catalog/website/script defect: reproduce it, or show concrete
     evidence that it exists;
   - a plugin behavior bug or an authoring question: out of scope here — the
     plugin's own repository and the plugin center own it.
3. If the problem does **not** exist, or is out of scope: comment with verification
   evidence and the correct destination (`https://plugins.aiuo.net` for plugin
   issues), then close when the conclusion is clear.
4. If the problem does exist and is in scope: implement the smallest coherent fix,
   commit, then comment and close.
5. Write the issue comment in the issue's language. Repository code, docs, and
   commits stay English.
6. An issue link authorizes commenting on and closing **that** issue. It does not
   authorize a git push.

## GitHub Pull Request Handling

This repository no longer accepts plugin sources, so the default outcome for a PR
that adds `plugins/<id>/` is **close, do not merge**.

1. Fetch the pull request (title, body, files, commits, comments, checks).
2. Classify it:
   - **adds plugin sources or hand-edits `catalog.json`** — do not merge. Comment
     with the publish path (build the plugin in your own repository, tag it, bind the
     repository and submit the version at [plugins.aiuo.net](https://plugins.aiuo.net),
     or run the publishing skill `https://plugins.aiuo.net/skill.md` over MCP), keep
     the contributor's branch intact, and close.
   - **fixes the distribution side** (package, catalog data, scripts, tests, website,
     docs) — review the principle first; if it is sound, merge **that** pull request,
     preserving commits. Completeness gaps are follow-up after merge.
   - **has a harm blocker** — do not merge; comment with evidence.
3. Never silently reimplement a contributor's work.
4. Write the pull request comment in the pull request's language. Repository code,
   docs, and commits stay English.
5. A pull request link authorizes reviewing, commenting on, and closing or merging
   **that** pull request. It does not authorize force-push or publishing unrelated
   work.

## Completion Checklist

Before reporting done:

- [ ] `python3 scripts/security_audit.py --check-packages` passes with zero blockers
- [ ] `python3 -m unittest discover -s tests -p 'test_*.py' -v` passes (or a test was added)
- [ ] `catalog.json` was not hand-edited; package files were not modified in place
- [ ] `plugins/` was not recreated and no plugin source was added
- [ ] No dangling references to removed scripts (`pack_plugin.py`,
      `rebuild_catalog.py`) or to `plugins/` remain in docs, website, tests or CI
- [ ] No secrets, local data, or unrelated changes are included
- [ ] All logical changes committed with conventional format
- [ ] Remote publishing only if explicitly requested

## Final Report

Report:

- What changed (files, and the plugin/catalog entries affected)
- Audit result (blockers) and the package/catalog delta
- Test result
- Commit hash and message
- Push target and result, or confirmation that nothing was pushed
