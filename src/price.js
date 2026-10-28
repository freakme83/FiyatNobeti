import { normalizeCandidatePrices } from "./watchlist.js";

const PRIMARY_SELECTOR = "#corePrice_feature_div .a-offscreen";
const PAYABLE_PRICE_SELECTOR = "#apex-pricetopay-accessibility-label";
const UNIT_PRICE_CLASS_PREFIX = "apex-priceperuni";
const MAX_PRICE_ANCESTORS = 6;
const EXCLUDED_PRICE_CONTEXT = /(?:coupon|shipping|installment|monthly|used|other.?seller|recommend|similar|variation|format|unit|discount|list.?price)/i;
const NEW_OFFER_LABEL = /^Yenisini Satın Al(?:$|[\s:·–—])/iu;
const NON_NEW_OFFER_LABEL = /^(?:Kullanılmış|Yenilenmiş|İkinci el|Used|Refurbished|Renewed|Second hand)(?:$|[\s:·–—])/iu;

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

function leadingHeadingText(heading) {
  const parts = [];
  const appendSimpleText = node => {
    const nestedParts = [];
    for (const child of node?.childNodes || []) {
      if (child.nodeType === 3) {
        nestedParts.push(child.nodeValue || "");
        continue;
      }
      if (child.nodeType === 1 && ["STYLE", "SCRIPT"].includes(child.tagName?.toUpperCase())) continue;
      return null;
    }
    return nestedParts.join(" ");
  };

  for (const child of heading?.childNodes || []) {
    if (child.nodeType === 3) {
      parts.push(child.nodeValue || "");
      continue;
    }
    if (child.nodeType === 1 && ["STYLE", "SCRIPT"].includes(child.tagName?.toUpperCase())) continue;
    if (child.nodeType === 1 && ["SPAN", "DIV"].includes(child.tagName?.toUpperCase())) {
      const nested = appendSimpleText(child);
      if (nested === null) return "";
      parts.push(nested);
      continue;
    }
    return "";
  }
  const text = parts.join(" ").replace(/\s+/g, " ").trim();
  return text.length <= 120 ? text : "";
}

function primaryOfferCondition(candidate, primaryContainer) {
  const row = candidate?.closest?.(".a-accordion-row");
  if (!row) return { inOfferRow: false, condition: "unknown" };
  const rowIsRelatedToPrimary = primaryContainer?.contains?.(row) || row.contains?.(primaryContainer);
  const headings = [...row.querySelectorAll("h5")];
  if (!rowIsRelatedToPrimary || headings.length !== 1) return { inOfferRow: true, condition: "unknown" };
  const label = leadingHeadingText(headings[0]);
  if (NEW_OFFER_LABEL.test(label)) return { inOfferRow: true, condition: "new" };
  if (NON_NEW_OFFER_LABEL.test(label)) return { inOfferRow: true, condition: "non-new" };
  return { inOfferRow: true, condition: "unknown" };
}

// Informational only: a pair is never a trusted new-product price.
// Require two distinct price regions and offer rows, but do not require Amazon's
// optional ASIN/payable classes for an explicitly unverified presentation.
function unverifiedCandidates(doc, expectedAsin, candidates, containers) {
  if (!/^[A-Z0-9]{10}$/.test(expectedAsin || "") || candidates.length !== 2) return null;
  const identities = [...doc.querySelectorAll("#ASIN")];
  if (identities.some(node => node.getAttribute("value") && node.getAttribute("value") !== expectedAsin)) return null;
  const rows = candidates.map(candidate => candidate.closest?.(".a-accordion-row"));
  if (!rows[0] || !rows[1] || rows[0] === rows[1] ||
      rows[0].contains(rows[1]) || rows[1].contains(rows[0]) ||
      !containers[0] || !containers[1] || containers[0] === containers[1] ||
      containers[0].contains(containers[1]) || containers[1].contains(containers[0])) return null;
  for (let index = 0; index <2; index++) {
    const candidate = candidates[index];
    const container = containers[index];
    const row = rows[index];
    if (!row.contains(container) || !container.contains(candidate) || candidate.tagName !== "SPAN") return null;
    // A row's explicitly declared identity must agree, if Amazon provides one.
    for (const node of [row, ...row.querySelectorAll("[data-asin]")]) {
      const asin = node.getAttribute?.("data-asin");
      if (asin && asin !== expectedAsin) return null;
    }
    // Reject reference/strike/variant contexts, including ancestors of the
    // price and the region itself. Used offers remain displayable, never trusted.
    for (let node = candidate; node; node = node.parentElement) {
      if (["S", "DEL", "STRIKE"].includes(node.tagName) ||
          node.getAttribute?.("data-a-strike")?.toLowerCase() === "true" ||
          /(?:reference|strike|was.?price|a-text-price|variant|twister|swatch|list.?price)/i.test(`${node.id || ""} ${classNames(node)}`)) return null;
      if (node === row) break;
    }
  }
  return normalizeCandidatePrices(candidates.map(candidate => parseTurkishPrice(candidate.textContent)));
}

