import { describe, expect, it, vi } from "vitest";
import { checkModelAvailability, findAvailableModel } from "./check-model.js";
import { checkUrlWatch, fetchUrlText, prepareUrlWatchText } from "./check-url.js";
import { evaluateTextCondition, hashWatchResult } from "./evaluate.js";
import type { WatchRecord } from "./types.js";

function createUrlWatch(overrides: Partial<WatchRecord> = {}): WatchRecord {
  return {
    id: "w_test",
    ownerKey: "test",
    title: "URL contains: hello",
    kind: "url",
    source: { url: "https://example.com/" },
    condition: { type: "contains", text: "hello", caseSensitive: false },
    status: "active",
    intervalSeconds: 60,
    nextCheckAt: 1,
    expiresAt: 10_000,
    errorCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function createModelWatch(overrides: Partial<WatchRecord> = {}): WatchRecord {
  return {
    id: "w_model",
    ownerKey: "test",
    title: "Model available: gpt-5.5",
    kind: "model",
    source: { query: "gpt-5.5", model: "gpt-5.5" },
    condition: { type: "available" },
    status: "active",
    intervalSeconds: 60,
    nextCheckAt: 1,
    expiresAt: 10_000,
    errorCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("watch condition evaluation", () => {
  it("captures a baseline before changed URL watches trigger", () => {
    const initial = evaluateTextCondition({
      condition: { type: "changed" },
      text: "alpha",
    });
    expect(initial.triggered).toBe(false);
    const changed = evaluateTextCondition({
      condition: { type: "changed" },
      text: "beta",
      previousHash: initial.resultHash,
    });
    expect(changed.triggered).toBe(true);
  });

  it("keeps changed URL watches quiet for unchanged content", () => {
    const initial = evaluateTextCondition({
      condition: { type: "changed" },
      text: "alpha",
    });
    const unchanged = evaluateTextCondition({
      condition: { type: "changed" },
      text: "alpha",
      previousHash: initial.resultHash,
    });
    expect(unchanged.triggered).toBe(false);
    expect(unchanged.summary).toContain("No content change");
  });

  it("matches URL contains conditions deterministically", () => {
    const result = evaluateTextCondition({
      condition: { type: "contains", text: "GPT-5.5" },
      text: "gpt-5.5 is here",
    });
    expect(result.triggered).toBe(true);
  });

  it("matches URL regex conditions against fetched text", () => {
    const result = evaluateTextCondition({
      condition: { type: "matches", pattern: "GPT-5\\.5\\s+API", flags: "i" },
      text: "The gpt-5.5 api is here",
      hashText: "canonical response",
    });
    expect(result.triggered).toBe(true);
    expect(result.resultHash).toBe(hashWatchResult("canonical response"));
  });
});

describe("model availability checks", () => {
  const catalog = [
    { provider: "openai", id: "gpt-5.4", name: "GPT-5.4" },
    { provider: "openai", id: "gpt-5.5", name: "GPT-5.5" },
  ];

  it("finds available models by normalized model id", () => {
    expect(findAvailableModel(catalog, { query: "GPT-5.5", model: "GPT-5.5" })?.id).toBe("gpt-5.5");
  });

  it("returns a triggered outcome when the catalog contains the watched model", async () => {
    const loadCatalog = vi.fn(async () => catalog);
    const outcome = await checkModelAvailability({
      watch: createModelWatch(),
      cfg: {},
      loadCatalog,
    });
    expect(outcome.triggered).toBe(true);
    expect(outcome.summary).toContain("openai/gpt-5.5");
  });
});

describe("URL checks", () => {
  it("triggers contains watches from bounded text fetches", async () => {
    const fetchImpl = vi.fn(async () => new Response("hello from the page"));
    const outcome = await checkUrlWatch({
      watch: createUrlWatch(),
      timeoutMs: 1000,
      maxBytes: 1024,
      fetchImpl,
    });
    expect(outcome.triggered).toBe(true);
    expect(outcome.resultHash).toBe(
      hashWatchResult("200\nhttps://example.com/\nhello from the page"),
    );
    if (!outcome.triggered) {
      throw new Error("expected URL watch to trigger");
    }
    expect(outcome.notification).toContain("🔎 URL text found");
    expect(outcome.notification).toContain('Matched: "hello"');
    expect(outcome.notification).toContain("Current: hello from the page");
  });

  it("distinguishes missing text from HTTP fetch failures", async () => {
    const missingText = await checkUrlWatch({
      watch: createUrlWatch({ condition: { type: "contains", text: "needle" } }),
      timeoutMs: 1000,
      maxBytes: 1024,
      fetchImpl: vi.fn(async () => new Response("haystack only")),
    });
    expect(missingText.triggered).toBe(false);
    expect(missingText.summary).toContain("Text not found");

    await expect(
      checkUrlWatch({
        watch: createUrlWatch({ condition: { type: "contains", text: "needle" } }),
        timeoutMs: 1000,
        maxBytes: 1024,
        fetchImpl: vi.fn(async () => new Response("Forbidden", { status: 403 })),
      }),
    ).rejects.toThrow("blocked the basic fetch with HTTP 403");
  });

  it("extracts readable page text from HTML in text mode", async () => {
    expect(
      prepareUrlWatchText({
        text: "<main>Release &amp; Notes</main>",
        contentType: "text/html",
        contentMode: "raw",
      }),
    ).toBe("<main>Release &amp; Notes</main>");
    expect(
      prepareUrlWatchText({
        text:
          "<html><head><script>secret()</script><style>p{}</style></head>" +
          "<body><main><h1>Release &amp; Notes</h1><p>GPT-5.5&nbsp;API</p></main></body></html>",
        contentType: "text/html; charset=utf-8",
        contentMode: "text",
      }),
    ).toBe("Release & Notes GPT-5.5 API");

    const outcome = await checkUrlWatch({
      watch: createUrlWatch({
        source: { url: "https://example.com/", contentMode: "text" },
        condition: { type: "contains", text: "Release & Notes GPT-5.5 API" },
        title: "URL text contains: Release & Notes GPT-5.5 API",
      }),
      timeoutMs: 1000,
      maxBytes: 2048,
      fetchImpl: vi.fn(
        async () =>
          new Response(
            "<html><body><main><h1>Release &amp; Notes</h1><script>noise</script><p>GPT-5.5 API</p></main></body></html>",
            { headers: { "content-type": "text/html; charset=utf-8" } },
          ),
      ),
    });

    expect(outcome.triggered).toBe(true);
    expect(outcome.summary).toContain("page text");
  });

  it("summarizes URL fetch timeouts without stack noise", async () => {
    const timeout = Object.assign(new Error("This operation was aborted."), {
      name: "AbortError",
    });
    await expect(
      fetchUrlText({
        url: "https://example.com/",
        timeoutMs: 500,
        maxBytes: 1024,
        fetchImpl: vi.fn(async () => {
          throw timeout;
        }),
      }),
    ).rejects.toThrow("URL fetch timed out after 500ms");
  });

  it("triggers URL changed watches only after a later content hash changes", async () => {
    const baseline = await checkUrlWatch({
      watch: createUrlWatch({
        condition: { type: "changed" },
        title: "URL changed: https://example.com/",
      }),
      timeoutMs: 1000,
      maxBytes: 1024,
      fetchImpl: vi.fn(async () => new Response("alpha")),
    });
    expect(baseline.triggered).toBe(false);
    expect(baseline.summary).toContain("Baseline captured");

    const unchanged = await checkUrlWatch({
      watch: createUrlWatch({
        condition: { type: "changed" },
        title: "URL changed: https://example.com/",
        lastResultHash: baseline.resultHash,
      }),
      timeoutMs: 1000,
      maxBytes: 1024,
      fetchImpl: vi.fn(async () => new Response("alpha")),
    });
    expect(unchanged.triggered).toBe(false);
    expect(unchanged.summary).toContain("No content change");

    const changed = await checkUrlWatch({
      watch: createUrlWatch({
        condition: { type: "changed" },
        title: "URL changed: https://example.com/",
        lastResultHash: baseline.resultHash,
      }),
      timeoutMs: 1000,
      maxBytes: 1024,
      fetchImpl: vi.fn(async () => new Response("beta")),
    });
    expect(changed.triggered).toBe(true);
    expect(changed.summary).toContain("Content changed");
    if (!changed.triggered) {
      throw new Error("expected URL changed watch to trigger");
    }
    expect(changed.notification).toContain("👀 URL changed");
    expect(changed.notification).toContain("Content changed since baseline");
    expect(changed.notification).toContain("Current: beta");
  });

  it("matches URL regex watches from bounded text fetches", async () => {
    const outcome = await checkUrlWatch({
      watch: createUrlWatch({
        condition: { type: "matches", pattern: "GPT-5\\.5\\s+API", flags: "i" },
      }),
      timeoutMs: 1000,
      maxBytes: 1024,
      fetchImpl: vi.fn(async () => new Response("The gpt-5.5 API is live.")),
    });
    expect(outcome.triggered).toBe(true);
    expect(outcome.summary).toContain("Matched regex");
    if (!outcome.triggered) {
      throw new Error("expected URL regex watch to trigger");
    }
    expect(outcome.notification).toContain("🔎 URL regex matched");
  });

  it("rejects non-text URL responses with a concise helpful error", async () => {
    await expect(
      checkUrlWatch({
        watch: createUrlWatch(),
        timeoutMs: 1000,
        maxBytes: 1024,
        fetchImpl: vi.fn(
          async () =>
            new Response(new Uint8Array([1, 2, 3]), {
              headers: { "content-type": "image/png" },
            }),
        ),
      }),
    ).rejects.toThrow("URL response is not text-like content (image/png)");
  });

  it("rejects oversized URL responses", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("too large", {
          headers: { "content-length": "999" },
        }),
    );
    await expect(
      fetchUrlText({
        url: "https://example.com/",
        timeoutMs: 1000,
        maxBytes: 10,
        fetchImpl,
      }),
    ).rejects.toThrow("exceeds");
  });

  it("blocks private-network URL targets before fetch", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope"));
    await expect(
      fetchUrlText({
        url: "http://127.0.0.1/",
        timeoutMs: 1000,
        maxBytes: 1024,
        fetchImpl,
      }),
    ).rejects.toThrow(/Blocked|private|internal/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
