import { describe, expect, it } from "vitest";
import { parseWatchCommand, parseWatchesCommand } from "./parse.js";

describe("watch command parser", () => {
  it("parses model availability watches", () => {
    expect(parseWatchCommand("models openai/gpt-5.5 until available")).toEqual({
      action: "create",
      kind: "model",
      source: { query: "openai/gpt-5.5", provider: "openai", model: "gpt-5.5" },
      condition: { type: "available" },
      title: "Model available: openai/gpt-5.5",
    });
  });

  it("parses URL contains watches", () => {
    expect(parseWatchCommand('url https://example.com contains "GPT-5.5 API"')).toEqual({
      action: "create",
      kind: "url",
      source: { url: "https://example.com/" },
      condition: { type: "contains", text: "GPT-5.5 API", caseSensitive: false },
      title: "URL contains: GPT-5.5 API",
    });
  });

  it("parses URL changed watches", () => {
    expect(parseWatchCommand("url https://example.com/announcements changed")).toMatchObject({
      action: "create",
      kind: "url",
      source: { url: "https://example.com/announcements" },
      condition: { type: "changed" },
    });
  });

  it("parses per-watch schedule suffixes", () => {
    expect(
      parseWatchCommand("models openai/gpt-5.5 until available every 5m for 6h"),
    ).toMatchObject({
      action: "create",
      schedule: { intervalSeconds: 300, expiryMs: 21_600_000 },
    });
    expect(
      parseWatchCommand('url https://example.com contains "ready" for 2h every 10m'),
    ).toMatchObject({
      action: "create",
      schedule: { intervalSeconds: 600, expiryMs: 7_200_000 },
      condition: { type: "contains", text: "ready" },
    });
  });

  it("parses URL page-text mode variants", () => {
    expect(parseWatchCommand("url https://example.com text changed")).toMatchObject({
      action: "create",
      kind: "url",
      source: { url: "https://example.com/", contentMode: "text" },
      condition: { type: "changed" },
      title: "URL text changed: https://example.com/",
    });
    expect(parseWatchCommand('url https://example.com contains "GPT-5.5 API" text')).toMatchObject({
      action: "create",
      kind: "url",
      source: { contentMode: "text" },
      condition: { type: "contains", text: "GPT-5.5 API" },
      title: "URL text contains: GPT-5.5 API",
    });
    expect(parseWatchCommand('url https://example.com text matches "GPT-5\\.5"')).toMatchObject({
      action: "create",
      kind: "url",
      source: { contentMode: "text" },
      condition: { type: "matches", pattern: "GPT-5\\.5" },
      title: "URL text matches: /GPT-5\\.5/i",
    });
  });

  it("keeps unquoted raw URL conditions ending in text compatible", () => {
    expect(parseWatchCommand("url https://example.com contains text")).toMatchObject({
      action: "create",
      kind: "url",
      source: { url: "https://example.com/" },
      condition: { type: "contains", text: "text" },
      title: "URL contains: text",
    });
    expect(parseWatchCommand("url https://example.com matches text")).toMatchObject({
      action: "create",
      kind: "url",
      source: { url: "https://example.com/" },
      condition: { type: "matches", pattern: "text" },
      title: "URL matches: /text/i",
    });
  });

  it("parses URL regex watches", () => {
    expect(parseWatchCommand('url https://example.com matches "GPT-5\\.5\\s+API"')).toEqual({
      action: "create",
      kind: "url",
      source: { url: "https://example.com/" },
      condition: { type: "matches", pattern: "GPT-5\\.5\\s+API", flags: "i" },
      title: "URL matches: /GPT-5\\.5\\s+API/i",
    });
    expect(parseWatchCommand('url https://example.com matches "/GPT-5\\.5/m"')).toEqual({
      action: "create",
      kind: "url",
      source: { url: "https://example.com/" },
      condition: { type: "matches", pattern: "GPT-5\\.5", flags: "m" },
      title: "URL matches: /GPT-5\\.5/m",
    });
  });

  it("parses GitHub PR checks and changed watches", () => {
    expect(
      parseWatchCommand(
        "github pr https://github.com/openclaw/openclaw/pull/123 until checks pass",
      ),
    ).toEqual({
      action: "create",
      kind: "github_pr",
      source: {
        owner: "openclaw",
        repo: "openclaw",
        number: 123,
        url: "https://github.com/openclaw/openclaw/pull/123",
        query: "openclaw/openclaw#123",
      },
      condition: { type: "github_pr_checks_pass" },
      title: "PR checks: openclaw/openclaw#123",
    });
    expect(parseWatchCommand("github pr openclaw/openclaw#123 changed")).toMatchObject({
      action: "create",
      kind: "github_pr",
      source: {
        owner: "openclaw",
        repo: "openclaw",
        number: 123,
      },
      condition: { type: "github_pr_state_changed" },
      title: "PR snapshot: openclaw/openclaw#123",
    });
    expect(parseWatchCommand("github pr openclaw/openclaw#123 until checks fail")).toMatchObject({
      action: "create",
      condition: { type: "github_pr_checks_fail" },
      title: "PR checks failing: openclaw/openclaw#123",
    });
    expect(parseWatchCommand("github pr openclaw/openclaw#123 until merged")).toMatchObject({
      action: "create",
      condition: { type: "github_pr_merged" },
      title: "PR merged: openclaw/openclaw#123",
    });
    expect(parseWatchCommand("github pr openclaw/openclaw#123 until approved")).toMatchObject({
      action: "create",
      condition: { type: "github_pr_review_approved" },
      title: "PR approved: openclaw/openclaw#123",
    });
    expect(
      parseWatchCommand("github pr openclaw/openclaw#123 until changes requested"),
    ).toMatchObject({
      action: "create",
      condition: { type: "github_pr_review_changes_requested" },
      title: "PR changes requested: openclaw/openclaw#123",
    });
  });

  it("rejects invalid GitHub PR references clearly", () => {
    expect(
      parseWatchCommand("github pr https://example.com/openclaw/openclaw/pull/1 changed"),
    ).toMatchObject({
      action: "error",
      message: expect.stringContaining("GitHub PR must be"),
    });
    expect(parseWatchCommand("github pr openclaw/openclaw changed")).toMatchObject({
      action: "error",
      message: expect.stringContaining("GitHub PR must be"),
    });
  });

  it("rejects invalid regex watches clearly", () => {
    expect(parseWatchCommand('url https://example.com matches "[unterminated"')).toMatchObject({
      action: "error",
      message: expect.stringContaining("Regex pattern is invalid"),
    });
    expect(parseWatchCommand('url https://example.com matches "/hello/g"')).toEqual({
      action: "error",
      message: "Regex flags can only include i and m.",
    });
  });

  it("parses cancel, show, and list flags", () => {
    expect(parseWatchCommand("cancel w_123")).toEqual({ action: "cancel", id: "w_123" });
    expect(parseWatchCommand("show w_123")).toEqual({ action: "show", id: "w_123" });
    expect(parseWatchesCommand("all")).toEqual({ action: "list", includeAll: true });
    expect(parseWatchesCommand("")).toEqual({ action: "list", includeAll: false });
    expect(parseWatchesCommand("show w_123")).toEqual({ action: "show", id: "w_123" });
    expect(parseWatchesCommand("cancel w_123")).toEqual({ action: "cancel", id: "w_123" });
  });

  it("rejects unsafe URL schemes", () => {
    expect(parseWatchCommand('url file:///etc/passwd contains "x"')).toEqual({
      action: "error",
      message: "Watch URL must use http or https.",
    });
  });
});
