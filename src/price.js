const PRIMARY_SELECTOR = "#corePrice_feature_div .a-offscreen";
const PAYABLE_PRICE_SELECTOR = "#apex-pricetopay-accessibility-label";
const UNIT_PRICE_CLASS_PREFIX = "apex-priceperuni";
const MAX_PRICE_ANCESTORS = 6;
const EXCLUDED_PRICE_CONTEXT = /(?:coupon|shipping|installment|monthly|used|other.?seller|recommend|similar|variation|format|unit|discount|list.?price)/i;
const NEW_OFFER_LABEL = /^Yenisini Satın Al(?:$|[\s:·–—])/iu;
const NON_NEW_OFFER_LABEL = /^(?:Kullanılmış|Yenilenmiş|İkinci el|Used|Refurbished|Renewed|Second hand)(?:$|[\s:·–—])/iu;
const MAX_AMBIGUITY_DIAGNOSTIC_COUNT = 100;
const MAX_PRIMARY_CANDIDATE_DIAGNOSTICS = 4;
const MAX_DIAGNOSTIC_ANCESTRY_DEPTH = 32;
const MAX_DIAGNOSTIC_HEADING_COUNT = 10;
const STOP_TAG_NAMES = new Set(["A", "B", "BR", "DIV", "EM", "I", "IMG", "INPUT", "PICTURE", "SCRIPT", "SMALL", "SPAN", "STYLE", "SUB", "SUP", "SVG"]);
const PAYABLE_CONTEXT_IDS = new Set([
  "apex-pricetopay-accessibility-label", "apex-pricetopay_feature_div", "apex_pricetopay_feature_div"
]);

function reportPriceAmbiguity(onAmbiguous, source, {
  primaryCandidateCount = 0,
  fallbackCandidateCount = null,
  newOfferCount = 0,
  nonNewOfferCount = 0,
  unknownOfferCount = 0,
  document,
  primaryContainerCount,
  primaryCandidates,
  primaryConditions,
  selectedPrimaryContainer
} = {}) {
  if (typeof onAmbiguous !== "function") return;
  const bounded = value => Math.min(MAX_AMBIGUITY_DIAGNOSTIC_COUNT, value);
  try {
    const report = {
      errorCode: "PRICE_AMBIGUOUS",
      source,
      primaryCandidateCount: bounded(primaryCandidateCount),
      fallbackCandidateCount: fallbackCandidateCount === null ? null : bounded(fallbackCandidateCount),
      newOfferCount: bounded(newOfferCount),
      nonNewOfferCount: bounded(nonNewOfferCount),
      unknownOfferCount: bounded(unknownOfferCount)
    };
    if (source === "PRIMARY_MULTIPLE_UNKNOWN") {
      report.primaryContainerCount = bounded(primaryContainerCount ?? document?.querySelectorAll?.("#corePrice_feature_div")?.length ?? 0);
      report.candidates = primaryCandidateDiagnostics(primaryCandidates, primaryConditions, selectedPrimaryContainer);
    }
    onAmbiguous(report);
  } catch { /* Diagnostics must never affect price extraction. */ }
}

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

function diagnosticTagName(node) {
  const name = typeof node?.tagName === "string" ? node.tagName.toUpperCase() : "";
  return STOP_TAG_NAMES.has(name) ? name : "OTHER";
}

function leadingHeadingText(heading) {
  const parts = [];
  let stopTag = null;
  const appendSimpleText = node => {
    for (const child of node?.childNodes || []) {
      if (child.nodeType === 3) {
        parts.push(child.nodeValue || "");
        continue;
      }
      if (child.nodeType === 1 && ["STYLE", "SCRIPT"].includes(child.tagName?.toUpperCase())) continue;
      return { complete: false, stopTag: diagnosticTagName(child) };
    }
    return { complete: true, stopTag: null };
  };

  for (const child of heading?.childNodes || []) {
    if (child.nodeType === 3) {
      parts.push(child.nodeValue || "");
      continue;
    }
    if (child.nodeType === 1 && ["STYLE", "SCRIPT"].includes(child.tagName?.toUpperCase())) continue;
    if (child.nodeType === 1 && child.tagName?.toUpperCase() === "SPAN") {
      const nested = appendSimpleText(child);
      if (nested.complete) continue;
      stopTag = nested.stopTag || "SPAN";
      break;
    }
    // Read only direct heading text and a simple, direct text wrapper.
    stopTag = diagnosticTagName(child);
    break;
  }
  return { text: parts.join(" ").replace(/\s+/g, " ").trim(), stopTag };
}

function primaryOfferCondition(candidate, primaryContainer) {
  const row = candidate?.closest?.(".a-accordion-row");
  if (!row) return { inOfferRow: false, condition: "unknown", row: null, headingCount: 0, unknownReason: "ROW_MISSING", headingStopTag: null };
  const rowIsRelatedToPrimary = primaryContainer?.contains?.(row) || row.contains?.(primaryContainer);
  const headings = [...row.querySelectorAll("h5")];
  const details = { inOfferRow: true, row, headingCount: headings.length, headingStopTag: null };
  if (!rowIsRelatedToPrimary) return { ...details, condition: "unknown", unknownReason: "ROW_RELATION_INVALID" };
  if (headings.length !== 1) return { ...details, condition: "unknown", unknownReason: "HEADING_COUNT_UNEXPECTED" };
  const headingText = leadingHeadingText(headings[0]);
  if (NEW_OFFER_LABEL.test(headingText.text)) return { ...details, headingStopTag: headingText.stopTag, condition: "new", unknownReason: null };
  if (NON_NEW_OFFER_LABEL.test(headingText.text)) return { ...details, headingStopTag: headingText.stopTag, condition: "non-new", unknownReason: null };
  return {
    ...details,
    headingStopTag: headingText.stopTag,
    condition: "unknown",
    unknownReason: headingText.text ? "HEADING_LABEL_UNRECOGNIZED" : "HEADING_TEXT_UNREADABLE"
  };
}

