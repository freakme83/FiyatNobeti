import test from "node:test";
import assert from "node:assert/strict";
import { AUTO_ALARM_NAME, AUTO_INTERVAL_MS, AUTO_PACE_MS } from "../src/automatic.js";
import { createProductRecord, WATCHLIST_KEY } from "../src/watchlist.js";

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
let workerSequence = 0;

async function makeColdWorker({ now, products, scheduledAt, blockedStartup = false, seedStorage }) {
  const lock = blockedStartup ? deferred() : null;
  let alarmListener;
  let startupListener;
  const alarms = new Map();
  const alarmCreations = [];
  const storage = seedStorage || {
    [WATCHLIST_KEY]: { version: 1, products: Object.fromEntries(products.map(product => [product.asin, product])) },
    automaticChecks: { version: 1, enabled: true, intervalMinutes: 180 },
    automaticCheckState: {
      version: 1, nextRunAt: new Date(scheduledAt).toISOString(), notBefore: null,
      unknownSince: {}, lastErrorCode: null
    }
  };
  let requests = 0;
  globalThis.chrome = {
    runtime: {
      id: "cold-worker-test",
      onMessage: { addListener() {} },
      onInstalled: { addListener() {} },
      onStartup: { addListener(fn) { startupListener = fn; } },
      async sendMessage(message) {
        assert.equal(message.type, "PARSE_HTML");
        return { status: "success", priceTry: 1234, title: "Test product" };
      }
    },
    permissions: { async contains() { return true; } },
    alarms: {
      onAlarm: { addListener(fn) { alarmListener = fn; } },
      async get(name) { return alarms.get(name); },
      async create(name, info) {
        alarms.set(name, { name, scheduledTime: info.when });
        alarmCreations.push({ name, ...info });
      },
      async clear(name) { return alarms.delete(name); }
    },
    offscreen: { async hasDocument() { return true; }, async createDocument() { throw new Error("unexpected"); } },
    storage: { local: {
      async get(keys) {
        if (lock) await lock.promise;
        const requested = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(requested.map(key => [key, storage[key]]));
      },
      async set(values) { Object.assign(storage, values); }
    } }
  };
  globalThis.fetch = async (_url, options) => {
    requests++;
    assert.equal(options.credentials, "omit");
    return new Response("<div id=\"corePrice_feature_div\"></div>", {
      status: 200, headers: { "content-type": "text/html; charset=UTF-8" }
    });
  };
  const RealDate = globalThis.Date;
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  };
  const moduleId = `../background.js?cold-worker=${++workerSequence}`;
  await import(moduleId);
  return {
    alarmListener: () => alarmListener,
    startupListener: () => startupListener,
    alarms,
    alarmCreations,
    storage,
    get requests() { return requests; },
    releaseStartup() { lock?.resolve(); },
    restoreDate() { globalThis.Date = RealDate; }
  };
}

function product(asin, checkedAt) {
  const record = createProductRecord({
    asin,
    canonicalUrl: `https://www.amazon.com.tr/dp/${asin}`,
    addedAt: checkedAt
  });
  record.lastAttemptedCheckAt = checkedAt;
  record.lastCheckStatus = "failure";
  record.lastErrorCode = "HTTP_ERROR";
  record.lastSuccessfulPriceTry = 999;
  record.lastSuccessfulCheckAt = checkedAt;
  return record;
}

test("cold alarm activation preserves the consumed delivery through startup reconciliation and checks once", async () => {
  const now = Date.parse("2026-10-22T12:00:00.000Z");
  const checkedAt = new Date(now - AUTO_INTERVAL_MS).toISOString();
  const worker = await makeColdWorker({ now, products: [product("B0D47HCRZ6", checkedAt)], scheduledAt: now, blockedStartup: true });
  try {
    // Chrome has consumed the one-shot alarm before creating this worker.
    const delivery = { name: AUTO_ALARM_NAME, scheduledTime: now };
    const handling = worker.alarmListener()(delivery);
    worker.releaseStartup();
    await handling;
    assert.equal(worker.requests, 1);
    assert.equal(worker.storage[WATCHLIST_KEY].products.B0D47HCRZ6.lastCheckStatus, "success");
    assert.equal(worker.storage[WATCHLIST_KEY].products.B0D47HCRZ6.lastSuccessfulPriceTry, 1234);
  } finally { worker.restoreDate(); }
});

