export const MANUAL_CHECK_COOLDOWN_MS = 3 * 60 * 1000;

export function manualCheckCooldownUntil(lastManualCheckAt) {
  if (typeof lastManualCheckAt !== "string") return null;
  const attemptedAt = Date.parse(lastManualCheckAt);
  if (!Number.isFinite(attemptedAt)) return null;
  return attemptedAt + MANUAL_CHECK_COOLDOWN_MS;
}

export function manualCheckCooldownRemaining(lastManualCheckAt, now = Date.now()) {
  const until = manualCheckCooldownUntil(lastManualCheckAt);
  return until === null ? 0 : Math.max(0, until - now);
}

export function isManualCooldownActive(until, now = Date.now()) {
  const deadline = typeof until === "number" ? until : Number(until);
  return Number.isFinite(deadline) && deadline > now;
}

export function formatManualCooldown(remainingMs) {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
