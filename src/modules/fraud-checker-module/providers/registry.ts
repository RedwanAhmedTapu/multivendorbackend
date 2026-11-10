import type { IFraudCheckerAdapter } from "../types.ts";
import { nirvorProvider } from "./nirvor.provider.ts";
import { fraudBdProvider } from "./fraudbd.provider.ts";

// ============================================================
// ADAPTER REGISTRY
// To add a new fraud checker (e.g. "FraudShield BD", "Mr Fraud
// Checker"):
//   1. Create providers/<slug>.provider.ts implementing IFraudCheckerAdapter
//      (copy nirvor.provider.ts or fraudbd.provider.ts as a template).
//   2. Import it below and add one line to ADAPTERS.
//   3. In the admin panel, create a FraudCheckerProvider row with a
//      matching `slug`, fill in credentials, and toggle it active.
// No other file needs to change — the service and admin panel are
// fully generic over whatever is registered here.
//
// To REMOVE a provider from active use, no code change is needed at
// all: just deactivate (or delete) its row from the admin panel.
// Removing it from this list too is only necessary if you want the
// adapter code itself gone from the bundle.
// ============================================================

const ADAPTERS: IFraudCheckerAdapter[] = [nirvorProvider, fraudBdProvider];

const REGISTRY = new Map<string, IFraudCheckerAdapter>(ADAPTERS.map((a) => [a.slug, a]));

export function getAdapter(slug: string): IFraudCheckerAdapter | undefined {
  return REGISTRY.get(slug);
}

export function listRegisteredAdapters(): IFraudCheckerAdapter[] {
  return ADAPTERS;
}
