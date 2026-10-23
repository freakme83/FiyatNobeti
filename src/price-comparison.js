import { priceCents } from "./watchlist.js";

const money = new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const percent = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 2 });

export function compareWithBaseline(product) {
  const current = priceCents(product?.lastSuccessfulPriceTry);
  const baseline = priceCents(product?.baselinePriceTry);
  if (current === null || baseline === null || !["first", "migrated"].includes(product.baselineSource)) return null;
  const difference = current - baseline;
  const absolute = Math.abs(difference);
  const basisPoints = Math.round(absolute * 10_000 / baseline);
  const percentText = absolute && basisPoints === 0 ? "%0,01'den az" : `%${percent.format(basisPoints / 100)}`;
  const reference = product.baselineSource === "migrated" ? "Referans" : "İlk";
  return {
    direction: Math.sign(difference),
    headline: difference < 0 ? `↓ ${percentText} daha ucuz` : difference > 0 ? `↑ ${percentText} daha pahalı` : `${reference} fiyatıyla aynı`,
    detail: difference === 0 ? `${reference} fiyatından beri değişmedi` :
      `${reference} fiyatından beri ${money.format(absolute / 100)} daha ${difference < 0 ? "ucuz" : "pahalı"}`,
    baselineText: money.format(baseline / 100)
  };
}
