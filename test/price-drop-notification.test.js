import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPriceDropNotification,
  buildPriceChangeNotification,
  calculatePriceChange,
  calculatePriceDrop,
  presentPriceDropNotification,
  presentPriceChangeNotification
} from "../src/price-drop-notification.js";
import {
  installDeveloperPriceDropNotificationTest,
  SYNTHETIC_PRICE_DROP_EVENT
} from "../scripts/dev-price-drop-notification.js";

const validEvent = () => ({
  product: { asin: "B012345678", title: "Test product" },
  previousPrice: 1000,
  newPrice: 800,
  currency: "TRY"
});

test("price drop uses Turkish currency and percentage formatting", () => {
  const drop = calculatePriceDrop(validEvent());
  assert.equal(drop.previousPriceText, "₺1.000,00");
  assert.equal(drop.newPriceText, "₺800,00");
  assert.equal(drop.absoluteDecreaseText, "₺200,00");
  assert.equal(drop.percentageText, "%20");
});

test("decimal calculation formats without binary floating-point artifacts", () => {
  const drop = calculatePriceDrop({ ...validEvent(), previousPrice: 0.3, newPrice: 0.2 });
  assert.equal(drop.previousPriceText, "₺0,30");
  assert.equal(drop.newPriceText, "₺0,20");
  assert.equal(drop.absoluteDecreaseText, "₺0,10");
  assert.equal(drop.percentageText, "%33,33");
});

test("price decreases are strictly positive and have a lower new price", () => {
  for (const [previousPrice, newPrice] of [[100, 100], [100, 101], [0, 1], [-1, 0.5], [100, 0]]) {
    assert.equal(calculatePriceDrop({ ...validEvent(), previousPrice, newPrice }), null);
  }
  for (const value of [NaN, Infinity, -Infinity, "800", null, 10.001, Number.MAX_VALUE]) {
    assert.equal(calculatePriceDrop({ ...validEvent(), newPrice: value }), null);
  }
});

test("product identity, title, currency, and optional URL are validated", () => {
  for (const product of [undefined, {}, { asin: "bad", title: "X" }, { asin: "B012345678", title: "\n" },
    { asin: "B012345678", title: "x".repeat(181) }]) {
    assert.equal(calculatePriceDrop({ ...validEvent(), product }), null);
  }
  assert.equal(calculatePriceDrop({ ...validEvent(), currency: "USD" }), null);
  for (const url of ["https://amazon.com.tr/dp/B012345678", "http://www.amazon.com.tr/dp/B012345678",
    "https://www.amazon.com.tr/dp/B012345678?ref=test", "https://user@www.amazon.com.tr/dp/B012345678",
    "https://www.amazon.com.tr/dp/B099999999"]) {
    assert.equal(calculatePriceDrop({ ...validEvent(), product: { ...validEvent().product, url } }), null);
  }
  assert.ok(calculatePriceDrop({ ...validEvent(), product: { ...validEvent().product, url: "https://www.amazon.com.tr/dp/B012345678" } }));
});

test("notification content prioritizes new, prior, absolute and percentage values", () => {
  const notification = buildPriceDropNotification(validEvent());
  assert.equal(notification.type, "basic");
  assert.equal(notification.title, "Test product");
  assert.equal(notification.message, "Yeni: ₺800,00 · Önceki: ₺1.000,00 · −₺200,00 (%20)");
});

test("price increase uses the same strict validation and Turkish formatting", async () => {
  const increase = { ...validEvent(), previousPrice: 800, newPrice: 860 };
  const change = calculatePriceChange(increase);
  assert.equal(change.direction, "increase");
  assert.equal(change.absoluteDifferenceText, "₺60,00");
  assert.equal(change.percentageText, "%7,5");
  assert.equal(calculatePriceDrop(increase), null);
  assert.deepEqual(buildPriceChangeNotification(increase), {
    type: "basic", title: "Test product",
    message: "Yeni: ₺860,00 · Önceki: ₺800,00 · +₺60,00 (%7,5)",
    contextMessage: "Fiyat yükselişi"
  });
  assert.equal(calculatePriceChange({ ...increase, newPrice: 800 }), null);
  assert.equal(calculatePriceChange({ ...increase, newPrice: 860.001 }), null);
  assert.equal(calculatePriceChange({ ...increase, previousPrice: NaN }), null);
  assert.equal(calculatePriceChange({ ...increase, product: { asin: "BAD", title: "x" } }), null);
  const calls = [];
  const result = await presentPriceChangeNotification({
    chromeApi: {
      notifications: { getPermissionLevel: async () => "granted", create: async options => { calls.push(options); return "increase-id"; } },
      runtime: { getURL: path => `chrome-extension://test/${path}` }
    }, event: increase
  });
  assert.deepEqual(result, { status: "created", notificationId: "increase-id" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].contextMessage, "Fiyat yükselişi");
});

test("presenter creates exactly one notification and returns its API id", async () => {
  const calls = [];
  const result = await presentPriceDropNotification({
    chromeApi: {
      notifications: {
        getPermissionLevel: async () => "granted",
        create: async options => { calls.push(options); return "chrome-id"; }
      },
      runtime: { getURL: path => `chrome-extension://test/${path}` }
    },
    event: validEvent()
  });
  assert.deepEqual(result, { status: "created", notificationId: "chrome-id" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].iconUrl, "chrome-extension://test/icons/notification-128.png");
});

test("denied permission and API errors return safe outcomes without creating a notification", async () => {
  let createCalls = 0;
  const denied = await presentPriceDropNotification({ chromeApi: {
    notifications: { getPermissionLevel: async () => "denied", create: async () => { createCalls++; } },
    runtime: { getURL: path => path }
  }, event: validEvent() });
  assert.deepEqual(denied, { status: "unavailable", errorCode: "NOTIFICATIONS_PERMISSION_DENIED" });
  assert.equal(createCalls, 0);

  const failed = await presentPriceDropNotification({ chromeApi: {
    notifications: { getPermissionLevel: async () => "granted", create: async () => { throw new Error("private platform detail"); } },
    runtime: { getURL: path => path }
  }, event: validEvent() });
  assert.deepEqual(failed, { status: "failed", errorCode: "NOTIFICATION_CREATE_FAILED" });
  assert.equal(JSON.stringify(failed).includes("private platform detail"), false);
});

test("explicit developer fixture makes one synthetic notification and has no other side effects", async () => {
  const calls = [];
  const forbidden = () => { throw new Error("unexpected external or product operation"); };
  const chromeApi = {
    notifications: {
      getPermissionLevel: async () => "granted",
      create: async options => { calls.push(options); return `synthetic-${calls.length}`; }
    },
    runtime: { getURL: path => `chrome-extension://test/${path}` },
    storage: { local: { get: forbidden, set: forbidden } },
    alarms: { create: forbidden, clear: forbidden }
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = forbidden;
  try {
    const { testPriceDropNotification } = installDeveloperPriceDropNotificationTest({ chromeApi });
    const result = await testPriceDropNotification();
    assert.deepEqual(result, { status: "created", notificationId: "synthetic-1" });
    assert.equal(calls.length, 1);
    assert.deepEqual(SYNTHETIC_PRICE_DROP_EVENT, {
      product: { asin: "SYNTHETIC1", title: "SYNTHETIC NOTIFICATION TEST" },
      previousPrice: 1000, newPrice: 800, currency: "TRY"
    });
    assert.equal(calls[0].title, "SYNTHETIC NOTIFICATION TEST");
    assert.match(calls[0].message, /₺800,00.*₺1\.000,00.*₺200,00.*%20/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
