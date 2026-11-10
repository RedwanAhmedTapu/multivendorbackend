# AI context — FinixMart backend (POS customer credit)

_Created 2026-10-25 with the POS customer-credit change. It covers only the POS customer-credit area. For the overall repository layout see `../../PROJECT_HANDOFF.md`._

## POS identity and permissions

- **Session gate:** every `/api/pos/*` route runs `posSessionGate` = `authenticateUser` → `resolvePosActor` (`src/middlewares/pos-auth.middleware.ts`).
  - Only a **VENDOR** owner, or an active vendor **EMPLOYEE** whose `Employee.permissions.posAccess === true`, gets in. The Employee row is re-read from the DB on every request.
  - The vendor comes from `req.vendorScope`, never from the request body.
- **Per-action grants** (`req.posActor.grants`, owner = all):

| Grant | Allows |
|---|---|
| `posDiscount` | discounts |
| `posCredit` | credit sales and credit-term writes |
| `posRefund` | refunds and voids |
| `posReports` | the dashboard |

- **Granting keys:** `posAccess`, `posDiscount`, `posCredit`, `posRefund` and `posReports` are vendor-only. Only a VENDOR owner can grant them to its own staff (`validatePermissionPatch`; `PUT /api/employees/:employeeId/permissions` allows only the ADMIN and VENDOR roles).
- **Operational routes** also need an active POS subscription (`requirePosEntitlement`, 402 otherwise).
- **Store status:** `createSale` reads `Vendor.status` from the DB first. `SUSPENDED` / `DEACTIVATED` stores can't open new sales (403); `PENDING` / `ACTIVE` can. Refunds, voids and due collection are never blocked by store status.

## Customer balances (authoritative rules)

- **Debt:** `PosCustomer.due` is the **only** outstanding customer debt. `loanBalance` is a mirror written equal to `due`; never read it for decisions.
- **Who writes balances:** only `PosService`, through the three statements in `posCustomerSql` (`src/services/pos.service.ts`):

| Statement | Used by | Effect |
|---|---|---|
| `sale` | `createSale` | conditional on the credit rule: `due + newDue <= loanLimit`, with `loanLimit 0` = no credit; `orders +1`, `spent += netBilling`, `lastOrderAt` |
| `reverse` | refund / void | `due −= dueReduced`, `spent −= refundNet`, a void also `orders −1` |
| `collect` | `payDue` | `due −= paid` |

- **Transactions:** each statement runs inside the same Serializable `runStockMutation` (or `prismaDirect.$transaction` for `payDue`) as the sale row, stock and voucher. Raw-query serialization conflicts (P2010/40001) are retried.
- **Refund allocation:** the unpaid part is cancelled first (`dueReduced = min(refundNet, sale.dueAmount)`); only `cashRefund = refundNet − dueReduced` is paid out. Sale and payment rows are updated optimistically on the values just read.
- **Rejected sale fields:** `extraAmount`, `dueCutAmount` and `walletAddAmount` other than 0 are rejected (no accounting exists for them). Overpayment is change, for walk-ins and registered customers alike (no wallet ledger).
- **Audit:** credit-term changes write `AuditLog` (`POS_CREDIT_TERMS_CHANGED`, entity `PosCustomer`), returned as `creditHistory` by `GET /pos/customers/:id`.

## POS ledger

- **Customer dues:** debit the vendor account **"POS Customer Receivable"** (`POS_CUSTOMER_RECEIVABLE`). It is created on first use by `AccountingService.ensurePosCustomerReceivableIn` and seeded for new vendors. It is **not** "Receivable from Platform", which is the marketplace settlement account checked by `getDriftReport`.
- **Legacy sales:** collections and refunds credit whichever receivable the original sale debited (`posReceivableAccountForSale`); legacy sales used "Receivable from Platform".
- **No customer link on vouchers:** POS vouchers never set `Voucher.customerId`, which references marketplace `User`.
- **No payable change:** POS vouchers never change `VendorPayable`, the platform's payout liability.
- **Idempotency key:** `<type>:<event>:<refType>:<vendorId>:<refId>`.
- **Refund and due-collection idempotency:** these accept an optional `clientRequestId`. The voucher reference is then `<invoice>-R-<id>` / `<invoice>-DP-<id>`, so the unique idempotency key blocks a repeat. A repeated or concurrent twin returns `duplicate: true` with the first voucher. Without an id there is no protection against a deliberate repeat.
- **Receivable account creation:** "POS Customer Receivable" is created outside the sale transaction (race-safe re-read on P2002). Inside a transaction it is never retried.

## Tests

- `tests/pos-credit.test.ts`: stubbed service and accounting.
- `tests/pos-credit-postgres.test.ts`: opt-in, runs the real SQL. Set `POS_PG_TEST_URL` to a throwaway **localhost** database; anything else is refused.
- `tests/pos-security.test.ts`: routes, permissions, subscription.
- Frontend: `multivendorsite/tests/pos-credit-ui.test.mjs`, `tests/pos-terminal-ui.test.mjs`.
- Verified results, the invariant-to-test map and the mutation check: `docs/POS_CUSTOMER_CREDIT_AUDIT.md` §16.10.
- Always give `assert.ok(...)` a message in these tests. Without one, Node re-parses the source to build the failure message, which hung a failing run for many minutes.
