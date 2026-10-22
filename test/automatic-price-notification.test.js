import test from "node:test";
import assert from "node:assert/strict";
import { acceptAutomaticPriceTransition, AUTOMATIC_NOTIFICATION_MARKERS_KEY } from "../src/automatic-price-notification.js";
import { presentPriceChangeNotification } from "../src/price-drop-notification.js";
import { NOTIFICATION_PREFERENCES_KEY } from "../src/notification-preferences.js";

const key = AUTOMATIC_NOTIFICATION_MARKERS_KEY;
const prefs = (enabled = true, notifyOnDecrease = true, notifyOnIncrease = false) =>
  ({ version: 1, enabled, notifyOnDecrease, notifyOnIncrease });
const stamp = hour => new Date(Date.UTC(2026, 9, 22, hour)).toISOString();
const url = asin => `https://www.amazon.com.tr/dp/${asin}`;

function fixture({ asin = "B0D47HCRZ6", previousPrice = 1000, newPrice = 800, checkedAt = stamp(12),
  title = "Test product", addedAt = stamp(0) } = {}) {
  const transition = {
    product: { asin, title, url: url(asin) }, previousPrice, newPrice, currency: "TRY", checkedAt, addedAt
  };
  const watchlist = { products: { [asin]: {
    asin, title, canonicalUrl: url(asin), addedAt, lastSuccessfulPriceTry: newPrice, lastSuccessfulCheckAt: checkedAt
  } } };
  return { transition, watchlist };
}

function storage(initial = {}, hooks = {}) {
  const data = structuredClone(initial);
  let writes = 0;
  return {
    data,
    get writes() { return writes; },
    local: {
      async get(keys) {
        if (hooks.failRead) throw new Error("read failed");
        return Object.fromEntries(keys.map(key => [key, structuredClone(data[key])]));
      },
      async set(values) {
        if (hooks.failWrite) throw new Error("write failed");
        Object.assign(data, structuredClone(values));
        writes++;
      }
    }
  };
}

async function accept(store, sample) {
  return acceptAutomaticPriceTransition({ storage: store, ...sample });
}

test("default decrease is accepted; default increase, equal and first price are silent", async () => {
  const decrease = fixture();
  const store = storage();
  assert.deepEqual(await accept(store, decrease), decrease.transition);
  assert.equal(store.writes, 1);
  assert.equal(await accept(storage(), fixture({ previousPrice: 800, newPrice: 860 })), null);
  assert.equal(await accept(storage(), fixture({ previousPrice: 800, newPrice: 800 })), null);
  assert.equal(await accept(storage(), fixture({ previousPrice: null })), null);
});

test("master and independent direction preferences gate both changes", async () => {
  const decrease = fixture();
  const increase = fixture({ previousPrice: 800, newPrice: 860 });
  for (const [setting, dropExpected, riseExpected] of [
    [prefs(true, true, true), true, true],
    [prefs(true, false, true), false, true],
    [prefs(true, true, false), true, false],
    [prefs(true, false, false), false, false],
    [prefs(false, true, true), false, false]
  ]) {
    assert.equal(!!await accept(storage({ [NOTIFICATION_PREFERENCES_KEY]: setting }), decrease), dropExpected);
    assert.equal(!!await accept(storage({ [NOTIFICATION_PREFERENCES_KEY]: setting }), increase), riseExpected);
  }
});

test("malformed, unsupported and unreadable preferences fail closed", async () => {
  for (const value of [{ version: 2, enabled: true, notifyOnDecrease: true, notifyOnIncrease: true },
    { version: 1, enabled: "yes", notifyOnDecrease: true, notifyOnIncrease: true }, null]) {
    assert.equal(await accept(storage({ [NOTIFICATION_PREFERENCES_KEY]: value }), fixture()), null);
  }
  await assert.rejects(accept(storage({}, { failRead: true }), fixture()));
});

test("invalid transitions, changed identity and corrupt markers are rejected without writes", async () => {
  for (const previousPrice of [0, -1, NaN, Infinity, 1000.001, Number.MAX_VALUE]) {
    const store = storage();
    assert.equal(await accept(store, fixture({ previousPrice })), null);
    assert.equal(store.writes, 0);
  }
  for (const newPrice of [0, -1, NaN, Infinity, 800.001, Number.MAX_VALUE]) {
    assert.equal(await accept(storage(), fixture({ newPrice })), null);
  }
  const replaced = fixture();
  replaced.watchlist.products.B0D47HCRZ6.addedAt = stamp(1);
  assert.equal(await accept(storage(), replaced), null);
  const deleted = fixture();
  deleted.watchlist.products = {};
  assert.equal(await accept(storage(), deleted), null);
  for (const value of [{ version: 2, byAsin: {} }, { version: 1, byAsin: [] }, null]) {
    assert.equal(await accept(storage({ [key]: value }), fixture()), null);
  }
});

test("the marker is durable, per-product, and rejects replay while allowing a later repeated value", async () => {
  const store = storage({ [NOTIFICATION_PREFERENCES_KEY]: prefs(true, true, true) });
  const first = fixture();
  assert.ok(await accept(store, first));
  assert.equal(await accept(store, first), null);
  const later = fixture({ previousPrice: 800, newPrice: 1000, checkedAt: stamp(15) });
  assert.ok(await accept(store, later));
  assert.equal(await accept(store, first), null); // Older event stays rejected after a newer one.
  const repeated = fixture({ previousPrice: 1000, newPrice: 800, checkedAt: stamp(18) });
  assert.ok(await accept(store, repeated));
  assert.deepEqual(store.data[key].byAsin.B0D47HCRZ6, { addedAt: stamp(0), checkedAt: stamp(18) });
});

test("mark-before-create boundary favors at-most-once attempts across termination and API failures", async () => {
  const sample = fixture();
  const beforeMarker = storage({}, { failWrite: true });
  await assert.rejects(accept(beforeMarker, sample));
  assert.equal(beforeMarker.data[key], undefined);

  const store = storage();
  const accepted = await accept(store, sample);
  assert.ok(accepted); // Worker may stop here; a restarted handler sees the marker.
  assert.equal(await accept(store, sample), null);

  let calls = 0;
  const chromeApi = {
    notifications: { getPermissionLevel: async () => "granted", create: async () => { calls++; throw new Error("API failure"); } },
    runtime: { getURL: path => `chrome-extension://test/${path}` }
  };
  assert.equal((await presentPriceChangeNotification({ chromeApi, event: accepted })).status, "failed");
  assert.equal(await accept(store, sample), null); // No retry after a failed create.
  assert.equal(calls, 1);
  assert.equal(store.data[key].byAsin.B0D47HCRZ6.checkedAt, stamp(12));
});

test("marker metadata is bounded and contains no prices, titles or URLs", async () => {
  const store = storage({ [NOTIFICATION_PREFERENCES_KEY]: prefs(true, true, true) });
  const watchlist = { products: {} };
  for (let i = 0; i < 120; i++) {
    const asin = `B${String(i).padStart(9, "0")}`;
    const item = fixture({ asin });
    Object.assign(watchlist.products, item.watchlist.products);
    assert.ok(await accept(store, { transition: item.transition, watchlist }));
    assert.ok(Object.keys(store.data[key].byAsin).length <= 100);
  }
  const encoded = JSON.stringify(store.data[key]);
  assert.doesNotMatch(encoded, /Test product|amazon|previousPrice|newPrice/);
  assert.equal(Object.keys(store.data[key].byAsin).length, 100);
});
