export const NOTIFICATION_PREFERENCES_KEY = "notificationPreferences";

export const DEFAULT_NOTIFICATION_PREFERENCES = Object.freeze({
  version: 1,
  enabled: true,
  notifyOnDecrease: true,
  notifyOnIncrease: false
});

const DISABLED_NOTIFICATION_PREFERENCES = Object.freeze({
  version: 1,
  enabled: false,
  notifyOnDecrease: false,
  notifyOnIncrease: false
});

const PREFERENCE_FIELDS = new Set(["enabled", "notifyOnDecrease", "notifyOnIncrease"]);

export function normalizeNotificationPreferences(value) {
  if (value === undefined) {
    return { preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES }, valid: true, isDefault: true };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { preferences: { ...DISABLED_NOTIFICATION_PREFERENCES }, valid: false, errorCode: "MALFORMED_NOTIFICATION_PREFERENCES" };
  }

  const keys = Object.keys(value);
  if (value.version !== 1) {
    return { preferences: { ...DISABLED_NOTIFICATION_PREFERENCES }, valid: false, errorCode: "UNSUPPORTED_NOTIFICATION_PREFERENCES_VERSION" };
  }
  if (keys.length !== 4 || !keys.includes("version") ||
      [...PREFERENCE_FIELDS].some(field => typeof value[field] !== "boolean") ||
      keys.some(key => key !== "version" && !PREFERENCE_FIELDS.has(key))) {
    return { preferences: { ...DISABLED_NOTIFICATION_PREFERENCES }, valid: false, errorCode: "MALFORMED_NOTIFICATION_PREFERENCES" };
  }

  return {
    preferences: {
      version: 1,
      enabled: value.enabled,
      notifyOnDecrease: value.notifyOnDecrease,
      notifyOnIncrease: value.notifyOnIncrease
    },
    valid: true,
    isDefault: false
  };
}

export function getEffectiveNotificationPreferences(preferences) {
  const normalized = normalizeNotificationPreferences(preferences);
  const value = normalized.preferences;
  return Object.freeze({
    enabled: normalized.valid && value.enabled,
    notifyOnDecrease: normalized.valid && value.enabled && value.notifyOnDecrease,
    notifyOnIncrease: normalized.valid && value.enabled && value.notifyOnIncrease
  });
}

export function createPopupNotificationPreferences(storage, onState) {
  let preferences = { ...DEFAULT_NOTIFICATION_PREFERENCES };
  let persistedPreferences = { ...DEFAULT_NOTIFICATION_PREFERENCES };
  let loaded = false;
  let valid = true;
  let errorCode = null;
  let status = "loading";
  let disposed = false;
  let revision = 0;
  let preferenceVersion = 0;
  let pendingWrites = 0;
  let writeQueue = Promise.resolve();
  let needsStorageRead = false;

  function snapshot() {
    return {
      preferences: { ...preferences },
      effective: getEffectiveNotificationPreferences(preferences),
      loaded,
      valid,
      errorCode,
      status
    };
  }

  function publish() {
    if (!disposed) onState(snapshot());
  }

  function applyNormalized(value, newStatus = "ready") {
    const normalized = normalizeNotificationPreferences(value);
    preferences = { ...normalized.preferences };
    persistedPreferences = { ...normalized.preferences };
    valid = normalized.valid;
    errorCode = normalized.errorCode || null;
    status = normalized.valid ? newStatus : "invalid";
    loaded = true;
    revision += 1;
    publish();
  }

  async function readLatest() {
    const readRevision = revision;
    const result = await storage.local.get(NOTIFICATION_PREFERENCES_KEY);
    if (disposed || readRevision !== revision || pendingWrites > 0) return false;
    const raw = result?.[NOTIFICATION_PREFERENCES_KEY];
    applyNormalized(raw);
    return true;
  }

  function onChanged(changes, areaName) {
    if (disposed || areaName !== "local" || !Object.hasOwn(changes, NOTIFICATION_PREFERENCES_KEY)) return;
    revision += 1;
    if (pendingWrites > 0) {
      needsStorageRead = true;
      return;
    }

    const eventRevision = revision;
    readLatest().catch(() => {
      if (disposed || eventRevision !== revision) return;
      preferences = { ...DISABLED_NOTIFICATION_PREFERENCES };
      persistedPreferences = { ...DISABLED_NOTIFICATION_PREFERENCES };
      loaded = true;
      valid = false;
      errorCode = "NOTIFICATION_PREFERENCES_READ_FAILED";
      status = "read-error";
      revision += 1;
      publish();
    });
  }

  storage.onChanged.addListener(onChanged);
  publish();

  async function load() {
    const initialRevision = revision;
    try {
      const result = await storage.local.get(NOTIFICATION_PREFERENCES_KEY);
      if (disposed || initialRevision !== revision) return false;
      applyNormalized(result?.[NOTIFICATION_PREFERENCES_KEY]);
      return true;
    } catch {
      if (disposed || initialRevision !== revision) return false;
      preferences = { ...DISABLED_NOTIFICATION_PREFERENCES };
      persistedPreferences = { ...DISABLED_NOTIFICATION_PREFERENCES };
      loaded = true;
      valid = false;
      errorCode = "NOTIFICATION_PREFERENCES_READ_FAILED";
      status = "read-error";
      revision += 1;
      publish();
      return false;
    }
  }

  function update(field, value) {
    if (disposed || !loaded || !PREFERENCE_FIELDS.has(field) || typeof value !== "boolean") return Promise.resolve(false);

    preferences = { ...preferences, version: 1, [field]: value };
    valid = true;
    errorCode = null;
    status = "saving";
    revision += 1;
    const thisVersion = ++preferenceVersion;
    const record = { ...preferences };
    pendingWrites += 1;
    publish();

    const save = async () => {
      try {
        await storage.local.set({ [NOTIFICATION_PREFERENCES_KEY]: record });
        persistedPreferences = record;
        if (thisVersion === preferenceVersion && !disposed) {
          preferences = { ...record };
          valid = true;
          errorCode = null;
          status = "saved";
          publish();
        }
        return true;
      } catch {
        if (thisVersion === preferenceVersion && !disposed) {
          preferences = { ...persistedPreferences };
          valid = false;
          errorCode = "NOTIFICATION_PREFERENCES_WRITE_FAILED";
          status = "write-error";
          publish();
        }
        return false;
      } finally {
        pendingWrites -= 1;
        if (pendingWrites === 0 && needsStorageRead && !disposed) {
          needsStorageRead = false;
          try { await readLatest(); } catch {
            if (!disposed) {
              errorCode = "NOTIFICATION_PREFERENCES_READ_FAILED";
              status = "read-error";
              valid = false;
              preferences = { ...DISABLED_NOTIFICATION_PREFERENCES };
              publish();
            }
          }
        }
      }
    };
    writeQueue = writeQueue.then(save, save);
    return writeQueue;
  }

  return {
    load,
    update,
    getState: snapshot,
    dispose() {
      if (disposed) return;
      disposed = true;
      storage.onChanged.removeListener(onChanged);
    }
  };
}
