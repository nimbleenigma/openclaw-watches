import { createHash } from "node:crypto";
import { compileWatchRegex } from "./regex.js";
import type { WatchCondition } from "./types.js";

export function hashWatchResult(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function truncateSummary(value: string, maxChars = 500): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function evaluateTextCondition(params: {
  condition: WatchCondition;
  text: string;
  hashText?: string;
  previousHash?: string;
}): { triggered: boolean; resultHash: string; summary: string } {
  const resultHash = hashWatchResult(params.hashText ?? params.text);
  switch (params.condition.type) {
    case "changed": {
      if (!params.previousHash) {
        return {
          triggered: false,
          resultHash,
          summary: "Baseline captured.",
        };
      }
      return {
        triggered: params.previousHash !== resultHash,
        resultHash,
        summary:
          params.previousHash !== resultHash
            ? "Content changed since the baseline."
            : "No content change detected.",
      };
    }
    case "contains": {
      const haystack = params.condition.caseSensitive ? params.text : params.text.toLowerCase();
      const needle = params.condition.caseSensitive
        ? params.condition.text
        : params.condition.text.toLowerCase();
      const matched = haystack.includes(needle);
      return {
        triggered: matched,
        resultHash,
        summary: matched
          ? `Matched text: ${params.condition.text}`
          : `Text not found: ${params.condition.text}`,
      };
    }
    case "matches": {
      const regex = compileWatchRegex(params.condition.pattern, params.condition.flags);
      const matched = regex.test(params.text);
      const label = `/${params.condition.pattern}/${params.condition.flags}`;
      return {
        triggered: matched,
        resultHash,
        summary: matched ? `Matched regex: ${label}` : `Regex not matched: ${label}`,
      };
    }
    case "available":
      return {
        triggered: false,
        resultHash,
        summary: "Availability conditions are evaluated by model checks.",
      };
    case "github_pr_checks_pass":
    case "github_pr_checks_fail":
    case "github_pr_merged":
    case "github_pr_review_approved":
    case "github_pr_review_changes_requested":
    case "github_pr_state_changed":
      return {
        triggered: false,
        resultHash,
        summary: "GitHub PR conditions are evaluated by GitHub checks.",
      };
  }
  return {
    triggered: false,
    resultHash,
    summary: "Unsupported condition.",
  };
}
