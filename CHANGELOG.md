# Changelog

All notable changes to this project are documented here.

## 0.1.1 - 2026-05-10

### Added

- Optional GitHub token authentication for PR watches through the configured
  `githubTokenEnv` environment variable.

### Changed

- GitHub PR watch docs now cover public unauthenticated mode and private or
  higher-rate-limit token mode.

## 0.1.0 - 2026-05-10

Initial public-ready beta.

### Added

- Ephemeral model availability watches.
- URL text, change, and regex watches.
- GitHub pull request watches for checks passed, checks failed, merged,
  approved, changes requested, and snapshot changed.
- Per-watch schedule suffixes, for example `every 5m for 6h`.
- `/watch` and `/watches` slash commands.
- `watches_manage` agent tool.
- SQLite-backed local state under the OpenClaw plugin state directory.
- Safe bounded URL fetching with SSRF guardrails.
- Standalone package metadata and built runtime files for external OpenClaw
  installs.

### Compatibility

- Requires OpenClaw `2026.5.10-beta.1` or newer.
- Uses `node:sqlite`; run on a Node.js build that includes it.

### Known Limitations

- GitHub private repository support requires a token exposed through the
  configured `githubTokenEnv` variable.
- URL watches fetch text only and do not render JavaScript.
- Watches are intentionally short-lived and are not a durable monitoring system.
