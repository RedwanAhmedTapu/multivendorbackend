-- PROPOSED — NOT APPLIED. Optional data alignment for the POS customer-credit change (2026-10-25).
--
-- PosCustomer.due is the authoritative outstanding debt. From this release every
-- sale / refund / void / due collection writes loanBalance = due in the same
-- statement. Rows written earlier may still differ. No code before this release
-- ever wrote loanBalance (git history of src/: no writer), so legacy values are
-- expected to be the column default 0. The code does NOT depend on this
-- migration (the UI and the credit rule read `due`); it only makes the mirror
-- column agree. No sale, voucher or ledger entry is touched.
--
-- Run reconciliation query (a) in README.md FIRST: where `due` itself is wrong
-- (refunds/voids before this release never reduced it), correct `due` through
-- an approved accounting adjustment before syncing, or the wrong value is mirrored.
--
-- Repeatable: the backup table is created only on the first run (IF NOT EXISTS),
-- and the UPDATE only touches rows that still differ.
-- Rollback: UPDATE "public"."pos_customers" c SET "loanBalance" = b."loanBalance"
--             FROM "public"."pos_customers_loan_balance_backup_20261025" b WHERE b."id" = c."id";
--           (rows not in the backup had loanBalance = 0 before the sync).
-- The backup table is not in schema.prisma: drop it once the result is verified,
-- before the next `prisma migrate dev` drift check.

-- Keep any non-zero value that differs — the only ones that could have been set on purpose.
CREATE TABLE IF NOT EXISTS "public"."pos_customers_loan_balance_backup_20261025" AS
  SELECT "id", "vendorId", "loanBalance", "due", NOW() AS "backedUpAt"
    FROM "public"."pos_customers"
   WHERE "loanBalance" <> 0 AND "loanBalance" IS DISTINCT FROM "due";

UPDATE "public"."pos_customers"
   SET "loanBalance" = "due"
 WHERE "loanBalance" IS DISTINCT FROM "due";