function hasDiagnosticAncestor(candidate, predicate) {
  let node = candidate;
  for (let depth = 0; node && depth < MAX_DIAGNOSTIC_ANCESTRY_DEPTH; depth++, node = node.parentElement) {
    if (predicate(node)) return true;
  }
  return false;
}

function primaryCandidateDiagnostics(candidates, conditions, selectedPrimaryContainer) {
  const parsedCents = candidates.map(candidate => {
    const price = parseTurkishPrice(typeof candidate?.textContent === "string" ? candidate.textContent : "");
    return price === null ? null : Math.round(price * 100);
  });
  const rows = conditions.map(({ row }) => row);
  return candidates.slice(0, MAX_PRIMARY_CANDIDATE_DIAGNOSTICS).map((candidate, index) => {
    const condition = conditions[index];
    return {
      priceFormatValid: parsedCents[index] !== null,
      sameParsedAmount: parsedCents[index] !== null && parsedCents.some((amount, otherIndex) => otherIndex !== index && amount === parsedCents[index]),
      isStrikePrice: hasDiagnosticAncestor(candidate, node =>
        node.classList?.contains?.("a-text-price") || node.getAttribute?.("data-a-strike") === "true"),
      isPriceToPay: hasDiagnosticAncestor(candidate, node =>
        node.classList?.contains?.("priceToPay") || node.classList?.contains?.("apex-pricetoprice") || PAYABLE_CONTEXT_IDS.has(node.id)),
      hasAccordionRow: Boolean(condition.row),
      sameAccordionRow: Boolean(condition.row && rows.some((row, otherIndex) => otherIndex !== index && row === condition.row)),
      headingCount: Math.min(MAX_DIAGNOSTIC_HEADING_COUNT, condition.headingCount),
      unknownReason: condition.unknownReason || "NOT_UNKNOWN",
      headingStopTag: condition.headingStopTag,
      candidateInsideSelectedPrimaryContainer: Boolean(selectedPrimaryContainer?.contains?.(candidate))
    };
  });
}

function extractPayablePriceFallback(doc, onAmbiguous, primaryCandidateCount) {
  const candidates = [...doc.querySelectorAll(PAYABLE_PRICE_SELECTOR)];
  if (candidates.length > 1) {
    reportPriceAmbiguity(onAmbiguous, "FALLBACK_MULTIPLE", {
      primaryCandidateCount,
      fallbackCandidateCount: candidates.length
    });
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

export function extractPrimaryPrice(doc, onAmbiguous) {
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
  const primaryContainer = doc.querySelector("#corePrice_feature_div");
  if (!primaryContainer) {
    return { status: "failure", errorCode: "HTML_STRUCTURE" };
  }
  const candidates = [...doc.querySelectorAll(PRIMARY_SELECTOR)].filter(candidate => !isUnitPriceCandidate(candidate));
  if (candidates.length === 1 && !candidates[0].textContent?.trim()) {
    return extractPayablePriceFallback(doc, onAmbiguous, candidates.length);
  }
  let selectedCandidate;
  if (candidates.length > 1) {
    const conditions = candidates.map(candidate => primaryOfferCondition(candidate, primaryContainer));
    const newOfferCount = conditions.filter(({ condition }) => condition === "new").length;
    const nonNewOfferCount = conditions.filter(({ condition }) => condition === "non-new").length;
    const unknownOfferCount = conditions.filter(({ condition }) => condition === "unknown").length;
    const counts = {
      primaryCandidateCount: candidates.length,
      newOfferCount,
      nonNewOfferCount,
      unknownOfferCount
    };
    if (unknownOfferCount > 0) {
      reportPriceAmbiguity(onAmbiguous, "PRIMARY_MULTIPLE_UNKNOWN", {
        ...counts,
        document: doc,
        primaryCandidates: candidates,
        primaryConditions: conditions,
        selectedPrimaryContainer: primaryContainer
      });
      return { status: "failure", errorCode: "PRICE_AMBIGUOUS" };
    }
    const newIndexes = conditions.flatMap(({ condition }, index) => condition === "new" ? [index] : []);
    if (newIndexes.length > 1) {
      reportPriceAmbiguity(onAmbiguous, "PRIMARY_MULTIPLE_NEW", counts);
      return { status: "failure", errorCode: "PRICE_AMBIGUOUS" };
    }
    if (newIndexes.length === 0) return { status: "failure", errorCode: "PRICE_MISSING" };
    selectedCandidate = candidates[newIndexes[0]];
  } else if (candidates.length === 1) {
    const offer = primaryOfferCondition(candidates[0], primaryContainer);
    if (offer.condition === "non-new") return { status: "failure", errorCode: "PRICE_MISSING" };
    selectedCandidate = candidates[0];
  }
  if (candidates.length === 0) {
    return extractPayablePriceFallback(doc, onAmbiguous, candidates.length);
  }
  const priceTry = parseTurkishPrice(selectedCandidate.textContent);
  return priceTry === null
    ? { status: "failure", errorCode: "PRICE_UNRECOGNIZED" }
    : { status: "success", priceTry };
}
