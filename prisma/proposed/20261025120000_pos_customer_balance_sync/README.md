# POS customer balance sync + reconciliation (proposed — not applied)

This accompanies the POS customer-credit implementation (`docs/POS_CUSTOMER_CREDIT_AUDIT.md`, §16–§17).

**No schema migration is required by the code.** The per-vendor "POS Customer Receivable" chart-of-accounts row is created on a vendor's first credit sale and seeded for new vendors.

Nothing in this folder has been run against a real, development, staging or production database.

**Status (2026-10-25):** not required by the code and deliberately not promoted to `prisma/migrations/`. Apply it only after a verified backup and the review of query (a).

## Order of operations (staging first)

1. Run the read-only queries in §2 and review them with whoever owns the books.
2. Correct customer `due` values only through an approved adjustment. Nothing here does that.
3. Optionally apply `migration.sql`, which copies `due` into `loanBalance`, backing up any non-zero differing value first.
4. Verify the result, then drop `pos_customers_loan_balance_backup_20261025`.

## 1. `migration.sql` (optional)

- **What it does:** `loanBalance` is a mirror of `due` and no code reads it for decisions. The migration backs up any non-zero `loanBalance` that differs from `due`, then sets `loanBalance = due`.
- **Repeatable:** a second run changes nothing and keeps the first backup.
- **Tested:** it was run twice against a disposable table in a throwaway local PostgreSQL 18 cluster only.

## 2. Read-only reconciliation queries

Wrap them in `BEGIN READ ONLY; … ROLLBACK;`. Each query returns one row per vendor or customer; add `AND <alias>."vendorId" = '<vendor>'` to look at a single store.

```sql
-- a) Customer due vs. what their open sales still owe.
SELECT c."vendorId", c.id, c.name, c.due,
       COALESCE(SUM(s."dueAmount") FILTER (WHERE s.status NOT IN ('REFUNDED','VOIDED')), 0) AS open_sale_due
  FROM pos_customers c
  LEFT JOIN pos_sales s ON s."customerId" = c.id AND s."vendorId" = c."vendorId"
 GROUP BY c.id
HAVING abs(c.due - COALESCE(SUM(s."dueAmount") FILTER (WHERE s.status NOT IN ('REFUNDED','VOIDED')), 0)) > 0.005;

-- b) POS postings on "Receivable from Platform" (made before this release; collections and
--    refunds of those legacy sales keep clearing this same account).
SELECT le."entityId" AS vendor_id, SUM(le."debitAmount") - SUM(le."creditAmount") AS pos_balance
  FROM ledger_entries le
  JOIN chart_of_accounts a ON a.id = le."accountId"
 WHERE a.name = 'Receivable from Platform' AND a."entityType" = 'VENDOR'
   AND le."referenceType" IN ('pos_invoice', 'pos_due_payment', 'pos_refund')
 GROUP BY le."entityId";

-- c) What POS sales added to VendorPayable before this release (each added its netBilling to
--    totalSales / totalPayable / balance). Compare with vendor_payables.balance.
SELECT s."vendorId", SUM(s."netBilling") AS pos_net_billing, vp.balance AS payable_balance
  FROM pos_sales s
  LEFT JOIN vendor_payables vp ON vp."vendorId" = s."vendorId"
 WHERE s."saleDate" < TIMESTAMP '2026-10-25 00:00:00'   -- set to the deploy time of this release
 GROUP BY s."vendorId", vp.balance;

-- d) Payout drift, as getDriftReport computes it: platform "Vendor Payables" (credit nature)
--    minus all vendors' "Receivable from Platform" (debit nature).
SELECT
  (SELECT COALESCE(SUM(le."creditAmount" - le."debitAmount"), 0)
     FROM ledger_entries le JOIN chart_of_accounts a ON a.id = le."accountId"
    WHERE a."entityType" = 'ADMIN' AND a.name = 'Vendor Payables') -
  (SELECT COALESCE(SUM(le."debitAmount" - le."creditAmount"), 0)
     FROM ledger_entries le JOIN chart_of_accounts a ON a.id = le."accountId"
    WHERE a."entityType" = 'VENDOR' AND a.name = 'Receivable from Platform') AS drift;
```

### How to read them

| Query | A row means | Typical cause | What to do (owner decision) |
|---|---|---|---|
| a | `due` ≠ what the customer's open sales still owe | a refund/void before this release didn't reduce `due` (customer over-stated), or a partly refunded credit sale | correct `due` with an approved adjustment, and tell the customer |
| b | POS customer debt still sits in the marketplace settlement account | credit sales before this release | reclassify the open balance to "POS Customer Receivable" with an approved journal; or let collections/refunds clear it naturally |
| c | `pos_net_billing` is part of `payable_balance` | POS sales before this release raised the payout liability | reduce the payable by that amount before payouts are ever enabled; don't pay it out |
| d | non-zero drift blocks a payout batch | (b) contributes; so do any non-POS differences | resolve (b) and any other drift before enabling payouts |

**Tested:** these queries were run inside a `READ ONLY` transaction against minimal stand-in tables in the throwaway cluster, to check syntax and grouping. They have not been run on real data.
