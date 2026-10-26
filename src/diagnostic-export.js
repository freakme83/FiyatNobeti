import { normalizeDiagnosticHistory, PRICE_CHECK_DIAGNOSTICS_KEY } from "./price-check-diagnostics.js";

export async function copyDiagnosticHistory(storage, clipboard) {
  const stored = await storage.get(PRICE_CHECK_DIAGNOSTICS_KEY);
  const history = normalizeDiagnosticHistory(stored[PRICE_CHECK_DIAGNOSTICS_KEY]);
  if (!history.entries.length) return "empty";
  await clipboard.writeText(JSON.stringify(history, null, 2));
  return "copied";
}