function extractPayablePriceFallback(doc) {
  const candidates = [...doc.querySelectorAll(PAYABLE_PRICE_SELECTOR)];
  if (candidates.length > 1) {
    return { status: "failure", errorCode: "PRICE_AMBIGUOUS" };
  }
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

export function extractPrimaryPrice(doc, expectedAsin = null) {
  const title = doc.title || "";
  const bodyText = doc.body?.textContent || "";
  // A verification form is structural evidence; incidental scripts and product text are not.
  const verificationForm = [...doc.querySelectorAll("form[action]")].some(form => {
    const action = form.getAttribute("action")?.trim();
    if (!action || !(/^(?:\/errors_page\/validateCaptcha|https:\/\/www\.amazon\.com\.tr\/errors_page\/validateCaptcha)(?:\?[^#]*)?$/.test(action))) return false;
    try {
      const url = new URL(action, "https://www.amazon.com.tr");
      return url.origin === "https://www.amazon.com.tr" && url.pathname === "/errors_page/validateCaptcha" &&
        !url.username && !url.password && !url.hash;
    } catch { return false; }
  });
  const challengeCopy = !doc.querySelector("#productTitle") && !doc.querySelector("#corePrice_feature_div") &&
    [...doc.querySelectorAll("p, label, h1, h2, h3")].some(node =>
      /enter the characters you see below|type the characters you see in this image|captcha required|doğrulama kodunu girin/i.test(node.textContent || ""));
  if (verificationForm || /robot check|captcha|automated access/i.test(title) || challengeCopy) {
    return { status: "failure", errorCode: "BOT_VERIFICATION" };
  }
  if (/access denied|erişim engellendi/i.test(title) ||
      /you don't have permission to access this page/i.test(bodyText)) {
    return { status: "failure", errorCode: "ACCESS_DENIED" };
  }
  if (/amazon sign.in|giriş yap/i.test(title) && doc.querySelector("#ap_email")) {
    return { status: "failure", errorCode: "AUTH_REQUIRED" };
  }
  const primaryContainers = [...doc.querySelectorAll("#corePrice_feature_div")];
  if (primaryContainers.length === 0) {
    return { status: "failure", errorCode: "HTML_STRUCTURE" };
  }
  const candidates = [...new Set(doc.querySelectorAll(PRIMARY_SELECTOR))]
    .filter(candidate => !isUnitPriceCandidate(candidate));
  const candidateContainers = candidates.map(candidate =>
    [...primaryContainers].reverse().find(container => container.contains(candidate)) || null);
  if (candidates.length === 1 && !candidates[0].textContent?.trim()) {
    return extractPayablePriceFallback(doc);
  }
  let selectedCandidate;
  if (candidates.length > 1) {
    const conditions = candidates.map((candidate, index) => primaryOfferCondition(candidate, candidateContainers[index]));
    const newOfferCount = conditions.filter(({ condition }) => condition === "new").length;
    const nonNewOfferCount = conditions.filter(({ condition }) => condition === "non-new").length;
    const unknownOfferCount = conditions.filter(({ condition }) => condition === "unknown").length;
    if (unknownOfferCount > 0) {
      const candidatePricesTry = unverifiedCandidates(doc, expectedAsin, candidates, candidateContainers);
      return { status: "failure", errorCode: "PRICE_AMBIGUOUS", ...(candidatePricesTry ? { candidatePricesTry } : {}) };
    }
    const newIndexes = conditions.flatMap(({ condition }, index) => condition === "new" ? [index] : []);
    if (newIndexes.length > 1) {
      const candidatePricesTry = unverifiedCandidates(doc, expectedAsin, candidates, candidateContainers);
      return { status: "failure", errorCode: "PRICE_AMBIGUOUS", ...(candidatePricesTry ? { candidatePricesTry } : {}) };
    }
    if (newIndexes.length === 0) return { status: "failure", errorCode: "PRICE_MISSING" };
    selectedCandidate = candidates[newIndexes[0]];
  } else if (candidates.length === 1) {
    const offer = primaryOfferCondition(candidates[0], candidateContainers[0]);
    if (offer.condition === "non-new") return { status: "failure", errorCode: "PRICE_MISSING" };
    selectedCandidate = candidates[0];
  }
  if (candidates.length === 0) {
    return extractPayablePriceFallback(doc);
  }
  const priceTry = parseTurkishPrice(selectedCandidate.textContent);
  return priceTry === null
    ? { status: "failure", errorCode: "PRICE_UNRECOGNIZED" }
    : { status: "success", priceTry };
}
