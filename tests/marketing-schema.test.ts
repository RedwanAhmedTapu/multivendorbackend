// tests/marketing-schema.test.ts
//
// Marketing Center Phase 1 — static checks on prisma/schema.prisma and the
// migration file (no database, no generated client needed):
//   - every approved table exists and maps to its snake_case name;
//   - all money is Decimal(18,4) (no Float) and money history cannot be
//     cascaded away (onDelete: Restrict);
//   - the agreed column changes exist and are nullable/additive;
//   - the unused Advertisement model is gone, and the migration refuses to
//     drop a non-empty `advertisements` table;
//   - the CHECK constraints for money/stock invariants are present.
//   npx tsx --test tests/marketing-schema.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
const migration = readFileSync(new URL("../prisma/migrations/20261015120000_marketing_center_phase1/migration.sql", import.meta.url), "utf8");

function model(name: string): string {
  const m = schema.match(new RegExp(`\\nmodel ${name} \\{([\\s\\S]*?)\\n\\}`));
  assert.ok(m, `model ${name} exists`);
  return m![1];
}
const field = (body: string, name: string) => body.split("\n").find((l) => new RegExp(`^\\s+${name}\\s`).test(l)) ?? "";

const TABLES: Record<string, string> = {
  MarketingCampaign: "marketing_campaigns",
  MarketingCampaignCategory: "marketing_campaign_categories",
  MarketingCampaignInvite: "marketing_campaign_invites",
  CampaignRegistration: "campaign_registrations",
  FlashSaleSlot: "flash_sale_slots",
  FlashSaleItem: "flash_sale_items",
  Promotion: "promotions",
  PromotionProduct: "promotion_products",
  FlexiComboTier: "flexi_combo_tiers",
  PromotionRedemption: "promotion_redemptions",
  VendorCoinsSetting: "vendor_coins_settings",
  VendorCoinsSettingHistory: "vendor_coins_setting_history",
  CoinsFundingRule: "coins_funding_rules",
  VendorAdWallet: "vendor_ad_wallets",
  VendorAdWalletTxn: "vendor_ad_wallet_txns",
  AdTopupPayment: "ad_topup_payments",
  AdCampaign: "ad_campaigns",
  AdCampaignProduct: "ad_campaign_products",
  AdClick: "ad_clicks",
  AdDailyStat: "ad_daily_stats",
  OrderItemDiscount: "order_item_discounts",
};

test("all approved Marketing Center tables exist, mapped, and are created by the migration", () => {
  for (const [name, table] of Object.entries(TABLES)) {
    assert.match(model(name), new RegExp(`@@map\\("${table}"\\)`), name);
    assert.match(migration, new RegExp(`CREATE TABLE "public"\\."${table}"`), `migration creates ${table}`);
  }
});

test("money is Decimal(18,4) everywhere in the new models; no Float", () => {
  const money = /^(amount|balance|balanceAfter|campaignPrice|originalPrice|flashPrice|discountValue|maxDiscount|minSpend|minAmount|dailyBudget|bidCpc|spentToday|chargedAmount|spend|revenue|sellerFunded|platformFunded|reversedAmount)$/;
  for (const name of Object.keys(TABLES)) {
    const body = model(name);
    assert.doesNotMatch(body, /\sFloat\b/, `${name} has no Float`);
    for (const line of body.split("\n")) {
      const [f, type] = line.trim().split(/\s+/);
      if (f && money.test(f)) {
        assert.match(type, /^Decimal\??$/, `${name}.${f} is Decimal`);
        assert.match(line, /@db\.Decimal\(18, 4\)/, `${name}.${f} is Decimal(18,4)`);
      }
    }
  }
});

test("money history cannot be cascaded away: wallet txns, top-ups, clicks, redemptions and discount rows restrict deletes", () => {
  const restrict = (m: string, rel: string) => assert.match(field(model(m), rel), /onDelete: Restrict/, `${m}.${rel}`);
  restrict("VendorAdWallet", "vendor");
  for (const rel of ["wallet", "vendor"]) restrict("VendorAdWalletTxn", rel);
  for (const rel of ["vendor", "wallet"]) restrict("AdTopupPayment", rel);
  restrict("AdClick", "vendor");
  for (const rel of ["promotion", "order", "user"]) restrict("PromotionRedemption", rel);
  for (const rel of ["order", "vendorOrder", "orderItem", "vendor"]) restrict("OrderItemDiscount", rel);
});

test("idempotency keys are unique on every money-moving table", () => {
  for (const m of ["PromotionRedemption", "VendorAdWalletTxn", "AdTopupPayment"]) {
    assert.match(field(model(m), "idempotencyKey"), /String\s+@unique/, m);
  }
  assert.match(field(model("AdClick"), "dedupeKey"), /String\s+@unique/);
  assert.match(field(model("LoyaltyTransaction"), "idempotencyKey"), /String\?\s+@unique/);
});

test("approved changes to existing tables are additive and nullable", () => {
  const lt = model("LoyaltyTransaction");
  assert.match(field(lt, "orderId"), /String\?/);
  assert.match(field(lt, "balanceAfter"), /Int\?/);
  const oi = model("OrderItem");
  assert.match(field(oi, "listPrice"), /Decimal\?\s+@db\.Decimal\(18, 4\)/);
  assert.match(field(oi, "priceSource"), /ItemPriceSource\?/);
  assert.match(migration, /ALTER TABLE "public"\."order_items" ADD COLUMN\s+"listPrice" DECIMAL\(18,4\),\s*ADD COLUMN\s+"priceSource"/);
  assert.match(migration, /CREATE UNIQUE INDEX "loyalty_transactions_idempotencyKey_key"/);
  // Payment.orderId stays required (top-ups use AdTopupPayment instead).
  assert.match(field(model("Payment"), "orderId"), /String\s*$/);
  for (const v of ["PROMOTION_SUBSIDY", "AD_WALLET_TOPUP", "AD_SPEND"]) assert.match(migration, new RegExp(`ADD VALUE '${v}'`));
});

