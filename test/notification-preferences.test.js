import test from "node:test";
import assert from "node:assert/strict";
import {
  createPopupNotificationPreferences,
  DEFAULT_NOTIFICATION_PREFERENCES,
  getEffectiveNotificationPreferences,
  normalizeNotificationPreferences,
  NOTIFICATION_PREFERENCES_KEY
} from "../src/notification-preferences.js";
import { createPopupWatchlistSync } from "../src/popup-watchlist-sync.js";

const defaults = () => ({ version: 1, enabled: true, notifyOnDecrease: true, notifyOnIncrease: false });
const stored = values => structuredClone(values);

function createStorage(initial = {}, hooks = {}) {
  const data = stored(initial);
  const listeners = new Set();
  const writes = [];
  let reads = 0;
  return {
    data,
    listeners,
    writes,
    api: {
      local: {
        async get(key) {
          reads++;
          if (hooks.get) return hooks.get(key, reads, data);
          return { [key]: stored(data[key]) };
        },
        async set(values) {
          writes.push(stored(values));
          if (hooks.beforeSet) await hooks.beforeSet(values, writes.length);
          for (const [key, value] of Object.entries(values)) {
            const oldValue = stored(data[key]);
            data[key] = stored(value);
            for (const listener of [...listeners]) listener({ [key]: { oldValue, newValue: stored(value) } }, "local");
          }
        }
      },
      onChanged: {
        addListener(listener) { listeners.add(listener); },
        removeListener(listener) { listeners.delete(listener); }
      }
    },
    emit(key, newValue, areaName = "local") {
      const oldValue = stored(data[key]);
      if (areaName === "local") data[key] = stored(newValue);
      for (const listener of [...listeners]) listener({ [key]: { oldValue, newValue: stored(newValue) } }, areaName);
    }
  };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(complete => { resolve = complete; });
  return { promise, resolve };
}

test("fresh install and legacy installation without a record receive the defaults", async () => {
  assert.deepEqual(DEFAULT_NOTIFICATION_PREFERENCES, defaults());
  for (const initial of [{}, { automaticChecks: { version: 1, enabled: false, intervalMinutes: 180 }, watchlist: { version: 1, products: {} } }]) {
    const storage = createStorage(initial);
    let view;
    const controller = createPopupNotificationPreferences(storage.api, state => { view = state; });
    await controller.load();
    assert.deepEqual(view.preferences, defaults());
    assert.deepEqual(view.effective, { enabled: true, notifyOnDecrease: true, notifyOnIncrease: false });
    assert.equal(storage.data[NOTIFICATION_PREFERENCES_KEY], undefined);
    assert.equal(storage.writes.length, 0);
    controller.dispose();
  }
});

test("direction preferences can be selected independently, including both or neither", async () => {
  const storage = createStorage();
  const controller = createPopupNotificationPreferences(storage.api, () => {});
  await controller.load();
  await controller.update("notifyOnDecrease", false);
  assert.deepEqual(controller.getState().preferences, { version: 1, enabled: true, notifyOnDecrease: false, notifyOnIncrease: false });
  await controller.update("notifyOnIncrease", true);
  assert.deepEqual(controller.getState().effective, { enabled: true, notifyOnDecrease: false, notifyOnIncrease: true });
  await controller.update("notifyOnDecrease", true);
  assert.deepEqual(controller.getState().effective, { enabled: true, notifyOnDecrease: true, notifyOnIncrease: true });
  await controller.update("notifyOnIncrease", false);
  assert.deepEqual(controller.getState().effective, { enabled: true, notifyOnDecrease: true, notifyOnIncrease: false });
  await controller.update("notifyOnDecrease", false);
  assert.deepEqual(controller.getState().effective, { enabled: true, notifyOnDecrease: false, notifyOnIncrease: false });
  controller.dispose();
});

test("master off disables both directions while preserving and restoring their selections", async () => {
  const storage = createStorage({ [NOTIFICATION_PREFERENCES_KEY]: { version: 1, enabled: true, notifyOnDecrease: true, notifyOnIncrease: true } });
  const controller = createPopupNotificationPreferences(storage.api, () => {});
  await controller.load();
  await controller.update("enabled", false);
  assert.deepEqual(controller.getState().preferences, { version: 1, enabled: false, notifyOnDecrease: true, notifyOnIncrease: true });
  assert.deepEqual(controller.getState().effective, { enabled: false, notifyOnDecrease: false, notifyOnIncrease: false });
  await controller.update("enabled", true);
  assert.deepEqual(controller.getState().effective, { enabled: true, notifyOnDecrease: true, notifyOnIncrease: true });
  controller.dispose();
});

