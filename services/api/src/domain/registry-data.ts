// The git-versioned registry (repo /registry) is the authoritative seed for the platform database.
import niches from "../../../../registry/niches.json" with { type: "json" };
import products from "../../../../registry/products.json" with { type: "json" };
import registry from "../../../../registry/registry.json" with { type: "json" };
import channels from "../../../../registry/channels.json" with { type: "json" };
import integrations from "../../../../registry/integrations.json" with { type: "json" };
import accounts from "../../../../registry/accounts.json" with { type: "json" };
import costs from "../../../../registry/costs.json" with { type: "json" };
import budgets from "../../../../registry/budgets.json" with { type: "json" };
import alerts from "../../../../registry/alerts.json" with { type: "json" };

export const REGISTRY_DATA = { niches, products, registry, channels, integrations, accounts, costs, budgets, alerts };
export type RegistryData = typeof REGISTRY_DATA;
