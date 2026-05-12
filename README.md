# OpenClaw Watches

Ephemeral watches for OpenClaw chats.

Watches are short-lived sentries scoped to the originating requester/session.
They poll a target, notify the captured chat when the condition becomes true,
then stop. They are meant for quick "tell me when..." workflows, not permanent
monitoring.

## What It Can Watch

- Model availability: `/watch models openai/gpt-5.5 until available`
- URL text: `/watch url https://example.com contains "ready"`
- URL changes: `/watch url https://example.com/releases changed`
- URL page-text changes: `/watch url https://example.com/releases text changed`
- URL regex: `/watch url https://example.com text matches "v\\d+\\.\\d+"`
- GitHub PR checks passed or failed
- GitHub PR merged
- GitHub PR approved
- GitHub PR changes requested
- GitHub PR snapshot changed

Schedule suffixes are optional:

```text
/watch url https://example.com/releases changed every 5m for 6h
/watch github pr openclaw/openclaw#123 until checks pass every 10m for 1d
```

More copy-paste examples live in [examples/README.md](examples/README.md).

## Management Commands

```text
/watches
/watches all
/watches health
/watches show <watch-id>
/watches cancel <watch-id>
```

`/watches show <watch-id>` includes the watch source, condition, schedule,
last result, error count, and recent event history.

`/watches health` summarizes owner-scoped watch health and scheduler pressure:
active counts, status/type breakdowns, due and overdue checks, stale leases,
cooldowns, delivered notifications, and recent failures.

## Install

This repository is an OpenClaw plugin root. Install it into another OpenClaw
install from a local checkout or Git URL:

```bash
openclaw plugins install ./openclaw-watches
# or install from GitHub:
openclaw plugins install git:github.com/nimbleenigma/openclaw-watches
openclaw gateway restart
openclaw plugins inspect watches --runtime --json
```

The repository ships TypeScript source and built JavaScript runtime files under
`dist/`. OpenClaw package installs load the built runtime; source checkouts inside
the OpenClaw monorepo can still use the TypeScript entry directly.

For source-checkout development inside the OpenClaw monorepo, place the folder
at:

```text
extensions/watches
```

Then run the focused checks from the OpenClaw repo root:

```bash
pnpm exec vitest run \
  extensions/watches/index.test.ts \
  extensions/watches/src/parse.test.ts \
  extensions/watches/src/management.test.ts \
  extensions/watches/src/evaluate.test.ts \
  extensions/watches/src/check-github.test.ts \
  extensions/watches/src/tool.test.ts \
  extensions/watches/src/commands.test.ts \
  extensions/watches/src/store.sqlite.test.ts \
  extensions/watches/src/scheduler.test.ts
pnpm tsgo:extensions
```

## Config

All config is optional. Defaults are intentionally conservative.

```json
{
  "plugins": {
    "entries": {
      "watches": {
        "enabled": true,
        "config": {
          "maxActivePerOwner": 20,
          "defaultIntervalSeconds": 900,
          "defaultExpiryHours": 24,
          "githubTokenEnv": "GITHUB_TOKEN"
        }
      }
    }
  }
}
```

Config fields:

- `maxActivePerOwner`: active watch limit per requester. Default `20`.
- `defaultIntervalSeconds`: polling interval for watches without an `every`
  suffix. Default `900` seconds.
- `defaultExpiryHours`: expiry for watches without a `for` suffix. Default
  `24` hours.
- `githubTokenEnv`: environment variable name to read for GitHub API auth.
  Default `GITHUB_TOKEN`; no token is stored in watch state or notifications.

Per-watch schedule suffixes are bounded to 60 seconds through 24 hours for the
interval, and 1 hour through 7 days for expiry.

## Runtime Notes

- State lives in OpenClaw's plugin state directory as
  `watches/watches.sqlite`.
- URL watches use bounded safe HTTP/HTTPS fetches with SSRF guardrails. They do
  not render JavaScript.
- URL `text changed` watches strip obvious HTML chrome such as scripts, styles,
  headers, footers, navigation, and narrow volatile timestamp/hash lines before
  hashing, which makes them quieter than raw `changed` watches for ordinary HTML
  pages.
- GitHub PR watches use the GitHub API. Public repositories work without auth.
  For private repositories or higher rate limits, set the configured
  `githubTokenEnv` variable in the OpenClaw gateway environment.
- Notifications go back to the originating OpenClaw chat/session target.
- The plugin requires an OpenClaw runtime with plugin services, runtime slash
  commands, `watches_manage` agent tools, `notifyCapturedTarget`, and
  `node:sqlite` support.

## Reporting Issues

When reporting bugs, include your OpenClaw version, install method, watch command,
expected result, actual result, and redacted logs. GitHub PR watches currently
support optional GitHub token auth through an environment variable; redact token
names and values from reports unless they are generic names like `GITHUB_TOKEN`.

## Current Rough Edges

- URL watches are text-only and do not run browser-rendered pages.
- Watches are intentionally ephemeral; this is not a replacement for a durable
  monitoring system.
- ClawHub/npm publishing would need a final package/release pass.

## Development and Packaging Notes

- `openclaw.plugin.json` is the plugin manifest OpenClaw uses for discovery.
- `package.json` keeps `openclaw.extensions` pointed at `./index.ts` for source
  checkout development.
- `dist/index.js` and `dist/api.js` are committed so Git/package installs can
  load the plugin without a local TypeScript build step.
- Before release-style sharing, run a clean install smoke test with
  `openclaw plugins install <path-or-git-url>`.
