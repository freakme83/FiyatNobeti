import { parseAmazonInput } from "./src/url.js";

const origin = "https://www.amazon.com.tr/*";
const shortLinkOrigin = "https://amzn.eu/*";
const form = document.querySelector("#probe-form");
const input = document.querySelector("#product-url");
const button = document.querySelector("#check-button");
const status = document.querySelector("#status");
const latest = document.querySelector("#latest");
const previous = document.querySelector("#previous");

const errors = {
  INVALID_URL: "Güvenli ve geçerli bir Amazon bağlantısı girin.",
  UNSUPPORTED_URL: "Bu Amazon bağlantı biçimi desteklenmiyor.",
  UNSUPPORTED_MARKETPLACE: "Bu bağlantı Amazon Türkiye'ye ait değil.",
  PERMISSION_REQUIRED: "Amazon Türkiye izni verilmedi.",
  SHORT_LINK_PERMISSION_REQUIRED: "Kısa Amazon bağlantısı izni verilmedi.",
  SHORT_LINK_RESOLUTION_FAILED: "Kısa Amazon bağlantısı çözümlenemedi.",
  SHORT_LINK_REDIRECT_LOOP: "Kısa bağlantıda yönlendirme döngüsü algılandı.",
  SHORT_LINK_TOO_MANY_REDIRECTS: "Kısa bağlantı çok fazla kez yönlendirildi.",
  UNSAFE_REDIRECT: "Kısa bağlantı güvenli olmayan bir adrese yönlendirildi.",
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
  let request;
  try {
    request = parseAmazonInput(input.value);
  } catch (error) {
    status.textContent = errors[error.message] || errors.INVALID_URL;
    return;
  }

  button.disabled = true;
  status.textContent = request.type === "short"
    ? "Amazon bağlantısı çözümleniyor…"
    : "Fiyat kontrol ediliyor…";
  try {
    const origins = request.type === "short" ? [origin, shortLinkOrigin] : [origin];
    // İzin isteme çağrısı doğrudan kullanıcının tıklamasıyla başlar.
    try { await chrome.permissions.request({ origins }); } catch { /* worker kaydeder */ }
    const result = await chrome.runtime.sendMessage({ type: "CHECK_PRICE", url: input.value });
    if (!result || !["success", "failure"].includes(result.status)) throw new Error("BAD_RESPONSE");
    if (result.canonicalUrl) input.value = result.canonicalUrl;
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