test("a consumed legacy six-hour alarm remains valid during cold-worker migration", async () => {
  const now = Date.parse("2026-10-22T12:00:00.000Z");
  const item = product("B0D47HCRZ6", new Date(now - 6 * 60 * 60 * 1000).toISOString());
  const storage = {
    [WATCHLIST_KEY]: { version: 1, products: { [item.asin]: item } },
    automaticChecks: { version: 1, enabled: true, intervalMinutes: 360 },
    automaticCheckState: {
      version: 1, nextRunAt: new Date(now).toISOString(), notBefore: null,
      unknownSince: {}, lastErrorCode: null
    }
  };
  const worker = await makeColdWorker({ now, products: [item], scheduledAt: now, blockedStartup: true, seedStorage: storage });
  try {
    const delivery = worker.alarmListener()({ name: AUTO_ALARM_NAME, scheduledTime: now });
    worker.releaseStartup();
    await delivery;
    assert.equal(worker.requests, 1);
    assert.equal(storage.automaticChecks.intervalMinutes, 180);
    assert.equal(worker.alarms.get(AUTO_ALARM_NAME).scheduledTime, now + AUTO_INTERVAL_MS);
  } finally { worker.restoreDate(); }
});

test("three fresh workers consume successive paced alarms without repeated one-minute deferral", async () => {
  let now = Date.parse("2026-10-22T12:00:00.000Z");
  const asins = ["B0CQXKXBR7", "B0D47HCRZ6", "B0FZ9Y4GPF"];
  const products = asins.map(asin => product(asin, new Date(now - AUTO_INTERVAL_MS).toISOString()));
  const originalDate = globalThis.Date;
  let requests = 0;
  let priorStorage;
  try {
    for (let index = 0; index < asins.length; index++) {
      const worker = await makeColdWorker({ now, products, scheduledAt: now, blockedStartup: true, seedStorage: index ? priorStorage : undefined });
      const delivery = { name: AUTO_ALARM_NAME, scheduledTime: now };
      const handling = worker.alarmListener()(delivery);
      worker.releaseStartup();
      await handling;
      requests += worker.requests;
      assert.equal(worker.storage[WATCHLIST_KEY].products[asins[index]].lastCheckStatus, "success", `fresh worker ${index + 1} should check its next eligible product`);
      if (index < asins.length - 1) {
        const next = worker.alarms.get(AUTO_ALARM_NAME);
        assert.ok(next);
        assert.equal(next.scheduledTime, now + AUTO_PACE_MS);
        now += AUTO_PACE_MS;
      }
      priorStorage = worker.storage;
      worker.restoreDate();
    }
    assert.equal(requests, 3);
  } finally { globalThis.Date = originalDate; }
});

test("browser startup restores only a missing alarm and preserves an existing future alarm", async () => {
  const now = Date.parse("2026-10-22T12:00:00.000Z");
  const due = now + AUTO_INTERVAL_MS;
  const worker = await makeColdWorker({ now, products: [product("B0D47HCRZ6", new Date(now).toISOString())], scheduledAt: due });
  try {
    const listener = worker.startupListener();
    await listener();
    assert.equal(worker.alarms.get(AUTO_ALARM_NAME).scheduledTime, due);
    const count = worker.alarmCreations.length;
    await listener();
    assert.equal(worker.alarmCreations.length, count);
    worker.alarms.delete(AUTO_ALARM_NAME);
    await listener();
    assert.equal(worker.alarms.get(AUTO_ALARM_NAME).scheduledTime, due);
    assert.equal(worker.requests, 0);
  } finally { worker.restoreDate(); }
});

test("premature and stale alarm deliveries do not issue requests", async () => {
  const now = Date.parse("2026-10-22T12:00:00.000Z");
  const checkedAt = new Date(now).toISOString();
  const worker = await makeColdWorker({ now, products: [product("B0D47HCRZ6", checkedAt)], scheduledAt: now + AUTO_INTERVAL_MS });
  try {
    await worker.alarmListener()({ name: AUTO_ALARM_NAME, scheduledTime: now + AUTO_INTERVAL_MS });
    assert.equal(worker.requests, 0);
    await worker.alarmListener()({ name: AUTO_ALARM_NAME, scheduledTime: now - AUTO_INTERVAL_MS });
    assert.equal(worker.requests, 0);
  } finally { worker.restoreDate(); }
});
