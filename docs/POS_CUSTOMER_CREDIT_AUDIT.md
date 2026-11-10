# FinixMart POS — Customer Credit / Loan Audit

_Audit only, 2026-10-25. No application code, schema, migration, data or permission was changed. Every finding below comes from reading the working tree. No test, request or database query was run for this audit, so runtime behaviour is **Not Verified** unless an existing automated test is cited._

> **Update 2026-10-25:** the defects in §1–§12 were fixed in a follow-up implementation, described in **§16**. Sections 1–15 are kept as the audit-time findings.

Status labels: **Verified Present** · **Verified Missing** · **Partially Implemented** · **Potential Defect** · **Not Verified**.
Here "Verified" means verified by reading the source.

---

## 1. Executive summary

The POS has a customer record with credit fields and a working **credit-sale permission boundary**. It does **not** have a working credit/loan system.

- **Authorization:** **Verified Present.** Credit sales and credit-term edits need the vendor owner or an active employee of the same vendor holding both `posAccess` and `posCredit`. These come from the database on every request. Admins, admin staff, customers, other vendors' staff and spoofed payload values are refused. Only the vendor owner can grant `posCredit`; HR management alone cannot.
- **Loan limit:** **Verified Missing.** `createSale` never compares the sale against `loanLimit`. Anyone holding `posCredit` can create unlimited debt for any of the vendor's customers, including customers with `loanLimit = 0`.
- **`loanBalance`:** **Verified Missing** as a maintained value. Nothing writes it; it stays 0 forever. The real outstanding balance is `due`.
- **Other customer statistics:** `orders`, `spent`, `lastOrderAt`, `walletBalance` and `creditScore` are never updated by any sale, payment or refund.
- **Refund or void of a credit sale (Potential Defect, High):** it pays the full refund out of cash. It never reduces the sale's `dueAmount` or the customer's `due`.
- **Customer form (Potential Defect, High):** the form always sends `loanLimit`, but has no input for it. Every customer create/edit by staff without `posCredit` is rejected with 403, and no UI can set a loan limit at all.
- **Customer dues in the ledger (Potential Defect):** they are posted to the vendor's **"Receivable from Platform"** account, which is the marketplace settlement account.
- **`extraAmount` and `dueCutAmount` (Potential Defect):** any value other than 0 unbalances the sale voucher, so the sale is refused.

---

## 2. Architecture files inspected

| Layer | Path | Symbols |
|---|---|---|
| Schema | `multivendorbackend/prisma/schema.prisma` | `model PosCustomer`, `model PosSale`, `model Voucher` (`customer User? @relation("VoucherCustomer")`) |
| Auth | `multivendorbackend/src/middlewares/auth.middleware.ts` | `authenticateUser` (user, role, vendor and employee re-read from the DB) |
| POS session gate | `multivendorbackend/src/middlewares/pos-auth.middleware.ts` | `resolvePosActor`, `posSessionGate`, `requirePosPermission`, `requirePosOwner`, `posActorCan` |
| Entitlement | `multivendorbackend/src/middlewares/pos-entitlement.middleware.ts` | `requirePosEntitlement` (`operate`) |
| Routes | `multivendorbackend/src/routes/pos.routes.ts` | `/customers` GET/POST/PUT, `/sales` POST, `/sales/:id/refund`, `/sales/:id/void`, `/sales/:id/pay-due` |
| Controller | `multivendorbackend/src/controllers/pos.controller.ts` | `createSale`, `createCustomer`, `updateCustomer` (pass `posActorCan(actor, "posCredit")`) |
| Service | `multivendorbackend/src/services/pos.service.ts` | `createSale`, `refundSale`/`voidSale` → `reverseInTx`, `payDue`, `customerData`, `createCustomer`, `updateCustomer`, `listCustomers`, `getDashboard` |
| Accounting | `multivendorbackend/src/services/accounting.services.ts` | `createPOSSaleVoucher`, `createPOSRefundVoucher`, `createPOSDuePaymentVoucher`, `_buildAndPostPOS`, `_upsertCustomerReceivable`, `PAYMENT_COA_NAME` |
| Permission grants | `multivendorbackend/src/middlewares/permission.middleware.ts`, `src/routes/employee.routes.ts`, `src/controllers/employee.controller.ts`, `src/services/employee.service.ts` | `VENDOR_ONLY_PERMISSION_KEYS`, `validatePermissionPatch`, `updateEmployeePermissions` |
| Tests | `multivendorbackend/tests/pos-security.test.ts` | session gate, revocation, "customer writes are whitelisted…", "createSale: … credit need grants" |
| Frontend API | `multivendorsite/src/features/posApi.ts` | `PosCustomer`, `CreateCustomerRequest`, `CreateSaleRequest` |
| Frontend terminal | `multivendorsite/src/app/pos/components/PosTerminalView.tsx` | `doCharge`, `submit`, `hasCreditLimit`, `availableCredit`, credit confirm dialog |
| Frontend customers | `multivendorsite/src/app/pos/components/CustomerFormModal.tsx`, `components/views/Customersview.tsx`, `components/CustomerPickerModal.tsx` | form state, `canManage` |
| Operator model | `multivendorsite/src/lib/pos/subscription-view.ts` | `operatorFromMe` (`canGrantLoan ← grants.posCredit`, `canManageCustomers: true`) |
| Permission editor | `multivendorsite/src/othersfeatures/hrm/components/PermissionCheckboxGroup.tsx` | `POS_OPTIONS` labels |
| Context | `PROJECT_HANDOFF.md` (workspace root) | repo layout and conventions |

**Sale path:**
1. **Browser:** `PosTerminalView.submit` → `POST /api/pos/sales`.
2. **Gate:** `posSessionGate` → `requirePosEntitlement`.
3. **Service:** `PosController.createSale` → `PosService.createSale`.
4. **Transaction:** `posTx` (Serializable plus P2034 retry):
   1. stock check, invoice number, `posSale.create`, stock deduction and movement;
   2. `createPOSSaleVoucher` (sale voucher, vendor payable and `_upsertCustomerReceivable`, which runs `posCustomer.due += dueAmount`);
   3. voucher link.

---

## 3. Customer data model field matrix

The model is `PosCustomer` (`pos_customers`), with `@@unique([vendorId, phone])`.

