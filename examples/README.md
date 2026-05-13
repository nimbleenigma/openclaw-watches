# Examples

Copy-paste commands for common OpenClaw Watches workflows.

## Model Availability

Tell me when a model appears:

```text
/watch models openai/gpt-5.5 until available
```

Check less often and expire after a day:

```text
/watch models openai/gpt-5.5 until available every 30m for 1d
```

## URL Watches

Tell me when a page changes:

```text
/watch url https://example.com/releases changed every 10m for 6h
```

Tell me when the readable text of a page changes:

```text
/watch url https://example.com/releases text changed every 10m for 6h
```

Tell me when a page contains text:

```text
/watch url https://example.com/status contains "ready" every 5m for 2h
```

Tell me when a page matches a regex:

```text
/watch url https://example.com/downloads text matches "v\\d+\\.\\d+\\.\\d+" every 15m for 1d
```

## GitHub Pull Requests

Tell me when checks pass:

```text
/watch github pr openclaw/openclaw#123 until checks pass every 10m for 1d
```

Tell me when checks fail:

```text
/watch github pr openclaw/openclaw#123 until checks fail every 10m for 1d
```

Tell me when a pull request gets merged:

```text
/watch github pr openclaw/openclaw#123 until merged every 15m for 2d
```

Tell me when review state changes:

```text
/watch github pr openclaw/openclaw#123 until approved every 15m for 2d
/watch github pr openclaw/openclaw#123 until changes requested every 15m for 2d
```

## Management

List active watches:

```text
/watches
```

Show detailed status and recent events:

```text
/watches show <watch-id>
```

Summarize watch health and scheduler pressure:

```text
/watches health
```

Cancel a watch:

```text
/watches cancel <watch-id>
```

## Notes

- GitHub PR watches work unauthenticated for public repositories. Set the
  configured `githubTokenEnv` variable for private repositories or higher rate
  limits.
- URL watches fetch text only; they do not run browser-rendered JavaScript.
- Watches stop when they trigger or expire.
