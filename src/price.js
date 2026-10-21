const PRIMARY_SELECTOR = "#corePrice_feature_div .a-offscreen";
const UNIT_PRICE_CLASS_PREFIX = "apex-priceperuni";
const MAX_PRICE_ANCESTORS = 6;

function isUnitPriceCandidate(candidate) {
  let ancestor = candidate?.parentElement;
  for (let depth = 0; ancestor && depth < MAX_PRICE_ANCESTORS; depth++, ancestor = ancestor.parentElement) {
    const classes = ancestor.classList;
    if (!classes || !Number.isInteger(classes.length) || typeof classes.item !== "function") continue;
    for (let index = 0; index < classes.length; index++) {
      const className = classes.item(index);
      if (typeof className === "string" && className.startsWith(UNIT_PRICE_CLASS_PREFIX)) return true;
    }
  }
  return false;
}

export function parseTurkishPrice(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u00a0\u202f]/g, " ").trim();
  const match = /^(?:₺\s*)?((?:\d{1,3}(?:\.\d{3})+|\d+),\d{2})\s*(TL|₺)?$/i.exec(cleaned);
  if (!match || (!cleaned.startsWith("₺") && !match[2])) return null;
  const price = Number(match[1].replaceAll(".", "").replace(",", "."));
  return Number.isSafeInteger(Math.round(price * 100)) && price > 0 ? price : null;
}

export function extractPrimaryPrice(doc) {
  const title = doc.title || "";
  const bodyText = doc.body?.textContent || "";
  if (/robot check|captcha|automated access/i.test(title) ||
      /enter the characters you see below|type the characters you see in this image|captcha required|doğrulama kodunu girin/i.test(bodyText)) {
    return { status: "failure", errorCode: "BOT_VERIFICATION" };
  }
  if (/access denied|erişim engellendi/i.test(title) ||
      /you don't have permission to access this page/i.test(bodyText)) {
    return { status: "failure", errorCode: "ACCESS_DENIED" };
  }
  if (/amazon sign.in|giriş yap/i.test(title) && doc.querySelector("#ap_email")) {
    return { status: "failure", errorCode: "AUTH_REQUIRED" };
  }
  if (!doc.querySelector("#corePrice_feature_div")) {
    return { status: "failure", errorCode: "HTML_STRUCTURE" };
  }
  const candidates = [...doc.querySelectorAll(PRIMARY_SELECTOR)].filter(candidate => !isUnitPriceCandidate(candidate));
  if (candidates.length > 1) {
    return { status: "failure", errorCode: "PRICE_AMBIGUOUS" };
  }
  if (candidates.length === 0 || !candidates[0].textContent?.trim()) {
    return { status: "failure", errorCode: "PRICE_MISSING" };
  }
  const priceTry = parseTurkishPrice(candidates[0].textContent);
  return priceTry === null
    ? { status: "failure", errorCode: "PRICE_UNRECOGNIZED" }
    : { status: "success", priceTry };
}