| Field (spec) | DB column / default | Frontend type | Frontend form | Client-writable on backend | Maintained by sale/payment flow | Status |
|---|---|---|---|---|---|---|
| id | `id` cuid | yes | — | no | — | Verified Present |
| name | `name` | yes | yes | yes | — | Verified Present |
| phone | `phone` (unique per vendor) | yes | yes | yes | — | Verified Present |
| address | `address` | yes | yes | yes | — | Verified Present |
| note | `note` | yes | yes ("Internal Note") | yes | — | Verified Present |
| email | `email` | yes | yes | yes | — | Verified Present |
| nid | `nid` | yes | **no input** | yes | — | Partially Implemented |
| referrerName / referrerEmail | columns exist | **not in `PosCustomer` type** | **no input** | yes | — | Partially Implemented |
| loanLimit | `loanLimit Float @default(0)` | yes | **in form state, no input** (`CustomerFormModal.tsx`, `loanLimit: editData?.loanLimit ?? 0`) | only with `posCredit` | **never checked** | Partially Implemented / Potential Defect |
| loanBalance | `loanBalance Float @default(0)` | yes (shown "Loan: balance / limit") | — | no | **never written** | Verified Missing (as a maintained value) |
| loanInterestRate | `Float @default(12)` | yes | no | only with `posCredit` (0–100) | never used | Partially Implemented (stored only) |
| loanTenureDays | `Int @default(30)` | yes | no | only with `posCredit` (0–3650) | never used; no due date | Partially Implemented (stored only) |
| creditScore | `String @default("Good")` | yes (badge) | no | no | never computed | Verified Missing (static default) |
| orders | `Int @default(0)` | yes | — | no | **never incremented** | Verified Missing |
| spent | `Float @default(0)` | yes | — | no | **never updated** | Verified Missing |
| due | `Float @default(0)` | yes | — | no | `+dueAmount` on sale (`_upsertCustomerReceivable` ADD); `−paying` on `payDue` (SUBTRACT) | Partially Implemented (see §5) |
| walletBalance | `Float @default(0)` | yes | — | no | **never written** | Verified Missing |
| last | `lastOrderAt DateTime?` (the spec's `last` is named `lastOrderAt`) | `lastOrderAt` | — | no | **never written** | Verified Missing |

**Naming mismatches and duplicate sources of truth**
- **Two balances:** `due` (maintained) and `loanBalance` (never maintained) both describe customer debt. The terminal's "Available credit" uses `loanLimit − loanBalance` (`PosTerminalView.tsx`, `availableCredit`), so it ignores real debt.
- **Shadow sale fields:** `PosSale.walletAddAmount`, `extraAmount` and `dueCutAmount` are accepted and stored per sale, but have no effect on customer balances (§7).
- **Frontend names:** `canGrantLoan` and `canManageCustomers` are frontend view-model names, not permission keys. The real keys are listed in §6.

---

## 4. Walk-in versus registered customer

| Rule | Frontend | Backend | Status |
|---|---|---|---|
| No customer selected → Walk-in | `customer` null; label "Walk-in Customer" | `isWalkIn: !customer`; voucher name "Walk-in Customer" | Verified Present |
| Walk-in must pay in full | `doCharge`: "Walk-in customers must pay in full" | `createSale`: `if (dueAmount > 0) { if (!customer) throw bad("Select a customer to sell on credit") … }` | Verified Present (enforced server-side; test "credit needs a customer") |
| Walk-in gets no credit or wallet | no wallet UI | no code path writes `walletBalance` for anyone | Verified Present (trivially) |
| Walk-in overpayment = change | confirm dialog "Return … change" | `change = max(tendered − net, 0)`, `paidAmount = tendered − change` | Verified Present (test "cash above the bill is change") |
| Registered customer may use credit only with permission and credit rules | confirm dialog warns "No Credit/Loan Facility" but **still lets the sale proceed** | permission checked (`posCredit`); **no credit-limit rule** | Partially Implemented |

**Bypass check.**
- **Walk-in debt:** a direct API call cannot create walk-in debt; the server requires a customer.
- **Registered-customer debt:** a direct API call by any `posCredit` holder can create unlimited debt for any customer of the same vendor. The UI permits the same.

---

## 5. Loan-limit and balance calculations

| Scenario | Finding | Status |
|---|---|---|
| 1. `loanLimit = 0` → no credit | Credit sale still succeeds if the actor holds `posCredit`. The UI shows an amber warning but proceeds. | **Verified Missing** |
| 2. `loanLimit > 0`, within limit | Allowed, but because nothing is checked, not because the limit is honoured | Partially Implemented |
| 3. Sale would exceed limit → reject | No comparison anywhere (`grep loanLimit` in `pos.service.ts` only matches `customerData`) | **Verified Missing** |
| 4. No `posCredit` → reject | `createSale`: `if (!posActorCan(actor, "posCredit")) throw forbidden(...)` | Verified Present (tested) |
| 5. With `posCredit` → allowed within scope and limit | Scope enforced; limit not enforced | Partially Implemented |
| 6. Concurrent sales exceeding the limit | Not applicable today (no limit check). `due` uses an atomic `{ increment }`, so concurrent sales don't lose updates. A future limit check needs a conditional update or a check inside the serializable transaction. | Not Verified (no limit to race) |
| 7. Refund / void / partial payment | `payDue`: conditional decrement of `PosSale.dueAmount` (`updateMany … dueAmount gte paying`) plus `posCustomer.due −= paying`, inside one transaction. Refund/void (`reverseInTx`): **do not touch `dueAmount` or `PosCustomer.due`** (details below). | Partially Implemented / **Potential Defect** |
| 8. Authoritative outstanding balance | `PosCustomer.due` is incremented and decremented and could serve as the authority. `loanBalance` is not. No check reads either. | Partially Implemented |

**`due` versus `loanBalance`:** these are independent columns. Only `due` is maintained, so in practice `due` is the loan balance and `loanBalance` is dead data.

**Refund and void of a credit sale (Potential Defect, High)**
- `createPOSRefundVoucher` always credits the cash/bank account for the full `refundNet`:
  ```
  { accountId: ...paymentCOAName(data.paymentMethod), creditAmount: data.refundNet, description: `Refund paid via ...` }
  ```
- `reverseInTx` never reduces `PosSale.dueAmount` or `PosCustomer.due`.
- **Result:** refunding an unpaid or partly paid credit sale gives the customer cash for goods they never paid for. Their due stays in place, and on a partial refund it can still be collected through `payDue`.
- **Void:** a voided credit sale leaves `PosCustomer.due` permanently overstated, because `payDue` refuses VOIDED sales.

---

## 6. Vendor and employee permission matrix

The actual keys are vendor-only, defined in `permission.middleware.ts` `VENDOR_ONLY_PERMISSION_KEYS` and labelled in `PermissionCheckboxGroup.tsx`:

| Key | UI label | Meaning |
|---|---|---|
| `posAccess` | "POS Terminal Access" | the spec's "Full POS Access"; required for any POS route |
| `posCredit` | "POS Credit Sales" | the spec's `canGrantLoan`: credit sales and credit-term edits |
| `posDiscount` | "POS Discounts" | discounts and `dueCutAmount` |
| `posRefund` | "POS Refunds & Voids" | |
| `posReports` | "POS Reports" | |

There is **no customer-management key**. The frontend's `canManageCustomers` is hard-coded `true` (`subscription-view.ts`, `operatorFromMe`). On the backend, customer create/update needs only `posAccess` plus an active subscription (`operate`).

| Actor | Open POS | Credit sale | Set `loanLimit` / interest / tenure | Create/edit customer profile | Evidence |
|---|---|---|---|---|---|
| Vendor owner (`VENDOR`, vendor row exists) | yes | yes | yes | yes | `resolvePosActor` gives the owner all grants |
| Employee of the same vendor, active, `posAccess` + `posCredit` | yes | yes | yes | yes, by API | `resolvePosActor` re-reads `Employee` (active, `vendorId` match) |
| Employee with `posAccess`, no `posCredit` | yes | **no** (403) | **no** (403) | API: profile-only body allowed. **UI: always 403** (form sends `loanLimit`) | `customerData` `creditKeys` check |
| Employee without `posAccess` (e.g. HR-only) | **no** (403) | no | no | no | `resolvePosActor` |
| Employee of another vendor | no: the vendor comes from their own `Employee` row, so they only ever reach their own store, and customer lookups are `vendorId`-scoped (404) | — | — | — | `findFirst({ id, vendorId })` everywhere |
| Inactive / deactivated employee | no (`authenticateUser` requires an active `Employee`; `resolvePosActor` re-checks `isActive`) | | | | test "revoking posAccess (or deactivating…)" |
| Admin / admin staff | no (403) | | | | `resolvePosActor`: only VENDOR or vendor EMPLOYEE |
| Customer / anonymous | no (403 / 401) | | | | |
| Spoofed `vendorId` / `employeeId` / `role` / `canGrantLoan` in the body | ignored: identity from the JWT plus DB, grants from `Employee.permissions` | | | | `authenticateUser` checks the role against the DB; controller uses `req.vendorScope` and `req.posActor` |

**Who can grant `posCredit`:**
- **The vendor owner only.** `PUT /api/employees/:employeeId/permissions` is `authorizeRoles('ADMIN','VENDOR')`, and `validatePermissionPatch` refuses vendor-only keys for any non-VENDOR actor ("can only be granted by a vendor owner to their own staff").
- **Scoping:** `updateEmployeePermissions(employeeId, permissions, vendorId)` looks the employee up with `{ id, vendorId }`, so a vendor can only edit its own staff.
- **HR:** HR employees cannot reach this route, because it doesn't allow the EMPLOYEE role. **HR management alone does not grant loan authority** (Verified Present).
- **Separate from `posAccess`:** `posAccess` does **not** imply `posCredit`. Separate booleans are checked separately (Verified Present).
- **Revocation:** takes effect on the next request, because `Employee.permissions` is re-read every time (Verified Present, tested). Stale client state cannot bypass it.

**Not Verified:** whether a suspended/inactive **vendor** (`Vendor.status`) is blocked. `authenticateUser` checks `User.isActive` and that the vendor row exists, not the vendor status. The POS subscription gate blocks operations independently.

---

## 7. End-to-end sale and overpayment flow (`PosService.createSale`)

1. `clientRequestId` validated; a repeat returns the earlier sale.
2. Variants, warehouses, racks, customer and legacy bank account are loaded **scoped to `vendorId`** (404 otherwise).
3. Server prices: `price = specialPrice ?? price`; `cost = avgCost`.
4. `subtotal`; discount (PERCENT or FLAT, ≤ subtotal); **`extraAmount`, `dueCutAmount` and `walletAddAmount` are read from the client** (money ≥ 0).
5. Discount or `dueCutAmount` > 0 requires `posDiscount`.
6. `taxAmount` on the discounted base; `netBilling = taxableBase + tax + extraAmount`.
7. `change = max(tendered − net, 0)`; `paidAmount = tendered − change`; `dueAmount = max(net − paid − dueCut, 0)`.
8. `dueAmount > 0` requires a customer and `posCredit`. **No `loanLimit` check.**
9. Transaction:
   1. stock re-check, invoice number, `posSale.create` (stores `walletAddAmount`, `extraAmount`, `dueCutAmount`), stock deduction and movement;
   2. `createPOSSaleVoucher`: debit cash for `paidAmount`, debit **"Receivable from Platform"** for `dueAmount`, debit discount; credit Sales Revenue (subtotal) and VAT; COGS / inventory;
   3. then vendor payable, then `posCustomer.due += dueAmount`;
   4. link the voucher.
10. Any failure rolls the whole transaction back: no partial customer-balance updates (Verified Present by code; the rollback test covers stock and sale).

| Expected behaviour | Finding | Status |
|---|---|---|
| `due` = previous + new due − due reduction | `due += dueAmount` (`dueAmount` already excludes `dueCut`); reductions only via `payDue` | Partially Implemented |
| `loanBalance` updated | never | Verified Missing |
| `orders` +1 per successful sale | never | Verified Missing |
| `spent` += net bill | never | Verified Missing |
| `last` / `lastOrderAt` = sale time | never | Verified Missing |
| Registered overpayment → pay old debt first, rest to `walletBalance` | overpayment is returned as change for everyone; old debt is not settled; wallet never credited | Verified Missing |
| Walk-in overpayment → change | yes | Verified Present |
| `walletAddAmount` | stored on the sale only; no permission needed; no balance effect. The sale record can claim a wallet top-up that never happened. | Potential Defect (data integrity) |
| `extraAmount` ≠ 0 or `dueCutAmount` ≠ 0 | The sale voucher has no entry for either. Debits total `subtotal + tax + extra − dueCut`, credits `subtotal + tax`. `_buildAndPostPOS` then throws `POS voucher imbalance` and the sale fails (400). `extraAmount` also needs no permission. The current terminal sends neither field. | Potential Defect (by code reading; not run) |
| Rounding | `round2` on every money value; `EPS = 0.005` for comparisons; Float columns | Verified Present |

---

## 8. Transactions and concurrency

**Sale:**
- one Serializable transaction (`posTx` / `runStockMutation`, P2034 retry);
- the `clientRequestId` unique key blocks duplicates;
- `due` uses an atomic increment;
- the voucher idempotency key is now vendor-scoped.

**Due payment:**
- `prismaDirect.$transaction` (default isolation);
- the conditional `updateMany` on `dueAmount` prevents over-collection;
- `posCustomer.due` uses an atomic decrement.

**Refund:** the conditional `refundedQty` increment prevents a double refund of a line.

**Gaps:**
- **No credit check at all.** Any future check must be atomic, for example a conditional `posCustomer.updateMany({ where: { id, vendorId, due: { lte: loanLimit − newDue } } })` or a check inside the serializable transaction.
- **`PosCustomer.due` is not reconciled against `Σ PosSale.dueAmount`.** Refunds and voids break the equality (§5).

---

## 9. Accounting consistency and auditability

| Capability | Status | Evidence |
|---|---|---|
| Customer payment history | Partially Implemented: each `payDue` posts a RECEIPT voucher (`pos_due_payment`, narration names the collector); there is no customer-level payment table | `createPOSDuePaymentVoucher` |
| Credit grant history (who set `loanLimit`, when) | **Verified Missing**: `updateCustomer` overwrites, with no audit row | `updateCustomer` |
| Repayment history per sale | Partially Implemented: `PosSale.paidAmount` / `dueAmount` change in place, and vouchers exist | `payDue` |
| Due dates / tenure tracking | Verified Missing (`loanTenureDays` stored, unused) | — |
| Interest calculation / accrual | Verified Missing (`loanInterestRate` stored, unused) | — |
| Ledger explaining balances | Partially Implemented. Vouchers carry `referenceId = invoiceNo`. Customer debt goes to **"Receivable from Platform"**, the vendor's marketplace settlement asset (also used by the order/payout entries in `accounting.services.ts`), so POS customer debt is mixed into platform receivables. Since the 2026-10-23 FK fix, vouchers carry no customer link (`Voucher.customerId` references `User`). | `createPOSSaleVoucher`, `createPOSDuePaymentVoucher` |
| Refund / return / void handling | Partially Implemented: stock and revenue are reversed; **customer debt is not** (High) | `reverseInTx`, `createPOSRefundVoucher` |

**Inconsistency cases:**
- **`loanBalance` versus `due`:** always diverge once any credit sale happens.
- **`PosCustomer.due` versus `Σ open PosSale.dueAmount`:** diverge after any refund or void of a sale with a due.
- **`walletBalance` versus `PosSale.walletAddAmount`:** the sale can record a wallet add that never reached the balance.

---

## 10. Security findings

| # | Severity | Finding | Evidence |
|---|---|---|---|
| S1 | **High** | No credit-limit enforcement: any `posCredit` holder (and the owner) can create unlimited customer debt, including for `loanLimit = 0` customers | `pos.service.ts` `createSale`, the `if (dueAmount > 0)` block |
| S2 | **High** | Refund/void of a credit sale pays cash for unpaid goods and leaves the due collectible or stuck | `reverseInTx`; `createPOSRefundVoucher` (credit of `refundNet` to the payment account) |
| S3 | Medium | `extraAmount` can be added by any `posAccess` user, without permission. Currently it unbalances the voucher (sale fails); if the accounting were "fixed" without a gate, it would let cashiers inflate bills and the resulting debt. | `createSale` (`extraAmount`), `createPOSSaleVoucher` |
| S4 | Medium | `walletAddAmount` accepted from any cashier and stored without effect: misleading financial record | `createSale` |
| S5 | Medium | POS customer debt is posted to "Receivable from Platform", the same account used for marketplace settlement. Risk of mixing POS debt into platform payout figures (Not Verified whether payout code sums this account for POS vouchers). | `createPOSSaleVoucher` |
| S6 | Low | Customer profile create/edit has no dedicated permission; any `posAccess` employee may edit names/phones of all the vendor's customers | `pos.routes.ts` POST/PUT `/customers` (`operate`) |
| S7 | Low | Vendor status (suspended, etc.) not checked by the POS session gate | `authenticateUser` VENDOR branch; `resolvePosActor` |

Tenant isolation is **Verified Present**:
- every customer, sale, warehouse and variant query is `vendorId`-scoped;
- `vendorId` and `staffId` in the body are ignored;
- grants come from the DB (`tests/pos-security.test.ts`: "payload vendorId is ignored", "cross-vendor ids … → 404").

---

## 11. Confirmed defects versus unverified concerns

**Confirmed by source reading:**
- S1 (no limit check);
- S2 (refund/void ignores due);
- `loanBalance`, `orders`, `spent`, `lastOrderAt`, `walletBalance` and `creditScore` never maintained;
- the customer form always sends `loanLimit`, so a staff member without `posCredit` gets 403 on every save, and no UI sets credit terms;
- the terminal's "Available credit" uses `loanBalance`;
- the credit confirm dialog lets a no-limit credit sale proceed.

**Code-reading conclusion, not executed:**
- `extraAmount` / `dueCutAmount` ≠ 0 → `POS voucher imbalance` → sale fails.

**Not Verified:**
- whether payout or settlement reports include POS "Receivable from Platform" postings (S5);
- vendor-status blocking (S7);
- live data consistency (no DB access in this audit).

---

## 12. Missing features and naming mismatches

**Missing:**
- credit-limit check;
- loan-balance maintenance (or removal of the duplicate);
- customer statistics (`orders`, `spent`, `lastOrderAt`);
- wallet top-up / overpayment-to-wallet and debt-first allocation;
- credit score;
- interest and due dates;
- credit-limit change audit trail;
- a customer-level payment history view;
- a UI to set credit terms;
- `nid` / referrer inputs.

**Mismatches:**
- spec `last` ↔ `lastOrderAt`;
- spec `canGrantLoan` ↔ key `posCredit`;
- spec "Full POS Access" ↔ key `posAccess`;
- spec `canManageCustomers` ↔ no key (frontend constant `true`);
- `due` ↔ `loanBalance` (two debt fields).

---

## 13. Minimal implementation plan (priority order; needs separate authorization)

1. **Credit-limit check (S1).**
   - **Rule:** the server rejects a sale when `customer.due + dueAmount > customer.loanLimit`; `loanLimit = 0` means no credit.
   - **Atomicity:** apply it inside the sale transaction with a conditional update, so concurrent sales can't overshoot.
   - **Decision for you:** whether the owner may override the limit.
   - **UI:** show the remaining limit (`loanLimit − due`) in the confirm dialog and block the sale there too.
2. **Refund/void of sales with a due (S2).**
   - **Ledger:** reverse against the receivable first (reduce `PosSale.dueAmount` and `PosCustomer.due`, crediting the receivable), and pay cash only for the portion actually paid.
   - **Void:** must do the same.
3. **Customer form.** Stop sending `loanLimit` unless the operator holds `posCredit`. Add a credit-terms section visible only with `posCredit`, using the existing fields.
4. **Pick one debt field.** Treat `due` as the authoritative balance and stop displaying `loanBalance` (or keep them equal). No schema change needed.
5. **Customer statistics.** In the sale transaction, update `orders += 1`, `spent += netBilling` and `lastOrderAt = saleDate`; on refund, reduce `spent` by `refundNet`.
6. **Unused amount fields.** Reject `extraAmount`, `dueCutAmount` and `walletAddAmount` values other than 0 until each has accounting and permission rules (S3/S4).
7. **Ledger account (S5).** Decide on a dedicated "Customer Receivable (POS)" COA account; this needs a COA seed change and data review.
8. **Later, each a business decision:** wallet/overpayment handling, credit score, interest, due dates, and a credit-term audit log (likely schema).

---

## 14. Regression-test plan

- **Credit limit:**
  - `loanLimit = 0` plus a due → rejected;
  - within the limit → OK;
  - `due + new due > limit` → rejected;
  - two concurrent sales that together exceed the limit → exactly one succeeds.
- **Permissions:** a credit sale without `posCredit` → 403 (exists); with it → OK; an owner override (if chosen) is audited.
- **Customer writes:**
  - a profile-only edit by a non-`posCredit` employee → 200;
  - an edit including `loanLimit` → 403 (exists);
  - the UI form omits credit keys for those users.
- **Refunds and voids:**
  - refund of a full-credit sale → no cash credit, sale `dueAmount` and customer `due` reduced;
  - refund of a partly paid sale → cash only up to the paid amount;
  - void of a credit sale → due cleared.
- **Customer statistics:** `orders`, `spent` and `lastOrderAt` after a sale; `spent` after a refund; nothing changes after a failed sale (rollback).
- **Overpayment:** walk-in → change only; registered → current behaviour (change), or debt-first/wallet once decided.
- **Amount fields:** `extraAmount`, `dueCutAmount` or `walletAddAmount` other than 0 → rejected (until implemented).
- **Tenancy:**
  - another vendor's customer → 404 (exists);
  - spoofed `vendorId` → ignored (exists);
  - an admin or admin employee → 403 (exists);
  - revoked `posCredit` → 403 on the next request.

---

## 15. Source paths and symbols

- `multivendorbackend/prisma/schema.prisma`: `model PosCustomer`, `model PosSale` (`dueAmount`, `walletAddAmount`, `extraAmount`, `dueCutAmount`, `isWalkIn`), `model Voucher` (`customer User? @relation("VoucherCustomer")`).
- `multivendorbackend/src/services/pos.service.ts`: `createSale` (credit block `if (dueAmount > 0)`), `reverseInTx`, `refundSale`, `voidSale`, `payDue`, `customerData`, `createCustomer`, `updateCustomer`, `getDashboard` (`totalCustomerDue` = Σ `PosCustomer.due`).
- `multivendorbackend/src/services/accounting.services.ts`: `createPOSSaleVoucher` (due → "Receivable from Platform"), `createPOSRefundVoucher` ("Refund paid via …"), `createPOSDuePaymentVoucher`, `_buildAndPostPOS` (balance check, idempotency key), `_upsertCustomerReceivable` (`posCustomer.due` increment).
- `multivendorbackend/src/middlewares/pos-auth.middleware.ts`: `resolvePosActor`, `posActorCan`, `requirePosPermission`, `requirePosOwner`.
- `multivendorbackend/src/middlewares/auth.middleware.ts`: `authenticateUser`.
- `multivendorbackend/src/middlewares/permission.middleware.ts`: `VENDOR_ONLY_PERMISSION_KEYS`, `validatePermissionPatch`.
- `multivendorbackend/src/routes/pos.routes.ts`: customer and sale routes.
- `multivendorbackend/src/routes/employee.routes.ts`: `PUT /employees/:employeeId/permissions` (`authorizeRoles('ADMIN','VENDOR')`).
- `multivendorbackend/src/services/employee.service.ts`: `updateEmployeePermissions` (`{ id, vendorId }` lookup, merge).
- `multivendorbackend/tests/pos-security.test.ts`: existing coverage cited above.
- `multivendorsite/src/features/posApi.ts`: `PosCustomer`, `CreateCustomerRequest`.
- `multivendorsite/src/app/pos/components/PosTerminalView.tsx`: `doCharge`, `submit`, `hasCreditLimit`, `availableCredit`, credit confirm dialog.
- `multivendorsite/src/app/pos/components/CustomerFormModal.tsx`: form state including `loanLimit` with no input.
- `multivendorsite/src/app/pos/components/views/Customersview.tsx`: `canManage`, loan/wallet/spent display.
- `multivendorsite/src/lib/pos/subscription-view.ts`: `operatorFromMe`.
- `multivendorsite/src/othersfeatures/hrm/components/PermissionCheckboxGroup.tsx`: POS key labels.

---

## 16. Implementation (2026-10-25)

All earlier findings (S1–S6, the field gaps and the form defect) are addressed below unless listed under "Still open".

### 16.1 Credit-limit rule and concurrency

- **Rule:** `due + newDue <= loanLimit` (tolerance 0.005); `loanLimit = 0` means no facility. It applies to every actor, the owner included.
- **Where it is enforced:** `PosService.createSale`.
  1. **Pre-check** (`withinCredit` / `creditRefusal`): refuses early with a readable 409.
  2. **Authoritative check:** `posCustomerSql.sale`, a single conditional `UPDATE "pos_customers" … WHERE id AND vendorId AND (due ≤ 0 OR (loanLimit > 0 AND due + $d ≤ loanLimit + ε))`, run inside the sale's Serializable `runStockMutation` transaction.
  3. If 0 rows are updated, the whole sale (stock, voucher, sale row) rolls back with the same 409 message.
- **Concurrency:** a raw-query serialization conflict surfaces as Prisma **P2010 / SQLSTATE 40001**, which was observed against PostgreSQL 18. `runStockMutation` now retries it like P2034 (`isSerializationConflict` in `src/modules/shared/stock-mutations.ts`).
- **Verified on a real PostgreSQL** (`tests/pos-credit-postgres.test.ts`): 8 concurrent 30-unit sales against a limit of 100 → exactly 3 commit, and the final due is 90.
- **Duplicates:** the existing `clientRequestId` dedupe is unchanged, so a duplicate submit never reaches the customer row twice.

### 16.2 One balance model

| Field | Behaviour now |
|---|---|
| `due` | **Authoritative outstanding debt.** + the new due on a sale; − the cancelled unpaid part on a refund/void; − the paid amount on a due collection; never below 0 |
| `loanBalance` | Written equal to `due` in every one of those statements (compatibility mirror). Legacy rows: see the optional `prisma/proposed/20261025120000_pos_customer_balance_sync` |
| `orders` / `spent` / `lastOrderAt` | Sale: +1, + `netBilling`, server time. Refund: `spent −= refundNet`. Void: also `orders −= 1`. Same statement as the due update, so they change exactly once per committed transaction |
| `walletBalance` | Unchanged. There is no wallet ledger, so registered-customer overpayment is still **returned as change** (not stored) |
| `loanInterestRate`, `loanTenureDays` | Stored; editable with `posCredit` (audited). No accrual or due-date logic (not specified) |
| `creditScore` | Unchanged static value; no algorithm invented |

Only `PosService` changes customer balances, through the three statements in `posCustomerSql`. `AccountingService` no longer touches `PosCustomer`; the old `_upsertCustomerReceivable` was removed.

### 16.3 Refund / void allocation (`PosService.reverseInTx`)

From the persisted sale, where `paidAmount + dueAmount` = the value not yet refunded:
- `dueReduced = min(refundNet, sale.dueAmount)`;
- `cashRefund = refundNet − dueReduced`;
- the refund is refused with 409 if `cashRefund` exceeds `paidAmount` by more than 0.05.

Then, in the same transaction:
- The sale row is updated **optimistically on the values just read** (`dueAmount`, `paidAmount`); a concurrent refund or collection loses with 409.
- The customer's due is reduced by `dueReduced` and `spent` by `refundNet`; a void also takes 1 off `orders`.
- The refund voucher credits cash for `cashRefund` only, and credits the receivable **the original sale debited** (`posReceivableAccountForSale`) for `dueReduced`. `createPOSRefundVoucher` throws if the two parts don't add up to `refundNet`.
- A partly refunded PENDING sale whose due reaches 0 becomes PAID.

The existing per-line `refundedQty` guard still blocks refunding more than was sold and repeated full refunds.

### 16.4 Due collection (`PosService.payDue`)

- **Double-submit protection:** the sale's due is decremented with an exact-value guard (`where dueAmount = <value read>`), so a double submit or a concurrent collection loses with 409.
- **Limits:** a collection can't exceed the due, and full repayment flips the sale to PAID (unchanged).
- **Ledger:** the customer due is reduced in the same transaction, and the receipt voucher credits the sale's own receivable account.

### 16.5 Unsupported amount fields

`extraAmount`, `dueCutAmount` and `walletAddAmount` other than 0 are rejected with 400. The terminal never sent them, and the sale voucher has no entry for them, so they would have unbalanced it. Zero or absent values are still accepted, and the columns keep being written as 0.

### 16.6 Ledger classification

- **New vendor account "POS Customer Receivable"** (ASSET / CURRENT_ASSET / ACCOUNTS_RECEIVABLE):
  - added to `VENDOR_COA` for new vendors;
  - created on first use for existing vendors (`AccountingService.ensurePosCustomerReceivableIn`), with the same `VND-AST-NNNN` code scheme.
- **New credit sales** debit this account instead of "Receivable from Platform". That platform account is reconciled against the platform's "Vendor Payables" in `getDriftReport`, so POS customer debt there created drift.
- **Legacy sales** (due posted before this release) keep clearing "Receivable from Platform" on collection and refund. `posReceivableAccountForSale` reads the original voucher's ledger entry, so no historical entry is edited.
- **POS sales no longer change `VendorPayable`:** they used to add `netBilling` to `totalSales` / `totalPayable` / `balance`, the payout liability, for money the platform never held.
- **Historical amounts are not corrected automatically.** See the reconciliation queries in the proposal README.

### 16.7 Authorization (unchanged model, re-verified)

- **Credit sales and credit-term writes:** need the vendor owner, or an active same-vendor employee with `posAccess` + `posCredit`. Permissions are re-read from the DB on every request.
- **Customer profile edits:** need only `posAccess` + an active subscription.
- **Granting `posCredit`:** only the vendor owner can do it (`validatePermissionPatch`). The permission route accepts only ADMIN and VENDOR roles, so an employee can never grant itself `posCredit`, and an admin cannot grant vendor-only keys.
- **Request body ignored:** `vendorId`, `employeeId`, `role`, `canGrantLoan` and `posCredit` sent in the body have no effect.

### 16.8 Auditability

- **Credit-term changes:** writes `AuditLog` `{ action: "POS_CREDIT_TERMS_CHANGED", entity: "PosCustomer", entityId, userId: <actor user>, oldData, newData: { …terms, vendorId, changed, byEmployeeId } }` in the same transaction as the update, and only when a value actually changes.
- **Reading the history:** `GET /pos/customers/:id` returns `creditHistory` (latest 20), after the vendor-scoped customer lookup.
- **Sales, refunds and collections:** remain traceable through their vouchers (`referenceId` = invoice / refund / payment number; narration names the customer and collector).
- **Not built:** a per-customer payment-history screen; the data is in vouchers and `PosSale`.

### 16.9 Frontend

- **`lib/pos/credit.ts`:** `creditStatus` / `creditRefusal` mirror the server rule and wording.
- **Terminal (`PosTerminalView`):**
  - stops "No Credit Facility" and "Credit Limit Exceeded" before submitting;
  - the confirm dialog shows outstanding, limit and available figures based on `due`, and blocks confirmation if refused;
  - server refusals (e.g. another till used the headroom) are shown as a toast, with no receipt.
- **Customer form:** sends `loanLimit` only when the operator holds `posCredit`, and shows a "Credit limit" field (validated ≥ 0) with outstanding and available amounts. Without the permission it shows read-only terms, so profile edits no longer fail with 403.
- **Customer list:** shows "Credit: due / limit · available", or "no facility".

### 16.10 Verification (final, 2026-10-25)

All backend runs used `DATABASE_URL`/`DIRECT_URL=postgresql://nobody:x@127.0.0.1:1/blocked` (unreachable on purpose). The PostgreSQL tests used a **throwaway local cluster** (PostgreSQL 18, `127.0.0.1:55432`, data folder in the session scratchpad), never the project database.

| Command | Exit | Result |
|---|---|---|
| `npx tsx --test tests/pos-credit.test.ts` | 0 | 16 pass / 0 fail |
| `POS_PG_TEST_URL=postgresql://postgres@127.0.0.1:55432/pos_credit_test npx tsx --test tests/pos-credit-postgres.test.ts` | 0 | 5 pass / 0 fail (incl. the 8-way concurrency test) |
| `npx tsx --test tests/pos-security.test.ts tests/employee-permission-keys.test.ts tests/vendor-management-routes.security.test.ts tests/marketing-admin-routes.security.test.ts` | 0 | 57 pass / 0 fail |
| `npx tsx --test tests/*.test.ts` (full backend) | 1 | 1084 tests: 1070 pass, **9 fail = known baseline** (HRM attendance/payroll/org tests needing a DB, `verification-no-secret-logging` needing Redis env), 5 skipped (the opt-in PostgreSQL tests) |
| backend `tsc` against the generated client | 2 | 625 errors (was 626; none in changed files; one fewer because `_upsertCustomerReceivable` was removed) |
| `node --test tests/pos-credit-ui.test.mjs tests/pos-terminal-ui.test.mjs tests/pos-payment-methods.test.mjs tests/pos-subscription-ui.test.mjs tests/permission-keys-parity.test.mjs` (frontend) | 0 | 34 pass / 0 fail |
| `node --test tests/*.test.mjs` (full frontend) | 1 | 425 tests: 424 pass, 1 fail = known baseline #127 (courier credentials page) |
| `npx eslint` on the changed frontend files | 0 | clean |
| frontend `tsc --noEmit` | 1 | 122 errors (unchanged; none in changed files) |

Not run:
- **Backend ESLint:** the repo has no ESLint configuration.
- **`next build`:** it would write the `.next` directory the running dev server uses.
- **Browser / end-to-end:** not performed.

**Mutation check** (`scratchpad/pos/mutate.py` on a scratch copy of the backend; the real repo was never mutated). Each mutant reintroduced one defect, and the credit, PostgreSQL and security suites were run against it:

| Mutant | Result |
|---|---|
| credit condition removed from `posCustomerSql.sale` | killed (4 tests, incl. PostgreSQL limit and concurrency) |
| early credit pre-check removed | killed (2) |
| refund pays everything in cash (`receivableCut = 0`) | killed (3) |
| sale due posted to "Receivable from Platform" again | killed (1). The first attempt hung: a bare `assert.ok` without a message makes Node re-parse the source to build its message. Messages were added and the rerun was killed in seconds. |
| raw-query 40001 retry removed | killed (2, incl. the real PostgreSQL concurrency test) |
| `extraAmount` accepted again | killed (1) |
| credit-term audit skipped | killed (1) |

**Invariants and where they are checked:**

| # | Invariant | Code | Test |
|---|---|---|---|
| 1 | `loanLimit = 0` → no credit | `withinCredit`, `posCustomerSql.sale` | pos-credit #1; postgres #1 |
| 2 | existing debt + new ≤ limit | same | pos-credit #2; postgres #2 |
| 3 | concurrent sales can't exceed it | conditional UPDATE + Serializable + `isSerializationConflict` retry | postgres #4; pos-credit #16 |
| 4 | walk-ins accumulate no debt | `createSale` (customer required for a due) | pos-credit #4 |
| 5 | balances change atomically, once | one statement in the sale transaction; `clientRequestId` dedupe | pos-credit #3, #5; pos-security idempotency test |
| 6 | unpaid sales are not refunded in cash | `reverseInTx` allocation | pos-credit #7 |
| 7 | partial refunds allocate correctly | same | pos-credit #8 |
| 8 | repeated refunds/voids add nothing | `refundedQty` guard, status check, optimistic sale update | pos-credit #8, #10; pos-security refund test |
| 9 | no credit without `posCredit` | `createSale`, `customerData` | pos-credit #4, #13; pos-security session/grant tests |
| 10 | vendor from server identity | `resolvePosActor`, `vendorId`-scoped queries and SQL | pos-security "payload vendorId is ignored", cross-vendor tests; postgres #3; pos-credit #13 |
| 11 | unsupported amounts can't unbalance vouchers | `createSale` rejection; refund allocation check | pos-credit #6, #14 |
| 12 | customer receivable ≠ platform payable | `ensurePosCustomerReceivableIn`, no `VendorPayable` write | pos-credit #14, #15 |

**Data proposal** `prisma/proposed/20261025120000_pos_customer_balance_sync`:
- **`migration.sql`:** run twice against a disposable table in the throwaway cluster; the result was identical after the second run.
- **Reconciliation queries:** run inside a `READ ONLY` transaction against minimal stand-in tables in that cluster (syntax and grouping only). They have **not** been run against real data.

### 16.11 Still open (business decisions)

- Wallet / overpayment storage and debt-first allocation (needs a wallet ledger).
- Interest accrual, due dates / tenure enforcement, credit scoring.
- Idempotency key for `payDue` and refunds: concurrent duplicates are refused, but a deliberate second submit after the first completes is treated as a new collection or refund, within the remaining due or quantity.
- A UI for refunds, voids and due collection (backend only).
- Correcting historical balances: customer `due` after old refunds/voids, POS entries in "Receivable from Platform", POS-inflated `VendorPayable`.
- S6: there is no separate customer-profile permission (any `posAccess` user may edit profiles). S7: vendor status is not checked by the POS gate.

---

## 17. Final accounting safety review (2026-10-25)

This section records only facts checked against the working tree and actual test runs. No migration was applied to any real, development, staging or production database.

### 17.1 Changes made in this review

| Area | Change |
|---|---|
| Receivable account race | `createSale` now creates "POS Customer Receivable" **before** the sale transaction (`ensurePosCustomerReceivableIn(undefined, …)`). Outside a transaction, a duplicate-key error (two first credit sales of a store) makes the loser re-read the winner's row, or retry with the next code; at most 3 attempts. Inside a transaction nothing is retried: the error aborts and the sale rolls back. `canDelete` now matches the seeded vendor accounts. |
| Refund / due-collection idempotency | Optional `clientRequestId` on `POST /pos/sales/:id/refund` and `/pay-due` (format `[A-Za-z0-9-]{8,64}`). The voucher reference becomes deterministic (`<invoice>-R-<id>` / `<invoice>-DP-<id>`), so the **unique `vouchers.idempotencyKey`** is the database-level guard. A repeat after completion returns the first voucher (`duplicate: true`) before any mutation. A concurrent twin either sees it, or loses its transaction (optimistic update or unique key) and returns the winner's voucher. No schema change. |
| Retry scope | `isSerializationConflict` now trusts only `meta.code === "40001"` (the message-text fallback is removed). Raw queries inside `runStockMutation` exist only in POS, whose work functions make database writes only, so a retry repeats no external effect. Bounded at 5 attempts. |
| Data proposal | `migration.sql` backs up any non-zero `loanBalance` that differs from `due` into `pos_customers_loan_balance_backup_20261025` before syncing. The README now has a payout-drift query (d), an order of operations and interpretation notes. |

### 17.2 Accounting traces (code-verified)

| Operation | Dr | Cr | Customer row | Sale row |
|---|---|---|---|---|
| Credit sale | cash `paid`; **POS Customer Receivable** `due`; Vendor Funded Discounts; COGS | Sales Revenue; Output VAT; Inventory | `due/loanBalance += due`, `orders +1`, `spent += net`, `lastOrderAt` (conditional on the limit) | new |
| Due collection | cash `paid` | **the receivable the sale debited** (`posReceivableAccountForSale`) | `due/loanBalance −= paid` (floor 0) | `dueAmount −= paid` (exact-value guard) |
| Refund / void | Sales Revenue; VAT; Inventory | discount; COGS; cash `cashRefund`; **the sale's receivable** `dueReduced` | `due −= dueReduced`, `spent −= refundNet`, void: `orders −1` | `dueAmount`, `paidAmount` (optimistic) |

- **Account:** ASSET / CURRENT_ASSET / ACCOUNTS_RECEIVABLE, debit nature, per vendor (`entityType VENDOR`, `entityId` = vendor). Balance = debits − credits, like every vendor asset. Chart-of-accounts rows have no currency field.
- **Legacy sales:** sales posted before this release keep clearing "Receivable from Platform"; no historical entry is reclassified.
- **VendorPayable writers:** `postVoucher`'s sync, driven by "Receivable from Platform" credits on vendor vouchers posted through `postVoucher`, and the payout voucher. POS vouchers use `_postPOSVoucher`, which never syncs VendorPayable, so removing the POS sale increment leaves every marketplace payable and settlement path untouched (settlement/refund suites: 31/31).

### 17.3 Verification runs

All runs used an unreachable `DATABASE_URL`/`DIRECT_URL`, except the opt-in PostgreSQL tests, which used a throwaway local PostgreSQL 18 cluster (`127.0.0.1:55432`, scratch data folder).

| Command (backend unless noted) | Exit | Result |
|---|---|---|
| `npx tsx --test tests/pos-credit.test.ts` | 0 | 22/22 |
| `POS_PG_TEST_URL=postgresql://postgres@127.0.0.1:55432/pos_credit_test npx tsx --test tests/pos-credit-postgres.test.ts` | 0 | 5/5 |
| `npx tsx --test tests/pos-security.test.ts tests/employee-permission-keys.test.ts tests/vendor-management-routes.security.test.ts tests/marketing-admin-routes.security.test.ts` | 0 | 57/57 |
| `npx tsx --test tests/payment-settlement-concurrency.test.ts tests/refund-backfill.test.ts tests/refund-concurrency.test.ts` | 0 | 31/31 |
| `npx tsx --test tests/*.test.ts` | 1 | 1090: 1076 pass, 9 fail (the same known HRM/Redis baseline), 5 skipped (opt-in PostgreSQL) |
| backend `tsc` | 2 | 625 errors, 0 in changed files (baseline 626) |
| frontend `node --test` on the 5 POS suites | 0 | 34/34 |
| frontend `node --test tests/*.test.mjs` | 1 | 425: 424 pass, 1 fail (known #127) |
| frontend `eslint` on changed files | 0 | clean |
| frontend `tsc --noEmit` | 2 | 122 errors, 0 in changed files (unchanged) |
| Mutation check of the review additions (`mutate2.py`, scratch copy) | — | 7/7 killed: refund prior lookup, twin recovery, deterministic reference, collection prior lookup, account race, account pre-creation, P2010 scope |
| `migration.sql` ×2 and queries (a)–(d) on stand-in tables in the throwaway cluster | 0 | idempotent; backup kept the one non-zero differing value; queries read-only |

**Not run:**
- **Browser smoke test:** the only authenticated environment is the local backend on :5000, whose database is the remote Supabase project, so any sale, collection or refund would change real data.
- **`next build`:** it would overwrite the running dev server's `.next`.
- **Backend ESLint:** no configuration exists.

### 17.4 Remaining risks

| Severity | Risk |
|---|---|
| HIGH | Historical data before payouts are enabled: (c) POS sales inflated `VendorPayable.balance`; (b)/(d) legacy POS dues sit in "Receivable from Platform" and create drift; (a) customer `due` is overstated by legacy refunds/voids. Requires the README review and approved adjustments. Payouts are currently disabled. |
| HIGH | Policy gap: `Vendor.status` (PENDING / SUSPENDED / DEACTIVATED) is not checked by `authenticateUser` or the POS gate. A suspended vendor's owner and staff can still sell, and sell on credit. Needs a business decision; blocking could lock out onboarding vendors. |
| MEDIUM | Refund/collection idempotency applies only when `clientRequestId` is sent. Without it, a deliberate repeat after completion is a new operation (bounded by the remaining quantity or due). There is no refund or collection UI yet; it must send an id. |
| MEDIUM | Money is stored in `double precision` columns (pre-existing); 2-dp rounding and a 0.005 tolerance are used throughout. |
| LOW | Any `posAccess` user can edit customer profiles (S6). The optional backup table must be dropped after verification. Interest, due dates, credit score and wallet are not implemented. |

---

## 18. Completion (2026-10-25)

### 18.1 Migration decision

The final code needs **no** migration. The credit rule, the terminal and the customer screens read `due`, and every sale, refund, void and collection writes `loanBalance = due` in the same statement.

`prisma/proposed/20261025120000_pos_customer_balance_sync` only aligns the unused `loanBalance` mirror on legacy rows. It was therefore **not** moved into `prisma/migrations/` and **not** applied to any database. Running it against the remote Supabase database would need, first:
- a verified, restorable backup; and
- the accounting review of query (a), so a wrong `due` isn't mirrored.

Neither can be verified from this workspace. No command was run against the remote database.

### 18.2 Suspended / deactivated stores

`PosService.createSale` reads `Vendor.status` for the session's vendor from the database, before any other read or write:

| Status | New POS sales (cash or credit) | Refunds, voids, due collection |
|---|---|---|
| `SUSPENDED`, `DEACTIVATED` | refused: 403 "This store is suspended/deactivated — new POS sales are paused …" | allowed (existing obligations) |
| `PENDING`, `ACTIVE` | allowed (subject to the subscription gate) | allowed |

The terminal shows the server's message, and no receipt.

**Tests:**
- `tests/pos-credit.test.ts` #23–#25: owner, credit clerk and cashier are refused with no write; a spoofed status or `vendorId` in the body is ignored; PENDING and ACTIVE stores sell; a refund is never blocked.
- `multivendorsite/tests/pos-terminal-ui.test.mjs`: the server's refusal message is shown and no receipt appears.
- **Already covered by existing tests:** inactive employees and cross-vendor access (`tests/pos-security.test.ts`, session-gate and cross-vendor tests).

**Mutation check** (fresh scratch copy): removing the check, allowing DEACTIVATED or blocking PENDING — all 3 killed.

### 18.3 Final runs

| Command | Exit | Result |
|---|---|---|
| `npx tsx --test tests/pos-credit.test.ts` | 0 | 25/25 |
| `POS_PG_TEST_URL=postgresql://postgres@127.0.0.1:55432/pos_credit_test npx tsx --test tests/pos-credit-postgres.test.ts` (fresh throwaway PostgreSQL 18 cluster) | 0 | 5/5 |
| security / permission suites (4 files) | 0 | 57/57 |
| settlement / refund accounting suites (3 files) | 0 | 31/31 |
| `npx tsx --test tests/*.test.ts` | 1 | 1093: 1078 pass, 10 fail, 5 skipped (opt-in PostgreSQL) |
| frontend POS suites (5 files) | 0 | 35/35 |
| `node --test tests/*.test.mjs` (frontend) | 1 | 426: 425 pass, 1 fail (known #127) |
| frontend `eslint` on changed files | 0 | clean |
| backend / frontend `tsc` | 2 / 1 | 625 / 122 errors, 0 in changed files (unchanged baselines) |

**About the 10 backend failures:**
- 9 are the known HRM/Redis baseline.
- The 10th, `chat-socket-session.test.ts` #146 ("reconnect with a refreshed token…", error `Unauthorized`), is intermittent under full-suite load. It passed 3 of 3 times when run alone. Its file contains no POS references and none of this change's code paths.

**Infrastructure note:** files in the session's temp scratch folder were removed while work was in progress (the first mutation copy lost its `node_modules` junction and part of `src/`). The mutants run against that broken copy were discarded as ERROR. The store-status mutants were rerun on a fresh copy, and the Postgres tests on a freshly created cluster. Earlier mutation results named the specific failing tests, so they ran before the removal.

### 18.4 Browser verification

Not performed. No staging environment exists in this workspace. The only signed-in environment is the local backend, whose database is the remote Supabase project, so test sales, collections or refunds would change real data.
