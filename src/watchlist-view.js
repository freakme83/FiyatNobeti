import { compareWithBaseline } from "./price-comparison.js";
import { priceCents } from "./watchlist.js";
import { parseAmazonInput } from "./url.js";
import { sortWatchlistProducts } from "./watchlist-sorting.js";

const ERROR_LABELS = {
  PERMISSION_REQUIRED: "Amazon Türkiye izni verilmedi.",
  SHORT_LINK_PERMISSION_REQUIRED: "Kısa Amazon bağlantısı izni verilmedi.",
  SHORT_LINK_RESOLUTION_FAILED: "Kısa Amazon bağlantısı çözümlenemedi.",
  SHORT_LINK_OPAQUE_REDIRECT: "Kısa bağlantı yönlendirmesi okunamadı.",
  SHORT_LINK_OPAQUE_RESPONSE: "Kısa bağlantı yanıtı okunamadı.",
  SHORT_LINK_HTTP_STATUS: "Kısa bağlantı isteği başarısız oldu.",
  SHORT_LINK_NETWORK_ERROR: "Kısa bağlantı için ağ isteği başarısız oldu.",
  SHORT_LINK_TIMEOUT: "Kısa bağlantı isteği zaman aşımına uğradı.",
  SHORT_LINK_UNSAFE_REDIRECT: "Kısa bağlantı desteklenmeyen bir adrese yönlendi.",
  SHORT_LINK_UNSUPPORTED_MARKETPLACE: "Kısa bağlantı Amazon Türkiye dışına yönlendi.",
  SHORT_LINK_FINAL_URL_MISSING: "Kısa bağlantının ürün adresi alınamadı.",
  SHORT_LINK_FINAL_URL_INVALID: "Kısa bağlantının ürün adresi doğrulanamadı.",
  SHORT_LINK_UNSUPPORTED_PRODUCT_URL: "Kısa bağlantı desteklenen bir ürün sayfasına ulaşmadı.",
  CHECK_INTERRUPTED: "Kontrol servis çalışanı yeniden başladığı için kesildi; yeniden deneyebilirsiniz.",
  CHECK_CANCELLED: "Kontrol sonucu ürün kaydı değiştiği için uygulanmadı.",
  REDIRECT: "Amazon yönlendirmesi nedeniyle fiyat doğrulanamadı.",
  ACCESS_DENIED: "Amazon erişimi reddetti.",
  BOT_VERIFICATION: "Amazon ek doğrulama istiyor. Fiyat kontrolü tamamlanamadı.",
  AUTH_REQUIRED: "Amazon giriş yapılmasını istiyor.",
  HTTP_ERROR: "Amazon sayfası yüklenemedi.",
  HTML_STRUCTURE: "Amazon ürün sayfasındaki fiyat alanı tanınamadı.",
  PRICE_MISSING: "Birincil ürün fiyatı bulunamadı.",
  PRICE_AMBIGUOUS: "Birden çok ürün fiyatı bulundu; fiyat güncellenmedi.",
  PRICE_UNRECOGNIZED: "Ürün fiyatı TL biçiminde tanınamadı.",
  RESPONSE_TOO_LARGE: "Amazon yanıtı güvenli boyut sınırını aştı.",
  TIMEOUT: "Amazon isteği zaman aşımına uğradı.",
  NETWORK_ERROR: "Amazon için ağ isteği başarısız oldu.",
  PARSE_ERROR: "Amazon ürün yanıtı ayrıştırılamadı.",
  INVALID_URL: "Geçerli bir Amazon Türkiye ürün bağlantısı veya ASIN girin.",
  UNSUPPORTED_URL: "Bu Amazon bağlantısı desteklenmiyor.",
  UNSUPPORTED_MARKETPLACE: "Bu bağlantı Amazon Türkiye'ye ait değil.",
  STORAGE_ERROR: "İzleme listesi yerel olarak okunamadı veya kaydedilemedi."
};

const priceFormatter = new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY" });

