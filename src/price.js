const PRIMARY_SELECTOR = "#corePrice_feature_div .a-offscreen";
const PAYABLE_PRICE_SELECTOR = "#apex-pricetopay-accessibility-label";
const UNIT_PRICE_CLASS_PREFIX = "apex-priceperuni";
const MAX_PRICE_ANCESTORS = 6;
const EXCLUDED_PRICE_CONTEXT = /(?:coupon|shipping|installment|monthly|used|other.?seller|recommend|similar|variation|format|unit|discount|list.?price)/i;

export function extractProductTitle(doc) {
  const candidate = doc.querySelector("#productTitle")?.textContent;
  if (typeof candidate !== "string") return null;
  const title = candidate.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return title && title.length <= 200 && /[\p{L}\p{N}]/u.test(title) ? title : null;
}

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

function classNames(node) {
  const classes = node?.classList;
  if (!classes || !Number.isInteger(classes.length) || typeof classes.item !== "function") return "";
  return Array.from({ length: classes.length }, (_, index) => classes.item(index) || "").join(" ");
}

const PURCHASE_REGION_ANCHORS = [
  { selector: ".apex-core-price-identifier", matches: node => node?.classList?.contains?.("apex-core-price-identifier") },
  { selector: "#corePriceDisplay_desktop_feature_div", id: "corePriceDisplay_desktop_feature_div" },
  { selector: "#apex_offerDisplay_expanded", id: "apex_offerDisplay_expanded" },
  { selector: "#desktop_qualifiedBuyBox", id: "desktop_qualifiedBuyBox" }
];
const MAX_PURCHASE_REGION_DEPTH = 32;

/**
 * Recognize only the observed desktop Amazon price-to-pay structure. The named
 * anchors must be unique in the document and nested in this exact order; DIVs
 * may bridge the anchors. No price text is included in the result.
 */
export function inspectPayablePriceCandidate(doc, candidate) {
  if (candidate?.tagName?.toLowerCase() !== "span") {
    return { qualified: false, rejectionReason: "WRONG_ELEMENT_TAG", purchaseRegion: false };
  }

  let visited = 0;
  for (let ancestor = candidate.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (EXCLUDED_PRICE_CONTEXT.test(`${ancestor.id || ""} ${classNames(ancestor)}`)) {
      return { qualified: false, rejectionReason: "EXCLUDED_CONTEXT", purchaseRegion: false };
    }
    if (++visited >= MAX_PURCHASE_REGION_DEPTH) {
      return { qualified: false, rejectionReason: "ANCESTRY_DEPTH_LIMIT", purchaseRegion: false };
    }
  }

  for (const anchor of PURCHASE_REGION_ANCHORS) {
    if (doc.querySelectorAll(anchor.selector).length !== 1) {
      const count = doc.querySelectorAll(anchor.selector).length;
      return {
        qualified: false,
        rejectionReason: count > 1 ? "PURCHASE_REGION_ANCHOR_AMBIGUOUS" : "PURCHASE_REGION_ANCHOR_MISSING",
        purchaseRegion: false
      };
    }
  }

  let anchorIndex = 0;
  let previousNode = candidate;
  for (let ancestor = candidate.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (anchorIndex < PURCHASE_REGION_ANCHORS.length && PURCHASE_REGION_ANCHORS[anchorIndex].matches?.(ancestor)) {
      if (previousNode !== candidate && !onlyDivsBetween(previousNode, ancestor)) {
        return { qualified: false, rejectionReason: "PURCHASE_REGION_STRUCTURE_UNRECOGNIZED", purchaseRegion: false };
      }
      if (ancestor.tagName?.toLowerCase() !== "div") {
        return { qualified: false, rejectionReason: "PURCHASE_REGION_STRUCTURE_UNRECOGNIZED", purchaseRegion: false };
      }
      anchorIndex++;
      previousNode = ancestor;
      if (anchorIndex === PURCHASE_REGION_ANCHORS.length) break;
      continue;
    }
    const expectedId = PURCHASE_REGION_ANCHORS[anchorIndex]?.id;
    if (expectedId && ancestor.id === expectedId) {
      if (!onlyDivsBetween(previousNode, ancestor) || ancestor.tagName?.toLowerCase() !== "div") {
        return { qualified: false, rejectionReason: "PURCHASE_REGION_STRUCTURE_UNRECOGNIZED", purchaseRegion: false };
      }
      anchorIndex++;
      previousNode = ancestor;
      if (anchorIndex === PURCHASE_REGION_ANCHORS.length) break;
      continue;
    }
    if (ancestor.tagName?.toLowerCase() !== "div") {
      return { qualified: false, rejectionReason: "PURCHASE_REGION_STRUCTURE_UNRECOGNIZED", purchaseRegion: false };
    }
  }
  if (anchorIndex !== PURCHASE_REGION_ANCHORS.length) {
    return { qualified: false, rejectionReason: "PURCHASE_REGION_ORDER_INVALID", purchaseRegion: false };
  }
  if (parseTurkishPrice(typeof candidate.textContent === "string" ? candidate.textContent : "") === null) {
    return { qualified: false, rejectionReason: "UNRECOGNIZED_TRY_AMOUNT", purchaseRegion: true };
  }
  return { qualified: true, rejectionReason: null, purchaseRegion: true };
}

function onlyDivsBetween(descendant, ancestor) {
  for (let node = descendant.parentElement; node && node !== ancestor; node = node.parentElement) {
    if (node.tagName?.toLowerCase() !== "div") return false;
  }
  return true;
}

function extractPayablePriceFallback(doc) {
  const candidates = [...doc.querySelectorAll(PAYABLE_PRICE_SELECTOR)];
  if (candidates.length > 1) return { status: "failure", errorCode: "PRICE_AMBIGUOUS" };
  const candidate = candidates[0];
  if (!candidate) {
    return { status: "failure", errorCode: "PRICE_MISSING" };
  }
  const qualification = inspectPayablePriceCandidate(doc, candidate);
  if (!qualification.qualified) {
    return { status: "failure", errorCode: qualification.rejectionReason === "UNRECOGNIZED_TRY_AMOUNT" ? "PRICE_UNRECOGNIZED" : "PRICE_MISSING" };
  }
  const priceTry = parseTurkishPrice(candidate.textContent);
  return priceTry === null
    ? { status: "failure", errorCode: "PRICE_UNRECOGNIZED" }
    : { status: "success", priceTry };
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
  const primaryContainer = doc.querySelector("#corePrice_feature_div");
  if (!primaryContainer) {
    return { status: "failure", errorCode: "HTML_STRUCTURE" };
  }
  const candidates = [...doc.querySelectorAll(PRIMARY_SELECTOR)].filter(candidate => !isUnitPriceCandidate(candidate));
  if (candidates.length > 1) {
    return { status: "failure", errorCode: "PRICE_AMBIGUOUS" };
  }
  if (candidates.length === 0 || !candidates[0].textContent?.trim()) {
    return extractPayablePriceFallback(doc);
  }
  const priceTry = parseTurkishPrice(candidates[0].textContent);
  return priceTry === null
    ? { status: "failure", errorCode: "PRICE_UNRECOGNIZED" }
    : { status: "success", priceTry };
}