test("no existing column is dropped or retyped; the only drop is the unused advertisements table", () => {
  assert.doesNotMatch(migration, /DROP COLUMN|ALTER COLUMN/);
  const drops = [...migration.matchAll(/DROP TABLE "public"\."(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(drops, ["advertisements"]);
  assert.doesNotMatch(schema.replace(/\/\/.*$/gm, ""), /\bmodel Advertisement\b|\bAdvertisement\[\]/);
});

test("the migration aborts before dropping a non-empty advertisements table", () => {
  const guard = migration.indexOf('IF EXISTS (SELECT 1 FROM "public"."advertisements"');
  const raise = migration.indexOf("RAISE EXCEPTION", guard);
  const firstTouch = migration.indexOf('ALTER TABLE "public"."advertisements"');
  const drop = migration.indexOf('DROP TABLE "public"."advertisements"');
  assert.ok(guard > 0 && raise > guard, "guard present");
  assert.ok(guard < firstTouch && firstTouch < drop, "guard runs before the table is touched");
});

test("CHECK constraints for money and stock invariants are present", () => {
  for (const c of [
    "vendor_ad_wallets_balance_chk",
    "flash_sale_items_stock_chk",
    "order_item_discounts_split_chk",
    "order_item_discounts_reversal_chk",
    "order_item_discounts_scope_chk",
    "vendor_coins_settings_rate_chk",
    "coins_funding_rules_chk",
    "campaign_registrations_price_chk",
    "promotions_amounts_chk",
    "loyalty_transactions_balance_after_chk",
  ]) {
    assert.match(migration, new RegExp(`"${c}" CHECK`), c);
  }
  assert.match(migration, /"vendor_ad_wallets_balance_chk" CHECK \("balance" >= 0\)/);
  assert.match(migration, /"soldQty" <= "stockLimit"/);
  assert.match(migration, /"amount" = "sellerFunded" \+ "platformFunded"/);
});

// ── merge migration: vendor programme belongs to a campaign page ─────────────

const merge = readFileSync(new URL("../prisma/migrations/20261016120000_marketing_programme_on_campaign_page/migration.sql", import.meta.url), "utf8");

test("merge migration aborts when marketing_campaigns has rows, before changing anything", () => {
  const guard = merge.indexOf('IF EXISTS (SELECT 1 FROM "public"."marketing_campaigns"');
  assert.ok(guard > 0 && merge.indexOf("RAISE EXCEPTION", guard) > guard, "guard present");
  const firstChange = merge.search(/^(ALTER|DROP|CREATE)/m);
  assert.ok(guard < firstChange, "guard runs before the first schema change");
});

test("merge migration only alters marketing_campaigns; campaign_pages and every other table untouched", () => {
  const touched = [...merge.matchAll(/^(?:ALTER TABLE|DROP INDEX|CREATE (?:UNIQUE )?INDEX "[^"]+" ON) "public"\."(\w+)"/gm)].map((m) => m[1]);
  const indexDrops = [...merge.matchAll(/^DROP INDEX "public"\."(\w+)"/gm)].map((m) => m[1]);
  assert.ok(indexDrops.every((i) => i.startsWith("marketing_campaigns_")), "only marketing_campaigns indexes dropped");
  assert.deepEqual([...new Set(touched.filter((t) => !t.startsWith("marketing_campaigns_")))], ["marketing_campaigns"]);
  assert.doesNotMatch(merge, /ALTER TABLE "public"\."campaign_pages"/);
  assert.doesNotMatch(merge, /DROP TABLE/);
});

test("merge migration: campaignPageId NOT NULL + unique + FK RESTRICT; duplicated columns dropped; window CHECK replaced", () => {
  assert.match(merge, /ADD COLUMN\s+"campaignPageId" TEXT NOT NULL/);
  assert.match(merge, /CREATE UNIQUE INDEX "marketing_campaigns_campaignPageId_key"/);
  assert.match(merge, /FOREIGN KEY \("campaignPageId"\) REFERENCES "public"\."campaign_pages"\("id"\) ON DELETE RESTRICT/);
  for (const c of ["bannerImage", "description", "endAt", "name", "slug", "startAt"]) assert.match(merge, new RegExp(`DROP COLUMN "${c}"`), c);
  assert.match(merge, /DROP CONSTRAINT IF EXISTS "marketing_campaigns_windows_chk"/);
  assert.match(merge, /"marketing_campaigns_registration_window_chk" CHECK \("registrationStartAt" < "registrationEndAt"\)/);
  const mc = model("MarketingCampaign");
  assert.match(field(mc, "campaignPageId"), /String\s+@unique/);
  assert.match(field(mc, "campaignPage"), /onDelete: Restrict/);
  for (const gone of ["name", "slug", "startAt", "endAt", "bannerImage", "description"]) assert.equal(field(mc, gone), "", `${gone} removed`);
  assert.match(field(model("CampaignPage"), "marketingCampaign"), /MarketingCampaign\?/);
});