test("preferences persist after popup close, reopen, and simulated service-worker restart", async () => {
  const storage = createStorage();
  const firstPopup = createPopupNotificationPreferences(storage.api, () => {});
  await firstPopup.load();
  await firstPopup.update("notifyOnIncrease", true);
  firstPopup.dispose();

  const reopenedPopup = createPopupNotificationPreferences(storage.api, () => {});
  await reopenedPopup.load();
  assert.deepEqual(reopenedPopup.getState().preferences, { version: 1, enabled: true, notifyOnDecrease: true, notifyOnIncrease: true });
  reopenedPopup.dispose();

  // The preference schema is durable extension storage, independent of worker globals.
  const afterWorkerRestart = createPopupNotificationPreferences(storage.api, () => {});
  await afterWorkerRestart.load();
  assert.equal(afterWorkerRestart.getState().effective.notifyOnIncrease, true);
  afterWorkerRestart.dispose();
});

test("rapid toggles are serialized and an older write cannot replace the latest UI choice", async () => {
  const gates = [];
  const storage = createStorage({}, { beforeSet: () => { const gate = deferred(); gates.push(gate); return gate.promise; } });
  const visible = [];
  const controller = createPopupNotificationPreferences(storage.api, state => visible.push(state));
  await controller.load();

  const first = controller.update("notifyOnDecrease", false);
  const second = controller.update("notifyOnIncrease", true);
  assert.deepEqual(controller.getState().preferences, { version: 1, enabled: true, notifyOnDecrease: false, notifyOnIncrease: true });
  await tick();
  assert.equal(gates.length, 1);
  gates[0].resolve();
  await tick();
  assert.equal(gates.length, 2);
  gates[1].resolve();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.deepEqual(storage.data[NOTIFICATION_PREFERENCES_KEY], { version: 1, enabled: true, notifyOnDecrease: false, notifyOnIncrease: true });
  assert.deepEqual(controller.getState().preferences, storage.data[NOTIFICATION_PREFERENCES_KEY]);
  assert.equal(visible.at(-1).status, "saved");
  controller.dispose();
});

test("failed writes roll back to committed preferences and show a safe failure state", async () => {
  const storage = createStorage({}, { beforeSet: async () => { throw new Error("simulated quota/write failure"); } });
  const controller = createPopupNotificationPreferences(storage.api, () => {});
  await controller.load();
  const result = await controller.update("notifyOnIncrease", true);
  assert.equal(result, false);
  assert.deepEqual(controller.getState().preferences, defaults());
  assert.equal(controller.getState().status, "write-error");
  assert.equal(controller.getState().errorCode, "NOTIFICATION_PREFERENCES_WRITE_FAILED");
  assert.equal(storage.data[NOTIFICATION_PREFERENCES_KEY], undefined);
  controller.dispose();
});

test("unsupported and malformed records fail closed without rewriting stored data", async () => {
  const badRecords = [
    { version: 9, enabled: true, notifyOnDecrease: true, notifyOnIncrease: true },
    { version: 1, enabled: true, notifyOnDecrease: "yes", notifyOnIncrease: false },
    { version: 1, enabled: true, notifyOnDecrease: true },
    { version: 1, enabled: true, notifyOnDecrease: true, notifyOnIncrease: false, extra: true },
    null
  ];
  for (const raw of badRecords) {
    const storage = createStorage({ [NOTIFICATION_PREFERENCES_KEY]: raw });
    const before = stored(storage.data[NOTIFICATION_PREFERENCES_KEY]);
    const controller = createPopupNotificationPreferences(storage.api, () => {});
    await controller.load();
    assert.equal(controller.getState().valid, false);
    assert.deepEqual(controller.getState().effective, { enabled: false, notifyOnDecrease: false, notifyOnIncrease: false });
    assert.deepEqual(storage.data[NOTIFICATION_PREFERENCES_KEY], before);
    assert.equal(storage.writes.length, 0);
    controller.dispose();
  }
  assert.equal(normalizeNotificationPreferences({ version: 7 }).errorCode, "UNSUPPORTED_NOTIFICATION_PREFERENCES_VERSION");
});

