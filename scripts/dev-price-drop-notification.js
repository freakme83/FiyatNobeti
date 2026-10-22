import { presentPriceDropNotification } from "../src/price-drop-notification.js";

export const SYNTHETIC_PRICE_DROP_EVENT = Object.freeze({
  product: Object.freeze({ asin: "SYNTHETIC1", title: "SYNTHETIC NOTIFICATION TEST" }),
  previousPrice: 1000,
  newPrice: 800,
  currency: "TRY"
});

export function installDeveloperPriceDropNotificationTest({ chromeApi }) {
  return Object.freeze({
    testPriceDropNotification: () => presentPriceDropNotification({
      chromeApi,
      event: SYNTHETIC_PRICE_DROP_EVENT
    })
  });
}
