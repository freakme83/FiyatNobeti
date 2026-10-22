import { timestampMs } from "./automatic.js";
import { getEffectiveNotificationPreferences, NOTIFICATION_PREFERENCES_KEY } from "./notification-preferences.js";
import { calculatePriceChange } from "./price-drop-notification.js";

export const AUTOMATIC_NOTIFICATION_MARKERS_KEY = "automaticNotificationMarkers";
const MAX_MARKERS = 100;
const ASIN_PATTERN = /^[A-Z0-9]{10}$/;

function readMarkers(value) {
  if (value === undefined) return { version: 1, byAsin: {} };
  if (value?.version !== 1 || !value.byAsin || typeof value.byAsin !== "object" || Array.isArray(value.byAsin)) return null;
  const entries = Object.entries(value.byAsin);
  if (entries.length > MAX_MARKERS || entries.some(([asin, marker]) =>
    !ASIN_PATTERN.test(asin) || !marker || typeof marker !== "object" ||
    typeof marker.addedAt !== "string" || timestampMs(marker.checkedAt) === null)) return null;
  return value;
}

// Called under the existing watchlist mutation lock, after the successful
// price commit. Claim first: a terminated worker never retries a presentation.
export async function acceptAutomaticPriceTransition({ storage, transition, watchlist }) {
  const change = calculatePriceChange(transition);
  const asin = transition?.product?.asin;
  const product = watchlist?.products?.[asin];
  const checkedAt = timestampMs(transition?.checkedAt);
  if (!change || checkedAt === null || !product || product.addedAt !== transition.addedAt ||
      product.lastSuccessfulCheckAt !== transition.checkedAt ||
      product.lastSuccessfulPriceTry !== transition.newPrice ||
      product.canonicalUrl !== transition.product.url || product.title !== transition.product.title) return null;

  const saved = await storage.local.get([NOTIFICATION_PREFERENCES_KEY, AUTOMATIC_NOTIFICATION_MARKERS_KEY]);
  const markers = readMarkers(saved[AUTOMATIC_NOTIFICATION_MARKERS_KEY]);
  if (!markers) return null; // Unrecognized deduplication data fails closed.
  const prior = markers.byAsin[asin];
  if (prior?.addedAt === product.addedAt && checkedAt <= timestampMs(prior.checkedAt)) return null;

  const byAsin = Object.fromEntries(Object.entries(markers.byAsin)
    .filter(([key, marker]) => key !== asin && watchlist.products[key]?.addedAt === marker.addedAt)
    .slice(-(MAX_MARKERS - 1)));
  byAsin[asin] = { addedAt: product.addedAt, checkedAt: transition.checkedAt };
  await storage.local.set({ [AUTOMATIC_NOTIFICATION_MARKERS_KEY]: { version: 1, byAsin } });

  const preferences = getEffectiveNotificationPreferences(saved[NOTIFICATION_PREFERENCES_KEY]);
  return preferences.enabled && (change.direction === "decrease" ? preferences.notifyOnDecrease : preferences.notifyOnIncrease)
    ? transition : null;
}
