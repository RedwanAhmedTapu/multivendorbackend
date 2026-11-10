# POS security + subscription — migration & rollout plan (PROPOSED, NOT APPLIED)

Nothing in this folder or in `../20261022200000_pos_baseline` has been run against
any database. They are **not** in `prisma/migrations`, so `prisma migrate deploy`
will not pick them up until someone deliberately moves them there.

## Findings that shape this plan

- `PosStaff`, `PosCustomer`, `PosBankAccount`, `PosSale`, `PosSaleItem`, `PosSettings`,
  `PosSubscription` (and `DiscountValueType`, `stock_movements.posSaleId`) are in the
  working-tree schema only. No migration creates them and HEAD's schema has none.
- Several tables the app relies on (e.g. `stock_movements`) are not created by any
  migration either, so migration history is not a complete baseline; the live
  database's real shape is the source of truth. Whether it already has the `pos_*`
  objects is **unverified** (no database was contacted).

## Order

1. `20261022200000_pos_baseline/migration.sql` — idempotent (IF NOT EXISTS /
   duplicate_object guards). Creates only what is missing.
2. `20261022210000_pos_subscription_lifecycle/migration.sql` — additive only:
   new enums + `pos_plans`, `pos_subscription_periods`, `pos_trial_grants`,
   `pos_subscription_payments`; new nullable/defaulted columns on
   `pos_subscriptions` (existing rows → `source = LEGACY`),
   `pos_sale_items.refundedQty DEFAULT 0`, and `pos_sales.soldByUserId` /
   `soldByEmployeeId` (who made the sale, from the session). No DROP, no type
   change, no data rewrite. `pos_staff` rows and `pos_sales.staffId` are kept
   untouched for historical attribution.

Checked offline: baseline + lifecycle create exactly the same objects as a
single diff from "no POS" to the current schema; neither file overlaps any
migration in `prisma/migrations`.

## Before applying (read-only, on a STAGING copy — needs explicit approval)

```bash
# What would change between the staging DB and the schema? (reads the DB, writes nothing)
npx prisma migrate diff --from-url "$STAGING_DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script > drift.sql
```

Expect only the statements in these two files. If `pos_*` tables exist with a
different shape, stop and reconcile — the baseline would skip them.

Then: apply both files to staging (`psql -f`, or move them into `prisma/migrations`
and `prisma migrate deploy` against staging), `prisma generate`, restart, run the
POS + subscription test suites, exercise checkout in the gateway **sandbox**.

## Rollback (lifecycle only; additive, so rollback is drop-new-objects)

```sql
ALTER TABLE "pos_subscriptions" DROP CONSTRAINT IF EXISTS "pos_subscriptions_planId_fkey";
DROP TABLE IF EXISTS "pos_subscription_payments", "pos_trial_grants", "pos_subscription_periods", "pos_plans";
ALTER TABLE "pos_subscriptions" DROP COLUMN IF EXISTS "planId", DROP COLUMN IF EXISTS "reminderSentFor",
  DROP COLUMN IF EXISTS "source", DROP COLUMN IF EXISTS "suspendedAt", DROP COLUMN IF EXISTS "suspendedReason",
  DROP COLUMN IF EXISTS "version";
ALTER TABLE "pos_sale_items" DROP COLUMN IF EXISTS "refundedQty";
DROP INDEX IF EXISTS "pos_sales_vendorId_soldByEmployeeId_idx";
ALTER TABLE "pos_sales" DROP COLUMN IF EXISTS "soldByUserId", DROP COLUMN IF EXISTS "soldByEmployeeId";
DROP TYPE IF EXISTS "PosSubscriptionSource", "PosPeriodKind", "PosSubPaymentStatus";
```
(Run only before any subscription payment exists — it deletes their history.)

## Rollout (no automatic lockout, no automatic backfill)

| Step | Action | Who |
|---|---|---|
| 1 | Deploy code with `POS_SUBSCRIPTION_ENFORCEMENT=monitor` **set explicitly** (the code default is `enforce` = fail closed). No POS secret is needed — the POS uses the normal FinixMart session. | ops |
| 2 | Apply the two migrations (after the staging run above). | ops, approved |
| 3 | `GET /api/admin/pos-subscriptions/rollout/dry-run` (ADMIN, read-only): lists every vendor, whether it uses POS, its entitlement state and the proposed action (`LEGACY_BACKFILL` for POS users without a subscription). Watch server logs for `[pos-entitlement] monitor: would deny`. | admin |
| 4 | Decide per vendor: complimentary grant (open-ended or until a cut-over date) via `POST /api/admin/pos-subscriptions/:vendorId/grant` (reason required, audited). No bulk backfill is performed by code. | business decision |
| 5 | Configure plans (`POST /plans`) and, if wanted, the trial policy (`PUT /policy` — trial is OFF until set; grace defaults to 0). | business decision |
| 6 | Re-run the dry-run until `wouldBeBlocked` is 0 for vendors that should keep access, then switch to `POS_SUBSCRIPTION_ENFORCEMENT=enforce`. | ops |
| 7 | Optionally `JOBS_ENABLED=1` for the expiry sweep (status tidy-up) and renewal reminders (in-app vendor notifications). Access never depends on the jobs. | ops |

## Decisions still open (not invented in code)

- Plan names, prices, durations; trial length (if any); grace days; cut-over date.
- Which existing POS vendors get complimentary/legacy access, and until when.
- Refund handling for subscription payments (manual: admin revokes/shortens; no gateway refund call).
- Authentication is the FinixMart session only (decided). PosStaff terminal logins are
  retired: no login route, no token, no POS_JWT_SECRET. Their rows stay (read-only
  list for the owner) because old sales reference them. Employees who used a PosStaff
  login need the new employee permissions (`posAccess`, and as needed `posDiscount`,
  `posCredit`, `posRefund`, `posReports`) granted by the vendor owner — nothing is
  copied automatically.
- Expiry policy (decided): without an ACTIVE/GRACE subscription every POS mutation is
  refused (sales, refunds, voids, due collection, customer writes, settings/bank changes);
  status, plans, checkout and vendor-scoped history reads stay available.

## Pre-existing issue noticed (not changed)

`payment-gateway.service.ts` references `PaymentMethod.PAYSTATION`, but the
`PaymentMethod` enum in the schema has no `PAYSTATION` value (TypeScript reports it;
the order PayStation path would fail at runtime). The POS subscription path does
not use `PaymentMethod`.