test("late initialization reads cannot overwrite a newer local storage event", async () => {
  const read = deferred();
  const storage = createStorage({}, { get: () => read.promise });
  const controller = createPopupNotificationPreferences(storage.api, () => {});
  const initialLoad = controller.load();
  storage.emit(NOTIFICATION_PREFERENCES_KEY, { version: 1, enabled: true, notifyOnDecrease: false, notifyOnIncrease: true });
  read.resolve({ [NOTIFICATION_PREFERENCES_KEY]: defaults() });
  assert.equal(await initialLoad, false);
  assert.deepEqual(controller.getState().preferences, { version: 1, enabled: true, notifyOnDecrease: false, notifyOnIncrease: true });
  controller.dispose();
});

test("local preference events update an open popup, while other keys and storage areas are ignored", async () => {
  const storage = createStorage();
  const states = [];
  const controller = createPopupNotificationPreferences(storage.api, state => states.push(state));
  await controller.load();
  const count = states.length;
  storage.emit("automaticChecks", { version: 1, enabled: false, intervalMinutes: 180 });
  storage.emit(NOTIFICATION_PREFERENCES_KEY, { version: 1, enabled: false, notifyOnDecrease: true, notifyOnIncrease: true }, "sync");
  assert.equal(states.length, count);
  storage.emit(NOTIFICATION_PREFERENCES_KEY, { version: 1, enabled: true, notifyOnDecrease: false, notifyOnIncrease: true });
  assert.deepEqual(controller.getState().effective, { enabled: true, notifyOnDecrease: false, notifyOnIncrease: true });
  controller.dispose();
});

test("preferences remain independent and do not alter watchlist or automatic settings", async () => {
  const initialWatchlist = { version: 1, products: { B0D47HCRZ6: { lastSuccessfulPriceTry: 1200, lastAttemptedCheckAt: "2026-10-22T10:00:00.000Z" } } };
  const initialAuto = { version: 1, enabled: false, intervalMinutes: 180 };
  const storage = createStorage({ watchlist: initialWatchlist, automaticChecks: initialAuto });
  const controller = createPopupNotificationPreferences(storage.api, () => {});
  await controller.load();
  await controller.update("notifyOnIncrease", true);
  assert.deepEqual(storage.data.watchlist, initialWatchlist);
  assert.deepEqual(storage.data.automaticChecks, initialAuto);
  assert.deepEqual(Object.keys(storage.data).sort(), ["automaticChecks", "notificationPreferences", "watchlist"]);
  controller.dispose();
});

test("preference updates do not create notifications, fetch, alarms, or product checks", async () => {
  const calls = { notification: 0, fetch: 0, alarm: 0, check: 0 };
  const chromeMock = {
    notifications: { create() { calls.notification++; } },
    alarms: { create() { calls.alarm++; } },
    runtime: { sendMessage() { calls.check++; } }
  };
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  globalThis.chrome = chromeMock;
  globalThis.fetch = () => { calls.fetch++; };
  const storage = createStorage();
  const controller = createPopupNotificationPreferences(storage.api, () => {});
  try {
    await controller.load();
    await controller.update("notifyOnIncrease", true);
    await controller.update("enabled", false);
    assert.deepEqual(calls, { notification: 0, fetch: 0, alarm: 0, check: 0 });
  } finally {
    controller.dispose();
    globalThis.chrome = previousChrome;
    globalThis.fetch = previousFetch;
  }
});

test("the preferences listener coexists with live watchlist updates and disposes cleanly", async () => {
  const storage = createStorage();
  const preferences = createPopupNotificationPreferences(storage.api, () => {});
  const watchlistStates = [];
  const watchlistSync = createPopupWatchlistSync(storage.api, value => watchlistStates.push(value));
  await preferences.load();
  storage.emit("watchlist", { version: 1, products: { B0D47HCRZ6: { title: "Live update" } } });
  assert.equal(watchlistStates.length, 1);
  assert.equal(preferences.getState().preferences.enabled, true);
  preferences.dispose();
  watchlistSync.dispose();
  assert.equal(storage.listeners.size, 0);
});