function timeLabel(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  return new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function textElement(doc, tagName, className, text) {
  const element = doc.createElement(tagName);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

export function errorMessage(code) {
  return ERROR_LABELS[code] || "Fiyat kontrolü başarısız oldu.";
}

export function createProductRow(doc, product, { customOrder = false, index = 0, count = 0 } = {}) {
  const row = doc.createElement("li");
  row.className = "product";
  row.dataset.asin = product.asin;
  const heading = doc.createElement("h3");
  heading.className = "product-title";
  const title = product.title || "Amazon ürünü";
  try {
    // A stored URL is never used as a destination; only the product's ASIN is accepted.
    const destination = parseAmazonInput(product.asin);
    if (destination.type !== "product" || destination.asin !== product.asin) throw new Error("INVALID_PRODUCT");
    const link = textElement(doc, "a", "", title);
    link.href = destination.canonicalUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    heading.append(link);
  } catch {
    heading.textContent = title;
  }
  row.append(
    heading,
    textElement(doc, "p", "product-asin", product.asin)
  );

  if (priceCents(product.lastSuccessfulPriceTry) !== null) {
    const fresh = product.lastCheckStatus === "success";
    row.append(
      textElement(doc, "p", "product-price-label", fresh ? "Son başarılı fiyat" : "Son başarılı fiyat · güncel değil"),
      textElement(doc, "p", "product-price", priceFormatter.format(product.lastSuccessfulPriceTry))
    );
    const comparison = compareWithBaseline(product);
    if (comparison) {
      const tone = comparison.direction < 0 ? "decrease" : comparison.direction > 0 ? "increase" : "unchanged";
      row.append(
        textElement(doc, "p", `product-comparison ${tone}`, comparison.headline),
        textElement(doc, "p", "product-comparison-detail", comparison.detail),
        textElement(doc, "p", "product-meta", `${product.baselineSource === "migrated" ? "Referans (geçişteki son fiyat)" : "Başlangıç"}: ${comparison.baselineText} · ${timeLabel(product.baselineCheckedAt) || "tarih bilinmiyor"}`)
      );
    } else row.append(textElement(doc, "p", "product-meta", "Karşılaştırma henüz kullanılamıyor."));
    if (product.lastSuccessfulCheckAt) {
      row.append(textElement(doc, "p", "product-meta", `Başarılı kontrol: ${timeLabel(product.lastSuccessfulCheckAt)}`));
    }
  } else {
    row.append(textElement(doc, "p", "product-price-label", "Henüz fiyat alınamadı"));
    row.append(textElement(doc, "p", "product-meta", "İlk geçerli fiyat bekleniyor."));
  }

  let statusText = "";
  let statusClass = "product-status";
  if (product.lastCheckStatus === "checking") statusText = "Kontrol ediliyor…";
  else if (product.lastCheckStatus === "failure") {
    statusText = `Son kontrol başarısız${product.lastErrorCode ? ` · ${errorMessage(product.lastErrorCode)}` : ""}`;
    statusClass += " error";
  } else if (product.lastCheckStatus === "never") statusText = "Henüz kontrol edilmedi.";
  if (statusText) row.append(textElement(doc, "p", statusClass, statusText));
  if (product.lastAttemptedCheckAt) {
    row.append(textElement(doc, "p", "product-meta", `Son deneme: ${timeLabel(product.lastAttemptedCheckAt)}`));
  }

  if (customOrder) {
    const orderActions = doc.createElement("div");
    orderActions.className = "product-order-actions";
    for (const [direction, label, action, disabled] of [
      [-1, "Yukarı", "move-up", index === 0],
      [1, "Aşağı", "move-down", index === count - 1]
    ]) {
      const button = textElement(doc, "button", "", direction < 0 ? "↑" : "↓");
      button.type = "button";
      button.dataset.action = action;
      button.dataset.asin = product.asin;
      button.ariaLabel = `${product.title || "Amazon ürünü"} (${product.asin}) ${label.toLowerCase()} taşı`;
      button.disabled = disabled;
      orderActions.append(button);
    }
    row.append(orderActions);
  }

  const actions = doc.createElement("div");
  actions.className = "product-actions";
  const check = textElement(doc, "button", "", "Fiyatı kontrol et");
  check.type = "button";
  check.dataset.action = "check";
  check.dataset.asin = product.asin;
  const remove = textElement(doc, "button", "remove", "Listeden kaldır");
  remove.type = "button";
  remove.dataset.action = "remove";
  remove.dataset.asin = product.asin;
  actions.append(check, remove);
  row.append(actions);
  return row;
}

export function renderProductRows(doc, container, products, emptyState, options = {}) {
  container.replaceChildren();
  const records = options.records || sortWatchlistProducts(products);
  emptyState.hidden = records.length > 0;
  records.forEach((product, index) => container.append(createProductRow(doc, product,
    { customOrder: options.customOrder, index, count: records.length })));
}
