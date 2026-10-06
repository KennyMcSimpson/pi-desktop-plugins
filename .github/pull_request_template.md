<!--
This repository distributes the published catalog and packages. It does NOT accept
plugin sources: a pull request that adds `plugins/<id>/` is closed with a pointer to
the plugin center.

Publish a plugin at https://plugins.aiuo.net instead:
  1. keep the source in your own repository and tag the version
  2. bind that repository to the plugin in the console (My Plugins → Create plugin)
  3. submit the version, or run the publishing skill https://plugins.aiuo.net/skill.md

Fixing something on the distribution side (package, catalog entry, script, test,
website, docs)? Continue below.
-->

## What this changes

<!-- package, catalog entry, script, test, website or docs -->

## Checks

- [ ] `python3 scripts/security_audit.py --check-packages` passes with zero blockers
- [ ] `python3 -m unittest discover -s tests -p 'test_*.py' -v` passes
- [ ] `catalog.json` was refreshed with `scripts/sync_catalog.py`, not edited by hand
- [ ] no plugin source tree (`plugins/`) was added
