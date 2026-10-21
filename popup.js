import { normalizeAmazonUrl } from "./src/url.js";

const origin = "https://www.amazon.com.tr/*";
const form = document.querySelector("#probe-form");
const input = document.querySelector("#product-url");
const button = document.querySelector("#check-button");
const status = document.querySelector("#status");
const latest = document.querySelector("#latest");
const previous = document.querySelector("#previous");

const errors = {
  INVALID_URL: "Geçerli bir Amazon Türkiye ürün bağlantısı girin.",
  UNSUPPORTED_URL: "Yalnızca /dp/ASIN ve /gp/product/ASIN bağlantıları destekleniyor.",
  PERMISSION_REQUIRED: "Amazon Türkiye erişimine izin verilmedi. Yeniden deneyebilirsiniz.",
  REDIRECT: "Amazon sayfayı başka bir adrese yönlendirdi; fiyat doğrulanamadı.",
  ACCESS_DENIED: "Amazon erişimi reddetti.",
  BOT_VERIFICATION: "Amazon robot doğrulaması istedi; fiyat okunamadı.",
  AUTH_REQUIRED: "Amazon giriş yapılmasını istiyor; fiyat okunamadı.",
  HTTP_ERROR: "Amazon sayfası yüklenemedi.",
  HTML_STRUCTURE: "Beklenen ürün fiyatı bölümü bulunamadı.",
  PRICE_MISSING: "Ürünün birincil fiyatı bulunamadı.",
  PRICE_AMBIGUOUS: "Birden çok birincil fiyat bulundu; sonuç güvenilir değil.",
  PRICE_UNRECOGNIZED: "Birincil fiyatın TL biçimi tanınamadı.",
  RESPONSE_TOO_LARGE: "Sayfa güvenli boyut sınırını aştı.",
  TIMEOUT: "Amazon yanıtı zaman aşımına uğradı.",
  NETWORK_ERROR: "Ağ veya ayrıştırma hatası oluştu.",
  PARSE_ERROR: "Ürün sayfası ayrıştırılamadı."
};

const formatPrice = value => new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY" }).format(value);
const formatTime = value => new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

function renderSection(element, heading, result) {
  element.replaceChildren();
  if (!result) { element.hidden = true; return; }
  const title = document.createElement("h2");
  title.textContent = heading;
  const detail = document.createElement("p");
  detail.className = result.status === "success" ? "price" : "error";
  detail.textContent = result.status === "success"
    ? formatPrice(result.priceTry)
    : errors[result.errorCode] || "Fiyat doğrulanamadı.";
  const meta = document.createElement("p");
  meta.className = "meta";
  meta.textContent = [result.asin, result.checkedAt && formatTime(result.checkedAt), result.errorCode, result.httpStatus && `HTTP ${result.httpStatus}`]
    .filter(Boolean).join(" · ");
  element.append(title, detail, meta);
  element.hidden = false;
}

function render(lastCheck, lastSuccess) {
  renderSection(latest, lastCheck?.status === "success" ? "Son başarılı kontrol" : "Son kontrol başarısız", lastCheck);
  const older = lastSuccess && (
    lastCheck?.status !== "success" || lastSuccess.checkedAt !== lastCheck.checkedAt
  ) ? lastSuccess : null;
  renderSection(previous, "Önceki başarılı kontrol (güncel değil)", older);
}

async function restore() {
  try {
    const { lastCheck, lastSuccess } = await chrome.storage.local.get(["lastCheck", "lastSuccess"]);
    if (lastCheck?.canonicalUrl) input.value = lastCheck.canonicalUrl;
    render(lastCheck, lastSuccess);
  } catch {
    status.textContent = "Kayıtlı sonuçlar okunamadı.";
  }
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  try {
    normalizeAmazonUrl(input.value);
  } catch (error) {
    status.textContent = errors[error.message] || errors.INVALID_URL;
    return;
  }

  button.disabled = true;
  status.textContent = "Fiyat kontrol ediliyor…";
  try {
    // İzin isteme çağrısı doğrudan kullanıcının tıklamasıyla başlar.
    try { await chrome.permissions.request({ origins: [origin] }); } catch { /* worker kaydeder */ }
    const result = await chrome.runtime.sendMessage({ type: "CHECK_PRICE", url: input.value });
    if (!result || !["success", "failure"].includes(result.status)) throw new Error("BAD_RESPONSE");
    status.textContent = result.storageError ? "Kontrol tamamlandı ancak sonuç yerel olarak kaydedilemedi." : "Kontrol tamamlandı.";
    const { lastCheck, lastSuccess } = await chrome.storage.local.get(["lastCheck", "lastSuccess"]);
    render(result.storageError ? result : lastCheck, lastSuccess);
  } catch {
    status.textContent = "Kontrol tamamlanamadı. Tekrar deneyin.";
  } finally {
    button.disabled = false;
  }
});

restore();
