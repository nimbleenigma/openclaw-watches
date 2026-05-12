import { formatGitHubPrRef, parseGitHubPrRef } from "./github-pr.js";
import { parseWatchRegex } from "./regex.js";
import type {
  GitHubPrWatchSource,
  ModelWatchSource,
  UrlWatchSource,
  WatchCondition,
  WatchKind,
  WatchScheduleSpec,
} from "./types.js";

export type ParsedWatchCommand =
  | { action: "help" }
  | { action: "cancel"; id: string }
  | { action: "show"; id: string }
  | {
      action: "create";
      kind: WatchKind;
      source: ModelWatchSource | UrlWatchSource | GitHubPrWatchSource;
      condition: WatchCondition;
      schedule?: WatchScheduleSpec;
      title: string;
    }
  | { action: "error"; message: string };

export type ParsedWatchesCommand =
  | { action: "list"; includeAll: boolean }
  | { action: "show"; id: string }
  | { action: "cancel"; id: string }
  | { action: "health" }
  | { action: "help" }
  | { action: "error"; message: string };

export const MAX_CONDITION_TEXT_CHARS = 512;
export const MAX_MODEL_QUERY_CHARS = 128;
type UrlContentMode = NonNullable<UrlWatchSource["contentMode"]>;
const DURATION_PATTERN = String.raw`\d+(?:\.\d+)?\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)`;

function trimCommandArgs(args?: string): string {
  return args?.trim() ?? "";
}

function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === `"` && last === `"`) || (first === `'` && last === `'`)) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function splitFirstToken(value: string): { token: string; rest: string } {
  const trimmed = value.trim();
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  return {
    token: match?.[1] ?? "",
    rest: match?.[2]?.trim() ?? "",
  };
}

function parseDurationMs(value: string): number | undefined {
  const match =
    /^\s*(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\s*$/i.exec(
      value,
    );
  if (!match) {
    return undefined;
  }
  const amount = Number.parseFloat(match[1] ?? "");
  if (!Number.isFinite(amount) || amount <= 0) {
    return undefined;
  }
  const unit = (match[2] ?? "").toLowerCase();
  if (unit.startsWith("s")) {
    return Math.round(amount * 1000);
  }
  if (unit.startsWith("m") && unit !== "month" && unit !== "months") {
    return Math.round(amount * 60_000);
  }
  if (unit.startsWith("h")) {
    return Math.round(amount * 3_600_000);
  }
  if (unit.startsWith("d")) {
    return Math.round(amount * 86_400_000);
  }
  return undefined;
}

function extractScheduleSuffix(value: string): { text: string; schedule?: WatchScheduleSpec } {
  let text = value.trim();
  const schedule: WatchScheduleSpec = {};
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (schedule.expiryMs == null) {
      const forMatch = new RegExp(String.raw`\s+for\s+(${DURATION_PATTERN})\s*$`, "i").exec(text);
      if (forMatch) {
        const expiryMs = parseDurationMs(forMatch[1] ?? "");
        if (expiryMs != null) {
          schedule.expiryMs = expiryMs;
          text = text.slice(0, forMatch.index).trim();
          continue;
        }
      }
    }
    if (schedule.intervalSeconds == null) {
      const everyMatch = new RegExp(String.raw`\s+every\s+(${DURATION_PATTERN})\s*$`, "i").exec(
        text,
      );
      if (everyMatch) {
        const intervalMs = parseDurationMs(everyMatch[1] ?? "");
        if (intervalMs != null) {
          schedule.intervalSeconds = Math.round(intervalMs / 1000);
          text = text.slice(0, everyMatch.index).trim();
          continue;
        }
      }
    }
  }
  return Object.keys(schedule).length > 0 ? { text, schedule } : { text };
}

