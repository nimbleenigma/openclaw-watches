export type WatchesConfig = {
  defaultIntervalSeconds: number;
  defaultExpiryMs: number;
  maxActivePerOwner: number;
  maxConcurrentChecks: number;
  claimLeaseMs: number;
  retentionMs: number;
  urlTimeoutMs: number;
  urlMaxBytes: number;
  maxConsecutiveErrors: number;
};

export const DEFAULT_WATCHES_CONFIG: WatchesConfig = {
  defaultIntervalSeconds: 15 * 60,
  defaultExpiryMs: 24 * 60 * 60 * 1000,
  maxActivePerOwner: 20,
  maxConcurrentChecks: 2,
  claimLeaseMs: 5 * 60 * 1000,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
  urlTimeoutMs: 10_000,
  urlMaxBytes: 512 * 1024,
  maxConsecutiveErrors: 5,
};

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function resolveWatchesConfig(input?: Record<string, unknown>): WatchesConfig {
  const defaultIntervalSeconds =
    finiteNumber(input?.defaultIntervalSeconds) ?? DEFAULT_WATCHES_CONFIG.defaultIntervalSeconds;
  const defaultExpiryHours =
    finiteNumber(input?.defaultExpiryHours) ??
    DEFAULT_WATCHES_CONFIG.defaultExpiryMs / (60 * 60 * 1000);
  const maxActivePerOwner =
    finiteNumber(input?.maxActivePerOwner) ?? DEFAULT_WATCHES_CONFIG.maxActivePerOwner;

  return {
    ...DEFAULT_WATCHES_CONFIG,
    defaultIntervalSeconds: Math.floor(clamp(defaultIntervalSeconds, 60, 24 * 60 * 60)),
    defaultExpiryMs: Math.floor(clamp(defaultExpiryHours, 1, 24 * 7) * 60 * 60 * 1000),
    maxActivePerOwner: Math.floor(clamp(maxActivePerOwner, 1, 100)),
  };
}
