export const AUTO_SETTINGS_KEY = "automaticChecks";
export const AUTO_STATE_KEY = "automaticCheckState";
export const AUTO_ALARM_NAME = "fiyatnobeti:automatic-price-check";
export const AUTO_INTERVAL_MS = 3 * 60 * 60 * 1000;
export const LEGACY_AUTO_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const AUTO_PACE_MS = 60 * 1000;
export const AUTO_VERSION = 1;

export function defaultAutoSettings() {
  return { version: AUTO_VERSION, enabled: true, intervalMinutes: 180 };
}

export function normalizeAutoSettings(value) {
  if (value === undefined) return defaultAutoSettings();
  if (value?.version !== AUTO_VERSION || typeof value.enabled !== "boolean" ||
      ![180, 360].includes(value.intervalMinutes)) {
    throw new Error("AUTO_SETTINGS_UNSUPPORTED_VERSION");
  }
  return { version: AUTO_VERSION, enabled: value.enabled, intervalMinutes: 180 };
}

export function migrateLegacyAutoState(state, now) {
  const boundary = timestampMs(state.notBefore);
  // Version 1 wrote one-minute pacing, six-hour interval cooldowns, and a
  // permission backoff identified by lastErrorCode. Preserve safety boundaries.
  if (state.lastErrorCode === "PERMISSION_REQUIRED" || boundary === null ||
      boundary <= now + AUTO_PACE_MS) return state;
  return {
    ...state,
    notBefore: new Date(Math.max(now + AUTO_PACE_MS,
      boundary - (LEGACY_AUTO_INTERVAL_MS - AUTO_INTERVAL_MS))).toISOString()
  };
}

export function defaultAutoState() {
  return { version: AUTO_VERSION, nextRunAt: null, notBefore: null, unknownSince: {}, lastErrorCode: null };
}

export function timestampMs(value) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeAutoState(value) {
  if (value === undefined) return defaultAutoState();
  if (value?.version !== AUTO_VERSION || !value.unknownSince || typeof value.unknownSince !== "object") {
    throw new Error("AUTO_STATE_UNSUPPORTED_VERSION");
  }
  const unknownSince = {};
  for (const [asin, since] of Object.entries(value.unknownSince)) {
    if (/^[A-Z0-9]{10}$/.test(asin) && timestampMs(since) !== null) unknownSince[asin] = since;
  }
  return {
    version: AUTO_VERSION,
    nextRunAt: timestampMs(value.nextRunAt) === null ? null : value.nextRunAt,
    notBefore: timestampMs(value.notBefore) === null ? null : value.notBefore,
    unknownSince,
    lastErrorCode: value.lastErrorCode === "PERMISSION_REQUIRED" ? "PERMISSION_REQUIRED" : null
  };
}

export function nextEligibleAt(product, unknownSince) {
  const attempted = timestampMs(product.lastAttemptedCheckAt);
  const added = timestampMs(product.addedAt);
  const fallback = timestampMs(unknownSince);
  const basis = attempted ?? added ?? fallback;
  return basis === null ? null : basis + AUTO_INTERVAL_MS;
}
