import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Brief } from "../src/brief.ts";
import type { RegistryProduct } from "../src/generate.ts";

export const NICHES = ["bidline", "quilt-plan-kit", "loaf-ledger"] as const;
export const loadBrief = (niche: string): Brief => JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", `${niche}.brief.json`), "utf8"));
export const registryProducts = (): RegistryProduct[] => JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "registry", "products.json"), "utf8")).products;
export const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

/** A synthetic brief for a business that does not exist. Test data only: not research, never shown as such. */
export function syntheticNewBusinessBrief(): Brief {
  const b = clone(loadBrief("loaf-ledger"));
  b.niche = "test-new-business"; b.brief_id = "brief_test-new-business_v1-0-0"; b.display_name = "Test New Business"; b.version = "1.0.0";
  return b;
}
