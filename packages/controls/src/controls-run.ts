/**
 * One pass of the data controls, for the platform's ledger.sync job: ledger integrity + price integrity +
 * budget health. Pure; the caller supplies rows and writes the findings as alerts.
 */
import type { Budget } from "@forge/contracts";
import type { Finding } from "./findings.ts";
import { checkLedger, type ProductPrice, type RawSale } from "./finance/ledger.ts";
import { budgetFindings } from "./finance/budget.ts";

export const API_ENVELOPE_BUDGET_ID = "bud_api_month";

export function runDataControls(input: { sales: RawSale[]; products: ProductPrice[]; budgets: Budget[]; modelUsageMonthToDateCents: number; unknownUsageRows?: number }): Finding[] {
  const f = [
    ...checkLedger(input.sales, input.products),
    ...budgetFindings(input.budgets, { budgetId: API_ENVELOPE_BUDGET_ID, cents: input.modelUsageMonthToDateCents, unknownRows: input.unknownUsageRows ?? 0 }),
  ];
  const seen = new Set<string>();
  return f.filter((x) => (seen.has(x.dedupeKey) ? false : (seen.add(x.dedupeKey), true)));
}