function parseUrlContentMode(value: string): {
  contentMode: UrlContentMode;
  conditionText: string;
} {
  let conditionText = value.trim();
  let contentMode: UrlContentMode = "raw";
  if (/^text\s+/i.test(conditionText)) {
    conditionText = conditionText.replace(/^text\s+/i, "").trim();
    contentMode = "text";
  }
  if (/\s+text$/i.test(conditionText)) {
    const candidate = conditionText.replace(/\s+text$/i, "").trim();
    const hasQuotedCondition =
      /^(contains|matches)\s+(["'])([\s\S]*)\2$/i.test(candidate) || /^changed$/i.test(candidate);
    if (hasQuotedCondition) {
      conditionText = candidate;
      contentMode = "text";
    }
  }
  return { contentMode, conditionText };
}

function titlePrefixForUrl(contentMode: UrlContentMode): string {
  return contentMode === "text" ? "URL text" : "URL";
}

function createUrlSource(url: string, contentMode: UrlContentMode): UrlWatchSource {
  return contentMode === "text" ? { url, contentMode } : { url };
}

export function parseProviderModel(query: string): ModelWatchSource {
  const trimmed = query.trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex > 0 && slashIndex < trimmed.length - 1) {
    return {
      query: trimmed,
      provider: trimmed.slice(0, slashIndex).trim(),
      model: trimmed.slice(slashIndex + 1).trim(),
    };
  }
  return { query: trimmed, model: trimmed };
}

function parseModelWatch(rest: string): ParsedWatchCommand {
  const scheduled = extractScheduleSuffix(rest);
  const untilMatch = /\s+until\s+available\s*$/i.exec(scheduled.text);
  if (!untilMatch) {
    return {
      action: "error",
      message: "Usage: /watch models <model> until available [every 15m] [for 24h]",
    };
  }
  const query = scheduled.text.slice(0, untilMatch.index).trim();
  if (!query) {
    return {
      action: "error",
      message: "Usage: /watch models <model> until available [every 15m] [for 24h]",
    };
  }
  if (query.length > MAX_MODEL_QUERY_CHARS) {
    return { action: "error", message: "Model watch query is too long." };
  }
  const source = parseProviderModel(query);
  return {
    action: "create",
    kind: "model",
    source,
    condition: { type: "available" },
    ...(scheduled.schedule ? { schedule: scheduled.schedule } : {}),
    title: `Model available: ${query}`,
  };
}

function parseUrlWatch(rest: string): ParsedWatchCommand {
  const first = splitFirstToken(rest);
  if (!first.token) {
    return { action: "error", message: 'Usage: /watch url <url> contains "<text>"' };
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(first.token);
  } catch {
    return { action: "error", message: "Watch URL must be a valid http or https URL." };
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return { action: "error", message: "Watch URL must use http or https." };
  }
  const scheduled = extractScheduleSuffix(first.rest);
  const { contentMode, conditionText } = parseUrlContentMode(scheduled.text);
  const source = createUrlSource(parsedUrl.toString(), contentMode);
  if (/^changed$/i.test(conditionText)) {
    return {
      action: "create",
      kind: "url",
      source,
      condition: { type: "changed" },
      ...(scheduled.schedule ? { schedule: scheduled.schedule } : {}),
      title: `${titlePrefixForUrl(contentMode)} changed: ${parsedUrl.toString()}`,
    };
  }
  const matchesMatch = /^matches\s+([\s\S]+)$/i.exec(conditionText);
  if (matchesMatch) {
    const rawPattern = stripMatchingQuotes(matchesMatch[1] ?? "");
    const parsedRegex = parseWatchRegex(rawPattern);
    if (!parsedRegex.ok) {
      return { action: "error", message: parsedRegex.message };
    }
    return {
      action: "create",
      kind: "url",
      source,
      condition: {
        type: "matches",
        pattern: parsedRegex.pattern,
        flags: parsedRegex.flags,
      },
      ...(scheduled.schedule ? { schedule: scheduled.schedule } : {}),
      title: `${titlePrefixForUrl(contentMode)} matches: /${parsedRegex.pattern}/${
        parsedRegex.flags
      }`,
    };
  }
  const containsMatch = /^contains\s+([\s\S]+)$/i.exec(conditionText);
  if (!containsMatch) {
    return { action: "error", message: 'Usage: /watch url <url> contains "<text>"' };
  }
  const text = stripMatchingQuotes(containsMatch[1] ?? "");
  if (!text) {
    return { action: "error", message: "Contains watch text cannot be empty." };
  }
  if (text.length > MAX_CONDITION_TEXT_CHARS) {
    return { action: "error", message: "Contains watch text is too long." };
  }
  return {
    action: "create",
    kind: "url",
    source,
    condition: { type: "contains", text, caseSensitive: false },
    ...(scheduled.schedule ? { schedule: scheduled.schedule } : {}),
    title: `${titlePrefixForUrl(contentMode)} contains: ${text}`,
  };
}

function githubPrUsage(): string {
  return "Usage: /watch github pr <url|owner/repo#number> until checks pass|fail|merged|approved|changes requested";
}

function parseGitHubWatch(rest: string): ParsedWatchCommand {
  const target = splitFirstToken(rest);
  if (target.token.toLowerCase() !== "pr") {
    return { action: "error", message: githubPrUsage() };
  }
  const ref = splitFirstToken(target.rest);
  if (!ref.token) {
    return { action: "error", message: githubPrUsage() };
  }
  const source = parseGitHubPrRef(ref.token);
  if (!source) {
    return {
      action: "error",
      message:
        "GitHub PR must be a https://github.com/<owner>/<repo>/pull/<number> URL or owner/repo#number.",
    };
  }
  const scheduled = extractScheduleSuffix(ref.rest);
  const conditionText = scheduled.text.trim();
  const label = formatGitHubPrRef(source);
  if (/^until\s+(?:checks|ci)\s+pass(?:es)?$/i.test(conditionText)) {
    return {
      action: "create",
      kind: "github_pr",
      source,
      condition: { type: "github_pr_checks_pass" },
      ...(scheduled.schedule ? { schedule: scheduled.schedule } : {}),
      title: `PR checks: ${label}`,
    };
  }
  if (/^until\s+(?:checks|ci)\s+fail(?:s)?$/i.test(conditionText)) {
    return {
      action: "create",
      kind: "github_pr",
      source,
      condition: { type: "github_pr_checks_fail" },
      ...(scheduled.schedule ? { schedule: scheduled.schedule } : {}),
      title: `PR checks failing: ${label}`,
    };
  }
  if (/^until\s+merged$/i.test(conditionText)) {
    return {
      action: "create",
      kind: "github_pr",
      source,
      condition: { type: "github_pr_merged" },
      ...(scheduled.schedule ? { schedule: scheduled.schedule } : {}),
      title: `PR merged: ${label}`,
    };
  }
  if (/^until\s+(?:review\s+)?approved$/i.test(conditionText)) {
    return {
      action: "create",
      kind: "github_pr",
      source,
      condition: { type: "github_pr_review_approved" },
      ...(scheduled.schedule ? { schedule: scheduled.schedule } : {}),
      title: `PR approved: ${label}`,
    };
  }
  if (/^until\s+(?:review\s+)?changes\s+requested$/i.test(conditionText)) {
    return {
      action: "create",
      kind: "github_pr",
      source,
      condition: { type: "github_pr_review_changes_requested" },
      ...(scheduled.schedule ? { schedule: scheduled.schedule } : {}),
      title: `PR changes requested: ${label}`,
    };
  }
  if (/^changed$/i.test(conditionText)) {
    return {
      action: "create",
      kind: "github_pr",
      source,
      condition: { type: "github_pr_state_changed" },
      ...(scheduled.schedule ? { schedule: scheduled.schedule } : {}),
      title: `PR snapshot: ${label}`,
    };
  }
  return { action: "error", message: githubPrUsage() };
}

export function parseWatchCommand(args?: string): ParsedWatchCommand {
  const trimmed = trimCommandArgs(args);
  if (!trimmed || /^help$/i.test(trimmed)) {
    return { action: "help" };
  }

  const first = splitFirstToken(trimmed);
  const action = first.token.toLowerCase();
  if (action === "cancel") {
    const id = first.rest.trim();
    if (!id) {
      return { action: "error", message: "Usage: /watch cancel <id>" };
    }
    return { action: "cancel", id };
  }
  if (action === "show") {
    const id = first.rest.trim();
    if (!id) {
      return { action: "error", message: "Usage: /watch show <id>" };
    }
    return { action: "show", id };
  }
  if (action === "models" || action === "model") {
    return parseModelWatch(first.rest);
  }
  if (action === "url") {
    return parseUrlWatch(first.rest);
  }
  if (action === "github") {
    return parseGitHubWatch(first.rest);
  }
  return { action: "error", message: "Usage: /watch models <model> until available" };
}

export function parseWatchesCommand(args?: string): ParsedWatchesCommand {
  const trimmed = trimCommandArgs(args);
  if (!trimmed) {
    return { action: "list", includeAll: false };
  }
  if (/^help$/i.test(trimmed)) {
    return { action: "help" };
  }
  if (/^all$/i.test(trimmed)) {
    return { action: "list", includeAll: true };
  }
  if (/^health$/i.test(trimmed)) {
    return { action: "health" };
  }
  const first = splitFirstToken(trimmed);
  const action = first.token.toLowerCase();
  if (action === "show") {
    const id = first.rest.trim();
    return id ? { action: "show", id } : { action: "error", message: "Usage: /watches show <id>" };
  }
  if (action === "cancel") {
    const id = first.rest.trim();
    return id
      ? { action: "cancel", id }
      : { action: "error", message: "Usage: /watches cancel <id>" };
  }
  return { action: "error", message: "Usage: /watches [all|health|show <id>|cancel <id>]" };
}
