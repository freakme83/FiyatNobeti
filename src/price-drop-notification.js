const ASIN_PATTERN = /^[A-Z0-9]{10}$/;
const TITLE_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const MAX_PRICE_CENTS = 99_999_999_999;

const tryFormatter = (locale, options) => new Intl.NumberFormat(locale, options);

function toCents(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const scaled = value * 100;
  if (!Number.isFinite(scaled) || Math.abs(scaled - Math.round(scaled)) > 1e-7) return null;
  const cents = Math.round(scaled);
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > MAX_PRICE_CENTS) return null;
  return cents;
}

export function calculatePriceChange(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const product = event.product;
  if (!product || typeof product !== "object" || Array.isArray(product)) return null;
  if (typeof product.asin !== "string" || !ASIN_PATTERN.test(product.asin)) return null;
  if (typeof product.title !== "string" || !product.title.trim() || product.title.length > 180 || TITLE_CONTROL_CHARS.test(product.title)) return null;
  if (event.currency !== "TRY") return null;

  if (product.url !== undefined) {
    if (typeof product.url !== "string") return null;
    try {
      const url = new URL(product.url);
      if (url.protocol !== "https:" || url.hostname !== "www.amazon.com.tr" || url.username || url.password ||
          url.search || url.hash || !new RegExp(`^/(?:dp|gp/product)/${product.asin}/?$`).test(url.pathname)) return null;
    } catch {
      return null;
    }
  }

  const previousCents = toCents(event.previousPrice);
  const newCents = toCents(event.newPrice);
  if (previousCents === null || newCents === null || newCents === previousCents) return null;

  const direction = newCents < previousCents ? "decrease" : "increase";
  const absoluteDifferenceCents = Math.abs(previousCents - newCents);
  const percentBasisPoints = Math.round((absoluteDifferenceCents * 10_000) / previousCents);
  const money = tryFormatter("tr-TR", { style: "currency", currency: "TRY", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const percent = tryFormatter("tr-TR", { maximumFractionDigits: 2, minimumFractionDigits: 0 });

  return Object.freeze({
    asin: product.asin,
    title: product.title.trim(),
    direction,
    previousCents,
    newCents,
    absoluteDifferenceCents,
    percentage: percentBasisPoints / 100,
    previousPriceText: money.format(previousCents / 100),
    newPriceText: money.format(newCents / 100),
    absoluteDifferenceText: money.format(absoluteDifferenceCents / 100),
    percentageText: `%${percent.format(percentBasisPoints / 100)}`
  });
}

export function calculatePriceDrop(event) {
  const change = calculatePriceChange(event);
  if (change?.direction !== "decrease") return null;
  return Object.freeze({ ...change,
    absoluteDecreaseCents: change.absoluteDifferenceCents,
    absoluteDecreaseText: change.absoluteDifferenceText
  });
}

function notificationFor(change) {
  return Object.freeze({
    type: "basic",
    title: change.title,
    message: `Yeni: ${change.newPriceText} · Önceki: ${change.previousPriceText} · ${change.direction === "decrease" ? "−" : "+"}${change.absoluteDifferenceText} (${change.percentageText})`,
    contextMessage: change.direction === "decrease" ? "Fiyat düşüşü" : "Fiyat yükselişi"
  });
}

export function buildPriceChangeNotification(event) {
  const change = calculatePriceChange(event);
  return change ? notificationFor(change) : null;
}

export function buildPriceDropNotification(event) {
  const drop = calculatePriceDrop(event);
  return drop ? notificationFor(drop) : null;
}

async function presentNotification(chromeApi, notification) {
  const api = chromeApi?.notifications;
  if (typeof api?.getPermissionLevel !== "function" || typeof api?.create !== "function" ||
      typeof chromeApi?.runtime?.getURL !== "function") {
    return { status: "unavailable", errorCode: "NOTIFICATIONS_API_UNAVAILABLE" };
  }

  try {
    const permission = await api.getPermissionLevel();
    if (permission === "denied") return { status: "unavailable", errorCode: "NOTIFICATIONS_PERMISSION_DENIED" };
    if (permission !== "granted") return { status: "unavailable", errorCode: "NOTIFICATIONS_PERMISSION_UNKNOWN" };
    const notificationId = await api.create({
      ...notification,
      iconUrl: chromeApi.runtime.getURL("icons/notification-128.png")
    });
    if (typeof notificationId !== "string" || notificationId.length === 0) {
      return { status: "failed", errorCode: "NOTIFICATION_ID_MISSING" };
    }
    return { status: "created", notificationId };
  } catch {
    return { status: "failed", errorCode: "NOTIFICATION_CREATE_FAILED" };
  }
}

export function presentPriceChangeNotification({ chromeApi, event }) {
  const notification = buildPriceChangeNotification(event);
  if (!notification) return Promise.resolve({ status: "rejected", errorCode: "INVALID_PRICE_CHANGE_EVENT" });
  return presentNotification(chromeApi, notification);
}

export function presentPriceDropNotification({ chromeApi, event }) {
  const notification = buildPriceDropNotification(event);
  if (!notification) return Promise.resolve({ status: "rejected", errorCode: "INVALID_PRICE_DROP_EVENT" });
  return presentNotification(chromeApi, notification);
}
